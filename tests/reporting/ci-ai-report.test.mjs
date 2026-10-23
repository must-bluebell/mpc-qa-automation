import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { reviewCiRun, restoreCodexAuth } from '../../scripts/ci-ai-report.mjs'

const run = () => ({runId:'gh-123-1',suite:'regression',env:'local-docker',status:'failed',
  startedAt:'2026-10-20T00:00:00Z',finishedAt:'2026-10-20T00:01:00Z',versions:{app:{id:'a'.repeat(40)}},groups:[],
  tests:[{key:'one',title:'W01 - Display Trust Wallet and WalletConnect options',status:'failed',errors:[],annotations:[],adapter:'playwright',project:'chromium'}]})
const auth = JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'test-access',id_token:'test-id',refresh_token:'test-refresh'},last_refresh:'2026-10-22T00:00:00Z'})
async function temp(t) {
  const dir=await mkdtemp(join(tmpdir(),'ci-ai-test-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  return dir
}

test('CI restores only a valid managed ChatGPT login in a private fresh directory',async t=>{
  const home=join(await temp(t),'codex')
  await restoreCodexAuth(auth,home)
  assert.equal(JSON.parse(await readFile(join(home,'auth.json'),'utf8')).auth_mode,'chatgpt')
  assert.equal((await stat(home)).mode&0o777,0o700)
  assert.equal((await stat(join(home,'auth.json'))).mode&0o777,0o600)
  await assert.rejects(restoreCodexAuth(auth,home),/fresh/)
  for(const raw of ['{}','not JSON',JSON.stringify({auth_mode:'api',OPENAI_API_KEY:'private-key'})])
    await assert.rejects(restoreCodexAuth(raw,join(await temp(t),'codex')),/ChatGPT/)
})

test('missing subscription credentials produce a report without calling a model or losing failures',async t=>{
  let called=false
  const report=await reviewCiRun(run(),'gh-123-1',{dir:await temp(t),auth:'',persistConfigured:false,
    analyze:async()=>{called=true;throw new Error('must not run')}})
  assert.equal(called,false)
  assert.equal(report.status,'failed')
  assert.equal(report.counts.failed,1)
  assert.equal(report.ai.status,'not-configured')
})

test('a completed CI analysis survives validation and cannot promote an unknown finding',async t=>{
  const dir=await temp(t)
  for(const invented of [false,true]) {
    const home=join(dir,invented?'invalid-auth':'valid-auth')
    const report=await reviewCiRun(run(),'gh-123-1',{dir,auth,codexHome:home,persistConfigured:true,analyze:async saved=>({
      result:{status:'ok',provider:'codex-cli',model:'test-model'},
      review:{summary:'Review the failed assertion',findings:[{title:'Failure',classification:'confirmed',
        evidenceIds:[invented?'missing':'T1'],requirementIds:[],rationale:'Recorded assertion'}],duplicateGroups:[],scenarios:[]},
    })})
    assert.equal(report.status,'failed')
    assert.equal(report.ai.status,invented?'rejected':'ok')
    if(!invented)assert.equal(report.ai.review.findings[0].classification,'suspected')
  }
})

test('no executed tests never causes model analysis or a passing report',async t=>{
  const raw=run();raw.tests=[];raw.status='infra-failed'
  const report=await reviewCiRun(raw,'gh-123-1',{dir:await temp(t),analyze:()=>{throw new Error('must not run')}})
  assert.equal(report.status,'infra-failed')
  assert.notEqual(report.ai.status,'ok')
  await assert.rejects(reviewCiRun(raw,'gh-999-1',{dir:await temp(t)}),/metadata/)
})

test('the hosted CI command emits an infrastructure report when QA setup produced no artifact',async t=>{
  const dir=await temp(t)
  const command=fileURLToPath(new URL('../../scripts/ci-ai-report.mjs',import.meta.url))
  const result=await promisify(execFile)(process.execPath,[command,'missing-report.json','gh-123-1'],{
    cwd:dir,env:{...process.env,GITHUB_ACTIONS:'true',QA_EXPECTED_SUITE:'full',QA_APP_REF:'a'.repeat(40),CODEX_AUTH_JSON:''},
  }).then(()=>({code:0}),error=>({code:error.code,stdout:error.stdout,stderr:error.stderr}))
  assert.equal(result.code,1)
  const report=JSON.parse(await readFile(join(dir,'ci-review-report.json'),'utf8'))
  assert.equal(report.status,'infra-failed')
  assert.equal(report.tests.length,0)
  assert.equal(report.counts.passed,0)
  assert.notEqual(report.ai.status,'ok')
  assert.match(await readFile(join(dir,'ci-review-report.md'),'utf8'),/No accepted AI analysis/)
})
