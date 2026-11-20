import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSettings } from '../../pipeline/github-app/policy.mjs'
import { createReviewer } from '../../pipeline/github-app/reviewer.mjs'

const REPO = 'MSQ-AI-Testing/demo-repository', SHA = '45d159386f02d97d4b578096b07d0c62dd4b9282', FOLDER = 'mpc-wallet-dev-0.1.0.0'
const settingsWith = entry => parseSettings({ testsRepository: 'MSQ-AI-Testing/mpc-automation', testsRef: 'main', repositories: { [REPO]: entry } })
const tmp = () => mkdtempSync(join(tmpdir(), 'ghapp-ext-'))

test('an extension folder must be a relative path inside the pull request, and cannot be combined with a deployment target', () => {
  assert.equal(settingsWith({ extension: { path: FOLDER } }).repositories.get(REPO.toLowerCase()).extension.path, FOLDER)
  for (const path of ['/etc', '../outside', 'a/../../b', '', 'dir/;rm']) assert.throws(() => settingsWith({ extension: { path } }), /extension\.path/)
  assert.throws(() => settingsWith({ extension: { path: FOLDER }, target: { baseUrl: 'https://web-a.vercel.app' } }), /cannot both/)
  assert.throws(() => settingsWith({ testsRef: 'bad ref;' }), /testsRef/)
})

test('a pull request extension is checked out at the exact commit, the tests get EXTENSION_PATH, and no deployment is needed', async () => {
  const workRoot = tmp(), lockDirectory = tmp(), calls = []
  const github = { resolveCommit: async () => 'a'.repeat(40), contentsToken: async () => 't' }
  const run = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env })
    if (command === 'git' && args[0] === 'checkout' && args[2] === 'FETCH_HEAD' && args[3] === '--') {
      mkdirSync(join(options.cwd, args[4]), { recursive: true })
      writeFileSync(join(options.cwd, args[4], 'manifest.json'), '{}')
    }
    if (command === 'npx' && args[1] === 'test') writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ title: 'S', specs: [{ title: 'ok', tests: [{ status: 'expected' }] }] }] }))
    return { code: 0, durationMs: 10 }
  }
  // The tests checkout for this commit already exists, so the fixture skips cloning it.
  const checkout = join(workRoot, 'checkouts', 'a'.repeat(40))
  mkdirSync(join(checkout, 'chrom extension'), { recursive: true })
  writeFileSync(join(checkout, '.qa-checkout'), '')
  const settings = settingsWith({ extension: { path: FOLDER }, testsDirectory: 'chrom extension', playwrightArgs: ['--project=packaged-extension'] })
  const reviewer = createReviewer({ github, workRoot, run, env: { QA_SEED_PHRASE: 'x'.repeat(20), WALLET_ADDRESS: '0x1' }, lockOptions: { pollMs: 5, waitMs: 50, lockDirectory } })
  const result = await reviewer({ repo: REPO, number: 3, sha: SHA, chainId: 97, settings, repoSettings: settings.repositories.get(REPO.toLowerCase()), changedFiles: null })
  const fetch = calls.find(c => c.command === 'git' && c.args[0] === 'fetch')
  assert.deepEqual(fetch.args.slice(-1), [SHA], 'the extension is fetched by its exact commit')
  const playwright = calls.find(c => c.command === 'npx' && c.args[1] === 'test')
  assert.match(playwright.env.EXTENSION_PATH, new RegExp(`extension/${FOLDER}$`))
  assert.equal(playwright.env.BASE_URL, '')
  assert.match(result.targetLabel, /packaged extension/)
  assert.equal(result.verdict, 'passed')
})

test('a pull request without the extension folder is reported as a setup problem, not a pass', async () => {
  const github = { resolveCommit: async () => 'a'.repeat(40), contentsToken: async () => 't' }
  const run = async () => ({ code: 0, durationMs: 1 })
  const settings = settingsWith({ extension: { path: FOLDER } })
  const reviewer = createReviewer({ github, workRoot: tmp(), run, env: { QA_SEED_PHRASE: 'x'.repeat(20), WALLET_ADDRESS: '0x1' }, lockOptions: { pollMs: 5, waitMs: 50, lockDirectory: tmp() } })
  await assert.rejects(reviewer({ repo: REPO, number: 3, sha: SHA, chainId: 97, settings, repoSettings: settings.repositories.get(REPO.toLowerCase()), changedFiles: null }), /has no mpc-wallet-dev-0\.1\.0\.0\/manifest\.json/)
})
