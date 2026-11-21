import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notifyBotRun } from '../../pipeline/notify/slack-bot.mjs'
import { renderMarkdown } from '../../pipeline/orchestrator.mjs'

// Own schedule fixture, as in slack-bot.test.mjs: the shipped local schedule file is intentionally empty.
const scheduleFixtureDir = mkdtempSync(join(tmpdir(), 'qa-flaky-schedules-'))
const scheduleFixture = join(scheduleFixtureDir, 'schedules.json')
writeFileSync(scheduleFixture, JSON.stringify({ timezone: 'Asia/Seoul', schedules: [] }))
process.env.QA_SCHEDULE_FILE = scheduleFixture

const run = (id, { flaky = false } = {}) => ({ runId: id, suite: 'regression', env: 'local-docker', status: 'passed',
  finishedAt: '2026-11-21T00:00:00Z', versions: { app: { id: 'abc123' } }, counts: { passed: 1, failed: 0, skipped: 0, blocked: 0 },
  tests: [{ key: 'w01', title: 'W01 Join Unity', status: 'passed', flaky, retries: flaky ? 1 : 0, fingerprint: 'fp-w01', requirementIds: [], annotations: [] }],
  ai: { status: 'not-requested' } })

function setup() {
  const calls = []; let serial = 0
  return { calls, options: { stateDir: mkdtempSync(join(tmpdir(), 'qa-flaky-bot-')), token: 'xoxb-test', channel: 'C123', owner: 'U123', wait: async () => {},
    fetchImpl: async (url, o) => { const body = JSON.parse(o.body); calls.push({ method: url.split('/').at(-1), body })
      return { ok: true, status: 200, json: async () => ({ ok: true, ts: `${++serial}.000` }), headers: new Headers() } } } }
}

test('Slack run summary names a check that passed only on retry', async () => {
  const { calls, options } = setup()
  await notifyBotRun(run('flaky-run', { flaky: true }), options)
  const text = JSON.stringify(calls)
  assert.match(text, /Flaky — passed on retry/)
  assert.match(text, /2 attempts/)
})

test('Slack run summary adds no flaky line when every check passed first time', async () => {
  const { calls, options } = setup()
  await notifyBotRun(run('clean-run'), options)
  assert.doesNotMatch(JSON.stringify(calls), /Flaky — passed on retry/)
})

test('run summary.md lists flaky checks with their attempt count', () => {
  const markdown = renderMarkdown({ ...run('md-run', { flaky: true }), trigger: 'manual', startedAt: '2026-11-21T00:00:00Z', finishedAt: '2026-11-21T00:01:00Z',
    durationMs: 60000, suite: 'regression', productionApiWrites: false, errors: [], groups: [], comparison: null, coverage: { numerator: 0, denominator: 0 },
    counts: { passed: 1, failed: 0, skipped: 0, blocked: 0, flaky: 1, total: 1 }, versions: { app: { id: 'abc123', source: 'test' }, testSuite: { id: 'suite' } },
    notifications: [], pipeline: undefined, ai: { status: 'not-requested' } })
  assert.match(markdown, /## Flaky \(failed, then passed on retry\)/)
  assert.match(markdown, /- W01 Join Unity · 2 attempts/)
})

test('run summary.md has no flaky section when nothing was flaky', () => {
  const markdown = renderMarkdown({ ...run('md-clean'), trigger: 'manual', startedAt: '2026-11-21T00:00:00Z', finishedAt: '2026-11-21T00:01:00Z',
    durationMs: 60000, suite: 'regression', productionApiWrites: false, errors: [], groups: [], comparison: null, coverage: { numerator: 0, denominator: 0 },
    counts: { passed: 1, failed: 0, skipped: 0, blocked: 0, flaky: 0, total: 1 }, versions: { app: { id: 'abc123', source: 'test' }, testSuite: { id: 'suite' } },
    notifications: [], pipeline: undefined, ai: { status: 'not-requested' } })
  assert.doesNotMatch(markdown, /## Flaky/)
})
