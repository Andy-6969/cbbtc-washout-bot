// cbBTC minute bot for make.fun's "Race a BTC trading bot live for 24 hours" (bars-replay/v1).
//
// Long only, one position, Node 22 standard library plus the kit's SDK shim (vendor/).
//
// The idea: buy the snap-back after a washout. When cbBTC has fallen a long way below its recent
// high (a "dip") and then closes clearly above the lowest close of the last few bars (a "bounce"),
// buy with almost all the cash; sell at a take-profit, a stop-loss or a time limit.
//
// "A long way" is measured against the market's own volatility, so the bot reads a calm day and a
// wild day alike: unit = RMS of 1-minute returns x sqrt(lookback), the typical move over the
// lookback, and dip, bounce, take-profit and stop are multiples of it (dip never under a floor, so
// a trade always aims well past the ~26 bps a round trip costs).
//
// The race ranks a bot that never trades below every bot that does, so if nothing has filled by
// the last hour it buys a token 5 USDC and lets the replay sell it at the end (about a cent in
// fees; the strategy's own trades are untouched).
//
// Determinism: only the bars received, + - * / and Math.sqrt (correctly rounded IEEE 754), no
// clock, no randomness: two runs on the same bars send the same orders byte for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 60;

const P = {
  dipLookback: 360, // bars for the recent high
  dipMinHist: 360, // bars of history before the first entry
  volBars: 360, // bars of 1-minute returns for the volatility
  dipK: 1.9, // dip = dipK * unit below the recent high
  dipFloorBps: 150, // never call less than this a dip
  bounceBars: 5, // the low the bounce is measured from
  bounceFrac: 0.133, // bounce = this share of the dip, above that low
  tpFrac: 0.667, // take-profit = this share of the dip
  slFrac: 0.6, // stop-loss = this share of the dip
  maxHold: 480, // bars
  cooldown: 30, // bars after an exit before a new entry
};

const WINDOW_BARS = 1440;
const FALLBACK_BAR = WINDOW_BARS - 60;
const FALLBACK_QUOTE = 5_000_000n; // 5 USDC

/** Pure decision logic: feed closes in, get 'buy', 'sell' or null out. */
class Strategy {
  closes: number[] = [];
  sq: number[] = []; // squared 1-minute returns
  inPos = false;
  entry = 0;
  held = 0;
  tp = 0;
  sl = 0;
  sinceExit = 1e9;

  /** [dip, bounce, tp, sl] in bps for a lookback of lb bars. */
  thresholds(lb: number): [number, number, number, number] {
    const w = this.sq.slice(-P.volBars);
    let s = 0;
    for (const x of w) s += x;
    const sigma = w.length > 0 ? Math.sqrt(s / w.length) * 1e4 : 0;
    let dip = P.dipK * sigma * Math.sqrt(lb);
    if (dip < P.dipFloorBps) dip = P.dipFloorBps;
    return [dip, P.bounceFrac * dip, P.tpFrac * dip, P.slFrac * dip];
  }

  step(close: number): 'buy' | 'sell' | null {
    const c = this.closes;
    if (c.length > 0) {
      const r = close / c[c.length - 1] - 1;
      this.sq.push(r * r);
      if (this.sq.length > 2000) this.sq.splice(0, 1000);
    }
    c.push(close);
    if (c.length > 2000) c.splice(0, 1000);

    if (this.inPos) {
      this.held++;
      const gain = (close / this.entry - 1) * 1e4;
      if (gain >= this.tp || gain <= -this.sl || this.held >= P.maxHold) return 'sell';
      return null;
    }

    this.sinceExit++;
    if (this.sinceExit < P.cooldown) return null;
    const lb = Math.min(P.dipLookback, c.length - 1);
    if (lb < P.dipMinHist) return null;
    let hi = -Infinity;
    for (let i = c.length - 1 - lb; i < c.length - 1; i++) if (c[i] > hi) hi = c[i];
    let lo = Infinity;
    for (let i = c.length - 1 - P.bounceBars; i < c.length - 1; i++) if (c[i] < lo) lo = c[i];
    const [dip, bounce, tp, sl] = this.thresholds(lb);
    if ((1 - lo / hi) * 1e4 >= dip && (close / lo - 1) * 1e4 >= bounce) {
      this.tp = tp;
      this.sl = sl;
      return 'buy';
    }
    return null;
  }

  filledBuy(price: number): void {
    this.inPos = true;
    this.entry = price;
    this.held = 0;
  }

  filledSell(): void {
    this.inPos = false;
    this.sinceExit = 0;
  }
}

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
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
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
