import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'

test('a killed suite retains redacted attachments from every completed attempt', t => {
  const dir=mkdtempSync(join(tmpdir(),'qa-checkpoint-evidence-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  writeFileSync(join(dir,'trace.zip'),'trace bytes')
  const script=`
    import Reporter from './utils/regression-reporter.ts';
    const dir=process.env.QA_REPORT_DIR;
    const item={id:'case',titlePath:()=>['chromium','case'],results:[],outcome:()=>item.results.length===1?'unexpected':'flaky',annotations:[],tags:[],parent:{project:()=>({name:'chromium'})}};
    const reporter=new Reporter();
    reporter.onBegin({configFile:process.cwd()+'/playwright.config.ts'},{allTests:()=>[item]});
    for(const retry of [0,1]) {
      const result={retry,status:retry?'passed':'failed',duration:10,startTime:new Date(),errors:[],annotations:[],attachments:retry
        ? [{name:'response',body:Buffer.from('private-seed-value'),contentType:'text/plain'}]
        : [{name:'trace',path:dir+'/trace.zip',contentType:'application/zip'}]};
      item.results.push(result);reporter.onTestEnd(item,result);
    }
    // Deliberately exit without onEnd/onExit: the hard-timeout recovery path.
  `
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,QA_REPORT_DIR:dir,QA_SEED_PHRASE:'private-seed-value'},encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  const rows=readFileSync(join(dir,'execution-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].evidence.length,1)
  assert.equal(rows[1].evidence.length,2)
  assert.equal(readFileSync(join(dir,rows[1].evidence[0].path),'utf8'),'trace bytes')
  assert.ok(!readFileSync(join(dir,rows[1].evidence[1].path),'utf8').includes('private-seed-value'))
  assert.match(rows[1].evidence[0].name,/attempt 1/)
})
