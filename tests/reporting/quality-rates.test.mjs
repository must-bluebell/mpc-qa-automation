import test from 'node:test'
import assert from 'node:assert/strict'
import { qualityRates } from '../../pipeline/lib/quality-rates.mjs'
import { publicSummary } from '../../pipeline/lib/safe-output.mjs'

test('test pass rate excludes unexecuted checks and reports execution coverage separately', () => {
  assert.deepEqual(qualityRates({passed:3,failed:1,skipped:2,blocked:2}), {
    executed:4,total:8,passRate:75,executionRate:50,
  })
})
test('no executed checks has no passing percentage', () => {
  assert.equal(qualityRates({skipped:3}).passRate,null)
  assert.equal(qualityRates({}).executionRate,null)
})
test('published report provides overall and category rates', () => {
  const s=publicSummary({runId:'quality',suite:'full',env:'local-docker',status:'failed',finishedAt:'2026-10-10T00:00:00Z',
    counts:{passed:1,failed:1,skipped:1},tests:[
      {key:'api1',adapter:'playwright',project:'api',status:'passed'},
      {key:'uat1',adapter:'webmpc-scenarios',status:'failed'},
      {key:'web1',adapter:'playwright',project:'chromium',status:'skipped'},
    ]})
  assert.equal(s.quality.passRate,50)
  assert.equal(s.categoryRates.find(r=>r.category==='UAT scenarios').passRate,0)
  assert.equal(s.categoryRates.find(r=>r.category==='Web automation regression testing').passRate,null)
})
