# GitHub App: `/automation review`

Comment `/automation review` on a pull request and the **MPC QA Automation** GitHub App runs the Playwright tests from this repository against that PR's deployment, then replies on the PR. The same review also starts automatically when a pull request is opened, reopened, marked ready for review, or receives a new commit (`synchronize`). Drafts and forks are skipped. If a commit is pushed while that pull request is already being reviewed, the newest such commit is reviewed once the current review finishes; older pending commits for the same pull request are superseded.

1. The App adds an 👀 reaction to your comment as soon as it accepts the request.
2. When the run ends it posts one comment: **✅ passed**, **❌ failed** (with failed test names), or **⚠️ could not verify** (nothing was tested, for example a missing preview or every test skipped). A skipped test is never counted as a pass.

## How it works

```
GitHub ──webhook──▶ tunnel / proxy ──▶ 127.0.0.1:QA_GITHUB_PORT (pipeline/github-app/server.mjs)
                                          │ verify HMAC signature, parse issue_comment
                                          │ check repository policy + live write permission
                                          ▼
                                   👀 reaction ─▶ queue (one review at a time)
                                          │ find deployment ─▶ fetch tests@ref ─▶ playwright
                                          ▼
                                   pass / fail comment
```

The server only listens on loopback. Whatever exposes it (ngrok today, a reverse proxy on a server later) must forward to that port.

## Who can use it

- Comment reviews require the commenter’s live repository permission to be `admin`, `maintain` or `write`. Association labels alone grant no access. Failed permission lookups deny the request before claiming a job, reacting or running tests.
- Automatic reviews (pull request opened, reopened, marked ready, or updated) also check the author's live repository permission: `admin`, `maintain` or `write`. The payload's `author_association` can be stale, so it is not used for these. Other authors are ignored silently, as above.
- Only repositories listed in the policy file respond. Other repositories the App is installed on are ignored.
- Webhook requests without a valid `X-Hub-Signature-256` for `GITHUB_WEBHOOK_SECRET` are rejected (401) before the body is parsed.
- Pull requests from forks are refused with a notice. They never receive the test wallet.
- The command must be the first line of the comment, exactly `/automation review` (case-insensitive). Edited comments and bot comments are ignored. Completed comment IDs are deduplicated across restarts. Accepted jobs are persisted with their claims and unfinished jobs resume on startup under the current repository policy. Recovery is at least once: a crash after posting a result but before recording completion can repeat a review/comment. Existing state files retain their completed IDs.

## Credentials stay on the server

The test login (`QA_SEED_PHRASE`, `WALLET_ADDRESS`, `WALLET_ADDRESS_INDEX`) is read from the server's private `.env`. It is passed only to the Playwright process, which otherwise gets a small allowlisted environment: no App private key, no webhook secret, no Slack tokens. For the local engine, nothing is added to the reviewed repositories or to GitHub secrets. The Actions engine uses the step-scoped secrets described below. Known secrets are redacted from run logs. Comments contain only test names and counts; raw logs and evidence stay in `runs/github-app/`.

The App token used for checkout is limited to the tests repository with `contents: read`, and goes to git through the process environment (not argv, a URL or `.git/config`).

## Configuration

`.env` (see `.env.example`): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_REPOSITORIES_FILE`, `QA_GITHUB_PORT`, plus the wallet variables.

Policy file (`pipeline/config/github-app.repositories.local.json`, git-ignored; start from `github-app.repositories.example.json`). It is re-read on every event, so edits apply without a restart:

```json
{
  "testsRepository": "globalmpc/mpc-automation",
  "testsRef": "git-app-and-demo-testing",
  "timeoutMinutes": 40,
  "playwrightArgs": ["--project=chromium"],
  "repositories": {
    "MSQ-AI-Testing/demo-repository": { "target": { "baseUrl": "https://<chain-97-preview>.vercel.app/" } },
    "globalmpc/<web-repo>": { "previewHostPrefix": "globalmpc-webapp" }
  }
}
```

- **Tests ref**: `testsRef` is the branch or commit of the tests repository that is run. Move from the review branch to `main` by editing it, or set `QA_GITHUB_TESTS_REF=main` in `.env` (the env value wins). Each run resolves the ref to an exact commit, caches the checkout by commit, and reports the commit in its comment.
- **Target, local stack (testing)**: `"target": { "type": "local-stack" }` runs the tests against the disposable Docker stack described by the `local-docker` profile in `pipeline/config/environments.json` (loopback, chain 97, writes allowed there only). The PR is not deployed: this checks the QA pipeline end to end against the local WEB MPC checkout, and the comment says so ("Target tested: local test stack"). The stack must already be running (`npm run stack:up`); the App only inspects it and says so if it is down. It needs `QA_EXTERNAL_REPOSITORIES=1`, because the stack is built from the separate `WEB MPC` checkout. Switch a repository to a real deployment later by replacing this target with `baseUrl` (below) or removing it for Vercel preview lookup.
- **Target, deployment**: either `target.baseUrl` (a fixed HTTPS `*.vercel.app` root, always chain 97) or, when omitted, the PR head commit's ready Vercel preview, read from GitHub deployment statuses created by `vercel[bot]` (needs the `deployments: read` permission). `previewHostPrefix` pins the Vercel project name. Mainnet targets are not accepted.
- **Suite**: `playwrightArgs` selects the default tests; reporters and output paths are controlled by the App.
- **Scope by changed files**: `impact` rules per repository choose the runs for each pull request. A rule lists path globs (for example `"src/features/dig/**"`) and one or more Playwright argument lists. When a changed file matches, those runs execute, one after another, sharing one wallet and one time budget (`timeoutMinutes`). Several matches are combined without duplicates. No match runs `playwrightArgs`. If the changed-file list cannot be read completely, every rule runs and `playwrightArgs` runs too, so files outside all rules are still tested. The comment's **Scope** line says which rules matched.

### Private repositories: Unity and the wallet extension

[pipeline/config/github-app.repositories.example.json](../pipeline/config/github-app.repositories.example.json) has two entries for the private repositories. Copy them into the local policy file and fill in the placeholder:

- **`globalmpc/globalmpc-unity-private`**: each pull request (opened, reopened, ready for review, or a new commit) runs `--project=api`, `--project=uat` and `--project=chromium` (browser regression) against the Vercel preview of its head commit. Load tests are **not** part of this review (see limits).
- **`globalmpc/globalmpc-wallet-extension-private`**: each pull request is checked out at its exact commit, and only the `chrom extension` suite (`--project=packaged-extension`) runs against the packaged extension in `extension.path`. Replace `REPLACE-WITH-EXTENSION-FOLDER` with the folder that holds the extension's `manifest.json`.

A failed case names its file and line, and includes the few source lines around the failing line from the test code, so the reader can see what broke. The App must be installed on each repository, and each repository's owner must approve the permissions.

Limits:

- **Load is not run on pull requests.** The k6 load step only runs against an isolated loopback stack, and that stack is built from another checkout, not from the pull request. Running load against a shared preview needs an explicit decision.
- **Web failures show test code only.** The web app's own source is in another repository and is not checked out, so the App cannot point at the line in the app that broke. The extension has the same limit for its runtime code.
- Drafts are skipped, so a draft pull request is reviewed when it is marked ready.

## One-time GitHub setup (needs the right owners)

`npm run qa:github-app:doctor` compares the live App with what is needed and lists what is still missing. Run it after each step.

1. **App owner** (App settings → *Permissions & events*): set *Pull requests* to **Read and write** (comments and reactions) and *Issues* to **Read-only** (the **Issue comment** event is only offered once the App has the Issues permission); add *Deployments* **Read-only** if any repository uses Vercel preview lookup; subscribe to the **Issue comment** and **Pull request** events. Keep Contents and Metadata read-only.
2. **Webhook** (App settings → *General*): URL `https://<public-host>/webhooks/github`, content type JSON, SSL verification on, secret equal to `GITHUB_WEBHOOK_SECRET`.
3. **Each organization owner**: approve the permission update on the installation (the owner gets an email and a banner), and make sure the App is installed on every repository that should respond **and** on the tests repository (read access is enough there).
4. Make the tests ref exist on GitHub (push the review branch).
5. If the App must be installed on more than one account, set the App's visibility to *Any account* (App settings → *Advanced*/*General*).

Ownership note: the App currently belongs to a personal account. Transferring it to the organization (App settings → *Advanced* → *Transfer ownership*) removes the dependency on one person.

## Run it

```sh
npm run qa:github-app:check    # validates .env and the policy file
npm run qa:github-app          # listen on 127.0.0.1:$QA_GITHUB_PORT
npm run qa:github-app:status
npm run qa:github-app:doctor   # live App / installation / webhook diagnosis
npm run test:github-app        # unit and HTTP tests (no network)
```

For now this runs on a developer Mac with an ngrok tunnel to `127.0.0.1:4600` using a reserved domain, so the webhook URL never changes. The Mac must be on and awake. Logs: `runs/github-app/server.log` when started in the background. To move it to a server later, run the same command under a process manager, put it behind HTTPS (reverse proxy or tunnel), copy `.env` and the private key with `0600` permissions, install Node 22+ and `npx playwright install --with-deps chromium`, and update the App's webhook URL.

Reviews share the QA wallet session, so they run one at a time and wait for the pipeline lock if the dashboard or scheduler is running a suite (up to 30 minutes). A PR already queued cannot be queued again; at most 10 reviews wait.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| No 👀 at all | Webhook not delivered (App settings → *Advanced* → Recent Deliveries shows 502/401), `issue_comment` not subscribed, the commenter is not an org member/collaborator, or the repository is not in the policy file. |
| 👀 then "could not run … cannot read … tests" | The App is not installed on the tests repository, or `testsRef` does not exist on GitHub. |
| 👀 then "No preview to test" | No ready Vercel deployment for the PR head commit. Wait for it, or configure `target.baseUrl`. |
| ⚠️ "no tests executed" | Every test skipped, usually missing wallet variables or a non-testnet target. This is deliberately not a pass. |
| Deliveries return 401 | `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret. |

## Engine `actions`: the review runs in GitHub Actions

Set `"engine": "actions"` on a repository in the policy file to run its reviews in the reusable workflow [.github/workflows/automation-review.yml](../.github/workflows/automation-review.yml) instead of in the App process. Repositories without it keep the in-process `local` engine.

```
/automation review ─▶ App: resolves head commit + preview, creates check "MPC QA automation review" (in progress)
                  ─▶ workflow_dispatch on the tests repository (inputs: review_id, PR, SHA, preview URL, args)
                  ─▶ self-hosted runner (label mpc-qa): npm ci, Playwright, pipeline/github-app/action-review.mjs
                  ─▶ signed report POST /callbacks/review ─▶ App: check completed, one PR comment
```

- **Matching**: each dispatch carries a random `review_id`, which is also the run name. The App finds the run by it and records its ID and URL.
- **Trust**: the App issues a dispatch credential signed over every input, the tests repository and ref. The runner verifies it before running tests or sending any verdict; the App also matches it against saved state. A public review ID is insufficient, and changing the target or test arguments invalidates the credential. The report is signed with `QA_REVIEW_CALLBACK_SECRET` (`x-qa-signature`). Its repository, pull request and commit come from the App's saved state, never from the report.
- **Wallet**: `QA_SEED_PHRASE` is a GitHub Actions secret injected only into the review step and passed to the test child. Dependency installation uses `npm ci --ignore-scripts` without wallet credentials. Never put the seed in the runner service environment or a checkout `.env` file.
- **One run at a time**: the workflow's `mpc-qa-wallet` concurrency group queues runs. A repeat request for a commit that is already running is answered with a notice, not a second run.
- **Missing report**: a run that does not report within `timeoutMinutes + 30` is finished as "could not verify" with its run link. A saved report that could not be posted is retried.
- **Limits in this version**: web deployments only (`target.baseUrl` or a Vercel preview). No local stack, no packaged extension, no `testsDirectory`, no `impact` rules (use `playwrightArgs`).

One-time setup:

1. **Runner**: register a self-hosted runner with labels `self-hosted, mpc-qa` on the QA server. Install Node 22+. Remove wallet variables from the runner service environment and restart the service before enabling this workflow. Remove any wallet `.env` from its checkout; do not put App/scheduler secrets into the runner environment.
2. **Tests repository**: the workflow must exist on the branch named by `testsRef`, and on `main` if the App dispatches to `main`.
3. **Secret and variable** on the tests repository: secrets `QA_SEED_PHRASE` and `QA_REVIEW_CALLBACK_SECRET` (16+ characters, the same value as the App's `QA_REVIEW_CALLBACK_SECRET`), variables `QA_PIPELINE_LOCK_DIR` (the absolute path to the scheduler’s `runs/.locks` directory, shared with the local reviewer), `QA_WALLET_ADDRESS`, `QA_WALLET_ADDRESS_INDEX` (usually `0`) and `QA_REVIEW_CALLBACK_URL` (the App's public `https://…/callbacks/review`). Reusable workflow callers must explicitly pass both secrets.
4. **App permissions**: *Actions* **Read and write** and *Checks* **Read and write**, approved by the org owner. `npm run qa:github-app:doctor` lists them as missing until granted.
5. **Policy**: add `"engine": "actions"` to the repository entry (`GITHUB_APP_REPOSITORIES_FILE` is re-read on each event; no restart is needed for policy). Each review saves its tests repository for dispatch and run lookup, so repository changes affect new reviews only.

The runner, scheduler and local reviewer must use the same lock directory on the same host **and PID namespace**, with permission to read and manage each other's lock files (the lock files are mode `0600`, so use the same OS user). A separate Actions checkout must never use its own `runs/.locks`. Do not point a host runner at a container's lock volume while the container uses a separate PID namespace; run all wallet consumers in the same namespace. A lock from a different PID namespace blocks acquisition; after a container restart, an operator must verify that the old wallet processes have stopped before removing that obsolete lock. A missing or relative `QA_PIPELINE_LOCK_DIR` blocks the Action before Playwright starts.

The signed `timeout_minutes` input carries the policy's 1–180 minute test budget. The workflow and App expiry allow another 60 minutes for installation, up to 30 minutes waiting for the shared wallet lock, and report delivery. Automatic reviews awaiting a preview stay pending and retry during the App's periodic sweep, including after restart. Result comments carry a stable hidden marker; recovery checks all existing comment pages before posting again.

When upgrading this workflow, deploy the App and workflow together (the dispatch signature now includes the timeout). Existing pending reviews without dispatch credentials cannot accept callbacks and will expire as blocked; request a new review after upgrading. Workflow editors and anyone able to access the callback secret remain trusted administrators.

Actions dispatch intent and signed inputs are saved before contacting GitHub. On startup and periodic sweeps, interrupted dispatches are looked up by review ID; an existing run is tracked, and a missing run is dispatched with the saved inputs. Lookup failures leave the intent pending for retry. Legacy records without saved inputs retain their expiry behavior. Artifacts contain only the sanitized `review.md` and `review.json`, never raw Playwright results.
