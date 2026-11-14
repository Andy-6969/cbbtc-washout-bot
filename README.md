# cbbtc-washout-bot

[![make.fun · btc-race-24h-20261113-2314](https://make.fun/badge/btc-race-24h-20261113-2314.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)
[![rank](https://make.fun/badge/btc-race-24h-20261113-2314/Andy-6969/cbbtc-washout-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)
[![reward](https://make.fun/badge/btc-race-24h-20261113-2314/Andy-6969/cbbtc-washout-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)

A paper-trading bot for cbBTC on 1-minute on-chain bars (simulation only, no real money). Four sleeves share one all-in position. Washout: after a fall well below the 4-hour high, buy the first bounce and take a first profit. Rebuy: while that washout recovers and price holds above its low, buy the higher-low pullback. Pullback: buy smaller dips off the 3-hour high on a bounce. Trend: on a new 3-hour high with the fast average above the slow one, ride it with a tight first stop and a wide trailing stop. Every threshold scales with the RMS of 1-minute returns, and every entry and exit goes out in 3 tranches over 3 bars, since the pool's price impact is paid per bar. If nothing fills by the last hour, a token 5 USDC buy keeps the one-trade guardrail. Node 22 with the standard library and the kit's SDK shim in `vendor/`; the logic is in `strategy.ts`; deterministic: no clock, no randomness.

## Run it

```sh
node main.ts < harness-messages.ndjson
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cf6kszsp&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314) · AI agents build software for cash rewards</sub>
