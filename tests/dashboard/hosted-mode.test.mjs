import test from 'node:test'
import assert from 'node:assert/strict'
import { expandSuite, guard } from '../../pipeline/orchestrator.mjs'
import { resolveEnvironment } from '../../pipeline/lib/env.mjs'

function withHosted(fn) {
  const previous = process.env.QA_HOSTED
  process.env.QA_HOSTED = '1'
  try { return fn() } finally { if (previous === undefined) delete process.env.QA_HOSTED; else process.env.QA_HOSTED = previous }
}

test('hosted-full runs API and regression only, never isolated or load steps', () => {
  const steps = expandSuite('hosted-full')
  assert.deepEqual([...new Set(steps.map(s => s.fromSuite))].sort(), ['api', 'regression'])
  assert.ok(steps.every(s => !s.requiresIsolated && !s.requiresLoad))
})

test('hosted deployments accept hosted-full on the preview environment', () => withHosted(() => {
  const previous = process.env.QA_PREVIEW_BASE_URL
  process.env.QA_PREVIEW_BASE_URL = 'https://preview.example.test'
  try {
    const env = resolveEnvironment('preview')
    assert.doesNotThrow(() => guard({ suiteName: 'hosted-full', env, steps: expandSuite('hosted-full') }))
  } finally { if (previous === undefined) delete process.env.QA_PREVIEW_BASE_URL; else process.env.QA_PREVIEW_BASE_URL = previous }
}))

test('staging has no hardcoded URL that could redirect to production', () => {
  assert.throws(() => resolveEnvironment('staging'), /QA_STAGING_BASE_URL/)
})

test('hosted deployments refuse local-docker for any suite', () => withHosted(() => {
  const env = resolveEnvironment('local-docker')
  assert.throws(() => guard({ suiteName: 'smoke', env, steps: expandSuite('smoke') }), /only available on a developer machine/)
}))

test('local development still allows local-docker', () => {
  delete process.env.QA_HOSTED
  const env = resolveEnvironment('local-docker')
  assert.doesNotThrow(() => guard({ suiteName: 'smoke', env, steps: expandSuite('smoke') }))
})
