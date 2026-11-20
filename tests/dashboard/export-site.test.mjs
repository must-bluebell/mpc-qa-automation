import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const EXPORTER = join(ROOT, 'scripts', 'export-dashboard-site.mjs')
const SEED_PHRASE = 'alpha bravo charlie delta echo foxtrot golf hotel'
const RUN_ID = '20260101-100000-regression-fixture'

// Synthetic run records only. Nothing here comes from a real run, wallet, or environment.
function fixtureRun(runId) {
  return {
    runId, suite: 'regression', env: 'local-docker', status: 'failed', trigger: 'manual', scheduleId: null, seededDefect: null,
    startedAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T10:05:00.000Z', durationMs: 300000,
    versions: { app: { id: 'mpc-fixture@1.0.0' } },
    counts: { passed: 1, failed: 1, skipped: 0, blocked: 0, total: 2 },
    steps: [{ name: '01-regression', adapter: 'playwright', fromSuite: 'regression', project: 'chromium', testCount: 2, exitCode: 1, errors: [], artifacts: {} }],
    tests: [
      { key: 'fixture:W01', title: 'W01 - Sign in', adapter: 'playwright', project: 'chromium', step: '01-regression', tags: ['@critical'], status: 'passed', errors: [], annotations: [], requirementIds: [] },
      { key: 'fixture:W02', title: 'W02 - Open Digging', adapter: 'playwright', project: 'chromium', step: '01-regression', tags: [], status: 'failed',
        errors: [`Expected Digging page. Leaked ${SEED_PHRASE} and contact dev@example.com`], annotations: [], requirementIds: [] },
    ],
  }
}

function writeFixtureRuns(dir) {
  const runs = join(dir, 'runs')
  mkdirSync(join(runs, RUN_ID), { recursive: true })
  writeFileSync(join(runs, RUN_ID, 'run.json'), JSON.stringify(fixtureRun(RUN_ID)))
  const entry = run => ({ runId: run.runId, suite: run.suite, env: run.env, status: run.status, finishedAt: run.finishedAt, seededDefect: run.seededDefect, counts: run.counts })
  const index = [
    entry(fixtureRun(RUN_ID)),
    { runId: '20260101-120000-regression-running', suite: 'regression', env: 'local-docker', status: 'running', finishedAt: null, seededDefect: null, counts: {} },
    { runId: '20260101-130000-regression-seeded', suite: 'regression', env: 'local-docker', status: 'failed', finishedAt: '2026-01-01T13:05:00.000Z', seededDefect: 'fixture-defect', counts: {} },
  ]
  writeFileSync(join(runs, 'index.json'), JSON.stringify(index))
  return runs
}

function runExporter(runsDir, out, extraEnv = {}) {
  return spawnSync(process.execPath, [EXPORTER, '--out', out], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, QA_RUNS_DIR: runsDir, QA_SEED_PHRASE: SEED_PHRASE, ...extraEnv },
  })
}

// Shared export target inside the repository (test-results/ is git-ignored); the exporter refuses paths outside it.
const OUT = join(ROOT, 'test-results', 'dashboard-site-export-test')
let fixtureDir
test.before(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'qa-site-export-'))
  const result = runExporter(writeFixtureRuns(fixtureDir), OUT)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
test.after(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
  rmSync(OUT, { recursive: true, force: true })
})

test('exports only completed, non-seeded runs with a run detail file', () => {
  const list = JSON.parse(readFileSync(join(OUT, 'data', 'runs.json'), 'utf8'))
  assert.deepEqual(list.runs.map(r => r.runId), [RUN_ID])
  assert.equal(list.runs[0].counts.failed, 1)
  assert.ok(existsSync(join(OUT, 'data', 'runs', `${RUN_ID}.json`)))
  assert.ok(existsSync(join(OUT, 'index.html')))
  assert.ok(existsSync(join(OUT, 'app.js')))
  assert.ok(existsSync(join(OUT, 'style.css')))
})

test('no raw run data, logs or configured secrets reach the exported files', () => {
  const files = readdirSync(join(OUT, 'data', 'runs')).map(f => join(OUT, 'data', 'runs', f))
  files.push(join(OUT, 'data', 'runs.json'))
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes(SEED_PHRASE), `seed phrase leaked into ${file}`)
    assert.ok(!text.includes('dev@example.com'), `email leaked into ${file}`)
    assert.ok(!text.includes('Expected Digging page'), `raw failure text leaked into ${file}`)
    assert.ok(!text.includes('fixture:W02'), `raw test key leaked into ${file}`)
  }
})

test('refuses to export to a folder outside the repository', () => {
  const result = runExporter(writeFixtureRuns(fixtureDir), tmpdir())
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Output must be a folder inside/)
})

test('does not export a record whose run ID differs from its index entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-site-mismatch-'))
  const out = join('test-results', 'dashboard-site-export-mismatch')
  try {
    const runs = writeFixtureRuns(dir)
    writeFileSync(join(runs, RUN_ID, 'run.json'), JSON.stringify({ ...fixtureRun(RUN_ID), runId: '20260101-999999-regression-other' }))
    const result = runExporter(runs, out)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const list = JSON.parse(readFileSync(join(ROOT, out, 'data', 'runs.json'), 'utf8'))
    assert.deepEqual(list.runs, [])
    assert.ok(!existsSync(join(ROOT, out, 'data', 'runs', '20260101-999999-regression-other.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(ROOT, out), { recursive: true, force: true })
  }
})

test('refuses to clear an existing folder that is not a previous export', () => {
  const result = runExporter(writeFixtureRuns(fixtureDir), 'tests')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not a previous site export/)
  assert.ok(existsSync(join(ROOT, 'tests', 'dashboard', 'export-site.test.mjs')))
})

test('refuses to export through a symlink inside the repository', () => {
  const parent = join(ROOT, 'test-results')
  const link = join(parent, 'dashboard-site-export-link')
  mkdirSync(parent, { recursive: true })
  rmSync(link, { force: true })
  symlinkSync(tmpdir(), link)
  try {
    const result = runExporter(writeFixtureRuns(fixtureDir), join('test-results', 'dashboard-site-export-link', 'site'))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /through a symlink/)
  } finally {
    rmSync(link, { force: true })
  }
})

test('rejects an invalid --limit', () => {
  const result = spawnSync(process.execPath, [EXPORTER, '--limit', '0'], { cwd: ROOT, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--limit must be/)
})

test('read-only page renders the exported run list and run detail in a browser', async t => {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const file = join(OUT, path === '/' ? 'index.html' : path)
    if (!file.startsWith(OUT) || !existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

  await page.goto(`${base}/#/`)
  await expect(page.getByRole('link', { name: RUN_ID })).toBeVisible()
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible()
  await expect(page.locator('button, input, form')).toHaveCount(0)

  await page.getByRole('link', { name: RUN_ID }).click()
  await expect(page.getByRole('heading', { name: `regression run ${RUN_ID}` })).toBeVisible()
  // Check names come from config/test-case-names.json; failure text is replaced by a generic reason.
  await expect(page.getByText('W02 - Sign in with Trust Wallet and open Digging')).toBeVisible()
  await expect(page.getByText('Assertion failed; see private local execution evidence.')).toBeVisible()
  await expect(page.getByText('Expected Digging page')).toHaveCount(0)
  await expect(page.getByText('null', { exact: true })).toHaveCount(0)
  await expect(page.getByText(SEED_PHRASE)).toHaveCount(0)
  assert.deepEqual(errors, [])
})
