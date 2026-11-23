import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'

// Serve the real dashboard in a browser with controlled API responses. No Docker runs or Slack sends.
async function dashboard(t, { scheduled = false, aiAuto = false, aiChecked, notifyChecked, productionWritesChecked, jobNotify, startButton = 'Run', accessToken, runDetail, history = [], categoryResults } = {}) {
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.clock.install()
  const runId = 'ui-completion-regression'
  const fixture = { started: scheduled, complete: false, logRequests: 0, startRequests: 0, statusRequests: 0, holdLog: null }
  const status = () => ({
    running: fixture.started && !fixture.complete ? { runId } : null,
    jobs: jobNotify === undefined ? [] : [{runId,notify:jobNotify,exitCode:fixture.complete?0:null}],
    slack: { configured: true, valid: true }, ai: { configured: true, auto: aiAuto },
    suites: [{ name: 'full' }, { name: 'regression' }],
    environments: [{ name: productionWritesChecked === undefined ? 'local-docker' : 'production' }], seededDefects: [{name:'upstream-connection-timeout',kind:'infrastructure'}], categoryResults,
  })
  await page.route('http://dashboard.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (/^\/assets\/[\w-]+\.(png|jpg)$/.test(pathname)) {
      return route.fulfill({ contentType: pathname.endsWith('.png') ? 'image/png' : 'image/jpeg', body: await readFile(new URL(`../../dashboard/public${pathname}`, import.meta.url)) })
    }
    if (pathname === '/' || pathname === '/app.js' || pathname === '/style.css') {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1)
      return route.fulfill({
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
        body: await readFile(new URL(`../../dashboard/public/${file}`, import.meta.url), 'utf8'),
      })
    }
    let data
    if (pathname === '/api/session') { fixture.sessionRequest = route.request().postDataJSON(); data = {ok:true} }
    else if (pathname === '/api/status') { fixture.statusRequests++; if (fixture.statusError) return route.fulfill({status:503,json:{error:'Temporary status failure'}}); data = status() }
    else if (pathname === '/api/stack') data = { project: 'ui-test', healthy: true }
    else if (pathname === '/api/jira/tickets') data = []
    else if (pathname === '/api/trends') data = { window: { runs: 0, from: null, to: null }, series: [], topFailing: [] }
    else if (pathname === '/api/runs' && route.request().method() === 'POST') { fixture.startRequests++; fixture.lastStart = route.request().postDataJSON(); fixture.started = true; data = { runId } }
    else if (pathname === '/api/runs') data = fixture.complete ? [{ runId, suite: 'regression', status: 'passed', counts: { passed: 22 } }] : history
    else if (pathname === `/api/jobs/${runId}/log`) {
      fixture.logRequests++
      if (fixture.logError) return route.fulfill({ status: fixture.logError, json: { error: 'No log for this run' } })
      if (fixture.holdLog) await fixture.holdLog
      // Bound the broken completion loop so its repeated requests can be observed safely.
      await delay(10)
      data = { running: !fixture.complete, log: `${'output line\n'.repeat(100)}${fixture.complete ? 'Finished: 22 passed' : 'Still running'}` }
    } else if (pathname === `/api/runs/${runId}`) data = runDetail ?? {
      runId, suite: 'regression', status: 'running', counts: {}, steps: [], groups: [], tests: [],
    }
    else throw new Error(`Unexpected dashboard request: ${pathname}`)
    await route.fulfill({ json: data })
  })
  await page.goto(`http://dashboard.test/${accessToken ? '#access='+accessToken : ''}`)
  if (!scheduled) {
    if (aiChecked !== undefined) await page.getByRole('checkbox', { name: 'AI review' }).setChecked(aiChecked)
    if (notifyChecked !== undefined) await page.getByRole('checkbox', { name: 'Slack alerts' }).setChecked(notifyChecked)
    if (productionWritesChecked !== undefined) await page.getByRole('checkbox', {name:'Allow production API writes'}).setChecked(productionWritesChecked, {timeout:1000})
    await page.getByRole('button', { name: startButton, exact: true }).click()
  }
  await expect(page.locator('pre.log')).toContainText('Still running')
  return { page, fixture, runId }
}

test('completion keeps the output panel and scroll position, refreshes results, and stops polling', async t => {
  const { page, fixture } = await dashboard(t)
  await page.locator('pre.log').evaluate(pre => { window.originalLog = pre; pre.scrollTop = 80 })
  fixture.complete = true
  await page.clock.runFor(2100)
  await expect(page.locator('pre.log')).toContainText('Finished: 22 passed')
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled()
  await expect(page.locator('tbody')).toContainText('passed')
  const requestsAtCompletion = fixture.logRequests
  await page.clock.runFor(6000)
  await delay(100)
  assert.equal(fixture.logRequests, requestsAtCompletion, 'completed runs must not restart polling')
  assert.equal(await page.locator('pre.log').evaluate(pre => pre === window.originalLog), true, 'keep the existing output element')
  assert.equal(await page.locator('pre.log').evaluate(pre => pre.scrollTop), 80)
})

test('dashboard shows regression, API and load before system health on home and run details',async t=>{
  const detail={runId:'ui-completion-regression',suite:'full',status:'failed',counts:{passed:2,failed:1},groups:[],
    steps:[{name:'api',fromSuite:'api'},{name:'load',fromSuite:'load'},{name:'web',fromSuite:'regression'}],
    tests:[{title:'API case',step:'api',status:'failed'},{title:'Load case',step:'load',status:'passed'},{title:'Regression case',step:'web',status:'passed'}],
    health:{ok:false,stack:{healthy:false,unhealthyServices:['web'],missingServices:[],services:[{service:'web',state:'exited'}]}}}
  const history=['load','api','regression'].map(suite=>({runId:'ui-completion-regression',suite,env:'local-docker',status:'failed',finishedAt:'2026-10-23T07:00:00Z',counts:{passed:2,failed:1}}))
  const {page}=await dashboard(t,{scheduled:true,runDetail:detail,history})
  await expect(page.locator('#app > section > h2')).toContainText(['Regression testing','API testing'])
  await page.getByRole('tab',{name:'History & health',exact:true}).click()
  await expect(page.locator('#tabpanel-history')).toContainText('Load testing')
  const headings=await page.locator('#tabpanel-history h2').allTextContents()
  assert.equal(headings.at(-1),'System health')
  await page.locator('a[href="#/runs/ui-completion-regression"]').first().click()
  await expect(page.getByRole('heading',{name:'Tests (3)',exact:true})).toBeVisible()
  const titles=await page.locator('#test-results h3').allTextContents()
  assert.deepEqual(titles,['Regression testing','API testing','Load testing'])
  assert.equal((await page.locator('#app h2').allTextContents()).at(-1),'System health')
  await expect(page.locator('#system-health')).toContainText('unhealthy')
})

test('a run without recorded health never borrows current stack health',async t=>{
  const {page,runId}=await dashboard(t,{scheduled:true})
  await expect(page.locator('#system-health')).toContainText('healthy')
  await page.locator(`a[href="#/runs/${runId}"]`).first().click()
  await expect(page.locator('#system-health')).toContainText('not recorded')
  await expect(page.locator('#system-health')).not.toContainText('unhealthy')
})

test('empty category summaries do not fall back to executions without recorded checks',async t=>{
  const history=[{runId:'no-checks',suite:'regression',env:'local-docker',status:'infra-failed',finishedAt:'2026-10-23T10:00:00Z',counts:{passed:0,failed:0}}]
  const {page}=await dashboard(t,{scheduled:true,history,categoryResults:[]})
  await expect(page.locator('#results-regression')).toContainText('No completed local run recorded.')
})

test('leaving the home screen cancels an in-flight log response', async t => {
  const { page, fixture, runId } = await dashboard(t)
  let release
  fixture.holdLog = new Promise(resolve => { release = resolve })
  t.after(() => release())
  await page.clock.runFor(2100)
  await expect.poll(() => fixture.logRequests).toBe(2)
  await page.locator(`a[href="#/runs/${runId}"]`).click()
  await expect(page.getByRole('heading', { name: 'Steps', exact: true })).toBeVisible()
  const before = fixture.statusRequests
  fixture.complete = true
  release()
  await delay(100)
  assert.equal(fixture.statusRequests, before, 'a cancelled poll must not refresh a different screen')
  await expect(page.getByRole('heading', { name: 'Steps', exact: true })).toBeVisible()
})

test('a scheduled run keeps its final output after the scheduler becomes idle', async t => {
  const { page, fixture } = await dashboard(t, { scheduled: true })
  fixture.complete = true
  await page.clock.runFor(2100)
  await expect(page.locator('pre.log')).toContainText('Finished: 22 passed')
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled()
  await page.clock.runFor(6000)
  assert.equal(fixture.logRequests, 2)
  await expect(page.locator('pre.log')).toContainText('Finished: 22 passed')
})

test('both run buttons honor checked and unchecked AI review', async t => {
  for (const startButton of ['Run', 'Run everything (full)']) {
    for (const aiChecked of [true, false]) {
      const { fixture } = await dashboard(t, { startButton, aiChecked, aiAuto: true })
      assert.equal(fixture.lastStart.ai, aiChecked, `${startButton}: checked=${aiChecked}`)
    }
  }
})

test('automatic AI configuration selects review by default in the dashboard', async t => {
  const { fixture } = await dashboard(t, { aiAuto: true })
  assert.equal(fixture.lastStart.ai, true)
})

test('dashboard run buttons can explicitly suppress Slack delivery',async t=>{
  for(const startButton of ['Run','Run everything (full)']) {
    const {fixture}=await dashboard(t,{startButton,notifyChecked:false})
    assert.equal(fixture.lastStart.notify,false)
  }
})

test('Slack alerts remain unchecked when the running form is refreshed',async t=>{
  const {page}=await dashboard(t,{notifyChecked:false})
  await expect(page.getByRole('checkbox',{name:'Slack alerts',exact:true})).not.toBeChecked()
})

test('opening an existing silent run preserves Slack suppression after completion',async t=>{
  const {page,fixture}=await dashboard(t,{scheduled:true,jobNotify:false})
  await expect(page.getByRole('checkbox',{name:'Slack alerts',exact:true})).not.toBeChecked()
  fixture.complete=true
  await page.clock.runFor(2100)
  await expect(page.getByRole('button',{name:'Run',exact:true})).toBeEnabled()
  await expect(page.getByRole('checkbox',{name:'Slack alerts',exact:true})).not.toBeChecked()
})


test('slow log requests never overlap interval ticks',async t=>{
  const {page,fixture}=await dashboard(t)
  let release
  fixture.holdLog=new Promise(resolve=>{release=resolve})
  t.after(()=>release())
  await page.clock.runFor(2100)
  await expect.poll(()=>fixture.logRequests).toBe(2)
  await page.clock.runFor(6100)
  assert.equal(fixture.logRequests,2)
  fixture.complete=true
  release()
  await expect(page.locator('pre.log')).toContainText('Finished: 22 passed')
})


test('the private startup link establishes a session and removes its key from the URL',async t=>{
  const {page,fixture}=await dashboard(t,{accessToken:'private-startup-key'})
  assert.deepEqual(fixture.sessionRequest,{access:'private-startup-key'})
  assert.equal(new URL(page.url()).hash,'')
  assert.equal(fixture.started,true)
})

test('explicit smoke provenance never implies regression or API coverage', async t => {
  const runDetail = {runId:'ui-completion-regression',suite:'smoke',status:'passed',counts:{passed:3},groups:[],
    steps:[{name:'smoke',fromSuite:'smoke'}],tests:[
      {title:'Smoke browser',step:'smoke',project:'chromium',status:'passed'},
      {title:'Smoke API',step:'smoke',project:'api',status:'passed'},
      {title:'Legacy browser',step:'legacy',project:'chromium',status:'passed'},
    ]}
  const {page,runId}=await dashboard(t,{scheduled:true,runDetail})
  await page.locator(`a[href="#/runs/${runId}"]`).first().click()
  await expect(page.locator('#test-results h3')).toHaveText(['Regression testing','Other checks'])
  const tables=page.locator('#test-results table')
  await expect(tables.nth(0)).toContainText('Legacy browser')
  await expect(tables.nth(0)).not.toContainText('Smoke')
  await expect(tables.nth(1)).toContainText('Smoke browser')
  await expect(tables.nth(1)).toContainText('Smoke API')
})

 test('missing job logs show an actionable error instead of silently waiting', async t => {
  const { page, fixture } = await dashboard(t)
  fixture.logError = 404
  await page.clock.runFor(2100)
  await expect(page.locator('pre.log')).toContainText('No log for this run')
  fixture.logError = null
  await page.clock.runFor(2100)
  await expect(page.locator('pre.log')).toContainText('Still running')
})

test('run form controls fit within their grid cells', async t => {
  const { page } = await dashboard(t)
  const bounds = await page.locator('select[name="defect"]').evaluate(el => ({ right: el.getBoundingClientRect().right, parentRight: el.parentElement.getBoundingClientRect().right }))
  assert.ok(bounds.right <= bounds.parentRight + 1, 'defect selector must not overlap AI review')
})

test('completion preserves output and retries a failed results refresh', async t => {
  const {page,fixture} = await dashboard(t)
  fixture.complete = true
  fixture.statusError = true
  await page.clock.runFor(2100)
  await expect(page.locator('pre.log')).toContainText('Finished: 22 passed')
  fixture.statusError = false
  await page.clock.runFor(2100)
  await expect(page.getByRole('button', {name:'Run',exact:true})).toBeEnabled()
})

test('a lost inactive run stops polling and enables a fresh run', async t => {
  const {page,fixture} = await dashboard(t)
  fixture.complete = true
  fixture.logError = 404
  await page.clock.runFor(2100)
  await expect(page.locator('pre.log')).toContainText('Start a new run')
  await expect(page.getByRole('button',{name:'Run',exact:true})).toBeEnabled()
  const requests = fixture.logRequests
  await page.clock.runFor(6100)
  assert.equal(fixture.logRequests,requests)
  await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')))
  await expect(page.locator('pre.log')).toHaveCount(0)
})

test('case results explain skipped and blocked prerequisites', async t => {
  const runDetail={runId:'ui-completion-regression',suite:'full',status:'blocked',counts:{skipped:1,blocked:1},groups:[],steps:[{name:'modules',fromSuite:'regression'}],tests:[
    {title:'Inbox case',step:'modules',status:'skipped',skipReason:'Requires a real test inbox'},
    {title:'Unfinished case',step:'modules',status:'blocked',skipReason:'Runner stopped before this case completed.'},
  ]}
  const {page,runId}=await dashboard(t,{scheduled:true,runDetail})
  await page.locator(`a[href="#/runs/${runId}"]`).first().click()
  await expect(page.locator('#test-results')).toContainText('Requires a real test inbox')
  await expect(page.locator('#test-results')).toContainText('Runner stopped before this case completed.')
})

for (const status of [502, 503, 504]) test(`HTTP ${status} preserves output and recovers without starting another run`, async t => {
  const { page, fixture } = await dashboard(t)
  const output = await page.locator('pre.log').textContent()
  fixture.logError = status
  await page.clock.runFor(2100)
  await expect(page.locator('pre.log')).toHaveText(output)
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Live output', exact: true }) }).getByRole('status')).toContainText(`HTTP ${status}`)
  fixture.logError = null
  fixture.complete = true
  await page.clock.runFor(2100)
  await expect(page.locator('pre.log')).toContainText('Finished: 22 passed')
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Live output', exact: true }) }).getByRole('status')).toBeEmpty()
  assert.equal(fixture.startRequests, 1, 'reconnection must not start a duplicate run')
  const requests = fixture.logRequests
  await page.clock.runFor(6000)
  assert.equal(fixture.logRequests, requests)
})


test('production API writes are explicit in dashboard run requests',async t=>{
  for(const checked of [false,true]){
    const {fixture}=await dashboard(t,{productionWritesChecked:checked})
    assert.equal(fixture.lastStart.productionApiWrites,checked)
  }
})

test('run details expose evidence from both attempts beyond the old four-link limit', async t => {
  const evidence = Array.from({ length: 6 }, (_, i) => ({ name: `evidence ${i + 1}`, path: `steps/web/attempt-${i < 4 ? 1 : 2}/${i}.zip` }))
  const runDetail = { runId: 'ui-completion-regression', suite: 'regression', status: 'passed', counts: { passed: 1, flaky: 1 }, groups: [], steps: [],
    tests: [{ title: 'W01', project: 'chromium', status: 'passed', flaky: true, evidence }] }
  const { page, runId } = await dashboard(t, { scheduled: true, runDetail })
  await page.locator(`a[href="#/runs/${runId}"]`).first().click()
  await expect(page.locator('#test-results a')).toHaveCount(6)
  await expect(page.getByRole('link', { name: 'evidence 6', exact: true })).toHaveAttribute('href', /attempt-2/)
})
