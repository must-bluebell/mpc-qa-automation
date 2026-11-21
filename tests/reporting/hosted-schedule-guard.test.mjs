import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Render has no Docker and must never run recurring checks against production. These guard the hosted schedule file.
const hosted = JSON.parse(readFileSync(new URL('../../pipeline/config/schedules.hosted.json', import.meta.url), 'utf8'))
const enabled = hosted.schedules.filter(s => s.enabled)

test('hosted schedules run only on the read-only preview environment', () => {
  assert.ok(enabled.length > 0, 'at least one hosted schedule is enabled')
  for (const s of enabled) assert.equal(s.env, 'preview', `${s.id} must target preview, not ${s.env}`)
})

test('hosted schedules use only suites that Render can run without Docker', () => {
  for (const s of enabled) assert.ok(['smoke', 'hosted-full'].includes(s.suite), `${s.id} uses suite ${s.suite}`)
})

test('the hourly smoke check is enabled and runs every hour', () => {
  const smoke = hosted.schedules.find(s => s.id === 'hourly-smoke-hosted')
  assert.ok(smoke?.enabled, 'hourly smoke must be enabled')
  assert.equal(smoke.cron, '0 * * * *')
})

test('the recurring rotation stays disabled on hosted', () => {
  assert.equal(hosted.rotation.enabled, false)
})
