import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'

test('reporter checkpoints every discovered case and completed result before a worker is killed', async t => {
  const dir=mkdtempSync(join(tmpdir(),'qa-interrupted-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  writeFileSync(join(dir,'test.spec.cjs'),`const {test,expect}=require(${JSON.stringify(resolve('node_modules/@playwright/test'))});
    test('finished assertion',()=>expect(2+2).toBe(4));
    test('interrupted assertion',async()=>{console.log('WAITING_FOR_KILL');await new Promise(()=>{});});
    test('never started',()=>{});`)
  writeFileSync(join(dir,'playwright.config.cjs'),`module.exports={testDir:__dirname,workers:1,retries:0,reporter:[[${JSON.stringify(resolve('utils/regression-reporter.ts'))}]]};`)
  const child=spawn(process.execPath,[resolve('node_modules/@playwright/test/cli.js'),'test','--config',join(dir,'playwright.config.cjs')],{env:{...process.env,QA_REPORT_DIR:dir},stdio:['ignore','pipe','pipe'],detached:true})
  const closed=new Promise(resolve=>child.once('close',resolve))
  t.after(async()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}await closed})
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x)
  const inventory=join(dir,'execution-inventory.json'),completed=join(dir,'execution-results.jsonl')
  const deadline=Date.now()+15000
  while(Date.now()<deadline && !(existsSync(completed)&&readFileSync(completed,'utf8').includes('finished assertion'))) {
    if(child.exitCode!==null)break
    await delay(100)
  }
  assert.ok(existsSync(inventory),'all discovered cases must be persisted before execution: '+output.slice(-1000))
  assert.ok(existsSync(completed),'completed assertions must be persisted without waiting for suite completion')
  process.kill(-child.pid,'SIGKILL');await closed
  const planned=JSON.parse(readFileSync(inventory,'utf8'))
  assert.equal(planned.records.length,3)
  assert.ok(planned.records.every(r=>r.status==='not-run'))
  const rows=readFileSync(completed,'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].status,'passed')
  assert.match(rows[0].title,/finished assertion/)
})

test('partial report recovery keeps completed cases and marks every unstarted case blocked', async t => {
  const {readPlaywrightRecords,normalizeRecord}=await import('../../pipeline/adapters/playwright.mjs')
  const dir=mkdtempSync(join(tmpdir(),'qa-recover-records-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const row=id=>({id,title:id,status:'not-run',outcome:'skipped',annotations:[],errors:[],evidence:[]})
  writeFileSync(join(dir,'execution-inventory.json'),JSON.stringify({records:[row('finished'),row('waiting')]}))
  writeFileSync(join(dir,'execution-results.jsonl'),JSON.stringify({...row('finished'),status:'passed',outcome:'expected'})+'\n{"partial":')
  const results=readPlaywrightRecords(dir).map(r=>normalizeRecord(r,{evidenceBase:'steps/web'}))
  assert.deepEqual(results.map(r=>r.status),['passed','blocked'])
  writeFileSync(join(dir,'regression-summary.json'),JSON.stringify({records:[{...row('finished'),status:'failed',outcome:'unexpected'}]}))
  assert.equal(readPlaywrightRecords(dir)[0].status,'failed','a completed report takes precedence')
  writeFileSync(join(dir,'regression-summary.json'),'{"records":')
  assert.equal(readPlaywrightRecords(dir).length,2,'a truncated final summary must recover checkpointed cases')
})

test('browser preflight failure retains every selected case before execution starts', async t => {
  const {runPlaywrightStep}=await import('../../pipeline/adapters/playwright.mjs')
  const dir=mkdtempSync(join(tmpdir(),'qa-preflight-records-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const result=await runPlaywrightStep({project:'chromium',grep:'W25'}, {
    env:{name:'test',baseUrl:'http://localhost:1',appOrigin:'http://localhost:1',chainId:1,chainName:'Test Chain',allowWrites:false,isolated:true,stack:{verificationRuntime:true,composeProject:'test'}},
    targetUrl:'http://localhost:1',versions:{app:{id:'test'}},stepDir:dir,runDir:dir,
    suite:'regression',runId:'test',echo:false,remainingMs:()=>30000,
  })
  assert.equal(result.tests.length,1,JSON.stringify(result.errors))
  assert.match(result.tests[0].title,/W25/)
  assert.equal(result.tests[0].status,'blocked')
  assert.match(result.tests[0].skipReason,/isolated loopback/)
  assert.equal(result.exitCode,1)
})
