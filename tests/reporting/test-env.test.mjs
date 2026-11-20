import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

test('Playwright dotenv loading cannot reintroduce service credentials', async () => {
  const { loadTestEnv } = await import('../../config/test-env.ts')
  const dir=mkdtempSync(join(tmpdir(),'qa-test-env-')),file=join(dir,'.env')
  writeFileSync(file,'QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART=1\nQA_SEED_PHRASE=wallet-fixture\nBASE_URL=https://file.example\nSLACK_BOT_TOKEN=xoxb-private\nOPENAI_API_KEY=private-key\nANTHROPIC_API_KEY=private-cloud\nWEBAPP_READ_TOKEN=private-repository\n')
  const env={BASE_URL:'https://runtime.example'}
  loadTestEnv(file,env)
  assert.deepEqual(env,{BASE_URL:'https://runtime.example',QA_SEED_PHRASE:'wallet-fixture'})
})

test('CI quality checks delegate to the managed automation workflow', () => {
  const qa=parse(readFileSync('.github/workflows/quality-check.yaml','utf8'))
  assert.equal(qa.jobs.call.uses, 'globalmpc/globalmpc-github-manager/.github/workflows/mpc-automation-quality-check.yaml@release')
  assert.equal(qa.jobs.call.secrets, 'inherit')
})
