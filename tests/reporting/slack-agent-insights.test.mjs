import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRequest, answerQuestion } from '../../pipeline/slack-agent/answers.mjs'
import { recentRuns, highPriorityCases, healthReport, startedBy } from '../../pipeline/slack-agent/insights.mjs'
import { draftTestCases, validateDraft, slugify } from '../../pipeline/slack-agent/drafts.mjs'

const end = Date.parse('2026-11-24T12:00:00Z')
const run = (overrides = {}) => ({ runId: 'run-a', suite: 'smoke', env: 'local-docker', status: 'passed', trigger: 'manual',
  startedAt: '2026-11-24T11:00:00Z', finishedAt: '2026-11-24T11:30:00Z', counts: { passed: 3, failed: 1, skipped: 0, blocked: 0 },
  tests: [], steps: [], ...overrides })

test('new intents parse from natural questions', () => {
  assert.equal(parseRequest('system health last 7 days').kind, 'health')
  assert.equal(parseRequest('system health last 7 days').days, 7)
  assert.equal(parseRequest('how is the system health?').days, 1)
  assert.equal(parseRequest('stack health last week').days, 7)
  assert.equal(parseRequest('health for the last 400 days').days, 30)
  assert.equal(parseRequest('show high priority cases').kind, 'priority')
  assert.equal(parseRequest('which critical tests are there?').kind, 'priority')
  assert.equal(parseRequest('who runs the tests?').kind, 'runs')
  assert.equal(parseRequest('show recent test runs').kind, 'runs')
  assert.equal(parseRequest('which PRs had QA checks recently?').kind, 'pr-list')
  assert.equal(parseRequest('which PR was checked most recently?').kind, 'pr-tested')
  assert.equal(parseRequest('show the most recent test run results').kind, 'latest')
  assert.equal(parseRequest('create test cases for wallet sign-in').kind, 'create-tests')
  assert.equal(parseRequest('please draft test scenarios for checkout').kind, 'create-tests')
})

test('existing intents keep their meaning', () => {
  assert.equal(parseRequest('what can you do?').kind, 'capabilities')
  assert.equal(parseRequest('which PR was tested last?').kind, 'pr-tested')
  assert.equal(parseRequest('who merged the code?').kind, 'pr-merged')
  assert.equal(parseRequest('show failed high priority cases').kind, 'failures')
  assert.equal(parseRequest('rerun api').kind, 'rerun')
})

test('priority cases come from @critical tags in the spec files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-priority-'))
  writeFileSync(join(dir, 'a.spec.ts'), "test.describe('Account access', { tag: ['@uat', '@critical'] }, () => {})\n"
    + "test.describe('Landing page', { tag: ['@ui'] }, () => {})\n")
  mkdirSync(join(dir, 'nested'))
  writeFileSync(join(dir, 'nested', 'b.spec.mjs'), "test('Wallet checkout', { tag: ['@critical'] }, async () => {})\n")
  const text = highPriorityCases(dir)
  assert.match(text, /High-priority cases \(tagged @critical\): 2/)
  assert.match(text, /Account access/)
  assert.match(text, /Wallet checkout/)
  assert.doesNotMatch(text, /Landing page/)
  assert.match(highPriorityCases(mkdtempSync(join(tmpdir(), 'slack-empty-'))), /No test cases are tagged @critical/)
})

test('recent runs say how each run started and do not invent a person', () => {
  assert.equal(startedBy(run({ trigger: 'dashboard' })), 'dashboard')
  assert.equal(startedBy(run({ trigger: 'scheduled' })), 'schedule')
  assert.equal(startedBy(run({ scheduleId: 'slack-agent' })), 'Slack-requested rerun')
  assert.equal(startedBy(run({ trigger: 'unknown-trigger' })), 'not recorded')
  const text = recentRuns([run(), run({ runId: 'run-b', trigger: 'github-ci' })])
  assert.match(text, /run-a · smoke · local-docker · passed · 3 passed, 1 failed · started by manual command/)
  assert.match(text, /started by GitHub CI/)
  assert.match(recentRuns([]), /No recorded test runs/)
})

test('health report uses the requested window and only real finished runs', () => {
  const runs = [run({ finishedAt: '2026-11-23T20:00:00Z' }), run({ runId: 'old', finishedAt: '2026-10-01T00:00:00Z' })]
  const text = healthReport({ runs, now: end, days: 7, schedules: { timezone: 'Asia/Seoul', schedules: [] }, jobs: [] })
  assert.match(text, /\(7 days\)/)
  assert.match(text, /local-docker/)
  assert.match(text, /1 actual runs/)
  assert.match(healthReport({ runs: [], now: end, days: 3 }), /No recorded runs finished in the last 3 days/)
})

test('answerQuestion routes health and priority questions without AI', async () => {
  const deps = {
    index: () => [{ runId: 'run-a' }], read: () => run({ finishedAt: new Date(Date.now() - 3_600_000).toISOString() }),
    schedules: () => ({ timezone: 'Asia/Seoul', schedules: [] }), jobs: () => [],
    explain: () => { throw new Error('Must not invoke AI') },
  }
  assert.match(await answerQuestion('system health last 2 days', { ...deps, environment: {} }), /\(2 days\)/)
  assert.match(await answerQuestion('show recent test runs', { ...deps, environment: {} }), /Recent test runs/)
  assert.match(await answerQuestion('create test cases for login', { ...deps, environment: {} }), /authorized QA user/)
})

test('draft validation rejects malformed AI output', () => {
  assert.throws(() => validateDraft({ title: 't', cases: [] }))
  assert.throws(() => validateDraft({ title: 't', cases: [{ id: 'TC-01', title: 'x', priority: 'urgent', type: 'ui', steps: ['a'], expected: 'b' }] }))
  assert.throws(() => validateDraft({ title: 't', cases: [{ id: 'TC-01', title: 'x', priority: 'high', type: 'ui', steps: [], expected: 'b' }] }))
  assert.doesNotThrow(() => validateDraft({ title: 'Login', cases: [{ id: 'TC-01', title: 'x', priority: 'high', type: 'ui', steps: ['open'], expected: 'shown' }] }))
})

test('draft is written as an uncommitted markdown file with a sanitized name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-drafts-'))
  const result = await draftTestCases('create test cases for wallet sign-in ../../etc', {
    now: new Date('2026-11-24T12:00:00Z'), ai: { configured: true },
    analyze: async () => ({ title: 'Wallet sign-in / ../../x', cases: [
      { id: 'TC-01', title: 'Sign in with a wallet', priority: 'critical', type: 'ui', steps: ['Open login', 'Connect wallet'], expected: 'Signed in' },
    ] }),
    dir,
  })
  assert.equal(result.count, 1)
  assert.match(result.path, /^testplans\/drafts\/202611241200-wallet-sign-in-x\.md$/)
  const [file] = readdirSync(dir)
  assert.match(file, /^202611241200-wallet-sign-in-x\.md$/)
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  await assert.rejects(draftTestCases('x', { ai: { configured: false }, dir }), /not configured/)
})
