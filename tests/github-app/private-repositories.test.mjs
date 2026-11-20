import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseSettings } from '../../pipeline/github-app/policy.mjs'
import { selectRuns } from '../../pipeline/github-app/selection.mjs'

// The checked-in example is the template the operator copies to the local policy file, so it must stay valid.
const example = JSON.parse(readFileSync(new URL('../../pipeline/config/github-app.repositories.example.json', import.meta.url), 'utf8'))
const settings = parseSettings(example, {})
const UNITY = 'globalmpc/globalmpc-unity-private'
const EXTENSION = 'globalmpc/globalmpc-wallet-extension-private'

test('the example policy parses and lists both private repositories', () => {
  assert.ok(settings.repositories.has(UNITY.toLowerCase()))
  assert.ok(settings.repositories.has(EXTENSION.toLowerCase()))
})

test('Unity pull requests run the API, UAT and browser regression projects, and no packaged extension', () => {
  const repo = settings.repositories.get(UNITY.toLowerCase())
  assert.equal(repo.extension, undefined)
  assert.equal(repo.localStack, undefined)
  assert.equal(repo.fixedBaseUrl, undefined, 'the App finds the pull request preview unless the policy pins one')
  assert.deepEqual(selectRuns(repo, ['src/Game.cs']).runs, [['--project=api', '--project=uat', '--project=chromium']])
  assert.deepEqual(selectRuns(repo, null).runs, [['--project=api', '--project=uat', '--project=chromium']], 'an unreadable file list still runs the default suite')
})

test('wallet extension pull requests run only the packaged-extension suite, from the extension test folder', () => {
  const repo = settings.repositories.get(EXTENSION.toLowerCase())
  assert.equal(typeof repo.extension.path, 'string')
  assert.equal(repo.fixedBaseUrl, undefined)
  assert.equal(repo.testsDirectory, 'chrom extension')
  assert.deepEqual(selectRuns(repo, ['README.md']).runs, [['--project=packaged-extension']])
})
