import { expect, test } from '@playwright/test'
import { stubAnalytics } from '../../fixtures/network'
import { injectTestWallet } from '../../fixtures/wallet'
import { target } from '../../config/target'
import { JoinSheet } from '../../pages/JoinSheet'
import { copy } from '../../pages/copy'
import { getConfiguredWallet } from '../../utils/wallet-generator'

const t = target()

/**
 * Hourly smoke journeys. They are read-only by design: no session is ever created, so they are safe on
 * production. Full sign-in (a verified SIWE signature that creates a session) stays in the API suite and
 * runs only where writes are allowed, because it leaves a session and join row behind.
 */
test.describe('Hourly smoke journeys', { tag: ['@ui', '@smoke', '@regression'] }, () => {
  test('J01 - Anonymous mining access requires joining', async ({ page }) => {
    await stubAnalytics(page)
    await page.goto('/?tab=mine')
    const sheet = new JoinSheet(page)
    await sheet.dismissConsent()
    await expect(page.getByRole('main', { name: 'Home', exact: true })).toBeVisible()
    await expect(sheet.cta()).toBeVisible()
    await expect(page.getByRole('tabpanel', { name: 'My Mine', exact: true })).toBeHidden()
    const session = await page.request.get('/api/auth/session')
    expect(session.status()).toBe(200)
    expect((await session.json())?.address ?? null).toBeNull()
  })

  test('J02 - A rejected sign-in request never reaches verification', async ({ page }) => {
    test.skip(!process.env.QA_SEED_PHRASE || !process.env.WALLET_ADDRESS,
      'QA_SEED_PHRASE and WALLET_ADDRESS are required for wallet sign-in checks')

    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: t.chainId,
      // The wallet refuses the SIWE message, so the app can never send a signature to /api/auth/verify.
      failOn: { personal_sign: 'rejected' },
    })

    const verificationRequests: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/auth/verify') verificationRequests.push(request.method())
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await Promise.all([
      page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/nonce', { timeout: 60_000 }),
      sheet.connectWith(wallet.walletName),
    ])
    await expect(sheet.error()).toHaveText(copy.join.signRejected)


    // Still anonymous after the refusal.
    const session = await page.request.get('/api/auth/session')
    expect(session.status()).toBe(200)
    expect((await session.json())?.address ?? null).toBeNull()
    expect(verificationRequests, 'a refused signature must not be sent for verification').toEqual([])
  })
})
