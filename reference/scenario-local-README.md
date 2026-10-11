# Local functional scenarios

Do not change application business logic. Run user flows using real HTTP APIs, signatures from public Anvil wallets,
the Docker database, and both chains. Playwright runs nine API/environment checks and three Chromium browser checks.
Check transaction receipts, balances, finalized database state, and Activity, rather than only HTTP 200 responses.

## Running

For the full run, prepare Chromium with `pnpm exec playwright install chromium`.
Follow Local scenario tests in the [Docker README](../../../docker/README.md) for Docker startup and port settings.

```sh
SCENARIO_COMPOSE_PROJECT=globalmpc-scenario pnpm run scenario:local
SCENARIO_COMPOSE_PROJECT=globalmpc-scenario pnpm run scenario:local:api
# Run only the three browser checks on a prepared stack (exclude the prerequisite API project)
SCENARIO_COMPOSE_PROJECT=globalmpc-scenario pnpm run scenario:local:ui
```

Reuse a **dedicated test** stack after starting it. Running against a normal development database adds administrator content,
users, and transactions, so use a dedicated Compose project and volumes. Separate projects still require separate host ports.
Use fresh wallet derivation indexes and a content prefix for each run. Do not disable daily limits or bypass application authentication.

## Flows checked

1. `api-chain.spec.ts`: Verify BSC SBT and opBNB Crew contracts and the immediate-finality profile.
2. `scripts/membership.mjs`: SIWE → Community step → Email registration according to policy → Server-relayed SBT issuance.
   Also check rejection of unauthenticated/unregistered users, resubmission, duplicate signup/issuance, and access after logout.
3. `scripts/checkin.mjs`: Administrator creates/approves a quiz → New members give correct, incorrect, or no answers → Directly signed check-in →
   Exact Crew increase and database finalization → Reject duplicates on the same day. Retire the created quiz.
4. `scripts/quests.mjs`: Reject unmet link/prerequisite conditions → Prerequisite and follow-up Crew quests →
   Verify Crew balance and database state → Reject duplicate claims. Use separate accounts for rejection and success paths to preserve request limits.
5. `scripts/ventures.mjs`: Two participation certificates → Invitation relationship → Both parties receive Crew → Mining conditions reflect the relationship.
   Check self-invitations, duplicate relationships, and duplicate rewards on the same day.
6. `scripts/mine.mjs`: Crew quest → Participation certificate and mining →
   Real on-chain records for hauling, refining, ore registration, credit claims, and raw ore purchases → Save restoration, rankings, and marking notifications read.
   Also check that another user cannot mark those notifications as read.
7. `scripts/vote.mjs`: Prepare Crew and certificates → Administrator publishes a proposal → Eligibility check → Signed vote → Change vote →
   Verify on-chain choice, unchanged weight, and finalized Activity. Also reject users without certificates, certificates issued after proposal creation, currently excluded users, and duplicate votes.
8. `scripts/admin.mjs`: Create administrator role/account → Initial password change → Reject unauthorized operations → Logout.
   Quiz, quest, and voting administration APIs also run in the setup stages of their corresponding user scenarios.
9. `scripts/relay-checkin-mine.mjs`: Sign and submit check-in relay → Finalize Crew, database state, and Activity →
   Prevent duplicate rewards on resubmission → Save and re-query actual server-generated mining results and prevent rerolls.

## Setup data and speed

1. `scripts/harness.mjs` verifies the local database host and Anvil chains and shares SIWE, administrator login, transaction, and finalization-wait helpers.
   Only gas is provisioned for test wallets; Crew is earned through actual rewards.
2. Use scenario Anvil's immediate-finality settings. Keep the application's `finalized` determination unchanged and do not change the wall-clock date.
   Advance to the voting start block in an exclusive phase after other scenarios finish.
3. Only the long My Mine economic flow receives fixed inputs in the draw ledger. This is a prerequisite to reach refining and purchases on every run,
   rather than a test of the actual RNG distribution. Do not inject reward balances, execution records, or successful responses.
   The relay check-in/mining scenario uses the real draw API without this setup.
4. The default API worker count is two. The two quiz-related checks run serially; after API voting, run the three browser checks with one worker.
   Do not attach multiple Playwright runs to the same stack concurrently. Do not hide failed tests with automatic retries; continue checking other features.

## Scope and evidence

These are representative success/rejection flows connecting the main features in AGENTS; they do not prove every possible combination.
Browser checks cover new signup and BSC SBT issuance, check-in and Crew mining/save, and voting on a new proposal with Activity verification.
Inject an EIP-1193 test wallet to produce real signatures. Actual email OTP receipt, Telegram OIDC/membership,
MegaFuel, Turnstile, and MetaMask popups/mobile apps are excluded. Use the existing Docker signup policy; tests must not silently change operator policy.
Daily boundaries, all network-failure combinations, long-term load, and all administrator editing combinations require separate expansion.

For PRs, `.github/workflows/local-scenarios.yml` runs the same full command.
On the company runner, the independent `docker-compose.scenario-ci.yml` starts only the database, HTTP proxy, and two Anvil instances.
Package and Chromium installation, contract deployment, database initialization, the app, cron, and Playwright all run on the runner.
`ci-runner.mjs` connects infrastructure services to the container runner's network and relays them through random loopback ports.
Host runners use randomly published loopback ports. There is no CI web container or duplicate installation inside it.
Temporarily generate deployment configuration in CI's isolated checkout and restore it at exit; retain application logs on the runner.
Keep the local Docker execution method. The harness prepares test administrator accounts with random credentials and
authenticates through the actual login API. Do not use production administrators or fixed Docker administrator passwords.
Each CI run uses new volumes and uploads success/failure reports and failure logs. Preserve traces, videos, and screenshots for browser failures.
Local results remain in `test-results/local-scenarios`, and HTML in `playwright-report/local-scenarios`.
The existence of test files differs from actual passing runs; inspect execution results as well.

## Implementation verification record — 2026-09-28

Ran all 12 checks in a dedicated Docker project prepared with empty volumes; 11 passed (about 9.3 minutes,
excluding Docker setup). Modified the remaining browser mining check to wait for the initial run-save response after Crew accrual,
then reran it independently and it passed (about 1.4 minutes). This was not a full-suite rerun after the fix.
`tsc --noEmit`, ESLint for changed test files, and `git diff --check` also passed.
Actual GitHub Actions execution was not included in local verification.

## Verification after browser restoration — 2026-09-30

With the existing dedicated stack's volumes preserved, ran all 12 checks together: **all 12 passed in about 5.7 minutes**.
Docker setup time is excluded. APIs use up to two workers; browsers run afterward with one worker, with zero automatic retries.
Browser signup took 20.9 seconds, check-in → Mining → Save took 48.9 seconds, and voting took 43.8 seconds.
TypeScript, ESLint for restored TS files, and 17 related Node regression checks also passed.
This records one successful full run; it does not establish that past server timeout root causes were resolved or that remote CI succeeded.

Three additional runs on the same volumes each passed 12/12 (5 minutes 46 seconds, 5 minutes 16 seconds, and 5 minutes 55 seconds).
The first two ran consecutively without restarting; the third ran after restarting the stack while retaining existing data.
All three had no failures, skips, or automatic retries. Actual results, traces, and diagnostic files are stored only in Git-ignored `test-results/`.

## Company runner configuration verification — 2026-10-01

Started locally in Docker with new CI-only volumes, a source copy, and no host ports.
The full 12-check run had 11 passes and one failure (10.1 minutes, excluding setup). The failure came from two old strings
remaining in the test after voting UI wording changed on main. Updated them to the current quorum and vote-weight wording,
then reran the browser voting scenario independently; it passed (2.0 minutes).
This does not represent a full 12-check rerun after the fix or completion of a remote company runner execution.
Eighteen regression checks, one actual Anvil time check, type checking, and ESLint for changed TS files also passed.
After preserving results, deleted only this verification stack and its volumes. The existing development environment was unchanged.
