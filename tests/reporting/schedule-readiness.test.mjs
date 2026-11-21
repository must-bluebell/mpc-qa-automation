import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleReadiness } from '../../pipeline/lib/placement.mjs'
const schedule = { id: 'hourly', suite: 'smoke', env: 'preview', enabled: true }
const options = { hosted: true, environments: { preview: { baseUrlEnv: 'QA_PREVIEW_BASE_URL' } }, suites: { smoke: {} }, variables: {} }
test('missing preview configuration is blocked with the setting name', () => {
  assert.deepEqual(scheduleReadiness(schedule, options), { ready: false, reason: 'Environment "preview" needs QA_PREVIEW_BASE_URL.' })
})
test('configured hosted target is ready without disclosing its URL', () => {
  assert.deepEqual(scheduleReadiness(schedule, { ...options, variables: { QA_PREVIEW_BASE_URL: 'https://preview.example' } }), { ready: true, reason: null })
})
test('unknown suites and unusable hosted URLs are blocked', () => {
  assert.equal(scheduleReadiness({ ...schedule, suite: 'missing' }, options).ready, false)
  for (const url of ['garbage', 'file:///tmp/test', 'http://localhost:3000', 'https://user:secret@example.com']) {
    const result = scheduleReadiness(schedule, { ...options, variables: { QA_PREVIEW_BASE_URL: url } })
    assert.equal(result.ready, false)
    assert.ok(!result.reason.includes(url))
  }
})

test('summary schedules need no application target or runnable suite', () => {
  assert.deepEqual(scheduleReadiness({ kind: 'summary', suite: 'daily-health', env: 'preview' }, options), { ready: true, reason: null })
})
test('Docker-only schedules remain refused on hosted runners', () => {
  assert.match(scheduleReadiness(schedule, { ...options, suites: { smoke: { requiresIsolated: true } } }).reason, /isolated Docker runner/)
})
