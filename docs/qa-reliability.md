# QA reliability and deployment checks

Application suites must run through the authenticated Render dashboard:
https://qa-automation-bq3y.onrender.com. A local tooling check does not validate the deployed app.

## Behavior

- Pipeline Playwright checks retry once by default. Retry passes are marked flaky and counted in run history and dashboard trends.
- Render schedules hourly smoke and nightly hosted-full against `preview`. Set `QA_PREVIEW_BASE_URL` on Render. Production remains available for manual read-only checks. No local schedules are enabled, and Docker-dependent suites are refused on Render.
- Smoke includes wallet discovery, anonymous mining access protection, and rejected-signature coverage. Anonymous access checks need no wallet credentials. A03 verifies successful SIWE sign-in only on an environment authorized for writes; current hosted profiles are read-only. A passing smoke run with A03 skipped does **not** establish successful sign-in.
- The dashboard watchdog checks scheduler silence at a 90-minute threshold and periodically checks the configured wallet's native-token balance. It sends opening/recovery alerts through configured Slack delivery. Keep the wallet empty. This does not inspect arbitrary ERC-20 assets or monitor an outage of the entire Render service; an external uptime monitor is needed for the latter.
- Dashboard trends show pass rate, first observed failure within the displayed history window, and flaky counts.
- Company Google accounts are viewers; only the admin key allows mutations. `QA_GOOGLE_ALLOWED_EMAILS`, when set, restricts company accounts further and never admits outside-domain accounts.
- Jira starts in manual-confirmation mode. Automatic creation requires `QA_JIRA_AUTO=1`, a product classification, and a failed retry. Tickets are tracked by environment and test, so a preview pass cannot close a production defect. Existing tickets recover their environment from their original saved run. If that record is unavailable, review the existing ticket before creating another.
- GitHub Markdown reports omit the empty previous-run comparison. No GitHub history synchronization is introduced.

## Settings to supply privately on Render

Google viewers require `QA_GOOGLE_CLIENT_ID`, `QA_GOOGLE_CLIENT_SECRET`, and `QA_GOOGLE_ALLOWED_DOMAIN`; optionally set `QA_GOOGLE_ALLOWED_EMAILS`. Register this redirect URI:
`https://qa-automation-bq3y.onrender.com/auth/google/callback`.

Jira requires `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`. The default project is `ME`; keep `QA_JIRA_AUTO=0` while people confirm initial tickets. Existing Slack configuration is used for alerts. Wallet monitoring uses `WALLET_ADDRESS`, `QA_WALLET_CHAIN_ID` (or `QA_CHAIN_ID`), and optionally `QA_WALLET_RPC_URL`; the default permitted native balance is zero.

Never put credentials in commits, command arguments, reports, or chat.

## Verification on 2026-11-20

Render authentication succeeded using the private access key together with the page CSRF token. Authenticated status confirmed hosted mode, no Docker stack, a disabled hourly production schedule, and an enabled nightly preview schedule. Google sign-in and Jira were unconfigured. The deployed run index was empty, so the original hourly W01 artifacts were unavailable. Initial HTTP 403 responses came from requests missing the CSRF token; they did not prove the access key was invalid.

The archived `runs/audit-2026-11-18/render-smoke-results.json` records W01 timing out while clicking the analytics consent dialog's Reject button. This is historical evidence, not proof of the cause of the specific hourly Join Unity timeout. That run's screenshot and trace must be retrieved through authenticated Render access before drawing that conclusion. Current JoinSheet code already contains consent dismissal and bounded CTA retry handling.

A preview smoke start returned HTTP 500 without a run ID. The dashboard preflight now reports missing environment configuration as HTTP 422 with the required setting name instead of a generic internal error. A manual read-only production smoke was accepted as `20261120-105913-smoke-16bd`; the retrieved final result was 11 passed, 1 failed, 1 skipped, zero flaky. W01 passed without retry. J01 failed on both attempts; A03 was skipped under production write protection.

After deployment, authenticate with the current key, inspect `/api/status`, start `smoke` through `/api/runs` against the configured preview, retain its returned run ID, and retrieve that run and its evidence from the same deployment. Verify actual retry outcomes and skipped sign-in coverage rather than relying on suite status alone. Do not enable hosted writes or attempt Docker suites to bypass missing sign-in coverage.

The fresh Render run reproduced J01 on both attempts. Its downloaded trace and DOM snapshot show the Unity landing page at the retired `?view=dig` URL, with mining gated behind joining. J01 now checks the current `?tab=mine` entry: an anonymous visitor sees Home and Join, cannot see the My Mine panel, and retains an anonymous session. This revised browser assertion requires deployment and another Render run for verification.
