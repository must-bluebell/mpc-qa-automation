# Authorized production API execution

User explicitly requested production API writes and code changes to unblock checks. Implement a per-run `productionApiWrites` opt-in through the authenticated Render run API and dashboard. Scope it to API workers on the exact configured production origin. Existing defaults, local seeding, load guards and browser-wallet gates remain unchanged.

- Add regression tests for exact origin authorization, per-project propagation, and rejected inappropriate run requests.
- Propagate the explicit opt-in from dashboard to orchestrator to API workers; record it in run evidence.
- Permit built-in session, rejection, validation and throwaway-wallet workflows under that policy. Configured arbitrary success fixtures still require isolation. Missing administrator sessions and response contracts remain explicit blockers.
- Add the dashboard checkbox and verify its request payload with tooling tests.
- Run reporting/dashboard tooling checks and TypeScript; review and push authorized changes.
- Trigger API from Render with explicit production authorization and no notifications; retrieve results and distinguish assertion failures from missing fixtures.

This does not promise fabricated success contracts, create administrator credentials, or classify unexecuted tests as passing. Deployment storage loss requires Render account access; this code change cannot provision a disk.

## Follow-up diagnosis from Render

The production run `20261120-125617-api-db33` was interrupted by the user-confirmed redeploy. The replacement dashboard full run `20261120-125749-hosted-full-ab92` has explicit production API authorization and suite fingerprint `content-de3a10ce71a3`. Its results are still being collected; intermediate checkpoint totals include retries.

Prepared corrections:
- Pace authentication requests to the source-defined nonce/verification limits. Honor bounded Retry-After once only for rejected authentication requests; do not replay other writes.
- Match the production admin CAPTCHA rejection and disabled bridge feature gates with exact response contracts while retaining local contracts and forged-credential cases.
- Expect the development funding endpoint to be unavailable in production (404 with an empty body), confirmed by the authenticated Render trace; do not enable a funding helper on production.
- Send the Mine protocol header (`x-mpc-run-protocol: 6`) declared in the supplied Postman collection. The Render validation trace reports `409 client_outdated` without it. Preserve explicitly supplied headers for negative tests.
- Give word authorization probes the collection's required body shape while retaining the 401 authentication expectation. The previous empty body returned 400 `bad_request`; the new request needs deployed verification.
- Preserve short machine error codes in private API metadata and expose only HTTP mismatch numbers in public failure reasons.

Tooling verification: 355 reporting tests passed, two platform-specific checks skipped; 54 dashboard tests passed; TypeScript passed. These checks do not establish deployed application success. Review found no actionable issues. Missing admin sessions, seeded success fixtures, and unavailable source contracts remain blockers; they must not become fabricated passes.

The old-code API phase completed with 421 passed, 35 failed and 193 skipped (one passing case was flaky). Private evidence was preserved under ignored `runs/remote-backups/20261120-125749-hosted-full-ab92` before the user-authorized redeploy. Commit `be84cc8` was pushed; Render accepted run `20261120-131827-api-adbf`, whose fingerprint `content-95b7199f6388` matches the Docker source inputs.

That run showed the collection's protocol 6 is also stale. Read-only inspection of production's shipped `/_next/static/immutable/chunks/3fl7xm7pd26gx.js` found module 850396 sends `x-mpc-run-protocol` from module 281697's `l` export, which is literal 9. The next correction pins production to 9 and retains the snapshot's 6 for other environments, preserving explicit negative-test headers. Focused catalog checks (12) and TypeScript passed; review found no actionable issues. This correction still requires deployed verification.
