# Operational alerts

`src/platform/integrations/slack/server/alert.ts` is the shared server-only contract and Slack delivery channel. Detection rules
must produce a `SystemAlert`; they must not construct Slack Block Kit payloads or call the webhook
directly. This keeps future funnel, email, database, and relay alerts on one message format.

```ts
import { sendSlackAlert } from '@platform/integrations/slack/server/alert'

const delivery = await sendSlackAlert({
  key: 'dependency_degraded',
  severity: 'warning',
  title: 'Dependency degraded',
  summary: 'Requests are completing more slowly than expected.',
  facts: [{ label: 'Service', value: 'example' }],
})
```

The sender reads `SLACK_ALERT_WEBHOOK_URL` at call time. Missing or failed delivery returns a narrow
result such as `not_configured`, `timeout`, or `slack_http_429`; it does not throw. Callers should log
only that result code, never the webhook or complete provider response.

Test messages use the same webhook. The standalone `alert` command sets `test: true`; the
shared renderer then puts a visible `[TEST]` prefix in both the Slack header and its plain-text
notification fallback. Alerts produced by real application flows are never labeled `[TEST]`.

Preview the default test payload without sending it:

```sh
pnpm run alert
```

Send it explicitly:

```sh
pnpm run alert --send
```

The command loads `.env.local`, never prints the webhook, and is always marked `[TEST]`. It verifies
only Slack delivery; feature behavior belongs to automated tests and real feature paths. Unit tests
inject `fetchImpl` and a dummy webhook, so `pnpm test` never contacts Slack.

Manual alert commands use one consistent namespace:

- `pnpm run alert` checks the shared Slack delivery format;
- `pnpm run alert:funnel` simulates the email, gasless SBT, and Telegram percentages;
- `pnpm run alert:gasless` simulates an individual relay failure;
- `pnpm run alert:funding` reads the real testnet MegaFuel policies.

Every command previews by default. Add `--send` only when the `[TEST]` message should be delivered.

## Gasless relay submission failure

`POST /api/relay/submit` schedules a best-effort Slack notification after returning the user's
fallback response when the relay outcome is `relayer_unfunded`, `sim_reverted`, or `reverted`. The
background callback rereads `relay_sends` and sends only when that exact challenge is already in the
terminal `failed` state. Wallet signature refusals, policy gates, limits, and an uncertain broadcast
do not alert.

The real UI path triggers it: run the app, complete the join flow, and approve the gasless
typed-data signature. An alert is sent only if `/api/relay/submit` then reaches a terminal failure. A
failure earlier at `/api/relay/challenge`, or a successful/in-flight transaction, correctly sends no
alert. The initial version has no artificial UI fault injection and does not modify chain behavior.

Preview or send a simulated failure message without submitting a relay:

```sh
pnpm run alert:gasless
pnpm run alert:gasless --scenario=relayer_unfunded --send
pnpm run alert:gasless --scenario=sim_reverted --send
pnpm run alert:gasless --scenario=reverted --send
```

## Privacy and ownership

- Do not put secrets, plaintext email addresses, full wallet addresses, or raw error responses in an
  alert. Prefer stable reason codes and aggregate counts.
- Rules own detection, thresholds, and the facts they expose.
- `renderSlackAlert` owns presentation and Slack escaping.
- `sendSlackAlert` owns webhook validation, timeout, and narrow delivery errors.
- This first event alert has no delivery persistence or deduplication. Retrying the same terminal
  submission can send the same alert again. Add that state only when observed alert volume justifies
  the database lifecycle and migration.

## opBNB MegaFuel funding below 0.1 BNB

This is a **condition alert**, not an individual transaction-failure alert. The scheduled
`GET /api/cron/megafuel-funding` route reads `remainingBalance` for the opBNB policy from
NodeReal's management API. A policy is low only when its balance is strictly below the configured
threshold. BSC funding is no longer monitored; exactly `0.1 BNB` is healthy when the threshold is `0.1`.

Configure these values in the chain bundle, not the shared `.env.local`:

```dotenv
# .env.prev for testnet; .env.prod for mainnet
NODEREAL_MEGAFUEL_API_KEY=
MEGAFUEL_OPBNB_POLICY_UUID=
MEGAFUEL_FUNDING_ALERT_THRESHOLD_BNB=0.1
```

The API key is embedded in NodeReal's management endpoint, so it is masked centrally by the server
logger. Provider errors are reduced to stable reason codes. A malformed or unavailable response is
reported as unavailable and never interpreted as a zero balance.

### Local test against real testnet policies

For an opBNB testnet balance of `0.139999 BNB`, temporarily set
this in `.env.prev`:

```dotenv
MEGAFUEL_FUNDING_ALERT_THRESHOLD_BNB=0.2
```

Then perform a read-only check:

```sh
pnpm run alert:funding
```

It should report opBNB as `LOW`. To send the breached policy through the real
Slack webhook, visibly marked as a test:

```sh
pnpm run alert:funding --send
```

Restore the threshold to `0.1` after testing. Each explicit `--send` is a new test.

### Scheduling

Vercel calls the authenticated cron route once daily at 01:00 UTC (10:00 KST). The route uses the shared
`CRON_SECRET` authorization and lease. There is deliberately no database state or deduplication:
while a policy remains below the threshold, every scheduled run sends another reminder. As soon as
the balance is equal to or above the threshold, the reminders stop automatically. A failed Slack
delivery is naturally attempted again by the next scheduled run.

## Funnel failure rates

The scheduled `GET /api/cron/funnel-failures` route measures three completion outcomes from ledgers
the application already writes. It creates no new table and stores no email address or wallet in
Slack.

- **Email verification:** a wallet requested an OTP, but no `users` row was verified within five
  minutes of that wallet's first request in the cohort.
- **Gasless SBT claim:** a wallet started a gasless `claim` relay, but no claim for that wallet
  reached `landed` within ten minutes of its first claim attempt in the cohort.
- **Telegram verification:** an eligible wallet started Telegram authentication but no group
  membership was confirmed within ten minutes. A recorded account-link conflict is excluded from
  the evaluated denominator unless that wallet retries and completes registration. Historical
  conflicts that were never recorded remain ordinary failures.

All three rules alert when at least 10 distinct wallets can be evaluated and at least 30% failed.
Failure rates from 30% through 59.9% are warnings; rates of 60% or more are critical.
Retries by the same wallet inside one cohort do not increase the denominator. The route runs every
five minutes and evaluates a mature five-minute arrival cohort, so consecutive scheduled runs do
not measure the same starts twice. For example, at 12:15:

- email evaluates starts from 12:05 up to (but not including) 12:10;
- gasless SBT and Telegram evaluate starts from 12:00 up to (but not including) 12:05.

This is deliberately a user-impact alert. The existing gasless relay submission alert remains the
immediate technical signal for each terminal relay failure. Also, “email verification failure”
means the user did not finish verification; the database cannot prove whether a mailbox provider
actually delivered or displayed the message. Wallet-paid SBT claims are not represented in
`relay_sends`, so this metric covers the gasless claim path only.

### Deterministic local scenarios

Preview three dummy 30% breach messages without writing to the database, sending email, or touching a
blockchain:

```sh
pnpm run alert:funnel
```

Send one scenario through the configured local Slack webhook. These messages are always visibly
marked `[TEST]`:

```sh
pnpm run alert:funnel --scenario=email --send
pnpm run alert:funnel --scenario=claim --send
pnpm run alert:funnel --scenario=telegram --send
```

Unit tests cover the threshold, minimum sample, message selection, and cron response. The DB
integration test covers timestamp boundaries and retry deduplication when `DATABASE_URL_TEST` is
configured. Production cron messages never carry the `[TEST]` marker.
