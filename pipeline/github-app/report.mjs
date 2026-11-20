import { safeText } from '../lib/safe-output.mjs'

/** Text that comes from test titles is untrusted for Markdown: no mentions, links, HTML or fences. */
const clean = (text, max = 140) => safeText(text).replace(/[\r\n]+/g, ' ').replace(/[`<>[\]()@#|*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
// Assertion text keeps parentheses (toBe(expected)); links need [ ] and are still removed.
const cleanDetail = (text, max = 200) => String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/[`<>[\]@#|*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
// Bound case count and rendered details separately; reserve space for metadata and the run URL.
const MAX_CASES = 120
const MAX_MESSAGE_LINES = 3
// Playwright's excerpt around the failing line: a few lines of the test source, with the failing line marked by ">".
const MAX_SNIPPET_LINES = 8
const duration = ms => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`

/**
 * Where a failed test broke, the code around that line and the first lines of its assertion message. Paths are
 * shortened to the tests folder; ANSI colours, stack traces and any known secret are removed before the text can
 * reach a comment.
 */
export function failureOf(result, secrets = []) {
  const error = result?.error ?? result?.errors?.[0]
  if (!error) return null
  const redact = value => {
    let text = String(value ?? '')
    for (const secret of secrets) if (secret) text = text.split(secret).join('(redacted)')
    return safeText(text)
  }
  const file = redact(error.location?.file)
  const location = file ? `${(file.match(/tests\/.*$/) ?? [file.split('/').pop()])[0]}:${redact(error.location.line)}` : null
  let text = String(error.message ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  text = redact(text)
  const message = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^at\s|^\s*\d+\s*\|/.test(line)).slice(0, MAX_MESSAGE_LINES)
  const snippet = redact(String(error.snippet ?? '').replace(/\x1b\[[0-9;]*m/g, '')).split(/\r?\n/).slice(0, MAX_SNIPPET_LINES).map(line => line.replace(/\s+$/, '').slice(0, 160))
  return { location, message, ...(snippet.some(line => line.trim()) ? { snippet } : {}) }
}

/** Pulls verdict and counts out of a Playwright JSON report. Skipped tests are never counted as passes. */
export function summarizeResults(json, { secrets = [] } = {}) {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 }, failed = [], cases = []
  const walk = (suite, path) => {
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) {
      const key = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' }[t.status]
      if (!key) continue
      counts[key]++
      const name = [...path, spec.title].join(' › ')
      if (key === 'failed') failed.push(name)
      // Playwright stores the reason given to test.skip(condition, reason) as a skip annotation.
      const reason = (t.annotations ?? []).find(a => a.type === 'skip' || a.type === 'blocked')?.description
      const failure = key === 'failed' ? failureOf(t.results?.at(-1), secrets) : null
      cases.push({ name, status: key, ...(reason ? { reason } : {}), ...(failure ? { failure } : {}) })
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title])
  }
  for (const suite of json?.suites ?? []) walk(suite, [])
  return { ...counts, failed, cases, globalErrors: (json?.errors ?? []).length }
}

/** Combines the summaries of several sequential runs into one, so counts and failures cover every run. */
export function mergeSummaries(parts) {
  const merged = { passed: 0, failed: [], flaky: 0, skipped: 0, cases: [], globalErrors: 0 }
  for (const part of parts) {
    merged.passed += part.passed; merged.flaky += part.flaky; merged.skipped += part.skipped
    merged.failed.push(...part.failed); merged.cases.push(...part.cases); merged.globalErrors += part.globalErrors
  }
  return merged
}

export function decideVerdict({ exitCode, timedOut, summary }) {
  if (!summary) return { verdict: 'blocked', reason: 'the test run produced no readable results, so nothing was verified' }
  if (timedOut) return { verdict: 'failed', reason: 'the test run exceeded its time limit' }
  if (summary.failed.length || summary.globalErrors) return { verdict: 'failed' }
  if (exitCode !== 0) return { verdict: 'failed', reason: `the test runner exited with code ${exitCode}` }
  if (summary.passed + summary.flaky === 0) return { verdict: 'blocked', reason: 'no tests executed (every test was skipped), so nothing was verified' }
  return { verdict: 'passed' }
}

export function formatReview({ actor, number, sha, tests, target, result }) {
  const short = value => String(value ?? '').slice(0, 7)
  const head = { passed: '✅ Automation review passed', failed: '❌ Automation review failed', blocked: '⚠️ Automation review could not verify this PR' }[result.verdict]
  const lines = [`### ${head}`, '']
  if (result.reason) lines.push(`**Why:** ${clean(result.reason, 300)}`, '')
  if (result.scope) lines.push(`**Scope:** ${clean(result.scope, 300)}`, '')
  if (result.summary) {
    const s = result.summary
    lines.push(`**Results:** ${s.passed} passed, ${s.failed.length} failed, ${s.flaky} flaky, ${s.skipped} skipped${result.durationMs ? ` · ${duration(result.durationMs)}` : ''}`)
    if (s.cases?.length) {
      const icon = { passed: '✅', failed: '❌', flaky: '⚠️', skipped: '⏭️' }
      const line = c => `- ${icon[c.status]} ${clean(c.name, 200)}${c.status === 'skipped' ? ` (skipped${c.reason ? `: ${clean(c.reason, 140)}` : ''})` : ''}`
      // A failed case gets its failing location and message lines under it, so a reader can see what broke.
      const detail = c => {
        if (!c.failure) return []
        const where = c.failure.location ? [`  - failed at \`${cleanDetail(c.failure.location, 160)}\``] : []
        // The excerpt is code, so it is fenced; a fence inside the source cannot close the block early.
        const code = c.failure.snippet ? ['  ```', ...c.failure.snippet.map(line => `  ${line.replace(/`/g, "'")}`), '  ```'] : []
        return [...where, ...code, ...c.failure.message.map(m => `  - ${cleanDetail(m, 200)}`)]
      }
      lines.push('', '**Test cases**')
      let shown = 0, length = lines.join('\n').length
      for (const c of s.cases.slice(0, MAX_CASES)) {
        const rendered = [line(c), ...detail(c)].join('\n')
        if (length + rendered.length + 1 > 57_000) break
        lines.push(rendered); length += rendered.length + 1; shown++
      }
      if (shown < s.cases.length) lines.push(`- … and ${s.cases.length - shown} more (details truncated; see the QA server)`)

    } else if (s.failed.length) lines.push('', '**Failed tests**', ...s.failed.slice(0, 15).map(t => `- ${clean(t)}`), ...(s.failed.length > 15 ? [`- … and ${s.failed.length - 15} more`] : []))
    if (s.flaky) lines.push('', `${s.flaky} test(s) passed only after a retry.`)
  }
  lines.push('', `**Pull request:** #${number} at \`${short(sha)}\``)
  if (target) lines.push(`**Target tested:** ${clean(target.replace(/^https:\/\//, ''), 100)}`)
  if (tests) lines.push(`**Automation tests:** ${clean(tests.repository)} @ ${clean(tests.ref)} (\`${short(tests.sha)}\`)`)
  lines.push('', `<sub>Requested by @${clean(actor, 39)} with the review command. Reports contain test names, failure locations, the code lines around each failure and the first assertion message lines only; evidence stays on the QA server.</sub>`)
  return lines.join('\n')
}

export function formatNotice({ actor, title, message }) {
  return [`### ⚠️ ${clean(title, 100)}`, '', clean(message, 600), '', `<sub>Requested by @${clean(actor, 39)}.</sub>`].join('\n')
}
