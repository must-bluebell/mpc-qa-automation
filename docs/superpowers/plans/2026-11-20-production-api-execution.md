# Authorized production API execution

User explicitly requested production API writes and code changes to unblock checks. Implement a per-run `productionApiWrites` opt-in through the authenticated Render run API and dashboard. Scope it to API workers on the exact configured production origin. Existing defaults, local seeding, load guards and browser-wallet gates remain unchanged.

- Add regression tests for exact origin authorization, per-project propagation, and rejected inappropriate run requests.
- Propagate the explicit opt-in from dashboard to orchestrator to API workers; record it in run evidence.
- Permit built-in session, rejection, validation and throwaway-wallet workflows under that policy. Configured arbitrary success fixtures still require isolation. Missing administrator sessions and response contracts remain explicit blockers.
- Add the dashboard checkbox and verify its request payload with tooling tests.
- Run reporting/dashboard tooling checks and TypeScript; review and push authorized changes.
- Trigger API from Render with explicit production authorization and no notifications; retrieve results and distinguish assertion failures from missing fixtures.

This does not promise fabricated success contracts, create administrator credentials, or classify unexecuted tests as passing. Deployment storage loss requires Render account access; this code change cannot provision a disk.
