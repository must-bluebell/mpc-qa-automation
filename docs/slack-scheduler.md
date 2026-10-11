# MPC QA scheduler

The scheduler uses Asia/Seoul (KST, UTC+9). User-visible Slack and sanitized report times use KST. Internal state uses UTC for unambiguous comparisons.

| Job | Asia/Seoul (KST) | Asia/Karachi (Pakistan) |
| --- | --- | --- |
| Critical API + account-access UAT smoke | Every hour at :00 and :30 | Every hour at :00 and :30 |
| Full API + UAT regression | Daily 01:00 | Previous day 21:00 |
| Controlled load (baseline profile) | Sunday 03:00 | Saturday 23:00 |
| Consolidated QA health report | Daily 09:00 | Daily 05:00 |

The local scheduler owns recurring execution; GitHub recurring triggers are removed. GitHub push, merge dispatch and manual triggers remain available. Deploy the workflow change to the default branch to disable remote recurring triggers. The former suite rotation is disabled. Migration cancels obsolete queued jobs while preserving running jobs, notification work and history.

Critical smoke covers read-only API checks and three account-access journeys: session restoration, identity isolation and sign-in after logout. Full nightly UAT also runs the application's wider scenario suite. Nightly does not include load.

All suites use the isolated local Docker stack. One test worker runs at a time because the suites share accounts and application state. The scheduler keeps recording slots during long runs; smoke queued more than ten minutes late is marked missed. Nightly and weekly load have six-hour grace periods and take precedence over smoke. The daily summary has a 24-hour grace period and can run while a test worker is busy. A first start does not backfill earlier slots; restart catches up at most 24 hours, with older absences visible in daily reports. Keep the host awake and Docker running. This local process does not install an OS startup service.

The daily health job records the half-open 24-hour window ending at its scheduled cutoff. It aggregates API, UAT, web and load checks, pass rate among executed assertions, execution coverage including skipped/blocked checks, failure comparison events, infrastructure failures, completed/missed/pending/absent scheduled slots, latest nightly and latest load with timestamp and age. Seeded defects, previews, other environments and completions at or after cutoff are excluded from window totals. No executed assertions means an n/a pass rate. Historical load may be shown without contributing to today's counts. The report is a snapshot, never a new passing test execution. Delivery uses the same durable Slack outbox, without altering incidents.

The current environment is `local-docker`, Compose project `mpc-qa-rotation-20261011`:

| Service | Host endpoint | Container port |
| --- | --- | --- |
| WEB MPC (Next.js development server) | http://localhost:3410 | 3400 |
| BSC Anvil (chain 97) | http://localhost:8555 | 8545 |
| opBNB Anvil (chain 5611) | http://localhost:8556 | 8545 |
| PostgreSQL 16 | localhost:5440 | 5432 |
| Neon HTTP proxy | http://localhost:4454 | 4444 |

UAT scripts inside the web container use `127.0.0.1:3400` for HTTP transport while retaining `http://localhost:3410` as the Origin and SIWE domain. Host-side browsers use port 3410. Mixing these addresses causes `ECONNREFUSED` in the scenario scripts.

The previous `mpc-qa-rotation-20261010` containers are stopped and their volumes are preserved. The current project starts with clean contracts, database and build cache; it does not reuse the previous legacy bridge registry or corrupted Turbopack cache. Use `npm run stack:status` to confirm all five services are healthy before running suites.

Load baselines are stored as `pipeline/baselines/<environment>-<profile>-<workloadId>.json`. The workload ID covers the k6 script, effective profile, measured endpoints and session count. Changing the traffic mix creates a separate baseline only after every absolute SLO and functional check passes. App changes continue to compare against the same workload baseline. Older baseline files remain available; the former 10-user traffic mix is not compared with the current 15-user mix.

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
npm run qa:scheduler:start
npm run qa:scheduler:status
npm run qa:scheduler -- --stop
```

For foreground use: `npm run qa:scheduler`. For one tick: `npm run qa:scheduler -- --once`. `--run-now` adds an extra immediate run; omit it for normal scheduled operation. `--status` shows upcoming cron slots and recent jobs. Stop only the PID shown by the status command using SIGTERM. Restart after changing .env. A stopped worker may leave its current child finishing; a replacement worker waits for it rather than duplicating the suite.

## Storage and delivery

- `.env`: Slack token, channel ID, owner ID and report base URL; permissions 0600.
- `pipeline/config/schedules.json`: cadence, timezone, suite and target profile; no credentials.
- `runs/scheduler-state.json`: durable slots and queued/running/finished/missed/interrupted status.
- `runs/scheduler.log` and `runs/<runId>.log`: private worker logs.
- `runs/slack-bot-state.json`: sanitized queued messages, Slack timestamps and persistent incident state; no token.
- `runs/health/<jobId>.json`: daily report snapshot, separate from test run history.
- `runs/published/<runId>.md`: allowlisted summaries suitable for sharing from an access-controlled HTTPS host.
- `runs/<runId>/`: private raw diagnostic evidence; never upload this whole tree to shared hosting.
- `runs/allure/<runId>/`: Allure HTML report for the run's Playwright steps; `runs/allure/history.jsonl` carries trends between runs.

Slack gets a separate parent summary for each workflow. Its thread lists failed, blocked/skipped and passed cases separately, followed by diagnostics, the saved validated AI review (findings, evidence references, duplicate hypotheses and proposed scenarios), and system health last. Long case lists and AI reviews are split into readable messages. AI proposals remain labelled “not an acceptance check.” Daily health uses a short parent with its 24-hour history in a thread. New actionable failures mention the configured owner once. Repeated failures update the run's thread without repeating the mention. Only explicit passes close relevant incidents; skipped, absent or blocked checks leave them open. Exact test/fingerprint matching drives incident identity; AI duplicate suggestions never silently merge incidents.

Explicit 429 rejections wait until Retry-After. A network timeout or 5xx is ambiguous: reconcile against Slack history before resending. Stable client IDs and message metadata identify accepted messages. If history permissions/rate limits prevent reconciliation, leave the message uncertain instead of blindly duplicating it. Public-channel bot tokens may be unable to read thread replies with conversations.replies; uncertain replies then require manual reconciliation, while ordinary confirmed deliveries work normally. Slack does not provide an unconditional exactly-once guarantee. Permanent failures such as invalid_auth require configuration repair; pending messages remain on disk. The scheduler retries the outbox between runs. Missing credentials queue messages without exposing test data.

Shared summaries exclude raw error text, titles derived from test data, cookie headers, wallet addresses, screenshots, browser traces and request bodies. Known secret values are redacted from structured run records before disk writes. Raw evidence remains private because binary traces cannot be reliably redacted. Report links appear only when QA_REPORT_BASE_URL is configured; hosting that directory is an explicit deployment step.

## Allure report

Every Playwright step writes Allure results to `runs/<runId>/allure-results/`. Before Slack delivery the orchestrator builds one report per run into `runs/allure/<runId>/` with Allure 3 (`npx allure`, no Java needed); `allurerc.mjs` holds its config. A failed or skipped build only omits the link and is recorded under `allure` in the run record and in `runs/<runId>/allure.log`. Runs without Playwright steps (load-only) have no Allure report.

When `QA_ALLURE_BASE_URL` is set, the Slack summary adds `Allure: <base>/<runId>/index.html`. The same HTTPS rules as `QA_REPORT_BASE_URL` apply. Hosting is a deployment step, for example `aws s3 sync runs/allure s3://your-bucket/allure --exclude history.jsonl` after each run. Unlike `runs/published/`, Allure reports are **not** sanitized: they contain screenshots, traces, video and raw error text, so serve them only behind team-only access (SSO or VPN), never publicly. View one locally with `npx allure open runs/allure/<runId>`.

Nightly API + UAT explicitly requests AI review even when passing; other test schedules inherit `QA_AI_AUTO=1` for failures and blocked runs. The local OpenClaw provider requires its authenticated gateway and dedicated tools-disabled review agent to be available. AI failures are recorded separately from assertion outcomes and can be retried with `node pipeline/ai/analyze.mjs <runId>`; AI has no durable retry outbox.

AI uses the existing approved-requirement validation and cannot change assertion outcomes. It remains optional; an exhausted API credit balance does not prevent tests or Slack delivery.

## Combined report preview

`npm run report:combined` shares web regression, API and load results from the newest completed run containing all three categories. UAT is excluded from its counts. The Slack parent contains the three result sections; its thread contains load metrics and source-run timestamps. The Markdown snapshot is written to `runs/published/combined-<sourceRunId>.md`. This is explicitly labelled a recorded-results preview and does not execute new tests or add a synthetic execution to run history. It does not repeat owner mentions for historical failures. Repeating the command for the same source reuses its durable message IDs.

Use `npm run report:combined -- --no-send` to create a local preview, or `npm run report:combined -- --source <runId>` to choose a completed source run. A missing category causes an error instead of fabricating a result.
