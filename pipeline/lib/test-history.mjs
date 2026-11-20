/**
 * Trend data for the dashboard, built from saved run records. Pure, so the numbers are unit-testable.
 *
 * Only executed outcomes count: a passed or failed case. Skipped and blocked cases are not evidence of
 * quality either way and are left out of pass rates. A case that passed only on a retry is `passed` with
 * `flaky: true`; it is counted as passed and also in its flaky total.
 */
const usable = run => run && run.finishedAt && !run.seededDefect && !run.reportOnly
  && !['running', 'skipped-overlap'].includes(run.status)

export function buildTrends(runs, { limit = 60 } = {}) {
  const ordered = runs.filter(usable).sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt)).slice(-limit)
  const series = ordered.map(run => {
    const passed = run.counts?.passed ?? 0
    const failed = run.counts?.failed ?? 0
    return {
      runId: run.runId, finishedAt: run.finishedAt, suite: run.suite, env: run.env, status: run.status,
      passed, failed, flaky: run.counts?.flaky ?? 0,
      passRate: passed + failed ? passed / (passed + failed) : null,
    }
  })

  const tests = new Map()
  for (const run of ordered) {
    for (const t of run.tests ?? []) {
      if (!t.key || !['passed', 'failed'].includes(t.status)) continue
      const entry = tests.get(t.key) ?? { key: t.key, title: t.title, executions: 0, failures: 0, flaky: 0, firstFailedAt: null, lastFailedAt: null, lastStatus: null }
      entry.executions++
      entry.title = t.title
      if (t.flaky) entry.flaky++
      if (t.status === 'failed') {
        entry.failures++
        entry.firstFailedAt ??= run.finishedAt
        entry.lastFailedAt = run.finishedAt
      }
      entry.lastStatus = t.status
      tests.set(t.key, entry)
    }
  }
  const topFailing = [...tests.values()]
    .filter(t => t.failures > 0 || t.flaky > 0)
    .map(t => ({ ...t, failureRate: t.executions ? t.failures / t.executions : 0 }))
    .sort((a, b) => b.failures - a.failures || b.flaky - a.flaky || a.title.localeCompare(b.title))
    .slice(0, 20)

  return { window: { runs: series.length, from: series[0]?.finishedAt ?? null, to: series.at(-1)?.finishedAt ?? null }, series, topFailing }
}
