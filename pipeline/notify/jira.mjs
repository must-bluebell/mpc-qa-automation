import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { RUNS_DIR } from '../lib/env.mjs'
import { isRunId, readRun, writeJsonAtomic } from '../lib/run-store.mjs'
import { redactValue } from '../lib/safe-output.mjs'

/**
 * Jira tickets for confirmed product failures (project ME by default).
 *
 * A failure is confirmed when it is a product failure that failed on its retry too (not flaky). A person
 * creates the first tickets from the dashboard; QA_JIRA_AUTO=1 turns on automatic creation later. A ticket
 * is closed automatically when its test passes again in a later run (not flaky). Tickets are keyed by test
 * and stored in runs/jira-tickets.json, so one failing test never gets two open tickets.
 */
const STORE = () => resolve(RUNS_DIR, 'jira-tickets.json')
const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/
const MAX_SCREENSHOTS = 3

/** Null when Jira is not set up. Throws only for a malformed base URL, so a typo is loud rather than silent. */
export function jiraConfig(env = process.env) {
  const raw = (env.JIRA_BASE_URL || '').trim()
  const email = (env.JIRA_EMAIL || '').trim()
  const token = (env.JIRA_API_TOKEN || '').trim()
  if (!raw || !email || !token) return null
  let url
  try { url = new URL(raw) } catch { throw new Error('JIRA_BASE_URL must be a URL such as https://your-site.atlassian.net') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    throw new Error('JIRA_BASE_URL must be https://<site> with no path, query or credentials')
  return {
    baseUrl: url.origin, email, token,
    projectKey: (env.JIRA_PROJECT_KEY || 'ME').trim(), issueType: (env.JIRA_ISSUE_TYPE || 'Bug').trim(),
  }
}

/** Status for the dashboard. Never returns the token or the address, only whether they are set. */
export function jiraStatus(env = process.env) {
  try {
    return { configured: !!jiraConfig(env), auto: env.QA_JIRA_AUTO === '1' }
  } catch (error) {
    return { configured: false, auto: false, reason: error.message }
  }
}

export function readTickets() {
  try { return JSON.parse(readFileSync(STORE(), 'utf8')) } catch { return {} }
}

/** Plain text becomes one ADF paragraph per line. Values are never interpreted as markup. */
export function adfDocument(lines) {
  return {
    type: 'doc', version: 1,
    content: lines.map(line => ({ type: 'paragraph', content: [{ type: 'text', text: String(line).slice(0, 2000) || ' ' }] })),
  }
}

/** Fields for a new issue. The error text is redacted before it leaves the machine. */
export function issueFields(run, test, config, { dashboardUrl = process.env.QA_DASHBOARD_URL } = {}) {
  const error = redactValue(String((test.errors ?? [])[0] ?? 'assertion failed')).split('\n').slice(0, 8).join('\n').slice(0, 1500)
  const runLink = dashboardUrl ? `${dashboardUrl.replace(/\/+$/, '')}/#/runs/${run.runId}` : `run ${run.runId}`
  const requirements = (test.requirementIds ?? []).join(', ') || 'none'
  return {
    project: { key: config.projectKey },
    issuetype: { name: config.issueType },
    summary: `[QA] ${String(test.title).slice(0, 180)} fails in ${run.env}`.slice(0, 250),
    description: adfDocument([
      'Automated QA: this check failed and failed again on its retry, so it is not flaky.',
      `Check: ${test.title}`,
      `Suite: ${run.suite} · Environment: ${run.env} · Run: ${run.runId}`,
      `App version: ${run.versions?.app?.id ?? 'unspecified'} · Failure signature: ${test.signature ?? 'n/a'}`,
      `Requirements: ${requirements}`,
      `Error (redacted): ${error}`,
      `Run record: ${runLink}`,
    ]),
    labels: ['mpc-qa'],
  }
}

async function jiraCall(config, method, path, { body, form, fetchImpl = fetch } = {}) {
  const headers = { authorization: `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`, accept: 'application/json' }
  let payload
  if (form) { headers['x-atlassian-token'] = 'no-check'; payload = form }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetchImpl(`${config.baseUrl}${path}`, { method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  // The response body is never echoed into errors: Jira can quote the request back.
  if (!res.ok) throw Object.assign(new Error(`Jira refused the request (HTTP ${res.status})`), { code: `jira_http_${res.status}` })
  if (res.status === 204) return null
  return res.json().catch(() => null)
}

/** Screenshots only, from the run's own folder, capped. Traces are not attached: they can carry request headers. */
export function evidenceScreenshots(run, test) {
  const runFolder = resolve(RUNS_DIR, run.runId)
  return (test.evidence ?? [])
    .filter(e => /\.(png|jpe?g)$/i.test(e.path ?? ''))
    .map(e => resolve(RUNS_DIR, run.runId, e.path))  // evidence paths are relative to the run folder
    .filter(file => file.startsWith(runFolder + sep) && existsSync(file))
    .slice(0, MAX_SCREENSHOTS)
}

function writeTickets(map) { writeJsonAtomic(STORE(), map) }

/**
 * Creates the ticket for one confirmed failure. Returns the existing open ticket instead of a duplicate.
 * The ticket is stored before attachments are uploaded, so a crash cannot leave an untracked duplicate.
 */
export async function createTicket(config, run, test, { mode = 'manual', fetchImpl = fetch } = {}) {
  if (test.status !== 'failed' || test.classification?.kind !== 'product' || test.flaky) {
    throw Object.assign(new Error('Only confirmed product failures get Jira tickets'), { status: 422 })
  }
  const store = readTickets()
  if (store[test.key]?.state === 'open') return { ...store[test.key], existing: true }
  const created = await jiraCall(config, 'POST', '/rest/api/3/issue', { body: { fields: issueFields(run, test, config) }, fetchImpl })
  const issueKey = created?.key
  if (typeof issueKey !== 'string' || !ISSUE_KEY.test(issueKey)) throw new Error('Jira returned an unexpected response')
  const ticket = { testKey: test.key, title: test.title, issueKey, url: `${config.baseUrl}/browse/${issueKey}`, runId: run.runId, mode, state: 'open', createdAt: new Date().toISOString() }
  store[test.key] = ticket
  writeTickets(store)
  const attachmentsFailed = []
  for (const file of evidenceScreenshots(run, test)) {
    try {
      const form = new FormData()
      form.append('file', new Blob([readFileSync(file)], { type: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg' }), basename(file))
      await jiraCall(config, 'POST', `/rest/api/3/issue/${issueKey}/attachments`, { form, fetchImpl })
    } catch { attachmentsFailed.push(basename(file)) }
  }
  return { ...ticket, attachmentsFailed }
}

/** Closes a ticket with a comment and the first transition whose status category is Done. */
async function closeTicket(config, ticket, runId, fetchImpl) {
  await jiraCall(config, 'POST', `/rest/api/3/issue/${ticket.issueKey}/comment`, {
    body: { body: adfDocument([`Passed again in run ${runId}. Closed automatically by the QA pipeline.`]) }, fetchImpl,
  })
  const transitions = await jiraCall(config, 'GET', `/rest/api/3/issue/${ticket.issueKey}/transitions`, { fetchImpl })
  const done = transitions?.transitions?.find(t => t.to?.statusCategory?.key === 'done')
  if (!done) throw Object.assign(new Error('No Done transition is available'), { code: 'no_done_transition' })
  await jiraCall(config, 'POST', `/rest/api/3/issue/${ticket.issueKey}/transitions`, { body: { transition: { id: done.id } }, fetchImpl })
}

/**
 * Runs after a run's outcomes are saved. Closes tickets whose test passed again, and, only when
 * QA_JIRA_AUTO=1, creates tickets for newly confirmed failures. Never changes the run's status.
 */
export async function reconcileAfterRun(run, { config = jiraConfig(), fetchImpl = fetch, auto = process.env.QA_JIRA_AUTO === '1' } = {}) {
  if (!config) return { configured: false }
  const result = { configured: true, created: [], closed: [], errors: [] }
  const store = readTickets()
  for (const ticket of Object.values(store)) {
    if (ticket.state !== 'open') continue
    const test = run.tests?.find(t => t.key === ticket.testKey)
    if (test?.status !== 'passed' || test.flaky) continue
    try {
      await closeTicket(config, ticket, run.runId, fetchImpl)
      const current = readTickets()
      if (current[ticket.testKey]) current[ticket.testKey] = { ...current[ticket.testKey], state: 'done', closedAt: new Date().toISOString(), closedByRun: run.runId }
      writeTickets(current)
      result.closed.push(ticket.issueKey)
    } catch (error) { result.errors.push({ issueKey: ticket.issueKey, code: error.code ?? 'jira_unavailable' }) }
  }
  if (auto) {
    for (const test of run.tests ?? []) {
      if (test.status !== 'failed' || test.classification?.kind !== 'product' || test.flaky) continue
      try {
        const ticket = await createTicket(config, run, test, { mode: 'auto', fetchImpl })
        if (!ticket.existing) result.created.push(ticket.issueKey)
      } catch (error) { result.errors.push({ testKey: test.key, code: error.code ?? 'jira_unavailable' }) }
    }
  }
  return result
}

/** Dashboard action: a person confirms one failure and its ticket is created. */
export async function openTicketForTest(runId, testKey, { config = jiraConfig(), fetchImpl = fetch } = {}) {
  if (!config) throw Object.assign(new Error('Jira is not configured on this deployment'), { status: 503 })
  if (!isRunId(runId) || typeof testKey !== 'string' || testKey.length > 400) throw Object.assign(new Error('Invalid run or test'), { status: 400 })
  const run = readRun(runId)
  const test = run?.tests?.find(t => t.key === testKey)
  if (!test) throw Object.assign(new Error('That test is not in this run'), { status: 404 })
  try {
    return await createTicket(config, run, test, { mode: 'manual', fetchImpl })
  } catch (error) {
    if (error.status) throw error
    throw Object.assign(new Error(error.message), { status: 502, code: error.code })
  }
}

/** Open and closed tickets for the dashboard. Only identifiers and links are returned. */
export function listTickets() {
  return Object.values(readTickets()).map(t => ({ testKey: t.testKey, issueKey: t.issueKey, url: t.url, state: t.state, runId: t.runId }))
}
