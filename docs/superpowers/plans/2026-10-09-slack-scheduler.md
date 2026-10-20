# MPC QA scheduler implementation plan

User requested implementation and execution on 2026-10-09 after reviewing the proposed design. Execute inline in the current workspace; preserve existing work.

Goal: run web regression every 30 minutes, API and UAT every four hours, and load nightly at 01:00 Asia/Seoul. Reuse isolated local-docker suites until a different target is supplied.

Architecture: one persistent Node scheduler queues scheduled slots and serializes pipeline children. A bot transport stores a durable outbox, posts one parent summary per run, and uses its timestamp for details. Stable message IDs plus reconciliation prevent blind retry after ambiguous delivery. Incident state persists across blocked/skipped runs; recovery requires the affected test to pass. AI remains advisory and optional.

Files: pipeline/scheduler.mjs (cron slots and durable queue); pipeline/notify/slack-bot.mjs (outbox/threads/incidents); pipeline/lib/safe-output.mjs (sanitized publication); tests/reporting/scheduler.test.mjs and slack-bot.test.mjs (behavior); config/slack-app-manifest.json (installation); pipeline/config/schedules.json, package.json, .env.example and README.md (configuration).

Constraints: Node >=22.18; no new dependencies; KST for user-visible times, UTC for internal machine timestamps; credentials stay in ignored .env; app-level xapp tokens are rejected. Use safe allowlisted fields for Slack, never raw errors, cookies, traces or screenshots. Published report links require an explicitly configured HTTPS report base. Interrupted deliveries remain pending until reconciliation proves absence; do not claim exactly-once delivery from Slack itself.

Tasks:
- [x] Write scheduler tests: KST boundaries, schedule cadence, restart deduplication, crash recovery and invalid cron rejection. Run RED, implement, run GREEN.
- [x] Write bot tests: invalid token, one summary with threaded details, owner mention once, recurring incident across skipped runs, explicit recovery, HTTP 429 retry, ambiguous delivery reconciliation, secret filtering and duplicate invocation. Run RED, implement, run GREEN.
- [x] Integrate bot transport with pipeline; redact before disk/AI/Slack; limit shared artifacts to safe structured summaries. Add app manifest and local configuration without storing the exposed app token.
- [x] Run reporting tests and typecheck; review failure paths; exercise scheduler locally and start a single worker. Verify PID and state. An existing private xoxb token authenticated to the supplied workspace; a real run's summary and threaded details were delivered.

Review focus: process dies after claiming a slot; same slot seen twice after restart; timeout after Slack accepted a message; blocked runs between failure and recovery; secrets in titles, URLs and errors.

Verification: 25 reporting tests passed; TypeScript check passed; dry-run verified all KST slots. Independent code review identified three important crash/configuration-repair issues; each received a failing test and a passing fix. Added crash-report publication coverage. Real worker restart preserved the existing active run ID. No new product behavior was accepted from AI. The initial run exposed an invalid local wallet index (0,); corrected to 0 and verified wallet derivation privately, then started a rerun. Shared report hosting remains unconfigured; private results are retained locally. Raw diagnostic artifacts are private and intentionally excluded from publication. The worker must run on an awake host and is not an OS reboot service.
