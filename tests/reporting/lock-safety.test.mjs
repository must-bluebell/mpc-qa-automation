import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const moduleUrl = new URL('../../pipeline/lib/lock.mjs', import.meta.url).href

test('a previous container namespace cannot keep a reused live PID locked', { skip: process.platform !== 'linux' }, async t => {
  const { acquireLock, readLock } = await import(moduleUrl)
  const directory = mkdtempSync(join(tmpdir(), 'qa-namespace-lock-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'pipeline.lock'), JSON.stringify({
    runId: 'previous-container', pid: process.pid, pidNamespace: 'pid:[previous-container]', startedAt: '2000-01-01',
  }))
  assert.equal(readLock('pipeline', { directory }).stale, true)
  const lock = acquireLock('new-container', 'pipeline', { directory })
  try {
    assert.equal(readLock('pipeline', { directory }).stale, false)
    assert.throws(() => acquireLock('contender', 'pipeline', { directory }), /Another pipeline run/)
  } finally { lock.release() }
})

test('a previous process cannot keep its lock when a container reuses both PID and namespace', { skip: process.platform !== 'linux' }, async t => {
  const { acquireLock, readLock } = await import(moduleUrl)
  const directory = mkdtempSync(join(tmpdir(), 'qa-reused-pid-lock-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'pipeline.lock'), JSON.stringify({
    runId: 'previous-process', pid: process.pid, pidStartTime: 'previous-start', startedAt: '2000-01-01',
  }))
  assert.equal(readLock('pipeline', { directory }).stale, true)
  const lock = acquireLock('new-process', 'pipeline', { directory })
  try { assert.equal(readLock('pipeline', { directory }).stale, false) }
  finally { lock.release() }
})

test('a live owner cannot be replaced because its heartbeat is old', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-live-lock-'))
  mkdirSync(join(dir, '.locks'))
  writeFileSync(join(dir, '.locks/pipeline.lock'), JSON.stringify({runId:'live',pid:process.pid,startedAt:'2000-01-01',heartbeatAt:'2000-01-01'}))
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {acquireLock} from ${JSON.stringify(moduleUrl)};
    try { const lock=acquireLock('contender');lock.release();console.log('acquired') }
    catch(e) { console.log(e.constructor.name) }
  `], { env: {...process.env, QA_RUNS_DIR:dir}, encoding:'utf8' })
  assert.match(output, /LockBusyError/)
})

test('two stale-lock contenders never both enter the critical section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-stale-race-'))
  mkdirSync(join(dir, '.locks'))
  writeFileSync(join(dir, '.locks/pipeline.lock'), JSON.stringify({runId:'old-owner',pid:2147483647,startedAt:'2000-01-01',heartbeatAt:'2000-01-01'}))
  const gate=join(dir,'gate'), messages=[[],[]]
  function worker(index) {
    const script=`
      import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
      const read=fs.readFileSync;
      fs.readFileSync=function(p,...args){const v=read.call(this,p,...args);
        if(String(p).endsWith('pipeline.lock')&&String(v).includes('old-owner')){
          console.log('stale-read');while(!fs.existsSync(${JSON.stringify(gate)}))pause(5);
          if(${index}===1)pause(50);
        }return v;};syncBuiltinESMExports();
      const {acquireLock}=await import(${JSON.stringify(moduleUrl)});
      try {const lock=acquireLock('worker-${index}');console.log('acquired');pause(250);lock.release();}
      catch(e){console.log(e.constructor.name==='LockBusyError'?'busy':'error:'+e.message);}
    `
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,QA_RUNS_DIR:dir},stdio:['ignore','pipe','pipe']})
    let output='';child.stdout.on('data',b=>{output+=b;messages[index]=output.trim().split('\n')})
    return {child,done:new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('lock worker failed')))})}
  }
  const a=worker(0)
  const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw new Error('lock worker timed out');await new Promise(r=>setTimeout(r,10))}}
  let b
  try {
    await until(()=>messages[0].includes('stale-read'));b=worker(1)
    await until(()=>messages[1].some(m=>m==='stale-read'||m==='busy'))
    writeFileSync(gate,'go');await Promise.all([a.done,b.done])
    assert.equal(messages.flat().filter(m=>m==='acquired').length,1)
  } finally { if(!existsSync(gate))writeFileSync(gate,'go');a.child.kill();b?.child.kill() }
})
