// MPC QA dashboard. All server data is rendered with textContent (never innerHTML): test titles, error
// messages and logs come from the app under test and must be treated as untrusted.
const TOKEN = document.querySelector('meta[name="qa-token"]').content
const app = document.getElementById('app')
const chips = document.getElementById('chips')
const nav = document.getElementById('nav')
let state = { status: null, stack: null, projects: [], watching: null, notify: true, productionApiWrites: false }
let pollTimer = null
let stopPolling = () => {}
let renderSeq = 0 // Each navigation gets a number; slower responses for an earlier page are dropped.
let reportLimit = 50

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
const HEALTH_CLASS = { healthy: 'ok', 'at-risk': 'warn', failing: 'bad', 'no-data': '' }
const badge = s => h('span', { class: `badge ${STATUS_CLASS[s] ?? ''}` }, s)
const secs = ms => (ms == null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
const when = iso => (iso ? `${new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hourCycle: 'h23' })} KST` : '—')
const shortDate = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Seoul', day: '2-digit', month: 'short' }) : '—')
const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)
const plain = text => String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '')
const fileUrl = (runId, rel) => `/api/runs/${encodeURIComponent(runId)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`
const REPORT_CATEGORIES = [{ suite: 'regression', label: 'Regression testing' }, { suite: 'api', label: 'API testing' }, { suite: 'load', label: 'Load testing' }]
const DAY_OPTIONS = [7, 30, 90, 365]

// ---- Routing. Pages are hash routes; the project and filters travel in the query string.
function route() {
  const [path = '', query = ''] = location.hash.replace(/^#/, '').split('?')
  // The former Dashboard page is now Home; its old links keep working.
  const page = path || '/'
  return { path: page === '/dashboard' ? '/' : page, params: new URLSearchParams(query) }
}
const onPage = name => route().path === name
function currentProjectId() {
  const want = route().params.get('project')
  return state.projects.find(p => p.id === want)?.id ?? state.projects[0]?.id ?? null
}
function go(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  location.hash = `${path}${[...query].length ? `?${query}` : ''}`
}
const projectQuery = project => (project ? `?project=${encodeURIComponent(project)}` : '')

const PAGES = [{ path: '/', label: 'Home' }, { path: '/reports', label: 'Reports' }]
function renderNav() {
  const { path } = route()
  const project = currentProjectId()
  const current = path.startsWith('/runs/') ? '/reports' : path
  const switcher = state.projects.length
    ? h('label', { class: 'project-switch' }, h('span', {}, 'Project'),
      h('select', { id: 'project-select', onchange: e => go(current, { project: e.target.value }) },
        state.projects.map(p => h('option', { value: p.id, selected: p.id === project }, p.id))))
    : null
  nav.replaceChildren(...PAGES.map(p => h('a', { href: `#${p.path}${projectQuery(project)}`, class: 'navlink', 'aria-current': current === p.path ? 'page' : null }, p.label)), switcher)
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
    s.viewerEmail ? h('span', { class: 'chip' }, `${s.role === 'admin' ? 'Signed in as' : 'Viewing as'} ${s.viewerEmail}`) : '',
    s.viewerEmail ? h('a', { href: '/auth/logout' }, 'Sign out') : '',
  )
}

async function refresh() {
  const [status, projects] = await Promise.all([api('/api/status'), api('/api/projects')])
  state.status = status
  state.projects = projects
  renderChips()
  renderNav()
  if (status.stackAvailable !== false) api('/api/stack').then(stack => {
    state.stack = stack
    renderChips()
    if (onPage('/')) document.getElementById('system-health')?.replaceWith(systemHealth())
  }).catch(() => {})
}

function runForm() {
  const s = state.status
  // Viewers see results only; the server refuses their writes, so this is guidance rather than a control.
  if (s.role === 'viewer') {
    return h('section', { class: 'panel', id: 'run-form' }, h('h2', {}, 'Run tests'),
      h('p', { class: 'hint' }, `Signed in as ${s.viewerEmail}. You can read results. Starting runs, sending alerts and creating tickets needs an administrator.`))
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
  return h('section', { class: 'panel', id: 'run-form' },
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
        // Keep the completed output mounted. Re-rendering the home page here starts another poller for
        // state.watching, creating an endless completion/render loop and resetting scroll.
        if (onPage('/')) {
          document.getElementById('run-form')?.replaceWith(runForm())
          refreshHomeStats()
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
            if (onPage('/')) document.getElementById('run-form')?.replaceWith(runForm())
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

// ---- Home: the QA dashboard. The selected project's card and the run launcher share one row of equal height.
// Statistics are repainted into their own slots, so a timer never rebuilds the run form or the live output.
const overviewFor = (project, days, env) => api(`/api/overview?${new URLSearchParams({ project, days: String(days), ...(env ? { env } : {}) })}`)
function homeParams() {
  const params = route().params
  return { days: DAY_OPTIONS.includes(Number(params.get('days'))) ? Number(params.get('days')) : 30, env: params.get('env') || null }
}

function projectCard(o) {
  const info = state.projects.find(p => p.id === o.project)
  const id = encodeURIComponent(o.project)
  const k = o.kpis
  return h('article', { class: 'project-card', 'aria-label': `${o.project} project` },
    h('div', { class: 'project-head' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Project'), h('h2', {}, o.project)),
      h('span', { class: `badge ${HEALTH_CLASS[o.health.state] ?? ''}`, title: o.health.rule }, o.health.label)),
    h('p', { class: 'hint' }, `${o.envs.length ? o.envs.join(', ') : 'No environments'} · ${info?.runs ?? 0} run${info?.runs === 1 ? '' : 's'}`),
    h('dl', { class: 'mini-stats' },
      h('div', {}, h('dt', {}, 'Pass rate'), h('dd', {}, pct(k.passRate))),
      h('div', {}, h('dt', {}, 'Failure rate'), h('dd', {}, pct(k.failureRate))),
      h('div', {}, h('dt', {}, 'Latest'), h('dd', {}, o.latest ? badge(o.latest.status) : '—'))),
    h('p', { class: 'hint' }, o.latest ? `Last finished ${when(o.latest.finishedAt)} · ${o.latest.suite}` : 'Runs appear here after their first completed execution.'),
    h('div', { class: 'actions' },
      h('a', { class: 'btn', href: `#/reports?project=${id}` }, 'Reports'),
      o.latest ? h('a', { class: 'btn', href: `#/runs/${encodeURIComponent(o.latest.runId)}` }, 'Latest run') : null),
  )
}

function otherProjectsPanel(o) {
  const others = state.projects.filter(p => p.id !== o.project)
  if (!others.length) return null
  return h('section', { class: 'panel', id: 'other-projects' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Other projects'), h('span', { class: 'hint' }, `${others.length} more`)),
    h('div', { class: 'project-list' }, others.map(p => h('a', { class: 'project-row', href: `#/?project=${encodeURIComponent(p.id)}` },
      h('span', {}, h('strong', {}, p.id), h('span', { class: 'hint' }, ` · ${p.envs.join(', ') || 'No environment'} · ${p.runs} run${p.runs === 1 ? '' : 's'}`)),
      p.latest ? badge(p.latest.status) : h('span', { class: 'badge' }, 'No runs yet')))))
}

// ---- Dashboard tiles: each figure is counted from executed cases (passed or failed), never from skipped or blocked ones.
function tile(label, value, detail, tone) {
  return h('article', { class: `kpi${tone ? ` kpi-${tone}` : ''}` }, h('p', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), detail ? h('p', { class: 'hint' }, detail) : null)
}

function kpiRow(o) {
  const k = o.kpis, executed = k.passed + k.failed
  return h('section', { class: 'kpis', 'aria-label': 'Key figures' },
    tile('Pass rate', pct(k.passRate), `${k.passed} of ${executed} executed cases passed`, 'pass'),
    tile('Failure rate', pct(k.failureRate), `${k.failed} executed case${k.failed === 1 ? '' : 's'} failed`, 'fail'),
    tile('Executed cases', String(executed), `Last ${o.days} days, Seoul time`),
    tile('Flaky cases', String(k.flaky), 'Passed only on retry'),
    tile('Runs', String(k.runs), `${k.passedRuns} finished as passed`))
}

function passLine(daily) {
  const pts = daily.filter(d => d.passRate != null)
  if (!pts.length) return emptyState('No pass rate yet', 'Passed and failed cases in this window draw the line.')
  const W = 640, H = 220, L = 44, R = 56, T = 12, B = 30
  const pw = W - L - R, ph = H - T - B, n = pts.length
  const x = i => (n === 1 ? L + pw / 2 : L + (i * pw) / (n - 1))
  const y = v => T + (1 - v) * ph
  const grid = [0, 0.5, 1].map(v => svg('g', {},
    svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'chart-grid' }),
    svg('text', { x: L - 8, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, pct(v))))
  const line = svg('polyline', { points: pts.map((p, i) => `${x(i)},${y(p.passRate)}`).join(' '), class: 'chart-line', fill: 'none' })
  const dots = pts.map((p, i) => svg('g', {},
    svg('circle', { cx: x(i), cy: y(p.passRate), r: 3.5, class: 'chart-dot' }),
    svg('circle', { cx: x(i), cy: y(p.passRate), r: 11, class: 'chart-hit' },
      svg('title', {}, `${shortDate(p.date)} · ${pct(p.passRate)} pass · ${p.passed} passed, ${p.failed} failed`))))
  const last = pts.at(-1)
  const endLabel = svg('text', { x: x(n - 1) + 8, y: y(last.passRate) + 4, class: 'chart-end' }, pct(last.passRate))
  const dates = [svg('text', { x: x(0), y: H - 8, class: 'chart-axis', 'text-anchor': n === 1 ? 'middle' : 'start' }, shortDate(pts[0].date))]
  if (n > 1) dates.push(svg('text', { x: x(n - 1), y: H - 8, class: 'chart-axis', 'text-anchor': 'end' }, shortDate(last.date)))
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Daily pass rate over ${n} days; latest ${pct(last.passRate)}` }, ...grid, line, ...dots, endLabel, ...dates)
  return h('figure', { class: 'chart' }, h('div', { class: 'chart-scroll' }, root),
    h('figcaption', { class: 'hint' }, 'Pass rate per day = passed ÷ (passed + failed). Hover a point for its day. The table view below has every value.'))
}

// Stacked columns: passed under failed, one column per day. The legend names both series.
function dailyColumns(daily) {
  if (!daily.length) return emptyState('No executed cases yet', 'Columns appear after the first completed run in this window.')
  const W = 640, H = 200, L = 44, R = 12, T = 12, B = 30
  const pw = W - L - R, ph = H - T - B, n = daily.length
  const max = Math.max(1, ...daily.map(d => d.passed + d.failed))
  const step = pw / n, bw = Math.max(6, Math.min(36, step * 0.6))
  const base = T + ph
  const y = v => base - (v / max) * ph
  const grid = [0, max / 2, max].map(v => svg('g', {},
    svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'chart-grid' }),
    svg('text', { x: L - 8, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, Math.round(v))))
  const columns = daily.map((d, i) => {
    const cx = L + step * (i + 0.5)
    const passedH = (d.passed / max) * ph, failedH = (d.failed / max) * ph
    return svg('g', {},
      svg('rect', { x: cx - bw / 2, y: base - passedH, width: bw, height: passedH, rx: 2, class: 'bar-passed' }),
      failedH ? svg('rect', { x: cx - bw / 2, y: base - passedH - failedH, width: bw, height: failedH, rx: 2, class: 'bar-failed' }) : null,
      svg('title', {}, `${shortDate(d.date)} · ${d.passed} passed, ${d.failed} failed`))
  })
  const dates = [svg('text', { x: L, y: H - 8, class: 'chart-axis', 'text-anchor': 'start' }, shortDate(daily[0].date))]
  if (n > 1) dates.push(svg('text', { x: W - R, y: H - 8, class: 'chart-axis', 'text-anchor': 'end' }, shortDate(daily.at(-1).date)))
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Passed and failed cases per day over ${n} days` }, ...grid, ...columns, ...dates)
  return h('figure', { class: 'chart' }, h('div', { class: 'chart-scroll' }, root),
    h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'swatch swatch-passed' }), 'Passed'), h('span', {}, h('i', { class: 'swatch swatch-failed' }), 'Failed')),
    h('figcaption', { class: 'hint' }, 'Executed cases per day. Table view under the pass rate chart.'))
}

function dayTable(daily) {
  if (!daily.length) return null
  return h('details', { class: 'hint table-view' }, h('summary', {}, 'Table view · daily values'),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Day (KST)', 'Runs', 'Passed', 'Failed', 'Flaky', 'Pass rate'].map(t => h('th', { class: t === 'Day (KST)' ? null : 'num' }, t)))),
      h('tbody', {}, daily.map(d => h('tr', {},
        h('td', {}, shortDate(d.date)), h('td', { class: 'num' }, d.runs), h('td', { class: 'num' }, d.passed),
        h('td', { class: 'num' }, d.failed), h('td', { class: 'num' }, d.flaky), h('td', { class: 'num' }, pct(d.passRate))))))))
}

function passRatePanel(o) {
  return h('section', { class: 'panel', id: 'trends' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Pass rate per day'),
      h('span', { class: 'hint' }, o.window.from ? `${shortDate(o.window.from)} to ${shortDate(o.window.to)}` : 'No completed runs in this window')),
    passLine(o.daily), dayTable(o.daily))
}

function volumePanel(o) {
  return h('section', { class: 'panel', id: 'volume' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Executed cases per day'),
      h('span', { class: 'hint' }, 'Passed and failed')),
    dailyColumns(o.daily))
}

function suiteSection(o) {
  return h('section', { class: 'panel', id: 'suites' }, h('h2', {}, 'Latest result by suite'),
    o.suites.length ? h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Suite'), h('th', {}, 'Latest'), h('th', { class: 'num' }, 'Passed'), h('th', { class: 'num' }, 'Failed'),
        h('th', { class: 'num' }, 'Blocked'), h('th', {}, 'Finished'), h('th', {}, ''))),
      h('tbody', {}, o.suites.map(s => h('tr', {},
        h('td', {}, s.suite, s.env ? h('div', { class: 'hint' }, s.env) : ''), h('td', {}, badge(s.status)),
        h('td', { class: 'num' }, s.counts.passed), h('td', { class: 'num' }, s.counts.failed), h('td', { class: 'num' }, s.counts.blocked),
        h('td', {}, when(s.finishedAt)), h('td', {}, h('a', { href: `#/runs/${s.runId}` }, 'Open run'))))))) :
      emptyState('No suite results yet', 'Each suite appears here after its first completed run.'))
}

function failingSection(o) {
  return h('section', { class: 'panel', id: 'failing' }, h('h2', {}, 'Tests that fail most'),
    o.topFailing.length ? failingTable(o.topFailing) : emptyState('No failures in this window', 'Failing tests are listed here with their latest failure.'))
}

// Lower part of the dashboard: operations detail and administration, behind tabs so the main view stays short.
let activeOpsTab = 'operations'
const OPS_TABS = [
  { id: 'operations', label: 'Schedules & system health', panels: () => [schedulePanel(), systemHealth()] },
  { id: 'administration', label: 'Administration', panels: () => [adminsPanel(), recentSignInsPanel()] },
]
function selectOpsTab(id) {
  activeOpsTab = id
  document.querySelectorAll('#ops-tabs [role="tab"]').forEach(tab => {
    const selected = tab.dataset.tab === id
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  })
  document.querySelectorAll('[role="tabpanel"][data-tab]').forEach(panel => { panel.hidden = panel.dataset.tab !== id })
}
function opsTabs() {
  const tabs = OPS_TABS.map(t => ({ ...t, content: t.panels().filter(Boolean) })).filter(t => t.content.length)
  if (!tabs.length) return null
  if (!tabs.some(t => t.id === activeOpsTab)) activeOpsTab = tabs[0].id
  const strip = h('div', { id: 'ops-tabs', class: 'tabs', role: 'tablist', 'aria-label': 'More dashboard sections' },
    tabs.map(t => h('button', { type: 'button', role: 'tab', class: 'tab', id: `tab-${t.id}`, 'data-tab': t.id, 'aria-controls': `tabpanel-${t.id}`,
      'aria-selected': String(t.id === activeOpsTab), tabIndex: t.id === activeOpsTab ? 0 : -1, onclick: () => selectOpsTab(t.id) }, t.label)))
  return h('div', { class: 'ops' }, strip, ...tabs.map(t => h('div', { role: 'tabpanel', id: `tabpanel-${t.id}`, 'data-tab': t.id, 'aria-labelledby': `tab-${t.id}`, hidden: t.id !== activeOpsTab, class: 'tab-panel' }, t.content)))
}

function homeHeader(o, days) {
  const scope = o.env ?? 'all'
  return h('section', { class: 'page-head' },
    h('div', {}, h('p', { class: 'eyebrow' }, 'QA dashboard'), h('h1', {}, `${o.project} overview`),
      h('p', { class: 'hint' }, `${o.envs.length ? o.envs.join(', ') : 'No environments'} · last ${days} days`)),
    h('form', { class: 'filters', onsubmit: e => e.preventDefault() },
      h('label', {}, 'Environment', h('select', { name: 'env', onchange: e => go('/', { project: o.project, env: e.target.value, days }) },
        h('option', { value: 'all', selected: scope === 'all' }, 'All environments'),
        o.envs.map(name => h('option', { value: name, selected: scope === name }, name)))),
      h('label', {}, 'Window', h('select', { name: 'days', onchange: e => go('/', { project: o.project, env: scope, days: e.target.value }) },
        DAY_OPTIONS.map(d => h('option', { value: d, selected: d === days }, `Last ${d} days`))))))
}

// Repaints the statistics only. The run form and live output are left alone.
function paintHome(o) {
  document.getElementById('kpi-slot')?.replaceChildren(kpiRow(o))
  document.getElementById('project-slot')?.replaceChildren(projectCard(o))
  document.getElementById('home-body')?.replaceChildren(
    h('div', { class: 'grid2' }, passRatePanel(o), volumePanel(o)),
    h('div', { class: 'grid2' }, suiteSection(o), failingSection(o)),
    otherProjectsPanel(o) ?? '')
}

async function refreshHomeStats() {
  if (!onPage('/') || !document.getElementById('kpi-slot')) return
  const project = currentProjectId()
  if (!project) return
  const { days, env } = homeParams()
  const hashAtStart = location.hash
  let o
  try { o = await overviewFor(project, days, env) } catch { return }
  // Drop the answer if the user navigated while it was in flight.
  if (location.hash !== hashAtStart || !onPage('/')) return
  paintHome(o)
}

async function renderHome(seq) {
  app.dataset.page = 'home'
  stopPolling()
  const project = currentProjectId()
  if (!project) return app.replaceChildren(emptyState('No projects yet', 'Add a "project" to an environment in pipeline/config/environments.json.'))
  const { days, env } = homeParams()
  let o = null
  let failure = null
  try { o = await overviewFor(project, days, env) } catch (error) { failure = error }
  if (seq !== renderSeq) return
  app.replaceChildren(
    o ? homeHeader(o, days) : h('section', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'QA dashboard'), h('h1', {}, `${project} overview`))),
    h('div', { id: 'kpi-slot' }),
    h('div', { class: 'equal-row' }, h('div', { id: 'project-slot', class: 'slot' }), runForm()),
    liveLog() ?? '',
    h('div', { id: 'home-body', class: 'home-body' }),
    opsTabs() ?? '')
  if (o) paintHome(o)
  else document.getElementById('home-body').replaceChildren(h('section', { class: 'panel' }, `Dashboard unavailable: ${failure.message}`))
}

// ---- Reports: choose a project, then read its latest test report per suite and its execution history.
// Every list is scoped to the selected project, so runs from other projects never mix in.
function projectPicker(project) {
  return h('section', { class: 'panel', id: 'project-picker', 'aria-labelledby': 'project-picker-title' },
    h('div', { class: 'panel-head' }, h('h2', { id: 'project-picker-title' }, 'Projects'),
      h('span', { class: 'hint' }, `${state.projects.length} project${state.projects.length === 1 ? '' : 's'} · select one to see its reports`)),
    h('div', { class: 'project-options' }, state.projects.map(p => h('a', {
      class: 'project-option', href: `#/reports?project=${encodeURIComponent(p.id)}`,
      'aria-current': p.id === project ? 'page' : null,
    },
    h('span', { class: 'po-name' }, p.id),
    h('span', { class: 'hint' }, `${p.envs.join(', ') || 'No environment'} · ${p.runs} run${p.runs === 1 ? '' : 's'}`),
    h('span', { class: 'po-foot' }, p.latest ? badge(p.latest.status) : h('span', { class: 'badge' }, 'No runs yet'),
      p.latest ? h('span', { class: 'hint' }, when(p.latest.finishedAt)) : null)))))
}

function suiteReports(o) {
  return h('section', { class: 'panel', id: 'suite-reports' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Latest test report by suite'),
      h('span', { class: 'hint' }, o.env ? `Environment: ${o.env}` : 'All environments')),
    o.suites.length ? h('div', { class: 'suite-grid' }, o.suites.map(s => h('article', { class: 'suite-card' },
      h('div', { class: 'suite-head' }, h('strong', {}, s.suite), badge(s.status)),
      h('p', { class: 'hint' }, `${s.env ?? '—'} · finished ${when(s.finishedAt)}`),
      h('dl', { class: 'mini-stats' },
        h('div', {}, h('dt', {}, 'Passed'), h('dd', {}, s.counts.passed)),
        h('div', {}, h('dt', {}, 'Failed'), h('dd', {}, s.counts.failed)),
        h('div', {}, h('dt', {}, 'Blocked'), h('dd', {}, s.counts.blocked))),
      h('div', { class: 'actions' }, h('a', { class: 'btn primary-link', href: `#/runs/${encodeURIComponent(s.runId)}` }, 'Open report'))))) :
      emptyState('No suite reports yet', 'Each suite appears here after its first completed run in this project.'))
}

async function renderReports(seq) {
  app.dataset.page = 'reports'
  stopPolling()
  const project = currentProjectId()
  if (!project) return app.replaceChildren(emptyState('No projects yet', 'Add a "project" to an environment in pipeline/config/environments.json.'))
  const params = route().params
  const env = params.get('env') || 'all'
  const outcome = params.get('outcome') || 'all'
  let runs, overview
  try {
    [runs, overview] = await Promise.all([
      api(`/api/runs?${new URLSearchParams({ project, ...(env !== 'all' ? { env } : {}) })}`),
      api(`/api/overview?${new URLSearchParams({ project, days: '30', env })}`),
    ])
  } catch (error) {
    if (seq === renderSeq) app.replaceChildren(projectPickerOr(project), h('section', { class: 'panel' }, `Reports unavailable: ${error.message}`))
    return
  }
  if (seq !== renderSeq) return
  const info = state.projects.find(p => p.id === project)
  const filtered = runs.filter(r => outcomeMatches(r, outcome))
  const shown = filtered.slice(0, reportLimit)
  const newest = overview.latest
  app.replaceChildren(
    h('section', { class: 'page-head' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Reports'), h('h1', {}, 'Test reports'),
        h('p', { class: 'hint' }, 'Pick a project to see its latest test reports and execution history.'))),
    projectPicker(project),
    h('section', { class: 'panel project-summary', 'aria-label': `${project} summary` },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Selected project'), h('h2', {}, project)),
      h('p', { class: 'hint' }, `${info?.envs.length ? info.envs.join(', ') : 'No environments'} · ${runs.length} run${runs.length === 1 ? '' : 's'} · last finished ${newest ? when(newest.finishedAt) : '—'}`)),
    suiteReports(overview),
    h('section', { class: 'panel', id: 'run-history' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Execution history'),
        h('form', { class: 'filters filters-inline', onsubmit: e => e.preventDefault() },
          h('label', {}, 'Environment', h('select', { name: 'env', onchange: e => { reportLimit = 50; go('/reports', { project, env: e.target.value, outcome }) } },
            h('option', { value: 'all', selected: env === 'all' }, 'All environments'),
            (info?.envs ?? []).map(name => h('option', { value: name, selected: env === name }, name)))),
          h('label', {}, 'Outcome', h('select', { name: 'outcome', onchange: e => { reportLimit = 50; go('/reports', { project, env, outcome: e.target.value }) } },
            [['all', 'All'], ['passed', 'Passed'], ['not-passed', 'Not passed'], ['running', 'Running']].map(([v, label]) => h('option', { value: v, selected: outcome === v }, label)))))),
      h('p', { class: 'hint' }, `Showing ${shown.length} of ${filtered.length}`),
      filtered.length ? runsTable(shown) : emptyState(runs.length ? 'No runs match these filters' : 'No runs yet', runs.length ? 'Change the environment or outcome filter.' : 'Runs started from this dashboard or by a schedule appear here.'),
      filtered.length > shown.length ? h('button', { type: 'button', class: 'more', onclick: () => { reportLimit += 50; render() } }, 'Show 50 more') : null))
}

function projectPickerOr(project) {
  return state.projects.length ? projectPicker(project) : emptyState('No projects yet', 'Add a "project" to an environment in pipeline/config/environments.json.')
}

function outcomeMatches(run, outcome) {
  if (outcome === 'passed') return run.status === 'passed'
  if (outcome === 'not-passed') return !['passed', 'running'].includes(run.status)
  if (outcome === 'running') return run.status === 'running'
  return true
}


function runsTable(rows) {
  const admin = state.status?.role === 'admin'
  const headers = ['Started', 'Suite', 'Env', 'Status', 'Pass', 'Fail', 'Blocked', 'Duration', 'Report', 'Slack', ...(admin ? [''] : [])]
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map(t => h('th', { class: ['Pass', 'Fail', 'Blocked', 'Duration'].includes(t) ? 'num' : null }, t)))),
    h('tbody', {}, rows.map(r => h('tr', { class: 'click', onclick: () => { location.hash = `#/runs/${r.runId}` } },
      h('td', {}, when(r.startedAt)), h('td', {}, r.suite, r.seededDefect ? ` · ${r.seededDefect}` : ''),
      h('td', {}, r.env), h('td', {}, badge(r.status)),
      h('td', { class: 'num' }, r.counts?.passed ?? 0), h('td', { class: 'num' }, r.counts?.failed ?? 0), h('td', { class: 'num' }, r.counts?.blocked ?? 0),
      h('td', { class: 'num' }, secs(r.durationMs)),
      h('td', {}, h('a', { href: `#/runs/${r.runId}`, onclick: e => e.stopPropagation() }, 'Open report')),
      h('td', {}, r.slack?.length ? r.slack.map(n => h('span', { class: `badge ${n.ok ? 'ok' : 'warn'}` }, `${n.kind}: ${n.ok ? 'sent' : n.code}`)) : '—'),
      admin ? h('td', {}, deleteRunButton(r)) : null)))))
}

// Deletes one run only after the user confirms. Runs are never removed automatically.
function deleteRunButton(run) {
  const button = h('button', { class: 'danger', type: 'button', 'aria-label': `Delete run ${run.runId}`, onclick: async event => {
    event.stopPropagation()
    if (!confirm(`Delete this run permanently?\n\n${run.suite} · ${run.env} · ${when(run.startedAt)}\n\nThis cannot be undone.`)) return
    button.disabled = true
    try {
      await api(`/api/runs/${encodeURIComponent(run.runId)}`, { method: 'DELETE', headers: { 'x-qa-token': TOKEN } })
      await refresh()
      render()
    } catch (error) {
      button.disabled = false
      alert(`Could not delete this run: ${error.message}`)
    }
  } }, 'Delete')
  return button
}

// Administrators: add or remove people who can run tests, delete runs and create tickets. Admin view only.
function adminsPanel() {
  const admins = state.status?.admins
  if (state.status?.role !== 'admin' || !admins) return null
  const input = h('input', { type: 'email', name: 'email', required: true, placeholder: 'name@example.com', 'aria-label': 'Email address of the new administrator', autocomplete: 'off' })
  const message = h('p', { class: 'hint', role: 'status' })
  const form = h('form', { class: 'admin-add', onsubmit: async event => {
    event.preventDefault()
    const email = input.value.trim()
    if (!email) return
    message.textContent = 'Adding…'
    try {
      await post('/api/admins', { email })
      await refresh()
      await render()
    } catch (error) {
      message.textContent = error.message
      message.className = 'msg bad'
    }
  } }, input, h('button', { class: 'primary', type: 'submit' }, 'Make administrator'))
  return h('section', { class: 'panel', id: 'admins' }, h('h2', {}, 'Administrators'),
    h('p', { class: 'hint' }, 'Administrators can run every test suite, delete runs, create Jira tickets and add or remove other administrators. Viewers can only read results.'),
    form, message,
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Email'), h('th', {}, 'Added'), h('th', {}, 'By'), h('th', {}, ''))),
      h('tbody', {}, admins.map(adminRow)))))
}

function adminRow(a) {
  const remove = async () => {
    if (!confirm(`Remove administrator access for ${a.email}?`)) return
    try {
      await api(`/api/admins/${encodeURIComponent(a.email)}`, { method: 'DELETE', headers: { 'x-qa-token': TOKEN } })
      await refresh()
      await render()
    } catch (error) { alert(`Could not remove: ${error.message}`) }
  }
  const action = a.source === 'added'
    ? h('button', { class: 'danger', type: 'button', 'aria-label': `Remove administrator ${a.email}`, onclick: remove }, 'Remove')
    : h('span', { class: 'hint' }, 'Settings')
  return h('tr', {},
    h('td', {}, a.email),
    h('td', {}, a.source === 'settings' ? 'Server settings' : when(a.addedAt)),
    h('td', {}, a.source === 'settings' ? '—' : (a.addedBy ?? '—')),
    h('td', {}, action))
}

// Recent Google sign-ins, newest first. Only shown to the admin view.
function recentSignInsPanel() {
  const rows = state.status?.recentSignIns
  if (state.status?.role !== 'admin' || !rows) return null
  return h('section', { class: 'panel', id: 'recent-signins' }, h('h2', {}, 'Recent sign-ins'),
    rows.length ? h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Email'))),
      h('tbody', {}, rows.map(r => h('tr', {}, h('td', {}, when(r.at)), h('td', {}, r.email)))))) :
      emptyState('No sign-ins yet', 'Viewers who sign in with Google will appear here.'))
}

/** A friendly placeholder for a section with nothing to show yet: a title, an optional next step, and no fake data. */
function emptyState(title, detail) {
  return h('div', { class: 'empty-state' },
    h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, '–'),
    h('div', {}, h('p', { class: 'empty-title' }, title), detail ? h('p', { class: 'hint' }, detail) : ''))
}

/** Plain-language cron. Only the shapes the hosted schedules use are named; anything else shows the raw expression. */
function describeCron(cron = '') {
  const parts = String(cron).trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [minute, hour, day, month, weekday] = parts
  if (minute === '0' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'Every hour, on the hour'
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') return `Daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  return cron
}

function scheduleCard(s) {
  const ready = s.enabled && s.readiness?.ready
  const [label, tone] = !s.enabled ? ['Disabled', 'info'] : ready ? ['Ready', 'ok'] : ['Blocked', 'bad']
  return h('article', { class: `schedule${s.enabled && !ready ? ' needs-fix' : ''}` },
    h('div', { class: 'schedule-head' }, h('strong', { class: 'mono' }, s.id), h('span', { class: `badge ${tone}` }, label)),
    h('dl', { class: 'schedule-meta' },
      h('dt', {}, 'Suite'), h('dd', {}, s.suite),
      h('dt', {}, 'Target'), h('dd', {}, s.env),
      h('dt', {}, 'When'), h('dd', {}, describeCron(s.cron))),
    s.enabled && !ready && s.readiness?.reason ? h('p', { class: 'callout' }, s.readiness.reason) : '')
}

function schedulePanel() {
  const schedules = state.status.schedules ?? []
  const enabled = schedules.filter(s => s.enabled)
  const ready = enabled.filter(s => s.readiness?.ready).length
  return h('section', { class: 'panel', id: 'schedules' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Schedule configuration'),
      enabled.length ? h('span', { class: `badge ${ready === enabled.length ? 'ok' : 'bad'}` }, `${ready} of ${enabled.length} ready`) : ''),
    h('p', { class: 'hint' }, 'Configuration checks only. Completed runs establish runtime and target health.'),
    schedules.length ? h('div', { class: 'schedule-grid' }, schedules.map(scheduleCard))
      : emptyState('No schedules configured', 'Add a schedule to pipeline/config/schedules.hosted.json.'))
}

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

// ---- Shared chart helpers. Inline SVG, no library. Values are written with textContent or setAttribute only.
const SVG_NS = 'http://www.w3.org/2000/svg'
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  el.append(...children.filter(c => c != null))
  return el
}
// Only https links are made clickable; anything else is shown as plain text.
function externalLink(url, text) {
  const a = h('a', { target: '_blank', rel: 'noopener noreferrer' }, text)
  try { if (new URL(url).protocol === 'https:') a.setAttribute('href', url) } catch { /* not a link */ }
  return a
}

function failingTable(rows) {
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', { class: 'num' }, 'Failed'), h('th', { class: 'num' }, 'Flaky'), h('th', { class: 'num' }, 'Runs'), h('th', {}, 'First failed'), h('th', {}, 'Last failed'))),
    h('tbody', {}, rows.map(r => h('tr', {},
      h('td', {}, r.title,
        r.failures ? h('details', {}, h('summary', {}, 'Latest failure details'),
          h('p', { class: 'hint' }, r.lastFailure ? `${r.lastFailure.classification}${r.lastFailure.reason ? ` · ${r.lastFailure.reason}` : ''}` : ''),
          h('pre', { class: 'log' }, r.lastFailure?.message ?? 'No failure details recorded.'),
          r.lastFailure?.runId ? h('a', { href: `#/runs/${encodeURIComponent(r.lastFailure.runId)}/failures` }, 'View failing run and evidence') : null) : ''),
      h('td', { class: 'num' }, r.failures), h('td', { class: 'num' }, r.flaky), h('td', { class: 'num' }, r.executions),
      h('td', {}, when(r.firstFailedAt)), h('td', {}, when(r.lastFailedAt)))))))
}

// Messages for the fixed reason codes the server puts in '#signin-error=<code>' after a refused sign-in.
const SIGN_IN_ERRORS = {
  google_declined: 'Google sign-in was cancelled. Choose Continue with Google to try again.',
  expired_or_invalid_state: 'That sign-in expired or was started in another browser. Start again below.',
  token_exchange_failed: 'Google could not confirm your account. Try again in a moment.',
  email_not_verified: 'Your Google email address is not verified. Verify it with Google, then try again.',
  not_allowed: 'This Google account does not have dashboard access. Ask an administrator to add it.',
  default: 'Sign-in did not finish. Try again, or ask an administrator if it keeps failing.',
}
function signInError() {
  const match = /^#signin-error=([a-z_]+)$/.exec(location.hash)
  if (!match) return null
  return SIGN_IN_ERRORS[match[1]] ?? SIGN_IN_ERRORS.default
}

// Google's multicolour "G" mark for the sign-in button (Google's sign-in branding uses the official logo).
const GOOGLE_G = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">'
  + '<path fill="#EA4335" d="M9 3.48c1.69 0 2.83.73 3.48 1.34l2.54-2.48C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l2.91 2.26C4.6 5.05 6.62 3.48 9 3.48z"/>'
  + '<path fill="#4285F4" d="M17.64 9.2c0-.74-.06-1.28-.19-1.84H9v3.34h4.96c-.1.83-.64 2.08-1.84 2.92l2.84 2.2c1.7-1.57 2.68-3.88 2.68-6.62z"/>'
  + '<path fill="#FBBC05" d="M3.88 10.78A5.54 5.54 0 0 1 3.58 9c0-.62.11-1.22.29-1.78L.96 4.96A9.008 9.008 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.92-2.26z"/>'
  + '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.84-2.2c-.76.53-1.78.9-3.12.9-2.38 0-4.4-1.57-5.12-3.74L.97 13.04C2.45 15.98 5.48 18 9 18z"/>'
  + '</svg>'

function signInPanel() {
  const error = signInError()
  const googleIcon = h('span', { class: 'g-icon' })
  googleIcon.innerHTML = GOOGLE_G // constant markup above, never user input
  return h('section', { class: 'signin' },
    h('div', { class: 'signin-card' },
      h('img', { class: 'signin-mark', src: '/assets/logo-mpc.png', alt: '', width: 936, height: 432 }),
      h('h1', {}, 'Sign in to MPC QA Dashboard'),
      h('p', { class: 'signin-lead' }, 'See test runs, failure evidence and trends with your Google account.'),
      error ? h('p', { class: 'signin-error', role: 'alert' }, error) : null,
      h('a', { class: 'btn-google', href: '/auth/google/start' }, googleIcon, 'Continue with Google'),
      h('ul', { class: 'signin-points' },
        h('li', {}, 'Read runs, results, evidence and trends'),
        h('li', {}, 'Starting runs and creating tickets need an administrator')),
      h('p', { class: 'signin-note' }, 'There is no separate sign-up. Your first Google sign-in gives you viewer access.')))
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

// Which report category a test belongs to. Used by the run drill-down.
function categoryOf(run, t) {
  const suite = run.steps.find(s => s.name === t.step)?.fromSuite
  if (suite != null) return [...REPORT_CATEGORIES.map(c => c.suite), 'uat'].includes(suite) ? suite : 'other'
  return t.adapter === 'k6' ? 'load' : t.project === 'api' ? 'api' : t.project === 'uat' || t.adapter === 'webmpc-scenarios' ? 'uat' : t.project === 'chromium' ? 'regression' : 'other'
}

// Drill-down: outcome filter chips and a search box narrow the list; each failing case opens its own details.
function testsPanel(run) {
  const FILTERS = [['all', 'All'], ['failed', 'Failed'], ['passed', 'Passed'], ['blocked', 'Blocked'], ['skipped', 'Skipped'], ['flaky', 'Flaky']]
  const countOf = key => (key === 'all' ? run.tests.length : key === 'flaky' ? run.tests.filter(t => t.flaky).length : run.tests.filter(t => t.status === key).length)
  let filter = 'all', query = ''
  const buttons = FILTERS.map(([key, label]) => ({ key, el: h('button', { type: 'button', class: 'chip-button', 'aria-pressed': 'false', onclick: () => { filter = key; draw() } }, `${label} ${countOf(key)}`) }))
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search test or step', 'aria-label': 'Search tests', autocomplete: 'off',
    oninput: e => { query = e.target.value.trim().toLowerCase(); draw() } })
  const body = h('div', { class: 'test-body' })
  const matches = t => {
    if (filter === 'flaky' ? !t.flaky : filter !== 'all' && t.status !== filter) return false
    return !query || `${t.title} ${t.step ?? ''}`.toLowerCase().includes(query)
  }
  function draw() {
    for (const b of buttons) b.el.setAttribute('aria-pressed', String(b.key === filter))
    const list = run.tests.filter(matches)
    const sections = [...REPORT_CATEGORIES, { suite: 'uat', label: 'UAT scenarios' }, { suite: 'other', label: 'Other checks' }].flatMap(({ suite, label }) => {
      const rows = list.filter(t => categoryOf(run, t) === suite)
      return rows.length ? [h('h3', {}, label), testTable(run.runId, rows)] : []
    })
    body.replaceChildren(...(list.length ? sections : [emptyState('No tests match', 'Clear the filter or the search to see every case.')]))
  }
  draw()
  return h('section', { class: 'panel', id: 'test-results' }, h('h2', {}, `Tests (${run.tests.length})`),
    h('div', { class: 'test-tools' }, h('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Filter tests by outcome' }, buttons.map(b => b.el)), search),
    body)
}

function testTable(runId, list) {
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Duration'), h('th', {}, 'Evidence'))),
    h('tbody', {}, list.map(t => {
      const errors = (t.errors ?? []).map(plain).filter(Boolean)
      const classification = [t.classification?.kind, t.classification?.reason].filter(Boolean).join(' · ')
      return h('tr', {},
        h('td', {}, t.title, h('div', { class: 'hint' }, t.step), t.skipReason ? h('div', { class: 'hint' }, t.skipReason) : null,
          errors.length || classification || t.infra ? h('details', { class: 'detail' }, h('summary', {}, 'Failure details'),
            h('dl', { class: 'kv' },
              h('dt', {}, 'Classification'), h('dd', {}, classification || '—'),
              h('dt', {}, 'Infrastructure'), h('dd', {}, t.infra ?? '—'),
              h('dt', {}, 'Retries'), h('dd', {}, String(t.retries ?? 0))),
            errors.length ? h('pre', { class: 'log' }, errors.join('\n\n')) : null) : null),
        h('td', {}, badge(t.status), t.flaky ? h('span', { class: 'badge warn' }, 'flaky') : null),
        h('td', { class: 'num' }, secs(t.durationMs)),
        h('td', { class: 'links' }, (t.evidence ?? []).map(e => h('a', { href: fileUrl(runId, e.path), target: '_blank', rel: 'noopener noreferrer' }, e.name))))
    }))))
}

async function renderRun(runId, anchor) {
  stopPolling()
  app.dataset.page = 'run'
  app.replaceChildren(h('section', { class: 'panel' }, 'Loading…'))
  let run
  try { run = await api(`/api/runs/${encodeURIComponent(runId)}`) } catch (error) {
    app.replaceChildren(h('section', { class: 'panel' }, h('a', { href: '#/reports' }, '← Reports'), h('p', {}, error.message))); return
  }
  const c = run.counts
  const tickets = await api('/api/jira/tickets').catch(() => [])
  const project = state.projects.find(p => p.envs.includes(run.env))?.id ?? run.project ?? 'unassigned'
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
    h('a', { href: '#/' }, 'Home'), ' / ', h('a', { href: `#/reports?project=${encodeURIComponent(project)}` }, `${project} reports`), ' / ', h('span', {}, run.runId))
  const overview = h('section', { class: 'panel' },
    h('h2', {}, `${run.suite} on ${run.env} `, badge(run.status)),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Run'), h('dd', {}, run.runId),
      h('dt', {}, 'Project'), h('dd', {}, project),
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
  app.replaceChildren(crumbs, overview, testsPanel(run), h('div', { class: 'grid2' }, ...extra.slice(0, 2)), failures, steps, ...extra.slice(2), systemHealth(run.health, true))
  if (anchor === 'failures') document.getElementById('failures')?.scrollIntoView()
}

async function render() {
  const seq = ++renderSeq
  const { path } = route()
  const m = path.match(/^\/runs\/([\w-]+)(?:\/(failures))?$/)
  if (!state.status) {
    try { await refresh() } catch (error) { app.replaceChildren(error.signIn ? signInPanel() : h('section', { class: 'panel' }, `Dashboard API unavailable: ${error.message}`)); return }
  }
  if (seq !== renderSeq) return
  renderNav()
  if (m) return renderRun(m[1], m[2])
  if (path === '/reports') return renderReports(seq)
  return renderHome(seq)
}

window.addEventListener('hashchange', () => render())
setInterval(() => refresh().catch(() => {}), 10_000)
// The statistics recompute once a minute; only the stats are repainted, never the run form.
setInterval(() => { if (!document.hidden) refreshHomeStats() }, 60_000)
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
