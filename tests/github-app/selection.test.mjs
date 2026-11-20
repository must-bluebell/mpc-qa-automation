import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSettings } from '../../pipeline/github-app/policy.mjs'
import { selectRuns } from '../../pipeline/github-app/selection.mjs'
import { mergeSummaries, summarizeResults } from '../../pipeline/github-app/report.mjs'
import { createReviewer } from '../../pipeline/github-app/reviewer.mjs'

const REPO = 'MSQ-AI-Testing/demo', SHA = 'f'.repeat(40)
const DIG_RUNS = [['--project=chromium', '--grep', '@regression'], ['--project=uat']]
const impact = [{ name: 'dig', paths: ['**/dig/**', '**/*Dig*.tsx'], runs: DIG_RUNS }, { name: 'cart', paths: ['src/cart/**'], runs: [['--project=api']] }]
const settingsWith = extra => parseSettings({ testsRepository: 'MSQ-AI-Testing/mpc-automation', testsRef: 'main', repositories: { [REPO]: { target: { type: 'local-stack' }, playwrightArgs: ['--grep', '@smoke'], ...extra } } })
const tmp = () => mkdtempSync(join(tmpdir(), 'ghapp-sel-'))

test('a changed file matching a rule runs that rule\'s suites; several rules are combined without duplicates', () => {
  const repo = settingsWith({ impact }).repositories.get(REPO.toLowerCase())
  assert.deepEqual(selectRuns(repo, ['src/features/dig/Board.tsx']), { runs: DIG_RUNS, rules: ['dig'] })
  assert.deepEqual(selectRuns(repo, ['src/features/dig/Board.tsx', 'src/cart/index.ts']), { runs: [...DIG_RUNS, ['--project=api']], rules: ['dig', 'cart'] })
  const both = selectRuns(repo, ['src/features/dig/Board.tsx', 'src/features/dig/Other.tsx'])
  assert.equal(both.runs.length, 2)
})

test('no matching rule runs the default suite, and an unreadable file list applies every rule', () => {
  const repo = settingsWith({ impact }).repositories.get(REPO.toLowerCase())
  assert.deepEqual(selectRuns(repo, ['README.md']), { runs: [['--grep', '@smoke']], rules: [] })
  assert.deepEqual(selectRuns(repo, null), { runs: [['--grep', '@smoke'], ...DIG_RUNS, ['--project=api']], rules: ['dig', 'cart'] })
  const none = settingsWith({}).repositories.get(REPO.toLowerCase())
  assert.deepEqual(selectRuns(none, ['src/features/dig/x.ts']), { runs: [['--grep', '@smoke']], rules: [] })
})

test('impact rules are validated: relative globs, named rules, bounded and checked arguments', () => {
  const bad = [
    [{ name: 'x', paths: ['/abs/**'], runs: [['--project=api']] }],
    [{ name: 'x', paths: ['../secrets/**'], runs: [['--project=api']] }],
    [{ name: '', paths: ['a/**'], runs: [['--project=api']] }],
    [{ name: 'x', paths: ['a/**'], runs: [] }],
    [{ name: 'x', paths: ['a/**'], runs: [['--reporter=list']] }],
    [{ name: 'x', paths: ['a/**'], runs: [['--output=/tmp/x']] }],
  ]
  for (const rules of bad) assert.throws(() => settingsWith({ impact: rules }))
  assert.equal(settingsWith({ impact }).repositories.get(REPO.toLowerCase()).impact.length, 2)
})

test('summaries of several runs are merged into one count and one failure list', () => {
  const a = summarizeResults({ suites: [{ title: 'A', specs: [{ title: 'ok', tests: [{ status: 'expected' }] }, { title: 'bad', tests: [{ status: 'unexpected', results: [{ error: { message: 'boom' } }] }] }] }] })
  const b = summarizeResults({ suites: [{ title: 'B', specs: [{ title: 'skip', tests: [{ status: 'skipped' }] }] }] })
  const merged = mergeSummaries([a, b])
  assert.equal(merged.passed, 1); assert.equal(merged.skipped, 1); assert.deepEqual(merged.failed, ['bad'])
  assert.equal(merged.cases.length, 3)
})

test('the reviewer runs each selected suite in turn, merges the counts and states the scope', async () => {
  const workRoot = tmp(), lockDirectory = tmp(), calls = []
  const github = { resolveCommit: async () => SHA, contentsToken: async () => 't' }
  // Each playwright invocation writes its own JSON; the dig suite passes, the cart suite (not selected here) would fail.
  const run = async (command, args, options) => {
    calls.push(args)
    if (args[1] === 'test') {
      const failing = args.includes('@regression') === false
      writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ title: 'S', specs: [{ title: failing ? 'uat journey' : 'regression case', tests: [{ status: failing ? 'unexpected' : 'expected', results: failing ? [{ error: { message: 'Expected connected' } }] : [] }] }] }] }))
    }
    return { code: 0, durationMs: 1000 }
  }
  const settings = settingsWith({ impact })
  const reviewer = createReviewer({ github, workRoot, run, env: { QA_SEED_PHRASE: 'x'.repeat(20), WALLET_ADDRESS: '0x1' }, lockOptions: { pollMs: 5, waitMs: 50, lockDirectory } })
  const result = await reviewer({ repo: REPO, number: 9, sha: SHA, baseUrl: 'https://web-a.vercel.app', chainId: 97, settings, repoSettings: settings.repositories.get(REPO.toLowerCase()), changedFiles: ['src/features/dig/Board.tsx'] })
  const playwright = calls.filter(args => args[0] === 'playwright' && args[1] === 'test')
  assert.equal(playwright.length, 2, 'two suites ran for the dig change')
  assert.equal(result.verdict, 'failed')
  assert.equal(result.summary.passed, 1); assert.equal(result.summary.failed.length, 1)
  assert.match(result.scope, /changed files matched dig · 2 test runs/)
})
