import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareTestData, examAnswers } from '../../pipeline/lib/test-data.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../../pipeline/lib/env.mjs'
import { publicSummary } from '../../pipeline/lib/safe-output.mjs'

test('shared environments are never written to',async()=>{
  let called=false
  const result=await prepareTestData({isolated:false,allowWrites:false,baseUrl:'https://staging.example'},{fetchImpl:async()=>{called=true}})
  assert.equal(result.status,'skipped'); assert.equal(called,false)
})
test('exam source loads with the target chain without changing the parent environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-exam-'))
  const previous = process.env.NEXT_PUBLIC_CHAIN_ID
  try {
    mkdirSync(join(root, 'src/modules/my-mine/glossary'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    // Use the installed application loader; the source fixture reproduces its fail-loud chain guard.
    const { symlinkSync } = await import('node:fs')
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'))
    writeFileSync(join(root, 'src/modules/my-mine/glossary/text.ts'), `
      if (process.env.NEXT_PUBLIC_CHAIN_ID !== '97') throw new Error('Wrong exam chain')
      export const WAY_QUIZ = [{ a: 2 }, { a: 0 }]
    `)
    process.env.NEXT_PUBLIC_CHAIN_ID = '56'
    assert.deepEqual(await examAnswers({ chainId: 97, stack: { webmpcPath: root } }), [2, 0])
    assert.equal(process.env.NEXT_PUBLIC_CHAIN_ID, '56')
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CHAIN_ID
    else process.env.NEXT_PUBLIC_CHAIN_ID = previous
    rmSync(root, { recursive: true, force: true })
  }
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
