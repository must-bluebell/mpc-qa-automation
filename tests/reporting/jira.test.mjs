import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runsDir = mkdtempSync(join(tmpdir(), 'qa-jira-'))
process.env.QA_RUNS_DIR = runsDir
const jira = await import('../../pipeline/notify/jira.mjs')
const { RUNS_DIR } = await import('../../pipeline/lib/env.mjs')

// Ticket state persists in the store file, so each test that creates tickets starts from an empty store.
const resetStore = () => writeFileSync(join(RUNS_DIR, 'jira-tickets.json'), '{}')

const config = { baseUrl: 'https://example.atlassian.net', email: 'qa@example.test', token: 'tok', projectKey: 'ME', issueType: 'Bug' }
const RUN = 'run-jira-1'
const SHOT = 'steps/01-playwright-chromium/shot.png'

function makeRun(extra = {}) {
  mkdirSync(join(RUNS_DIR, RUN, 'steps/01-playwright-chromium'), { recursive: true })
  writeFileSync(join(RUNS_DIR, RUN, SHOT), Buffer.from('png'))
  return {
    runId: RUN, suite: 'regression', env: 'production', versions: { app: { id: 'abc' } },
    tests: [
      { key: 'chromium:W01', title: 'W01 - Display options', status: 'failed', retries: 1, flaky: false, classification: { kind: 'product' }, signature: 'sig1', requirementIds: ['WALLET-01'],
        errors: ['Expected visible: token=supersecret123 at 0x' + 'a'.repeat(40)], evidence: [{ name: 'shot', path: SHOT }, { name: 'trace', path: 'steps/01-playwright-chromium/t.zip' }] },
      { key: 'chromium:W02', title: 'W02', status: 'passed', flaky: true, classification: null, errors: [], evidence: [] },
      { key: 'chromium:W03', title: 'W03', status: 'failed', flaky: true, classification: { kind: 'product' }, errors: ['x'], evidence: [] },
    ],
    ...extra,
  }
}

/** Fake Jira: records every call and answers like the REST API does for the paths used here. */
function fakeJira({ failOn = [] } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ method: init.method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, headers: init.headers })
    if (failOn.includes(path)) return new Response('boom with secret', { status: 500 })
    if (path === '/rest/api/3/issue') return Response.json({ key: 'ME-101' }, { status: 201 })
    if (path.endsWith('/attachments')) return Response.json([{ id: '1' }], { status: 200 })
    if (path.endsWith('/transitions') && init.method === 'GET') return Response.json({ transitions: [{ id: '31', to: { statusCategory: { key: 'done' } } }] })
    if (path.endsWith('/comment')) return Response.json({ id: 'c' }, { status: 201 })
    if (path.endsWith('/transitions') && init.method === 'POST') return new Response(null, { status: 204 })
    return new Response('not found', { status: 404 })
  }
  return { calls, fetchImpl }
}

test('jira stays off until all three settings are present and rejects a non-https or pathful base URL', () => {
  assert.equal(jira.jiraConfig({}), null)
  assert.equal(jira.jiraConfig({ JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.c' }), null)
  assert.throws(() => jira.jiraConfig({ JIRA_BASE_URL: 'http://x.atlassian.net', JIRA_EMAIL: 'a', JIRA_API_TOKEN: 't' }), /https/)
  assert.throws(() => jira.jiraConfig({ JIRA_BASE_URL: 'https://x.atlassian.net/jira', JIRA_EMAIL: 'a', JIRA_API_TOKEN: 't' }), /no path/)
  const ok = jira.jiraConfig({ JIRA_BASE_URL: 'https://x.atlassian.net/', JIRA_EMAIL: 'a', JIRA_API_TOKEN: 't' })
  assert.equal(ok.baseUrl, 'https://x.atlassian.net')
  assert.equal(ok.projectKey, 'ME')
  assert.deepEqual(jira.jiraStatus({}), { configured: false })
})

test('new tickets are assigned only when JIRA_ASSIGNEE_ACCOUNT_ID is set', () => {
  const base = { JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a', JIRA_API_TOKEN: 't' }
  const run = { runId: 'r', suite: 'smoke', env: 'production', versions: {} }
  const test = { key: 'k', title: 't', status: 'failed', retries: 1, flaky: false, classification: { kind: 'product' }, errors: ['e'] }
  assert.equal(jira.jiraConfig(base).assigneeAccountId, null)
  assert.equal('assignee' in jira.issueFields(run, test, jira.jiraConfig(base), { dashboardUrl: '' }), false)
  const assigned = jira.jiraConfig({ ...base, JIRA_ASSIGNEE_ACCOUNT_ID: ' 712020:abc ' })
  assert.equal(assigned.assigneeAccountId, '712020:abc')
  assert.deepEqual(jira.issueFields(run, test, assigned, { dashboardUrl: '' }).assignee, { accountId: '712020:abc' })
})

test('a confirmed failure becomes an ME ticket with redacted text and screenshot evidence only', async () => {
  resetStore()
  const run = makeRun()
  const { calls, fetchImpl } = fakeJira()
  const ticket = await jira.createTicket(config, run, run.tests[0], { fetchImpl })
  assert.equal(ticket.issueKey, 'ME-101')
  assert.equal(jira.listTickets()[0].env, 'production')
  const create = calls.find(c => c.path === '/rest/api/3/issue')
  assert.equal(create.body.fields.project.key, 'ME')
  assert.equal(create.body.fields.issuetype.name, 'Bug')
  const description = JSON.stringify(create.body.fields.description)
  assert.doesNotMatch(description, /supersecret123/)
  assert.match(description, /Requirements: WALLET-01/)
  assert.equal(calls.filter(c => c.path.endsWith('/attachments')).length, 1, 'only the screenshot is attached, not the trace')
  assert.match(create.headers.authorization, /^Basic /)
})

test('a ticket is stored before attachments run, and a second request returns the same open ticket', async () => {
  resetStore()
  const run = makeRun()
  const { calls, fetchImpl } = fakeJira()
  await jira.createTicket(config, run, run.tests[0], { fetchImpl })
  const again = await jira.createTicket(config, run, run.tests[0], { fetchImpl })
  assert.equal(again.existing, true)
  assert.equal(calls.filter(c => c.path === '/rest/api/3/issue').length, 1)
})

test('flaky, passing and infrastructure outcomes never get a ticket', async () => {
  const run = makeRun()
  const { fetchImpl } = fakeJira()
  await assert.rejects(jira.createTicket(config, run, run.tests[1], { fetchImpl }), /Only confirmed product failures/)
  await assert.rejects(jira.createTicket(config, run, run.tests[2], { fetchImpl }), /Only confirmed product failures/)
})

test('a test that passes again closes its ticket with a comment and the Done transition', async () => {
  resetStore()
  const first = makeRun()
  const { fetchImpl: createFetch } = fakeJira()
  await jira.createTicket(config, first, first.tests[0], { fetchImpl: createFetch })
  const later = { runId: 'run-later', env: 'production', tests: [{ key: 'chromium:W01', title: 'W01', status: 'passed', flaky: false }] }
  const { calls, fetchImpl } = fakeJira()
  const result = await jira.reconcileAfterRun(later, { config, fetchImpl })
  assert.deepEqual(result.closed, ['ME-101'])
  assert.ok(calls.some(c => c.path === '/rest/api/3/issue/ME-101/comment'))
  assert.deepEqual(calls.at(-1).body, { transition: { id: '31' } })
  assert.equal(jira.listTickets().find(t => t.issueKey === 'ME-101').state, 'done')
})

test('no run creates a ticket, even with QA_JIRA_AUTO set; people open tickets from the dashboard', async () => {
  resetStore()
  process.env.QA_JIRA_AUTO = '1'
  try {
    const run = makeRun({ runId: 'run-no-auto', tests: [{ key: 'chromium:W09', title: 'W09', status: 'failed', retries: 1, flaky: false, classification: { kind: 'product' }, errors: ['e'], evidence: [] }], comparison: { newFailures: [{ key: 'chromium:W09' }], newVariants: [], persisting: [] } })
    const api = fakeJira()
    const result = await jira.reconcileAfterRun(run, { config, fetchImpl: api.fetchImpl })
    assert.equal(api.calls.filter(c => c.path === '/rest/api/3/issue').length, 0)
    assert.deepEqual(result.created, [])
  } finally { delete process.env.QA_JIRA_AUTO }
})

const failed = (key, extra = {}) => ({ key, title: key, status: 'failed', retries: 1, flaky: false, classification: { kind: 'product' }, errors: ['e'], signature: 'sig-A', requirementIds: [], ...extra })

test('a shared ticket stays open while another test with the same cause still fails', async () => {
  resetStore()
  const seeded = { runId: 'run-share-1', env: 'production', tests: [failed('share-a', { signature: 'sig-share' }), failed('share-b', { signature: 'sig-share' })] }
  await jira.createTicket(config, seeded, seeded.tests[0], { fetchImpl: fakeJira().fetchImpl })
  const api = fakeJira()
  const second = { runId: 'run-share-2', env: 'production', tests: [{ ...failed('share-a', { signature: 'sig-share' }), status: 'passed' }, failed('share-b', { signature: 'sig-share' })] }
  const result = await jira.reconcileAfterRun(second, { config, fetchImpl: api.fetchImpl })
  assert.deepEqual(result.closed, [])
  assert.equal(api.calls.length, 0)
})

test('a manual ticket for a passing or unknown test is refused with a clear status', async () => {
  makeRun()
  await assert.rejects(jira.openTicketForTest('not a run id!', 'x', { config, fetchImpl: fakeJira().fetchImpl }), error => error.status === 400)
  await assert.rejects(jira.openTicketForTest(RUN, 'chromium:missing', { config, fetchImpl: fakeJira().fetchImpl }), error => error.status === 404)
})

test.after(() => rmSync(runsDir, { recursive: true, force: true }))

test('passing in another environment does not close a production defect', async () => {
  resetStore()
  const run = makeRun()
  await jira.createTicket(config, run, run.tests[0], { fetchImpl: fakeJira().fetchImpl })
  const api = fakeJira()
  const result = await jira.reconcileAfterRun({ runId: 'preview-pass', env: 'preview', tests: [{ ...run.tests[0], status: 'passed' }] }, { config, fetchImpl: api.fetchImpl })
  assert.deepEqual(result.closed, [])
  assert.equal(api.calls.length, 0)
})

test('legacy tickets recover their environment from the original saved run', async () => {
  resetStore()
  const run = makeRun()
  writeFileSync(join(RUNS_DIR, RUN, 'run.json'), JSON.stringify(run))
  writeFileSync(join(RUNS_DIR, 'jira-tickets.json'), JSON.stringify({ [run.tests[0].key]: {
    testKey: run.tests[0].key, runId: RUN, issueKey: 'ME-99', state: 'open', url: config.baseUrl + '/browse/ME-99',
  } }))
  const api = fakeJira()
  const existing = await jira.createTicket(config, run, run.tests[0], { fetchImpl: api.fetchImpl })
  assert.equal(existing.issueKey, 'ME-99')
  assert.equal(existing.env, 'production')
  assert.equal(api.calls.length, 0)
})
