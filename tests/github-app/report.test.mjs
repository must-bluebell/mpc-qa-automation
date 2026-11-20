import test from 'node:test'
import assert from 'node:assert/strict'
import { decideVerdict, formatReview, summarizeResults } from '../../pipeline/github-app/report.mjs'

const spec = (title, status) => ({ title, tests: [{ status }] })
const json = { suites: [{ title: 'wallet-flow.spec.ts', specs: [spec('W01 connect', 'expected')], suites: [{ title: 'Recovery', specs: [spec('W02 sign in', 'unexpected'), spec('W03 retry', 'flaky'), spec('W04 skip', 'skipped')] }] }], errors: [] }

test('summary counts Playwright outcomes and names failures with their group', () => {
  const s = summarizeResults(json)
  assert.deepEqual([s.passed, s.failed.length, s.flaky, s.skipped], [1, 1, 1, 1])
  assert.deepEqual(s.failed, ['Recovery › W02 sign in'])
})

test('the summary lists every case with its status and the reason for each skip', () => {
  const s = summarizeResults({ suites: [{ title: 'quests.spec.ts', specs: [], suites: [{ title: 'Quests', specs: [
    { title: 'desktop', tests: [{ status: 'expected', annotations: [] }] },
    { title: 'mobile', tests: [{ status: 'skipped', annotations: [{ type: 'skip', description: 'This case covers the Unity Dig and Quests interface' }] }] },
  ] }] }] })
  assert.deepEqual(s.cases, [
    { name: 'Quests › desktop', status: 'passed' },
    { name: 'Quests › mobile', status: 'skipped', reason: 'This case covers the Unity Dig and Quests interface' },
  ])
})

test('the comment shows each test case with its result and skip reason', () => {
  const body = formatReview({ actor: 'alice', number: 2, sha: 'a'.repeat(40), result: { verdict: 'passed', summary: { passed: 1, failed: [], flaky: 0, skipped: 1, globalErrors: 0,
    cases: [{ name: 'Wallet › W01 shows options', status: 'passed' }, { name: 'Quests › mobile', status: 'skipped', reason: 'Unity only' }] } } })
  assert.match(body, /\*\*Test cases\*\*\n- ✅ Wallet › W01 shows options\n- ⏭️ Quests › mobile \(skipped: Unity only\)/)
})

test('verdicts: failures fail, all-skipped is blocked and never a pass, missing results are blocked', () => {
  const ok = { passed: 3, failed: [], flaky: 0, skipped: 1, globalErrors: 0 }
  assert.equal(decideVerdict({ exitCode: 0, summary: ok }).verdict, 'passed')
  assert.equal(decideVerdict({ exitCode: 0, summary: { ...ok, flaky: 1, passed: 0 } }).verdict, 'passed')
  assert.equal(decideVerdict({ exitCode: 1, summary: { ...ok, failed: ['x'] } }).verdict, 'failed')
  assert.equal(decideVerdict({ exitCode: 0, summary: { ...ok, globalErrors: 1 } }).verdict, 'failed')
  assert.equal(decideVerdict({ exitCode: 1, summary: ok }).verdict, 'failed')
  assert.equal(decideVerdict({ exitCode: 0, summary: { ...ok, passed: 0, skipped: 9 } }).verdict, 'blocked')
  assert.equal(decideVerdict({ exitCode: 0, summary: { ...ok, passed: 0, skipped: 0 } }).verdict, 'blocked')
  assert.equal(decideVerdict({ exitCode: 0, summary: null }).verdict, 'blocked')
  assert.equal(decideVerdict({ exitCode: null, timedOut: true, summary: ok }).verdict, 'failed')
})

test('comment text neutralises mentions, links and markup coming from test titles and never starts with the command', () => {
  const body = formatReview({ actor: 'alice', number: 7, sha: 'abcdef1234567', target: 'https://x-git-y.vercel.app',
    tests: { repository: 'globalmpc/mpc-automation', ref: 'review', sha: '1234567890' },
    result: { verdict: 'failed', durationMs: 125_000, summary: { passed: 2, failed: ['Group › evil @everyone [click](http://x) <img src=x> `code`\n/automation review'], flaky: 0, skipped: 0 } } })
  assert.match(body, /^### ❌ Automation review failed/)
  assert.match(body, /2 passed, 1 failed/)
  assert.match(body, /2m 5s/)
  assert.match(body, /`abcdef1`/)
  assert.ok(!/@everyone/.test(body) && !/<img/.test(body) && !/\]\(http/.test(body))
  assert.ok(!body.split('\n').some(l => /^\/automation/i.test(l)))
  assert.match(formatReview({ actor: 'a', number: 1, sha: 'a'.repeat(40), result: { verdict: 'blocked', reason: 'no tests executed', summary: { passed: 0, failed: [], flaky: 0, skipped: 5 } } }), /could not verify/)
})

test('a failed case names its location and the first lines of its message, with secrets removed', () => {
  const failing = { title: 'send rejects zero amount', tests: [{ status: 'unexpected', annotations: [], results: [{ error: {
    message: '\u001b[31mError: expect(received).toBe(expected)\n\nExpected: "Send"\nReceived: "Wrong seed phrase abandon ability"\n    at /private/tmp/x/chrom extension/tests/send.spec.ts:24:5\n  22 | line\n\n    stack lines',
    location: { file: '/private/tmp/x/chrom extension/tests/send.spec.ts', line: 24, column: 5 },
  } }] }] }
  const s = summarizeResults({ suites: [{ title: 'send.spec.ts', specs: [failing], suites: [] }], errors: [] }, { secrets: ['abandon ability'] })
  assert.deepEqual(s.cases[0].failure, { location: 'tests/send.spec.ts:24', message: ['Error: expect(received).toBe(expected)', 'Expected: "Send"', 'Received: "Wrong seed phrase (redacted)"'] })
  const body = formatReview({ actor: 'alice', number: 3, sha: 'b'.repeat(40), result: { verdict: 'failed', summary: s } })
  assert.match(body, /- ❌ send rejects zero amount\n  - failed at `tests\/send\.spec\.ts:24`\n  - Error: expect\(received\)\.toBe\(expected\)\n  - Expected: "Send"/)
  assert.doesNotMatch(body, /abandon ability|\u001b/)
})

test('failure details redact credentials and personal data before formatting', () => {
  const s = summarizeResults({ suites: [{ specs: [{ title: 'failure', tests: [{ status: 'unexpected', results: [{ error: {
    message: 'Cookie: session=private-session\nToken: private-token\nCustomer alice@example.com',
    location: { file: '/tmp/tests/alice@example.com/wallet-secret.spec.ts', line: 4 },
  } }] }] }] }] }, { secrets: ['wallet-secret'] })
  const body = formatReview({ actor: 'alice', number: 1, sha: 'abc', result: { verdict: 'failed', summary: s } })
  assert.doesNotMatch(JSON.stringify(s), /private-session|private-token|alice@example.com|wallet-secret/)
  assert.doesNotMatch(body, /private-session|private-token|alice@example.com|wallet-secret/)
})

test('missing results are unverified even after a timeout or nonzero exit', () => {
  for (const timedOut of [false, true]) for (const exitCode of [0, 1, null]) {
    assert.equal(decideVerdict({ summary: null, timedOut, exitCode }).verdict, 'blocked')
  }
})

test('test names and skip reasons redact configured secrets and API tokens before Markdown formatting', () => {
  const previous = process.env.QA_SEED_PHRASE
  process.env.QA_SEED_PHRASE = 'fixture wallet phrase with punctuation @[]'
  try {
    const summary = summarizeResults({ suites: [{ specs: [{ title: process.env.QA_SEED_PHRASE,
      tests: [{ status: 'skipped', annotations: [{ type: 'skip', description: 'sk-fixtureSecret123' }] }] }] }] })
    const body = formatReview({ actor: 'alice', number: 1, sha: 'abc', result: { verdict: 'blocked', summary } })
    assert.doesNotMatch(body, /fixture wallet phrase|fixtureSecret123/)
    assert.match(body, /REDACTED/)
  } finally {
    if (previous === undefined) delete process.env.QA_SEED_PHRASE
    else process.env.QA_SEED_PHRASE = previous
  }
})

test('large failure details stay within the callback budget with a truncation notice', () => {
  const cases = Array.from({ length: 120 }, () => ({ name: 'n'.repeat(200), status: 'failed', failure: { location: 'l'.repeat(160), message: Array(3).fill('m'.repeat(200)) } }))
  const body = formatReview({ actor: 'alice', number: 12, sha: 'a'.repeat(40), result: { verdict: 'failed', summary: { passed: 0, failed: cases.map(c => c.name), flaky: 0, skipped: 0, cases } } })
  assert.ok(body.length <= 59_000)
  assert.match(body, /truncated/)
  assert.match(body, /\*\*Pull request:\*\*/)
})

test('a failed case shows the code around the failing line, fenced, with secrets removed', () => {
  const failing = { title: 'send rejects zero amount', tests: [{ status: 'unexpected', annotations: [], results: [{ error: {
    message: 'Error: expect(received).toBe(expected)',
    location: { file: '/private/tmp/x/chrom extension/tests/send.spec.ts', line: 24, column: 5 },
    snippet: '\u001b[2m  22 |\u001b[39m const seed = `abandon ability`\n> 24 |   await expect(page.getByText("Send")).toBeVisible()\n     |                                       ^\n  25 |',
  } }] }] }
  const s = summarizeResults({ suites: [{ title: 'send.spec.ts', specs: [failing], suites: [] }], errors: [] }, { secrets: ['abandon ability'] })
  assert.deepEqual(s.cases[0].failure.snippet, [
    '  22 | const seed = `(redacted)`',
    '> 24 |   await expect(page.getByText("Send")).toBeVisible()',
    '     |                                       ^',
    '  25 |',
  ])
  const body = formatReview({ actor: 'alice', number: 4, sha: 'c'.repeat(40), result: { verdict: 'failed', summary: s } })
  assert.match(body, /  - failed at `tests\/send\.spec\.ts:24`\n  ```\n {4}22 \| const seed = '\(redacted\)'\n {2}> 24 \|   await expect/)
  assert.doesNotMatch(body, /abandon ability|\u001b/)
})

test('a failing excerpt cannot close its code fence early', () => {
  const s = summarizeResults({ suites: [{ specs: [{ title: 'fence', tests: [{ status: 'unexpected', results: [{ error: {
    message: 'Error: boom', location: { file: '/tmp/tests/fence.spec.ts', line: 3 },
    snippet: '> 3 | await page.locator("```").click()',
  } }] }] }] }] }, {})
  const body = formatReview({ actor: 'alice', number: 5, sha: 'd'.repeat(40), result: { verdict: 'failed', summary: s } })
  assert.equal(body.split('\n').filter(line => line.trim() === '```').length, 2)
  assert.match(body, /await page\.locator\("'''"\)\.click\(\)/)
})

test('a passing case or a case without an excerpt adds no code block', () => {
  const body = formatReview({ actor: 'alice', number: 6, sha: 'e'.repeat(40), result: { verdict: 'failed', summary: summarizeResults(json) } })
  assert.doesNotMatch(body, /```/)
})
