import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('reporter retains failed attempt evidence when retry passes, without attachment collisions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-retry-evidence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const attempt of [0, 1]) {
    mkdirSync(join(dir, String(attempt)))
    writeFileSync(join(dir, String(attempt), 'trace.zip'), `trace attempt ${attempt}`)
  }
  const script = `
    import Reporter from './utils/regression-reporter.ts';
    const dir = process.env.QA_REPORT_DIR;
    const results = [0,1].map(retry => ({retry, status: retry ? 'passed' : 'timedOut', duration: 10,
      startTime: new Date(), errors: retry ? [] : [{message:'Timed out waiting for Join Unity'}],
      attachments:[{name:'trace',path:dir+'/'+retry+'/trace.zip',contentType:'application/zip'}]}));
    const item = {id:'w01',titlePath:()=>['chromium','W01'],results,outcome:()=>'flaky',annotations:[],tags:[],parent:{project:()=>({name:'chromium'})}};
    const reporter = new Reporter();
    reporter.onBegin({configFile:process.cwd()+'/playwright.config.ts'}, {allTests:()=>[item]});
    reporter.onEnd({status:'passed'}); await reporter.onExit();
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, QA_REPORT_DIR: dir }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(readFileSync(join(dir, 'regression-summary.json'))).records[0]
  assert.equal(row.outcome, 'flaky')
  assert.equal(row.retries, 1)
  assert.equal(row.evidence.length, 2)
  assert.notEqual(row.evidence[0].path, row.evidence[1].path)
  assert.match(row.evidence[0].name, /attempt 1.*timedOut/)
  assert.equal(readFileSync(join(dir, row.evidence[0].path), 'utf8'), 'trace attempt 0')
  assert.equal(readFileSync(join(dir, row.evidence[1].path), 'utf8'), 'trace attempt 1')
})
