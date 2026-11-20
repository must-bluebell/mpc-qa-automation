import test from 'node:test'
import assert from 'node:assert/strict'
import { publicSummary } from '../../pipeline/lib/safe-output.mjs'
import { evaluateStackHealth } from '../../pipeline/adapters/local-stack.mjs'
import { normalizeRecord } from '../../pipeline/adapters/playwright.mjs'

test('a stack without the web service is unhealthy',()=>{
  const services=['anvil','anvil-opbnb','postgres','neon-proxy'].map(service=>({service,state:'running',health:'healthy'}))
  const status=evaluateStackHealth(services)
  assert.equal(status.healthy,false)
  assert.deepEqual(status.missingServices,['web'])
  assert.equal(evaluateStackHealth([...services,{service:'web',state:'running',health:'healthy'}]).healthy,true)
})
test('published failures have readable test names and specific sanitized reasons',()=>{
  const s=publicSummary({runId:'test',suite:'regression',env:'local-docker',status:'failed',finishedAt:'2026-10-09T08:00:00Z',tests:[
    {key:'w04',title:'wallet/wallet-errors.spec.ts > Wallet connection errors > W04 - Explain failed wallet connection: rejected request',status:'failed',errors:["TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n - waiting for getByRole('main', { name: 'Home', exact: true }).getByRole('button', { name: 'Join Unity', exact: true })"]},
    {key:'w01',title:'W01 - Display Trust Wallet and WalletConnect options',status:'failed',errors:['Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3410/?token=private']}
  ]})
  assert.equal(s.checks[0].name,'W04 - Explain failed wallet connection: rejected request')
  assert.match(s.checks[0].reason,/Join Unity/)
  assert.match(s.checks[1].reason,/unreachable/i)
  assert.doesNotMatch(JSON.stringify(s),/token=private/)
})
test('unreachable dependencies count as blocked instead of an intentional skip',()=>{
  const record={title:'chromium > W17 - Explain failed message signing: locked wallet',status:'skipped',outcome:'skipped',annotations:[{type:'skip',description:'could not reach local app: ECONNREFUSED'}],errors:[]}
  const normalized=normalizeRecord(record,{evidenceBase:'step'})
  assert.equal(normalized.status,'blocked')
  assert.match(normalized.skipReason,/ECONNREFUSED/)
})

test('unknown test titles and arbitrary diagnostic data remain private',()=>{
  const s=publicSummary({runId:'privacy',finishedAt:'2026-10-09T08:00:00Z',tests:[{key:'private',title:'Customer account 778899 phone 03001234567',status:'failed',errors:['recovery words alpha bravo charlie; customer balance 12345']}]})
  assert.doesNotMatch(JSON.stringify(s),/778899|03001234567|alpha bravo|12345/)
})
test('load rates retain precision until percentage formatting',()=>{
  const s=publicSummary({runId:'precision',finishedAt:'2026-10-09T08:00:00Z',load:{checkPassRate:0.996,endpoints:{'POST /api/auth/nonce':{errorRate:0.004,p95Ms:12.345}}}})
  assert.equal(s.loadMetrics.checkPassRate,0.996)
  assert.equal(s.loadMetrics.endpoints.find(e=>e.name==='POST /api/auth/nonce').errorRate,0.004)
})

test('missing isolated environments and fixtures are blocked, while unavailable optional features remain skipped',()=>{
  for (const reason of [
    'Expanded API cases require the isolated QA_ALLOW_WRITES=1 environment.',
    'Write checks run only on an isolated environment (QA_ALLOW_WRITES=1).',
    'Requires QA_API_CASES_FILE entry API001.success with seeded inputs and an exact response contract.',
    'Requires an isolated administrator storageState file in QA_API_ADMIN_STATE_FILE',
    'Requires isolated QA_API_CRON_SECRET',
    'Configured API success fixtures require an isolated target.',
    'API write checks require an isolated target or an explicitly authorized production API run.',
    'Requires matching source or explicit environment contract; snapshot omits the response or configuration gate.',
    'Join policy runs before authentication. Configure baseline 401/not_signed_in when skipEmailOtp=true, otherwise 403/otp_required.',
  ]) {
    const record={title:'api > API001',status:'skipped',outcome:'skipped',annotations:[{type:'skip',description:reason}],errors:[]}
    const item=normalizeRecord(record,{evidenceBase:'step'})
    assert.equal(item.status,'blocked',reason)
    const summary=publicSummary({runId:'blocked',finishedAt:'2026-11-20T00:00:00Z',tests:[item]})
    assert.doesNotMatch(summary.checks[0].reason,/private local execution evidence/)
  }
  assert.equal(normalizeRecord({title:'api > optional',status:'skipped',outcome:'skipped',annotations:[{type:'skip',description:'My Mine is not open on this deployment (404).'}]},{evidenceBase:'step'}).status,'skipped')
})

test('expanded API checks publish catalog names without leaking arbitrary titles',()=>{
  const titles=[
    'API001 POST /api/auth/activity — baseline contract',
    'API001 POST /api/auth/activity — successful fixture contract',
    'API088-V1 GET /api/energy/history?page=invalid rejects bad_page',
    'API012 PATCH /api/admin/admins/invalid rejects invalid input after admin authentication',
    'FLOW01 — two wallet sessions remain independent after logout',
  ]
  const s=publicSummary({runId:'catalog',finishedAt:'2026-11-20T00:00:00Z',tests:titles.map((title,i)=>({key:String(i),title,status:'blocked'}))})
  for(const check of s.checks)assert.doesNotMatch(check.name,/^Check /)
  assert.match(s.checks[0].name,/API001.*POST.*\/api\/auth\/activity.*baseline contract/)
  const privateSummary=publicSummary({runId:'privacy',finishedAt:'2026-11-20T00:00:00Z',tests:[{key:'secret',title:'API001 POST /private/customer-secret — baseline contract',status:'blocked'}]})
  assert.doesNotMatch(JSON.stringify(privateSummary),/customer-secret/)
})
