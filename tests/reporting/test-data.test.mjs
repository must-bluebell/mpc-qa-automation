import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareTestData } from '../../pipeline/lib/test-data.mjs'
import { publicSummary } from '../../pipeline/lib/safe-output.mjs'

test('shared environments are never written to',async()=>{
  let called=false
  const result=await prepareTestData({isolated:false,allowWrites:false,baseUrl:'https://staging.example'},{fetchImpl:async()=>{called=true}})
  assert.equal(result.status,'skipped'); assert.equal(called,false)
})
test('non-loopback or wrong-chain RPC fails preparation instead of funding',async()=>{
  const prev=process.env.QA_SEED_PHRASE,prevAddr=process.env.WALLET_ADDRESS
  process.env.QA_SEED_PHRASE='test test test test test test test test test test test junk'; delete process.env.WALLET_ADDRESS
  try {
    const result=await prepareTestData({isolated:true,allowWrites:true,baseUrl:'http://127.0.0.1:1',stack:{ports:{anvil:1,opbnbAnvil:2}}})
    assert.equal(result.status,'failed')
    assert.ok(!result.steps.some(s=>s.name.startsWith('funding')))
  } finally { process.env.QA_SEED_PHRASE=prev; if(prevAddr)process.env.WALLET_ADDRESS=prevAddr }
})
test('published test-data stage carries step names and statuses only',()=>{
  const run={runId:'r1',suite:'regression',env:'local-docker',status:'passed',finishedAt:'2026-10-09T10:00:00Z',tests:[],counts:{},versions:{app:{id:'v'}},
    testData:{status:'failed',steps:[{name:'preparation',status:'failed',detail:'RPC http://127.0.0.1:8556 for 0xe46d2a8c9ae04517373b8c9c468dfa5db2d381df'}]}}
  const td=publicSummary(run).pipeline.environment.testData
  assert.deepEqual(td,{status:'failed',steps:[{name:'preparation',status:'failed'}]})
  assert.doesNotMatch(JSON.stringify(td),/0xe46d|8556/)
})
