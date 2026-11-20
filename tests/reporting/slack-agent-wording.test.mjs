import test from 'node:test'
import assert from 'node:assert/strict'
import { answerQuestion, parseRequest } from '../../pipeline/slack-agent/answers.mjs'

const recorded={runId:'recorded-run',suite:'api',env:'local-docker',status:'passed',finishedAt:'2026-10-23T10:00:00Z',
  counts:{passed:1,failed:0,skipped:0,blocked:0},steps:[],tests:[{key:'api-ok',project:'api',status:'passed'}]}
const options={ai:true,environment:{QA_SLACK_PR_REPOSITORY:'globalmpc/mpc-automation'},
  index:()=>[{runId:recorded.runId}],read:()=>recorded,scheduler:()=>({stale:false}),
  schedules:()=>({timezone:'Asia/Karachi',schedules:[{enabled:true,suite:'api',cron:'0 1 * * *'}]}),
  prEvidence:async kind=>`Recorded ${kind} PR evidence`,
  explain:()=>{throw new Error('A factual wording variation must not invoke AI')}}
const groups=[
  ['capabilities','what are your capabilities?',[
    'Hello <@UAPP>, could you introduce yourself?', 'What is your role?', 'Tell me about yourself',
    'How can you help me?', 'Which tests do you support?', 'What can the MPC QA agent do?',
    'Can you explain your capabilties?', 'hey, what are your abilities?',
    'WHAT’S YOUR PURPOSE?', 'what you can do and which repos you can access?',
    'What are you able to do?', 'Describe the agent role',
  ]],
  ['repositories','which repos can you access?',[
    'What repositories are you connected to?', 'Which repository do you test?',
    'Tell me your repo permissions', 'what is your repository scope?',
  ]],
  ['latest','show latest results',[
    'Hello <@UAPP>, any testing updates?', 'How did the tests go?', 'Show me the QA summary please',
    'What is the outcome of the checks?', 'Can I see the most recent test results?',
    'Show the most recent test run results please',
  ]],
  ['failures','what failed?',[
    'Which cases are failing?', 'Show broken tests', 'Any test failures?', 'List unsuccessful checks',
  ]],
  ['last-pass','when did tests last pass?',[
    'When were the tests last green?', 'Show the most recent successful run', 'What was the previous passing run?',
  ]],
  ['evidence','show evidence',[
    'Please share the test report', 'Can I see screenshots and traces?', 'Show the report please',
  ]],
  ['schedule','what is the testing schedule?',[
    'When is the next test run?', 'What time do the checks run?', 'Tell me the test timetable',
  ]],
  ['scheduler','is the scheduler running?',[
    'Is scheduling active?', 'Has the scheduler stopped?',
  ]],
  ['pr-tested','show last tested PR',[
    'Which pull-request was checked most recently?', 'Name the PR you verified', 'latest tested pull request please',
  ]],
  ['pr-merged','show last merged PR',[
    'Who landed the code?', 'Which pull request was integrated last?', 'How did the PR get merged?',
  ]],
]
for(const [kind,canonical,questions] of groups)test(`${kind} wording variations return the same factual answer`,async()=>{
  const expected=await answerQuestion(canonical,options)
  for(const question of questions){
    assert.equal(parseRequest(question).kind,kind,question)
    assert.equal(await answerQuestion(question,options),expected,question)
  }
})

test('suite wording and polite report requests preserve scope without inventing a run ID',()=>{
  for(const [question,suite] of [['latest endpoint test results','api'],['how did acceptance testing go?','uat'],
    ['latest performance results','load'],['how did the UI tests go?','regression']])
    assert.equal(parseRequest(question).suite,suite,question)
  assert.equal(parseRequest('show the report please').runId,null)
  assert.equal(parseRequest('when did the API test run last pass?').kind,'last-pass')
  assert.equal(parseRequest('show report missing-run').runId,'missing-run')
})

test('unrecognized questions get QA guidance without borrowing evidence or invoking AI',async()=>{
  for(const question of ['tell me a joke','what is tomorrow’s weather?', 'hello there']){
    const answer=await answerQuestion(question,{ai:true,
      index:()=>{throw new Error('Unknown question must not consult test history')},
      explain:()=>{throw new Error('Unknown question must not invoke AI')}})
    assert.match(answer,/Ask about/)
    assert.doesNotMatch(answer,/Advisory|Source:/)
  }
})

test('wording flexibility does not turn conversational text or shell fragments into rerun commands',()=>{
  for(const question of ['could you run API tests please','rerun api; echo test','rerun api && curl evil',
    'tell me your capabilities then rerun full'])assert.notEqual(parseRequest(question).kind,'rerun')
  assert.deepEqual(parseRequest('<@UAPP> rerun api'),{kind:'rerun',suite:'api',env:'local-docker'})
})
