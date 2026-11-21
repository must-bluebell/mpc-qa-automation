import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Render has no Docker and must never run recurring checks against production. These guard the hosted schedule file.
const hosted = JSON.parse(readFileSync(new URL('../../pipeline/config/schedules.hosted.json', import.meta.url), 'utf8'))
const enabled = hosted.schedules.filter(s => s.enabled)

// Only the hourly smoke targets production, by explicit decision. It is read-only: production allows no writes, load or seeded defects.
const PRODUCTION_ALLOWED = new Set(['hourly-smoke-hosted'])

test('hosted schedules run only on read-only environments; production only for the hourly smoke', () => {
  assert.ok(enabled.length > 0, 'at least one hosted schedule is enabled')
  for (const s of enabled) {
    const expected = PRODUCTION_ALLOWED.has(s.id) ? 'production' : 'preview'
    assert.equal(s.env, expected, `${s.id} must target ${expected}, not ${s.env}`)
  }
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

// The hourly run has no wallet seed phrase, so its sign-in journey must not depend on one.
test('the hourly sign-in journey runs without wallet secrets', () => {
  const spec = readFileSync(new URL('../../tests/wallet/smoke-journeys.spec.ts', import.meta.url), 'utf8')
  assert.match(spec, /J02 - A rejected sign-in request/)
  assert.doesNotMatch(spec, /QA_SEED_PHRASE|WALLET_ADDRESS|getConfiguredWallet/)
})
