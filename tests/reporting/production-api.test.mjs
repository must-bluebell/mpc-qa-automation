import test from 'node:test'
import assert from 'node:assert/strict'
import {guard,expandSuite} from '../../pipeline/orchestrator.mjs'
import {resolveEnvironment} from '../../pipeline/lib/env.mjs'
import * as adapter from '../../pipeline/adapters/playwright.mjs'

test('production API opt-in is rejected for other environments, hosts or suites without API steps',()=>{
  const env=resolveEnvironment('production'),steps=expandSuite('api')
  assert.doesNotThrow(()=>guard({suiteName:'api',env,steps,productionApiWrites:true}))
  for(const other of [{...env,name:'staging'},{...env,baseUrl:'https://other.example'},{...env,baseUrl:'http://localhost:3460'},resolveEnvironment('local-docker')])assert.throws(()=>guard({suiteName:'api',env:other,steps,productionApiWrites:true}))
  assert.throws(()=>guard({suiteName:'regression',env,steps:expandSuite('regression'),productionApiWrites:true}))
  assert.throws(()=>guard({suiteName:'api',env,steps,productionApiWrites:'true'}))
})

test('production write authorization reaches only API workers and never leaks to default or browser runs',()=>{
  assert.equal(typeof adapter.apiWriteEnvironment,'function')
  const ctx={env:resolveEnvironment('production'),productionApiWrites:true}
  assert.deepEqual(adapter.apiWriteEnvironment({project:'api'},ctx),{QA_ALLOW_WRITES:'1',QA_PRODUCTION_API_WRITES:'1'})
  assert.deepEqual(adapter.apiWriteEnvironment({project:'chromium'},ctx),{QA_ALLOW_WRITES:'0',QA_PRODUCTION_API_WRITES:'0'})
  assert.deepEqual(adapter.apiWriteEnvironment({project:'api'},{...ctx,productionApiWrites:false}),{QA_ALLOW_WRITES:'0',QA_PRODUCTION_API_WRITES:'0'})
  assert.deepEqual(adapter.apiWriteEnvironment({project:'api'},{env:resolveEnvironment('local-docker')}),{QA_ALLOW_WRITES:'1',QA_PRODUCTION_API_WRITES:'0'})
})
