import test from 'node:test'
import assert from 'node:assert/strict'
import { answerQuestion } from '../../pipeline/slack-agent/answers.mjs'

const recorded={runId:'recorded-run',suite:'api',env:'local-docker',status:'passed',finishedAt:'2026-10-23T10:00:00Z',
  counts:{passed:1,failed:0,skipped:0,blocked:0},steps:[],tests:[{key:'api-ok',project:'api',status:'passed'}]}
const deps=(overrides={})=>({ai:true,environment:{},index:()=>[{runId:recorded.runId}],read:()=>recorded,
  explain:()=>{throw new Error('explain not stubbed')},...overrides})

test('QA-looking questions outside the fixed intents reach the AI QA path with recent runs',async()=>{
  let received
  const answer=await answerQuestion('how should we organize our test cases and fixtures?',deps({
    explain:async input=>{received=input;return {answer:'Group cases by feature; keep fixtures small.',runIds:[]}}}))
  assert.equal(received.general,true)
  assert.equal(received.runs.length,1)
  assert.match(answer,/^AI QA answer/)
  assert.match(answer,/Group cases by feature/)
  assert.doesNotMatch(answer,/Source:/)
})

test('general answers may cite only runs that were supplied',async()=>{
  const answer=await answerQuestion('are our flaky tests getting worse?',deps({
    explain:async()=>({answer:'Based on the run.',runIds:['invented-run']})}))
  assert.match(answer,/could not|unavailable/i)
  assert.doesNotMatch(answer,/invented-run/)
})

test('non-QA questions keep the help text and never call AI',async()=>{
  for(const question of ['tell me a joke','what is tomorrow’s weather?','hello there']){
    const answer=await answerQuestion(question,deps({explain:()=>{throw new Error('Non-QA must not invoke AI')}}))
    assert.match(answer,/Ask about/,question)
  }
})

test('QA questions get the help text when AI is disabled',async()=>{
  const answer=await answerQuestion('how should we structure our regression test suite?',deps({ai:false,
    explain:()=>{throw new Error('AI disabled must not invoke AI')}}))
  assert.match(answer,/Ask about/)
})

test('rerun grammar is unchanged by the general QA routing',async()=>{
  const answer=await answerQuestion('rerun api; echo test',deps({explain:()=>{throw new Error('Rerun must not invoke AI')}}))
  assert.match(answer,/Ask about|rerun/i)
})
