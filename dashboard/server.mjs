#!/usr/bin/env node
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync, watch } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, RUNS_DIR, config, knownSecrets, resolveEnvironment } from '../pipeline/lib/env.mjs'
import { isRunId, newRunId, readIndex, readRun, runDir } from '../pipeline/lib/run-store.mjs'
import { runStatus } from '../pipeline/lib/run-status.mjs'
import { readLock } from '../pipeline/lib/lock.mjs'
import { stackStatus } from '../pipeline/adapters/local-stack.mjs'
import { PROFILES } from '../pipeline/chaos/proxy.mjs'
import { aiConfig } from '../pipeline/ai/providers.mjs'
import { aiArgs } from '../pipeline/ai/policy.mjs'
import { notifyEvent } from '../pipeline/notify/slack.mjs'
import { sendBotTest } from '../pipeline/notify/slack-bot.mjs'
import { slackStatus } from './slack-settings.mjs'
import { expandSuite, guard } from '../pipeline/orchestrator.mjs'
import { outputRedactor } from '../pipeline/lib/output-redactor.mjs'
import { REPORT_CATEGORIES } from '../pipeline/lib/safe-output.mjs'

/**
 * Local QA dashboard: browse run history and start suites without opening the WEB MPC project.
 * Security model: loopback bind only; Host header pinned (blocks DNS rebinding); every state-changing
 * API access needs a private startup-link session; state-changing requests also need the per-process
 * token from the served page, a JSON body and a same-origin Origin;
 * suite/env/defect names are whitelisted from config; artifact paths cannot leave their run folder;
 * text artifacts are re-redacted on the way out; nothing secret is ever returned, only "configured" flags.
 */
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public')
// Hosted mode (e.g. Render): set QA_DASHBOARD_HOST=0.0.0.0 and the platform's public hostname. Default stays loopback-only.
const HOST = process.env.QA_DASHBOARD_HOST || '127.0.0.1'
const PORT = Number(process.env.QA_DASHBOARD_PORT || process.env.PORT || 4500)
const PUBLIC_HOST = (process.env.QA_DASHBOARD_PUBLIC_HOST || process.env.RENDER_EXTERNAL_HOSTNAME || '').trim().toLowerCase()
if (PUBLIC_HOST && !/^[a-z0-9.-]+$/.test(PUBLIC_HOST)) throw new Error('QA_DASHBOARD_PUBLIC_HOST must be a bare hostname')
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(PUBLIC_HOST ? [PUBLIC_HOST] : [])])
const ALLOWED_ORIGINS = new Set([
  ...[`127.0.0.1:${PORT}`, `localhost:${PORT}`].map(h => `http://${h}`),
  ...(PUBLIC_HOST ? [`https://${PUBLIC_HOST}`] : []),
])
const TOKEN = randomBytes(32).toString('hex')
// Independent of the public page's CSRF token: only the launching user's terminal receives this key.
// A fixed token (min 32 chars) survives redeploys when hosted; otherwise a fresh one is generated per start.
const FIXED_ACCESS_TOKEN = process.env.QA_DASHBOARD_ACCESS_TOKEN || ''
if (FIXED_ACCESS_TOKEN && FIXED_ACCESS_TOKEN.length < 32) throw new Error('QA_DASHBOARD_ACCESS_TOKEN must be at least 32 characters')
const ACCESS_TOKEN = FIXED_ACCESS_TOKEN || randomBytes(32).toString('hex')
const SESSION_COOKIE = `mpc_qa_session_${PORT}`
const JOB_LOG_DIR = join(RUNS_DIR, '.dashboard')
const MAX_BODY = 4_096
const REDACT_LIMIT = 8 * 1024 * 1024

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm',
  '.zip': 'application/zip', '.svg': 'image/svg+xml',
}
const TEXT = new Set(['.json', '.md', '.log', '.txt', '.html', '.mjs', '.js', '.ts', '.svg', '.css'])

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
// Playwright HTML reports are self-contained inline apps; they run sandboxed in an opaque origin with no network.
const REPORT_CSP = "sandbox allow-scripts allow-popups; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src data:; connect-src 'self' data: blob:; frame-ancestors 'none'"

/** Jobs started from this dashboard process: runId → { pid, startedAt, exitCode, logFile }. */
const jobs = new Map()

const redact = text => { for (const s of knownSecrets()) text = text.split(s).join('[REDACTED]'); return text }

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body)
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Security-Policy': APP_CSP, 'X-Frame-Options': 'DENY',
    'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers })
  res.end(json ? JSON.stringify(body) : body)
}

function tokenOk(req) {
  const given = Buffer.from(String(req.headers['x-qa-token'] ?? ''))
  const want = Buffer.from(TOKEN)
  return given.length === want.length && timingSafeEqual(given, want)
}

function accessOk(value) {
  if (typeof value !== 'string') return false
  const given = Buffer.from(value), want = Buffer.from(ACCESS_TOKEN)
  return given.length === want.length && timingSafeEqual(given, want)
}
function sessionOk(req) {
  const cookie = String(req.headers.cookie ?? '').split(';').map(c => c.trim())
    .find(c => c.startsWith(`${SESSION_COOKIE}=`))
  return accessOk(cookie?.slice(SESSION_COOKIE.length + 1))
}

async function readBody(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 })
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
}

function busy() {
  const lock = readLock()
  if (lock && !lock.stale) return { runId: lock.runId, startedAt: lock.startedAt }
  const live = [...jobs.values()].find(j => j.exitCode === undefined)
  return live ? { runId: live.runId, startedAt: live.startedAt } : null
}

// Normal saveRun writes invalidate synchronously through the index signature; manual run.json
// repairs invalidate when the filesystem event arrives. Without a watcher, revalidate each poll.
// Cache negative lookups too: a history with no load run must not be decoded on every poll.
const categoryRuns = new Map()
let categoryCache = null, categoryIndexVersion, categoryWatcher
function fileVersion(file) {
  try { const s = statSync(file, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` } catch { return null }
}
function watchCategoryRuns() {
  if (categoryWatcher) return true
  try {
    categoryWatcher = watch(RUNS_DIR, { recursive: true }, (_event, filename) => {
      const parts = String(filename ?? '').split(/[\\/]/)
      if (!filename) { categoryCache = null; categoryRuns.clear(); return }
      if (parts.length === 1 && parts[0] === 'index.json') {
        if (fileVersion(join(RUNS_DIR, 'index.json')) !== categoryIndexVersion) categoryCache = null
      } else if (isRunId(parts[0]) && (parts.at(-1) === 'run.json' || parts.length === 1)) {
        const cached = categoryRuns.get(parts[0])
        if (!cached || cached.version !== fileVersion(join(runDir(parts[0]), 'run.json'))) categoryCache = null
      }
    })
    categoryWatcher.on('error', () => {
      categoryWatcher?.close()
      categoryWatcher = null
      categoryCache = null
      categoryRuns.clear()
    })
    categoryWatcher.unref()
    categoryCache = null // Revalidate changes made before this watcher was established.
    return true
  } catch { return false }
}
function cachedCategoryRun(runId) {
  if (!isRunId(runId)) return null
  const version = fileVersion(join(runDir(runId), 'run.json'))
  const cached = categoryRuns.get(runId)
  if (cached && cached.version === version) return cached.run
  const run = readRun(runId)
  categoryRuns.set(runId, { version, run })
  return run
}
function categoryMatches(suite, source, project, adapter) {
  // Explicit suite provenance wins over adapter/project guesses in combined runs.
  if (source != null && source !== '') return source === suite
  return (suite === 'api' && project === 'api') || (suite === 'regression' && project === 'chromium')
    || (suite === 'load' && adapter === 'k6')
}
function latestCategoryResults() {
  const watching = watchCategoryRuns()
  const version = fileVersion(join(RUNS_DIR, 'index.json'))
  if (watching && categoryCache && version === categoryIndexVersion) return categoryCache
  const latest = new Map()
  const index = readIndex()
  const runIds = new Set(index.map(r => r.runId))
  for (const runId of categoryRuns.keys()) if (!runIds.has(runId)) categoryRuns.delete(runId)
  const entries = index.filter(r => r.env === 'local-docker' && r.finishedAt && !r.seededDefect && !r.reportOnly && !['running', 'skipped-overlap'].includes(r.status))
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
  for (const entry of entries) {
    const run = cachedCategoryRun(entry.runId)
    if (!run || run.reportOnly || run.seededDefect || run.env !== 'local-docker' || !run.finishedAt || ['running', 'skipped-overlap'].includes(run.status)) continue
    for (const { suite } of REPORT_CATEGORIES) {
      if (latest.has(suite)) continue
      const steps = (run.steps ?? []).filter(step => categoryMatches(suite, step.fromSuite ?? run.suite, step.project, step.adapter))
      const tests = (run.tests ?? []).filter(t => {
        const step = run.steps?.find(s => s.name === t.step)
        return categoryMatches(suite, step?.fromSuite ?? run.suite, t.project ?? step?.project, t.adapter ?? step?.adapter)
      })
      const executionFailed = steps.some(s => s.timedOut || s.errors?.length || (s.exitCode != null && s.exitCode !== 0))
      if (!tests.length && !executionFailed) continue
      const counts = Object.fromEntries(['passed', 'failed', 'skipped', 'blocked'].map(status => [status, tests.filter(t => t.status === status).length]))
      const status = executionFailed ? runStatus({ tests, steps })
        : counts.failed ? 'failed' : counts.blocked ? 'blocked' : counts.passed ? 'passed' : 'skipped'
      latest.set(suite, { suite, runId: run.runId, env: run.env, finishedAt: run.finishedAt, status, counts })
    }
    if (latest.size === REPORT_CATEGORIES.length) break
  }
  categoryIndexVersion = version
  categoryCache = REPORT_CATEGORIES.flatMap(({ suite }) => latest.has(suite) ? [latest.get(suite)] : [])
  return categoryCache
}

function status() {
  const suites = config.suites()
  const envs = config.environments()
  const ai = aiConfig()
  return {
    running: busy(),
    jobs: [...jobs.values()].map(({ runId, suite, env, startedAt, exitCode, notify }) => ({ runId, suite, env, startedAt, exitCode: exitCode ?? null, notify })),
    suites: Object.entries(suites).map(([name, s]) => ({ name, description: s.description, include: s.include ?? null, requiresIsolated: !!s.requiresIsolated, requiresLoad: !!s.requiresLoad })),
    environments: Object.entries(envs).map(([name, e]) => ({ name, description: e.description, isolated: !!e.isolated, allowWrites: !!e.allowWrites, allowLoad: !!e.allowLoad })),
    seededDefects: Object.entries(PROFILES).map(([name, p]) => ({ name, kind: p.kind, description: p.description })),
    slack: slackStatus(),
    ai: { provider: ai.provider, configured: ai.configured, model: ai.configured ? ai.model : null, auto: process.env.QA_AI_AUTO === '1' },
    schedules: config.schedules().schedules,
    categoryResults: latestCategoryResults(),
  }
}

function startRun({ suite, env, seedDefect, ai, notify }) {
  const suites = config.suites()
  const envs = config.environments()
  if (typeof suite !== 'string' || !Object.hasOwn(suites, suite)) throw Object.assign(new Error('Unknown suite'), { status: 400 })
  if (typeof env !== 'string' || !Object.hasOwn(envs, env)) throw Object.assign(new Error('Unknown environment'), { status: 400 })
  if (notify != null && typeof notify !== 'boolean') throw Object.assign(new Error('Slack alerts must be enabled or disabled'), { status: 400 })
  if (seedDefect != null && seedDefect !== '' && (typeof seedDefect !== 'string' || !Object.hasOwn(PROFILES, seedDefect))) throw Object.assign(new Error('Unknown seeded defect'), { status: 400 })
  const holder = busy()
  if (holder) throw Object.assign(new Error(`A run is already in progress (${holder.runId})`), { status: 409 })
  // Same policy checks the orchestrator applies, reported immediately instead of as a failed job.
  const resolved = resolveEnvironment(env)
  try { guard({ suiteName: suite, env: resolved, steps: expandSuite(suite, suites), seededDefect: seedDefect || null }) } catch (error) { throw Object.assign(error, { status: 422 }) }

  const runId = newRunId(suite)
  const args = [join(ROOT, 'pipeline/orchestrator.mjs'), '--suite', suite, '--env', env, '--run-id', runId, '--trigger', 'dashboard']
  if (seedDefect) args.push('--seed-defect', seedDefect)
  if (notify === false) args.push('--no-notify')
  args.push(...aiArgs(ai))
  mkdirSync(JOB_LOG_DIR, { recursive: true, mode: 0o700 })
  const logFile = join(JOB_LOG_DIR, `${runId}.log`)
  const log = createWriteStream(logFile, { mode: 0o600 })
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const job = { runId, suite, env, pid: child.pid, startedAt: new Date().toISOString(), logFile, exitCode: undefined, notify: notify !== false }
  jobs.set(runId, job)
  const stdout = outputRedactor(text => log.write(text)), stderr = outputRedactor(text => log.write(text))
  child.stdout.on('data', chunk => stdout.write(chunk))
  child.stderr.on('data', chunk => stderr.write(chunk))
  child.on('error', error => { log.write(redact(`\n${error.message}\n`)); job.exitCode = -1 })
  child.on('close', code => { stdout.end(); stderr.end(); job.exitCode = code ?? -1; log.end() })
  return { runId }
}

function jobLog(runId) {
  const job = jobs.get(runId)
  const file = job?.logFile ?? join(JOB_LOG_DIR, `${runId}.log`)
  if (!existsSync(file)) return null
  const fd = openSync(file, 'r')
  let text
  try {
    const size = fstatSync(fd).size
    // Four bytes per character, plus overlap for a secret crossing the beginning of the read.
    const overlap = Math.max(0, ...knownSecrets().map(s => Buffer.byteLength(s)))
    const length = Math.min(size, 60_000 * 4 + overlap), buffer = Buffer.alloc(length)
    let bytes = 0
    while (bytes < length) {
      const read = readSync(fd, buffer, bytes, length - bytes, size - length + bytes)
      if (!read) break
      bytes += read
    }
    text = redact(buffer.subarray(0, bytes).toString('utf8')).slice(-60_000)
    if (/^[\uDC00-\uDFFF]/.test(text)) text = text.slice(1)
  } finally { closeSync(fd) }
  return { runId, exitCode: job?.exitCode ?? null, running: job ? job.exitCode === undefined : false, log: text }
}

/** Serves a file inside runs/<id>/ only. Symlinks are resolved first, so they cannot point outside either. */
function serveArtifact(res, runId, rel) {
  if (!isRunId(runId)) return send(res, 400, { error: 'Invalid run id' })
  let decoded
  try { decoded = decodeURIComponent(rel) } catch { return send(res, 400, { error: 'Bad path' }) }
  if (!decoded || decoded.includes('\0') || decoded.split('/').some(p => p === '' || p === '..' || p.startsWith('.'))) return send(res, 400, { error: 'Bad path' })
  const base = runDir(runId)
  let file
  try {
    const realBase = realpathSync(base)
    if (realBase !== join(realpathSync(RUNS_DIR), runId)) return send(res, 403, { error: 'Forbidden' })
    file = realpathSync(resolve(base, decoded))
    if (!file.startsWith(realBase + sep)) return send(res, 403, { error: 'Forbidden' })
    if (!statSync(file).isFile()) return send(res, 404, { error: 'Not found' })
  } catch { return send(res, 404, { error: 'Not found' }) }
  const ext = extname(file).toLowerCase()
  const headers = { ...BASE_HEADERS, 'Content-Type': TYPES[ext] ?? 'application/octet-stream' }
  if (ext === '.html') headers['Content-Security-Policy'] = REPORT_CSP
  else headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"
  if (!TYPES[ext]) headers['Content-Disposition'] = 'attachment'
  if (TEXT.has(ext)) {
    // Never fall back to raw streaming when a text file is too large to redact safely.
    if (statSync(file).size > REDACT_LIMIT) return send(res, 413, { error: 'Text artifact is too large to redact safely' })
    res.writeHead(200, headers)
    return res.end(redact(readFileSync(file, 'utf8')))
  }
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
}

function serveStatic(res, path) {
  const name = path === '/' ? 'index.html' : path.slice(1)
  if (!/^[\w-]+\.(html|js|css|svg)$/.test(name)) return send(res, 404, { error: 'Not found' })
  const file = join(PUBLIC, name)
  if (!existsSync(file)) return send(res, 404, { error: 'Not found' })
  let body = readFileSync(file, 'utf8')
  if (name === 'index.html') body = body.replace('__QA_TOKEN__', TOKEN)
  send(res, 200, body, { 'Content-Type': TYPES[extname(name)] })
}

async function route(req, res) {
  // Platform health probe: no Host check (probes use internal hosts), reveals nothing.
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true })
  // DNS-rebinding defence: a page on another domain that resolves to 127.0.0.1 still sends its own Host.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 421, { error: 'Unexpected Host header' })
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const write = !['GET', 'HEAD'].includes(req.method)
  if (write) {
    const origin = req.headers.origin
    if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'Cross-origin request refused' })
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: 'Cross-site request refused' })
    if (!tokenOk(req)) return send(res, 403, { error: 'Missing or invalid dashboard token (reload the page)' })
  }

  if (req.method === 'POST' && path === '/api/session') {
    const body = await readBody(req)
    if (!accessOk(body?.access)) return send(res, 403, { error: 'Invalid private dashboard link' })
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=${ACCESS_TOKEN}; HttpOnly; SameSite=Strict; Path=/api/${PUBLIC_HOST ? '; Secure' : ''}` })
  }
  if (path.startsWith('/api/') && !sessionOk(req)) {
    return send(res, 403, { error: 'Open the private dashboard link printed by npm run dashboard.' })
  }

  if (req.method === 'GET' && !path.startsWith('/api/')) return serveStatic(res, path)
  if (req.method === 'GET' && path === '/api/status') return send(res, 200, status())
  if (req.method === 'GET' && path === '/api/runs') return send(res, 200, readIndex().slice(-200).reverse())
  if (req.method === 'GET' && path === '/api/stack') return send(res, 200, await stackStatus(resolveEnvironment('local-docker')))

  let m = path.match(/^\/api\/runs\/([^/]+)$/)
  if (req.method === 'GET' && m) {
    const run = readRun(m[1])
    return run ? send(res, 200, JSON.parse(redact(JSON.stringify(run)))) : send(res, 404, { error: 'Run not found' })
  }
  m = path.match(/^\/api\/runs\/([^/]+)\/files\/(.+)$/)
  if (req.method === 'GET' && m) return serveArtifact(res, m[1], m[2])
  m = path.match(/^\/api\/jobs\/([^/]+)\/log$/)
  if (req.method === 'GET' && m) {
    if (!isRunId(m[1])) return send(res, 400, { error: 'Invalid run id' })
    const log = jobLog(m[1])
    return log ? send(res, 200, log) : send(res, 404, { error: 'No log for this run' })
  }

  if (req.method === 'POST' && path === '/api/runs') return send(res, 202, startRun(await readBody(req)))
  if (req.method === 'POST' && path === '/api/slack/test') {
    await readBody(req)
    const result = slackStatus().mode==='bot'?await sendBotTest():await notifyEvent({ key: 'qa_dashboard_test', severity: 'info', test: true, environment: 'qa-dashboard',
      title: 'MPC QA dashboard test alert', summary: 'Slack delivery from the QA dashboard works. No run was started.' })
    return send(res, 200, { ok: result.ok, code: result.code, attempts: result.attempts })
  }
  return send(res, 404, { error: 'Not found' })
}

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    if (res.headersSent) return res.end()
    send(res, error.status ?? 500, { error: error.status ? error.message : 'Internal error' })
    if (!error.status) console.error(redact(error.stack ?? String(error)))
  })
})
server.requestTimeout = 30_000
server.headersTimeout = 15_000
server.listen(PORT, HOST, () => console.log(PUBLIC_HOST
  ? `MPC QA dashboard listening on ${HOST}:${PORT}; open https://${PUBLIC_HOST}/#access=<QA_DASHBOARD_ACCESS_TOKEN>`
  : `MPC QA dashboard: http://${HOST}:${PORT}/#access=${ACCESS_TOKEN}  (private link; loopback only)`))
