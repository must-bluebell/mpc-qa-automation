# API report and history recovery

**Goal:** Report unavailable prerequisites honestly, identify every API case safely, and recover saved history when the index is lost.

**Evidence:** Render run `20261120-111310-api-27a5` contains 95 passes and 554 skips, all caused by isolation requirements. Render has no isolated environment. No application defect was demonstrated by these skips.

**Constraints:** Application suites run only through authenticated Render APIs. Keep credentials private and preserve production write guards. Push only task changes (authorized by AGENTS.md). Tooling unit checks do not verify the deployment.

- [x] Add failing tooling tests for blocked prerequisites, mixed pass/blocked status, safe API names and reasons, and index recovery.
- [x] Normalize known missing prerequisites to blocked and prevent a green status when any check is blocked. Preserve intentional feature skips.
- [x] Resolve API names from the checked-in catalog and fixed labels; expose only allowlisted prerequisite reasons. Unknown output remains private.
- [x] Recover missing/corrupt indexes from valid run records; rebuild atomically without retaining stale entries.
- [x] Run reporting/dashboard unit checks and typecheck, inspect the diff, commit and push the authorized fix.
- [x] Verify deployment, trigger API through Render with notifications disabled, and retrieve the returned run record. Report unavailable isolated coverage explicitly.

**Review focus:** Unknown titles and arbitrary error text must remain private; failures/timeouts retain precedence; optional feature skips remain skips; invalid run folders are ignored; recovery must not erase valid history.

Verification: reporting tooling 342 passed, 2 platform-specific skips; dashboard tooling 52 passed; TypeScript passed. Independent review found no remaining issues after recovery and baseline-prerequisite fixes. Deployed verification completed through the authenticated Render dashboard: run `20261120-122724-api-e42a`, suite fingerprint `content-0fcc4d0dee2d`, overall `blocked`, 95 passed, 0 failed, 0 skipped, 554 blocked. Retrieved the saved run and summary (HTTP 200); Allure generated; no notifications sent. All 649 names resolve and all 554 blocked reasons identify the isolated-environment prerequisite. Full application coverage remains unavailable because Render exposes no writable isolated target.
