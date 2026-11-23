import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAdmin, isAdminEmail, listAdmins, normalizeEmail, removeAdmin } from '../../dashboard/admins.mjs'
import { checkIdTokenClaims, googleConfig } from '../../dashboard/google-auth.mjs'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-admins-'))
  try { return fn({ dir, env: { QA_GOOGLE_ADMIN_EMAILS: 'Owner@Gmail.com, ops@company.example' } }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('emails are normalised and malformed ones are refused', () => {
  assert.equal(normalizeEmail('  Name@Example.COM '), 'name@example.com')
  assert.equal(normalizeEmail('no-at-sign'), null)
  assert.equal(normalizeEmail('a@b'), null)
  assert.equal(normalizeEmail('x'.repeat(250) + '@example.com'), null)
  assert.equal(normalizeEmail(undefined), null)
})

test('settings administrators are admins, and cannot be removed from the dashboard', () => {
  withDir(opts => {
    assert.equal(isAdminEmail('owner@gmail.com', opts), true)
    assert.equal(isAdminEmail('OPS@company.example', opts), true)
    assert.equal(isAdminEmail('someone@gmail.com', opts), false)
    assert.equal(removeAdmin('owner@gmail.com', opts), 'settings')
    assert.equal(isAdminEmail('owner@gmail.com', opts), true)
  })
})

test('an added administrator is recorded with who added them, and can be removed again', () => {
  withDir(opts => {
    const added = addAdmin('Usmanch2261@gmail.com', 'owner@gmail.com', { ...opts, now: new Date('2026-11-23T00:00:00Z') })
    assert.deepEqual([added.ok, added.email, added.alreadyAdmin], [true, 'usmanch2261@gmail.com', false])
    assert.equal(isAdminEmail('usmanch2261@gmail.com', opts), true)
    const row = listAdmins(opts).find(a => a.email === 'usmanch2261@gmail.com')
    assert.equal(row.source, 'added')
    assert.equal(row.addedBy, 'owner@gmail.com')
    assert.equal(addAdmin('usmanch2261@gmail.com', 'owner@gmail.com', opts).alreadyAdmin, true)
    assert.equal(removeAdmin('usmanch2261@gmail.com', opts), 'removed')
    assert.equal(isAdminEmail('usmanch2261@gmail.com', opts), false)
    assert.equal(removeAdmin('usmanch2261@gmail.com', opts), 'missing')
  })
})

test('invalid addresses are not added', () => {
  withDir(opts => {
    assert.equal(addAdmin('not an email', 'owner@gmail.com', opts).ok, false)
    assert.equal(listAdmins(opts).length, 2)
  })
})

test('a sign-in from an administrator is admitted even outside the company domain', () => {
  const config = googleConfig({ QA_GOOGLE_CLIENT_ID: 'c', QA_GOOGLE_CLIENT_SECRET: 's', QA_GOOGLE_ALLOWED_DOMAIN: 'company.example' })
  const claims = { iss: 'https://accounts.google.com', aud: 'c', exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n', email: 'boss@gmail.com', email_verified: true }
  assert.equal(checkIdTokenClaims(claims, { config, nonce: 'n' }).ok, false)
  assert.equal(checkIdTokenClaims(claims, { config, nonce: 'n', isAdmin: e => e === 'boss@gmail.com' }).ok, true)
})
