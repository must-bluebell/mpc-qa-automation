import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

function list(config, overrides={}) {
  return execFileSync(process.execPath,['node_modules/@playwright/test/cli.js','test','--config',config,'--list','--reporter=json'],{
    encoding:'utf8',env:{...process.env,QA_RUN_QUEST_DIG_CART:'1',QA_ALLOW_WRITES:'1',QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART:'1',...overrides},
    stdio:['ignore','pipe','pipe'],
  })
}
test('ordinary regression excludes the cart transaction even with inherited write flags',()=>{
  const output=list('playwright.config.ts')
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

test('npm cart command selects the dedicated project with zero CI retries',()=>{
  const output=execFileSync('npm',['run','--silent','test:quests-dig:cart','--','--list','--reporter=json'],{
    encoding:'utf8',env:{...process.env,CI:'1',QA_RUN_QUEST_DIG_CART:'1',QA_ALLOW_WRITES:'1',QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART:'1'},
    stdio:['ignore','pipe','pipe'],
  })
  const report=JSON.parse(output)
  assert.equal(report.config.projects.length,1)
  assert.equal(report.config.projects[0].name,'quests-dig-cart')
  assert.equal(report.config.projects[0].retries,0)
  assert.equal(report.errors.length,0)
})
