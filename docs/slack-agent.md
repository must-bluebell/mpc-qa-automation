# Conversational MPC QA Slack agent

The existing MPC QA Slack app can receive channel mentions and direct messages through Socket Mode. The listener answers questions from sanitized local QA history and submits authorized, confirmed reruns to the existing scheduler. This feature is separate from PR preview testing.

## Enable the existing app

1. Open the existing MPC QA application at https://api.slack.com/apps. Apply the updated `config/slack-app-manifest.json`, retaining the existing app identity. This repository file does not update Slack by itself.
2. Enable Socket Mode. Under Basic Information → App-Level Tokens, generate a token with `connections:write`. Save the `xapp-` token privately as `SLACK_APP_TOKEN`; retain the existing `xoxb-` bot token.
3. Add the bot scopes `app_mentions:read` and `im:history` alongside the current reporting scopes. Enable Event Subscriptions and subscribe to `app_mention` and `message.im`. Enable the App Home Messages tab and allow users to send messages. Enable Interactivity. Socket Mode does not need an HTTP Request URL.
4. Reinstall/reauthorize the same app when prompted. Invite MPC QA to the configured channel. In channels, mention the app in each follow-up. In the app Messages tab, send ordinary messages without a mention. Group DMs and ordinary unmentioned channel messages are ignored.
5. Configure the private root `.env` (never commit actual values):

```dotenv
QA_SLACK_AGENT_ENABLED=1
QA_SLACK_TEAM_ID=T_WORKSPACE_ID
QA_SLACK_ALLOWED_CHANNEL_IDS=*
QA_SLACK_ALLOW_DMS=1
SLACK_CHANNEL_ID=C_QA_CHANNEL_ID
SLACK_BOT_TOKEN=xoxb-your-existing-token
SLACK_APP_TOKEN=xapp-your-new-token
QA_SLACK_ALLOWED_USER_IDS=U_AUTHORIZED_USER_ID,U_ANOTHER_USER_ID
QA_SLACK_ALLOWED_SUITES=smoke,api,regression,uat,load,full
QA_SLACK_ALLOWED_ENVIRONMENTS=local-docker
QA_SLACK_AGENT_AI=0
QA_EXTERNAL_REPOSITORIES=0
```

Use real Slack IDs without underscores. Rerun users default to `QA_OWNER_SLACK_ID` when the explicit user list is blank; without either, reruns are denied. Read-only questions are allowed in the configured workspace. `QA_SLACK_ALLOWED_CHANNEL_IDS=*` accepts mentions in all channels where the app has been invited; a comma-separated list accepts only those channel IDs. Blank defaults to the existing `SLACK_CHANNEL_ID`. `QA_SLACK_ALLOW_DMS=1` separately enables one-to-one direct messages. DM-only operation works with an empty reporting channel and empty allowed-channel list. Scheduled reports still use `SLACK_CHANNEL_ID`; it is independent of conversational access. Other workspaces, bots, group DMs and edited messages are ignored. The app's bot token must belong to the configured workspace. Keep `.env` private (0600).

6. Run `npm ci`, then `npm run qa:slack-agent:check`. This checks local configuration only; starting the listener validates workspace authentication. Start the listener with `npm run qa:slack-agent` in a supervised terminal or service. `npm run qa:slack-agent:status` reports its process lock. Stop the foreground process with Ctrl+C/SIGTERM.
7. Restart the scheduler after installing this change or changing `.env`: `npm run qa:scheduler -- --stop`, then `npm run qa:scheduler:start`. Only one scheduler should own this run directory. The listener does not start the scheduler automatically.
8. For the existing container deployment, rebuild the automation image and explicitly set `QA_SLACK_AGENT_ENABLED=1` in `.env`. The existing service supervisor starts and stops the listener with its peers. `restart: unless-stopped` restarts a failed container while Docker is available. Host installations need their own startup supervision. Preserve the repository restriction and existing volumes; do not rebuild the application stack merely to enable chat.

## Questions

In channels, mention `@MPC QA` before each example. In the MPC QA app Messages tab, send the question directly:

- `what failed in the latest API run?`
- `when did UAT tests last pass?`
- `show the latest report`
- `show report <runId>` (replace the placeholder with an actual ID)
- `is the scheduler running?`
- `what is the testing schedule?`
- `help`
- `what are your capabilities?`
- `show the last tested PR`
- `failed cases in the last tested PR`
- `show the last merged PR name`
- `who merged the code?`
- `how was the code merged?`

Read-only questions accept common wording variations, greetings, inline mentions, punctuation, and supported synonyms. For example, “introduce yourself”, “what is your role?”, and “what are you capable of?” return the testing capabilities; “how did the tests go?” returns results; “last green run” asks for the last passing run; “who landed the code?” asks for recorded PR merge details. API/endpoint, UAT/acceptance, load/performance, and browser/UI terminology select the corresponding suite. Unknown questions return QA guidance. Advisory AI is reserved for explicit questions about explaining or analyzing QA evidence; unmatched wording is never automatically sent to the model. Rerun commands retain their exact grammar and confirmation requirements.

PR questions use read-only GitHub CLI queries against `QA_SLACK_PR_REPOSITORY` (for this installation, `globalmpc/mpc-automation`). Install `gh` and authenticate it with read access on the listener host; the current Docker image does not bundle `gh`. These queries inspect the latest 100 updated PRs and current-head checks. A completed `MPC QA / pre-merge`, `Automation self-checks`, `Wallet tests`, or `qa` check identifies testing evidence; skipped and pending checks do not. The answer identifies the actual check rather than claiming every test suite passed. Failed checks link to their QA evidence; individual failed case names require the linked report and are not inferred from unrelated local runs. Merge reports include the title, number, merger, timestamp, branches, and merge commit when available. The merge method is reported as unavailable because this metadata does not establish squash versus rebase versus merge. PR reporting does not merge code or change GitHub state.

Answers examine the latest 100 run records, excluding running, seeded-defect and report-only preview records. Each result names the source run, environment and completion timestamp. Unknown/raw test names and error text are not published. Report links use `QA_REPORT_BASE_URL` when it is a valid HTTPS base; otherwise they point to the private dashboard on the scheduler host. A localhost link requires access to that host and an established private dashboard session. Private screenshots, traces, logs and browser storage are never uploaded by the conversational listener.

Set `QA_SLACK_AGENT_AI=1` for optional questions such as `explain the pattern across runs`. The configured QA model receives a redacted question of at most 800 characters and at most five sanitized runs, capped at 20 checks per run. Status/count questions remain deterministic. Model explanations are advisory and must cite supplied run IDs; failed validation falls back to recorded-result guidance. No model output can call tools, confirm requests or select execution targets. Redaction cannot detect every arbitrary secret typed into chat: never include credentials in questions. No conversation history is sent to the model. Only one advisory explanation runs at a time; status questions remain available while it finishes.

## Controlled reruns

Use `rerun api`, `rerun regression`, `rerun uat`, `rerun load`, `rerun smoke`, or `rerun full`. An optional `on local-docker` selects the configured environment. Arbitrary commands and URLs are not accepted. Every target must be a configured isolated loopback environment; production writes and load remain refused.

The app posts Confirm rerun/Cancel buttons. Only the requesting, currently authorized user can act, in the original channel/thread/workspace. Confirmation expires after five minutes. Cancellation applies before confirmation; confirmed/running work is not remotely killed. At most three pending/queued/running requests per user are allowed. A duplicate Slack event or button click cannot create another job.

A confirmed request waits in a durable inbox, and the scheduler persists the job before marking it consumed. Jobs share the existing single pipeline worker. Unconsumed requests expire after one hour; consumed jobs have a one-hour scheduling grace period. After restarting the scheduler with changed configuration, disabling the feature or revoking permissions prevents new inbox consumption and cancels already-consumed Slack jobs that have not started. Running tests are allowed to finish. Expired unconfirmed proposals release their outstanding-request slots automatically. Unreadable inbox records hold Slack dispatch while ordinary schedules remain available. Existing application safety and repository restrictions still apply; an unhealthy stack produces an infrastructure result, not a passing test. Completion is posted in the original conversation/thread. Channel-initiated reruns also use normal pipeline reporting. DM-initiated reruns suppress the channel broadcast and return completion privately in that DM; evidence is still saved locally.

## Multiple channels and private use

Invite the existing app into each desired public or private channel; it does not automatically join channels. With `QA_SLACK_ALLOWED_CHANNEL_IDS=*`, mention it there to ask questions. To talk separately, open MPC QA under Apps, select Messages and send a question. No channel or `@` mention is needed in a one-to-one DM. Enable the Messages tab in App Home if Slack does not show an input box.

After updating the manifest in the Slack developer portal, reinstall/reauthorize the app so `im:history` is granted. Saving this repository manifest or `.env` alone does not change Slack subscriptions. Restart both local processes after policy changes. Existing confirmations remain bound to their original conversation; a DM confirmation cannot be reused in another DM or channel.

## Private state and delivery

`runs/slack-agent/` stores private request identities, confirmation timestamps, audit transitions, run IDs and reply delivery receipts; no raw user questions or tokens are intentionally persisted. It also stores redacted reply text so explicit rate-limit rejections can be retried. Requests and replies use atomic files under a short state lock. The scheduler is the only writer of `scheduler-state.json`; the listener never overwrites it. Back up these files with the corresponding scheduler state.

Explicit Slack 429 rejections wait until Retry-After. SDK network retries are disabled for posting replies. A timeout, 5xx, or crash after persisting a send claim is ambiguous: `sending`/`uncertain` records are held instead of blindly resent. A crash while handling a question may leave it unanswered; ask again in a new message. An accepted confirmation remains durable even if its acknowledgment reply is lost.

For ambiguous messages, inspect the original Slack thread and private record before taking action. Never delete request files to force reruns or remove process locks while their owners are alive. A new explicit rerun request is auditable and should be preferred over editing state. Corrupt records fail closed and require operator repair. Empty/missing inbox state must not be substituted for damaged state.

## Validation and current limits

Run `node --test tests/reporting/slack-agent*.test.mjs`, `npm run test:reporting`, `npm run test:dashboard` and `npm run typecheck`. These tests use temporary directories and mocked Slack network boundaries; they do not post to a workspace.

Live acceptance requires updated app permissions, the app-level token and a connected listener: test a question, denied requester, cancellation, confirmation, duplicate click, completion, restart and unavailable target. Successful reruns also require the local application stack to be healthy. This implementation does not restore the stopped chains, bypass `QA_EXTERNAL_REPOSITORIES=0`, enable application-owned UAT scenarios, or change GitHub PR settings.

Slack references: https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/ and https://docs.slack.dev/tools/bolt-js/concepts/actions/.
