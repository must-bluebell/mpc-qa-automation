# MPC web regression from the supplied plans

The 20 Playwright browser cases in `tests/wallet/web-regression.spec.ts` extend the `chromium` project. They run with the existing `regression` and `full` pipeline suites and the corresponding GitHub Actions suite selections. The current nightly schedule selects API and UAT; these new Chromium checks do not change that schedule.

Sources: the supplied `MPC-load-testing.jmx` browser recording and `mpc-waitlist.postman_collection.json` API collection. Recorded third-party requests, captured activity IDs, cookies and payloads are not replayed. The recording's old My Mine routes are mapped to current board navigation. Each case asserts visible browser behavior; API responses support session and state assertions.

| Case | Browser behavior | Source coverage |
|---|---|---|
| WEB-01 | Anonymous home remains usable after reload | `/api/home`, `/api/auth/session` |
| WEB-02 | `/quests` selects Quests | `/api/quests`, `/api/quiz/today` |
| WEB-03 | `/mine` selects My Mine | Recorded `/my-mine/*` journey |
| WEB-04 | `/vote` selects Vote | `/api/vote/proposals` |
| WEB-05 | Browser back/forward restore board selection | Home, quest and vote navigation |
| WEB-06 | Closing/reopening Join restores Community | Auth and `/api/join/social-complete` |
| WEB-07 | Invalid email is rejected visibly without registration | `/api/register/skip-otp`, `/api/register/status` |
| WEB-08 | Incomplete Community prevents moving to email | `/api/join/x-open`, `/api/join/social-complete` |
| WEB-09 | Reload restores completed Community without registration | Social and registration status |
| WEB-10 | Reload retains wallet identity and board panel | `/api/auth/session` |
| WEB-11 | New tab shares the real server session | `/api/auth/session` |
| WEB-12 | Browser Disconnect survives reload | `/api/auth/logout` |
| WEB-13 | Protected deep link cannot restore logged-out identity | Auth and notifications |
| WEB-14 | Fresh wallet exposes no other user's activity | `/api/activities` |
| WEB-15 | Check status refreshes the real activity feed | Activity polling/status |
| WEB-16 | Close dismisses a finalized failed activity | `/api/activities/:id/dismiss` |
| WEB-17 | Unknown proposal has an explicit recovery message | Proposal/metadata lookup |
| WEB-18 | Back to proposals removes invalid selection | Vote list navigation |
| WEB-19 | Anonymous admin navigation requires login | Admin authentication/permissions |
| WEB-20 | Anonymous My Mine exposes no private panel/feed | Mine and activities permissions |

## Fixtures and safeguards

Use the prepared isolated stack. Member cases use the existing configured QA wallet and real onboarding helper, which can register a test member if necessary. Newcomer cases generate a fresh wallet in Node and sign real SIWE challenges through the injected wallet bridge. No MPC API or authenticated-session response is mocked. Only third-party analytics/social destinations are stubbed.

Write cases require `QA_ALLOW_WRITES=1`; member cases also require the dedicated `QA_SEED_PHRASE`, matching `WALLET_ADDRESS`, and derivation index. These are private local/Actions configuration, never committed.

WEB-15 requires `QA_WEB_ACTIVITY_REFRESH_ID`, an owned pending QA activity. WEB-16 requires `QA_WEB_ACTIVITY_DISMISS_ID`, an owned finalized failed QA activity. Each requires that activity to be the wallet's only current item, so it cannot click an unrelated card. WEB-16 dismisses the selected test record. Provision deterministic disposable fixtures before enabling these checks. Missing or unsuitable fixtures are marked `blocked:` and do not count as passes; existing production IDs from the JMX recording are never reused.

## Run

The existing pipeline supplies target, chain and write guards:

```bash
node pipeline/orchestrator.mjs --suite regression --env local-docker --trigger manual
```

To execute only these 20 additions, with local `.env` wallet settings:

```bash
BASE_URL=http://localhost:3410 QA_APP_ORIGIN=http://localhost:3410 \
QA_ENVIRONMENT=local-docker QA_ALLOW_WRITES=1 QA_NAVIGATION=activities \
QA_CHAIN_ID=97 QA_CHAIN_NAME='Local Anvil' \
QA_REPORT_DIR=runs/web-regression \
npx playwright test --project=chromium --grep @web-regression
```

Use a fresh report directory for each retained run. Screenshots/traces and raw reports remain in ignored `runs/`. These browser checks do not establish load capacity or cover successful mining/voting transactions without their own fixtures.
