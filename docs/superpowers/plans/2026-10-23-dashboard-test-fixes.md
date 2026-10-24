# Dashboard test repair

User request: run and fix all dashboard test cases; do not run or report through Slack.

- [x] Stop the scheduler and conversational Slack listener.
- [x] Add and test an explicit per-run Slack alert switch; use `notify: false` for every dashboard run.
- [x] Start full isolated suite from the dashboard: `20261023-111158-full-5806` (AI deferred during diagnosis).
- [ ] Investigate each reproduced failure from saved artifacts; fix the cause without weakening assertions, load SLOs, or changing failures into skips.
- [ ] Verify targeted fixes, then run the complete dashboard suite again.
- [ ] Verify dashboard/reporting checks, final stack health and absence of new Slack messages; leave Slack processes stopped.

Runtime: `mpc-qa-recovery-20261023`, app localhost:3460, dashboard 127.0.0.1:4501. The dashboard process temporarily allows the local application-owned scenarios so full UAT can execute. Stored `.env` restrictions remain unchanged; remove the process override after verification. Preserve all prior changes and Docker volumes.

## Findings and verification

- Baseline full run: 93 passed, 4 failed, 6 intentionally skipped, 0 blocked (103 cases). All25 API, 3 account-access UAT and12 application-owned scenarios passed. Browser W03 failed on a read-only registration connection reset; added bounded transport retries to the two registration reads.
- Load preparation now verifies the isolated web container identity, restarts only web, waits for readiness and warms measured endpoints with real sessions. Original workload, SLOs and baseline are unchanged.
- First prepared load run `20261023-113407-load-725c` still failed three latency checks. Found the Next worker wrapper forcing `QA_LOCAL_LOAD=0`, which disabled the app’s existing load configuration. Removed that override while retaining compiler memory eviction.
- Corrected load run `20261023-113927-load-e385`: 8 passed, zero failures; baseline compared, not updated. Session p95 187.777 ms, home p95 122.460 ms.
- Full final verification in progress: `20261023-114302-full-e5e2`, initiated through the dashboard with AI enabled and Slack notifications explicitly disabled.
- User also requested removal of the unused `hiring-quest` folder. Its only document described an unrelated recruiting exercise; removed it plus the obsolete Git/Docker ignore entries after checking references.
