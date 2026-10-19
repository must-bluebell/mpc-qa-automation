---
name: merge-pr-qa
description: Use when reviewing an MPC application PR before merge, investigating its QA results, or extending the code, security, regression, UAT, API and load checks for application PR revisions.
---

# Pre-merge PR quality checks

The application and QA repositories are separate. Application PR creation/updates send
`webapp-pr` with `client_payload.repository`, exact head commit `sha` and
`pr_number`. The existing skill directory name is retained for compatibility.
Read `docs/github/README.md` and `docs/github/app-qa-trigger.yml` in the QA
repository for installation and permissions. A skill does not register a GitHub
trigger; the workflow files provide the automation.

Use `scripts/github-qa.mjs` to validate the repository and exact SHA. A validated open, same-repository PR
selects `full` in `pipeline/config/suites.json`: API, wallet regression, UAT
and load. Do not substitute staging, a merge commit or the latest main branch for that SHA.
`prepare` validates the live PR head before execution. `scripts/github-pr.mjs`
publishes `MPC QA / pre-merge` status and updates the bot report comment with
a GitHub-hosted Actions report link. Old revisions cannot update the latest
PR comment. The separate trusted reporting job holds `WEBAPP_REPORT_TOKEN`;
never give that write-capable token to application execution jobs. Enable the
required status in the application branch rules after deploying both workflows.

Code and security evidence comes from the separate `code-security` job in
`.github/workflows/qa-runner.yml`: application TypeScript, lint/boundaries and
dependency audit. Audit errors and high/critical vulnerabilities fail that gate.
This audit covers known dependency vulnerabilities; it is not a source security
audit. API checks additionally exercise SIWE validation and authorization.

Run writes and load only on the configured isolated Docker stack. Preserve the
loopback and isolation guards in `pipeline/adapters/k6.mjs`; never use a shared
deployment to obtain a passing load result. Load checks include wallet identity,
private endpoint denial, origin enforcement, latency and throughput. Expected
denials use separate request names so they do not dilute endpoint SLO metrics.

Use `npm run typecheck` and `npm run test:reporting` for local self-checks.
Use `npm run qa:full` only with a prepared isolated stack, application scenario
dependencies, Chromium, pnpm, k6 and the configured test wallet available.
Do not send Slack messages or dispatch GitHub workflows unless the user has
authorized those external actions; local checks need neither.

Read the sanitized run artifact for overall and per-suite test pass rates:
passed / (passed + failed). Also report execution coverage and counts of skipped
and blocked checks. No executed tests means no pass rate. These percentages
describe tests in one run; historical PR success rates require separate evidence.
Each required step must execute assertions for a combined run to pass; a missing
wallet fixture must block the pre-merge QA gate rather than hide behind passing API
checks. Report setup failures and unexecuted suites explicitly. Keep credentials, raw
traces and private test data out of published summaries.
