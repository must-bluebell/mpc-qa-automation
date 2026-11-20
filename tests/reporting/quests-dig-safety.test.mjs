import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function list(config, overrides={}, projects=[]) {
  return execFileSync(process.execPath,['node_modules/@playwright/test/cli.js','test','--config',config,'--list','--reporter=json', ...projects.map(project => `--project=${project}`)],{
    encoding:'utf8',env:{...process.env,QA_RUN_QUEST_DIG_CART:'1',QA_ALLOW_WRITES:'1',QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART:'1',...overrides},
    stdio:['ignore','pipe','pipe'],
  })
}
test('ordinary regression excludes the cart transaction even with inherited write flags',()=>{
  // Web regression must be listable on CI without a locally installed wallet extension.
  const output=list('playwright.config.ts', {EXTENSION_PATH:'/nonexistent/qa-extension'}, ['chromium', 'api', 'uat', 'web-modules'])
  assert.doesNotMatch(output,/exhaust digs, reject/)
  assert.match(output,/Quests, UI content, and refresh persistence/)
})
test('dedicated cart invocation rejects missing opt-in or production authorization and disabled writes',()=>{
  for(const key of ['QA_RUN_QUEST_DIG_CART','QA_ALLOW_WRITES','QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART'])
    assert.throws(()=>list('playwright.quests-dig.config.ts',{[key]:'0'}),/requires explicit production-write authorization/)
})
test('authorized dedicated invocation selects only the cart transaction with no retries',()=>{
  const report=JSON.parse(list('playwright.quests-dig.config.ts',{CI:'1'}))
  const specs=[]
  const visit=s=>{specs.push(...s.specs);s.suites?.forEach(visit)}
  report.suites.forEach(visit)
  assert.equal(specs.length,1)
  assert.match(specs[0].title,/exhaust digs, reject/)
  assert.equal(report.config.projects[0].retries,0)
})

test('the production quest cart run has no npm entry point',()=>{
  // Commit 407029c removed developer-facing suite scripts. The production cart journey must stay
  // unreachable from npm, so this asserts the script is absent rather than running it.
  const scripts=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).scripts
  assert.equal(scripts['test:quests-dig:cart'],undefined)
})
