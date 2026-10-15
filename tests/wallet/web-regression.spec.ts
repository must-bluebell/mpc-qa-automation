import { expect, test as base, type Page } from '@playwright/test'
import { generateMnemonic, mnemonicToAccount, english } from 'viem/accounts'
import { target } from '../../config/target'
import { appOrigin, requireWrites } from '../../fixtures/api'
import { stubAnalytics } from '../../fixtures/network'
import { connectConfiguredWallet } from '../../fixtures/connected-wallet'
import { injectTestWallet, type MockWallet } from '../../fixtures/wallet'
import { JoinSheet } from '../../pages/JoinSheet'
import { storedActivity } from '../../fixtures/stored-activity'

// Derived from MPC-load-testing.jmx and mpc-waitlist.postman_collection.json.
// Wallet signatures and MPC responses are real; only third-party destinations are stubbed.
function blockIf(condition: boolean, reason: string) {
  if (condition) {
    base.info().annotations.push({ type: 'blocked', description: reason })
    base.skip(true, reason)
  }
}

const test = base.extend<{ member: MockWallet; newcomer: MockWallet; activityRecord: string }>({
  member: async ({ page }, use) => {
    requireWrites()
    blockIf(!process.env.QA_SEED_PHRASE, 'Configured member wallet is missing')
    await use(await connectConfiguredWallet(page))
  },
  newcomer: async ({ page }, use) => {
    requireWrites()
    const wallet = await injectTestWallet(page, { account: mnemonicToAccount(generateMnemonic(english)), chainId: target().chainId })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)
    await expect.poll(async () => (await (await page.request.get('/api/auth/session', { maxRetries: 2 })).json()).address).toBe(wallet.address.toLowerCase())
    await sheet.expectStep('Community')
    await use(wallet)
  },
  activityRecord: async ({ page }, use, info) => {
    requireWrites()
    const refresh = info.title.startsWith('WEB-15')
    if (!process.env.QA_WEB_FIXTURE_CONTAINER) {
      const id = process.env[refresh ? 'QA_WEB_ACTIVITY_REFRESH_ID' : 'QA_WEB_ACTIVITY_DISMISS_ID']
      blockIf(!id, 'Run npm run test:web:isolated to prepare an owned Activity fixture')
      await connectConfiguredWallet(page)
      await use(id!)
      return
    }
    const wallet = await injectTestWallet(page, { account: mnemonicToAccount(generateMnemonic(english)), chainId: target().chainId })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)
    await expect.poll(async () => (await (await page.request.get('/api/auth/session', { maxRetries: 2 })).json()).address).toBe(wallet.address.toLowerCase())
    const record = await storedActivity(wallet.address, refresh ? 'pending' : 'failed')
    try {
      await page.reload()
      await use(record.id)
    } finally { await record.cleanup() }
  },
})

async function closeJoin(page: Page) {
  const sheet = page.getByRole('dialog', { name: 'Join', exact: true })
  // The member helper navigates while Join is marked for restoration. Wait for
  // its lazy-loaded dialog before starting another overlay; do not race hydration.
  const restoring = await page.evaluate(() => sessionStorage.getItem('mpc.join-sheet') === '1')
  if (restoring) await expect(sheet).toBeVisible()
  if (await sheet.isVisible()) {
    const later = sheet.getByRole('button', { name: 'Later', exact: true })
    if (await later.isVisible()) await later.click()
    else await page.keyboard.press('Escape')
    await expect(sheet).not.toBeVisible()
  }
}
async function emailStep(page: Page) {
  const sheet = page.getByRole('dialog', { name: 'Join', exact: true })
  await page.context().route(/^https:\/\/(t\.me|x\.com)\//, route => route.fulfill({ status: 204, body: '' }))
  await sheet.getByRole('link', { name: /Join the Telegram group/ }).click()
  await sheet.getByRole('link', { name: /Follow on X/ }).click()
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(sheet.locator('input[type="email"]')).toBeVisible()
  return sheet
}
async function assertTab(page: Page, label: string, key: string) {
  await expect(page).toHaveURL(new RegExp(`[?&]tab=${key}(?:&|$)`))
  await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: label, exact: true })).toBeVisible()
}
async function disconnect(page: Page) {
  await closeJoin(page)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.getByRole('dialog', { name: 'Disconnect wallet?', exact: true }).getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect.poll(async () => (await (await page.request.get('/api/auth/session', { maxRetries: 2 })).json()).address).toBeNull()
  await expect(new JoinSheet(page).cta()).toBeVisible()
}

test.describe('MPC web regression from supplied plans', { tag: ['@ui', '@regression', '@web-regression'] }, () => {
  test.setTimeout(120_000)
  test.beforeEach(async ({ page }, info) => {
    await stubAnalytics(page)
    if (info.title.startsWith('WEB-15')) await page.clock.install()
  })

  test('WEB-01 - Home remains usable after a browser reload', async ({ page }) => {
    await page.goto('/')
    await expect(new JoinSheet(page).cta()).toBeVisible()
    await page.reload()
    await expect(new JoinSheet(page).cta()).toBeVisible()
    expect((await (await page.request.get('/api/auth/session', { maxRetries: 2 })).json()).address).toBeNull()
  })
  for (const [id, label, key, path] of [
    ['02', 'Quests', 'quest', '/quests'], ['03', 'My Mine', 'mine', '/mine'], ['04', 'Vote', 'vote', '/vote'],
  ] as const) {
    test(`WEB-${id} - ${label} legacy link opens the correct board panel`, async ({ page, member }) => {
      expect(member.address).toBeTruthy()
      await closeJoin(page)
      await page.goto(path)
      await assertTab(page, label, key)
    })
  }
  test('WEB-05 - Browser back and forward restore the selected board panel', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await page.goto('/?tab=quest')
    await assertTab(page, 'Quests', 'quest')
    await page.goto('/?tab=vote')
    await assertTab(page, 'Vote', 'vote')
    await page.goBack()
    await assertTab(page, 'Quests', 'quest')
    await page.goForward()
    await assertTab(page, 'Vote', 'vote')
  })
  test('WEB-06 - Closing and reopening Join preserves the community step', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    await closeJoin(page)
    await new JoinSheet(page).open('Community')
    await new JoinSheet(page).expectStep('Community')
  })
  test('WEB-07 - Malformed email shows validation and does not register the wallet', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    const sheet = await emailStep(page)
    await sheet.locator('input[type="email"]').fill('invalid-email')
    const rejected = page.waitForResponse(r => r.url().endsWith('/api/register/skip-otp') && r.request().method() === 'POST')
    await sheet.getByRole('button', { name: 'Continue', exact: true }).click()
    const response = await rejected
    expect(response.status()).toBe(400)
    expect((await response.json()).error).toBe('bad_email')
    await expect(sheet.getByText('Check the email format.', { exact: true })).toBeVisible()
    expect((await (await page.request.get('/api/register/status')).json()).registered).toBe(false)
  })
  test('WEB-08 - Incomplete community actions prevent proceeding to email', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    const sheet = page.getByRole('dialog', { name: 'Join', exact: true })
    await expect(sheet.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    await expect(sheet.locator('input[type="email"]')).toHaveCount(0)
  })
  test('WEB-09 - Reload restores completed community progress without registering', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    await emailStep(page)
    await page.reload()
    await expect(page.getByRole('dialog', { name: 'Join', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Join', exact: true }).locator('input[type="email"]')).toBeVisible()
    expect((await (await page.request.get('/api/register/status')).json()).registered).toBe(false)
  })
  test('WEB-10 - Reload preserves the signed-in wallet and selected panel', async ({ page, member }) => {
    await page.goto('/?tab=quest')
    await page.reload()
    await assertTab(page, 'Quests', 'quest')
    // A reload can leave a stale keep-alive socket on the local dev server.
    // Retry connection resets only; HTTP errors and the session assertion still fail normally.
    expect((await (await page.request.get('/api/auth/session', { maxRetries: 2 })).json()).address).toBe(member.address.toLowerCase())
  })
  test('WEB-11 - A second browser tab shares the same server session', async ({ page, member }) => {
    const second = await page.context().newPage()
    try {
      await stubAnalytics(second)
      await second.goto('/?tab=quest')
      await assertTab(second, 'Quests', 'quest')
      expect((await (await second.request.get('/api/auth/session')).json()).address).toBe(member.address.toLowerCase())
    } finally { await second.close() }
  })
  test('WEB-12 - Browser logout remains effective after reload', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await disconnect(page)
    await page.reload()
    await expect(new JoinSheet(page).cta()).toBeVisible()
    expect((await (await page.request.get('/api/auth/session', { maxRetries: 2 })).json()).address).toBeNull()
  })
  test('WEB-13 - A protected deep link cannot restore identity after logout', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await disconnect(page)
    await page.goto('/?tab=mine')
    await expect(new JoinSheet(page).cta()).toBeVisible()
    await expect(page.getByRole('tabpanel', { name: 'My Mine', exact: true })).toHaveCount(0)
    expect((await page.request.get('/api/notifications')).status()).toBe(401)
  })
  test('WEB-14 - A new wallet has no activity launcher or another user’s activity', async ({ page, newcomer }) => {
    expect(newcomer.address).toBeTruthy()
    await closeJoin(page)
    const response = await page.request.get('/api/activities')
    expect(response.status()).toBe(200)
    expect((await response.json()).activities).toEqual([])
    await expect(page.getByRole('button', { name: /^Activity / })).toHaveCount(0)
  })
  for (const [id, action] of [
    ['15', 'Check status'], ['16', 'Close'],
  ] as const) {
    test(`WEB-${id} - Activity ${action} updates the real wallet feed`, async ({ page, activityRecord }) => {
      const activityId = activityRecord
      const data = await (await page.request.get('/api/activities')).json()
      const item = data.activities.find((a: { activityId: string | number }) => String(a.activityId) === activityId)
      if (process.env.QA_WEB_FIXTURE_CONTAINER) {
        expect(item, 'The owned notification fixture must appear in the real feed').toBeDefined()
        expect(data.activities, 'The fresh wallet must have exactly its fixture notification').toHaveLength(1)
        if (id === '15') expect(['submitting', 'confirming']).toContain(item.status)
        else { expect(item.status).toBe('failed'); expect(item.finalized).toBe(true) }
      } else {
        blockIf(!item, 'Configured QA activity is absent from this wallet feed')
        blockIf(id === '15' ? !['submitting', 'confirming'].includes(item.status) : item.status !== 'failed' || item.finalized === false,
          'Configured QA activity is not in the required state')
        blockIf(data.activities.length !== 1, 'Activity fixture must be the only current item for deterministic browser selection')
      }
      await closeJoin(page)
      await page.getByRole('button', { name: /^Activity / }).click()
      const card = page.locator('article').filter({ has: page.getByRole('button', { name: action, exact: true }) })
      // Avoid acting on an arbitrary existing item when multiple cards share the same action.
      // Freeze provider polling so a background timer cannot satisfy the refresh check.
      if (id === '15') {
        // Use the browser clock: the Node wall clock can lag the installed clock.
        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
      }
      const requested = page.waitForRequest(r => new URL(r.url()).pathname === (id === '15'
        ? '/api/activities' : `/api/activities/${activityId}/dismiss`), { timeout: 5000 })
      await card.getByRole('button', { name: action, exact: true }).click()
      const request = await requested
      expect(request.method()).toBe(id === '15' ? 'GET' : 'POST')
      const response = await request.response()
      expect(response?.status()).toBe(200)
      if (id === '16') {
        await expect(card).toHaveCount(0)
        expect((await (await page.request.get('/api/activities')).json()).activities.some((a: { activityId: string | number }) => String(a.activityId) === activityId)).toBe(false)
      } else {
        expect((await response!.json()).activities.some((a: { activityId: string | number }) => String(a.activityId) === activityId)).toBe(true)
        await expect(card).toBeVisible()
      }
    })
  }
  test('WEB-17 - A nonexistent proposal shows an explicit recovery message', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await page.goto('/?tab=vote&proposal=999999999')
    await assertTab(page, 'Vote', 'vote')
    await expect(page.getByRole('alert').filter({ hasText: 'This proposal does not exist on-chain.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Back to proposals', exact: true })).toBeVisible()
  })
  test('WEB-18 - Back to proposals clears the invalid selection and restores the list', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await page.goto('/?tab=vote&proposal=999999999')
    await page.getByRole('button', { name: 'Back to proposals', exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('proposal')).toBeNull()
    await assertTab(page, 'Vote', 'vote')
    await expect(page.getByRole('alert').filter({ hasText: 'This proposal does not exist on-chain.' })).toHaveCount(0)
    const panel = page.getByRole('tabpanel', { name: 'Vote', exact: true })
    await expect(panel.getByRole('navigation', { name: 'Filter proposals' })
      .or(panel.getByText('No proposals have been published.', { exact: true }))).toBeVisible()
    await expect(panel.getByText('Vote data is temporarily unavailable', { exact: true })).toHaveCount(0)
  })
  test('WEB-19 - Anonymous admin navigation requires login', async ({ page }) => {
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login(?:\?|$)/)
    await expect(page.locator('input[type="password"]')).toBeVisible()
    expect((await page.request.get('/api/admin/admins', { headers: { origin: appOrigin() } })).status()).toBe(401)
  })
  test('WEB-20 - Anonymous My Mine navigation exposes no signed-in panel or private feed', async ({ page }) => {
    await page.goto('/?tab=mine')
    await expect(new JoinSheet(page).cta()).toBeVisible()
    await expect(page.getByRole('tabpanel', { name: 'My Mine', exact: true })).toHaveCount(0)
    const response = await page.request.get('/api/activities')
    expect(response.status()).toBe(401)
    expect((await response.json()).error).toBe('not_signed_in')
  })
})
