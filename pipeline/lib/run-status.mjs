/** A runner failure or an entirely unexecuted suite must never produce a green gate. */
export function runStatus({ tests, steps }) {
  if (tests.some(t => t.status === 'failed' && t.classification?.kind === 'product')) return 'failed'
  if (tests.some(t => t.status === 'failed')) return 'infra-failed'
  if (steps.some(s => s.timedOut)) return 'timeout'
  if (steps.some(s => s.errors?.length || (s.exitCode != null && s.exitCode !== 0))) return 'infra-failed'
  if (steps.some(s => s.name && !tests.some(t => t.step === s.name && ['passed', 'failed'].includes(t.status)))) return 'blocked'
  return tests.some(t => t.status === 'passed') ? 'passed' : 'blocked'
}
