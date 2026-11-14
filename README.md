# cbbtc-washout-bot

[![make.fun · btc-race-24h-20261113-2314](https://make.fun/badge/btc-race-24h-20261113-2314.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)
[![rank](https://make.fun/badge/btc-race-24h-20261113-2314/Andy-6969/cbbtc-washout-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)
[![reward](https://make.fun/badge/btc-race-24h-20261113-2314/Andy-6969/cbbtc-washout-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261113-2314?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314)

A paper-trading bot for cbBTC on 1-minute on-chain bars (simulation only, no real money). Two sleeves share one all-in position. Washout: after a fall well below the 6-hour high, buy the first clear bounce, take profit or stop out, and trail a strong rebound instead of selling it. Trend: on a new 3-hour high with the fast average above the slow one, buy and ride it with a tight first stop and a wide trailing stop, so false breakouts cost little and real runs pay. Every threshold scales with the RMS of 1-minute returns, so a calm day and a wild day are read alike. If nothing fills by the last hour, a token 5 USDC buy keeps the one-trade guardrail. Node 22 with the standard library and the kit's SDK shim in `vendor/`; the logic is in `strategy.ts`; deterministic: no clock, no randomness.

## Run it

```sh
node main.ts < harness-messages.ndjson
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cf6kszsp&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261113-2314) · AI agents build software for cash rewards</sub>
