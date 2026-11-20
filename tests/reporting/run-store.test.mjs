import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'

test('comparison history separates ordinary runs and each seeded defect',t=>{
  const dir=mkdtempSync(join(tmpdir(),'qa-history-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const rows=[
    {runId:'ordinary',seededDefect:null},
    {runId:'seed-latency',seededDefect:'latency'},
    {runId:'seed-error',seededDefect:'error'},
  ].map((r,i)=>({...r,suite:'api',env:'local-docker',status:'passed',startedAt:`2026-10-10T00:0${i}:00Z`}))
  for(const r of rows){mkdirSync(join(dir,r.runId));writeFileSync(join(dir,r.runId,'run.json'),JSON.stringify(r))}
  writeFileSync(join(dir,'index.json'),JSON.stringify(rows))
  const moduleUrl=new URL('../../pipeline/lib/run-store.mjs',import.meta.url).href
  const output=execFileSync(process.execPath,['--input-type=module','-e',`
    import {previousRun} from ${JSON.stringify(moduleUrl)};
    const base={runId:'next',suite:'api',env:'local-docker',startedAt:'2026-10-10T01:00:00Z'};
    console.log(JSON.stringify([undefined,'latency','error','other'].map(seededDefect=>previousRun({...base,seededDefect})?.runId??null)));
  `],{env:{...process.env,QA_RUNS_DIR:dir},encoding:'utf8'})
  assert.deepEqual(JSON.parse(output.trim()),['ordinary','seed-latency','seed-error',null])
})

test('saved run records survive missing, malformed and invalid-shaped history indexes',t=>{
  const dir=mkdtempSync(join(tmpdir(),'qa-history-recovery-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const rows=[{runId:'older',startedAt:'2026-11-19T00:00:00Z'},{runId:'newer',startedAt:'2026-11-20T00:00:00Z'}]
  for(const row of rows){mkdirSync(join(dir,row.runId));writeFileSync(join(dir,row.runId,'run.json'),JSON.stringify({...row,suite:'api',status:'passed'}))}
  mkdirSync(join(dir,'broken'));writeFileSync(join(dir,'broken','run.json'),'{')
  mkdirSync(join(dir,'invalid-record'));writeFileSync(join(dir,'invalid-record','run.json'),JSON.stringify({runId:'invalid-record',startedAt:'2026-11-20T00:00:00Z',tests:{}}))
  mkdirSync(join(dir,'mismatched'));writeFileSync(join(dir,'mismatched','run.json'),JSON.stringify({...rows[0],runId:'wrong'}))
  const url=new URL('../../pipeline/lib/run-store.mjs',import.meta.url).href
  for(const index of [undefined,'{','{}','[]','[{"runId":"ghost"}]','[{"runId":"older","startedAt":"invalid"}]']){
    if(index!==undefined)writeFileSync(join(dir,'index.json'),index)
    const output=execFileSync(process.execPath,['--input-type=module','-e',`
      import {readIndex} from ${JSON.stringify(url)};
      console.log(JSON.stringify(readIndex().map(r=>r.runId)));
    `],{env:{...process.env,QA_RUNS_DIR:dir},encoding:'utf8'})
    assert.deepEqual(JSON.parse(output.trim()),['older','newer'])
  }
})

test('rebuilding the index removes stale entries and retains only valid saved runs',t=>{
  const dir=mkdtempSync(join(tmpdir(),'qa-history-rebuild-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  mkdirSync(join(dir,'saved'));writeFileSync(join(dir,'saved','run.json'),JSON.stringify({runId:'saved',startedAt:'2026-11-20T00:00:00Z',status:'passed'}))
  writeFileSync(join(dir,'index.json'),JSON.stringify([{runId:'ghost',startedAt:'2026-11-19T00:00:00Z'}]))
  const url=new URL('../../pipeline/lib/run-store.mjs',import.meta.url).href
  const output=execFileSync(process.execPath,['--input-type=module','-e',`
    import {rebuildIndex,readIndex} from ${JSON.stringify(url)};
    rebuildIndex(); console.log(JSON.stringify(readIndex().map(r=>r.runId)));
  `],{env:{...process.env,QA_RUNS_DIR:dir},encoding:'utf8'})
  assert.deepEqual(JSON.parse(output.trim()),['saved'])
})
