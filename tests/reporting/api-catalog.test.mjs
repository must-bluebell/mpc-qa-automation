import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)))
const flatten = items => items.flatMap(item => item.item ? flatten(item.item) : [item])
test('catalog covers every supplied method/route exactly once', () => {
  const collection = flatten(read('../../testplans/api/unity.postman_collection.json').item)
  const catalog = read('../../testplans/api/contracts.json')
  assert.equal(collection.length, 171)
  assert.equal(catalog.length, 171)
  assert.deepEqual(catalog.map(c => `${c.method} ${c.route}`).sort(), collection.map(c => c.name).sort())
  assert.equal(new Set(catalog.map(c => c.id)).size, 171)
  for (const c of catalog) {
    assert.ok(c.source)
    assert.ok(c.baseline || c.blocked, `${c.id} must declare a contract or an explicit gap`)
    if (c.baseline) {
      validateExpected(c.baseline)
      assert.ok(Number.isInteger(c.baseline.status))
      assert.ok(c.baseline.error || c.baseline.fields || c.baseline.text !== undefined || c.baseline.contentType || c.baseline.empty || c.baseline.location, `${c.id}: body assertion missing`)
    }
  }
})

import { assertIsolatedTarget, validateExpected, loadApiCases } from '../../fixtures/api-case-config.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('sensitive API cases cannot run against a remote host or without the write flag', () => {
  for (const url of ['https://app.globalmpc.tech', 'https://localhost.example.com', 'https://localhost@evil.example']) {
    assert.throws(() => assertIsolatedTarget(url, '1'))
  }
  assert.throws(() => assertIsolatedTarget('http://localhost:3461', '0'))
  assert.doesNotThrow(() => assertIsolatedTarget('http://localhost:3461', '1'))
})
test('expectations cannot silently reduce to status-only smoke checks', () => {
  for (const invalid of [{ status: [200, 400] }, { status: 200 }, { status: 200, fields: {} }, { status: 200, text: '' }]) assert.throws(() => validateExpected(invalid))
  validateExpected({ status: 401, error: 'not_signed_in' })
  validateExpected({ status: 204, empty: true })
  validateExpected({ status: 200, fields: { registered: false } })
})
test('fixtures reject endpoint drift, redirects to other hosts, unresolved values and non-success statuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-cases-'))
  const path = join(dir, 'cases.json')
  const catalog = [{ id: 'API001', route: '/api/activities/[id]/status' }]
  const success = { auth: 'wallet', path: '/api/activities/123/status', expected: { status: 200, fields: { ok: true } } }
  try {
    for (const change of [{ path: '/\\evil.example/api/activities/123/status' }, { path: '/\tevil.example' }, { path: '//evil.example' }, { path: '/api/admin/admins' }, { path: '/api/activities/{{id}}/status' }, { body: { id: '{{id}}' } }, { expected: { status: 401, error: 'not_signed_in' } }]) {
      writeFileSync(path, JSON.stringify({ API001: { success: { ...success, ...change } } }))
      assert.throws(() => loadApiCases(path, catalog))
    }
    writeFileSync(path, JSON.stringify({ API001: { success } }))
    assert.deepEqual(loadApiCases(path, catalog).API001.success, success)
  } finally { rmSync(dir, { recursive: true }) }
})

test('hosted success policy permits only reviewed anonymous reads and keeps fixture overrides isolated', async () => {
  const { isHostedReadSuccess } = await import('../../fixtures/api-case-config.mjs')
  assert.equal(typeof isHostedReadSuccess, 'function')
  const contract = { id: 'API004', method: 'GET', route: '/api/auth/session' }
  const fixture = { auth: 'anonymous', path: '/api/auth/session', expected: { status: 200, fields: { address: null } } }
  assert.equal(isHostedReadSuccess(contract, fixture), true)
  for (const change of [{ method: 'POST' }, { route: '/api/cron/relay-sweep' }, { id: 'API999' }]) {
    assert.equal(isHostedReadSuccess({ ...contract, ...change }, fixture), false)
  }
  for (const change of [{ auth: 'wallet' }, { auth: 'admin' }, { auth: 'cron' }, { path: '/api/auth/session?refresh=1' }, { body: {} }, { headers: { cookie: 'session' } }, { storageStateEnv: 'ADMIN_STATE' }]) {
    assert.equal(isHostedReadSuccess(contract, { ...fixture, ...change }), false)
  }
  assert.equal(isHostedReadSuccess(contract, fixture, true), false)
  assert.equal(isHostedReadSuccess(contract, undefined), false)
  const catalog = read('../../testplans/api/contracts.json')
  for (const [id, path] of [['API092', '/api/home'], ['API138', '/api/quests'], ['API146', '/api/register/status'], ['API156', '/.well-known/security.txt'], ['API166', '/api/vote/proposals']]) {
    assert.equal(isHostedReadSuccess(catalog.find(c => c.id === id), { ...fixture, path }), true)
  }
})

test('hosted baseline policy permits only reviewed anonymous GET probes and keeps cron, dev and overrides isolated', async () => {
  const { isHostedReadBaseline } = await import('../../fixtures/api-case-config.mjs')
  const catalog = read('../../testplans/api/contracts.json')
  const allowed = catalog.filter(c => isHostedReadBaseline(c))
  assert.ok(allowed.length >= 40, `expected reviewed reads, got ${allowed.length}`)
  for (const c of allowed) {
    assert.equal(c.method, 'GET')
    assert.ok(c.baseline, `${c.id} needs a baseline`)
    assert.ok(!/^\/(api\/cron\/|dev\/)/.test(c.route), `${c.id} must stay isolated`)
    assert.equal(isHostedReadBaseline(c, true), false, `${c.id} configured override must stay isolated`)
  }
  const ids = new Set(allowed.map(c => c.id))
  for (const id of ['API101', 'API124', 'API094', 'API096', 'API158', 'API053']) assert.equal(ids.has(id), false, `${id} is an action or callback route`)
  for (const c of catalog.filter(c => c.method !== 'GET' || /^\/(api\/cron\/|dev\/)/.test(c.route))) assert.equal(isHostedReadBaseline(c), false, `${c.method} ${c.route} must stay isolated`)
})

test('production API writes require a per-run opt-in and the exact production origin', async()=>{
  const {assertApiWriteTarget}=await import('../../fixtures/api-case-config.mjs')
  assert.equal(typeof assertApiWriteTarget,'function')
  const authorization={productionApiWrites:true,environment:'production'}
  assert.doesNotThrow(()=>assertApiWriteTarget('https://app.globalmpc.tech','1',authorization))
  assert.doesNotThrow(()=>assertApiWriteTarget('http://localhost:3460','1',{}))
  for(const url of ['http://localhost:3460','https://app.globalmpc.tech.evil.test','http://app.globalmpc.tech','https://app.globalmpc.tech:8443','https://user@app.globalmpc.tech','https://app.globalmpc.tech/path','https://app.globalmpc.tech?x=1'])assert.throws(()=>assertApiWriteTarget(url,'1',authorization),url)
  for(const options of [{},{productionApiWrites:true,environment:'staging'},{productionApiWrites:false,environment:'production'}])assert.throws(()=>assertApiWriteTarget('https://app.globalmpc.tech','1',options))
  assert.throws(()=>assertApiWriteTarget('https://app.globalmpc.tech','0',authorization))
  // Arbitrary configured success fixtures still use the isolated-only guard.
  assert.throws(()=>assertIsolatedTarget('https://app.globalmpc.tech','1'))
})
