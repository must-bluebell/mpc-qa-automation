import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeCiRun } from '../../pipeline/lib/ci-report.mjs'
import { publicSummary } from '../../pipeline/lib/safe-output.mjs'

const fixture = () => ({
  runId:'gh-123-1',suite:'regression',env:'local-docker',status:'passed',
  startedAt:'2026-10-20T00:00:00Z',finishedAt:'2026-10-20T00:01:00Z',durationMs:60000,
  versions:{app:{id:'abcdef123'}},counts:{passed:1,failed:0,skipped:0,blocked:0},groups:[],
  tests:[{key:'case',title:'W01 - Display Trust Wallet and WalletConnect options',status:'passed',adapter:'playwright',project:'chromium',annotations:[],errors:[]}],
})

test('CI artifact export and trusted revalidation preserve cases without raw data', () => {
  const raw=fixture()
  raw.tests.push({...raw.tests[0],key:'private-case',title:'private customer-specific text',status:'skipped',errors:['private failure details'],evidence:[{path:'/private/trace.zip'}]})
  const exported=sanitizeCiRun(raw,'gh-123-1')
  const received=sanitizeCiRun(exported,'gh-123-1',{suite:'regression'})
  assert.equal(received.tests.length,2)
  assert.equal(received.counts.passed,1)
  assert.equal(received.counts.skipped,1)
  assert.equal(received.tests[0].title,raw.tests[0].title)
  assert.doesNotMatch(JSON.stringify(exported)+JSON.stringify(received),/private customer|private failure|trace\.zip/)
})

test('downloaded reports cannot select another run, suite, environment or contradictory status', () => {
  assert.throws(()=>sanitizeCiRun({...fixture(),runId:'../../secret'},'gh-123-1'))
  assert.throws(()=>sanitizeCiRun(fixture(),'gh-123-1',{suite:'full'}))
  assert.throws(()=>sanitizeCiRun({...fixture(),env:'production'},'gh-123-1'))
  const wrong=fixture();wrong.tests[0].status='failed'
  assert.throws(()=>sanitizeCiRun(wrong,'gh-123-1'),/contradicts/)
})

test('double sanitization preserves missing and unhealthy Docker services', () => {
  const raw=fixture();raw.status='infra-failed'
  raw.health={ok:false,status:503,stack:{healthy:false,services:[{service:'postgres',state:'running',health:'unhealthy'}],missingServices:['web','anvil','anvil-opbnb','neon-proxy','pgbouncer'],unhealthyServices:['postgres']}}
  const received=sanitizeCiRun(sanitizeCiRun(raw,'gh-123-1'),'gh-123-1')
  assert.ok(received.health.stack.missingServices.includes('web'))
  assert.deepEqual(received.health.stack.unhealthyServices,['postgres'])
  assert.equal(received.health.stack.healthy,false)
  assert.ok(publicSummary(received).pipeline.environment.stack.unhealthy>0)
})
