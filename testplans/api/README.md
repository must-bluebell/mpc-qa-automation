# Unity API automation

The supplied Postman collection contains 171 distinct method/route pairs. `contracts.json` gives each a stable API001–API171 ID, source reference, request path and explicit baseline response. `coverage.md` lists the mapping.

The expanded Playwright suite adds baseline responses, forged credentials, origin rejection, 43 wallet-authenticated validation cases, 18 administrator validation cases, five workflows, and one success-case slot for every endpoint. These are discovered by the existing `api` project and `qa:api` pipeline automatically.

**This is not yet verified full behavioral coverage.** There are 154 built-in baseline contracts and 17 baseline gaps requiring matching source or an environment-specific contract. There are 16 built-in success cases (two require admin session fixtures); the remaining 155 success slots explicitly skip until populated. The local checkout has handlers for 130 collection entries; the other 41 rely on the supplied snapshot. Missing deployed routes fail assertions rather than being accepted as success. Catalog coverage does not mean every endpoint has passed an HTTP test.

## Commands

```sh
npm run test:api:catalog
npm run typecheck
npm run report:api:coverage
npm run test:api:collection -- --list
```

Run the expanded suite only against the existing isolated stack, sequentially with other suites using that stack:

```sh
BASE_URL=http://localhost:3461 \
QA_APP_ORIGIN=http://localhost:3461 \
QA_CHAIN_ID=97 QA_ALLOW_WRITES=1 \
QA_REPORT_DIR=runs/api-collection \
npm run test:api:collection -- --retries=0
```

`npm run test:api` includes the pre-existing authentication/security tests as well. `npm run qa:api -- --env local-docker` uses the existing orchestrator and its stack lock; use it for a scheduled/shared-stack run. No new scheduler was installed.

Without `QA_ALLOW_WRITES=1`, all expanded cases skip before making requests. With the flag set, the suite additionally requires a loopback base URL. This covers GET cron jobs, development routes, anonymous mutations and transaction routes as well as ordinary writes. Redirects are not followed. The existing older specs retain their own controls.

The default profile expects My Mine and the legacy energy bridge routes to be enabled, administrator configuration to exist, and requests to reach the application rather than an authentication proxy. A deployment with disabled features is a different contract. Do not add 404/500 to accepted statuses to make it green.

## Seeded fixtures

Set `QA_API_CASES_FILE` to a private JSON file following `fixtures.example.json`. The example's API145 baseline applies only when the isolated join policy enables `skipEmailOtp`; when OTP is required, replace it with status 403 and error `otp_required`.

Each entry is keyed by its stable ID and can supply:

- `baseline`: an exact `status` and response assertions for configuration-dependent or missing-source baseline cases.
- `success`: `auth`, a concrete relative `path`, optional `body`/`headers`, and `expected` assertions. The path must match that entry's route. Unresolved Postman variables, other endpoints, and external URLs are rejected before execution.

`expected` supports exact nested `fields` (dot-separated paths), `types` (`array`, `string`, `number`, `boolean`, `object`, `null`, or a union), exact `error`, `text` containment, `contentType`, empty body, and redirect `location` containment. Exact status and at least one nonempty assertion are mandatory; success cases require 2xx/3xx. Assertions must describe the intended seeded state, not be copied automatically from a failing response.

Authentication modes:

| Mode | Setup |
| --- | --- |
| `anonymous` | Fresh empty cookie context |
| `wallet` | Fresh throwaway wallet, real nonce/SIWE authentication |
| `admin` | `QA_API_ADMIN_STATE_FILE`: Playwright storageState for an isolated admin with the required permissions and completed password-change step |
| `cron` | `QA_API_CRON_SECRET`: secret belonging only to the isolated stack |
| `fixture` | `storageStateEnv`: name of an environment variable holding a seeded test account's storageState file path |

Supply these through process environment variables. They are not loaded into browser workers from `.env`. Keep private fixture files and storage states outside version control. Seeded IDs, challenges and signatures must belong to the isolated stack and to the same account as the storage state. Expiring vouchers need refreshing before each run. A static template cannot manufacture valid chain transactions, Telegram OAuth callbacks, email OTPs, or Turnstile tokens.

Admin mutation, authorized cron and transaction success cases execute only when their explicit success fixtures exist. The runner performs the requested operation; seed disposable data and use the stack's reset/cleanup workflow between runs. It does not delete records or reset chain state automatically. The five built-in workflows use fresh wallet identities; registration retains a unique `example.com` test record in the disposable database.

Response attachments contain route, status, content type and byte count, not raw payloads or credentials. Administrator and success-fixture traces are disabled. Reports may still contain assertion values, so keep expected assertions free of secrets.

## Verification on 2026-11-05

Typechecking and the catalog/safety unit checks pass. Offline Playwright execution verifies test collection and the write-disabled skip gate; skipped cases are not recorded as endpoint passes. Live HTTP execution was blocked by sandbox networking, and permission to run outside the sandbox was declined. No successful live API run is claimed.

Final offline results: 628 expanded Playwright cases discovered, all 628 correctly skipped with writes disabled; four catalog/safety tests passed. The broader reporting suite finished with 287 passed, two skipped and two failures caused by sandbox `listen EPERM` on loopback: `browser warmup compiles join telemetry with an invalid body before wallet requests` and `corrupt Slack state cannot discard completed results or retain the pipeline lock`. These are infrastructure limitations, not verified API outcomes.
