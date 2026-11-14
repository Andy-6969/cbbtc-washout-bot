// cbBTC minute bot for make.fun's "Race a BTC trading bot live for 24 hours" (bars-replay/v1).
//
// Long only, one position, Node 22 standard library plus the kit's SDK shim (vendor/).
//
// Four sleeves, one position, always (nearly) all in (the logic is in strategy.ts): washout (buy
// the first bounce after a fall well below the recent high), rebuy (the higher-low pullback while
// that washout recovers), pullback (smaller dips off the 3-hour high) and trend (new 3-hour highs,
// ridden with a tight first stop and a wide trailing stop). Every threshold scales with the RMS of
// 1-minute returns, so a calm day and a wild day read alike.
//
// Execution: each entry and each exit goes out in `split` equal tranches, one per bar. The replay
// prices a fill's impact against that bar's own pool, so three tranches over three bars pay about
// a third of the impact one order would (the delay is two minutes).
//
// The race ranks a bot that never trades below every bot that does, so if nothing has filled by
// the last hour it buys a token 5 USDC and lets the replay sell it at the end (about a cent in
// fees; the strategy's own trades are untouched).
//
// Determinism: only the bars received, + - * / and Math.sqrt (correctly rounded IEEE 754), no
// clock, no randomness: two runs on the same bars send the same orders byte for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';
import { Strategy } from './strategy.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 60; // entries: skip a buy that would fill far above the signal close
const EXIT_SLIPPAGE_BPS = 300; // exits: wider, so a stop in a fast fall still gets out

const WINDOW_BARS = 1440;
const FALLBACK_BAR = WINDOW_BARS - 60;
const FALLBACK_QUOTE = 5_000_000n; // 5 USDC

const strat = new Strategy();
const K = strat.p.split; // tranches per entry and per exit, one per bar
let mode: 'buy' | 'sell' | null = null; // the tranche run in progress
let left = 0; // tranches still to send in it
let px = 1;
let first = 0;
let traded = false;
let fallbackSent = false;
let fbN = 0;

await runBars({
  onHello(state: BarsState) {
    const s = state.hello.symbols.find((x) => x.symbol === SYMBOL)!;
    px = 10 ** s.price_scale;
    first = state.hello.first_close_ms;
  },
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // sync the strategy with what actually filled: the first tranche of an entry sets its
    // entry price, and the position counts as closed once nothing of it is left
    for (const f of batch.fills) {
      const fb = f.client_id.startsWith('fb');
      if (f.status !== 'filled') {
        if (fb) fallbackSent = false; // refused (slippage, no bar): try again
        continue;
      }
      traded = true;
      if (fb) continue;
      if (f.side === 'buy') {
        if (!strat.inPos) strat.filledBuy(Number(f.price) / px);
      } else if (!state.positions.has(SYMBOL)) {
        strat.filledSell();
        mode = null;
      }
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    if (strat.inPos && !state.positions.has(SYMBOL)) {
      strat.filledSell();
      mode = null;
    }

    const signal = strat.step(Number(bar.c) / px);
    const held = state.positions.get(SYMBOL);
    if (signal === 'sell' && held !== undefined && mode !== 'sell') {
      mode = 'sell';
      left = K;
    }
    if (signal === 'buy' && !strat.inPos && held === undefined) {
      mode = 'buy';
      left = K;
    }
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (mode === 'buy') {
      // an equal share of the cash per remaining tranche; the last keeps a hair of cash back
      const spend = left > 1 ? state.cash / BigInt(left) : state.cash - state.cash / 1000n;
      left--;
      if (left <= 0) mode = null;
      if (spend >= minNotional) return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      return [];
    }
    if (mode === 'sell' && held !== undefined) {
      // an equal share of what is left per remaining tranche; the last (repeated until it
      // fills) sells everything
      const qty = left > 1 ? held.qty / BigInt(left) : held.qty;
      if (left > 1) left--;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: EXIT_SLIPPAGE_BPS }];
    }
    const idx = Math.floor((batch.t - first) / 60000);
    if (!traded && !fallbackSent && held === undefined && idx >= FALLBACK_BAR && idx < WINDOW_BARS - 2 && state.cash >= FALLBACK_QUOTE) {
      fallbackSent = true;
      fbN++;
      return [{ side: 'buy', client_id: `fb${fbN}`, symbol: SYMBOL, notional_quote_units: FALLBACK_QUOTE, max_slippage_bps: 10_000 }];
    }
    return [];
  },
});
