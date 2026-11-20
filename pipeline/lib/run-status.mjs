/** A runner failure or an entirely unexecuted suite must never produce a green gate. */
export function executionRecovered(run) {
  return ['passed','failed'].includes(run.status)&&!run.errors?.length
    &&run.testData?.status!=='failed'
    &&!(run.steps??[]).some(s=>s.timedOut||s.errors?.length)
    &&!(run.tests??[]).some(t=>t.infra||t.status==='blocked'||t.classification?.kind==='infrastructure')
}

export function runStatus({ tests, steps, testData }) {
  if (steps.some(s => s.timedOut)) return 'timeout'
  if (tests.some(t => t.status === 'failed' && t.classification?.kind === 'product')) return 'failed'
  if (tests.some(t => t.status === 'failed')) return 'infra-failed'
  if (steps.some(s => s.errors?.length || (s.exitCode != null && s.exitCode !== 0))) return 'infra-failed'
  if (testData?.status === 'failed') return 'infra-failed'
  if (tests.some(t => t.status === 'blocked')) return 'blocked'
  if (steps.some(s => s.name && !tests.some(t => t.step === s.name && ['passed', 'failed'].includes(t.status)))) return 'blocked'
  return tests.some(t => t.status === 'passed') ? 'passed' : 'blocked'
}
