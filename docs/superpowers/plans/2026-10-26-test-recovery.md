# Test recovery and service startup

Goal: repair reproduced failures and run the dashboard and Slack scheduler with validated AI analysis.

- [x] Run reporting, dashboard and TypeScript checks; all passed (265 reporting passes, 2 skips; 23 dashboard passes).
- [x] Diagnose unavailable runtime: Docker stopped; after startup both Anvil containers reject unclean snapshots.
- [x] Preserve all old volumes; provision a new coordinated isolated project and update both local aliases in pipeline/config/environments.json.
- [x] Run full API, browser, UAT and load coverage with AI; investigate failures without weakening assertions or thresholds. Application-owned scenarios need a process-local repository-scope override; keep stored .env policy unchanged.
- [x] Reproduce each code defect before fixing it; verify focused tests and relevant complete suites.
- [x] Leave dashboard and scheduler running, confirm AI review and Slack configuration, and report actual counts and remaining blocks.

Preserve historical evidence and baselines. Never restore mismatched database/chain state or delete safety markers. Use existing runtime images and fresh project volumes.

Runtime: `mpc-qa-recovery-20261026`; database/proxy ports 5491/4495 and app/chains unchanged. Initialized the fresh workspace from the previous source snapshot and dependency caches, excluding configuration, build results and runtime state; deployed fresh contracts, migrated and seeded the fresh database. Dashboard PID 15711 is authenticated and AI-configured. Full verification: `20261026-043023-full-1fa5`, explicit AI enabled and Slack reporting enabled as requested.

Browser investigation: first cold W25 exhausted its 30-second application nonce budget while parallel telemetry requests were pending; subsequent signature checks and successful sign-in passed. Added `warmBrowserRuntime` for verified isolated browser steps (except seeded-defect runs): a rejected empty POST compiles `/api/join/event` before wallet interaction without creating join data. Added real-HTTP coverage and remote/read-only/failure guards; observed the new checks fail before implementation, then all 13 focused runtime checks pass. Final browser verification remains pending.

First full run completed: API 25 passed, browser 48 passed/1 failed/6 skipped, account UAT 3 passed, application scenarios 12 passed, load 8 passed. AI review succeeded (codex-cli, 57.8 seconds); Allure generated and all 12 Slack delivery sections acknowledged. Corrected browser verification `20261026-044614-regression-cb3e` is running; W25 now passes in 5.4 seconds. Scheduler restarted as PID 22575 and uses the corrected runner. Read-only code review found no actionable issues.

Corrected browser suite completed: 49 passed, 0 failed, 6 existing target-specific skips (6.2 minutes). Across latest category executions: API 25 passed, browser 49 passed, UAT 15 passed, load 8 passed (97 applicable functional tests). Reporting: 268 passed/2 platform-specific skips; dashboard: 23 passed; Python: 6 passed; TypeScript and diff checks passed. AI and delivery finalization for the corrected run remains pending.

Final verification: corrected run AI review succeeded (51.5 seconds), Allure generated, all 9 Slack delivery sections acknowledged. Authenticated dashboard status and report page checked; live stack healthy, scheduler PID 22575 alive, dashboard PID 15711 serving port 4501. All planned work complete; historical failed run retained for audit and all old volumes preserved. Stored external-repository policy remains unchanged.
