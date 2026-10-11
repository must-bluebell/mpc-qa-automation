import test from 'node:test'
import assert from 'node:assert/strict'
import { aiConfig, requestAnalysisWith } from '../../pipeline/ai/providers.mjs'
import { redactValue } from '../../pipeline/lib/safe-output.mjs'

const env={QA_AI_PROVIDER:'openclaw',QA_OPENCLAW_TOKEN:'gateway-test-token'}
const response=text=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]})})
test('OpenClaw requires its gateway credential independently of OpenAI keys',()=>{
  assert.equal(aiConfig({QA_AI_PROVIDER:'openclaw',OPENAI_API_KEY:'cloud-key',OPENAI_MODEL:'cloud-model'}).configured,false)
  const cfg=aiConfig(env)
  assert.equal(cfg.configured,true)
  assert.equal(cfg.provider,'openclaw')
  assert.equal(cfg.agent,'qa-review')
  assert.equal(cfg.baseUrl,'http://127.0.0.1:18789')
})
test('OpenClaw reviews use a stateless dedicated agent, no tools, and the schema in instructions',async()=>{
  const out=await requestAnalysisWith(aiConfig(env),{input:{run:{id:'r1'}},schema:{type:'object'},fetchImpl:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:18789/v1/responses')
    assert.equal(options.headers.Authorization,'Bearer gateway-test-token')
    assert.equal(options.redirect,'error')
    const body=JSON.parse(options.body)
    assert.equal(body.model,'openclaw/qa-review')
    assert.equal(body.tool_choice,'none')
    assert.deepEqual(body.tools,[])
    assert.equal(body.user,undefined)
    assert.equal(body.previous_response_id,undefined)
    assert.match(body.instructions,/untrusted data/)
    assert.match(body.instructions,/"type":"object"/)
    assert.deepEqual(JSON.parse(body.input),{run:{id:'r1'}})
    return response('{"summary":"review"}')
  }})
  assert.equal(out.summary,'review')
})
test('OpenClaw refuses unsafe URLs and invalid agent identifiers before sending credentials',async()=>{
  for(const overrides of [
    {baseUrl:'https://remote.example'}, {baseUrl:'http://localhost:18789@evil.example'},
    {baseUrl:'http://localhost:18789/path'}, {baseUrl:'http://localhost:18789?token=secret'},
    {baseUrl:'http://localhost:18789/#secret'}, {agent:'../main'},
  ]) {
    let called=false
    await assert.rejects(requestAnalysisWith({...aiConfig(env),...overrides},{input:{},schema:{},fetchImpl:async()=>{called=true}}),/OpenClaw/)
    assert.equal(called,false)
  }
})
test('failed, incomplete, tool-call and invalid JSON responses never become OpenClaw analysis',async()=>{
  for(const data of [
    {status:'incomplete',output:[]},
    {status:'completed',output:[{type:'function_call',name:'exec'}]},
    {status:'completed',output:[]},
  ])await assert.rejects(requestAnalysisWith(aiConfig(env),{input:{},schema:{},fetchImpl:async()=>({ok:true,json:async()=>data})}),/AI analysis/)
  await assert.rejects(requestAnalysisWith(aiConfig(env),{input:{},schema:{},fetchImpl:async()=>response('not JSON')}),/AI analysis/)
  await assert.rejects(requestAnalysisWith(aiConfig(env),{input:{},schema:{},fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:'secret diagnostic'})})}),/HTTP 401/)
  await assert.rejects(requestAnalysisWith(aiConfig(env),{input:{},schema:{},fetchImpl:async()=>{throw new Error('secret network diagnostic')}}),e=>!e.message.includes('secret')&&/OpenClaw/.test(e.message))
})
test('gateway tokens participate in evidence and output redaction',()=>{
  const prior=process.env.QA_OPENCLAW_TOKEN
  process.env.QA_OPENCLAW_TOKEN='private-gateway-credential-123'
  try {assert.equal(redactValue('Evidence includes private-gateway-credential-123'),'Evidence includes [REDACTED]')}
  finally {if(prior===undefined)delete process.env.QA_OPENCLAW_TOKEN;else process.env.QA_OPENCLAW_TOKEN=prior}
})
