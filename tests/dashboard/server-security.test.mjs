import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {chromium,expect} from '@playwright/test'
import {createServer} from 'node:net'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

async function dashboardServer(t) {
  const dir=mkdtempSync(join(tmpdir(),'qa-dashboard-security-'))
  const socket=createServer().listen(0,'127.0.0.1')
  await once(socket,'listening')
  const port=socket.address().port
  await new Promise(resolve=>socket.close(resolve))
  mkdirSync(join(dir,'private-run','steps'),{recursive:true})
  mkdirSync(join(dir,'.dashboard'))
  writeFileSync(join(dir,'private-run','steps','trace.zip'),'private-trace-bytes')
  writeFileSync(join(dir,'private-run','steps','report.html'),'<html>private report</html>')
  const logFile=join(dir,'.dashboard','private-run.log'),events=join(dir,'reads.jsonl')
  writeFileSync(logFile,'old output\n'.repeat(100000)+'final output 🔐\n')
  const preload=join(dir,'instrument.mjs')
  writeFileSync(preload,`
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const readFile=fs.readFileSync,read=fs.readSync,stat=fs.statSync;
    fs.statSync=function(file,...args){
      if(String(file).endsWith('/run.json'))fs.appendFileSync(process.env.QA_TEST_READ_EVENTS,JSON.stringify({runStat:String(file)})+'\\n');
      return stat.call(this,file,...args);
    };
    fs.readFileSync=function(file,...args){
      if(String(file).endsWith('/run.json'))fs.appendFileSync(process.env.QA_TEST_READ_EVENTS,JSON.stringify({runRead:String(file)})+'\\n');
      if(String(file)===process.env.QA_TEST_LOG_FILE)fs.appendFileSync(process.env.QA_TEST_READ_EVENTS,JSON.stringify({full:true})+'\\n');
      return readFile.call(this,file,...args);
    };
    fs.readSync=function(fd,buffer,offset,length,position){
      fs.appendFileSync(process.env.QA_TEST_READ_EVENTS,JSON.stringify({length})+'\\n');
      return read.call(this,fd,buffer,offset,length,position);
    };
    syncBuiltinESMExports();
  `)
  const child=spawn(process.execPath,['--import',preload,'dashboard/server.mjs'],{
    env:{...process.env,OPENAI_API_KEY:'qa-security-test-secret',QA_RUNS_DIR:dir,QA_DASHBOARD_PORT:String(port),QA_TEST_LOG_FILE:logFile,QA_TEST_READ_EVENTS:events},
    stdio:['ignore','pipe','pipe'],
  })
  let output='',errors=''
  child.stderr.on('data',chunk=>{errors+=chunk})
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'close')}rmSync(dir,{recursive:true,force:true})})
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`dashboard startup timed out: ${errors}`)),10000)
    child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('MPC QA dashboard:')){clearTimeout(timer);resolve()}})
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(`dashboard exited: ${errors}`))})
  })
  const base=`http://127.0.0.1:${port}`
  const startupUrl=output.match(/http:\/\/\S+/)[0]
  const root=await fetch(base),html=await root.text()
  const csrf=html.match(/name="qa-token" content="([^"]+)"/)[1]
  async function session() {
    const access=new URL(startupUrl).hash.replace('#access=','')
    const response=await fetch(`${base}/api/session`,{method:'POST',headers:{'content-type':'application/json','x-qa-token':csrf,origin:base},body:JSON.stringify({access})})
    assert.equal(response.status,200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  return {base,startupUrl,html,csrf,session,events,dir}
}

test('home category summaries use newer full-run checks and category-specific counts',async t=>{
  const f=await dashboardServer(t)
  const full={runId:'full-new',suite:'full',env:'local-docker',status:'failed',finishedAt:'2026-10-23T10:00:00Z',
    steps:[{name:'web',fromSuite:'regression'},{name:'api',fromSuite:'api'},{name:'load',fromSuite:'load'}],
    tests:[{step:'web',status:'passed'},{step:'api',status:'failed'},{step:'api',status:'passed'},{step:'load',status:'blocked'}]}
  const old={runId:'regression-old',suite:'regression',env:'local-docker',status:'passed',finishedAt:'2026-10-22T10:00:00Z',steps:[{name:'web',fromSuite:'regression'}],tests:[{step:'web',status:'passed'},{step:'web',status:'passed'}]}
  const preview={...full,runId:'preview',reportOnly:true,finishedAt:'2026-10-23T11:00:00Z'}
  const seeded={...full,runId:'seeded',seededDefect:'timeout',finishedAt:'2026-10-23T12:00:00Z'}
  const noResults={...full,runId:'infra-only',status:'infra-failed',tests:[],finishedAt:'2026-10-23T13:00:00Z'}
  const runs=[old,full,preview,seeded,noResults]
  for(const run of runs){mkdirSync(join(f.dir,run.runId));writeFileSync(join(f.dir,run.runId,'run.json'),JSON.stringify(run))}
  writeFileSync(join(f.dir,'index.json'),JSON.stringify(runs))
  const response=await fetch(`${f.base}/api/status`,{headers:{cookie:await f.session()}})
  const status=await response.json()
  assert.deepEqual(status.categoryResults?.map(r=>({suite:r.suite,runId:r.runId,status:r.status,counts:r.counts})),[
    {suite:'regression',runId:'full-new',status:'passed',counts:{passed:1,failed:0,skipped:0,blocked:0}},
    {suite:'api',runId:'full-new',status:'failed',counts:{passed:1,failed:1,skipped:0,blocked:0}},
    {suite:'load',runId:'full-new',status:'blocked',counts:{passed:0,failed:0,skipped:0,blocked:1}},
  ])
})

function saveFixtureRun(f,run) {
  mkdirSync(join(f.dir,run.runId),{recursive:true})
  writeFileSync(join(f.dir,run.runId,'run.json'),JSON.stringify(run))
}

async function eventuallyCategoryResults(f,headers,predicate) {
  let results
  for(let attempt=0;attempt<40;attempt++){
    results=await categoryResults(f,headers)
    if(predicate(results))return results
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  assert.fail(`category change was not observed: ${JSON.stringify(results)}`)
}

async function categoryResults(f,headers) {
  const response=await fetch(`${f.base}/api/status`,{headers})
  assert.equal(response.status,200)
  return (await response.json()).categoryResults
}

test('category summaries include matching execution failures without blaming other combined steps',async t=>{
  const f=await dashboardServer(t),headers={cookie:await f.session()}
  for(const [failure,want] of [[{timedOut:true},'timeout'],[{errors:['runner stopped']},'infra-failed'],[{exitCode:2},'infra-failed']]) {
    for(const withTests of [true,false]) {
      const run={runId:'combined',suite:'full',env:'local-docker',finishedAt:'2026-10-23T10:00:00Z',status:want,
        steps:[{name:'web',fromSuite:'regression',exitCode:0},{name:'api',fromSuite:'api',...failure}],
        tests:[{step:'web',status:'passed'},...(withTests?[{step:'api',status:'passed'}]:[])]}
      saveFixtureRun(f,run)
      writeFileSync(join(f.dir,'index.json'),JSON.stringify([run]))
      const results=await categoryResults(f,headers)
      assert.equal(results.find(r=>r.suite==='regression')?.status,'passed')
      const api=results.find(r=>r.suite==='api')
      assert.equal(api?.runId,'combined')
      assert.equal(api.status,want)
      assert.deepEqual(api.counts,{passed:withTests?1:0,failed:0,blocked:0,skipped:0})
    }
  }
})

test('category polling caches absent categories and refreshes additions and changed run records',async t=>{
  const f=await dashboardServer(t),headers={cookie:await f.session()}
  const runs=Array.from({length:40},(_,i)=>({runId:`web-${i}`,suite:'regression',env:'local-docker',status:'passed',
    finishedAt:new Date(Date.UTC(2026,9,23,0,i)).toISOString(),steps:[{name:'web',fromSuite:'regression'}],tests:[{step:'web',status:'passed'}]}))
  runs.forEach(run=>saveFixtureRun(f,run))
  writeFileSync(join(f.dir,'index.json'),JSON.stringify(runs))
  assert.deepEqual((await categoryResults(f,headers)).map(r=>r.suite),['regression'])
  writeFileSync(f.events,'')
  for(let i=0;i<4;i++)await categoryResults(f,headers)
  const events=readFileSync(f.events,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(events.filter(e=>e.runRead).length,0,'unchanged polling must not reread history for absent categories')
  assert.ok(events.filter(e=>e.runStat).length<=12,'polling metadata checks must be bounded independently of history size')

  const api={...runs[0],runId:'new-api',suite:'api',finishedAt:'2026-10-24T00:00:00Z',steps:[{name:'api',fromSuite:'api'}],tests:[{step:'api',status:'passed'}]}
  saveFixtureRun(f,api)
  writeFileSync(join(f.dir,'index.json'),JSON.stringify([...runs,api]))
  assert.equal((await categoryResults(f,headers)).find(r=>r.suite==='api')?.runId,'new-api')
  // A run record can be repaired independently of the compact index, including atomic replacement.
  const repaired={...runs[0],steps:[{name:'load',fromSuite:'load',timedOut:true}],tests:[]}
  const file=join(f.dir,repaired.runId,'run.json')
  writeFileSync(`${file}.tmp`,JSON.stringify(repaired))
  renameSync(`${file}.tmp`,file)
  await eventuallyCategoryResults(f,headers,results=>results.find(r=>r.suite==='load')?.status==='timeout')
  // Excluded corrected records must reveal the previous eligible category result.
  saveFixtureRun(f,{...api,reportOnly:true})
  await eventuallyCategoryResults(f,headers,results=>!results.some(r=>r.suite==='api'))
  saveFixtureRun(f,{...repaired,seededDefect:'latency'})
  await eventuallyCategoryResults(f,headers,results=>!results.some(r=>r.suite==='load'))
})

test('private evidence requires a session that cannot be obtained from the public page',async t=>{
  const f=await dashboardServer(t),artifact=`${f.base}/api/runs/private-run/files/steps/trace.zip`
  assert.equal((await fetch(artifact)).status,403)
  assert.equal((await fetch(artifact,{headers:{'x-qa-token':f.csrf}})).status,403)
  const access=new URL(f.startupUrl).hash.replace('#access=','')
  assert.ok(access.length>=32)
  assert.ok(!f.html.includes(access))
  const denied=await fetch(`${f.base}/api/session`,{method:'POST',headers:{'content-type':'application/json','x-qa-token':f.csrf},body:JSON.stringify({access:'wrong'})})
  assert.equal(denied.status,403)
  const cookie=await f.session()
  const allowed=await fetch(artifact,{headers:{cookie}})
  assert.equal(allowed.status,200)
  assert.equal(await allowed.text(),'private-trace-bytes')
  assert.equal((await fetch(`${f.base}/api/runs/private-run/files/steps/report.html`,{headers:{cookie}})).status,200)
  assert.equal((await fetch(`${f.base}/api/jobs/private-run/log`)).status,403)
  assert.equal((await fetch(artifact,{headers:{cookie:'mpc_qa_session=wrong'}})).status,403)
})

test('log polling reads a bounded tail instead of loading the complete log',async t=>{
  const f=await dashboardServer(t)
  const headers=new URL(f.startupUrl).hash?{cookie:await f.session()}:{}
  writeFileSync(f.events,'')
  const response=await fetch(`${f.base}/api/jobs/private-run/log`,{headers})
  assert.equal(response.status,200)
  const result=await response.json()
  assert.ok(result.log.endsWith('final output 🔐\n'))
  assert.ok(result.log.length<=60000)
  const events=existsSync(f.events)?readFileSync(f.events,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
  assert.equal(events.some(e=>e.full),false,'polling must not call readFileSync for the full log')
  assert.ok(events.reduce((sum,e)=>sum+(e.length??0),0)<=250000,'read at most a bounded UTF-8 tail')
})

test('oversized text artifacts cannot bypass credential redaction',async t=>{
  const f=await dashboardServer(t),headers={cookie:await f.session()}
  const body='x'.repeat(8*1024*1024)+'qa-security-test-secret'
  writeFileSync(join(f.dir,'private-run','steps','large.log'),body)
  const response=await fetch(`${f.base}/api/runs/private-run/files/steps/large.log`,{headers})
  assert.equal(response.status,413)
  assert.equal((await response.text()).includes('qa-security-test-secret'),false)
})

test('SVG and CSS text artifacts redact configured credentials',async t=>{
  const f=await dashboardServer(t),headers={cookie:await f.session()}
  for(const [name,body,want] of [
    ['image.svg','<svg><!-- qa-security-test-secret --></svg>','<svg><!-- [REDACTED] --></svg>'],
    ['style.css','/* qa-security-test-secret */','/* [REDACTED] */'],
  ]) {
    writeFileSync(join(f.dir,'private-run','steps',name),body)
    const response=await fetch(`${f.base}/api/runs/private-run/files/steps/${name}`,{headers})
    assert.equal(response.status,200)
    assert.equal(await response.text(),want)
  }
})

test('artifact paths reject symlinks to files and run directories outside the run',async t=>{
  const f=await dashboardServer(t),headers={cookie:await f.session()}
  const outside=mkdtempSync(join(tmpdir(),'qa-outside-run-'))
  t.after(()=>rmSync(outside,{recursive:true,force:true}))
  writeFileSync(join(outside,'private.txt'),'outside private data')
  symlinkSync(outside,join(f.dir,'linked-run'),'dir')
  symlinkSync(join(outside,'private.txt'),join(f.dir,'private-run','steps','linked.txt'))
  for(const path of ['linked-run/files/private.txt','private-run/files/steps/linked.txt']) {
    const response=await fetch(`${f.base}/api/runs/${path}`,{headers})
    assert.equal(response.status,403)
    assert.equal((await response.text()).includes('outside private data'),false)
  }
})


test('the real browser exchanges the startup key for a private evidence session',async t=>{
  const f=await dashboardServer(t),browser=await chromium.launch()
  t.after(()=>browser.close())
  const page=await browser.newPage()
  // Docker health is unrelated to session establishment; all authentication and evidence requests are real.
  await page.route('**/api/stack',route=>route.fulfill({json:null}))
  await page.goto(f.startupUrl)
  await expect(page.getByRole('heading',{name:'Run tests',exact:true})).toBeVisible()
  assert.equal(new URL(page.url()).hash,'')
  const cookies=await page.context().cookies()
  assert.ok(cookies.some(c=>c.name.startsWith('mpc_qa_session_')&&c.httpOnly&&c.sameSite==='Strict'))
  const artifact=await page.evaluate(async()=>{
    const response=await fetch('/api/runs/private-run/files/steps/trace.zip')
    return {status:response.status,text:await response.text()}
  })
  assert.deepEqual(artifact,{status:200,text:'private-trace-bytes'})
  const other=await browser.newPage()
  await other.goto(f.base)
  await expect(other.locator('#app')).toContainText('Open the private dashboard link')
  assert.equal(await other.evaluate(async()=> (await fetch('/api/runs/private-run/files/steps/trace.zip')).status),403)
})
