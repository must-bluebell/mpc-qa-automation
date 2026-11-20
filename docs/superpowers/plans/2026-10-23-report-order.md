# Report order implementation plan

**Approved scope:** Both dashboard and Slack show regression cases together, then API, then load; system health is last. AI stays advisory. Schedule times and application stack stay unchanged.

**Approach:** Extend the current dashboard and category-aware Slack renderer, preserving existing results, privacy controls, delivery IDs and incident handling.

- [x] Add behavioral tests for category order across mixed outcomes and dashboard health placement; confirm they fail.
- [x] Group Slack cases by category before outcome, and group dashboard results in the same order. Display recorded results honestly and health last.
- [x] Run dashboard/reporting checks and typecheck, inspect the diff, then start the dashboard and verify authenticated access, AI analysis and the existing scheduler.

**Runtime constraint:** The app and chains are stopped. Do not start them or claim fresh regression/API/load execution. Existing scheduler cadence remains unchanged.

**Verification:** Dashboard 14 passed; reporting 185 passed, 2 skipped; typecheck and diff checks passed. Live authenticated browser verified home/run ordering and opened the private dashboard. Codex CLI analysis completed successfully for `manual-1792654634035-regression-retry`. Scheduler restarted with unchanged cadence; application stack remains stopped.

**Review fixes:** Missing recorded health stays unknown; latest category summaries include constituent full-suite checks and category-specific counts; authoritative empty summaries cannot fall back to zero-check history. Each behavior was tested failing before its fix.

**Approved recovery follow-up (2026-10-23):** User authorized restoring the application stack. Both local aliases now use `mpc-qa-recovery-20261023`, fresh database/chains, unchanged app/RPC ports and database/proxy ports 5491/4495. All 143 previous volumes were preserved. Read-only dependency caches were verified at the pinned clean revisions before copying. Startup metadata files were removed only from the fresh workspace. HTTP 200, six required services healthy, live dashboard badge healthy and 13/13 critical smoke checks verified. Scheduler resumed with its existing cadence; stored external-repository restriction remains unchanged.
