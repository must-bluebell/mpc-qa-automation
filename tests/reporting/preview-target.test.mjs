import test from 'node:test'
import assert from 'node:assert/strict'

test('secret-bearing preview CI accepts only explicitly trusted deployment hosts', async () => {
  const { validatePreviewTarget } = await import('../../scripts/validate-preview-target.mjs')
  const options = { hosts: ['globalmpc-webapp-git-fix-login-qa-team.vercel.app'] }
  assert.equal(validatePreviewTarget('https://globalmpc-webapp-git-fix-login-qa-team.vercel.app', '97', options).chainId, 97)
  for (const url of [
    'https://attacker.example', 'http://globalmpc-webapp-git-main-qa-team.vercel.app',
    'https://globalmpc-webapp-git-main-other-team.vercel.app',
    'https://globalmpc-webapp-git-main-attacker-qa-team.vercel.app',
    'https://another-project-git-main-qa-team.vercel.app',
    'https://globalmpc-webapp-git-main-qa-team.vercel.app.attacker.example',
    'https://user:secret@globalmpc-webapp-git-main-qa-team.vercel.app',
    'https://globalmpc-webapp-git-main-qa-team.vercel.app/redirect',
    'https://globalmpc-webapp-git-main-qa-team.vercel.app?redirect=https://attacker.example',
  ]) assert.throws(() => validatePreviewTarget(url, '97', options), /preview/i)
  assert.throws(() => validatePreviewTarget('https://globalmpc-webapp-git-fix-login-qa-team.vercel.app', '56', options), /testnet/i)
  assert.throws(() => validatePreviewTarget('https://globalmpc-webapp-git-main-qa-team.vercel.app', '97'), /QA_PREVIEW_HOSTS/)
  assert.throws(() => validatePreviewTarget('https://globalmpc-webapp-git-main-qa-team.vercel.app', '97', {hosts:'*.vercel.app'}), /wildcards/)
})
