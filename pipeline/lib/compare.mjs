/**
 * Diff a run against the previous run of the same suite + environment, plus history for "first seen".
 *  - newFailures: test failing now that passed (or did not fail) last time
 *  - persisting:  same failure variant as last time (a duplicate; alert is grouped, not repeated as new)
 *  - newVariants: test failed last time too, but with a different failure (previously unseen variant)
 *  - recovered:   test failed last time and passes now
 */
export function compareRuns(current, previous, history = []) {
  const prev = new Map((previous?.tests ?? []).map(t => [t.key, t]))
  const firstSeen = new Map()
  for (const run of history) for (const fp of run.failedFingerprints ?? []) if (!firstSeen.has(fp)) firstSeen.set(fp, run.runId)
  const out = { previousRunId: previous?.runId ?? null, newFailures: [], persisting: [], newVariants: [], recovered: [] }
  for (const t of current.tests) {
    const before = prev.get(t.key)
    if (t.status === 'failed') {
      const item = { key: t.key, title: t.title, fingerprint: t.fingerprint, firstSeenRunId: firstSeen.get(t.fingerprint) ?? current.runId }
      if (!before || before.status !== 'failed') out.newFailures.push(item)
      else if (before.fingerprint === t.fingerprint) out.persisting.push({ ...item, since: firstSeen.get(t.fingerprint) ?? previous.runId })
      else out.newVariants.push({ ...item, previousFingerprint: before.fingerprint })
    } else if (t.status === 'passed' && before?.status === 'failed') {
      out.recovered.push({ key: t.key, title: t.title, failingSinceRunId: firstSeen.get(before.fingerprint) ?? previous.runId })
    }
  }
  return out
}
