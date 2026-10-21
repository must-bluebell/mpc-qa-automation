import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {chromium,expect} from '@playwright/test'
import {createServer} from 'node:net'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs'
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
    const readFile=fs.readFileSync,read=fs.readSync;
    fs.readFileSync=function(file,...args){
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
    env:{...process.env,QA_RUNS_DIR:dir,QA_DASHBOARD_PORT:String(port),QA_TEST_LOG_FILE:logFile,QA_TEST_READ_EVENTS:events},
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
  return {base,startupUrl,html,csrf,session,events}
}

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
