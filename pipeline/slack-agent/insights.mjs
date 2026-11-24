import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeText } from '../lib/safe-output.mjs'
import { buildHealthSummary, renderHealthSummary } from '../health-summary.mjs'

const clean = value => safeText(String(value ?? '')).replace(/[<>&`]/g, '').slice(0, 160)
const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../tests')
const TRIGGERS = { manual: 'manual command', dashboard: 'dashboard', scheduled: 'schedule', 'github-ci': 'GitHub CI' }

/** A Slack-requested rerun is queued under the slack-agent schedule; other runs record only how they started. */
export function startedBy(run) {
  if (run.scheduleId === 'slack-agent') return 'Slack-requested rerun'
  return TRIGGERS[run.trigger] ?? 'not recorded'
}

export function recentRuns(runs) {
  const rows = runs.slice(0, 5)
  if (!rows.length) return 'No recorded test runs were found.'
  return [
    'Recent test runs (latest 5, newest first):',
    ...rows.map(r => {
      const c = r.counts ?? {}
      return `• ${clean(r.runId)} · ${clean(r.suite)} · ${clean(r.env)} · ${clean(r.status)} · ${Number(c.passed) || 0} passed, ${Number(c.failed) || 0} failed · started by ${startedBy(r)} · ${clean(r.finishedAt)}`
    }),
    'Runs do not record the person who typed a manual or dashboard command. Slack-requested reruns name their requester in the private Slack audit trail.',
  ].join('\n').slice(0, 2800)
}

function specFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : specFiles(path)
    return /\.spec\.(?:ts|mjs|js)$/.test(entry.name) ? [path] : []
  })
}

/** High priority means a describe block tagged @critical in the Playwright specs. Per-case results come from the recorded runs. */
export function highPriorityCases(dir = TESTS_DIR) {
  const cases = []
  for (const file of specFiles(dir)) {
    const source = readFileSync(file, 'utf8')
    for (const m of source.matchAll(/test(?:\.describe)?\(\s*(['"`])((?:(?!\1).){1,200})\1\s*,\s*\{[^}]*?tag:\s*\[([^\]]*)\]/g)) {
      const tags = [...m[3].matchAll(/['"`](@[\w-]+)['"`]/g)].map(t => t[1])
      if (tags.includes('@critical')) cases.push({ title: m[2], file: relative(dir, file), tags })
    }
  }
  if (!cases.length) return 'No test cases are tagged @critical in the test suite.'
  return [
    `High-priority cases (tagged @critical): ${cases.length}`,
    ...cases.slice(0, 20).map(c => `• ${clean(c.title)} — ${clean(c.file)} [${c.tags.map(clean).join(' ')}]`),
    cases.length > 20 ? `${cases.length - 20} more are in the test files.` : null,
    'Latest results for these cases are in the recorded runs; ask for failures or the latest report.',
  ].filter(Boolean).join('\n').slice(0, 2800)
}

/** Uses only real recorded runs; the window is the number of days ending now. */
export function healthReport({ runs, now = Date.now(), days = 1, schedules = { timezone: 'Asia/Seoul', schedules: [] }, jobs = [], reportBase }) {
  const since = now - days * 86_400_000
  const inWindow = runs.filter(r => Date.parse(r.finishedAt) >= since && Date.parse(r.finishedAt) < now)
  const envs = [...new Set(inWindow.map(r => r.env).filter(e => typeof e === 'string' && /^[\w-]{1,40}$/.test(e)))].slice(0, 3)
  if (!envs.length) return `No recorded runs finished in the last ${days} day${days === 1 ? '' : 's'}.`
  const end = new Date(now).toISOString()
  return envs.map(env => renderHealthSummary(buildHealthSummary({ end, env, schedules: schedules.schedules, timezone: schedules.timezone, runs, jobs, days }), { reportBase })).join('\n\n').slice(0, 2800)
}
