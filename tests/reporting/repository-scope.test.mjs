import test from 'node:test'
import assert from 'node:assert/strict'
import { runWebmpcStep } from '../../pipeline/adapters/webmpc-scenarios.mjs'
import { stackStatus, stackUp, stackDown } from '../../pipeline/adapters/local-stack.mjs'
import { examAnswers } from '../../pipeline/lib/test-data.mjs'
import { appVersion } from '../../pipeline/lib/versions.mjs'

function profile() {
  return { externalRepositoriesAllowed:false,baseUrl:'http://127.0.0.1:1',stack:{composeProject:'qa-scope',
    get webmpcPath(){throw new Error('External repository path was accessed')}} }
}

test('external scenarios are recorded as blocked before accessing another checkout',async()=>{
  const result=await runWebmpcStep({}, {env:profile()})
  assert.equal(result.tests.length,1)
  assert.equal(result.tests[0].status,'blocked')
  assert.match(result.tests[0].skipReason,/repository scope/i)
})

test('restricted scope refuses source imports and external stack lifecycle operations',async()=>{
  await assert.rejects(examAnswers(profile()),/repository scope/i)
  await assert.rejects(stackUp(profile()),/repository scope/i)
  await assert.rejects(stackDown(profile()),/repository scope/i)
})

test('application version does not inspect another checkout in restricted scope',async t=>{
  const previous=process.env.QA_VERSION
  process.env.QA_VERSION=''
  t.after(()=>{if(previous===undefined)delete process.env.QA_VERSION;else process.env.QA_VERSION=previous})
  const result=await appVersion(profile())
  assert.equal(result.source,'none')
})

test('stack health uses Docker metadata without reading another repository',async()=>{
  const calls=[]
  const result=await stackStatus(profile(),{execImpl:async(command,args,options)=>{
    calls.push({command,args,options})
    if(args[0]==='ps')return {stdout:'container-one\n'}
    return {stdout:JSON.stringify([...['web','postgres','neon-proxy','anvil','anvil-opbnb'].map(name=>({
      Config:{Labels:{'com.docker.compose.service':name}},State:{Status:'running',Health:{Status:'healthy'}},
    })),{Config:{Labels:{'com.docker.compose.service':'web','com.docker.compose.oneoff':'True'}},State:{Status:'exited'}}])}
  }})
  assert.equal(result.healthy,true)
  assert.equal(calls[0].command,'docker')
  assert.ok(calls[0].args.includes('label=com.docker.compose.project=qa-scope'))
  assert.equal(calls[0].options.cwd,undefined)
  assert.equal(calls[1].args[0],'inspect')
})
