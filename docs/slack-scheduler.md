# MPC QA scheduler

The scheduler uses Asia/Seoul (KST, UTC+9). User-visible Slack and sanitized report times use KST. Internal state uses UTC for unambiguous comparisons.

| Suite | Schedule in KST |
| --- | --- |
| Web regression | Every hour at :00 and :30 |
| API and automated UAT | 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 |
| Controlled load | Daily at 01:00 |

All suites currently use the isolated local Docker stack. The global pipeline lock serializes suites using the shared account. Runs queued past their grace period are visibly marked missed in scheduler-state.json instead of being replayed indefinitely. A first start does not backfill earlier runs. Restarting never reruns a claimed slot; interrupted jobs remain visible. Keep the host awake and Docker running. This local process does not install an OS startup service.

## Configuration

Store private configuration in the root `.env` (ignored by Git):

```dotenv
SLACK_BOT_TOKEN=xoxb-your-private-bot-token
SLACK_CHANNEL_ID=your-channel-id
QA_OWNER_SLACK_ID=your-member-id
QA_REPORT_BASE_URL=https://your-private-report-host.example/qa
QA_ALLURE_BASE_URL=https://your-private-report-host.example/allure
```

Use `config/slack-app-manifest.json` when creating/installing MPC QA in Slack. Invite the app to the destination channel. The manifest requests chat:write for publishing, channels:history for resolving uncertain parent-message delivery and channels:manage for channel creation. An existing channel does not require channels:manage; remove that scope if creating channels is unnecessary. No Socket Mode, app-level token or verification token is required. Tokens pasted in chat should be revoked and replaced privately.

The app cannot be installed from a channel ID alone. Workspace installation requires the workspace's permitted installer. After installation copy the Bot User OAuth Token (xoxb prefix) into .env and restart the scheduler. The app-level xapp token cannot post messages.

## Run

```sh
npm run qa:scheduler -- --dry-run
npm run qa:scheduler -- --check-slack
npm run qa:scheduler:start -- --run-now regression
npm run qa:scheduler:status
npm run qa:scheduler -- --stop
```

For foreground use: `npm run qa:scheduler`. For one tick: `npm run qa:scheduler -- --once`. `--run-now` adds one immediate run; it does not change cron cadence. Stop only the PID shown by the status command using SIGTERM. Restart after changing .env. A stopped worker may leave its current child finishing; a replacement worker waits for it rather than duplicating the suite.

## Storage and delivery

- `.env`: Slack token, channel ID, owner ID and report base URL; permissions 0600.
- `pipeline/config/schedules.json`: cadence, timezone, suite and target profile; no credentials.
- `runs/scheduler-state.json`: durable slots and queued/running/finished/missed/interrupted status.
- `runs/scheduler.log` and `runs/<runId>.log`: private worker logs.
- `runs/slack-bot-state.json`: sanitized queued messages, Slack timestamps and persistent incident state; no token.
- `runs/published/<runId>.md`: allowlisted summaries suitable for sharing from an access-controlled HTTPS host.
- `runs/<runId>/`: private raw diagnostic evidence; never upload this whole tree to shared hosting.
- `runs/allure/<runId>/`: Allure HTML report for the run's Playwright steps; `runs/allure/history.jsonl` carries trends between runs.

Slack gets one parent summary and threaded supporting details per run. New actionable failures mention the configured owner once. Repeated failures update the run's thread without repeating the mention. Only explicit passes close relevant incidents; skipped, absent or blocked checks leave them open. Exact test/fingerprint matching drives incident identity; AI duplicate suggestions never silently merge incidents.

Explicit 429 rejections wait until Retry-After. A network timeout or 5xx is ambiguous: reconcile against Slack history before resending. Stable client IDs and message metadata identify accepted messages. If history permissions/rate limits prevent reconciliation, leave the message uncertain instead of blindly duplicating it. Public-channel bot tokens may be unable to read thread replies with conversations.replies; uncertain replies then require manual reconciliation, while ordinary confirmed deliveries work normally. Slack does not provide an unconditional exactly-once guarantee. Permanent failures such as invalid_auth require configuration repair; pending messages remain on disk. The scheduler retries the outbox between runs. Missing credentials queue messages without exposing test data.

Shared summaries exclude raw error text, titles derived from test data, cookie headers, wallet addresses, screenshots, browser traces and request bodies. Known secret values are redacted from structured run records before disk writes. Raw evidence remains private because binary traces cannot be reliably redacted. Report links appear only when QA_REPORT_BASE_URL is configured; hosting that directory is an explicit deployment step.

## Allure report

Every Playwright step writes Allure results to `runs/<runId>/allure-results/`. Before Slack delivery the orchestrator builds one report per run into `runs/allure/<runId>/` with Allure 3 (`npx allure`, no Java needed); `allurerc.mjs` holds its config. A failed or skipped build only omits the link and is recorded under `allure` in the run record and in `runs/<runId>/allure.log`. Runs without Playwright steps (load-only) have no Allure report.

When `QA_ALLURE_BASE_URL` is set, the Slack summary adds `Allure: <base>/<runId>/index.html`. The same HTTPS rules as `QA_REPORT_BASE_URL` apply. Hosting is a deployment step, for example `aws s3 sync runs/allure s3://your-bucket/allure --exclude history.jsonl` after each run. Unlike `runs/published/`, Allure reports are **not** sanitized: they contain screenshots, traces, video and raw error text, so serve them only behind team-only access (SSO or VPN), never publicly. View one locally with `npx allure open runs/allure/<runId>`.

AI uses the existing approved-requirement validation and cannot change assertion outcomes. It remains optional; an exhausted API credit balance does not prevent tests or Slack delivery.

## Combined report preview

`npm run report:combined` shares web regression, API and load results from the newest completed run containing all three categories. UAT is excluded from its counts. The Slack parent contains the three result sections; its thread contains load metrics and source-run timestamps. The Markdown snapshot is written to `runs/published/combined-<sourceRunId>.md`. This is explicitly labelled a recorded-results preview and does not execute new tests or add a synthetic execution to run history. It does not repeat owner mentions for historical failures. Repeating the command for the same source reuses its durable message IDs.

Use `npm run report:combined -- --no-send` to create a local preview, or `npm run report:combined -- --source <runId>` to choose a completed source run. A missing category causes an error instead of fabricating a result.
