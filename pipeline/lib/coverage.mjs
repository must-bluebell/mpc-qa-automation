/** Which approved requirements a set of test results covers, using each requirement's coveredBy matchers. */
export function matchRequirements(test, requirements) {
  return requirements.filter(r => r.approved && (r.coveredBy ?? []).some(m =>
    m.startsWith('tag:') ? (test.tags ?? []).includes(m.slice(4)) : m.startsWith('title:') ? test.title.includes(m.slice(6)) : false,
  )).map(r => r.id)
}

/**
 * Per requirement: passed (≥1 passing assertion, none failing), failed (any mapped test failed), or not-run.
 * Coverage ratio = critical approved requirements with a passing assertion ÷ all critical approved requirements.
 */
export function coverageOf(tests, requirements) {
  const rows = requirements.filter(r => r.approved).map(r => {
    const mapped = tests.filter(t => (t.requirementIds ?? []).includes(r.id))
    const failed = mapped.filter(t => t.status === 'failed')
    const passed = mapped.filter(t => t.status === 'passed')
    return { id: r.id, critical: !!r.critical, area: r.area, description: r.description,
      status: failed.length ? 'failed' : passed.length ? 'passed' : 'not-run', tests: mapped.map(t => ({ key: t.key, status: t.status })) }
  })
  const critical = rows.filter(r => r.critical)
  const covered = critical.filter(r => r.status === 'passed').length
  return { numerator: covered, denominator: critical.length, ratio: critical.length ? covered / critical.length : 0, requirements: rows }
}

/** Latest result per requirement across recent runs (any suite), so smoke + api + uat combine into one picture. */
export function latestCoverage(runs, requirements, windowMs = 7 * 86_400_000) {
  const now = Date.now()
  const latest = new Map()
  for (const run of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (run.seededDefect || now - Date.parse(run.startedAt) > windowMs) continue
    for (const req of run.coverage?.requirements ?? []) {
      if (req.status === 'not-run') continue
      latest.set(req.id, { status: req.status, runId: run.runId, at: run.startedAt })
    }
  }
  const rows = requirements.filter(r => r.approved).map(r => ({ id: r.id, critical: !!r.critical, area: r.area, description: r.description,
    ...(latest.get(r.id) ?? { status: 'not-run', runId: null, at: null }) }))
  const critical = rows.filter(r => r.critical)
  const covered = critical.filter(r => r.status === 'passed').length
  return { numerator: covered, denominator: critical.length, ratio: critical.length ? covered / critical.length : 0, requirements: rows }
}
