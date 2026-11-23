import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from '../pipeline/lib/env.mjs'

/**
 * Administrators for the dashboard. An administrator can start runs, delete runs, create Jira tickets and
 * manage this list. Two sources:
 *   - QA_GOOGLE_ADMIN_EMAILS (settings): always admins; cannot be removed from the dashboard.
 *   - added from the dashboard: stored in the runs folder (.dashboard/admins.json).
 * Membership is checked on every request, so removing an admin takes effect immediately.
 */
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  return email.length <= 254 && EMAIL.test(email) ? email : null
}

export function settingsAdmins(env = process.env) {
  return (env.QA_GOOGLE_ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean)
}

function fileIn(dir) { return join(dir, '.dashboard', 'admins.json') }

export function readAdded({ dir = RUNS_DIR } = {}) {
  try {
    const rows = JSON.parse(readFileSync(fileIn(dir), 'utf8'))
    return Array.isArray(rows) ? rows.filter(r => normalizeEmail(r?.email)) : []
  } catch { return [] }
}

function writeAdded(rows, { dir = RUNS_DIR } = {}) {
  mkdirSync(join(dir, '.dashboard'), { recursive: true, mode: 0o700 })
  const tmp = `${fileIn(dir)}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 })
  renameSync(tmp, fileIn(dir))
}

export function isAdminEmail(email, opts = {}) {
  const normal = normalizeEmail(email)
  if (!normal) return false
  return settingsAdmins(opts.env).includes(normal) || readAdded(opts).some(r => normalizeEmail(r.email) === normal)
}

export function listAdmins(opts = {}) {
  const fromSettings = settingsAdmins(opts.env).map(email => ({ email, source: 'settings', addedBy: null, addedAt: null }))
  const added = readAdded(opts).map(r => ({ email: normalizeEmail(r.email), source: 'added', addedBy: r.addedBy ?? null, addedAt: r.addedAt ?? null }))
    .filter(r => !fromSettings.some(s => s.email === r.email))
  return [...fromSettings, ...added]
}

export function addAdmin(value, addedBy, opts = {}) {
  const email = normalizeEmail(value)
  if (!email) return { ok: false, error: 'Enter a valid email address, such as name@example.com.' }
  if (settingsAdmins(opts.env).includes(email)) return { ok: true, email, alreadyAdmin: true }
  const rows = readAdded(opts)
  if (rows.some(r => normalizeEmail(r.email) === email)) return { ok: true, email, alreadyAdmin: true }
  rows.push({ email, addedBy: normalizeEmail(addedBy) ?? String(addedBy ?? 'administrator').slice(0, 80), addedAt: (opts.now ?? new Date()).toISOString() })
  writeAdded(rows, opts)
  return { ok: true, email, alreadyAdmin: false }
}

/** Returns 'removed', 'settings' (cannot remove a settings admin here) or 'missing'. */
export function removeAdmin(value, opts = {}) {
  const email = normalizeEmail(value)
  if (!email) return 'missing'
  if (settingsAdmins(opts.env).includes(email)) return 'settings'
  const rows = readAdded(opts)
  const kept = rows.filter(r => normalizeEmail(r.email) !== email)
  if (kept.length === rows.length) return 'missing'
  writeAdded(kept, opts)
  return 'removed'
}
