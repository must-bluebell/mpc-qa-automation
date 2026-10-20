/** Rates describe checks in this run, not historical PR merge success. */
export function qualityRates(counts) {
  const count = key => Number.isFinite(counts[key]) && counts[key] >= 0 ? Math.floor(counts[key]) : 0
  const executed = count('passed') + count('failed')
  const total = executed + count('skipped') + count('blocked')
  return { executed, total, passRate: executed ? 100 * count('passed') / executed : null,
    executionRate: total ? 100 * executed / total : null }
}
export const formatRate = value => value === null ? 'n/a' : `${value.toFixed(1)}%`
