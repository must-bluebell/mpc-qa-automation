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


test('a timeout takes precedence over assertions recorded before interruption',()=>{
  for(const kind of ['product','infrastructure']) {
    assert.equal(runStatus({tests:[row('failed',kind)],steps:[{timedOut:true,exitCode:null}]}),'timeout')
  }
})

test('failed test-data preparation cannot be hidden by passing assertions',()=>{
  const tests=[row('passed')],steps=[{exitCode:0,errors:[]}]
  assert.equal(runStatus({tests,steps,testData:{status:'failed'}}),'infra-failed')
  for(const status of ['ready','skipped'])assert.equal(runStatus({tests,steps,testData:{status}}),'passed')
  assert.equal(runStatus({tests:[row('failed','product')],steps,testData:{status:'failed'}}),'failed')
  assert.equal(runStatus({tests,steps:[{timedOut:true}],testData:{status:'failed'}}),'timeout')
})

test('failed preparation never announces infrastructure recovery even when assertions execute',async()=>{
  const {executionRecovered}=await import('../../pipeline/lib/run-status.mjs')
  for(const status of ['passed','failed']){
    const run={status,tests:[row('passed')],steps:[],errors:[],testData:{status:'failed'}}
    assert.equal(executionRecovered(run),false)
    assert.equal(executionRecovered({...run,testData:{status:'ready'}}),true)
  }
})

test('passing checks cannot hide blocked prerequisites in the same step',()=>{
  assert.equal(runStatus({tests:[row('passed'),row('blocked')],steps:[]}), 'blocked')
  assert.equal(runStatus({tests:[row('passed'),row('skipped')],steps:[]}), 'passed')
})
