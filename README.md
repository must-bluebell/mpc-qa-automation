# MPC Wallet QA

Playwright tests for wallet discovery, connection, SIWE sign-in, connected-address display, and wallet errors during connection, signing, and network switching.

## Setup

```sh
npm ci
npx playwright install chromium
cp .env.example .env
```

Set `BASE_URL`, `QA_CHAIN_ID`, `QA_SEED_PHRASE`, `WALLET_ADDRESS`, and `WALLET_ADDRESS_INDEX` in `.env`. The phrase must derive the supplied address at the configured index. Keep the phrase out of version control. Tests use that fixed address, display “Trust Wallet” as the wallet label, and run one at a time. Successful sign-in verifies the server session and opens `/?view=dig` without digging or sending transactions.

## Run

```sh
npm test
npm run test:wallet
npm run test:headed
npm run test:ui
npm run test:watch
npm run typecheck
npm run report
```

Tests skip when the seed phrase is missing. Sign-in tests also skip if the deployment refuses same-origin authentication requests. CI skips successful sign-in tests on mainnet targets.

## Wallet code

- `fixtures/wallet.ts`: EIP-6963 mock provider, Node-side signing, and configurable wallet failures.
- `utils/wallet-generator.ts`: Fixed wallet derivation with address and recovery-phrase matching.
- `config/target.ts`: target URL, chain ID, and display names.
- `fixtures/network.ts`: third-party analytics stubs used by wallet tests.
- `fixtures/tiers.ts`: authentication capability probe used by signing tests.
- `pages/JoinSheet.ts` and `pages/copy.ts`: wallet flow locators, actions, and matching UI strings.
- `tests/wallet/wallet-flow.spec.ts` and `tests/wallet/wallet-errors.spec.ts`: wallet tests.
- `tests/wallet/standalone.ts`: existing self-contained version for use in another project. The default suite runs the modular tests. To use the standalone copy in another project, save it as `wallet-standalone.spec.ts`.

The Community step name is retained only to confirm successful wallet sign-in. No community actions are tested.

`npm run check:copy` checks wallet locator strings against a sibling `globalmpc-webapp` checkout. It skips when that checkout is unavailable; use `WEBAPP_PATH` to override the location.

GitHub Actions runs static checks on pushes and pull requests. Wallet browser tests run when a target is supplied through workflow or repository dispatch. Configure the `QA_SEED_PHRASE` repository secret for those runs.

All 20 runnable tests live in `tests/wallet`: W01–W19 and the recorded journey, which contains ordered steps W20–W24. Run the entire folder with `npm run test:wallet`.

Successful sign-in cases keep the Digging screen open for 10 seconds before finishing. They have a 180-second total timeout; the complete recorded journey has a 300-second total timeout. Run `npm run test:wallet -- --grep "W02" --headed` to watch the successful connection.

The recorded journey now lives under **Wallet sign-in and recovery** in `tests/wallet/wallet-flow.spec.ts`. It connects once, then runs steps W20–W24 in recording order: account → Ventures → Copy → claim state → proposal 1 → community check-in → X → Digging. The actions are implemented in `tests/wallet/recorded-actions.ts`. This is one journey test with ordered steps, so later steps use the same connected session. No rewards are claimed when Claim crew is disabled. X blocking is attached to the report and does not prevent returning to Digging.

Run `npm run test:wallet -- --grep "W20" --headed` to watch the whole recorded journey. The raw recording remains at `tests/wallet/recordings/original-session.txt`.

## Regression reporting and AI analysis

Every test run writes `playwright-report/regression-summary.md` and `.json`, plus `ai-analysis.md` and a redacted `ai-analysis-input.json`. Reports use actual assertion results, with final retry counts, skipped tests, explicitly blocked tests, flaky tests, configured owner, and the target deployment version. Available traces/screenshots are copied into `playwright-report/evidence`. The generated Markdown includes evidence links. Nothing is sent to Slack or email.

Set `QA_ENVIRONMENT`, `QA_VERSION`, and `QA_OWNER` locally or in CI. An absent target version is reported as unspecified; the QA repository's commit is not substituted for the application's deployment version. `npm run test:nightly` sets the summary label to Nightly regression. This command does not schedule a nightly job. CI publishes the summary in the workflow job summary and uploads the complete report.

`npm run test:reporting` checks reporting and AI validation without a wallet, browser, or model request. Node 22.18 or later is required.

### Finding classifications

- **Confirmed:** a failed explicit assertion mapped to an approved requirement, with a reviewed `defect-confirmed` annotation. A failed locator or timeout alone does not prove a product defect.
- **Suspected:** an observed failure, external block, or likely shared cause that still needs investigation.
- **Usability-related:** a recorded usability observation, separate from acceptance failures.

After reviewing and reproducing a defect, annotate the relevant test with `{ type: 'defect-confirmed', description: 'AUTH-01: description of the verified requirement violation' }`. A critical defect also needs `{ type: 'severity', description: 'critical' }`. Use the actual requirement ID from `config/qa-requirements.json`. Expected rejection tests are not defects merely because they exercise error messages. `blocked` annotations apply to skipped tests; an `external-blocked` step annotation is reported without changing a passing test's outcome.

### Optional model review

To use an existing OpenClaw GPT login, enable its Responses HTTP endpoint and create a dedicated `qa-review` agent with `tools.deny: ["*"]`, no skills, and its own workspace. Configure the private QA `.env`:

```dotenv
QA_AI_PROVIDER=openclaw
QA_AI_MODEL=openai/gpt-6-astra
QA_OPENCLAW_BASE_URL=http://127.0.0.1:18789
QA_OPENCLAW_AGENT=qa-review
QA_OPENCLAW_TOKEN=your-private-gateway-token
QA_AI_AUTO=1
```

`QA_AI_MODEL` labels the configured backend; the dedicated agent's OpenClaw configuration selects the actual GPT model and manages OAuth. The QA project uses only the gateway token. This adapter accepts only loopback HTTP endpoints and refuses redirects. Requests use independent sessions and disable tools. OpenClaw's Responses compatibility layer does not guarantee schema-constrained generation, so the schema is included in the instructions and the project validates all returned evidence and requirement references before accepting the review. Gateway transcripts may retain the sanitized evidence; `store: false` is not a retention guarantee for OpenClaw. Keep the gateway token private and the gateway accessible only to trusted callers. [OpenClaw endpoint documentation](https://docs.openclaw.ai/gateway/openresponses-http-api).

Review an existing completed pipeline run without rerunning tests:

```sh
node pipeline/ai/analyze.mjs <runId>
```

Success requires `status: "ok"`; results are saved under `runs/<runId>/ai-analysis.json` and shown in the dashboard. Gateway outages, quota failures, malformed output and missing evidence references produce a rejected review while preserving test outcomes. There is no durable AI retry queue; use the saved-run command to retry. Restart the dashboard and scheduler after changing provider settings. Smoke schedules inherit automatic failure-only review; nightly regression explicitly requests review on every result. Per-schedule `ai: true` or `ai: false` overrides automatic mode and is preserved in durable queued jobs.

For local analysis without an API key, start Ollama, install a model (`ollama pull gpt-oss:20b`), and set `QA_AI_PROVIDER=ollama` and `QA_AI_MODEL=gpt-oss:20b` in `.env`. The default endpoint is `http://127.0.0.1:11434`; only local loopback endpoints are accepted. A Mac with 16 GB of memory has limited room for this model alongside Docker, so avoid running model inference during load measurements. The download is large and is a separate installation step. [Official local GPT-OSS guide](https://developers.openai.com/cookbook/articles/gpt-oss/run-locally-ollama).

Alternatively configure `OPENAI_API_KEY` and `OPENAI_MODEL`, or the existing Anthropic provider. Then run:

```sh
npm run analyze:ai
```

The model reviews approved requirements and redacted execution evidence, summarizes findings, groups likely duplicate failures as hypotheses, and proposes difficult scenarios and regression checks. Ollama uses local structured JSON output without credentials; the OpenAI path uses the Responses API with `store: false`. No provider receives recovery phrases, browser storage, trace files, or screenshot contents. Output is validated against recorded evidence before use. Without model configuration, the automatic file remains clearly labelled **model not run**.

Generated output is checked against existing evidence IDs and approved requirement IDs. AI cannot promote an unconfirmed defect. Proposed scenarios remain marked **not an acceptance check**; no generated code executes automatically. Review requirement mapping, reproduce a failing assertion, implement the test, run it, and examine evidence before using it for acceptance or release decisions.

The dashboard's **AI review** checkbox applies to Run, Run everything, and Smoke. Checking it reviews the selected run after tests finish; unchecking it explicitly skips review for that run. Set `QA_AI_AUTO=1` to select the checkbox by default and automatically review failed, blocked, timed-out, or infrastructure-failed CLI and scheduled runs. Passing scheduled runs skip automatic review. CLI `--ai` and `--no-ai` override automatic mode. Restart the dashboard and scheduler after changing `.env`. View the result in the run's AI review panel and `ai-analysis.json`; AI does not change test outcomes.

`config/qa-evaluation.json` assigns 45% to execution reliability, 40% to confirmed defect detection, 10% to coverage and 5% to AI usefulness. No score is invented from a single passing run: history, reference defects, coverage and validated contributions must be measured first. The cart failure in the requested notification example is retained as an unapproved illustration, not a reported defect or an approved requirement.

Wallet readiness checks now allow 60 seconds for the authenticated session and connected UI. Navigation allows 60 seconds; general actions allow 30 seconds. The test does not depend on observing a particular `/api/home` response event. These are maximum waits: successful operations proceed immediately.

## QA dashboard (run everything without opening WEB MPC)

For KST schedules, threaded Slack summaries, bot installation and private configuration, see [Slack scheduler setup](docs/slack-scheduler.md).

```sh
npm run dashboard          # http://127.0.0.1:4500
```

The dashboard starts any suite (`smoke`, `api`, `regression`, `uat`, `load`, `full`) on any configured environment, streams live output, and shows run history, grouped failures, load results against SLOs, AI review status, Slack delivery and per-step Playwright HTML reports. The same runs are available from the CLI: `npm run qa:full`, `npm run qa:uat`, `npm run qa:load`, and so on. `npm run stack:status` reports the isolated Docker stack.

Application PRs can trigger code/type checks, dependency security auditing and all four suites when opened or updated, against their exact head commit. A pending/final `MPC QA / pre-merge` status and an updated bot comment link reviewers to GitHub-hosted reports before merge. See [GitHub setup](docs/github/README.md) for the application dispatch template and required secrets. Sanitized reports show test pass rates and execution coverage for each suite. A reusable [PR QA skill](skills/merge-pr-qa/SKILL.md) describes this workflow for agents.

UAT and load run only against the isolated `local-docker` stack (`pipeline/config/environments.json`, Compose project and host ports under `stack`). The pipeline refuses them on preview, staging and production.

For the complete web suite, including the write-gated cases, start Docker and run `npm run test:web:isolated`.
This command uses the verified `mpc-qa-web-20261019` Compose project at `http://localhost:3420`, prepares a fresh local member through real registration and certificate transactions, and runs only the Chromium project with local writes enabled. This stack is now shared by the `local-docker` and `web-isolated` profiles; run tests sequentially. The previous recovery stack and its volumes are preserved. The first startup installs app dependencies and deploys local contracts; subsequent runs reuse the stack. The local app Docker image must already be built.

The Activity refresh and dismissal cases create owned pending/failed notification records in this disposable database and remove those records afterward. Their HTTP responses, authentication, and UI actions remain real; these notification fixtures do not establish blockchain transaction correctness. Running `npx playwright test --project=chromium` directly still uses `.env` and skips write-gated cases unless its target and prerequisites are configured.

Unity cart/check-in and Quests/Crew overlay cases require the live Unity interface and its pinned mainnet contracts. They skip on the local activity board. Run them separately with `npm run test:silicon-cart`, `npm run test:daily-checkin`, and `npm run test:unity-additional`. Wallet sign-in and authentication rejection checks also run on the local board. W32 additionally requires `QA_CHECKIN_EVIDENCE` pointing to evidence from a confirmed check-in for the current day.

After this stack is healthy, run every scheduled application suite sequentially with `npm run qa -- --suite full --env web-isolated --no-notify --no-ai`. This executes API, web regression, UAT (including the app's local scenarios), and the configured k6 load profile, and saves a combined run report under `runs/`. The command does not start the recurring scheduler or post Slack messages.
The verification overlay enables the app's existing runner compiler-cache eviction in the Next server child, caps V8 old-space at 3 GiB per process, and logs worker exits. The launcher still binds to the Docker interface; both aliases retain these protections on the verified QA stack.

The standalone [JMeter and Postman plans](testplans/README.md) add 30 load cases (2,000 users, 60-second ramp-up, two-second request pacing) and 20 API cases. They include a JTL/Newman latency reporter and are separate from the scheduled k6 workload.

To check Slack delivery without a workspace, run `node scripts/slack-sink.mjs` and start the dashboard with `SLACK_ALERT_WEBHOOK_URL=http://127.0.0.1:4599/services/TQA/BQA/local QA_SLACK_ALLOW_LOOPBACK=1`. Payloads land in `runs/slack-sink.jsonl`. Real deliveries require a `https://hooks.slack.com/services/...` URL.

### Security

- The dashboard binds to 127.0.0.1 only. It rejects any other `Host` header (DNS rebinding). Every action needs the per-process token embedded in the page, a JSON body and a same-origin request. Suite, environment and seeded-defect names are whitelisted from config.
- Artifacts are served only from inside their own `runs/<id>/` folder (no `..`, dotfiles or symlink escapes). Text files are redacted again on the way out. Playwright HTML reports open in a sandboxed origin.
- `QA_SEED_PHRASE`, API keys and the Slack webhook are passed only to the wallet Playwright step. The WEB MPC scenarios, k6 and Docker never receive them, and known secret values are redacted from every log.
- `.env` is mode 600. `runs/`, logs, `.env.*` and `.claude/` are git-ignored. k6 session cookies live in a private `mkdtemp` folder that is deleted after the run.
