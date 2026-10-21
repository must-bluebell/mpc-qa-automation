import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

test('Playwright dotenv loading cannot reintroduce service credentials', async () => {
  const { loadTestEnv } = await import('../../config/test-env.ts')
  const dir=mkdtempSync(join(tmpdir(),'qa-test-env-')),file=join(dir,'.env')
  writeFileSync(file,'QA_SEED_PHRASE=wallet-fixture\nBASE_URL=https://file.example\nSLACK_BOT_TOKEN=xoxb-private\nOPENAI_API_KEY=private-key\nANTHROPIC_API_KEY=private-cloud\nWEBAPP_READ_TOKEN=private-repository\n')
  const env={BASE_URL:'https://runtime.example'}
  loadTestEnv(file,env)
  assert.deepEqual(env,{BASE_URL:'https://runtime.example',QA_SEED_PHRASE:'wallet-fixture'})
})

test('CI signing targets are validated and assertion steps never receive Slack credentials', () => {
  const qa=parse(readFileSync('.github/workflows/qa.yml','utf8'))
  const steps=qa.jobs.test.steps
  const validate=steps.findIndex(s=>s.id==='target'),sign=steps.findIndex(s=>s.env?.QA_SEED_PHRASE)
  assert.ok(validate>=0&&validate<sign)
  assert.equal(steps[sign].env.BASE_URL,'${{ steps.target.outputs.base_url }}')
  const runner=parse(readFileSync('.github/workflows/qa-runner.yml','utf8'))
  const assertion=runner.jobs.qa.steps.find(s=>s.run?.includes('pipeline/orchestrator.mjs'))
  assert.equal(assertion.env.SLACK_BOT_TOKEN,undefined)
  assert.match(assertion.run,/--no-notify/)
  assert.ok(runner.jobs.qa.steps.every(s=>!s.env?.SLACK_BOT_TOKEN))
  const reportJob=runner.jobs['slack-report']
  const notify=reportJob.steps.find(s=>s.env?.SLACK_BOT_TOKEN)
  assert.ok(notify)
  assert.equal(notify.env.QA_SEED_PHRASE,undefined)
  assert.equal(reportJob['continue-on-error'],true)
  assert.ok(reportJob.steps.some(s=>s.uses?.startsWith('actions/checkout@')))
  assert.ok(reportJob.steps.some(s=>s.uses?.startsWith('actions/download-artifact@')))
  assert.ok(reportJob.steps.every(s=>!s.with?.repository))
})
