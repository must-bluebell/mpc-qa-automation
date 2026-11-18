import dotenv from 'dotenv'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
dotenv.config({ path: resolve(ROOT, '.env'), quiet: true })

export const RUNS_DIR = resolve(ROOT, process.env.QA_RUNS_DIR || 'runs')

/** Hosted deployments (e.g. Render) run against hosted environments only; see QA_HOSTED in render.yaml. */
export const HOSTED = process.env.QA_HOSTED === '1'
export const DEFAULT_ENV = process.env.QA_DEFAULT_ENV || (HOSTED ? 'production' : 'local-docker')

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) } catch (error) {
    if (fallback !== undefined) return fallback
    throw error
  }
}

export const config = {
  environments: () => readJson('pipeline/config/environments.json'),
  suites: () => readJson('pipeline/config/suites.json'),
  schedules: () => readJson(process.env.QA_SCHEDULE_FILE || 'pipeline/config/schedules.json'),
  thresholds: () => readJson('pipeline/config/thresholds.json'),
  requirements: () => readJson('config/qa-requirements.json'),
  evaluation: () => readJson('config/qa-evaluation.json'),
}

export function isLoopback(url) {
  try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname) } catch { return false }
}

/** Resolves an environment profile; URLs may come from env vars so nothing deployment-specific is committed. */
export function resolveEnvironment(name) {
  const all = config.environments()
  const profile = all[name]
  if (!profile) throw new Error(`Unknown environment "${name}". Known: ${Object.keys(all).join(', ')}`)
  const baseUrl = (profile.baseUrlEnv ? process.env[profile.baseUrlEnv] : profile.baseUrl) || ''
  if (!baseUrl) throw new Error(`Environment "${name}" needs ${profile.baseUrlEnv} in .env`)
  const isolated = !!profile.isolated && isLoopback(baseUrl)
  return { name, ...profile, externalRepositoriesAllowed: process.env.QA_EXTERNAL_REPOSITORIES !== '0', baseUrl: baseUrl.replace(/\/+$/, ''), appOrigin: (profile.appOrigin || baseUrl).replace(/\/+$/, ''), isolated,
    allowWrites: !!profile.allowWrites && isolated, allowLoad: !!profile.allowLoad && isolated, allowSeededDefects: !!profile.allowSeededDefects && isolated }
}

/** Every secret value we know about, for redaction of anything written to disk or sent to Slack/AI. */
// Keep retired provider credentials protected when they remain in an upgraded installation's .env.
export const SECRET_KEYS = ['QA_SEED_PHRASE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_AUTH_JSON', 'CODEX_AUTH_WRITE_TOKEN', 'QA_OPENCLAW_TOKEN', 'ANTHROPIC_API_KEY', 'SLACK_ALERT_WEBHOOK_URL', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_VERIFICATION_TOKEN', 'CRON_SECRET', 'WEBAPP_READ_TOKEN', 'WEBAPP_REPORT_TOKEN']

export function knownSecrets() {
  return SECRET_KEYS.map(k => process.env[k]).filter(v => v && v.length >= 8)
}
