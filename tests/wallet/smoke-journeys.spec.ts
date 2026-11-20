import { expect, test } from '@playwright/test'
import { usesActivities } from '../../fixtures/mining-navigation'
import { stubAnalytics } from '../../fixtures/network'
import { injectTestWallet } from '../../fixtures/wallet'
import { target } from '../../config/target'
import { JoinSheet } from '../../pages/JoinSheet'
import { getConfiguredWallet } from '../../utils/wallet-generator'

const t = target()

/**
 * Hourly smoke journeys. They are read-only by design: no session is ever created, so they are safe on
 * production. Full sign-in (a verified SIWE signature that creates a session) stays in the API suite and
 * runs only where writes are allowed, because it leaves a session and join row behind.
 */
test.describe('Hourly smoke journeys', { tag: ['@ui', '@smoke', '@regression'] }, () => {
  test.skip(
    () => !process.env.QA_SEED_PHRASE,
    'QA_SEED_PHRASE is not set — there is no seed to derive a test wallet from',
  )

  test('J01 - Digging opens for an anonymous visitor', async ({ page }) => {
    test.skip(usesActivities(), 'The Digging journey is not part of the activities navigation.')
    await page.goto('/?view=dig')
    await expect(page.getByRole('heading', { name: 'Digging', exact: true })).toBeVisible({ timeout: 30_000 })
  })

  test('J02 - A rejected sign-in request never reaches verification', async ({ page }) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: t.chainId,
      // The wallet refuses the SIWE message, so the app can never send a signature to /api/auth/verify.
      failOn: { personal_sign: 'rejected' },
    })

    const nonceRequested = page.waitForRequest(
      request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/nonce',
      { timeout: 60_000 },
    )
    const verifyRequested = page.waitForRequest(
      request => new URL(request.url()).pathname === '/api/auth/verify',
      { timeout: 20_000 },
    ).then(() => true, () => false)

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.walletRow(wallet.walletName).click()

    // The sign-in started: the app asked the server for a nonce before asking the wallet to sign.
    await nonceRequested
    expect(await verifyRequested, 'a refused signature must not be sent for verification').toBe(false)

    // Still anonymous after the refusal.
    const session = await page.request.get('/api/auth/session')
    expect(session.status()).toBe(200)
    expect((await session.json())?.address ?? null).toBeNull()
  })
})
