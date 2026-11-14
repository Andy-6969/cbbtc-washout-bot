// Decision logic of the bot, kept apart from the wire (main.ts) so it can be swept offline.
//
// Two ways in, each with its own way out; one position at a time, always (nearly) all in:
//
//  * washout: price has fallen dipK "units" below its recent high and then bounces clearly off
//    the lowest close of the last few bars -> buy the snap-back. Exit at a take-profit, a stop or
//    a time limit; past the take-profit's arm level a trailing stop lets a strong rebound run.
//  * trend: price closes at a new high of the last brkBars bars while the fast average is above
//    the slow one -> ride the move. Exit on a trailing stop from the highest close since entry,
//    or on an initial stop under the entry price.
//
// unit = RMS of 1-minute returns over volBars x sqrt(lookback): the typical move over the
// lookback, so every threshold reads a calm day and a wild day alike. Floors keep every target
// well past the ~26 bps a round trip costs.
//
// Only + - * / and Math.sqrt (both correctly rounded in IEEE 754): the same bars always give the
// same decisions.

export const DEFAULTS = {
  volBars: 360, // bars of 1-minute returns for the volatility
  cooldown: 30, // bars after an exit before a new entry

  // washout sleeve
  dipLookback: 360, // bars for the recent high
  dipMinHist: 360, // bars of history before the first washout entry
  dipK: 1.9, // dip = dipK * unit below the recent high
  dipFloorBps: 150, // never call less than this a dip
  bounceBars: 5, // the low the bounce is measured from
  bounceFrac: 0.133, // bounce = this share of the dip, above that low
  tpFrac: 0.667, // take-profit = this share of the dip
  slFrac: 0.6, // stop-loss = this share of the dip
  maxHold: 480, // bars
  rideTrailFrac: 0.3, // > 0: past the take-profit, trail this share of the dip instead of selling

  // trend sleeve (off while brkBars is 0): a tight first stop cuts a false breakout fast, a wide
  // trailing stop lets a real run go on for hours
  brkBars: 180, // new high of the last brkBars closes
  brkMinHist: 120, // bars of history before the first trend entry
  emaFast: 20,
  emaSlow: 120,
  trailK: 7, // trailing stop = trailK * unit(trailBars) below the highest close since entry
  trailBars: 60,
  trailFloorBps: 40,
  trendSlK: 1.25, // initial stop = trendSlK * unit(trailBars) under the entry
  trendMaxHold: 1440,
};

export type Params = typeof DEFAULTS;
export type Signal = 'buy' | 'sell' | null;

export class Strategy {
  p: Params;
  closes: number[] = [];
  sq: number[] = []; // squared 1-minute returns
  ef = 0;
  es = 0;
  n = 0;
  inPos = false;
  exiting = false;
  kind: 'washout' | 'trend' | null = null; // the sleeve of the open (or pending) position
  entry = 0;
  peak = 0;
  held = 0;
  tp = 0;
  sl = 0;
  trail = 0;
  sinceExit = 1e9;

  constructor(params: Partial<Params> = {}) {
    this.p = { ...DEFAULTS, ...params };
  }

  /** The typical move in bps over lb bars. */
  unit(lb: number): number {
    const w = this.sq.length > this.p.volBars ? this.sq.slice(-this.p.volBars) : this.sq;
    let s = 0;
    for (const x of w) s += x;
    return w.length > 0 ? Math.sqrt(s / w.length) * 1e4 * Math.sqrt(lb) : 0;
  }

  step(close: number): Signal {
    const p = this.p;
    const c = this.closes;
    if (c.length > 0) {
      const r = close / c[c.length - 1] - 1;
      this.sq.push(r * r);
      if (this.sq.length > 2000) this.sq.splice(0, 1000);
    }
    c.push(close);
    if (c.length > 2000) c.splice(0, 1000);
    this.n++;
    if (this.n === 1) {
      this.ef = close;
      this.es = close;
    } else {
      this.ef += (2 / (p.emaFast + 1)) * (close - this.ef);
      this.es += (2 / (p.emaSlow + 1)) * (close - this.es);
    }

    if (this.inPos) return this.manage(close);

    this.sinceExit++;
    if (this.sinceExit < p.cooldown) return null;

    // washout
    const lb = Math.min(p.dipLookback, c.length - 1);
    if (lb >= p.dipMinHist) {
      let hi = -Infinity;
      for (let i = c.length - 1 - lb; i < c.length - 1; i++) if (c[i] > hi) hi = c[i];
      let lo = Infinity;
      for (let i = c.length - 1 - p.bounceBars; i < c.length - 1; i++) if (c[i] < lo) lo = c[i];
      let dip = p.dipK * this.unit(lb);
      if (dip < p.dipFloorBps) dip = p.dipFloorBps;
      if ((1 - lo / hi) * 1e4 >= dip && (close / lo - 1) * 1e4 >= p.bounceFrac * dip) {
        this.kind = 'washout';
        this.tp = p.tpFrac * dip;
        this.sl = p.slFrac * dip;
        this.trail = p.rideTrailFrac * dip;
        return 'buy';
      }
    }

    // trend
    if (p.brkBars > 0 && c.length > p.brkBars && c.length - 1 >= p.brkMinHist) {
      let hi = -Infinity;
      for (let i = c.length - 1 - p.brkBars; i < c.length - 1; i++) if (c[i] > hi) hi = c[i];
      if (close > hi && this.ef > this.es) {
        const u = this.unit(p.trailBars);
        this.kind = 'trend';
        this.trail = Math.max(p.trailK * u, p.trailFloorBps);
        this.sl = Math.max(p.trendSlK * u, p.trailFloorBps);
        return 'buy';
      }
    }
    return null;
  }

  manage(close: number): Signal {
    const p = this.p;
    this.held++;
    if (close > this.peak) this.peak = close;
    // once an exit is decided it stands until a sell fills: a sell the market refused
    // (slippage cap, no bar) is sent again on the next bar even if the price came back
    if (this.exiting) return 'sell';
    const gain = (close / this.entry - 1) * 1e4;
    const fromPeak = (1 - close / this.peak) * 1e4;
    let out = false;
    if (this.kind === 'trend') {
      out = gain <= -this.sl || fromPeak >= this.trail || this.held >= p.trendMaxHold;
    } else {
      const peakGain = (this.peak / this.entry - 1) * 1e4;
      if (this.trail > 0 && peakGain >= this.tp) out = fromPeak >= this.trail;
      else out = (this.trail <= 0 && gain >= this.tp) || gain <= -this.sl;
      if (this.held >= p.maxHold) out = true;
    }
    if (out) this.exiting = true;
    return out ? 'sell' : null;
  }

  filledBuy(price: number): void {
    this.inPos = true;
    this.exiting = false;
    this.entry = price;
    this.peak = price;
    this.held = 0;
  }

  filledSell(): void {
    this.inPos = false;
    this.exiting = false;
    this.kind = null;
    this.sinceExit = 0;
  }
}
