import test from 'node:test'
import assert from 'node:assert/strict'
import { aiArgs, shouldReview } from '../../pipeline/ai/policy.mjs'

test('explicit checkbox choices survive the dashboard to CLI boundary', () => {
  assert.deepEqual(aiArgs(true), ['--ai'])
  assert.deepEqual(aiArgs(false), ['--no-ai'])
  assert.deepEqual(aiArgs(undefined), [])
})

test('explicit review overrides automatic mode in both directions', () => {
  assert.equal(shouldReview(true, { status: 'passed' }, {}), true)
  assert.equal(shouldReview(false, { status: 'failed' }, { QA_AI_AUTO: '1' }), false)
})

test('automatic review includes assertion and infrastructure failures, excluding clean and overlap runs', () => {
  for (const status of ['failed', 'infra-failed', 'timeout', 'blocked', 'crashed']) {
    assert.equal(shouldReview(undefined, { status }, { QA_AI_AUTO: '1' }), true, status)
    assert.equal(shouldReview(undefined, { status }, {}), false, status)
  }
  for (const status of ['passed', 'running', 'skipped-overlap'])
    assert.equal(shouldReview(undefined, { status }, { QA_AI_AUTO: '1' }), false, status)
})
