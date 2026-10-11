import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { openMining, usesActivities } from '../../fixtures/mining-navigation'
import { target } from '../../config/target'
import { getConfiguredWallet } from '../../utils/wallet-generator'

async function closeJoinIfOpen(page: Page): Promise<void> {
  const join = page.getByRole('dialog', { name: 'Join', exact: true })
  if (await join.isVisible()) {
    await join.getByRole('button', { name: usesActivities() ? 'Later' : 'Close Join', exact: true }).click({ timeout: 3_000 })
    await expect(join).not.toBeVisible()
  }
}

/** Follow the recorded actions in one browser session, without another wallet connection. */
export async function runRecordedActions(page: Page, testInfo: TestInfo): Promise<void> {
  if (usesActivities()) {
    const certificate = await page.request.get('/my-mine/claim')
    expect(certificate.ok(), 'My Mine certificate status must load').toBe(true)
    if (!(await certificate.json()).held) {
      const reason = 'Recorded journey requires a My Mine certificate for the test wallet.'
      testInfo.annotations.push({ type: 'blocked', description: reason })
      test.skip(true, reason)
    }
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: target().baseUrl })

  await test.step('W20 - Open account, choose Ventures, and copy the referral link', async () => {
    const ventures = page.getByRole(usesActivities() ? 'tab' : 'button', { name: 'Ventures', exact: true })
    await expect(async () => {
      await closeJoinIfOpen(page)
      if (!usesActivities() && !await ventures.isVisible()) {
        await page.getByRole('button', { name: 'Open user account', exact: true }).click({ timeout: 3_000 })
      }
      await ventures.click({ timeout: 3_000 })
      await expect(page).toHaveURL(usesActivities() ? /tab=ventures/ : /view=ventures/, { timeout: 3_000 })
      await expect(page.getByRole('heading', { name: 'Invite', exact: true })).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 60_000 })

    await page.getByRole('button', { name: 'Copy', exact: true }).click({ timeout: 30_000 })
    const link = `${target().baseUrl}/?ref=${getConfiguredWallet().address.toLowerCase()}`
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link)
  })

  await test.step('W21 - Claim Crew when available, or verify the empty reward state', async () => {
    const claim = page.getByRole('button', { name: 'Claim crew', exact: true })
    await expect(claim).toBeVisible()
    const emptyState = page.getByRole('main').getByText(usesActivities() ? 'Nothing stands to claim yet' : 'Nothing to claim yet', { exact: true }).filter({ visible: true })
    if (await claim.isDisabled()) {
      await expect(emptyState).toBeVisible()
      testInfo.annotations.push({ type: 'reward-state', description: 'No referral rewards available; Claim crew is disabled.' })
    } else {
      await claim.click()
      await expect(claim).toBeDisabled({ timeout: 60_000 })
      await expect(emptyState).toBeVisible()
    }
  })

  await test.step('W22 - Open proposal 1', async () => {
    await page.goto(usesActivities() ? '/?tab=vote&proposal=1' : '/?view=vote&proposal=1')
    await expect(page).toHaveURL(usesActivities() ? /tab=vote&proposal=1/ : /view=vote&proposal=1/)
    await expect(page.getByRole('main')).toBeVisible()
    if (usesActivities()) await expect(page.getByRole('tabpanel', { name: 'Vote', exact: true })).toBeVisible()
  })

  const externalPages: Page[] = []
  try {
    await test.step('W23 - Open community check-in in a separate tab', async () => {
      const checkIn = await page.context().newPage()
      externalPages.push(checkIn)
      const response = await checkIn.goto('https://pre-check-in.globalmpc.tech/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      expect(response?.ok(), 'Community check-in should load').toBe(true)
      await expect(checkIn).toHaveURL(/^https:\/\/pre-check-in\.globalmpc\.tech\//)
    })

    await test.step('W24 - Open the MPC X profile in a separate tab', async () => {
      const profile = await page.context().newPage()
      externalPages.push(profile)
      const response = await profile.goto('https://x.com/MPC_Global_X', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      const status = response?.status() ?? 0
      await expect(profile).toHaveURL(/^https:\/\/x\.com\//)
      await testInfo.attach('x-navigation-status', {
        body: Buffer.from(JSON.stringify({ url: profile.url(), status })), contentType: 'application/json',
      })
      if (status === 403 || status === 429) {
        testInfo.annotations.push({ type: 'external-blocked', description: `X prevented profile loading (HTTP ${status}); navigation was attempted.` })
      } else {
        expect(response?.ok(), 'X profile should load').toBe(true)
      }
    })
  } finally {
    for (const externalPage of externalPages) await externalPage.close()
  }

  await test.step('Return to Digging and confirm the wallet session', async () => {
    await openMining(page)
    const session = await page.request.get('/api/auth/session')
    expect(session.ok()).toBe(true)
    expect((await session.json()).address).toBe(getConfiguredWallet().address.toLowerCase())
    await page.screenshot({ path: testInfo.outputPath('recorded-journey-digging.png'), fullPage: true })
  })
}
