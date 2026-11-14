// cbBTC minute bot for make.fun's "Race a BTC trading bot live for 24 hours" (bars-replay/v1).
//
// Long only, one position, Node 22 standard library plus the kit's SDK shim (vendor/).
//
// Two sleeves, one position, always (nearly) all in (the logic is in strategy.ts):
//  * washout: after a fall well below the 6-hour high, buy the first clear bounce; take profit,
//    stop out or time out, and past the target trail the rebound instead of selling it.
//  * trend: on a new 3-hour high with the fast average over the slow one, buy and ride it with a
//    tight first stop and a wide trailing stop, so false breakouts cost little and real runs pay.
// Every threshold scales with the RMS of 1-minute returns, so a calm day and a wild day read alike.
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
    // sync the strategy with what actually filled
    for (const f of batch.fills) {
      const fb = f.client_id.startsWith('fb');
      if (f.status !== 'filled') {
        if (fb) fallbackSent = false; // refused (slippage, no bar): try again
        continue;
      }
      traded = true;
      if (fb) continue;
      if (f.side === 'buy') strat.filledBuy(Number(f.price) / px);
      else if (!state.positions.has(SYMBOL)) strat.filledSell();
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    if (strat.inPos && !state.positions.has(SYMBOL)) strat.filledSell();

    const signal = strat.step(Number(bar.c) / px);
    const held = state.positions.get(SYMBOL);
    if (signal === 'sell' && held !== undefined) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: EXIT_SLIPPAGE_BPS }];
    }
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (signal === 'buy' && !strat.inPos) {
      const spend = state.cash - state.cash / 1000n; // keep a hair of cash back
      if (spend >= minNotional) return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
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
