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
