import { expect, test } from '@playwright/test'
import { openMining } from '../../fixtures/mining-navigation'
import { target } from '../../config/target'
import { stubAnalytics } from '../../fixtures/network'
import { capabilities } from '../../fixtures/tiers'
import { injectTestWallet, setWalletFailure } from '../../fixtures/wallet'
import { copy } from '../../pages/copy'
import { JoinSheet } from '../../pages/JoinSheet'
import { getConfiguredWallet } from '../../utils/wallet-generator'
import { connectConfiguredWallet } from '../../fixtures/connected-wallet'
import { runRecordedActions } from './recorded-actions'

const t = target()

/**
 * T1 — wallet connect and SIWE sign-in.
 *
 * This is the tier that proves the whole approach: an EIP-6963 announcement is what makes the
 * wallet clickable at all, and a genuine ECDSA signature is what gets past `/api/auth/verify`.
 */
test.describe('Wallet discovery', { tag: ['@ui', '@feature-wallet', '@critical', '@smoke', '@regression', '@WALLET-01'] }, () => {
  test.skip(
    () => !process.env.QA_SEED_PHRASE,
    'QA_SEED_PHRASE is not set — there is no seed to derive a test wallet from',
  )

  test('W01 - Display Trust Wallet and WalletConnect options', async ({ page }, testInfo) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: t.chainId,
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()

    // 🔴 The assertion that matters. A bare `window.ethereum` injection produces wagmi's unnamed
    //    catch-all connector, which `visibleInjectedWallets()` filters out — so this row exists
    //    only because the mock announced itself over EIP-6963 with a name.
    await expect(sheet.walletRow(wallet.walletName)).toBeVisible({ timeout: 15_000 })

    // WalletConnect is always offered too: lib/wagmi.ts throws at startup if it is missing.
    await expect(sheet.walletConnectRow()).toBeVisible()
  })
})

/**
 * Everything below needs the server to accept a write from this origin.
 *
 * 🔴 Staging currently does not (`APP_ORIGIN` there names a different deployment), so these skip
 *    with that reason rather than failing. Without the guard they fail on `cross_origin` and read
 *    as "sign-in is broken", which is the wrong conclusion to hand anyone.
 */
test.describe('Wallet sign-in and recovery', { tag: ['@ui', '@feature-auth', '@critical', '@regression'] }, () => {
  test.setTimeout(300_000)
  test.beforeEach(async () => {
    test.skip(
      !process.env.QA_SEED_PHRASE,
      'QA_SEED_PHRASE is not set — there is no seed to derive a test wallet from',
    )
    const caps = await capabilities()
    test.skip(!caps.sameOriginWrites, caps.reason ?? 'the target refuses writes from this origin')
    // A successful sign-in creates a real session and `join_events` rows. Fine on a target we own;
    // from CI against shared mainnet staging it would accumulate throwaway wallets in that database.
    test.skip(
      Boolean(process.env.CI) && !t.isTestnet,
      `refusing to write sign-in data to a mainnet target (chain ${t.chainId}) from CI`,
    )
  })

  test('W02 - Sign in with Trust Wallet and open Digging', { tag: ['@AUTH-01'] }, async ({ page }, testInfo) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: t.chainId,
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.expectStep(copy.join.stepWallet)

    // Connecting also signs: `onConnectVia` chains straight into `signInWith`, so one click
    // carries the flow through the wallet step and the signature step together.
    await sheet.connectWith(wallet.walletName)

    await expect.poll(async () => {
      const response = await page.request.get('/api/auth/session')
      if (!response.ok()) return null
      return (await response.json()).address
    }, { timeout: 60_000 }).toBe(wallet.address.toLowerCase())

    const session = await page.request.get('/api/auth/session')
    expect(session.ok(), 'GET /api/auth/session should succeed').toBe(true)
    expect((await session.json()).address).toBe(wallet.address.toLowerCase())

    await openMining(page)
    // Intentional viewing pause after the connected Digging screen is ready.
    await page.waitForTimeout(10_000)
    const connectedSession = await page.request.get('/api/auth/session')
    expect((await connectedSession.json()).address).toBe(wallet.address.toLowerCase())
    await page.screenshot({ path: testInfo.outputPath('connected-wallet-digging.png'), fullPage: true })
  })

  test('W20 - Complete the recorded journey after successful wallet sign-in', { tag: ['@uat', '@JOURNEY-01', '@CLAIM-01'] }, async ({ page }, testInfo) => {
    test.setTimeout(300_000)
    await connectConfiguredWallet(page)
    // Keep the requested viewing pause before continuing the recorded actions.
    await page.waitForTimeout(10_000)
    await runRecordedActions(page, testInfo)
  })

  test('W03 - Display the connected account and recover from cancelled signing', { tag: ['@RECOVERY-01'] }, async ({ page }, testInfo) => {
    await stubAnalytics(page)
    // Failing the signature holds the flow on the sign step, which is where the address is shown.
    // Without this the flow runs straight through to the community step and the chip is gone.
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: t.chainId,
      failOn: { personal_sign: 'rejected' },
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)

    await sheet.expectStep(copy.join.stepSign)
    // The chip's accessible name carries the full lowercase address (Address.tsx).
    await expect(sheet.addressChip(wallet.address)).toBeVisible()
    await expect(sheet.signInButton()).toBeVisible()

    // Confirm the rejection, then allow the retry to sign normally.
    await expect(sheet.error()).toHaveText(copy.join.signRejected)
    await setWalletFailure(page, 'personal_sign', null)
    await sheet.signInButton().click()
    await expect.poll(async () => {
      const response = await page.request.get('/api/auth/session')
      if (!response.ok()) return null
      return (await response.json()).address
    }, { timeout: 60_000 }).toBe(wallet.address.toLowerCase())
    await expect(sheet.error()).not.toBeVisible()

    await openMining(page)
    // Intentional viewing pause after the connected Digging screen is ready.
    await page.waitForTimeout(10_000)

  })
})
