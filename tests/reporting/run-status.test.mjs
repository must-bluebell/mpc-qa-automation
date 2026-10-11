import test from 'node:test'
import assert from 'node:assert/strict'
import { runStatus } from '../../pipeline/lib/run-status.mjs'

const row=(status,kind)=>({status,classification:{kind}})
test('skipped or blocked checks alone cannot pass a merged commit',()=>{
  assert.equal(runStatus({tests:[row('skipped')],steps:[]}), 'blocked')
  assert.equal(runStatus({tests:[row('blocked')],steps:[]}), 'blocked')
  assert.equal(runStatus({tests:[],steps:[]}), 'blocked')
})
test('runner failure cannot be hidden by passing assertions',()=>{
  const tests=[row('passed')]
  assert.equal(runStatus({tests,steps:[{exitCode:1}]}), 'infra-failed')
  assert.equal(runStatus({tests,steps:[{errors:['runner failed']}]}), 'infra-failed')
  assert.equal(runStatus({tests,steps:[{timedOut:true}]}), 'timeout')
  assert.equal(runStatus({tests,steps:[{exitCode:0,errors:[]}]}), 'passed')
})
test('explicit failures keep product and infrastructure classifications',()=>{
  assert.equal(runStatus({tests:[row('failed','product')],steps:[]}), 'failed')
  assert.equal(runStatus({tests:[row('failed','infrastructure')],steps:[]}), 'infra-failed')
})
test('every required step must execute assertions before a combined run can pass',()=>{
  const steps=[{name:'api',exitCode:0},{name:'wallet',exitCode:0}]
  const tests=[{...row('passed'),step:'api'},{...row('skipped'),step:'wallet'}]
  assert.equal(runStatus({tests,steps}), 'blocked')
  assert.equal(runStatus({tests:tests.slice(0,1),steps}), 'blocked')
  assert.equal(runStatus({tests:[tests[0],{...row('passed'),step:'wallet'}],steps}), 'passed')
})
