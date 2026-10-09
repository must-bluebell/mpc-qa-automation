# GitHub Actions and Slack setup

The QA repository is `must-bluebell/mpc-qa-automation`. Its `.github/workflows/qa-runner.yml` runs regression against the exact application commit received through `webapp-merged`, API checks every four hours, and load checks daily at 01:00 Asia/Seoul. Manual runs are also available. The workflow must be on the QA repository's default branch.

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
4. Merge the workflow into the application repository. Subsequent merged PRs send their merge commit SHA to QA. Closed, unmerged PRs do not dispatch QA. The trigger does not check out or execute PR code.

The application repository must contain the Docker Compose files and development environment example required by `pipeline/adapters/local-stack.mjs` and `scripts/github-qa.mjs`. GitHub runners build a disposable stack; the local Docker installation is not used.

## Verify activation

First use Actions → MPC QA regression and schedules → Run workflow with suite `regression` and an application ref. Confirm the application checkout, Docker startup, assertions and Slack message. Then merge a small application PR and confirm QA checks out its exact merge commit. GitHub publishes a sanitized Markdown artifact and links the Slack summary to the workflow run.

Only sanitized Markdown reports are uploaded. Allure artifacts remain on the runner; hosted Allure links are not configured by this workflow. Failures before the assertions step appear in GitHub's summary but currently do not send a Slack message.

References: [GitHub merge triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#running-your-pull_request-workflow-when-a-pull-request-merges), [repository dispatch permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).
