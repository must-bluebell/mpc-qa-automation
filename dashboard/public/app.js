// MPC QA dashboard. All server data is rendered with textContent (never innerHTML): test titles, error
// messages and logs come from the app under test and must be treated as untrusted.
const TOKEN = document.querySelector('meta[name="qa-token"]').content
const app = document.getElementById('app')
const chips = document.getElementById('chips')
let state = { status: null, stack: null, runs: [], watching: null }
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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) })

const STATUS_CLASS = { passed: 'ok', failed: 'bad', 'infra-failed': 'warn', timeout: 'warn', blocked: 'warn', crashed: 'bad', running: '' }
const badge = s => h('span', { class: `badge ${STATUS_CLASS[s] ?? ''}` }, s)
const secs = ms => (ms == null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
const when = iso => (iso ? `${new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hourCycle: 'h23' })} KST` : '—')
const fileUrl = (runId, rel) => `/api/runs/${encodeURIComponent(runId)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`

function renderChips() {
  const s = state.status
  chips.replaceChildren()
  if (!s) return
  const stack = state.stack
  chips.append(
    s.running ? h('span', { class: 'chip warn' }, `Running ${s.running.runId}`) : h('span', { class: 'chip ok' }, 'Idle'),
    stack ? h('span', { class: `chip ${stack.healthy ? 'ok' : 'bad'}` }, `Stack ${stack.project}: ${stack.healthy ? 'healthy' : stack.error ?? 'unhealthy'}`) : h('span', { class: 'chip' }, 'Stack …'),
    h('span', { class: `chip ${s.slack.valid ? 'ok' : s.slack.configured ? 'bad' : 'warn'}` }, `Slack ${s.slack.valid ? 'configured' : s.slack.configured ? s.slack.reason || 'invalid configuration' : 'not configured'}`),
    h('span', { class: `chip ${s.ai.configured ? 'ok' : 'warn'}` }, `AI ${s.ai.configured ? `${s.ai.provider} · ${s.ai.model}` : 'not configured'}`),
  )
}

async function refresh() {
  const [status, runs] = await Promise.all([api('/api/status'), api('/api/runs')])
  state.status = status
  state.runs = runs
  renderChips()
  api('/api/stack').then(stack => { state.stack = stack; renderChips() }).catch(() => {})
}

function runForm() {
  const s = state.status
  const msg = h('div', { class: 'msg', role: 'status' })
  const suite = h('select', { name: 'suite' }, s.suites.map(x => h('option', { value: x.name, selected: x.name === 'full' }, x.name)))
  const env = h('select', { name: 'env' }, s.environments.map(x => h('option', { value: x.name, selected: x.name === 'local-docker' }, x.name)))
  const defect = h('select', { name: 'defect' }, h('option', { value: '' }, 'none'), s.seededDefects.map(x => h('option', { value: x.name }, `${x.name} (${x.kind})`)))
  const ai = h('input', { type: 'checkbox', name: 'ai', checked: s.ai.configured && s.ai.auto })
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
      state.watching = runId
      await refresh()
      render()
    } catch (error) { msg.className = 'msg badge bad'; msg.textContent = error.message }
  }
  const running = !!s.running
  return h('section', { class: 'panel' },
    h('h2', {}, 'Run tests'),
    h('form', { class: 'run', onsubmit: e => { e.preventDefault(); start({ suite: suite.value, env: env.value, seedDefect: defect.value || null, ai: ai.checked }) } },
      h('label', {}, 'Suite', suite), h('label', {}, 'Environment', env), h('label', {}, 'Seeded defect', defect),
      h('label', { class: 'check' }, ai, 'AI review'),
      h('button', { class: 'primary', type: 'submit', disabled: running }, running ? 'Run in progress' : 'Run')),
    desc,
    h('div', { class: 'actions' },
      h('button', { type: 'button', disabled: running, onclick: () => start({ suite: 'full', env: 'local-docker', ai: ai.checked }) }, 'Run everything (full)'),
      h('button', { type: 'button', disabled: running, onclick: () => start({ suite: 'smoke', env: 'local-docker', ai: ai.checked }) }, 'Smoke'),
      h('button', { type: 'button', onclick: async () => {
        msg.className = 'msg'; msg.textContent = 'Sending Slack test…'
        try { const r = await post('/api/slack/test'); msg.className = `msg badge ${r.ok ? 'ok' : 'warn'}`; msg.textContent = r.ok ? 'Slack test delivered' : `Slack not delivered: ${r.code}` }
        catch (error) { msg.className = 'msg badge bad'; msg.textContent = error.message }
      } }, 'Send Slack test')),
    msg,
    h('p', { class: 'hint' }, 'UAT and load run only against the isolated local Docker stack; the pipeline refuses them elsewhere. Runs never touch production or staging with writes.'))
}

function liveLog() {
  stopPolling()
  const id = state.watching ?? state.status.running?.runId
  if (!id) return null
  const pre = h('pre', { class: 'log' }, 'Waiting for output…')
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
    try {
      const r = await api(`/api/jobs/${encodeURIComponent(id)}/log`)
      if (cancelled) return
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20
      const text = r.log || '(no output yet)'
      if (pre.textContent !== text) pre.textContent = text
      if (atBottom) pre.scrollTop = pre.scrollHeight
      if (!r.running) {
        clearInterval(pollTimer)
        pollTimer = null
        await refresh()
        if (cancelled) return
        // Keep the completed output mounted. Rebuilding home here starts another poller for
        // state.watching, creating an endless completion/render loop and resetting scroll.
        if (location.hash === '' || location.hash === '#/') {
          app.firstElementChild.replaceWith(runForm())
          app.lastElementChild.replaceWith(runsTable())
        }
      }
    } catch { /* job log not created yet */ }
    finally { pending = false }
  }
  pollTimer = setInterval(tick, 2000)
  tick()
  return h('section', { class: 'panel' }, h('h2', {}, 'Live output'), head, pre)
}

function runsTable() {
  if (!state.runs.length) return h('section', { class: 'panel' }, h('h2', {}, 'Run history'), h('p', { class: 'empty' }, 'No runs yet.'))
  return h('section', { class: 'panel' }, h('h2', {}, 'Run history'), h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Started', 'Suite', 'Env', 'Status', 'Pass', 'Fail', 'Blocked', 'Duration', 'Slack'].map(t => h('th', { class: ['Pass', 'Fail', 'Blocked', 'Duration'].includes(t) ? 'num' : null }, t)))),
    h('tbody', {}, state.runs.map(r => h('tr', { class: 'click', onclick: () => { location.hash = `#/runs/${r.runId}` } },
      h('td', {}, when(r.startedAt)), h('td', {}, r.suite, r.seededDefect ? ` · ${r.seededDefect}` : ''), h('td', {}, r.env), h('td', {}, badge(r.status)),
      h('td', { class: 'num' }, r.counts?.passed ?? 0), h('td', { class: 'num' }, r.counts?.failed ?? 0), h('td', { class: 'num' }, r.counts?.blocked ?? 0),
      h('td', { class: 'num' }, secs(r.durationMs)),
      h('td', {}, r.slack?.length ? r.slack.map(n => h('span', { class: `badge ${n.ok ? 'ok' : 'warn'}` }, `${n.kind}: ${n.ok ? 'sent' : n.code}`)) : '—')))))))
}

function renderHome() {
  app.replaceChildren(runForm(), liveLog() ?? '', runsTable())
}

async function renderRun(runId, anchor) {
  stopPolling()
  app.replaceChildren(h('section', { class: 'panel' }, 'Loading…'))
  let run
  try { run = await api(`/api/runs/${encodeURIComponent(runId)}`) } catch (error) {
    app.replaceChildren(h('section', { class: 'panel' }, h('a', { href: '#/' }, '← All runs'), h('p', {}, error.message))); return
  }
  const c = run.counts
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
      h('ul', {}, g.tests.map(t => h('li', {}, t.title))))) : h('p', { class: 'empty' }, 'No failures.'))

  const tests = h('section', { class: 'panel' }, h('h2', {}, `Tests (${run.tests.length})`), h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Duration'), h('th', {}, 'Evidence'))),
    h('tbody', {}, run.tests.map(t => h('tr', {},
      h('td', {}, t.title, h('div', { class: 'hint' }, t.step)), h('td', {}, badge(t.status), t.flaky ? h('span', { class: 'badge warn' }, 'flaky') : ''),
      h('td', { class: 'num' }, secs(t.durationMs)),
      h('td', { class: 'links' }, (t.evidence ?? []).slice(0, 4).map(e => h('a', { href: fileUrl(run.runId, e.path), target: '_blank', rel: 'noopener noreferrer' }, e.name)))))))))

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
  app.replaceChildren(overview, h('div', { class: 'grid2' }, ...extra.slice(0, 2)), failures, steps, ...extra.slice(2), tests)
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
refresh().then(render).catch(error => app.replaceChildren(h('section', { class: 'panel' }, `Dashboard API unavailable: ${error.message}`)))
