// MPC QA dashboard. All server data is rendered with textContent (never innerHTML): test titles, error
// messages and logs come from the app under test and must be treated as untrusted.
const TOKEN = document.querySelector('meta[name="qa-token"]').content
const app = document.getElementById('app')
const chips = document.getElementById('chips')
let state = { status: null, stack: null, runs: [], watching: null, notify: true, productionApiWrites: false }
let pollTimer = null
let stopPolling = () => {}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'href') el.setAttribute('href', safeHref(v))
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}
// Only same-origin paths and in-page hashes are ever placed in href.
const safeHref = v => (/^(#|\/(?!\/))/.test(String(v)) ? String(v) : '#')

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json', 'x-qa-token': TOKEN } : {}), ...options.headers } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, signIn: data.signIn === true })
  return data
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) })

const STATUS_CLASS = { passed: 'ok', failed: 'bad', 'infra-failed': 'warn', timeout: 'warn', blocked: 'warn', crashed: 'bad', running: '' }
const badge = s => h('span', { class: `badge ${STATUS_CLASS[s] ?? ''}` }, s)
const secs = ms => (ms == null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
const when = iso => (iso ? `${new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hourCycle: 'h23' })} KST` : '—')
const fileUrl = (runId, rel) => `/api/runs/${encodeURIComponent(runId)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`
const REPORT_CATEGORIES = [{ suite: 'regression', label: 'Regression testing' }, { suite: 'api', label: 'API testing' }, { suite: 'load', label: 'Load testing' }]

// Load runs only on the local Docker stack, so hosted deployments do not show a load panel.
const reportCategories = () => REPORT_CATEGORIES.filter(c => !(state.status?.hosted && c.suite === 'load'))

function systemHealth(health, recorded = false) {
  if (!recorded && state.status?.hosted === true) {
    return h('section', { class: 'panel', id: 'system-health' }, h('h2', {}, 'Target environment'),
      h('p', {}, `Runs target ${state.status.defaultEnv} on this hosted deployment. Local Docker is not available here.`))
  }
  if (!recorded) health = state.stack
  const stack = recorded ? health?.stack : health
  const healthy = recorded ? health?.ok === true && stack?.healthy !== false : stack?.healthy
  return h('section', { class: 'panel', id: 'system-health' }, h('h2', {}, 'System health'),
    h('p', {}, recorded ? 'Health recorded with this run: ' : 'Current local stack: ',
      badge(health ? healthy ? 'healthy' : 'unhealthy' : 'not recorded')),
    stack?.project ? h('p', {}, `Stack: ${stack.project}`) : '',
    stack?.services?.length ? h('ul', {}, stack.services.map(s => h('li', {}, `${s.service}: ${s.state}${s.health ? ` · ${s.health}` : ''}`))) : '',
    stack?.missingServices?.length ? h('p', {}, `Missing services: ${stack.missingServices.join(', ')}`) : '',
    recorded ? h('p', { class: 'hint' }, 'Recorded infrastructure health; assertion results are shown above.') :
      h('p', { class: 'hint' }, 'Current infrastructure health; the results above are recorded executions.'))
}

function categoryResults() {
  return reportCategories().map(({ suite, label }) => {
    const run = Array.isArray(state.status.categoryResults) ? state.status.categoryResults.find(r => r.suite === suite) : state.runs.filter(r => r.suite === suite && r.env === (state.status.defaultEnv ?? 'local-docker') && r.finishedAt && !r.seededDefect && !r.reportOnly && r.status !== 'skipped-overlap')
      .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0]
    const c = run?.counts
    return h('section', { class: 'panel', id: `results-${suite}` }, h('h2', {}, label),
      run ? h('div', {}, badge(run.status), h('p', {}, `${c?.passed ?? 0} passed · ${c?.failed ?? 0} failed · ${c?.skipped ?? 0} skipped · ${c?.blocked ?? 0} blocked`),
        h('p', { class: 'hint' }, `Recorded execution · ${when(run.finishedAt)}`),
        run.errors?.length ? h('p', { class: 'hint' }, run.errors.join(' ')) : '',
        h('a', { href: `#/runs/${run.runId}` }, 'View cases and evidence')) : h('p', { class: 'empty' }, `No completed ${state.status.hosted ? state.status.defaultEnv : 'local'} run recorded.`))
  })
}

function renderChips() {
  const s = state.status
  chips.replaceChildren()
  if (!s) return
  const stack = state.stack
  chips.append(
    s.running ? h('span', { class: 'chip warn' }, `Running ${s.running.runId}`) : h('span', { class: 'chip ok' }, 'Idle'),
    s.stackAvailable !== false
      ? (stack ? h('span', { class: `chip ${stack.healthy ? 'ok' : 'bad'}` }, `Stack ${stack.project}: ${stack.healthy ? 'healthy' : stack.error ?? 'unhealthy'}`) : h('span', { class: 'chip' }, 'Stack …'))
      : h('span', { class: 'chip ok' }, `Target ${s.defaultEnv}`),
    h('span', { class: `chip ${s.slack.valid ? 'ok' : s.slack.configured ? 'bad' : 'warn'}` }, `Slack ${s.slack.valid ? 'configured' : s.slack.configured ? s.slack.reason || 'invalid configuration' : 'not configured'}`),
    h('span', { class: `chip ${s.ai.configured ? 'ok' : 'warn'}` }, `AI ${s.ai.configured ? `${s.ai.provider} · ${s.ai.model}` : 'not configured'}`),
    s.role === 'viewer' ? h('span', { class: 'chip' }, `Viewing as ${s.viewerEmail}`) : '',
    s.role === 'viewer' ? h('a', { href: '/auth/logout' }, 'Sign out') : '',
  )
}

async function refresh() {
  const [status, runs] = await Promise.all([api('/api/status'), api('/api/runs')])
  state.status = status
  state.runs = runs
  renderChips()
  if (status.stackAvailable !== false) api('/api/stack').then(stack => {
    state.stack = stack
    renderChips()
    if (location.hash === '' || location.hash === '#/') document.getElementById('system-health')?.replaceWith(systemHealth())
  }).catch(() => {})
  if (location.hash === '' || location.hash === '#/') {
    const panels = categoryResults()
    reportCategories().forEach(({ suite }, i) => document.getElementById(`results-${suite}`)?.replaceWith(panels[i]))
  }
}

function runForm() {
  const s = state.status
  // Viewers see results only; the server refuses their writes, so this is guidance rather than a control.
  if (s.role === 'viewer') {
    return h('section', { class: 'panel' }, h('h2', {}, 'Run tests'),
      h('p', { class: 'hint' }, `Signed in as ${s.viewerEmail}. Viewers can read results; starting runs and sending alerts needs the admin key.`))
  }
  const msg = h('div', { class: 'msg', role: 'status' })
  const suite = h('select', { name: 'suite' }, s.suites.map(x => h('option', { value: x.name, selected: x.name === s.defaultSuite }, x.name)))
  const env = h('select', { name: 'env' }, s.environments.map(x => h('option', { value: x.name, selected: x.name === s.defaultEnv }, x.name)))
  const defect = h('select', { name: 'defect' }, h('option', { value: '' }, 'none'), s.seededDefects.map(x => h('option', { value: x.name }, `${x.name} (${x.kind})`)))
  const ai = h('input', { type: 'checkbox', name: 'ai', checked: s.ai.configured && s.ai.auto })
  const activeNotify = s.jobs?.find(j => j.runId === s.running?.runId)?.notify
  if (typeof activeNotify === 'boolean') state.notify = activeNotify
  const notify = h('input', { type: 'checkbox', name: 'notify', checked: state.notify,
    onchange: e => { state.notify = e.target.checked } })
  const productionWrites = h('input', {type:'checkbox', name:'productionApiWrites', checked:state.productionApiWrites,
    onchange:e => {state.productionApiWrites = e.target.checked} })
  const updateProductionWrites = () => {
    productionWrites.disabled = env.value !== 'production'
    if (productionWrites.disabled) { productionWrites.checked = false; state.productionApiWrites = false }
  }
  env.addEventListener('change', updateProductionWrites)
  updateProductionWrites()
  const desc = h('p', { class: 'hint' })
  const describe = () => { desc.textContent = s.suites.find(x => x.name === suite.value)?.description ?? '' }
  suite.addEventListener('change', describe)
  describe()
  const start = async body => {
    msg.className = 'msg'
    msg.textContent = 'Starting…'
    try {
      const { runId } = await post('/api/runs', body)
      msg.textContent = `Started ${runId}`
      state.productionApiWrites = false
      state.watching = runId
      await refresh()
      render()
    } catch (error) { msg.className = 'msg badge bad'; msg.textContent = error.message }
  }
  const running = !!s.running
  return h('section', { class: 'panel' },
    h('h2', {}, 'Run tests'),
      h('form', { class: 'run', onsubmit: e => { e.preventDefault(); start({ suite: suite.value, env: env.value, seedDefect: defect.value || null, ai: ai.checked, notify: notify.checked, productionApiWrites: env.value === 'production' && productionWrites.checked }) } },
      h('label', {}, 'Suite', suite), h('label', {}, 'Environment', env), h('label', {}, 'Seeded defect', defect),
      h('label', { class: 'check' }, ai, 'AI review'),
      h('label', { class: 'check' }, notify, 'Slack alerts'),
      h('label', { class: 'check' }, productionWrites, 'Allow production API writes'),
      h('button', { class: 'primary', type: 'submit', disabled: running }, running ? 'Run in progress' : 'Run')),
    desc,
    h('div', { class: 'actions' },
      h('button', { type: 'button', disabled: running, onclick: () => start({ suite: s.runAllSuite, env: env.value, ai: ai.checked, notify: notify.checked, productionApiWrites: env.value === 'production' && productionWrites.checked }) }, s.hosted ? 'Run everything (hosted)' : 'Run everything (full)'),
      h('button', { type: 'button', disabled: running, onclick: () => start({ suite: 'smoke', env: env.value, ai: ai.checked, notify: notify.checked, productionApiWrites: env.value === 'production' && productionWrites.checked }) }, 'Smoke'),
      h('button', { type: 'button', onclick: async () => {
        msg.className = 'msg'; msg.textContent = 'Sending Slack test…'
        try { const r = await post('/api/slack/test'); msg.className = `msg badge ${r.ok ? 'ok' : 'warn'}`; msg.textContent = r.ok ? 'Slack test delivered' : `Slack not delivered: ${r.code}` }
        catch (error) { msg.className = 'msg badge bad'; msg.textContent = error.message }
      } }, 'Send Slack test')),
    msg,
    h('p', { class: 'hint' }, s.hosted
      ? 'Hosted deployment: runs target hosted environments only. UAT and load need the local Docker stack and are not offered here. Production API writes require the explicit checkbox and use test wallets. Administrator and seeded success cases still need fixtures.'
      : 'UAT and load run only against the isolated local Docker stack; the pipeline refuses them elsewhere. Production API writes require explicit per-run authorization.'))
}

function liveLog() {
  stopPolling()
  const id = state.watching ?? state.status.running?.runId
  if (!id) return null
  const pre = h('pre', { class: 'log' }, 'Waiting for output…')
  const connection = h('p', { class: 'hint', role: 'status' })
  const head = h('div', {}, h('a', { href: `#/runs/${id}` }, id))
  let cancelled = false
  let pending = false
  stopPolling = () => {
    cancelled = true
    clearInterval(pollTimer)
    pollTimer = null
  }
  const tick = async () => {
    if (cancelled || pending) return
    pending = true
    let receivedLog = false
    try {
      const r = await api(`/api/jobs/${encodeURIComponent(id)}/log`)
      if (cancelled) return
      receivedLog = true
      connection.textContent = ''
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20
      const text = r.log || '(no output yet)'
      if (pre.textContent !== text) pre.textContent = text
      if (atBottom) pre.scrollTop = pre.scrollHeight
      if (!r.running) {
        await refresh()
        if (cancelled) return
        clearInterval(pollTimer)
        pollTimer = null
        // Keep the completed output mounted. Rebuilding home here starts another poller for
        // state.watching, creating an endless completion/render loop and resetting scroll.
        if (location.hash === '' || location.hash === '#/') {
          app.firstElementChild.replaceWith(runForm())
          document.getElementById('run-history')?.replaceWith(runsTable())
        }
      }
    } catch (error) {
      if (cancelled || receivedLog) return
      if ([502, 503, 504].includes(error.status)) {
        // A gateway outage does not invalidate output already received or prove the run failed.
        connection.textContent = `Dashboard temporarily unavailable (HTTP ${error.status}). Reconnecting… Last received output is shown below.`
        return
      }
      connection.textContent = ''
      pre.textContent = `Output unavailable: ${error.message}. Retrying…`
      if (error.status === 404) {
        // A fresh status distinguishes a brief log-creation delay from a lost run.
        // Do not keep a stale run ID selected after the service has forgotten it.
        try {
          await refresh()
          if (cancelled) return
          if (state.status.running?.runId !== id) {
            clearInterval(pollTimer)
            pollTimer = null
            state.watching = null
            pre.textContent = 'This run is no longer available on the server. Start a new run to collect fresh results.'
            head.replaceChildren(document.createTextNode(id))
            app.firstElementChild.replaceWith(runForm())
            document.getElementById('run-history')?.replaceWith(runsTable())
          }
        } catch { /* Keep retrying until server status can be confirmed. */ }
      }
    }
    finally { pending = false }
  }
  pollTimer = setInterval(tick, 2000)
  tick()
  return h('section', { class: 'panel' }, h('h2', {}, 'Live output'), head, connection, pre)
}

function runsTable() {
  if (!state.runs.length) return h('section', { class: 'panel', id: 'run-history' }, h('h2', {}, 'Run history'), h('p', { class: 'empty' }, 'No runs yet.'))
  return h('section', { class: 'panel', id: 'run-history' }, h('h2', {}, 'Run history'), h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Started', 'Suite', 'Env', 'Status', 'Pass', 'Fail', 'Blocked', 'Duration', 'Slack'].map(t => h('th', { class: ['Pass', 'Fail', 'Blocked', 'Duration'].includes(t) ? 'num' : null }, t)))),
    h('tbody', {}, state.runs.map(r => h('tr', { class: 'click', onclick: () => { location.hash = `#/runs/${r.runId}` } },
      h('td', {}, when(r.startedAt)), h('td', {}, r.suite, r.seededDefect ? ` · ${r.seededDefect}` : ''), h('td', {}, r.env), h('td', {}, badge(r.status)),
      h('td', { class: 'num' }, r.counts?.passed ?? 0), h('td', { class: 'num' }, r.counts?.failed ?? 0), h('td', { class: 'num' }, r.counts?.blocked ?? 0),
      h('td', { class: 'num' }, secs(r.durationMs)),
      h('td', {}, r.slack?.length ? r.slack.map(n => h('span', { class: `badge ${n.ok ? 'ok' : 'warn'}` }, `${n.kind}: ${n.ok ? 'sent' : n.code}`)) : '—')))))))
}

function schedulePanel() {
  return h('section', { class: 'panel' }, h('h2', {}, 'Schedule configuration'),
    h('p', { class: 'hint' }, 'Configuration checks only. Completed runs establish runtime and target health.'),
    ...(state.status.schedules ?? []).map(s => h('p', {},
      h('strong', {}, s.id), ` · ${s.suite} · ${s.env} · `,
      h('span', { class: `badge ${!s.enabled || !s.readiness?.ready ? 'warn' : 'ok'}` },
        !s.enabled ? 'Disabled' : s.readiness?.ready ? 'Configured' : 'Blocked'),
      s.readiness?.reason ? ` — ${s.readiness.reason}` : '')))
}

function renderHome() {
  app.replaceChildren(runForm(), liveLog() ?? '', ...categoryResults(), trendsPanel(), runsTable(), schedulePanel(), systemHealth())
  loadTrends()
}

// Trend charts: inline SVG, no library. Values come from the server as data and are written with textContent or
// setAttribute only. The line colour is --chart-line (validated per theme); text uses ink and muted tokens.
const SVG_NS = 'http://www.w3.org/2000/svg'
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  el.append(...children.filter(c => c != null))
  return el
}
const pct = v => `${Math.round(v * 100)}%`
const shortDate = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Seoul', day: '2-digit', month: 'short' }) : '—')
// Only https links are made clickable; anything else is shown as plain text.
function externalLink(url, text) {
  const a = h('a', { target: '_blank', rel: 'noopener noreferrer' }, text)
  try { if (new URL(url).protocol === 'https:') a.setAttribute('href', url) } catch { /* not a link */ }
  return a
}

let trendsLoadedAt = 0
async function loadTrends(force = false) {
  if (!force && Date.now() - trendsLoadedAt < 60_000) return
  trendsLoadedAt = Date.now()
  try { state.trends = await api('/api/trends') } catch { return }
  document.getElementById('trends')?.replaceWith(trendsPanel())
}

function trendsPanel() {
  const t = state.trends
  if (!t) return h('section', { class: 'panel', id: 'trends' }, h('h2', {}, 'Trends'), h('p', { class: 'empty' }, 'Loading trends…'))
  if (!t.series.length) return h('section', { class: 'panel', id: 'trends' }, h('h2', {}, 'Trends'), h('p', { class: 'empty' }, 'No completed runs yet.'))
  return h('section', { class: 'panel', id: 'trends' }, h('h2', {}, 'Trends'),
    h('p', { class: 'hint' }, `Last ${t.window.runs} completed runs · ${shortDate(t.window.from)} to ${shortDate(t.window.to)}`),
    passRateChart(t.series),
    h('h3', {}, 'Tests that fail most'),
    t.topFailing.length ? failingTable(t.topFailing) : h('p', { class: 'empty' }, 'No failures in this window.'))
}

function passRateChart(series) {
  const pts = series.filter(p => p.passRate != null)
  if (!pts.length) return h('p', { class: 'empty' }, 'No passed or failed tests to chart yet.')
  const W = 640, H = 220, L = 44, R = 56, T = 12, B = 30
  const pw = W - L - R, ph = H - T - B
  const n = pts.length
  const x = i => (n === 1 ? L + pw / 2 : L + (i * pw) / (n - 1))
  const y = v => T + (1 - v) * ph
  const grid = [0, 0.5, 1].map(v => svg('g', {},
    svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'chart-grid' }),
    svg('text', { x: L - 8, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, pct(v))))
  const line = svg('polyline', { points: pts.map((p, i) => `${x(i)},${y(p.passRate)}`).join(' '), class: 'chart-line', fill: 'none' })
  // Each point has a larger invisible hit target, so the tooltip is easy to reach with a pointer.
  const points = pts.map((p, i) => svg('g', {},
    svg('circle', { cx: x(i), cy: y(p.passRate), r: 3.5, class: 'chart-dot' }),
    svg('circle', { cx: x(i), cy: y(p.passRate), r: 11, class: 'chart-hit' },
      svg('title', {}, `${shortDate(p.finishedAt)} · ${pct(p.passRate)} pass · ${p.passed} passed, ${p.failed} failed · ${p.runId}`))))
  const last = pts[n - 1]
  const endLabel = svg('text', { x: x(n - 1) + 8, y: y(last.passRate) + 4, class: 'chart-end' }, pct(last.passRate))
  const dates = [svg('text', { x: x(0), y: H - 8, class: 'chart-axis', 'text-anchor': n === 1 ? 'middle' : 'start' }, shortDate(pts[0].finishedAt))]
  if (n > 1) dates.push(svg('text', { x: x(n - 1), y: H - 8, class: 'chart-axis', 'text-anchor': 'end' }, shortDate(last.finishedAt)))
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Pass rate over ${n} runs; latest ${pct(last.passRate)}` }, ...grid, line, ...points, endLabel, ...dates)
  return h('figure', { class: 'chart' }, h('div', { class: 'chart-scroll' }, root),
    h('figcaption', { class: 'hint' }, `Latest ${pct(last.passRate)}. Pass rate = passed ÷ (passed + failed) in each run. Hover a point for its run. Table view below.`),
    runTable(series))
}

function runTable(series) {
  return h('details', { class: 'hint' }, h('summary', {}, 'Table view'),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Finished', 'Suite', 'Passed', 'Failed', 'Flaky', 'Pass rate'].map(t => h('th', { class: t === 'Finished' || t === 'Suite' ? null : 'num' }, t)))),
      h('tbody', {}, series.map(p => h('tr', {},
        h('td', {}, when(p.finishedAt)), h('td', {}, p.suite),
        h('td', { class: 'num' }, p.passed), h('td', { class: 'num' }, p.failed), h('td', { class: 'num' }, p.flaky),
        h('td', { class: 'num' }, p.passRate == null ? '—' : pct(p.passRate))))))))
}

function failingTable(rows) {
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', { class: 'num' }, 'Failed'), h('th', { class: 'num' }, 'Flaky'), h('th', { class: 'num' }, 'Runs'), h('th', {}, 'First failed'), h('th', {}, 'Last failed'))),
    h('tbody', {}, rows.map(r => h('tr', {},
      h('td', {}, r.title,
        r.failures ? h('details', {}, h('summary', {}, 'Latest failure details'),
          h('p', { class: 'hint' }, r.lastFailure ? `${r.lastFailure.classification}${r.lastFailure.reason ? ` · ${r.lastFailure.reason}` : ''}` : ''),
          h('pre', { class: 'log' }, r.lastFailure?.message ?? 'No failure details recorded.'),
          r.lastFailure?.runId ? h('a', { href: `#/runs/${encodeURIComponent(r.lastFailure.runId)}/failures` }, 'View failing run and evidence') : '') : ''),
      h('td', { class: 'num' }, r.failures), h('td', { class: 'num' }, r.flaky), h('td', { class: 'num' }, r.executions),
      h('td', {}, when(r.firstFailedAt)), h('td', {}, when(r.lastFailedAt)))))))
}

function signInPanel() {
  return h('section', { class: 'panel' }, h('h2', {}, 'Sign in to view results'),
    h('p', {}, 'Use your company Google account. Signed-in viewers can read runs; starting runs needs the admin key.'),
    h('p', {}, h('a', { class: 'badge ok', href: '/auth/google/start' }, 'Sign in with Google')))
}

// Creates a Jira ticket for one confirmed product failure (admin only). Shows the existing ticket instead when there is one.
function ticketControl(run, t, tickets) {
  const existing = tickets.find(x => x.testKey === t.key && x.env === run.env && (x.state === 'open' || x.runId === run.runId))
  if (existing) return h('span', {}, ' · ', externalLink(existing.url, existing.issueKey), existing.state === 'done' ? ' (closed)' : '')
  if (!state.status?.jira?.configured || state.status.role !== 'admin') return ''
  const message = h('span', { class: 'hint', role: 'status' })
  const button = h('button', { type: 'button', onclick: async e => {
    e.currentTarget.disabled = true
    message.textContent = 'Creating ticket…'
    try {
      const r = await post('/api/jira/tickets', { runId: run.runId, testKey: t.key })
      message.textContent = r.existing ? `Already tracked as ${r.issueKey}` : `Created ${r.issueKey}`
      await renderRun(run.runId)
    } catch (error) { message.textContent = error.message; e.currentTarget.disabled = false }
  } }, 'Create Jira ticket')
  return h('span', {}, ' ', button, ' ', message)
}

async function renderRun(runId, anchor) {
  stopPolling()
  app.replaceChildren(h('section', { class: 'panel' }, 'Loading…'))
  let run
  try { run = await api(`/api/runs/${encodeURIComponent(runId)}`) } catch (error) {
    app.replaceChildren(h('section', { class: 'panel' }, h('a', { href: '#/' }, '← All runs'), h('p', {}, error.message))); return
  }
  const c = run.counts
  const tickets = await api('/api/jira/tickets').catch(() => [])
  const overview = h('section', { class: 'panel' },
    h('a', { href: '#/' }, '← All runs'),
    h('h2', {}, `${run.suite} on ${run.env} `, badge(run.status)),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Run'), h('dd', {}, run.runId),
      h('dt', {}, 'Target'), h('dd', {}, run.baseUrl),
      h('dt', {}, 'Trigger'), h('dd', {}, run.trigger, run.seededDefect ? ` · seeded defect ${run.seededDefect}` : ''),
      h('dt', {}, 'Started'), h('dd', {}, when(run.startedAt), ' · ', secs(run.durationMs)),
      h('dt', {}, 'App version'), h('dd', {}, `${run.versions?.app?.id} (${run.versions?.app?.source})`),
      h('dt', {}, 'Critical coverage'), h('dd', {}, run.coverage ? `${run.coverage.numerator}/${run.coverage.denominator}` : '—')),
    h('div', { class: 'counts' },
      h('span', { class: 'badge ok' }, `${c.passed} passed`), h('span', { class: `badge ${c.failed ? 'bad' : ''}` }, `${c.failed} failed`),
      h('span', { class: 'badge' }, `${c.skipped} skipped`), h('span', { class: `badge ${c.blocked ? 'warn' : ''}` }, `${c.blocked} blocked`), h('span', { class: 'badge' }, `${c.flaky} flaky`)),
    run.errors?.length ? h('div', {}, h('h3', {}, 'Run errors'), h('pre', { class: 'log' }, run.errors.join('\n\n'))) : '',
    h('div', { class: 'links' }, h('h3', {}, 'Files'),
      h('a', { href: fileUrl(run.runId, 'summary.md'), target: '_blank', rel: 'noopener noreferrer' }, 'summary.md'),
      h('a', { href: fileUrl(run.runId, 'run.json'), target: '_blank', rel: 'noopener noreferrer' }, 'run.json')))

  const steps = h('section', { class: 'panel' }, h('h2', {}, 'Steps'), h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Step'), h('th', {}, 'Suite'), h('th', { class: 'num' }, 'Tests'), h('th', { class: 'num' }, 'Duration'), h('th', {}, 'Evidence'))),
    h('tbody', {}, run.steps.map(s => h('tr', {},
      h('td', {}, s.name, s.timedOut ? h('span', { class: 'badge warn' }, 'timed out') : ''), h('td', {}, s.fromSuite), h('td', { class: 'num' }, s.testCount), h('td', { class: 'num' }, secs(s.durationMs)),
      h('td', { class: 'links' },
        s.artifacts?.htmlReport ? h('a', { href: fileUrl(run.runId, s.artifacts.htmlReport), target: '_blank', rel: 'noopener noreferrer' }, 'HTML report') : '',
        s.artifacts?.log ? h('a', { href: fileUrl(run.runId, s.artifacts.log), target: '_blank', rel: 'noopener noreferrer' }, 'log') : '')))))))

  const failures = h('section', { class: 'panel', id: 'failures' }, h('h2', {}, `Failures (${run.groups.length} group${run.groups.length === 1 ? '' : 's'})`),
    run.groups.length ? run.groups.map(g => h('div', { class: 'group' },
      h('div', {}, h('span', { class: `badge ${g.classification === 'product' ? 'bad' : 'warn'}` }, g.classification), g.critical ? h('span', { class: 'badge bad' }, 'critical') : '',
        ` ${g.size} test(s)`, g.requirementIds?.length ? ` · ${g.requirementIds.join(', ')}` : '', g.reason ? ` · ${g.reason}` : ''),
      h('div', { class: 'err' }, g.message),
      h('ul', {}, g.tests.map(t => h('li', {}, t.title, g.classification === 'product' ? ticketControl(run, t, tickets) : ''))))) : h('p', { class: 'empty' }, 'No failures.'))

  const categoryOf = t => {
    const suite = run.steps.find(s => s.name === t.step)?.fromSuite
    if (suite != null) return [...REPORT_CATEGORIES.map(c => c.suite), 'uat'].includes(suite) ? suite : 'other'
    return t.adapter === 'k6' ? 'load' : t.project === 'api' ? 'api' : t.project === 'uat' || t.adapter === 'webmpc-scenarios' ? 'uat' : t.project === 'chromium' ? 'regression' : 'other'
  }
  const testTable = list => h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Duration'), h('th', {}, 'Evidence'))),
    h('tbody', {}, list.map(t => h('tr', {},
      h('td', {}, t.title, h('div', { class: 'hint' }, t.step), t.skipReason ? h('div', { class: 'hint' }, t.skipReason) : ''), h('td', {}, badge(t.status), t.flaky ? h('span', { class: 'badge warn' }, 'flaky') : ''),
      h('td', { class: 'num' }, secs(t.durationMs)),
      h('td', { class: 'links' }, (t.evidence ?? []).map(e => h('a', { href: fileUrl(run.runId, e.path), target: '_blank', rel: 'noopener noreferrer' }, e.name))))))))
  const tests = h('section', { class: 'panel', id: 'test-results' }, h('h2', {}, `Tests (${run.tests.length})`),
    [...REPORT_CATEGORIES, { suite: 'uat', label: 'UAT scenarios' }, { suite: 'other', label: 'Other checks' }].flatMap(({ suite, label }) => {
      const list = run.tests.filter(t => categoryOf(t) === suite)
      return list.length ? [h('h3', {}, label), testTable(list)] : []
    }))

  const extra = []
  if (run.load) {
    extra.push(h('section', { class: 'panel' }, h('h2', {}, `Performance (${run.load.profile})`),
      h('p', { class: 'hint' }, `${run.load.totalRequests} requests · ${run.load.throughputRps.toFixed(1)} req/s · checks ${run.load.checkPassRate == null ? '—' : `${(run.load.checkPassRate * 100).toFixed(1)}%`} · baseline ${run.load.baselineAction}`),
      h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Endpoint'), h('th', { class: 'num' }, 'p95'), h('th', { class: 'num' }, 'SLO p95'), h('th', { class: 'num' }, 'Errors'), h('th', { class: 'num' }, 'Requests'), h('th', {}, 'Result'))),
        h('tbody', {}, Object.entries(run.load.endpoints).map(([name, r]) => h('tr', {},
          h('td', {}, name), h('td', { class: 'num' }, r.p95Ms == null ? '—' : `${Math.round(r.p95Ms)} ms`), h('td', { class: 'num' }, `${r.slo.p95Ms} ms`),
          h('td', { class: 'num' }, r.errorRate == null ? '—' : `${(r.errorRate * 100).toFixed(2)}%`), h('td', { class: 'num' }, r.requests),
          h('td', {}, r.breaches.length ? h('span', { class: 'badge bad' }, r.breaches.join('; ')) : h('span', { class: 'badge ok' }, 'within SLO')))))))))
  }
  const ai = run.ai ?? {}
  extra.push(h('section', { class: 'panel' }, h('h2', {}, 'AI review'),
    h('p', {}, h('span', { class: `badge ${ai.status === 'ok' ? 'ok' : ai.status === 'rejected' ? 'bad' : ''}` }, ai.status ?? 'not-run'), ' ', ai.reason ?? ai.summary ?? ''),
    ai.status === 'ok' ? h('a', { href: fileUrl(run.runId, 'ai-analysis.json'), target: '_blank', rel: 'noopener noreferrer' }, 'ai-analysis.json') : ''))
  extra.push(h('section', { class: 'panel' }, h('h2', {}, 'Slack alerts'),
    run.notifications?.length ? h('ul', {}, run.notifications.map(n => h('li', {}, h('span', { class: `badge ${n.ok ? 'ok' : 'warn'}` }, n.ok ? 'delivered' : n.code), ` ${n.kind} · ${n.severity ?? ''} · ${n.title ?? ''}`))) : h('p', { class: 'empty' }, 'No notifications for this run.')))
  if (run.comparison) {
    const cmp = run.comparison
    extra.push(h('section', { class: 'panel' }, h('h2', {}, 'Compared with previous run'),
      h('p', {}, `Previous: ${cmp.previousRunId ?? 'none'} · new ${cmp.newFailures.length} · recurring ${cmp.persisting.length} · new variants ${cmp.newVariants.length} · recovered ${cmp.recovered.length}`)))
  }
  app.replaceChildren(overview, tests, h('div', { class: 'grid2' }, ...extra.slice(0, 2)), failures, steps, ...extra.slice(2), systemHealth(run.health, true))
  if (anchor === 'failures') document.getElementById('failures')?.scrollIntoView()
}

async function render() {
  const m = location.hash.match(/^#\/runs\/([\w-]+)(?:\/(failures))?$/)
  if (m) return renderRun(m[1], m[2])
  if (!state.status) await refresh()
  renderHome()
}

window.addEventListener('hashchange', () => render())
setInterval(() => refresh().catch(() => {}), 10_000)
async function connectDashboard() {
  if (location.hash.startsWith('#access=')) {
    const access = location.hash.slice('#access='.length)
    history.replaceState(null, '', location.pathname + location.search)
    await post('/api/session', { access })
  }
  await refresh()
  await render()
}
connectDashboard().catch(error => app.replaceChildren(error.signIn ? signInPanel() : h('section', { class: 'panel' }, `Dashboard API unavailable: ${error.message}`)))
