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
