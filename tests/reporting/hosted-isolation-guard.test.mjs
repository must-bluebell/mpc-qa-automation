import test from 'node:test'
import assert from 'node:assert/strict'
import { guard, expandSuite } from '../../pipeline/orchestrator.mjs'
import { resolveEnvironment } from '../../pipeline/lib/env.mjs'

// Render (QA_HOSTED=1) has no Docker daemon. Every isolated profile must be refused by the orchestrator guard,
// including manual runs that bypass the scheduler's placement check.
function withHosted(value, fn) {
  const previous = process.env.QA_HOSTED
  if (value === undefined) delete process.env.QA_HOSTED
  else process.env.QA_HOSTED = value
  try { return fn() } finally {
    if (previous === undefined) delete process.env.QA_HOSTED
    else process.env.QA_HOSTED = previous
  }
}

test('hosted deployments refuse every isolated Docker environment', () => {
  for (const name of ['local-docker', 'web-isolated']) {
    const env = resolveEnvironment(name)
    assert.ok(env.isolated, `${name} resolves as isolated`)
    withHosted('1', () => assert.throws(() => guard({ suiteName: 'smoke', env, steps: expandSuite('smoke') }), /developer machine/))
  }
})

test('hosted deployments still allow hosted environments for read-only suites', () => {
  const env = resolveEnvironment('production')
  withHosted('1', () => assert.doesNotThrow(() => guard({ suiteName: 'smoke', env, steps: expandSuite('smoke') })))
})

test('developer machines keep the isolated environments available', () => {
  const env = resolveEnvironment('web-isolated')
  withHosted(undefined, () => assert.doesNotThrow(() => guard({ suiteName: 'smoke', env, steps: expandSuite('smoke') })))
})
