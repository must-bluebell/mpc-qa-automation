import { expectCheckInRateLimit } from './checkin-rate-limit'
import { prepareCheckInAccount } from './checkin-setup'
import { expect, test, todo, skipWhen, uniqueEmail } from './fixtures'
import { call } from '../../fixtures/api'
import { stubAnalytics } from '../../fixtures/network'
import { validationCopy } from '../../pages/validation-copy'
import { connectConfiguredWallet } from '../../fixtures/connected-wallet'
import { target } from '../../config/target'
import type { Response } from '@playwright/test'
import type { Page, TestInfo, APIRequestContext } from '@playwright/test'

/**
 * Registration-to-claim, daily check-in, quests and the SBT claim.
 *
 * Gated cases create real state on the isolated stack (quest opens, vouchers, permits). A fresh
 * wallet is registered through the skip-OTP route when the signup policy allows it; otherwise the
 * dependent case is skipped with the reason.
 */

type Quest = { key: string; linkUrl?: string | null; requiresKey?: string | null; done?: boolean; claimed?: boolean; [k: string]: unknown }

/** Registers the page's wallet without an email code (skip-OTP policy). Skips the test if unavailable. */
async function registerFresh(page: Page, info: TestInfo): Promise<void> {
  const res = await call(page.request, info, 'POST', '/api/register/skip-otp', { body: { email: uniqueEmail('fresh') } })
  skipWhen(res.status !== 200, `Skip-OTP registration is not available here (${res.status} ${res.json?.error ?? ''}).`)
}

async function listQuests(request: APIRequestContext, info: TestInfo): Promise<Quest[]> {
  const res = await call(request, info, 'GET', '/api/quests')
  expect(res.status).toBe(200)
  return ((res.json?.quests ?? []) as Quest[])
}

async function checkFreshMemberRateLimit(page: Page, info: TestInfo): Promise<void> {
  test.setTimeout(300_000)
  const account = await prepareCheckInAccount()
  await connectConfiguredWallet(page, { account })
  const today = await call(page.request, info, 'GET', '/api/quiz/today')
  expect(today.status).toBe(200)
  expect(today.json?.checkedIn, 'Fresh member must have an unclaimed daily reward').toBe(false)
  await expectCheckInRateLimit(page.request, info)
}

async function completeFreshCheckIn(page: Page): Promise<void> {
  test.setTimeout(300_000)
  const account = await prepareCheckInAccount()
  let challenge: Promise<Response> | undefined
  let signed = 0
  const member = await connectConfiguredWallet(page, { account, beforeSignTypedData: async payload => {
    expect(challenge, 'Only the check-in requested below may be signed').toBeDefined()
    const response = await challenge!
    expect(response.ok()).toBe(true)
    const prepared = await response.json()
    expect(payload.primaryType).toBe('CheckInFor')
    expect(payload.domain).toMatchObject({ name: 'MpcDailyCheckIn', version: '3', chainId: 5611 })
    expect(payload).toMatchObject(prepared.typedData)
    expect(payload.types.CheckInFor).toEqual([
      { name: 'user', type: 'address' }, { name: 'submitter', type: 'address' },
      { name: 'challenge', type: 'bytes32' }, { name: 'day', type: 'uint256' },
      { name: 'bonus', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ])
    const message = payload.message as Record<string, unknown>
    expect(String(message.user).toLowerCase()).toBe(member.address.toLowerCase())
    expect(message.challenge).toBe(prepared.challenge)
    expect(Number(message.day)).toBe(Math.floor(Date.now() / 86_400_000))
    expect(Number(message.bonus)).toBeGreaterThanOrEqual(0)
    expect(Number(message.bonus)).toBeLessThanOrEqual(20)
    expect(Number(message.deadline)).toBeGreaterThan(Date.now() / 1000)
    expect(Number(message.deadline)).toBeLessThanOrEqual(Date.now() / 1000 + 600)
    expect(++signed).toBe(1)
  } })
  await page.goto('/?tab=quest')
  const button = page.getByRole('button', { name: 'Check in', exact: true })
  const done = page.getByText(validationCopy.checkedIn, { exact: true }).filter({ visible: true }).first()
  const before = await page.request.get('/my-mine/energy')
  expect(before.ok()).toBe(true)
  const balance = Number((await before.json()).balance)
  expect(Number.isSafeInteger(balance)).toBe(true)
  const today = await page.request.get('/api/quiz/today')
  expect(today.ok()).toBe(true)
  expect((await today.json()).checkedIn, 'This case requires an unclaimed daily reward').toBe(false)
  challenge = page.waitForResponse(r => new URL(r.url()).pathname === '/api/relay/challenge' && r.request().postDataJSON()?.kind === 'checkin')
  // Attach a handler immediately so a failed click cannot leave an unhandled rejection.
  void challenge.catch(() => {})
  const [submitted] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/relay/submit', { timeout: 90_000 }),
    button.click(),
  ])
  expect(submitted.ok()).toBe(true)
  expect(signed).toBe(1)
  await expect(done).toBeVisible({ timeout: 90_000 })
  await expect.poll(async () => {
    const after = await page.request.get('/my-mine/energy')
    expect(after.ok()).toBe(true)
    return Number((await after.json()).balance)
  }).toBeGreaterThan(balance)
}

test.describe('Quests and check-in (read-only)', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('QST-10 - Every quest link is https or absent', async ({ request }, info) => {
    const quests = await listQuests(request, info)
    for (const quest of quests) {
      if (quest.linkUrl === undefined || quest.linkUrl === null) continue
      expect(quest.linkUrl, quest.key).toMatch(/^https:\/\//)
    }
  })

  test('QST-11 - Quest links open in a new tab with noopener', async ({ page }) => {
    await page.goto('/?tab=quest')
    const links = page.locator('a[target="_blank"]')
    const count = await links.count()
    for (let i = 0; i < count; i += 1) {
      const rel = (await links.nth(i).getAttribute('rel')) ?? ''
      expect(rel).toMatch(/noopener/)
    }
  })

  test('QST-01 - The quest list loads for the wallet and every item has a done flag (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const quests = await listQuests(page.request, info)
    expect(quests.length).toBeGreaterThan(0)
    for (const quest of quests) expect(Object.keys(quest).join(' ')).toMatch(/done|claimed|complete/i)
  })
})

test.describe('Check-in (signed in)', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('CHK-01 - A signed-in user sees the check-in control (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await page.goto('/?tab=quest')
    await expect(page.getByRole('button', { name: 'Check in', exact: true })
      .or(page.getByText(validationCopy.checkedIn, { exact: true })).filter({ visible: true }).first()).toBeVisible()
  })

  test('CHK-07 - Energy on screen matches the ledger after reload (gated)', async () => {
    skipWhen(true, 'The ledger comparison needs the energy ledger shape from /api/energy; not yet mapped.')
  })

  test('CHK-08 - The quiz response never includes the correct answer (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const res = await call(page.request, info, 'GET', '/api/quiz/today')
    skipWhen(res.status === 403 || res.status === 404, `Quiz not available (${res.status}).`)
    expect(res.text).not.toMatch(/correctIndex|isCorrect|"correct"\s*:|answerIndex"\s*:\s*\d/i)
  })

  test('CHK-09 - Answering twice grades once; the second is refused (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const quiz = await call(page.request, info, 'GET', '/api/quiz/today')
    const day = quiz.json?.day ?? (quiz.json?.assignment as Record<string, unknown> | undefined)?.day
    const itemId = quiz.json?.itemId ?? (quiz.json?.item as Record<string, unknown> | undefined)?.id ?? (quiz.json?.assignment as Record<string, unknown> | undefined)?.itemId
    skipWhen(day === undefined || itemId === undefined, 'Quiz payload does not expose day and item id; cannot build an answer.')
    const body = { answerIndex: 0, day, itemId }
    await call(page.request, info, 'POST', '/api/quiz/answer', { body })
    const second = await call(page.request, info, 'POST', '/api/quiz/answer', { body })
    expect(second.status).toBe(409)
    expect(second.json?.error).toBe('already_answered')
  })

  for (const answerIndex of [-1, 1.5, '0', null, 1e9] as const) {
    test(`CHK-10 - Answer index ${String(answerIndex)} is refused before grading (gated)`, async ({ page, member }, info) => {
      expect(member.address).toBeTruthy()
      const res = await call(page.request, info, 'POST', '/api/quiz/answer', { body: { answerIndex, day: '2026-11-05', itemId: '1' } })
      expect(res.status).toBe(400)
    })
  }

  test('CHK-05 - Four rapid check-in challenges hit the attempt window (gated)', async ({ page }, info) => {
    await checkFreshMemberRateLimit(page, info)
  })

  test('CHK-13 - Double-clicked check-in produces at most one voucher (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const [a, b] = await Promise.all([
      call(page.request, info, 'POST', '/api/quiz/voucher'),
      call(page.request, info, 'POST', '/api/quiz/voucher'),
    ])
    expect([a.status, b.status].filter(s => s === 200).length).toBeLessThanOrEqual(1)
  })

  test('CHK-12 - An unregistered wallet cannot get a check-in voucher (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    const res = await call(page.request, info, 'POST', '/api/quiz/voucher')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.json).not.toHaveProperty('signature')
  })

  test('M-15 - Check in once and the reward is added (gated, on-chain)', async ({ page }) => {
    await completeFreshCheckIn(page)
  })

  test('M-16 - A second check-in on the same day is refused (gated)', async ({ page }, info) => {
    await completeFreshCheckIn(page)
    await page.reload()
    await expect(page.getByText(validationCopy.checkedIn, { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 })
    const res = await call(page.request, info, 'POST', '/api/quiz/voucher')
    expect(res.status).not.toBe(200)
  })

  todo('CHK-02', 'Bonus by base: 0→20, 10→10, 20→0, 25→0 (never negative)', 'Pure arithmetic: bonusEnergy in checkin-rules.ts; covered by the app repo unit tests, not a browser case.')
  todo('CHK-03', 'Check-in at 23:59:59Z counts for that UTC day; 00:00:00Z starts a new one', 'Server clock: the browser clock cannot move server time. Needs a test-only clock on the stack.')
  todo('CHK-04', 'Voucher issuance refused from 23:55:00Z (midnight grace)', 'Server clock: as CHK-03. Unit-level: deadlineBeforeMidnight in day-boundary.ts.')
  todo('CHK-06', 'The twenty-first attempt in one day is refused', 'Slow: needs twenty-one attempts spaced past the 5-minute window.')
  todo('CHK-11', 'Check-in without a quiz answer works with no bonus', 'Needs a fresh day with no quiz answer on the stack.')
  todo('M-17', 'Consecutive days raise the streak (day 7 pays the top rung)', 'Blocked on gap G6: the streak grace rule is not decided.')
  todo('M-18', 'Missing a day resets the streak', 'Blocked on gap G6: the grace day can keep the streak.')
  todo('M-xx-QST-timing', 'Quest voucher reuse margin: 59 s left issues a new voucher', 'Needs a voucher aged to 59 seconds (server clock).')
})

test.describe('Quests (registered wallet, gated)', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test('M-19 - Opening a quest link is recorded as opened (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const quest = (await listQuests(page.request, info)).find(q => q.linkUrl)
    skipWhen(!quest, 'No quest with a link is open on this stack.')
    const res = await call(page.request, info, 'POST', '/api/quest/link-open', { body: { questKey: quest!.key } })
    expect(res.status).toBe(200)
  })

  test('QST-02 - A second open of the same link is accepted and does not error (gated; timer check manual)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const quest = (await listQuests(page.request, info)).find(q => q.linkUrl)
    skipWhen(!quest, 'No quest with a link is open on this stack.')
    await call(page.request, info, 'POST', '/api/quest/link-open', { body: { questKey: quest!.key } })
    const again = await call(page.request, info, 'POST', '/api/quest/link-open', { body: { questKey: quest!.key } })
    expect(again.status).toBe(200)
  })

  test('QST-03 - Claiming before the 15-second gap is refused as too soon (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const quest = (await listQuests(page.request, info)).find(q => q.linkUrl)
    skipWhen(!quest, 'No quest with a link is open on this stack.')
    await call(page.request, info, 'POST', '/api/quest/link-open', { body: { questKey: quest!.key } })
    const res = await call(page.request, info, 'POST', '/api/quest/voucher', { body: { questKey: quest!.key } })
    skipWhen(res.json?.error !== 'too_soon', `Quest gap is not enforced here (${res.status} ${res.json?.error ?? ''}).`)
    expect(res.status).toBe(429)
    expect(Number(res.json?.retryAfterMs ?? 0)).toBeGreaterThan(0)
    expect(Number(res.json?.retryAfterMs)).toBeLessThanOrEqual(15_000)
  })

  test('QST-05 - A claim without opening the link is refused (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const quest = (await listQuests(page.request, info)).find(q => q.linkUrl)
    skipWhen(!quest, 'No quest with a link is open on this stack.')
    const res = await call(page.request, info, 'POST', '/api/quest/voucher', { body: { questKey: quest!.key } })
    expect(['link_not_opened', 'not_registered']).toContain(res.json?.error)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  test('QST-06 - A Telegram quest is locked until Telegram is verified (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const quest = (await listQuests(page.request, info)).find(q => /^https:\/\/t\.me\//.test(String(q.linkUrl ?? '')))
    skipWhen(!quest, 'No Telegram quest is open on this stack.')
    const res = await call(page.request, info, 'POST', '/api/quest/voucher', { body: { questKey: quest!.key } })
    skipWhen(res.json?.error !== 'telegram_not_joined', `Telegram gate is off here (${res.json?.error ?? res.status}).`)
    expect(res.status).toBe(403)
  })

  test('QST-07 - A quest with a prerequisite is locked until the prerequisite is done (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const quest = (await listQuests(page.request, info)).find(q => q.requiresKey)
    skipWhen(!quest, 'No quest with a prerequisite is open on this stack.')
    const res = await call(page.request, info, 'POST', '/api/quest/voucher', { body: { questKey: quest!.key } })
    expect(res.status).toBe(403)
    expect(res.json?.error).toBe('locked')
  })

  test('QST-12 - The server ignores a client-sent reward amount (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const quest = (await listQuests(page.request, info)).find(q => q.linkUrl)
    skipWhen(!quest, 'No quest with a link is open on this stack.')
    const res = await call(page.request, info, 'POST', '/api/quest/voucher', { body: { questKey: quest!.key, amount: 999999 } })
    expect(res.status).toBeLessThan(500)
    expect(res.text).not.toContain('999999')
  })

  todo('QST-04', 'Admin gap of 0 turns the wait off; a gap above 600 s is refused', 'Needs admin credentials (not configured). The 600 s ceiling is MAX_GAP_SECONDS.')
  todo('QST-08', 'The quest list matches the ledger', 'Needs the ledger response shape; not mapped yet.')
  todo('QST-09', 'A voucher with less than 60 s left is not reused', 'Needs a voucher aged to the margin (server clock).')
  todo('QST-13', 'A quest belonging to another wallet cannot be claimed', 'Needs two registered wallets with the same quest state; cross-wallet fixture not built.')
  todo('M-20', 'Finishing a quest pays its energy once', 'Completion needs the on-chain relay transaction; covered by the relay contract tests.')
  todo('M-21', 'Claiming the same quest twice is refused', 'Needs a completed quest, which needs the on-chain relay (see M-20).')
})

test.describe('SBT claim', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('T4-02 - Claiming without registering is refused as not registered (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    const res = await call(page.request, info, 'POST', '/api/claim/permit')
    expect(res.status).toBe(403)
    expect(res.json?.error).toBe('not_registered')
  })

  test('T4-08 - Registration (the claim precondition) is refused without Telegram (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    const res = await call(page.request, info, 'POST', '/api/register/skip-otp', { body: { email: uniqueEmail('gate') } })
    skipWhen(res.status === 200, 'Telegram gate is off on this target.')
    expect(res.json?.error).toBe('telegram_not_joined')
  })

  test('T4-01 - Registered wallet can request an SBT claim permit (API leg; wallet leg manual) (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const res = await call(page.request, info, 'POST', '/api/claim/permit')
    expect(res.status).toBe(200)
  })

  test('T4-13 - Two simultaneous claim requests produce at most one permit (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const [a, b] = await Promise.all([call(page.request, info, 'POST', '/api/claim/permit'), call(page.request, info, 'POST', '/api/claim/permit')])
    expect([a.status, b.status].filter(s => s === 200).length).toBeLessThanOrEqual(1)
  })

  test('T4-14 - A second permit request inside 10 seconds is refused (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    await registerFresh(page, info)
    const first = await call(page.request, info, 'POST', '/api/claim/permit')
    skipWhen(first.status === 403 || first.status === 409, `First request refused for another reason (${first.status} ${first.json?.error ?? ''}).`)
    const second = await call(page.request, info, 'POST', '/api/claim/permit')
    expect(second.status).toBe(429)
  })

  test('M-25 - Claiming the SBT twice refuses the second (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const res = await call(page.request, info, 'POST', '/api/claim/permit')
    skipWhen(res.json?.error !== 'already_claimed' && res.status !== 409, 'The member has no claimed SBT yet; M-25 needs a completed claim.')
    expect(res.status).toBe(409)
    expect(res.json?.error).toBe('already_claimed')
  })

  for (const id of ['T4-03', 'T4-04', 'T4-05', 'T4-06', 'T4-07', 'T4-09', 'T4-10', 'T4-11', 'T4-12', 'T4-15', 'M-26'] as const) {
    const reason: Record<string, string> = {
      'T4-03': 'The claim step is reached through the join UI after registration; its copy is not in the vendored set yet.',
      'T4-04': 'Needs the claim button copy and a wallet signature prompt, which the mock wallet answers only for sign-in.',
      'T4-05': 'Needs the wallet balance before and after an on-chain claim (gas sponsorship check).',
      'T4-06': 'Needs an issued token id; the claim must complete on chain first.',
      'T4-07': 'Needs the claim success copy; not in the vendored set yet.',
      'T4-09': 'Permit lifetime is 3600 s (PERMIT_TTL_SECONDS); needs a permit aged past it.',
      'T4-10': 'Needs the claim signature rejected in the claim UI step.',
      'T4-11': 'Needs a pending wallet request during the claim UI step.',
      'T4-12': 'Transfer must revert on chain; needs an issued token and a transfer transaction.',
      'T4-15': 'Slow: twenty-one permits spaced past the ten-second cooldown.',
      'M-26': 'Needs an issued token and a transfer transaction (as T4-12).',
    }
    todo(id, `${id} (see the plan for the wording)`, reason[id] ?? 'Not automated.')
  }
})

test.describe('Member API security (gated)', { tag: ['@security', '@regression', '@web-module'] }, () => {
  test('SEC-06 - A state-changing request from another origin is refused (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const res = await call(page.request, info, 'PATCH', '/api/notifications', { body: { all: true }, origin: 'https://evil.example' })
    expect(res.status).not.toBe(200)
    expect(res.status).toBeLessThan(500)
  })

  test('SEC-10 - Injection payloads in the email field do not change the response shape (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    // verify-code is used because it sends nothing; the injection reaches only the parameterised lookup.
    for (const email of ["' OR '1'='1", "a' OR '1'='1@example.com", "'; DROP TABLE otp;--@example.com"]) {
      const res = await call(page.request, info, 'POST', '/api/register/verify-code', { body: { email, code: '000000' } })
      expect(res.status).toBeLessThan(500)
      expect(res.json?.error).not.toBe(undefined)
    }
  })

  test('SEC-11 - A time-based injection payload is not slowed down (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const started = Date.now()
    await call(page.request, info, 'POST', '/api/register/verify-code', { body: { email: "x'||pg_sleep(2)--@example.com", code: '000000' } })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('SEC-13 - Logout invalidates the server session for the old cookie (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const cookie = (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join('; ')
    expect(cookie).not.toBe('')
    await call(page.request, info, 'POST', '/api/auth/logout')
    const replay = await call(page.request, info, 'GET', '/api/notifications', { headers: { cookie } })
    expect(replay.status).toBe(401)
  })

  test('SEC-15 - A request one byte over the body limit is refused (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const pad = 'x'.repeat(24_001 - 14)
    const over = `{"samples":[],"p":"${pad}"}`
    const res = await call(page.request, info, 'POST', '/api/telemetry/latency', { raw: over })
    expect([400, 413]).toContain(res.status)
  })

  test('SEC-17 - Rate limits hold on check-in challenge issuance (gated)', async ({ page }, info) => {
    await checkFreshMemberRateLimit(page, info)
  })

  test('SEC-01 - Wallet-scoped reads take identity from the session only (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const other = '0x0000000000000000000000000000000000000002'
    for (const path of [`/api/energy/history?wallet=${other}`, `/api/energy/history?address=${other}`, `/api/notifications?wallet=${other}`]) {
      const res = await call(page.request, info, 'GET', path)
      expect(res.status, path).toBeLessThan(500)
      expect(res.text.toLowerCase(), path).not.toContain(other)
    }
  })

  test('SEC-08 - Numeric parameters are bounded: bad values give 400, never 500 (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    for (const page_ of ['-1', '0', 'abc', '1.0', '1e9', '9007199254740993']) {
      const res = await call(page.request, info, 'GET', `/api/energy/history?page=${page_}`)
      expect(res.status, `page=${page_}`).not.toBe(500)
      expect(res.status, `page=${page_}`).toBeLessThan(500)
    }
  })

  test('SEC-19 - The browser session cookie is HttpOnly, SameSite and Secure on HTTPS (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    const cookies = await page.context().cookies()
    const session = cookies.filter(c => /^(?:__Host-)?mpc_session$/.test(c.name))
    expect(session, 'one session cookie').toHaveLength(1)
    for (const c of session) {
      expect(c.httpOnly).toBe(true)
      expect(c.secure, c.name).toBe(new URL(target().baseUrl).protocol === 'https:')
      expect(c.sameSite).toBe('Lax')
    }
  })

  todo('T2-11', 'The same join event from a different update id still counts once', 'Needs the live bot and a real group join; the webhook secret is required (see T2-05).')
  todo('M-01', 'Press START with a valid token: the account is linked', 'Manual: needs a live Telegram account and the bot (see plan M-01).')
  todo('M-03', 'Press START with no token: the bot asks for the personal link', 'Manual: needs a live Telegram account and the bot.')
  todo('M-04', 'Press START with a broken token: the bot says the link is not valid', 'Manual: needs a live Telegram account and the bot.')
  todo('M-07', 'Personal link fails to build: the user lands in the group, not the bot', 'Manual: needs a fault injected into link building; not available on the stack.')

  todo('SEC-05', 'An admin without a permission gets 403 on restricted actions','Needs a restricted admin role; admin credentials are not configured.')
  todo('SEC-18', 'Repeated claim or check-in attempts stop at the burst gate', 'Covered by CHK-05 and SEC-17 (same gate); listed here for traceability.')
})
