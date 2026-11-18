import { request as playwrightRequest, type APIRequestContext, type TestInfo } from '@playwright/test'
import { expect, test, todo, skipWhen, COPY, EMAIL, CODE_BVA, INJECTION_EMAILS, uniqueEmail, fetchNonce, freshAccount, siweMessage, verifySiwe, watchErrors } from './fixtures'
import { JoinSheet } from '../../pages/JoinSheet'
import { target } from '../../config/target'
import { call, requireWrites } from '../../fixtures/api'
import { stubAnalytics } from '../../fixtures/network'

/**
 * Community (Telegram, X) and email verification.
 *
 * Send-code calls are only made to reserved example.com addresses or to the configured QA inbox.
 * Refusals (disposable, format, already registered) happen before any mail is sent, so those are
 * safe to run against the isolated stack.
 */

const QA_INBOX = process.env.QA_INBOX_EMAIL ?? ''
const social = /^https:\/\/(t\.me|x\.com)\//

async function reachEmailStep(page: import('@playwright/test').Page) {
  await page.context().route(social, route => route.fulfill({ status: 204, body: '' }))
  const sheet = new JoinSheet(page).sheet()
  await sheet.getByRole('link', { name: /Join the Telegram group/ }).click()
  await sheet.getByRole('link', { name: /Follow on X/ }).click()
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(sheet.locator('input[type="email"]')).toBeVisible()
  return sheet
}

/** A second signed-in identity on its own request context (a separate cookie jar). */
async function signedInContext(info: TestInfo) {
  const ctx = await playwrightRequest.newContext({ baseURL: target().baseUrl })
  const account = freshAccount()
  const nonce = await fetchNonce(ctx, info)
  const message = await siweMessage(account, nonce)
  const signature = await account.signMessage({ message })
  const res = await verifySiwe(ctx, info, message, signature)
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`)
  return { ctx, account }
}

async function sendCode(ctx: APIRequestContext, info: TestInfo, email: string) {
  return call(ctx, info, 'POST', '/api/register/send-code', { body: { email } })
}

/** Ask for a code twice in a row; the second must be refused by the resend cooldown. */
async function cooldownRefusal(ctx: APIRequestContext, info: TestInfo) {
  const email = uniqueEmail('cooldown')
  const first = await sendCode(ctx, info, email)
  skipWhen(first.status === 403 && first.json?.error === 'telegram_not_joined', 'Telegram gate is on; the community step must be completed first.')
  expect(first.status, 'first send').toBe(200)
  const second = await sendCode(ctx, info, email)
  expect(second.status).toBe(429)
  expect(second.json?.error).toBe('cooldown')
  expect(Number(second.json?.retryAfterMs ?? 0)).toBeGreaterThan(0)
}

/** Five wrong codes, then a sixth attempt. Plan: after five, the screen asks for a new code (G13). */
async function exhaustAttempts(ctx: APIRequestContext, info: TestInfo) {
  const email = uniqueEmail('attempts')
  const sent = await sendCode(ctx, info, email)
  skipWhen(sent.status === 403 && sent.json?.error === 'telegram_not_joined', 'Telegram gate is on; the community step must be completed first.')
  expect(sent.status).toBe(200)
  const left: unknown[] = []
  for (let i = 1; i <= 5; i += 1) {
    const res = await call(ctx, info, 'POST', '/api/register/verify-code', { body: { email, code: '000000' } })
    expect(res.status).toBe(401)
    left.push(res.json?.attemptsLeft)
  }
  expect(left).toEqual([4, 3, 2, 1, 0])
  const sixth = await call(ctx, info, 'POST', '/api/register/verify-code', { body: { email, code: '000000' } })
  expect(sixth.json?.error).toBe('no_code')
  return sixth
}

test.describe('Community step', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('T2-01 - Community step shows the Telegram link, the X link and Continue (gated)', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    const sheet = new JoinSheet(page).sheet()
    await expect(sheet.getByRole('link', { name: /Join the Telegram group/ })).toBeVisible()
    await expect(sheet.getByRole('link', { name: /Follow on X/ })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
  })

  test('T2-02 - The Telegram row opens its link in a new tab (gated)', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    // A 204 cancels document navigation, so Chromium never exposes a loaded popup.
    await page.context().route(social, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>QA social destination</title>' }))
    const sheet = new JoinSheet(page).sheet()
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      sheet.getByRole('link', { name: /Join the Telegram group/ }).click(),
    ])
    expect(new URL(popup.url()).host).toMatch(/t\.me$/)
  })

  test('T2-08 - Continue is refused until Telegram and X are done (gated)', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    const sheet = new JoinSheet(page).sheet()
    await expect(sheet.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    await new JoinSheet(page).expectStep('Community')
    await expect(sheet.locator('input[type="email"]')).not.toBeVisible()
  })

  test('T2-18 - Leaving for Telegram and returning keeps the Community progress (gated)', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    await page.context().route(social, route => route.fulfill({ status: 204, body: '' }))
    await new JoinSheet(page).sheet().getByRole('link', { name: /Join the Telegram group/ }).click()
    await page.reload()
    await expect(new JoinSheet(page).sheet()).toBeVisible()
    await new JoinSheet(page).expectStep('Community')
  })

  test('T2-06 - A webhook event with a wrong secret is refused', async ({ request }) => {
    const res = await request.post('/api/support/telegram/webhook', {
      headers: { 'x-telegram-bot-api-secret-token': 'not-the-secret', 'content-type': 'application/json' },
      data: { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 0, type: 'private' }, from: { id: 0, is_bot: false, first_name: 'Test' }, text: '/start' } },
      maxRetries: 0,
    })
    skipWhen(res.status() === 503, 'Telegram webhook is not configured on this target.')
    expect([401, 403]).toContain(res.status())
  })

  for (const [label, secret] of [['missing header', undefined], ['empty secret', ''], ['short guess', 'a'], ['long guess', 'x'.repeat(64)]] as [string, string | undefined][]) {
    test(`T2-10 - Webhook refuses a ${label}`, async ({ request }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (secret !== undefined) headers['x-telegram-bot-api-secret-token'] = secret
      const res = await request.post('/api/support/telegram/webhook', { headers, data: { update_id: 2 }, maxRetries: 0 })
      skipWhen(res.status() === 503, 'Telegram webhook is not configured on this target.')
      expect([401, 403]).toContain(res.status())
    })
  }

  test('T2-05 - The same join event sent twice counts once and is not an error (gated)', async ({ request }, info) => {
    const secret = process.env.QA_TELEGRAM_WEBHOOK_SECRET
    skipWhen(!secret, 'QA_TELEGRAM_WEBHOOK_SECRET is not set; a real secret is needed to send a valid event.')
    skipWhen(process.env.QA_ALLOW_WRITES !== '1', 'Writes are not allowed on this target.')
    const body = { update_id: 900_001, message: { message_id: 1, date: 0, chat: { id: 0, type: 'private' }, from: { id: 0, is_bot: false, first_name: 'QA' }, text: '/start' } }
    const headers = { 'x-telegram-bot-api-secret-token': secret!, 'content-type': 'application/json' }
    const first = await call(request, info, 'POST', '/api/support/telegram/webhook', { body, headers, origin: null })
    const second = await call(request, info, 'POST', '/api/support/telegram/webhook', { body, headers, origin: null })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })

  test('T2-15 - Telegram auth start does not redirect to an outside site (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    for (const returnTo of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const res = await call(page.request, info, 'POST', '/api/telegram/auth/start', { body: { returnTo, replace: false } })
      expect(res.status).toBeLessThan(500)
      expect(res.headers.location ?? '', returnTo).not.toMatch(/evil\.example|javascript:/)
      expect(JSON.stringify(res.json ?? {}), returnTo).not.toMatch(/evil\.example|javascript:/)
    }
  })

  todo('T2-03', 'A Telegram token is refused after 15 minutes', 'Needs a token aged 15 minutes; the TTL is not in the source (G12).')
  todo('T2-04', 'With the gate on, a link that was only opened is not counted', 'Needs the Telegram gate turned on for the target (environment flag).')
  todo('T2-07', 'X link opening records "opened" only and does not show verified', 'The X row copy for the opened state is not in the vendored copy; add it before automating.')
  todo('T2-09', 'Preview with the gate off: opening the link is enough', 'Environment-dependent (gate flag); run on preview only.')
  todo('T2-12', 'A Telegram account linked to one waitlist account cannot link to another', 'Needs two Telegram accounts and the live bot.')
  todo('T2-13', 'Second wallet pressing START on a linked account is told it is already linked', 'Needs the live bot (manual M-02).')
  todo('T2-14', 'A START with another wallet token does not change that wallet link', 'Needs the live bot.')
  todo('T2-16', 'A lookalike host is not treated as Telegram', 'Unit-level: isTelegramQuest in platform/integrations/telegram/telegram-rules.ts, tested in the app repo.')
  todo('T2-17', 'Telegram row shows verified and keeps it after reload', 'Needs a real group join (manual M-05).')
})

test.describe('Email verification', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('T3-03 - Continue stays off until the email looks valid (gated)', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    const sheet = await reachEmailStep(page)
    const field = sheet.locator('input[type="email"]')
    const cont = sheet.getByRole('button', { name: 'Continue', exact: true })
    for (const value of ['a', 'a@', 'a@b', '@b.com', 'a b@c.com']) {
      await field.fill(value)
      await expect(cont, value).toBeDisabled()
    }
    await field.fill(EMAIL.permanent)
    await expect(cont).toBeEnabled()
  })

  test('T3-04 - Length limit: 254 characters accepted by format, 255 refused (gated)', async ({}, info) => {
    requireWrites()
    const ctx = await signedInContext(info)
    const over = await sendCode(ctx.ctx, info, EMAIL.overLength)
    expect(over.status).toBe(400)
    expect(over.json?.error).toBe('bad_email')
    const at = await sendCode(ctx.ctx, info, EMAIL.maxLength)
    expect(at.json?.error, 'the 254-character address must pass the format check').not.toBe('bad_email')
    await ctx.ctx.dispose()
  })

  test('T3-07 - A throwaway address is refused before any code is saved or sent (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    // Only an already-registered member would reach a 409 first; use a newcomer context instead.
    const ctx = await signedInContext(info)
    const res = await sendCode(ctx.ctx, info, EMAIL.disposable)
    expect(res.status).toBe(400)
    expect(res.json?.error).toBe('disposable_email')
    await ctx.ctx.dispose()
  })

  test('T3-08 - A subdomain of a blocked service is also refused (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const ctx = await signedInContext(info)
    const res = await sendCode(ctx.ctx, info, EMAIL.disposableSubdomain)
    expect(res.json?.error).toBe('disposable_email')
    await ctx.ctx.dispose()
  })

  test('T3-12 - Gmail-style alias variants are allowed (accepted sybil limit) (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    skipWhen(!QA_INBOX, 'QA_INBOX_EMAIL is not set; an alias is only sent to the QA inbox.')
    const alias = QA_INBOX.replace('@', `+mpc${Date.now() % 1000}@`)
    const ctx = await signedInContext(info)
    const res = await sendCode(ctx.ctx, info, alias)
    expect(res.json?.error).not.toBe('disposable_email')
    await ctx.ctx.dispose()
  })

  test('T3-11 - The QA test inbox is allowed (gated, needs QA_INBOX_EMAIL)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    skipWhen(!QA_INBOX, 'QA_INBOX_EMAIL is not set. Gap G4: the QA inbox must not be on the disposable list.')
    const ctx = await signedInContext(info)
    const res = await sendCode(ctx.ctx, info, QA_INBOX)
    expect(res.json?.error).not.toBe('disposable_email')
    await ctx.ctx.dispose()
  })

  test('T3-13 - The code field accepts exactly six digits (gated)', async ({}, info) => {
    const { ctx } = await signedInContext(info)
    try {
      for (const code of CODE_BVA) {
        const res = await call(ctx, info, 'POST', '/api/register/verify-code', { body: { email: uniqueEmail('format'), code } })
        // Both 123456 and 004821 are valid formats; no code has been issued.
        expect(res.json?.error, code).toBe(/^\d{6}$/.test(code) ? 'no_code' : 'bad_code_format')
      }
    } finally { await ctx.dispose() }
  })

  test('T3-14 - Wrong codes count down the attempts and then ask for a new code (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const ctx = await signedInContext(info)
    const sixth = await exhaustAttempts(ctx.ctx, info)
    expect(sixth.status).toBe(401)
    await ctx.ctx.dispose()
  })

  test('T3-15 - A correct code is accepted on the fifth attempt (gated)', async () => {
    skipWhen(true, 'Needs the real code from the inbox; no inbox reader exists in this repo.')
  })

  test('T3-17 - Resend cooldown refuses a second code within 60 seconds (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const ctx = await signedInContext(info)
    await cooldownRefusal(ctx.ctx, info)
    await ctx.ctx.dispose()
  })

  test('T3-21 - An email already used by another wallet is refused (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const email = uniqueEmail('taken')
    const owner = await signedInContext(info)
    const reg = await call(owner.ctx, info, 'POST', '/api/register/skip-otp', { body: { email } })
    skipWhen(reg.status !== 200, `Skip-OTP registration is not available here (${reg.status} ${reg.json?.error ?? ''}).`)
    const other = await signedInContext(info)
    const res = await sendCode(other.ctx, info, email)
    expect(res.status).toBe(409)
    expect(res.json?.error).toBe('email_taken')
    await owner.ctx.dispose()
    await other.ctx.dispose()
  })

  test('T3-22 - A registered wallet asking for a code is told it is already verified (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const res = await sendCode(page.request, info, EMAIL.permanent)
    expect(res.status).toBe(409)
    expect(res.json?.error).toBe('already_registered')
  })

  test('T3-24 - The send response never carries the code (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const ctx = await signedInContext(info)
    const res = await sendCode(ctx.ctx, info, uniqueEmail('nocode'))
    skipWhen(res.status === 403, 'Telegram gate is on; community must be completed first.')
    expect(res.text).not.toMatch(/\b\d{6}\b/)
    expect(res.json).not.toHaveProperty('code')
    await ctx.ctx.dispose()
  })

  test('T3-25 - Brute force: after five wrong codes the sixth attempt gets no code (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const ctx = await signedInContext(info)
    await exhaustAttempts(ctx.ctx, info)
    await ctx.ctx.dispose()
  })

  test('T3-28 - Telegram gate on: sending a code before the community step is refused (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    const telegram = await call(page.request, info, 'GET', '/api/telegram/status')
    expect(telegram.status).toBe(200)
    expect(typeof telegram.json?.enforced).toBe('boolean')
    skipWhen(telegram.json?.enforced === false, 'Telegram gate is off on this target.')
    const res = await sendCode(page.request, info, uniqueEmail('gate'))
    expect(res.status).toBe(403)
    expect(res.json?.error).toBe('telegram_not_joined')
  })

  test('T3-29 - A registered wallet with a throwaway address gets already-registered, not disposable (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const res = await sendCode(page.request, info, EMAIL.disposable)
    expect(res.status).toBe(409)
    expect(res.json?.error).toBe('already_registered')
  })

  test('T3-30 - A throwaway address is refused before the Telegram check (gated)', async ({ page, newcomer }, info) => {
    expect(newcomer.address).toBeTruthy()
    const res = await sendCode(page.request, info, EMAIL.disposable)
    expect(res.status).toBe(400)
    expect(res.json?.error).toBe('disposable_email')
  })

  test('T3-31 - Header and HTML injection in the email field is refused and nothing is sent (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    // Only the whitespace-bearing payloads are refused by the format check and are safe to send.
    for (const payload of INJECTION_EMAILS.filter(p => /\s/.test(p))) {
      const res = await sendCode(page.request, info, payload)
      expect(res.json?.error, payload).toBe('bad_email')
    }
  })

  test('T3-01 - Send a code to a real inbox (send leg; inbox read is manual) (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    skipWhen(!QA_INBOX, 'QA_INBOX_EMAIL is not set.')
    const ctx = await signedInContext(info)
    const res = await sendCode(ctx.ctx, info, QA_INBOX)
    expect(res.status).toBe(200)
    await ctx.ctx.dispose()
  })

  test('T3-02 - A wrong code is refused and the tries left are shown (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const ctx = await signedInContext(info)
    const email = uniqueEmail('wrong')
    const sent = await sendCode(ctx.ctx, info, email)
    skipWhen(sent.status === 403, 'Telegram gate is on; community must be completed first.')
    const res = await call(ctx.ctx, info, 'POST', '/api/register/verify-code', { body: { email, code: '000000' } })
    expect(res.json?.error).toBe('wrong_code')
    expect(res.json?.attemptsLeft).toBe(4)
    await ctx.ctx.dispose()
  })

  test('M-08 - Asking for a second code too soon asks the user to wait (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const ctx = await signedInContext(info)
    await cooldownRefusal(ctx.ctx, info)
    await ctx.ctx.dispose()
  })

  test('M-10 - An email owned by another wallet is refused (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const email = uniqueEmail('owned')
    const owner = await signedInContext(info)
    const reg = await call(owner.ctx, info, 'POST', '/api/register/skip-otp', { body: { email } })
    skipWhen(reg.status !== 200, `Skip-OTP registration is not available here (${reg.status}).`)
    const other = await signedInContext(info)
    expect((await sendCode(other.ctx, info, email)).json?.error).toBe('email_taken')
    await owner.ctx.dispose()
    await other.ctx.dispose()
  })

  test('M-12 - Using up all tries asks for a new code (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const ctx = await signedInContext(info)
    await exhaustAttempts(ctx.ctx, info)
    await ctx.ctx.dispose()
  })

  test('M-13 - A throwaway email on screen is refused and says so (gated)', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    const responses: number[] = []
    page.on('response', (r) => { if (r.url().includes('/api/register/send-code')) responses.push(r.status()) })
    const sheet = await reachEmailStep(page)
    await sheet.locator('input[type="email"]').fill(EMAIL.disposable)
    await sheet.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(sheet.getByRole('alert')).toContainText(COPY.disposableEmail)
    expect(responses.every(s => s >= 400)).toBe(true)
  })

  test('M-14 - A test inbox address is allowed (gated, needs QA_INBOX_EMAIL)', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    skipWhen(!QA_INBOX, 'QA_INBOX_EMAIL is not set. Gap G4 applies.')
    const sheet = await reachEmailStep(page)
    await sheet.locator('input[type="email"]').fill(QA_INBOX)
    await sheet.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(sheet.getByText(COPY.disposableEmail, { exact: true })).toHaveCount(0)
  })

  test('UI-06-email - Email step reports no uncaught errors (gated)', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    const problems = watchErrors(page)
    await reachEmailStep(page)
    expect(problems).toEqual([])
  })

  todo('T3-05', 'A mixed-case address is accepted and normalised', 'Needs a sendable mixed-case inbox. Set QA_INBOX_EMAIL and add a mixed-case variant of it.')
  todo('T3-06', 'Leading and trailing spaces are trimmed', 'Needs a sendable inbox (as T3-05). The trimming is applied before the format check.')
  todo('T3-09', 'A lookalike domain (not10mail.org) is allowed', 'Would send mail to a real-looking domain. Run only with a QA-owned lookalike.')
  todo('T3-10', 'A throwaway not on the list (tempmail.com) is refused (gap G5)', 'Would send mail to a real tempmail address while the gap is open. Verified offline: tempmail.com is not on the list.')
  todo('T3-16', 'An expired code is refused at 10 minutes', 'Needs a code aged 10 minutes (OTP_TTL_MS); the clock cannot be moved on the server.')
  todo('T3-18', 'The per-email daily limit refuses the eleventh send', 'Slow: ten sends one minute apart (about ten minutes). Run as a scheduled slow case.')
  todo('T3-19', 'The per-IP daily limit refuses the thirty-first send', 'Slow and needs a trusted client IP per request.')
  todo('T3-20', 'The per-wallet daily limit refuses the twenty-first send', 'Slow: twenty-one sends across different addresses.')
  todo('T3-23', 'A failed send does not use up the quota', 'Needs fault injection in the mail provider on the stack.')
  todo('T3-26', 'A used code cannot be reused', 'Needs the real code from the inbox.')
  todo('T3-27', 'A code for one address cannot verify another', 'Needs the real code from the inbox.')
  todo('T3-32', 'The masked address on the code step does not contain raw HTML', 'Needs a sendable inbox to reach the code step.')
  todo('T3-33', 'A unicode IDN domain passes the format check', 'Would send mail to a real IDN domain; run with a QA-owned IDN address only.')
  todo('M-09', 'Passing the daily email limit is refused', 'Slow (see T3-18).')
  todo('M-11', 'Letting the code expire is refused and a new one can be sent', 'Needs a 10-minute wait (see T3-16).')

  test('M-xx-injection-note - Format check accepts angle brackets (finding)', async () => {
    // Observed in source, not sent: "a+<script>@x.com" passes EMAIL_FORMAT, so the send would go out
    // to a malformed domain. Recorded here as a finding; no request is made.
    skipWhen(true, 'Finding only: email format allows < and > characters (registration-rules.ts EMAIL_FORMAT). Not sent.')
  })
})
