import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBrief } from '../../pipeline/ai/analyze.mjs'

test('AI brief preserves blocked and skipped statuses so evidence agrees with run counts', () => {
  const run = {
    runId: 'brief-statuses', suite: 'full', env: 'local-docker', status: 'blocked',
    versions: { app: { id: 'test' } },
    counts: { passed: 1, failed: 0, skipped: 1, blocked: 1, total: 3 },
    tests: [
      { key: 'passed', title: 'Passing check', status: 'passed' },
      { key: 'skipped', title: 'Optional check', status: 'skipped' },
      { key: 'blocked', title: 'Unavailable dependency', status: 'blocked' },
    ],
    groups: [], comparison: null,
  }
  const { brief } = buildBrief(run, [])
  assert.deepEqual(brief.tests.map(t => t.status), ['passed', 'skipped', 'blocked'])
  for (const status of ['passed', 'failed', 'skipped', 'blocked']) {
    assert.equal(brief.tests.filter(t => t.status === status).length, brief.run.counts[status])
  }
})
