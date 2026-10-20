import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { notifySavedRun } from '../../scripts/notify-saved-run.mjs'

test('separate Slack delivery saves a reporting error without changing test outcomes', async () => {
  const run={runId:'completed',status:'passed',finishedAt:'2026-10-20T00:00:00Z',counts:{passed:20}}
  let saved
  const ok=await notifySavedRun(run,{notify:async()=>{throw new Error('corrupt delivery state')},save:value=>{saved=value}})
  assert.equal(ok,false)
  assert.equal(saved.status,'passed')
  assert.equal(saved.counts.passed,20)
  assert.equal(saved.notifications[0].code,'notification_error')
})

test('corrupt Slack state cannot discard completed results or retain the pipeline lock', async () => {
  const dir=mkdtempSync(join(tmpdir(),'qa-finalization-'))
  writeFileSync(join(dir,'slack-bot-state.json'),'not JSON')
  const root=new URL('../../',import.meta.url).href
  const script=`
    import http from 'node:http';
    const server=http.createServer((req,res)=>{res.writeHead(503);res.end('{}')});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const {config}=await import(${JSON.stringify(root+'pipeline/lib/env.mjs')});
    config.suites=()=>({fixture:{steps:[]}});
    config.environments=()=>({fixture:{baseUrl:'http://127.0.0.1:'+server.address().port}});
    const {runPipeline}=await import(${JSON.stringify(root+'pipeline/orchestrator.mjs')});
    const {readRun}=await import(${JSON.stringify(root+'pipeline/lib/run-store.mjs')});
    const {readLock}=await import(${JSON.stringify(root+'pipeline/lib/lock.mjs')});
    try{await runPipeline({suite:'fixture',env:'fixture',runId:'notify-failure',ai:false,echo:false})}
    catch{console.log('pipeline threw')}
    const run=readRun('notify-failure');console.log(JSON.stringify({status:run?.status,notifications:run?.notifications,lock:readLock()}));
    server.close();
  `
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,QA_RUNS_DIR:dir,QA_AI_AUTO:'0',SLACK_BOT_TOKEN:'xoxb-test',SLACK_CHANNEL_ID:'C123'},timeout:15000,
  })
  const result=JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(result.status,'infra-failed')
  assert.equal(result.lock,null)
  assert.equal(result.notifications[0].code,'notification_error')
})
