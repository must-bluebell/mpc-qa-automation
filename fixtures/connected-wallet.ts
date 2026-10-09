import { expect, type Page } from '@playwright/test'
import { openMining, usesActivities } from './mining-navigation'
import { target } from '../config/target'
import { stubAnalytics } from './network'
import { injectTestWallet, type MockWallet } from './wallet'
import { JoinSheet } from '../pages/JoinSheet'
import { getConfiguredWallet } from '../utils/wallet-generator'

/** Connect once and wait for authentication and the visible connected page. */
export async function connectConfiguredWallet(page: Page): Promise<MockWallet> {
  const wallet = await injectTestWallet(page, {
    account: getConfiguredWallet(),
    chainId: target().chainId,
  })
  await stubAnalytics(page)
  await page.goto('/')
  const sheet = new JoinSheet(page)
  await sheet.open()
  await sheet.connectWith(wallet.walletName)
  await expect.poll(async () => {
    const response = await page.request.get('/api/auth/session')
    return response.ok() ? (await response.json()).address : null
  }, { timeout: 60_000 }).toBe(wallet.address.toLowerCase())

  // Readiness is based on session and UI state, not one potentially cached response event.
  await openMining(page)
  if (!usesActivities()) await expect(page.getByRole('button', { name: 'Open user account', exact: true })).toBeVisible({ timeout: 60_000 })
  return wallet
}
