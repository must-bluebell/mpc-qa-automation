import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'

// Serve the real dashboard in a browser with controlled API responses. No Docker runs or Slack sends.
async function dashboard(t, { scheduled = false, aiAuto = false, aiChecked, startButton = 'Run' } = {}) {
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.clock.install()
  const runId = 'ui-completion-regression'
  const fixture = { started: scheduled, complete: false, logRequests: 0, statusRequests: 0, holdLog: null }
  const status = () => ({
    running: fixture.started && !fixture.complete ? { runId } : null,
    slack: { configured: true, valid: true }, ai: { configured: true, auto: aiAuto },
    suites: [{ name: 'full' }, { name: 'regression' }],
    environments: [{ name: 'local-docker' }], seededDefects: [],
  })
  await page.route('http://dashboard.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/' || pathname === '/app.js' || pathname === '/style.css') {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1)
      return route.fulfill({
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
        body: await readFile(new URL(`../../dashboard/public/${file}`, import.meta.url), 'utf8'),
      })
    }
    let data
    if (pathname === '/api/status') { fixture.statusRequests++; data = status() }
    else if (pathname === '/api/stack') data = { project: 'ui-test', healthy: true }
    else if (pathname === '/api/runs' && route.request().method() === 'POST') { fixture.lastStart = route.request().postDataJSON(); fixture.started = true; data = { runId } }
    else if (pathname === '/api/runs') data = fixture.complete ? [{ runId, suite: 'regression', status: 'passed', counts: { passed: 22 } }] : []
    else if (pathname === `/api/jobs/${runId}/log`) {
      fixture.logRequests++
      if (fixture.holdLog) await fixture.holdLog
      // Bound the broken completion loop so its repeated requests can be observed safely.
      await delay(10)
      data = { running: !fixture.complete, log: `${'output line\n'.repeat(100)}${fixture.complete ? 'Finished: 22 passed' : 'Still running'}` }
    } else if (pathname === `/api/runs/${runId}`) data = {
      runId, suite: 'regression', status: 'running', counts: {}, steps: [], groups: [], tests: [],
    }
    else throw new Error(`Unexpected dashboard request: ${pathname}`)
    await route.fulfill({ json: data })
  })
  await page.goto('http://dashboard.test/')
  if (!scheduled) {
    if (aiChecked !== undefined) await page.getByRole('checkbox', { name: 'AI review' }).setChecked(aiChecked)
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
