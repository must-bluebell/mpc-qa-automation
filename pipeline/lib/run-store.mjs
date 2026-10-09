import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from './env.mjs'
import { redactValue } from './safe-output.mjs'

/**
 * Run history on disk: runs/<runId>/run.json is the full record, runs/index.json a compact list for the
 * dashboard and comparisons. Writes go through a temp file + rename so a crash never leaves half a JSON.
 */
export function newRunId(suite, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${suite}-${randomBytes(2).toString('hex')}`
}

export function runDir(runId) { return join(RUNS_DIR, runId) }

export function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(redactValue(data), null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

export function createRunDir(runId) {
  if (!isRunId(runId)) throw new Error(`Invalid run id "${runId}"`)
  const dir = runDir(runId)
  mkdirSync(join(dir, 'steps'), { recursive: true, mode: 0o700 })
  return dir
}

export function saveRun(run) {
  writeJsonAtomic(join(runDir(run.runId), 'run.json'), run)
  updateIndex(run)
}

/** Run ids name folders under runs/; anything else (dots, slashes) is refused so ids cannot escape it. */
export function isRunId(runId) { return typeof runId === 'string' && /^[A-Za-z0-9][\w-]{0,99}$/.test(runId) }

export function readRun(runId) {
  if (!isRunId(runId)) return null
  try { return JSON.parse(readFileSync(join(runDir(runId), 'run.json'), 'utf8')) } catch { return null }
}

export function summarize(run) {
  return {
    runId: run.runId, suite: run.suite, env: run.env, trigger: run.trigger, scheduleId: run.scheduleId ?? null,
    seededDefect: run.seededDefect ?? null, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
    durationMs: run.durationMs, counts: run.counts, coverage: run.coverage?.ratio ?? null,
    failedFingerprints: (run.tests ?? []).filter(t => t.status === 'failed').map(t => t.fingerprint),
    slack: run.notifications?.map(n => ({ kind: n.kind, ok: n.ok, code: n.code })) ?? [],
    appVersion: run.versions?.app ?? null, testSuiteVersion: run.versions?.testSuite ?? null,
  }
}

export function readIndex() {
  try { return JSON.parse(readFileSync(join(RUNS_DIR, 'index.json'), 'utf8')) } catch { return [] }
}

function updateIndex(run) {
  mkdirSync(RUNS_DIR, { recursive: true })
  const index = readIndex().filter(r => r.runId !== run.runId)
  index.push(summarize(run))
  index.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  writeJsonAtomic(join(RUNS_DIR, 'index.json'), index)
}

/** Rebuilds the index from run folders (used after a crash or manual cleanup). */
export function rebuildIndex() {
  if (!existsSync(RUNS_DIR)) return []
  const runs = readdirSync(RUNS_DIR).map(readRun).filter(Boolean)
  for (const run of runs) updateIndex(run)
  return readIndex()
}

/** Most recent finished run for the same suite + environment, for diffing. Seeded runs compare among themselves. */
export function previousRun(run) {
  const index = readIndex().filter(r => r.runId !== run.runId && r.suite === run.suite && r.env === run.env
    && r.startedAt < run.startedAt && !['running', 'skipped-overlap'].includes(r.status))
  const last = index.at(-1)
  return last ? readRun(last.runId) : null
}

export function appendEvent(file, event) {
  mkdirSync(RUNS_DIR, { recursive: true })
  appendFileSync(join(RUNS_DIR, file), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}

export function readEvents(file) {
  try { return readFileSync(join(RUNS_DIR, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
}

/** Runs left in "running" with no live lock were killed mid-way (worker crash); mark them so. */
export function markCrashedRuns(activeRunId) {
  const crashed = []
  for (const entry of readIndex().filter(r => r.status === 'running' && r.runId !== activeRunId)) {
    const run = readRun(entry.runId)
    if (!run) continue
    run.status = 'crashed'
    run.finishedAt ??= new Date().toISOString()
    run.errors = [...(run.errors ?? []), 'Run never finished: the orchestrator process exited unexpectedly (worker crash or kill).']
    saveRun(run)
    crashed.push(run.runId)
  }
  return crashed
}
