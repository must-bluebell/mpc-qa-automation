import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ROOT, config, isLoopback } from '../lib/env.mjs'
import { appendEvent } from '../lib/run-store.mjs'
import { runProcess } from '../lib/proc.mjs'
import { signInFresh } from '../lib/siwe.mjs'

export class LoadGuardError extends Error {}

/** Hard guard: load runs only against an isolated loopback environment the config marks allowLoad. */
export function assertLoadAllowed(env, targetUrl) {
  if (!env.allowLoad || !env.isolated) throw new LoadGuardError(`Load tests are refused on "${env.name}": not an approved isolated environment.`)
  if (!isLoopback(targetUrl) || !isLoopback(env.baseUrl)) throw new LoadGuardError(`Load tests are refused: ${targetUrl} is not a loopback address.`)
}

const metric = (summary, name, tag) => summary.metrics?.[`${name}{name:${tag}}`]?.values ?? null

/** Pure evaluation of a k6 summary against thresholds and an optional baseline (unit-tested). */
export function evaluateLoad(summary, thresholds, baseline) {
  const endpoints = {}
  const breaches = []
  for (const [name, slo] of Object.entries(thresholds.endpoints)) {
    const d = metric(summary, 'http_req_duration', name)
    const f = metric(summary, 'http_req_failed', name)
    const c = metric(summary, 'http_reqs', name)
    const row = { p95Ms: d?.['p(95)'] ?? null, p99Ms: d?.['p(99)'] ?? null, avgMs: d?.avg ?? null, errorRate: f?.rate ?? null, requests: c?.count ?? 0, slo, breaches: [] }
    if (!row.requests) row.breaches.push('no requests recorded')
    if (row.p95Ms != null && row.p95Ms > slo.p95Ms) row.breaches.push(`p95 ${Math.round(row.p95Ms)}ms > ${slo.p95Ms}ms`)
    if (row.errorRate != null && row.errorRate > slo.maxErrorRate) row.breaches.push(`error rate ${(row.errorRate * 100).toFixed(2)}% > ${(slo.maxErrorRate * 100).toFixed(2)}%`)
    const base = baseline?.endpoints?.[name]
    if (base?.p95Ms && row.p95Ms != null && row.p95Ms > base.p95Ms * (1 + thresholds.maxP95RegressionPct / 100) && row.p95Ms - base.p95Ms > 50) {
      row.breaches.push(`p95 regressed ${Math.round(((row.p95Ms - base.p95Ms) / base.p95Ms) * 100)}% vs baseline ${Math.round(base.p95Ms)}ms`)
    }
    if (base && row.errorRate != null && (row.errorRate - (base.errorRate ?? 0)) * 100 > thresholds.maxErrorRateRegressionPct) {
      row.breaches.push(`error rate rose ${((row.errorRate - (base.errorRate ?? 0)) * 100).toFixed(2)} points vs baseline`)
    }
    endpoints[name] = row
    for (const b of row.breaches) breaches.push(`${name}: ${b}`)
  }
  const rps = summary.metrics?.http_reqs?.values?.rate ?? 0
  const checks = summary.metrics?.checks?.values?.rate ?? null
  return { endpoints, throughputRps: rps, checkPassRate: checks, totalRequests: summary.metrics?.http_reqs?.values?.count ?? 0, breaches }
}

export async function runK6Step(step, ctx) {
  assertLoadAllowed(ctx.env, ctx.targetUrl)
  const thresholds = config.thresholds()
  const profileName = process.env.QA_LOAD_PROFILE || step.profile || 'baseline'
  const profile = { ...thresholds.profiles[profileName] }
  if (process.env.QA_LOAD_DURATION && profile.duration) profile.duration = process.env.QA_LOAD_DURATION
  // Sessions are signed in against the real app (not the chaos proxy) so seeded faults only affect measured traffic.
  const sessions = []
  for (let i = 0; i < (step.sessions ?? 10); i++) sessions.push(await signInFresh({ baseUrl: ctx.env.baseUrl, appOrigin: ctx.env.appOrigin, chainId: ctx.env.chainId }))
  // Private, unpredictable temp folder (mkdtemp creates it 0700) so other local users cannot read the cookies.
  const secretDir = mkdtempSync(join(tmpdir(), 'mpc-qa-'))
  const sessionsFile = join(secretDir, 'sessions.json') // cookies stay out of the evidence folder
  writeFileSync(sessionsFile, JSON.stringify(sessions), { mode: 0o600 })
  const summaryFile = join(ctx.stepDir, 'k6-summary.json')
  try {
    const result = await runProcess('k6', ['run', '--quiet', join(ROOT, 'load/k6', `${step.script}.js`)], {
      cwd: ROOT, timeoutMs: ctx.remainingMs(), logFile: join(ctx.stepDir, 'output.log'), echo: ctx.echo,
      env: { BASE_URL: ctx.targetUrl, APP_ORIGIN: ctx.env.appOrigin, SESSIONS_FILE: sessionsFile, SUMMARY_FILE: summaryFile,
        K6_PROFILE: JSON.stringify(profile), K6_ENDPOINTS: JSON.stringify(Object.keys(thresholds.endpoints)), K6_NO_USAGE_REPORT: 'true' },
    })
    const base = relative(ctx.runDir, ctx.stepDir).split('\\').join('/')
    if (!existsSync(summaryFile)) {
      return { tests: [], errors: [`k6 produced no summary (exit ${result.code}): ${result.tail.slice(-1200)}`], infra: /not found|ENOENT/.test(result.tail) ? 'load tool missing' : 'load run did not complete', timedOut: result.timedOut }
    }
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8'))
    const baselinePath = join(ROOT, 'pipeline/baselines', `${ctx.env.name}-${profileName}.json`)
    const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null
    const load = evaluateLoad(summary, thresholds, baseline)
    const evidence = [{ name: 'k6 summary', path: `${base}/k6-summary.json` }, { name: 'k6 output', path: `${base}/output.log` }]
    const tag = ['@load', '@PERF-01', '@critical']
    const tests = Object.entries(load.endpoints).map(([name, row]) => ({
      key: `k6:${profileName}:${name}`, title: `PERF-01 ${name} meets p95/error-rate SLO (${profileName})`, adapter: 'k6', project: profileName, tags: tag,
      status: row.breaches.length ? 'failed' : 'passed', durationMs: null, retries: 0, errors: row.breaches.length ? [`Load SLO breached for ${name}: ${row.breaches.join('; ')}`] : [],
      annotations: [], evidence,
    }))
    const rpsOk = load.throughputRps >= thresholds.minThroughputRps
    tests.push({ key: `k6:${profileName}:throughput`, title: `PERF-01 throughput ≥ ${thresholds.minThroughputRps} req/s (${profileName})`, adapter: 'k6', project: profileName, tags: tag,
      status: rpsOk ? 'passed' : 'failed', durationMs: null, retries: 0, errors: rpsOk ? [] : [`Throughput ${load.throughputRps.toFixed(1)} req/s below ${thresholds.minThroughputRps}`], annotations: [], evidence })
    const checksOk = load.checkPassRate != null && load.checkPassRate >= 0.99
    tests.push({ key: `k6:${profileName}:checks`, title: `PERF-01 functional checks hold under load (${profileName})`, adapter: 'k6', project: profileName, tags: tag,
      status: checksOk ? 'passed' : 'failed', durationMs: null, retries: 0, errors: checksOk ? [] : [`Only ${((load.checkPassRate ?? 0) * 100).toFixed(1)}% of functional checks passed under load`], annotations: [], evidence })
    let baselineAction = 'compared'
    if (!ctx.seededDefect && !load.breaches.length && (!baseline || process.env.QA_UPDATE_BASELINE === '1')) {
      writeFileSync(baselinePath, JSON.stringify({ createdAt: new Date().toISOString(), runId: ctx.runId, profile: profileName, profileSpec: profile,
        appVersion: ctx.versions.app.id, endpoints: Object.fromEntries(Object.entries(load.endpoints).map(([k, v]) => [k, { p95Ms: v.p95Ms, errorRate: v.errorRate, requests: v.requests }])),
        throughputRps: load.throughputRps }, null, 2))
      baselineAction = baseline ? 'updated' : 'created'
    } else if (!baseline) baselineAction = 'none'
    return { tests, errors: [], timedOut: result.timedOut, load: { profile: profileName, profileSpec: profile, ...load, baselineAction, baseline }, artifacts: { log: `${base}/output.log` } }
  } finally {
    rmSync(secretDir, { recursive: true, force: true })
    appendEvent('load-runs.jsonl', { runId: ctx.runId, env: ctx.env.name, target: ctx.targetUrl, profile: profileName })
  }
}
