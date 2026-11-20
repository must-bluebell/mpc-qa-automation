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
    for (const expected of [...Object.values(c.baselineByEnvironment ?? {}), ...Object.values(c.originByEnvironment ?? {})]) validateExpected(expected)
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

test('admin login checks the production CAPTCHA rejection contract without weakening local credential assertions', async()=>{
  const {baselineForEnvironment}=await import('../../fixtures/api-case-config.mjs')
  assert.equal(typeof baselineForEnvironment,'function')
  const login=read('../../testplans/api/contracts.json').find(c=>c.id==='API023')
  assert.deepEqual(baselineForEnvironment(login,'production'),{status:403,error:'verification_failed'})
  assert.deepEqual(baselineForEnvironment(login,'local-docker'),{status:401,error:'bad_credentials'})
  assert.deepEqual(baselineForEnvironment(login,'preview'),{status:401,error:'bad_credentials'})
  assert.deepEqual(baselineForEnvironment(login,'production',{status:503,error:'verification_unavailable'}),{status:503,error:'verification_unavailable'})
})

test('disabled production bridge routes assert the feature gate before authentication and origin checks',async()=>{
  const {baselineForEnvironment,originForEnvironment}=await import('../../fixtures/api-case-config.mjs')
  assert.equal(typeof originForEnvironment,'function')
  const catalog=read('../../testplans/api/contracts.json')
  for(const id of ['API079','API080','API081','API083']){
    const contract=catalog.find(c=>c.id===id)
    assert.deepEqual(baselineForEnvironment(contract,'production'),{status:404,text:'Not found'})
    assert.deepEqual(originForEnvironment(contract,'production'),{status:404,text:'Not found'})
    assert.deepEqual(originForEnvironment(contract,'local-docker'),{status:403,error:'cross_origin'})
  }
})

test('API response diagnostics retain short machine error codes without arbitrary payloads',async()=>{
  const {apiErrorCode}=await import('../../fixtures/api-case-config.mjs')
  assert.equal(typeof apiErrorCode,'function')
  assert.equal(apiErrorCode({error:'recovery_changed'}),'recovery_changed')
  for(const body of [{error:'customer email@example.com'},{error:'Bearer private-token'},{error:'0x'+'a'.repeat(40)},{error:'x'.repeat(100)},{error:{secret:'value'}},null])assert.equal(apiErrorCode(body),null)
})

test('Mine API requests carry the supplied collection protocol and preserve explicit negative-test headers',async()=>{
  const {apiProtocolHeaders}=await import('../../fixtures/api-case-config.mjs')
  const collection=read('../../testplans/api/unity.postman_collection.json')
  const protocol=collection.variable.find(v=>v.key==='runProtocol').value
  for(const item of flatten(collection.item)) {
    const usesProtocol=item.request.header?.some(h=>h.key==='x-mpc-run-protocol')
    const path='/'+item.request.url.path.join('/')
    if(usesProtocol)assert.deepEqual(apiProtocolHeaders(path,{},'local-docker'),{'x-mpc-run-protocol':protocol})
  }
  assert.deepEqual(apiProtocolHeaders('/my-mine/run?record=0',{},'local-docker'),{'x-mpc-run-protocol':protocol})
  assert.deepEqual(apiProtocolHeaders('/my-mine/run',{},'production'),{'x-mpc-run-protocol':'9'})
  assert.deepEqual(apiProtocolHeaders('/api/auth/verify'),{})
  assert.deepEqual(apiProtocolHeaders('/my-mine/run',{'x-mpc-run-protocol':'invalid'}),{'x-mpc-run-protocol':'invalid'})
})

test('production funding helper stays unavailable and word authorization probes use a well-formed body',async()=>{
  const {baselineForEnvironment}=await import('../../fixtures/api-case-config.mjs')
  const catalog=read('../../testplans/api/contracts.json')
  const dev=catalog.find(c=>c.id==='API077')
  assert.deepEqual(baselineForEnvironment(dev,'production'),{status:404,empty:true})
  assert.deepEqual(baselineForEnvironment(dev,'local-docker'),{status:401,error:'not_signed_in'})
  const word=catalog.find(c=>c.id==='API169')
  assert.deepEqual(word.body,{day:0,attempt:0,word:'apple'})
  assert.deepEqual(word.baseline,{status:401,error:'not_signed_in'})
})

test('newer production source enables bounded rejection contracts without live transaction fixtures',async()=>{
  const {baselineForEnvironment}=await import('../../fixtures/api-case-config.mjs')
  const catalog=read('../../testplans/api/contracts.json')
  for(const id of ['API047','API048'])assert.deepEqual(baselineForEnvironment(catalog.find(c=>c.id===id),'production'),{status:404,error:'not_found'})
  for(const id of ['API049','API050'])assert.deepEqual(baselineForEnvironment(catalog.find(c=>c.id===id),'production'),{status:401,error:'sign_in_required'})
  for(const id of ['API151','API152','API153','API154'])assert.deepEqual(baselineForEnvironment(catalog.find(c=>c.id===id),'production'),{status:401,error:'not_signed_in'})
  for(const id of ['API055','API056'])assert.deepEqual(baselineForEnvironment(catalog.find(c=>c.id===id),'production'),{status:400,text:'This reminder link is invalid.',contentType:'text/html'})
  for(const id of ['API075','API076'])assert.deepEqual(baselineForEnvironment(catalog.find(c=>c.id===id),'production'),{status:404,empty:true})
  const word=catalog.find(c=>c.id==='API169')
  assert.deepEqual(word.body,{day:0,attempt:0,word:'apple'})
  assert.deepEqual(baselineForEnvironment(word,'production'),{status:409,error:'day_changed'})
  assert.deepEqual(baselineForEnvironment(word,'local-docker'),{status:401,error:'not_signed_in'})
  assert.equal(word.originCheck,true)
  assert.deepEqual(baselineForEnvironment(catalog.find(c=>c.id==='API145'),'production'),{status:403,error:'otp_required'})
  assert.deepEqual(baselineForEnvironment(catalog.find(c=>c.id==='API126'),'production'),{status:200,types:{live:'array',planned:'array',sender:'string|null'}})
})
