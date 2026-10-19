# Pre-merge GitHub QA and Slack setup

The QA repository is `must-bluebell/mpc-qa-automation`. Its `.github/workflows/qa-runner.yml` runs the full API, regression, UAT and load suite against the exact PR head commit received through `webapp-pr`, with recurring execution owned by the local scheduler (critical smoke every 30 minutes, nightly API + UAT, weekly load and a daily health report). Manual runs support `regression`, `api`, `uat`, `load` and `full`. The workflow must be on the QA repository's default branch. Application PRs trigger QA when opened, updated, reopened or marked ready for review. A pending `MPC QA / pre-merge` commit status becomes success only when both full QA and code/security jobs pass; the final PR comment links reviewers to the GitHub-hosted report before merge.

An independent code/security job checks out the same application revision, installs its frozen pnpm lockfile, runs TypeScript and lint/boundary checks, and audits dependencies. High or critical dependency vulnerabilities fail the gate, as do unavailable audit services. These checks run independently so a code gate failure does not suppress functional test evidence. The application's existing `packageManager` field selects pnpm through Corepack. QA-repository PRs also run `npm audit --audit-level=high --include=dev` in `qa.yml`.

The reusable agent instructions are in `skills/merge-pr-qa/SKILL.md`. This repository copy can be installed in an agent's skills directory; GitHub automation is provided by the workflows, independently of skill installation.

## QA repository settings

Add these under Settings → Secrets and variables → Actions.

| Type | Name | Value |
| --- | --- | --- |
| Secret | `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token, starting with `xoxb-` |
| Secret | `WEBAPP_READ_TOKEN` | Token with Contents: read and Pull requests: read access to the private application repository |
| Secret | `WEBAPP_REPORT_TOKEN` | Fine-grained PAT on the application repository with Pull requests: read/write and Commit statuses: write; use a stable bot account |
| Secret | `QA_SEED_PHRASE` | Dedicated test-wallet phrase |
| Variable | `WEBAPP_REPOSITORY` | Actual application owner/repository |
| Variable | `WEBAPP_REF` | Default application branch, normally `main` |
| Variable | `SLACK_CHANNEL_ID` | Destination Slack channel ID beginning with `C` |
| Variable | `QA_OWNER_SLACK_ID` | Slack member ID for new failure mentions |
| Variable | `QA_WALLET_ADDRESS` | Address derived from the test-wallet phrase |
| Variable | `QA_WALLET_ADDRESS_INDEX` | Wallet derivation index; defaults to `0` |

Install the Slack app using `config/slack-app-manifest.json` and invite its bot to the channel. Local `.env` values are not automatically available in GitHub Actions. Do not upload `.env`, runtime logs, or raw reports.

## Application repository setup

1. Copy `docs/github/app-qa-trigger.yml` into the application repository as `.github/workflows/mpc-qa-trigger.yml`.
2. Set its `branches` filter to the target branch reviewed before merge (the template uses `main`).
3. Add the application repository secret `QA_DISPATCH_TOKEN`: a fine-grained GitHub token scoped to `must-bluebell/mpc-qa-automation` with Contents: write permission. Obtain organization approval if required.
4. Install the updated trigger on the application repository's default branch, and deploy `qa-runner.yml` plus both GitHub helper scripts to the QA repository's default branch. Replace the old merge trigger; do not keep both copies enabled. The application trigger uses the base-branch `pull_request_target` workflow only to dispatch the PR number and exact head SHA; it never checks out or executes PR code.
5. Give reviewers read access to the private QA repository. They open the PR status Details link or bot comment to see the hosted Actions job summaries and download the sanitized Markdown artifact, retained for 14 days. These links do not require the local dashboard or a report server.
6. In the application's branch protection/ruleset, require `MPC QA / pre-merge` and require branches to be up to date before merging. Run one PR first so the status context is available to select. Local workflow edits alone do not change branch protection.

The runner verifies through GitHub that the PR is open, belongs to the configured application repository, and still has the dispatched head SHA. Fork PRs are not dispatched or run with test credentials. Same-repository PRs execute on disposable GitHub runners with dedicated QA fixtures. The write-capable report token is available only in the trusted preparation/reporting jobs, never in either application execution job. The full SHA is used for both application checkouts; no merged commit or moving branch substitutes for it.

A new commit triggers a fresh run and requires a status for that new SHA. Existing runs stay serialized to preserve Slack incident state. `queue: max` retains up to 100 waiting runs rather than replacing an earlier pending PR check. If a queued revision is already obsolete, preflight rejects it; it never reports success for the new revision. Runs that become obsolete after starting finish their own commit status without updating the latest PR comment. Setup failures, cancelled jobs, skipped jobs and failed tests cannot produce a passing combined status. The bot updates its own existing report comment rather than posting duplicates. Manual runs remain available and do not publish to an application PR.

The application repository must contain the Docker Compose files and development environment example required by `pipeline/adapters/local-stack.mjs` and `scripts/github-qa.mjs`. GitHub runners build a disposable stack; the local Docker installation is not used.

## Checkout and cleanup failures

The application checkout uses `WEBAPP_READ_TOKEN`, because the QA repository's built-in `GITHUB_TOKEN` cannot read a different private repository. A preflight checks read access to the exact requested application commit before checkout. If it fails, verify `WEBAPP_REPOSITORY`, `WEBAPP_REF`, and the token's expiry, selected application repository, Contents: read permission, and any organization approval or SSO requirements. Git exit code 128 alone does not identify which of these failed.

Cleanup runs only after stack startup was attempted, including a failed startup that may have created containers. If checkout failed first, cleanup is skipped; the stack command also safely skips cleanup when its Compose file is absent. The workflows use Node 24 action runtimes (`checkout@v7`, `setup-node@v7`, `cache@v6`, and `upload-artifact@v7`); `node-version: '22'` separately selects the Node version used to run this project's scripts. Publish the updated workflow files to the QA repository before starting a new run. Re-running a historical workflow run uses that run's older workflow revision.

## Verify activation

First use Actions → MPC PR quality checks and manual runs → Run workflow with suite `full` and an application ref. Confirm both jobs check out the same revision, code/security gates run, Docker starts, all four suites execute and the Slack summary appears. Then open a small same-repository application PR and confirm QA checks out its exact head commit, shows a pending status, and posts the final status plus report comment before merge. Push another commit and confirm a fresh status targets the new SHA. Exercise a failing assertion and a setup failure to confirm the status fails. Verify the configured branch rule prevents merging until the latest required status succeeds. GitHub publishes a sanitized Markdown artifact and links the Slack summary to the workflow run.

The sanitized report includes overall and per-suite test pass rates and execution coverage. Pass rate is `passed / (passed + failed)`; execution coverage is `(passed + failed) / (passed + failed + skipped + blocked)`. Skipped and blocked checks never count as passes, and no executed checks displays `n/a`. These are test percentages for the tested PR revision, not a historical percentage of PRs passing. Code/security gate outcomes appear separately in the GitHub job summary.

Every required suite step must execute assertions to produce a passing combined gate. For example, if the wallet phrase is missing and all wallet tests skip, the full run is blocked even if its API, UAT and load checks pass. Runner errors and nonzero exits also prevent a passing gate.

New coverage includes rejected SIWE domain/chain/expiry/signer combinations, forced logout protection, access after logout, wallet connection retries, restored sessions, independent user identities and sign-in after logout. Load traffic also checks anonymous session isolation, private notification access, origin enforcement and cache control. Auth nonce traffic accepts an explicit `429 rate_limited` only with a positive `Retry-After`; other failures still fail checks. The added boundary scenario increases the baseline profile from two to three concurrent traffic groups (15 total VUs with the default 5 per group), so comparisons with older load baselines may need review.

Only sanitized Markdown reports are uploaded. Allure artifacts remain on the runner; hosted Allure links are not configured by this workflow. Failures before the assertions step appear in GitHub's summary but currently do not send a Slack message.

References: [GitHub PR target triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target), [commit statuses](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status), [repository dispatch permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).


## Shared dashboard hosting: DevOps handoff

GitHub-hosted PR reports are the initial shared review destination. A persistent team dashboard for local/scheduled history still needs a deployment; changing a URL does not publish local files.

DevOps request draft: provision a small team-only server or static report store with persistent storage, a stable HTTPS domain, TLS, SSO or VPN access, backups and a defined report retention policy. Publish sanitized `runs/published/<runId>.md` files and set `QA_REPORT_BASE_URL` to that directory's HTTPS URL only after publishing is verified. If hosting the dashboard service, put its loopback listener behind an authenticated reverse proxy; preserve authorization for run-start endpoints. Raw Allure/browser evidence needs separate private access. Set `QA_ALLURE_BASE_URL` only when those private reports are actually published.

Acceptance: a reviewer on another machine can open the shared report link with team access; neither PR nor Slack shared links point to `127.0.0.1` or `localhost`; report links remain accessible after the originating runner exits. This request is prepared here; no server has been provisioned or external message sent by this change.
