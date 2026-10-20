import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeRecordedLoad } from '../../pipeline/adapters/recorded-load.mjs'
import { assertRecordedDestination, recordedMatches, recordedResponseOk, recordedAssertion, recordedError } from '../../pipeline/docker/recorded-load-policy.mjs'

const plan = JSON.parse(readFileSync(new URL('../../load/recorded/mpc-recording.json', import.meta.url)))
test('runner diagnostics retain HTTP mismatch details without response credentials', () => {
  const value = recordedError(new Error('POST /api/auth/verify: expected 200, got 401 {"signature":"secret-value"}'))
  assert.match(value, /POST \/api\/auth\/verify expected 200, got 401/)
  assert.doesNotMatch(value, /secret-value|signature/)
})
test('a logout identity assertion failure marks that measured case failed', async () => {
  const report = { samples: [{ id: 'JMX-03', ok: true }], errors: [] }
  await recordedAssertion(report, ['JMX-46'], async () => {
    report.samples.push({ id: 'JMX-46', ok: true, status: 200 })
    throw new Error('identity was retained')
  })
  assert.equal(report.samples[0].ok, true)
  assert.equal(report.samples[1].ok, false)
  assert.match(report.errors[0], /JMX-46/)
})
test('HTTP 200 cannot hide malformed RPC, RPC errors, an empty batch or a truncated body', async () => {
  await assert.rejects(recordedResponseOk(new Response('broken JSON'), true, true))
  for (const payload of [[], { jsonrpc: '2.0', error: { code: -1 } }, { result: '0x01' },
    { jsonrpc: '2.0', id: 1, result: null }, { jsonrpc: '2.0', id: 1, result: 'invalid' }]) {
    assert.equal(await recordedResponseOk(Response.json(payload), true, true), false)
  }
  assert.equal(await recordedResponseOk(Response.json({ jsonrpc: '2.0', id: 1, result: '0x01' }), true, true), true)
  await assert.rejects(recordedResponseOk({ clone: () => ({ arrayBuffer: async () => { throw new Error('truncated') } }), ok: true }, false, true), /truncated/)
})
test('recorded traffic cannot use public, credentialed or unexpected local destinations', () => {
  for (const url of ['https://app.globalmpc.tech/', 'http://127.0.0.1:8585/', 'http://user:pass@anvil:8545/', 'http://neon-proxy:3400/', 'https://www.google-analytics.com/g/collect']) {
    assert.throws(() => assertRecordedDestination(url), /refuses/)
  }
  const rpc = assertRecordedDestination('http://anvil-opbnb:8545/')
  assert.deepEqual(recordedMatches(plan, rpc, 'POST', ['eth_call']).map(row => row.id), ['JMX-16'])
  assert.deepEqual(recordedMatches(plan, rpc, 'POST', ['eth_sendRawTransaction']), [])
  assert.deepEqual(recordedMatches(plan, new URL('http://127.0.0.1:3400/api/activities/123/seen'), 'POST').map(row => row.id), ['JMX-26', 'JMX-35', 'JMX-41'])
})
test('recorded plan preserves every source ID without recorded credentials or external execution', () => {
  assert.equal(plan.cases.length, 46)
  assert.equal(new Set(plan.cases.map(row => row.id)).size, 46)
  assert.equal(plan.cases.filter(row => row.excluded).length, 1)
  assert.equal(plan.cases.filter(row => row.blocked).length, 1)
  assert.doesNotMatch(JSON.stringify(plan), /0x[a-f\d]{40}|Fe26|BEGIN.*PRIVATE|userSig|globalmpc\.tech|bnbchain\.org/i)
})
test('unmeasured, rejected and failed prerequisite cases never become passing results', () => {
  const samples = [{ id: 'JMX-03', status: 200, ok: true, durationMs: 15 }, { id: 'JMX-04', status: 401, ok: false, durationMs: 9 },
    { id: 'JMX-05', status: 500, ok: true, durationMs: 1 }]
  const rows = normalizeRecordedLoad(plan, { samples, errors: [] }, 'steps/recorded')
  assert.equal(rows.length, 45)
  assert.equal(rows.find(row => row.key === 'recorded:JMX-03').status, 'passed')
  assert.equal(rows.find(row => row.key === 'recorded:JMX-04').status, 'failed')
  assert.equal(rows.find(row => row.key === 'recorded:JMX-05').status, 'failed')
  assert.match(rows.find(row => row.key === 'recorded:JMX-14').title, /ready → \/my-mine\/claim\/self/)
  assert.equal(rows.find(row => row.key === 'recorded:JMX-20').status, 'blocked')
  assert.equal(rows.find(row => row.key === 'recorded:JMX-01').status, 'blocked')
  assert.ok(rows.every(row => row.durationMs === null || row.durationMs >= 0))
})
