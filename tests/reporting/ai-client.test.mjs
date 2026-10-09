import test from 'node:test'
import assert from 'node:assert/strict'
import { requestAnalysis } from '../../utils/ai-client.mjs'

test('requires local model configuration without making a request', async () => {
 let called=false
 await assert.rejects(requestAnalysis({input:{},schema:{},fetchImpl:()=>{called=true}}),/Configure/)
 assert.equal(called,false)
})
test('uses structured output and disables response storage', async () => {
 let payload
 const output=await requestAnalysis({key:'fake-key',model:'configured-model',input:{findings:[]},schema:{type:'object'},fetchImpl:async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses')
  payload=JSON.parse(options.body)
  return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:'{"summary":"review"}'}]}]})}
 }})
 assert.equal(output.summary,'review')
 assert.equal(payload.store,false)
 assert.equal(payload.text.format.strict,true)
 assert.equal(payload.text.format.type,'json_schema')
})
test('API errors and incomplete responses do not become analysis results', async()=>{
 await assert.rejects(requestAnalysis({key:'fake',model:'model',input:{},schema:{},fetchImpl:async()=>({ok:false,status:429})}),/HTTP 429/)
 await assert.rejects(requestAnalysis({key:'fake',model:'model',input:{},schema:{},fetchImpl:async()=>({ok:true,json:async()=>({status:'incomplete'})})}),/incomplete/)
})
