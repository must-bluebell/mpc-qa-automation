// Read-only results viewer for the exported snapshot in data/. No controls and no API calls: every value is written with textContent.
const app = document.getElementById('app')
const chips = document.getElementById('chips')
const STATUS_CLASS = { passed: 'ok', failed: 'bad', blocked: 'warn', skipped: '', timedOut: 'warn' }
const COUNT_KEYS = ['passed', 'failed', 'skipped', 'blocked']

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'class') el.className = value
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

const badge = (text, cls = '') => h('span', { class: `badge ${cls}`.trim() }, text)
const percent = value => value == null ? 'n/a' : `${Number(value).toFixed(1)}%`
const statusBadge = status => badge(status ?? 'unknown', STATUS_CLASS[status] ?? '')

async function load(path) {
  const res = await fetch(path, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
  return res.json()
}

function table(headers, rows) {
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, headers.map(text => h('th', {}, text)))),
      h('tbody', {}, rows.map(cells => h('tr', {}, cells.map(cell => h('td', {}, cell)))))))
}

function countsText(counts) {
  return COUNT_KEYS.map(key => `${counts?.[key] ?? 0} ${key}`).join(' · ')
}

function renderChips(generatedAt) {
  chips.replaceChildren(
    ...(generatedAt ? [badge(`Snapshot ${new Date(generatedAt).toLocaleString()}`)] : []),
    badge('Read-only', 'ok'))
}

async function renderList(isCurrent) {
  const { generatedAt, runs } = await load('data/runs.json')
  if (!isCurrent()) return
  renderChips(generatedAt)
  app.replaceChildren(
    h('section', { class: 'panel' },
      h('h2', {}, 'Recent completed runs'),
      h('p', { class: 'muted' }, 'Snapshot of sanitized run summaries. Raw logs, screenshots, traces and credentials are not included.'),
      runs.length
        ? table(['Run', 'Suite', 'Environment', 'Status', 'Finished', 'App version', 'Results', 'Pass rate'],
          runs.map(run => [
            h('a', { href: `#/runs/${encodeURIComponent(run.runId)}` }, run.runId),
            run.suite, run.environment, statusBadge(run.status), run.finishedAt, run.applicationVersion,
            countsText(run.counts), percent(run.quality?.passRate),
          ]))
        : h('p', {}, 'No completed runs have been exported yet.')))
}

function renderSections(sections) {
  if (!sections?.length) return null
  return h('section', { class: 'panel' },
    h('h2', {}, 'Categories'),
    table(['Testing', 'Status', 'Results', 'Source run'],
      sections.map(s => [s.label, statusBadge(s.status), countsText(s.counts), s.sourceRunId])))
}

function renderLoad(metrics) {
  if (!metrics) return null
  return h('section', { class: 'panel' },
    h('h2', {}, 'Load testing'),
    h('p', {}, `${metrics.totalRequests ?? 'unavailable'} requests · ${metrics.throughputRps ?? 'unavailable'} requests/s · functional check rate ${percent(metrics.checkPassRate == null ? null : metrics.checkPassRate * 100)}`),
    metrics.endpoints?.length ? table(['Endpoint', 'p95 (ms)', 'Error rate', 'p95 change vs baseline'],
      metrics.endpoints.map(e => [e.name, e.p95Ms ?? 'unavailable', e.errorRate == null ? 'unavailable' : percent(e.errorRate * 100),
        e.p95ChangePct == null ? 'n/a' : `${e.p95ChangePct > 0 ? '+' : ''}${e.p95ChangePct}%`])) : null)
}

function renderChecks(checks) {
  const groups = new Map()
  for (const check of checks ?? []) {
    if (!groups.has(check.category)) groups.set(check.category, [])
    groups.get(check.category).push(check)
  }
  return [...groups].map(([category, list]) => h('section', { class: 'panel' },
    h('h2', {}, category ?? 'Other checks'),
    table(['Result', 'Test case', 'Requirements', 'Reason / measurement'],
      list.map(c => [
        h('span', {}, statusBadge(c.status), c.critical ? badge('critical', 'bad') : null),
        c.name, c.requirementIds?.join(', ') || '—', c.reason ?? '',
      ]))))
}

async function renderRun(runId, isCurrent) {
  if (!/^[A-Za-z0-9][\w-]{0,99}$/.test(runId)) throw new Error('Invalid run id')
  const run = await load(`data/runs/${runId}.json`)
  if (!isCurrent()) return
  renderChips(null)
  const counts = run.counts
  app.replaceChildren(...[
    h('p', {}, h('a', { href: '#/' }, '← All runs')),
    h('section', { class: 'panel' },
      h('h2', {}, `${run.suite} run ${run.runId}`),
      h('p', {}, statusBadge(run.status), ' ', `${run.environment} · finished ${run.finishedAt} · app ${run.applicationVersion}`),
      h('p', {}, countsText(counts)),
      h('p', { class: 'muted' }, `Test pass rate ${percent(run.quality?.passRate)} · execution coverage ${percent(run.quality?.executionRate)}. Pass rate = passed / (passed + failed); skipped and blocked checks are not passes.`)),
    renderSections(run.sections),
    renderLoad(run.loadMetrics),
    ...renderChecks(run.checks),
  ].filter(Boolean))
}

// Each navigation gets a number; a response that arrives after a newer navigation started is discarded.
let navigation = 0

async function render() {
  const current = ++navigation
  const isCurrent = () => current === navigation
  const match = location.hash.match(/^#\/runs\/([^/]+)$/)
  try {
    if (match) await renderRun(decodeURIComponent(match[1]), isCurrent)
    else await renderList(isCurrent)
  } catch (error) {
    if (isCurrent()) app.replaceChildren(h('section', { class: 'panel' }, h('h2', {}, 'Could not load results'), h('p', {}, error.message)))
  }
}

window.addEventListener('hashchange', render)
render()
