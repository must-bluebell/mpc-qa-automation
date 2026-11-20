#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../lib/env.mjs'
import { checkConfiguration } from './server.mjs'
import { createGitHub } from './github.mjs'
import { ACTIONS_PERMISSIONS, REQUIRED_EVENTS, REQUIRED_PERMISSIONS } from './policy.mjs'

const LEVEL = { read: 1, write: 2, admin: 3 }

/** Pure comparison of the live App against what the review flow needs; returns human-readable gaps. */
export function diagnose({ app, installations, settings, hook, deliveries = [] }) {
  const gaps = [], notes = []
  const enabled = [...settings.repositories.values()].filter(r => r.enabled)
  // Deployment status is only read to discover a PR's Vercel preview; fixed-target repositories do not need it.
  const needsDeployments = enabled.some(r => !r.fixedBaseUrl && !r.localStack && !r.extension)
  const needsActions = enabled.some(r => r.engine === 'actions')
  const requiredPermissions = { ...REQUIRED_PERMISSIONS, ...(needsActions ? ACTIONS_PERMISSIONS : {}) }
  for (const [name, need] of Object.entries(requiredPermissions)) {
    if (name === 'deployments' && !needsDeployments) continue
    const have = app.permissions?.[name]
    if ((LEVEL[have] ?? 0) < LEVEL[need]) gaps.push(`App permission "${name}" is ${have ?? 'not granted'}; needs ${need} (App settings → Permissions & events, then the org owner must approve the update)`)
  }
  for (const event of REQUIRED_EVENTS) if (!app.events?.includes(event)) gaps.push(`App is not subscribed to the "${event}" event (App settings → Permissions & events → Subscribe to events)`)
  if (!hook?.url) gaps.push('No webhook URL is configured on the App')
  else notes.push(`Webhook URL: ${hook.url}`)
  if (hook?.url && hook.insecure_ssl !== '0') gaps.push('Webhook SSL verification is disabled')
  const wanted = new Set([settings.testsRepository, ...[...settings.repositories.values()].filter(r => r.enabled).map(r => r.name)].map(r => r.toLowerCase()))
  const covered = new Set()
  for (const installation of installations) {
    if (installation.suspended) { gaps.push(`Installation on ${installation.account} is suspended`); continue }
    if (installation.selection === 'all') for (const r of wanted) { if (r.startsWith(`${installation.account.toLowerCase()}/`)) covered.add(r) }
    for (const r of installation.repositories ?? []) covered.add(r.toLowerCase())
    // Only installations that serve a configured repository matter; others (e.g. a personal account) are noise.
    const serves = [...wanted].some(r => r.startsWith(`${installation.account.toLowerCase()}/`))
    const pending = Object.entries(app.permissions ?? {}).filter(([k, v]) => (LEVEL[installation.permissions?.[k]] ?? 0) < (LEVEL[v] ?? 0))
    if (serves && pending.length) gaps.push(`Installation on ${installation.account} has not accepted: ${pending.map(([k, v]) => `${k}:${v}`).join(', ')} (an org owner must approve the request)`)
  }
  for (const r of wanted) if (!covered.has(r)) gaps.push(`The App is not installed on ${r} (org owner: Settings → GitHub Apps → Configure → Repository access)`)
  const recent = deliveries.slice(0, 5).map(d => `${d.event}${d.action ? `/${d.action}` : ''}=${d.status_code}`)
  if (recent.length) notes.push(`Recent deliveries: ${recent.join(', ')}`)
  return { ok: gaps.length === 0, gaps, notes }
}

export async function installationRepositories(token, fetchImpl = fetch) {
  const repositories = []
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'mpc-qa-automation' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Installation repository lookup failed (HTTP ${response.status})`)
    const { repositories: batch } = await response.json()
    if (!Array.isArray(batch)) throw new Error('Installation repository lookup returned invalid data')
    repositories.push(...batch.map(r => r.full_name))
    if (batch.length < 100) return repositories
  }
}

async function live(env = process.env) {
  const { privateKey, settings } = checkConfiguration(env)
  const github = createGitHub({ appId: env.GITHUB_APP_ID, privateKey })
  const app = await github.asApp('GET', '/app')
  const hook = await github.asApp('GET', '/app/hook/config')
  const deliveries = await github.asApp('GET', '/app/hook/deliveries?per_page=5').catch(() => [])
  const installations = []
  for (let page = 1; ; page++) {
    const batch = await github.asApp('GET', `/app/installations?per_page=100&page=${page}`)
    for (const i of batch) {
      const entry = { account: i.account.login, selection: i.repository_selection, permissions: i.permissions, suspended: !!i.suspended_at, repositories: [] }
      if (i.repository_selection === 'selected') {
        const created = await github.asApp('POST', `/app/installations/${i.id}/access_tokens`)
        entry.repositories = await installationRepositories(created.token)
      }
      installations.push(entry)
    }
    if (batch.length < 100) break
  }
  return { app, installations, settings, hook, deliveries, summary: installations.map(i => `${i.account}: ${i.selection === 'all' ? 'all repositories' : i.repositories.join(', ') || 'no repositories'}`) }
}

async function main() {
  const result = await live()
  const report = diagnose(result)
  console.log(`App: ${result.app.slug}`); result.summary.forEach(line => console.log(`Installed → ${line}`)); report.notes.forEach(n => console.log(n))
  if (report.ok) return console.log('Everything the review flow needs is in place.')
  console.log('\nStill needed:'); report.gaps.forEach(g => console.log(`- ${g}`)); process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
