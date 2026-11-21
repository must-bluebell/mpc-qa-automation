# Smoke evidence and schedule readiness

Goal: preserve failed-attempt evidence after a retry passes and expose schedules that Render cannot start.

The requested retry and flaky counting already exist. Keep that policy, retain each attempt's attachments with distinct paths and labels, and test the reporter using synthetic records (no application execution). Add a shared schedule configuration check for the scheduler and authenticated dashboard. Configuration readiness does not establish runtime or target health. Never expose configured URL values or alter production write protection.

- [x] Add failing tooling tests for evidence retention and missing schedule configuration.
- [x] Preserve every attempt's evidence; show schedule readiness and refuse misconfigured jobs before launch.
- [x] Run focused tooling checks and type checking; inspect Render's saved W01 evidence if available.
- [x] Document deployed verification separately from local checks and unresolved deployment blockers.

Original W01 screenshot/trace availability and Render's busy runner are external constraints; do not replace missing evidence with a guess or interrupt someone else's run.

Outcome: tooling checks pass. Render returned 404 for archived W01 artifacts and 409 for the new preview smoke request because an existing full run is active. Deployment/runtime verification remains pending.
