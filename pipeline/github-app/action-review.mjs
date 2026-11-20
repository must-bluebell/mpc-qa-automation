#!/usr/bin/env node
/**
 * Runs inside the reusable GitHub Action (.github/workflows/automation-review.yml) on the QA runner. It runs the
 * tests that the App dispatched, formats the same review comment as the in-process reviewer, and reports the result
 * back to the App. The wallet secret is injected only into this step and the test child.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SetupError, withPipelineLock } from './reviewer.mjs'
import { runProcess } from '../lib/proc.mjs'
import { parseCallback, verifyDispatch } from './actions.mjs'
import { ARGUMENT, validatePreviewUrl } from './policy.mjs'
import { decideVerdict, formatReview, summarizeResults } from './report.mjs'
import { sign } from './signature.mjs'

/** Parent variables the test child may inherit; the callback secret is deliberately absent. */
const CHILD_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_OPTIONS', 'PLAYWRIGHT_BROWSERS_PATH', 'npm_config_cache']
const SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Validates every value the dispatch supplies before anything runs. Throws with a message fit for the PR comment. */
export function readInputs(env) {
  const fail = message => { throw new Error(message) }
  const reviewId = env.REVIEW_ID ?? ''
  if (!/^[0-9a-f]{32}$/.test(reviewId)) fail('REVIEW_ID is missing or malformed')
  const repository = env.REVIEW_REPOSITORY ?? ''
  if (!REPOSITORY.test(repository)) fail('REVIEW_REPOSITORY must be owner/repository')
  const number = Number(env.REVIEW_PR)
  if (!Number.isSafeInteger(number) || number < 1) fail('REVIEW_PR must be a pull request number')
  if (!SHA.test(env.REVIEW_SHA ?? '')) fail('REVIEW_SHA must be a full commit SHA')
  const baseUrl = validatePreviewUrl(env.REVIEW_BASE_URL)
  if (!baseUrl) fail('REVIEW_BASE_URL must be the HTTPS root of a *.vercel.app deployment')
  if (env.REVIEW_CHAIN_ID !== '97') fail('REVIEW_CHAIN_ID must be 97 (testnet)')
  let args
  try { args = JSON.parse(env.REVIEW_ARGS ?? '') } catch { fail('REVIEW_ARGS must be a JSON list of Playwright arguments') }
  if (!Array.isArray(args) || !args.length || !args.every(a => typeof a === 'string' && ARGUMENT.test(a) && !a.startsWith('--reporter') && !a.startsWith('--output'))) {
    fail('REVIEW_ARGS must be plain Playwright arguments')
  }
  const callbackUrl = env.REVIEW_CALLBACK_URL ?? ''
  if (!/^https:\/\//.test(callbackUrl)) fail('the callback URL must be HTTPS')
  if ((env.REVIEW_CALLBACK_SECRET ?? '').length < 16) fail('the callback secret is not configured on the runner')
  if (!env.QA_SEED_PHRASE || !env.WALLET_ADDRESS) fail('the test wallet is not configured on the QA runner')
  const timeoutMinutes = Number(env.REVIEW_TIMEOUT_MINUTES)
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 180) fail('REVIEW_TIMEOUT_MINUTES must be an integer from 1 to 180')
  if (Number(env.REVIEW_JOB_TIMEOUT_MINUTES) !== timeoutMinutes + 60) fail('REVIEW_JOB_TIMEOUT_MINUTES must include the 60 minute setup and lock budget')
  if (!env.QA_PIPELINE_LOCK_DIR || !isAbsolute(env.QA_PIPELINE_LOCK_DIR)) fail('QA_PIPELINE_LOCK_DIR must be the absolute shared scheduler lock directory')
  return {
    reviewId, repository, number, sha: env.REVIEW_SHA, baseUrl, args, callbackUrl, callbackSecret: env.REVIEW_CALLBACK_SECRET,
    requestedBy: env.REVIEW_REQUESTED_BY || 'the review command', walletSeed: env.QA_SEED_PHRASE, walletAddress: env.WALLET_ADDRESS,
    walletIndex: env.WALLET_ADDRESS_INDEX || '0', timeoutMinutes,
    runUrl: env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    testsRepository: env.GITHUB_REPOSITORY || '', testsSha: env.GITHUB_SHA || '', testsRef: env.GITHUB_REF_NAME || '',
  }
}

const headlineOf = (verdict, summary) => {
  if (summary) return `${summary.passed} passed, ${summary.failed.length} failed, ${summary.skipped} skipped${verdict.reason ? ` · ${verdict.reason}` : ''}`
  return verdict.reason || 'no readable results'
}

/**
 * Sends the signed report. Network errors and 5xx responses are retried; a 4xx means the App refused the report,
 * so retrying cannot help and the error is raised at once.
 */
export async function postCallback({ url, secret, report, fetchImpl = fetch, retries = 3, pauseMs = 2_000 }) {
  const raw = JSON.stringify(report)
  for (let attempt = 1; attempt <= retries; attempt++) {
    let response
    try {
      response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qa-signature': sign(secret, Buffer.from(raw)) }, body: raw, signal: AbortSignal.timeout(20_000) })
    } catch (error) {
      if (attempt === retries) throw new Error(`the review report could not reach the App (${error.name})`)
      await new Promise(resolve => setTimeout(resolve, pauseMs * attempt))
      continue
    }
    if (response.ok) return
    if (response.status < 500 || attempt === retries) throw new Error(`the App refused the review report (HTTP ${response.status})`)
    await new Promise(resolve => setTimeout(resolve, pauseMs * attempt))
  }
}

/** Reject altered/manual dispatches before either running tests or reporting setup failures. */
function authorizeDispatch(env) {
  const inputs = Object.fromEntries([
    ['review_id', 'REVIEW_ID'], ['repository', 'REVIEW_REPOSITORY'], ['pr_number', 'REVIEW_PR'],
    ['head_sha', 'REVIEW_SHA'], ['base_url', 'REVIEW_BASE_URL'], ['chain_id', 'REVIEW_CHAIN_ID'],
    ['job_timeout_minutes', 'REVIEW_JOB_TIMEOUT_MINUTES'], ['timeout_minutes', 'REVIEW_TIMEOUT_MINUTES'], ['playwright_args', 'REVIEW_ARGS'], ['requested_by', 'REVIEW_REQUESTED_BY'],
  ].map(([key, name]) => [key, env[name] ?? '']))
  if (!verifyDispatch(env.REVIEW_CALLBACK_SECRET, env.GITHUB_REPOSITORY, env.GITHUB_REF_NAME, inputs, env.REVIEW_DISPATCH_TOKEN)) {
    throw new Error('invalid dispatch credential')
  }
}

/** Runs the dispatched tests once, writes the report files, reports the verdict to the App and returns it. */
export async function runAction({ env = process.env, outDir, run = runProcess, post = postCallback, lockOptions = {} } = {}) {
  authorizeDispatch(env)
  let inputs
  try { inputs = readInputs(env) } catch (error) {
    // A setup problem is reported to the pull request when the callback itself is configured; otherwise the App's sweep records it.
    if (/^[0-9a-f]{32}$/.test(env.REVIEW_ID ?? '') && /^https:\/\//.test(env.REVIEW_CALLBACK_URL ?? '') && (env.REVIEW_CALLBACK_SECRET ?? '').length >= 16) {
      const report = { reviewId: env.REVIEW_ID, dispatchToken: env.REVIEW_DISPATCH_TOKEN, verdict: 'blocked', headline: error.message, body: `### ⚠️ Automation review could not run\n\n${error.message}`, runUrl: null }
      await post({ url: env.REVIEW_CALLBACK_URL, secret: env.REVIEW_CALLBACK_SECRET, report })
    }
    throw error
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const resultsFile = join(outDir, 'results.json')
  const started = Date.now()
  const result = await withPipelineLock(`action-${inputs.reviewId}`, () => run('npx', ['playwright', 'test', ...inputs.args, '--reporter=json'], {
    cwd: process.cwd(), onlyEnv: CHILD_ENV, passSecrets: ['QA_SEED_PHRASE'], echo: true, logFile: join(outDir, 'playwright.log'),
    timeoutMs: inputs.timeoutMinutes * 60_000,
    env: {
      PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile, CI: '1', BASE_URL: inputs.baseUrl, QA_CHAIN_ID: '97',
      QA_SEED_PHRASE: inputs.walletSeed, WALLET_ADDRESS: inputs.walletAddress, WALLET_ADDRESS_INDEX: inputs.walletIndex,
      QA_VERSION: inputs.sha.slice(0, 12), QA_RUN_LABEL: `PR review ${inputs.repository}#${inputs.number}`, QA_ENVIRONMENT: 'pr-preview',
    },
  }), { ...lockOptions, lockDirectory: env.QA_PIPELINE_LOCK_DIR }).catch(error => {
    if (!(error instanceof SetupError)) throw error
    return { code: 1, blockedReason: error.message }
  })
  let summary = null
  try { summary = summarizeResults(JSON.parse(readFileSync(resultsFile, 'utf8')), { secrets: [inputs.walletSeed, inputs.callbackSecret] }) } catch { /* no readable results */ }
  const verdict = result.blockedReason ? { verdict: 'blocked', reason: result.blockedReason } : decideVerdict({ exitCode: result.code ?? 1, timedOut: result.timedOut, summary })
  const body = formatReview({
    actor: inputs.requestedBy, number: inputs.number, sha: inputs.sha,
    tests: { repository: inputs.testsRepository, ref: inputs.testsRef, sha: inputs.testsSha }, target: inputs.baseUrl,
    result: { ...verdict, summary, durationMs: Date.now() - started, scope: `GitHub Action run · ${inputs.args.join(' ')}` },
  }) + (inputs.runUrl ? `\n\n**Run:** ${inputs.runUrl}` : '')
  const report = { reviewId: inputs.reviewId, dispatchToken: env.REVIEW_DISPATCH_TOKEN, verdict: verdict.verdict, headline: headlineOf(verdict, summary), body, runUrl: inputs.runUrl }
  parseCallback(report)
  writeFileSync(join(outDir, 'review.md'), body, { mode: 0o600 })
  writeFileSync(join(outDir, 'review.json'), JSON.stringify({ repository: inputs.repository, number: inputs.number, sha: inputs.sha, verdict: report.verdict, headline: report.headline, runUrl: report.runUrl }, null, 2), { mode: 0o600 })
  await post({ url: inputs.callbackUrl, secret: inputs.callbackSecret, report })
  return verdict.verdict
}

async function main() {
  const outDir = resolve(process.env.REVIEW_OUTPUT_DIR || 'review-output')
  const verdict = await runAction({ outDir }).catch(error => { console.error(error.message); return 'blocked' })
  process.exitCode = verdict === 'passed' ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
