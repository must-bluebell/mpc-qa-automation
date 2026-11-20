import { randomBytes } from 'node:crypto'
import { sign, verifySignature } from './signature.mjs'

/** The reusable workflow in this repository that runs the review on the QA runner. */
export const WORKFLOW_FILE = 'automation-review.yml'
export const CHECK_NAME = 'MPC QA automation review'

const VERDICTS = new Set(['passed', 'failed', 'blocked'])
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/
const CONCLUSION = { passed: 'success', failed: 'failure', blocked: 'neutral' }
const TITLE = { passed: 'Automation review passed', failed: 'Automation review failed', blocked: 'Automation review could not verify this PR' }

export const newReviewId = () => randomBytes(16).toString('hex')

/** workflow_dispatch inputs must be strings. The run is named after review_id so it can be found again. */
export function dispatchInputs({ reviewId, repository, number, sha, baseUrl, chainId, playwrightArgs, requestedBy, timeoutMinutes = 40 }) {
  return {
    review_id: reviewId, repository, pr_number: String(number), head_sha: sha, base_url: baseUrl,
    timeout_minutes: String(timeoutMinutes), job_timeout_minutes: String(Number(timeoutMinutes) + 60), chain_id: String(chainId), playwright_args: JSON.stringify(playwrightArgs), requested_by: requestedBy,
  }
}

// Domain-separated, ordered payload binds the credential to every dispatch input and tests ref.
export function dispatchPayload(testsRepository, ref, inputs) {
  return JSON.stringify(['automation-dispatch-v1', testsRepository, ref,
    ...['review_id', 'repository', 'pr_number', 'head_sha', 'base_url', 'chain_id', 'playwright_args', 'requested_by', 'timeout_minutes', 'job_timeout_minutes'].map(key => inputs[key] ?? '')])
}
export function signDispatch(secret, testsRepository, ref, inputs) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('dispatch signing secret is not configured')
  return sign(secret, dispatchPayload(testsRepository, ref, inputs))
}
export function verifyDispatch(secret, testsRepository, ref, inputs, token) {
  return verifySignature(secret, dispatchPayload(testsRepository, ref, inputs), token)
}

/**
 * The only shape the runner may report back. The repository, pull request and commit come from our own
 * state, keyed by reviewId, so a report can never redirect a comment to another pull request.
 */
export function parseCallback(value) {
  const fail = message => { throw new Error(`review report: ${message}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object')
  const { reviewId, dispatchToken, verdict, headline, body } = value
  const runUrl = value.runUrl ?? null
  if (!/^[0-9a-f]{32}$/.test(reviewId ?? '')) fail('reviewId is malformed')
  if (!/^sha256=[0-9a-f]{64}$/.test(dispatchToken ?? '')) fail('dispatchToken is malformed')
  if (!VERDICTS.has(verdict)) fail('verdict must be passed, failed or blocked')
  if (typeof headline !== 'string' || !headline.trim() || headline.length > 300) fail('headline must be 1-300 characters')
  if (typeof body !== 'string' || !body.trim() || body.length > 60_000) fail('body must be 1-60000 characters')
  if (runUrl !== null && (typeof runUrl !== 'string' || !RUN_URL.test(runUrl))) fail('runUrl must be a GitHub Actions run URL')
  return { reviewId, dispatchToken, verdict, headline: headline.trim(), body, runUrl }
}

/**
 * Operations on the GitHub Actions run and the pull request's check. `github` is the App client from github.mjs.
 * Dispatch and run lookup happen on the tests repository; the check lives on the pull request's repository.
 */
export function createActionsClient({ github, testsRepository, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), lookups = 6, lookupMs = 3000 }) {
  return {
    async dispatch({ ref, inputs, testsRepository: repository = testsRepository }) {
      await github.dispatchWorkflow(repository, WORKFLOW_FILE, ref, inputs)
    },
    /** A dispatch returns no run ID, so the run is found by the review_id in its run name. Null means not found yet. */
    async findRun(reviewId, repository = testsRepository) {
      for (let attempt = 0; attempt < lookups; attempt++) {
        const run = (await github.listWorkflowRuns(repository)).find(r => (r.display_title ?? r.name ?? '').includes(`automation-review ${reviewId}`))
        if (run) return { id: run.id, url: run.html_url }
        await sleep(lookupMs)
      }
      return null
    },
    async createCheck(repo, { sha, reviewId }) {
      const check = await github.createCheckRun(repo, {
        name: CHECK_NAME, head_sha: sha, status: 'in_progress',
        output: { title: 'Waiting for the QA runner', summary: `The GitHub Action for review ${reviewId.slice(0, 8)} is queued on the QA runner.` },
      })
      return check.id
    },
    finishCheck(repo, checkId, { verdict, headline, runUrl }) {
      return github.updateCheckRun(repo, checkId, {
        status: 'completed', conclusion: CONCLUSION[verdict], completed_at: new Date().toISOString(),
        ...(runUrl ? { details_url: runUrl } : {}),
        output: { title: TITLE[verdict], summary: headline || 'See the pull request comment for details.' },
      })
    },
  }
}
