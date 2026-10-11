# GitHub Actions and Slack setup

The QA repository is `must-bluebell/mpc-qa-automation`. Its `.github/workflows/qa-runner.yml` runs the full API, regression, UAT and load suite against the exact application commit received through `webapp-merged`, API checks every four hours, and load checks daily at 01:00 Asia/Seoul. Manual runs support `regression`, `api`, `uat`, `load` and `full`. The workflow must be on the QA repository's default branch.

An independent code/security job checks out the same application revision, installs its frozen pnpm lockfile, runs TypeScript and lint/boundary checks, and audits dependencies. High or critical dependency vulnerabilities fail the gate, as do unavailable audit services. These checks run independently so a code gate failure does not suppress functional test evidence. The application's existing `packageManager` field selects pnpm through Corepack. QA-repository PRs also run `npm audit --audit-level=high --include=dev` in `qa.yml`.

The reusable agent instructions are in `skills/merge-pr-qa/SKILL.md`. This repository copy can be installed in an agent's skills directory; GitHub automation is provided by the workflows, independently of skill installation.

## QA repository settings

Add these under Settings → Secrets and variables → Actions.

| Type | Name | Value |
| --- | --- | --- |
| Secret | `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token, starting with `xoxb-` |
| Secret | `WEBAPP_READ_TOKEN` | Token with Contents: read access to the private application repository |
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
2. Set its `branches` filter to the team's merge branch (the template uses `main`).
3. Add the application repository secret `QA_DISPATCH_TOKEN`: a fine-grained GitHub token scoped to `must-bluebell/mpc-qa-automation` with Contents: write permission. Obtain organization approval if required.
4. Merge the workflow into the application repository. Subsequent merged PRs send their merge commit SHA to QA. Closed, unmerged PRs do not dispatch QA. The trigger does not check out or execute PR code. Post-merge results appear in the QA repository's Actions run; this is a post-merge check and does not block an earlier merge or post a status back to the application PR.

The application repository must contain the Docker Compose files and development environment example required by `pipeline/adapters/local-stack.mjs` and `scripts/github-qa.mjs`. GitHub runners build a disposable stack; the local Docker installation is not used.

## Checkout and cleanup failures

The application checkout uses `WEBAPP_READ_TOKEN`, because the QA repository's built-in `GITHUB_TOKEN` cannot read a different private repository. A preflight checks read access to the exact requested application commit before checkout. If it fails, verify `WEBAPP_REPOSITORY`, `WEBAPP_REF`, and the token's expiry, selected application repository, Contents: read permission, and any organization approval or SSO requirements. Git exit code 128 alone does not identify which of these failed.

Cleanup runs only after stack startup was attempted, including a failed startup that may have created containers. If checkout failed first, cleanup is skipped; the stack command also safely skips cleanup when its Compose file is absent. The workflows use Node 24 action runtimes (`checkout@v7`, `setup-node@v7`, `cache@v6`, and `upload-artifact@v7`); `node-version: '22'` separately selects the Node version used to run this project's scripts. Publish the updated workflow files to the QA repository before starting a new run. Re-running a historical workflow run uses that run's older workflow revision.

## Verify activation

First use Actions → MPC QA regression and schedules → Run workflow with suite `full` and an application ref. Confirm both jobs check out the same revision, code/security gates run, Docker starts, all four suites execute and the Slack summary appears. Then merge a small application PR and confirm QA checks out its exact merge commit. GitHub publishes a sanitized Markdown artifact and links the Slack summary to the workflow run.

The sanitized report includes overall and per-suite test pass rates and execution coverage. Pass rate is `passed / (passed + failed)`; execution coverage is `(passed + failed) / (passed + failed + skipped + blocked)`. Skipped and blocked checks never count as passes, and no executed checks displays `n/a`. These are test percentages for the merged commit, not a historical percentage of PRs passing. Code/security gate outcomes appear separately in the GitHub job summary.

Every required suite step must execute assertions to produce a passing combined gate. For example, if the wallet phrase is missing and all wallet tests skip, the full run is blocked even if its API, UAT and load checks pass. Runner errors and nonzero exits also prevent a passing gate.

New coverage includes rejected SIWE domain/chain/expiry/signer combinations, forced logout protection, access after logout, wallet connection retries, restored sessions, independent user identities and sign-in after logout. Load traffic also checks anonymous session isolation, private notification access, origin enforcement and cache control. Auth nonce traffic accepts an explicit `429 rate_limited` only with a positive `Retry-After`; other failures still fail checks. The added boundary scenario increases the baseline profile from two to three concurrent traffic groups (15 total VUs with the default 5 per group), so comparisons with older load baselines may need review.

Only sanitized Markdown reports are uploaded. Allure artifacts remain on the runner; hosted Allure links are not configured by this workflow. Failures before the assertions step appear in GitHub's summary but currently do not send a Slack message.

References: [GitHub merge triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#running-your-pull_request-workflow-when-a-pull-request-merges), [repository dispatch permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).
