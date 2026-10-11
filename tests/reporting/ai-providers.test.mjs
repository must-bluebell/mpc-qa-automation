import test from 'node:test'
import assert from 'node:assert/strict'
import { aiConfig, requestAnalysisWith } from '../../pipeline/ai/providers.mjs'

test('local Ollama analysis needs no API key', () => {
  const cfg=aiConfig({QA_AI_PROVIDER:'ollama'})
  assert.equal(cfg.configured,true)
  assert.equal(cfg.model,'gpt-oss:20b')
  assert.equal(cfg.baseUrl,'http://127.0.0.1:11434')
  assert.equal(cfg.key,undefined)
})
test('Ollama receives schema and instructions without authorization',async()=>{
  const cfg=aiConfig({QA_AI_PROVIDER:'ollama',QA_AI_MODEL:'local-test'})
  const out=await requestAnalysisWith(cfg,{input:{findings:[]},schema:{type:'object'},fetchImpl:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:11434/api/chat')
    assert.equal(options.headers.Authorization,undefined)
    assert.equal(options.redirect,'error')
    const payload=JSON.parse(options.body)
    assert.equal(payload.model,'local-test')
    assert.equal(payload.stream,false)
    assert.deepEqual(payload.format,{type:'object'})
    assert.match(payload.messages[0].content,/untrusted data/)
    return {ok:true,json:async()=>({done:true,done_reason:'stop',message:{content:'{"summary":"local review"}'}})}
  }})
  assert.equal(out.summary,'local review')
})
test('local provider refuses remote endpoints before sending evidence',async()=>{
  for(const baseUrl of ['https://example.com','http://127.0.0.1:11434@evil.example','http://localhost:11434/?secret=x']) {
    let called=false
    await assert.rejects(requestAnalysisWith({provider:'ollama',configured:true,model:'local',baseUrl},{
      input:{},schema:{},fetchImpl:async()=>{called=true},
    }),/loopback/)
    assert.equal(called,false)
  }
})
test('unavailable, incomplete and invalid local responses never become analysis',async()=>{
  const cfg=aiConfig({QA_AI_PROVIDER:'ollama'})
  for(const data of [{done:false,message:{content:'{}'}},{done:true,done_reason:'length',message:{content:'{}'}},{done:true,message:{content:'not JSON'}},{done:true,message:{content:''}}])
    await assert.rejects(requestAnalysisWith(cfg,{input:{},schema:{},fetchImpl:async()=>({ok:true,json:async()=>data})}),/AI analysis/)
  await assert.rejects(requestAnalysisWith(cfg,{input:{},schema:{},fetchImpl:async()=>({ok:false,status:404})}),/HTTP 404/)
})
test('unknown providers fail closed and existing cloud configuration remains explicit',()=>{
  assert.equal(aiConfig({QA_AI_PROVIDER:'typo',OPENAI_API_KEY:'fake',OPENAI_MODEL:'model'}).configured,false)
  assert.equal(aiConfig({QA_AI_PROVIDER:'openai',OPENAI_API_KEY:'fake',OPENAI_MODEL:'model'}).provider,'openai')
})
