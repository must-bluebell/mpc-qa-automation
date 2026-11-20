import { AUTOMATIC_ACTIONS, isAuthorizedPermission, parseCommand } from './policy.mjs'
import { findPreview, GitHubError } from './github.mjs'
import { formatNotice, formatReview } from './report.mjs'
import { SetupError } from './reviewer.mjs'
import { dispatchInputs, newReviewId, signDispatch } from './actions.mjs'

const outcome = (status, reason) => ({ status, reason })

/**
 * Turns a verified `issue_comment` delivery into at most one queued review. All checks that can reject
 * a request run before any GitHub side effect; unauthorized users get no reaction and no comment.
 * Reviews run one at a time because they share a single test wallet session.
 */
export function createHandler({ settings, github, runReview, state, actions, dispatchSecret, log = () => {}, queueLimit = 10, now = Date.now }) {
  const queue = [], active = new Set()
  // At most one follow-up per pull request: the newest commit pushed while that pull request was being reviewed.
  const followUps = new Map()
  const finishing = new Map()
  const reconciling = new Set()
  let running = false, idleWaiters = []

  async function pump() {
    if (running) return
    running = true
    try {
      for (let job; (job = queue.shift());) {
        try { const outcome = await job.run(); if (!outcome?.waiting) state.complete(job.commentId) } catch (error) { log('review-error', { repo: job.repo, number: job.number, error: error.message }) }
        active.delete(job.key)
        const next = followUps.get(job.key)
        if (next) { followUps.delete(job.key); enqueue(next.job, next.repoSettings, next.config) }
      }
    } finally { running = false; idleWaiters.splice(0).forEach(resolve => resolve()) }
  }

  async function review({ repo, number, actor, commentId, repoSettings, config }) {
    const notice = (title, message) => formatNotice({ actor, title, message })
    try {
      const pull = await github.pull(repo, number)
      if (pull.state !== 'open') return notice('Review skipped', 'This pull request is no longer open.')
      // Fork heads can contain code from outside the organization; they never get the test wallet or a review.
      if (pull.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) return notice('Review skipped', 'Pull requests from forks are not reviewed automatically.')
      const sha = pull.head.sha
      if (typeof commentId === 'string' && !commentId.endsWith(`@${sha}`)) return { superseded: true }
      const localStack = repoSettings.localStack
      const baseUrl = localStack || repoSettings.extension ? undefined : repoSettings.fixedBaseUrl ?? await findPreview(github, repo, sha, { prefix: repoSettings.previewHostPrefix })
      if (!localStack && !repoSettings.extension && !baseUrl && typeof commentId === 'string') { state.patch(commentId, { waitingPreview: true }); return { waiting: true } }
      if (!localStack && !repoSettings.extension && !baseUrl) return notice('No preview to test', `There is no ready Vercel preview for commit ${sha.slice(0, 7)} yet. Wait for the deployment to finish, then comment again.`)
      // Unreadable or incomplete file lists fall back to every impact rule (null), never to fewer tests.
      const changedFiles = await github.pullFiles(repo, number).catch(error => { log('files-failed', { repo, number, error: error.message }); return null })
      const result = await runReview({ repo, number, sha, baseUrl, localStack, chainId: repoSettings.chainId, settings: config, repoSettings, changedFiles, log })
      const latest = await github.pull(repo, number).catch(() => null)
      const stale = latest && latest.head?.sha !== sha
      const body = formatReview({ actor, number, sha, tests: result.tests, target: result.targetLabel ?? baseUrl, result }) +
        (stale ? `\n\n> A newer commit (\`${latest.head.sha.slice(0, 7)}\`) was pushed during this run; comment again to review it.` : '')
      log('review-finished', { repo, number, verdict: result.verdict })
      return body
    } catch (error) {
      log('review-failed', { repo, number, error: error.message })
      const message = error instanceof SetupError ? error.message : 'An internal error stopped the review before it finished. The QA server log has details.'
      return notice('Automation review could not run', message)
    }
  }

  function enqueue(job, repoSettings, config) {
    const { repo, number, commentId } = job
    const key = `${repo.toLowerCase()}#${number}`
    active.add(key)
    queue.push({ ...job, key, run: async () => {
      // Automatic runs (pull request events) have no comment to react to; their commentId is a text claim key.
      if (typeof commentId === 'number') {
        try { await github.react(repo, commentId, 'eyes') } catch (error) { log('reaction-failed', { repo, number, error: error.message }) }
      }
      // A saved local result must be delivered even if policy changed engines while it was pending.
      if (job.resultBody === undefined && repoSettings.engine === 'actions') return dispatchReview({ ...job, repoSettings, config })
      const body = job.resultBody ?? await review({ ...job, repoSettings, config })
      if (body?.waiting) return body
      if (body?.superseded) return
      if (job.resultBody === undefined) state.saveResult(commentId, body)
      // Delivery errors must escape to pump, leaving the saved result pending for restart recovery.
      await github.comment(repo, number, body, { key: String(commentId) })
    } })
  }

  /**
   * Starts a review when a pull request is opened, reopened or marked ready. One review per head commit, so a
   * reopened pull request is not tested twice. Forks, drafts and non-members are skipped without a comment.
   */
  async function automatic({ payload, delivery }) {
    const config = settings()
    const repo = payload.repository?.full_name
    const repoSettings = typeof repo === 'string' ? config.repositories.get(repo.toLowerCase()) : null
    if (!repoSettings?.enabled) return outcome('ignored', 'repository-not-enabled')
    if (!AUTOMATIC_ACTIONS.has(payload.action)) return outcome('ignored', 'event')
    const pull = payload.pull_request
    if (!pull || pull.state !== 'open') return outcome('ignored', 'pull-request-closed')
    if (pull.draft) return outcome('ignored', 'draft')
    if (pull.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) return outcome('ignored', 'fork')
    const number = pull.number, actor = pull.user?.login, sha = pull.head?.sha
    if (!Number.isSafeInteger(number) || typeof actor !== 'string' || !/^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(actor) || !/^[0-9a-f]{40}$/.test(sha ?? '')) return outcome('ignored', 'malformed')
    if (pull.user?.type === 'Bot') return outcome('ignored', 'bot')
    // The payload's author_association can be stale (a PR opened by a member was delivered as CONTRIBUTOR),
    // so automatic reviews ask GitHub for the author's current permission on this repository.
    const permission = await github.permissionOf(repo, actor).catch(() => 'none')
    if (!isAuthorizedPermission(permission)) {
      log('rejected', { repo, number, actor, permission, association: pull.author_association, trigger: 'pull_request' })
      return outcome('rejected', 'not-authorized')
    }
    const key = `pr:${repo.toLowerCase()}#${number}@${sha}`
    const pullKey = `${repo.toLowerCase()}#${number}`
    const job = { repo, number, actor, commentId: key }
    // Another review of this pull request is queued or running. Review the newest commit once it finishes; an older
    // pending follow-up for the same pull request is superseded and never runs.
    if (active.has(pullKey)) {
      if (!state.claim(key, job)) return outcome('ignored', 'duplicate')
      const superseded = followUps.get(pullKey)
      if (superseded) state.complete(superseded.job.commentId)
      followUps.set(pullKey, { job, repoSettings, config })
      log('queued-after-active', { repo, number, actor, delivery, trigger: 'pull_request' })
      return outcome('accepted', 'queued-after-active')
    }
    if (queue.length >= queueLimit) return outcome('ignored', 'queue-full')
    if (!state.claim(key, job)) return outcome('ignored', 'duplicate')
    log('accepted', { repo, number, actor, delivery, trigger: 'pull_request' })
    enqueue(job, repoSettings, config)
    pump()
    return outcome('accepted', 'queued')
  }

  /**
   * Engine "actions": the review runs in the GitHub Action. This step resolves the head commit and its preview, creates
   * the pull request check and starts the workflow. The verdict arrives later through completeReview(), so the job
   * stays pending and the queue is released (`waiting`). The reviewId ties the run, the check and the report together.
   */
  async function dispatchReview({ repo, number, actor, commentId, repoSettings, config }) {
    const notice = (title, message) => github.comment(repo, number, formatNotice({ actor, title, message }))
    let record
    try {
      const pull = await github.pull(repo, number)
      if (pull.state !== 'open') return await notice('Review skipped', 'This pull request is no longer open.')
      if (pull.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) return await notice('Review skipped', 'Pull requests from forks are not reviewed automatically.')
      const sha = pull.head.sha
      if (typeof commentId === 'string' && !commentId.endsWith(`@${sha}`)) return
      const baseUrl = repoSettings.fixedBaseUrl ?? await findPreview(github, repo, sha, { prefix: repoSettings.previewHostPrefix })
      if (!baseUrl && typeof commentId === 'string') { state.patch(commentId, { waitingPreview: true }); return { waiting: true } }
      if (!baseUrl) return await notice('No preview to test', `There is no ready Vercel preview for commit ${sha.slice(0, 7)} yet. Wait for the deployment to finish, then comment again.`)
      // Duplicate requests for the same commit share one run, even when they come from different comments.
      const running = state.pending().find(job => job.reviewId && !job.result && job.repo.toLowerCase() === repo.toLowerCase() && job.number === number && job.sha === sha)
      if (running) return await notice('Review already running', `Commit ${sha.slice(0, 7)} is already being reviewed. Its result will be posted here when the GitHub Action finishes.`)
      const reviewId = newReviewId(), ref = repoSettings.testsRef ?? config.testsRef
      const inputs = dispatchInputs({ reviewId, repository: repo, number, sha, baseUrl, chainId: repoSettings.chainId, playwrightArgs: repoSettings.playwrightArgs, requestedBy: actor, timeoutMinutes: config.timeoutMinutes })
      const dispatchToken = signDispatch(dispatchSecret, config.testsRepository, ref, inputs)
      const checkId = await actions.createCheck(repo, { sha, reviewId })
      record = { dispatchInputs: inputs, dispatchState: 'pending', dispatchToken, testsRepository: config.testsRepository, commentId, repo, number, actor, sha, reviewId, checkId, baseUrl, ref, expiresAt: now() + (config.timeoutMinutes + 60) * 60_000 }
      // Saved before dispatch, so a verdict that arrives early still finds its job.
      state.patch(commentId, record)
      await actions.dispatch({ testsRepository: record.testsRepository, ref, inputs: { ...inputs, dispatch_token: dispatchToken } })
    } catch (error) {
      log('dispatch-failed', { repo, number, error: error.message })
      if (!record) return await notice('Automation review could not run', 'An internal error stopped the review before it started. The QA server log has details.')
      // A lost response or transient failure may hide an accepted dispatch. Keep its
      // intent and callback credential alive; sweep reconciles GitHub runs before retrying.
      const rejected = error instanceof GitHubError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
      if (!rejected) return { waiting: true }
      // Let delivery errors reach pump so the saved blocked result stays pending for recovery.
      await finish(record, { verdict: 'blocked', headline: 'the GitHub Action could not be started', body: formatNotice({ actor, title: 'Automation review could not run', message: 'The GitHub Action could not be started. The QA server log has details.' }), runUrl: null })
      return undefined
    }
    // Dispatched. The run is looked up for tracking only; a failed lookup never blocks the result.
    state.patch(commentId, { dispatchState: 'dispatched', dispatched: true, dispatchedAt: now() })
    const run = await actions.findRun(record.reviewId, record.testsRepository).catch(error => { log('run-lookup-failed', { repo, number, error: error.message }); return null })
    if (run) state.patch(commentId, { runId: run.id, runUrl: run.url })
    log('dispatched', { repo, number, sha: record.sha.slice(0, 7), run: run?.id ?? null })
    return { waiting: true }
  }

  // Reconcile a persisted dispatch intent before retrying it. Never infer absence from a failed lookup.
  async function reconcileDispatch(record) {
    if (reconciling.has(record.reviewId) || active.has(`${record.repo.toLowerCase()}#${record.number}`)) return
    reconciling.add(record.reviewId)
    try {
      const run = await actions.findRun(record.reviewId, record.testsRepository)
      // A callback may have completed the job during the lookup.
      const current = state.pending().find(job => job.reviewId === record.reviewId)
      if (!current || current.result) return
      if (!run) await actions.dispatch({ testsRepository: record.testsRepository, ref: record.ref,
        inputs: { ...record.dispatchInputs, dispatch_token: record.dispatchToken } })
      state.patch(record.commentId, { dispatchState: 'dispatched', dispatched: true, dispatchedAt: now(),
        ...(run ? { runId: run.id, runUrl: run.url } : {}) })
    } finally { reconciling.delete(record.reviewId) }
  }

  /** Records a verdict once: the result is saved first, so sweep() can retry it if GitHub is unreachable. */
  function finish(record, report) {
    if (finishing.has(record.reviewId)) return finishing.get(record.reviewId)
    const delivery = Promise.resolve().then(async () => {
      const current = state.pending().find(job => job.reviewId === record.reviewId)
      if (!current) return
      await deliver(current, current.result ?? report)
    }).finally(() => finishing.delete(record.reviewId))
    finishing.set(record.reviewId, delivery)
    return delivery
  }

  async function deliver(record, report) {
    state.patch(record.commentId, { result: report })
    const latest = await github.pull(record.repo, record.number).catch(() => null)
    const stale = latest && latest.head?.sha !== record.sha
    const body = report.body + (stale ? `\n\n> A newer commit (\`${latest.head.sha.slice(0, 7)}\`) was pushed during this run; comment again to review it.` : '')
    // Keep the saved verdict pending until both GitHub writes succeed. Swallowing a check
    // failure here would leave the check in progress forever after the job is completed.
    if (record.checkId) await actions.finishCheck(record.repo, record.checkId, report)
    await github.comment(record.repo, record.number, body, { key: String(record.commentId) })
    state.complete(record.commentId)
  }

  // Recover before accepting new work; resolve current policy rather than storing credentials/config. Actions reviews
  // are reconciled by sweep() using the saved dispatch intent and GitHub run lookup.
  for (const job of state.pending()) {
    if (job.reviewId || job.waitingPreview) continue
    const config = settings()
    const repoSettings = config.repositories.get(job.repo.toLowerCase())
    if (repoSettings?.enabled) enqueue(job, repoSettings, config)
    else state.complete(job.commentId)
  }
  pump()

  return {
    async handle({ event, delivery, payload }) {
      if (event === 'ping') return outcome('ignored', 'ping')
      if (event === 'pull_request') return automatic({ payload, delivery })
      if (event !== 'issue_comment' || payload?.action !== 'created') return outcome('ignored', 'event')
      const config = settings()
      const repo = payload.repository?.full_name
      const repoSettings = typeof repo === 'string' ? config.repositories.get(repo.toLowerCase()) : null
      if (!repoSettings?.enabled) return outcome('ignored', 'repository-not-enabled')
      if (!payload.issue?.pull_request) return outcome('ignored', 'not-a-pull-request')
      if (payload.issue.state !== 'open') return outcome('ignored', 'pull-request-closed')
      if (!parseCommand(payload.comment?.body)) return outcome('ignored', 'no-command')
      const actor = payload.comment?.user?.login, number = payload.issue.number, commentId = payload.comment?.id
      if (payload.comment?.user?.type === 'Bot' || payload.sender?.type === 'Bot') return outcome('ignored', 'bot')
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(commentId) || typeof actor !== 'string' || !/^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(actor)) return outcome('ignored', 'malformed')
      const permission = await github.permissionOf(repo, actor).catch(() => 'none')
      if (!isAuthorizedPermission(permission)) {
        log('rejected', { repo, number, actor, permission, association: payload.comment.author_association })
        return outcome('rejected', 'not-authorized')
      }
      if (state.has(commentId)) return outcome('ignored', 'duplicate')
      const key = `${repo.toLowerCase()}#${number}`
      if (active.has(key) || queue.length >= queueLimit) {
        const reason = active.has(key) ? 'already-active' : 'queue-full'
        const message = active.has(key) ? 'A review of this pull request is already queued or running.' : 'The review queue is full. Try again in a few minutes.'
        state.claim(commentId)
        await github.comment(repo, number, formatNotice({ actor, title: 'Review not started', message })).catch(() => {})
        return outcome('rejected', reason)
      }
      const job = { repo, number, actor, commentId }
      if (!state.claim(commentId, job)) return outcome('ignored', 'duplicate')
      log('accepted', { repo, number, actor, delivery })
      enqueue(job, repoSettings, config)
      pump()
      return outcome('accepted', 'queued')
    },
    /** A signed, validated verdict from the GitHub Action. Repository, pull request and commit come from saved state only. */
    async completeReview(report) {
      const record = state.pending().find(job => job.reviewId === report.reviewId)
      if (!record) return outcome('ignored', 'unknown-review')
      if (!record.dispatchToken || record.dispatchToken !== report.dispatchToken) return outcome('ignored', 'invalid-dispatch')
      if (record.result) return outcome('ignored', 'duplicate')
      await finish(record, report)
      log('review-reported', { repo: record.repo, number: record.number, verdict: report.verdict })
      return outcome('accepted', 'reported')
    },
    /**
     * Finishes Actions reviews: posts results that were saved but not yet delivered, and expires runs that never
     * reported (a runner that died, a workflow that was cancelled). Called on start and periodically by the server.
     */
    async sweep() {
      for (const job of state.pending().filter(job => !job.reviewId && (job.waitingPreview || job.resultBody !== undefined))) {
        if (queue.length >= queueLimit) break
        if (active.has(`${job.repo.toLowerCase()}#${job.number}`)) continue
        const config = settings(), repoSettings = config.repositories.get(job.repo.toLowerCase())
        if (repoSettings?.enabled) enqueue(job, repoSettings, config)
        else state.complete(job.commentId)
      }
      pump()
      for (const record of state.pending().filter(job => job.reviewId)) {
        try {
          if (record.result) await finish(record, record.result)
          else if (now() >= record.expiresAt) {
            log('review-expired', { repo: record.repo, number: record.number })
            const message = `The GitHub Action did not report a result within the time limit.${record.runUrl ? ` Run: ${record.runUrl}` : ''}`
            await finish(record, { verdict: 'blocked', headline: 'the GitHub Action did not report a result', body: formatNotice({ actor: record.actor, title: 'Automation review could not verify this PR', message }), runUrl: record.runUrl ?? null })
          } else if (record.dispatchState === 'pending' && record.dispatchInputs) {
            await reconcileDispatch(record)
          }
        } catch (error) { log('sweep-failed', { repo: record.repo, number: record.number, error: error.message }) }
      }
    },
    /** Resolves when no review is queued or running (used by shutdown and tests). */
    idle: () => (running || queue.length ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve()),
  }
}
