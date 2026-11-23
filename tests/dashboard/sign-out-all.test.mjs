import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { issuedAfterSignOut, signOutEveryone, signedOutBefore } from '../../dashboard/sessions.mjs'

test('sign-out-everyone refuses Google sessions issued before the cutoff and keeps later ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-signout-'))
  assert.equal(signedOutBefore({ dir }), 0)
  assert.equal(issuedAfterSignOut({ issuedAt: 1 }, { dir }), true, 'no cutoff yet: every session stays valid')
  const cut = signOutEveryone({ dir, now: 1_000 })
  assert.equal(cut, 1_000)
  assert.equal(signedOutBefore({ dir }), 1_000)
  assert.equal(issuedAfterSignOut({ issuedAt: 999 }, { dir }), false, 'older session refused')
  assert.equal(issuedAfterSignOut({ issuedAt: 1_000 }, { dir }), false, 'same-millisecond session refused (fail closed)')
  assert.equal(issuedAfterSignOut({ issuedAt: 1_001 }, { dir }), true, 'later sign-in works')
  assert.equal(issuedAfterSignOut({ role: 'viewer', email: 'a@b.co' }, { dir }), false, 'sessions without a time are refused once a cutoff exists')
})

test('a damaged sign-out file reads as no cutoff instead of failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-signout-'))
  signOutEveryone({ dir, now: 5 })
  writeFileSync(join(dir, '.dashboard', 'sessions.json'), '{not json')
  assert.equal(signedOutBefore({ dir }), 0)
})
