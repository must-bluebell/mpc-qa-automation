/**
 * Project-level statistics for the dashboard and reports. Pure, so the numbers are unit-testable.
 *
 * A run belongs to a project through its environment (`project` in pipeline/config/environments.json),
 * or through a `project` field stamped on the run itself. Runs saved before that field existed are
 * assigned from their environment when they are read.
 *
 * Pass rate counts executed outcomes only (passed or failed), the same rule as the trend charts.
 */
import { buildTrends } from './test-history.mjs'

export const HEALTHY_PASS_RATE = 0.95
export const AT_RISK_PASS_RATE = 0.8
export const UNASSIGNED = 'unassigned'
const ACTIVE = ['running', 'skipped-overlap']

/** True for a run whose outcome is final and that is not a seeded or report-only record. */
export const countsForReporting = run => Boolean(run?.finishedAt) && !run.seededDefect && !run.reportOnly && !ACTIVE.includes(run.status)

export function projectOf(run, envs = {}) {
  return run?.project || envs[run?.env]?.project || UNASSIGNED
}

const seoulDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
const rate = (passed, failed) => (passed + failed ? passed / (passed + failed) : null)
const timeOf = run => Date.parse(run.finishedAt ?? run.startedAt) || 0
const newestFirst = (a, b) => timeOf(b) - timeOf(a)

function summaryOf(run) {
  const c = run.counts ?? {}
  return {
    runId: run.runId, suite: run.suite, env: run.env ?? null, status: run.status,
    startedAt: run.startedAt ?? null, finishedAt: run.finishedAt ?? null,
    counts: { passed: c.passed ?? 0, failed: c.failed ?? 0, skipped: c.skipped ?? 0, blocked: c.blocked ?? 0, flaky: c.flaky ?? 0 },
  }
}

/** One row per project: its environments, how many runs it has, and its newest finished run. */
export function buildProjects(entries, envs = {}) {
  const projects = new Map()
  const entry = id => {
    if (!projects.has(id)) projects.set(id, { id, envs: new Set(), runs: 0, latest: null })
    return projects.get(id)
  }
  for (const [name, profile] of Object.entries(envs)) if (profile?.project) entry(profile.project).envs.add(name)
  for (const run of entries) {
    const project = entry(projectOf(run, envs))
    if (run.env) project.envs.add(run.env)
    project.runs++
    if (countsForReporting(run) && (!project.latest || newestFirst(run, project.latest) < 0)) project.latest = summaryOf(run)
  }
  return [...projects.values()]
    .map(p => ({ id: p.id, envs: [...p.envs].sort(), runs: p.runs, latest: p.latest }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function healthOf({ latest, passRate, days }) {
  if (!latest) return { state: 'no-data', label: 'No runs yet', rule: 'Health appears after the first completed run.' }
  if (passRate == null) return { state: 'no-data', label: 'No recent results', rule: `No passed or failed tests in the last ${days} days.` }
  const pct = v => `${Math.round(v * 100)}%`
  if (passRate < AT_RISK_PASS_RATE) return { state: 'failing', label: 'Failing', rule: `Pass rate is below ${pct(AT_RISK_PASS_RATE)} in the last ${days} days.` }
  if (passRate < HEALTHY_PASS_RATE || latest.status !== 'passed') {
    return { state: 'at-risk', label: 'At risk', rule: `Pass rate is below ${pct(HEALTHY_PASS_RATE)}, or the latest run did not pass.` }
  }
  return { state: 'healthy', label: 'Healthy', rule: `Pass rate is ${pct(HEALTHY_PASS_RATE)} or higher and the latest run passed.` }
}

/**
 * Statistics for one project (pass `runs` already filtered to that project) and an optional environment.
 * The latest-run and per-suite summaries look at all history; the rates and daily totals use the window.
 */
export function buildOverview(runs, { env = null, days = 30, now = new Date() } = {}) {
  const pool = runs.filter(r => countsForReporting(r) && (!env || r.env === env)).sort(newestFirst)
  const since = now.getTime() - days * 86_400_000
  const windowed = pool.filter(r => timeOf(r) >= since)
  const trends = buildTrends(windowed, { limit: 1000 })
  const series = trends.series
  const sum = key => series.reduce((total, p) => total + (p[key] ?? 0), 0)
  const passed = sum('passed'), failed = sum('failed'), flaky = sum('flaky')
  const passRate = rate(passed, failed)

  const byDay = new Map()
  for (const p of series) {
    const day = seoulDay(p.finishedAt)
    const row = byDay.get(day) ?? { date: day, runs: 0, passed: 0, failed: 0, flaky: 0 }
    row.runs++; row.passed += p.passed; row.failed += p.failed; row.flaky += p.flaky
    byDay.set(day, row)
  }
  const daily = [...byDay.values()]
    .map(d => ({ ...d, passRate: rate(d.passed, d.failed) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const suites = new Map()
  for (const run of pool) if (!suites.has(run.suite)) suites.set(run.suite, summaryOf(run))
  const latest = pool[0] ? summaryOf(pool[0]) : null

  return {
    days, env,
    envs: [...new Set(runs.map(r => r.env).filter(Boolean))].sort(),
    window: trends.window,
    kpis: {
      runs: windowed.length, passedRuns: windowed.filter(r => r.status === 'passed').length,
      passed, failed, flaky, passRate, failureRate: passRate == null ? null : 1 - passRate,
    },
    health: healthOf({ latest, passRate, days }),
    latest,
    suites: [...suites.values()],
    daily,
    topFailing: trends.topFailing,
  }
}
