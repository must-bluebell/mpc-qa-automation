# Extended MPC JMeter and Postman plans

These files extend the supplied JMeter recording and Postman collection. The source files remain unchanged. This is a standalone deliverable: the existing k6 scheduler and its load baselines are unchanged. Executions and measured results are retained under `runs/`; a generated plan alone is not evidence of a passing run.

The isolated `local-docker` environment uses the QA-only `pipeline/config/docker-compose.pool.yml` overlay. PgBouncer queues database bursts in transaction mode, with 32 normal backend connections and a 40-connection ceiling, rather than exhausting PostgreSQL's 100-connection limit. It has no published host port. Its authentication file uses the existing local PostgreSQL SCRAM verifier and stays in a private Docker volume. Caddy limits active SQL requests to 16 over HTTP/1.1, keeping them within Neon's 20-connection reuse pool; excess SQL work queues without changing API response assertions. Verbose Neon diagnostic logging is disabled. `npm run stack:up -- --no-build` applies the overlay; stack health also requires the pool to be healthy. Existing database and chain volumes are preserved.

The overlay sets `QA_LOCAL_LOAD=1`. The companion `WEB MPC/next.config.ts` change disables persistent Turbopack development caching and incoming development request logging for that flag during the development-server phase only. Production configuration and application security checks stay unchanged. The local startup also preserves the previous development tree before creating a fresh one, and stages configuration copies so repeated starts do not fail on identical files. Keep the companion changes when moving the harness to another machine. The application still runs in Next.js development mode; results describe this local environment and do not establish production capacity. For a warmed-runtime benchmark, make one preliminary pass through all cases and retain its evidence separately from measured API and JMeter samples.

`local-load-next-config.patch` preserves the companion application change and its configuration tests for another checkout. Apply it from the application directory with `git apply <path-to-this-repo>/testplans/local-load-next-config.patch`; it is already applied to this machine's `WEB MPC` files.

The overlay builds `mpc-qa-neon-proxy-release:58abce0` from `pipeline/docker/neon-proxy.Dockerfile`. The upstream local image ships a debug binary; the QA image uses the **same pinned Neon revision and authentication features**, compiled with `cargo build --release --locked`. Run `npm run stack:up` for the first build, then `--no-build` for subsequent starts. This first compilation needs network access and can take several minutes. It does not change database passwords, authentication checks, test timeouts or load expectations.

## JMeter

Open `MPC-load-testing-extended.jmx` in JMeter 5.6.3 or newer. One active thread group contains 30 distinct cases with response status, JSON and applicable security contract assertions.

| Setting | Default |
|---|---|
| Total users, shared by all 30 cases | 2,000 |
| Ramp-up to all users | 60 seconds |
| Pause before each request, per user | 2,000 ms |
| Iterations per user | 1 |
| Target for this configured QA stack | `http://localhost:3410` |
| Connection / response timeout | 10 / 30 seconds |
| Redirects and embedded-resource downloads | Disabled |

Each user executes all 30 cases sequentially. This is up to 60,000 requests for one iteration. The pause is added to response time, so it does not guarantee exactly one request every two seconds or 1,000 requests/sec. Ramp-up does not guarantee all users remain concurrently active. With healthy responses, the final users finish roughly one minute after ramp-up completes; slow responses extend execution. Cookies are not retained, so rejection cases stay anonymous. No valid bearer, wallet signature, admin session or cron secret is used.

The original 46 recorded samplers are retained only as **disabled reference samplers** in a disabled group. Captured headers, bodies, query strings and numeric IDs have been removed or replaced. Third-party sampler destinations are omitted. This reference is not an executable reconstruction of the original authenticated journey. The 30 new cases target only the configured MPC application. Feature-gated energy endpoints require the corresponding feature enabled; 404 is a failure, not a pass.

After preparing an isolated target and an adequately sized load generator, run explicitly:

```bash
mkdir -p runs/external-load
jmeter -n -t testplans/MPC-load-testing-extended.jmx \
  -Jusers=2000 -Jramp_seconds=60 -Jpacing_ms=2000 -Jloops=1 \
  -Jhost=localhost -Jport=3410 -Jprotocol=http \
  -Jjmeter.save.saveservice.output_format=csv \
  -Jjmeter.save.saveservice.print_field_names=true \
  -Jjmeter.save.saveservice.timestamp_format=ms \
  -l runs/external-load/results.jtl -j runs/external-load/jmeter.log
python3 scripts/external_qa_plans.py report runs/external-load/results.jtl \
  --out runs/external-load/latency
```

Use a fresh JTL path for each run; JMeter may append to an existing file. Target properties are configurable for an approved isolated staging environment. Do not point the stress workload at production or public RPC/analytics services.

## Postman

Import `mpc-waitlist-extended.postman_collection.json`. It preserves all 130 original requests and adds the folder **QA additions - 20 API cases**, for 150 requests total. Run the new folder alone; the original collection includes mutation and administrative templates that require their own fixtures and credentials.

Set `baseUrl` to your isolated application origin, with no trailing slash. The original collection default remains `http://localhost:3000`; the current QA stack uses `http://localhost:3410`. New cases disable inherited authentication, cookie-jar use and redirects. Each case asserts its expected status and JSON contract. Anonymous session cases also assert no address and no-store caching. Public-read cases validate JSON availability, not the entire application schema.

`qaLatencyLimitMs` defaults to **2,000 ms**, a provisional configurable per-request threshold, not an agreed production SLO. Adjust it to your team's approved requirement. Each new request logs its measured response duration as `QA_LATENCY` in the Postman console. Use repeated iterations for meaningful percentiles; one observation cannot establish a latency distribution.

With Newman installed, run the additions and export measured evidence:

```bash
mkdir -p runs/external-api
newman run testplans/mpc-waitlist-extended.postman_collection.json \
  --folder 'QA additions - 20 API cases' \
  --env-var baseUrl=http://localhost:3410 \
  --iteration-count 5 --delay-request 2000 --timeout-request 30000 \
  --reporters cli,json --reporter-json-export runs/external-api/newman.json
python3 scripts/external_qa_plans.py report runs/external-api/newman.json \
  --out runs/external-api/latency
```

The report command is separate so it can still run after Newman exits nonzero for failed assertions. Newman JSON and JTL evidence remain under ignored `runs/`.

## Latency reports

Both formats produce `api-latency.md` and `api-latency.json`: cases ranked by slowest p95, with endpoint, category, sample count, average, p50, p95, p99, maximum, requests/sec and error percentage. Latency is end-to-end response duration, not server-only processing or time to first byte. Percentiles use nearest rank. Expected rejection cases are labelled separately; their timings are not successful authenticated-operation benchmarks. An expected 401/403 passes only with its required assertions. Assertion failures and transport failures count as errors. Newman failures without a response remain in the denominator even though they have no latency sample. No data produces no inferred pass or slowest API.

JMeter per-case requests/sec uses first start to last finish. Newman uses total collection-run duration, including delays. These observed rates are not claims about maximum system capacity. The report retains separate test cases for the same endpoint, rather than blending success and rejection paths.

## Case inventory

`case-catalog.json` defines all 30 cases. The first 20 also appear as `API-EXT-01` through `API-EXT-20` in Postman.

| IDs | Coverage |
|---|---|
| 01–03 | Public home, quests and vote proposals JSON |
| 04 | Anonymous session and cache control |
| 05–11 | Anonymous notifications, activities, energy balance/history/deposits/portfolio/compensation rejection |
| 12–14 | Anonymous admin accounts, quests and roles rejection |
| 15–16 | Relay-sweep and funnel-failures cron bearer protection |
| 17–18 | Foreign-origin nonce and logout rejection |
| 19–20 | Zero and malformed vote metadata IDs |
| 21–23 | Admin ledger export, website analytics and join policy protection |
| 24–26 | Energy, quest and check-in cron bearer protection |
| 27–29 | Foreign-origin notification updates, energy updates and compensation rejection |
| 30 | Invalid authorization cannot turn an anonymous session into a wallet session |

These additions exercise public reads and negative/security paths. Successful signed-in mining, claims, relay submissions and admin operations are not represented as passing load journeys. They need unique session/data fixtures before they can be added safely and meaningfully.

## Rebuild and verify

```bash
python3 scripts/external_qa_plans.py build \
  --jmx '/Users/mac/Downloads/MPC-load-testing.jmx' \
  --postman /Users/mac/mpc-waitlist.postman_collection.json --out testplans
node --test tests/reporting/external-plans.test.mjs
```

Rebuilding reads only recorded method/path metadata from the JMX source, and copies the original Postman collection. Review any future Postman input for credentials before committing its generated copy.

## Browser regression

See [MPC web regression](web-regression.md) for 20 additional Playwright browser cases mapped to the supplied JMeter and Postman files, required fixtures, and execution commands. They join the existing Chromium regression project.
