import { expectValidationMessage } from './validation-messages'
import { validationCopy } from '../pages/validation-copy'
import { expect, type Page } from '@playwright/test'
import { target } from '../config/target'

export const usesActivities = () => process.env.QA_NAVIGATION === 'activities'

/** Use the current local app's real onboarding, never a mocked member/session response. */
export async function openMining(page: Page): Promise<void> {
  if (!usesActivities()) {
    await page.goto('/?view=dig')
    await expect(page.getByRole('heading', { name: 'Digging', exact: true })).toBeVisible()
    await expectValidationMessage(page.getByText(validationCopy.miningIntro, { exact: true }), validationCopy.miningIntro, 'digging-instructions')
    return
  }
  const registration = await page.request.get('/api/register/status')
  expect(registration.ok(), 'Registration status must load').toBe(true)
  if (!(await registration.json()).registered) {
    const hostname = new URL(target().baseUrl).hostname
    if (!['local-docker', 'web-isolated'].includes(process.env.QA_ENVIRONMENT ?? '') || process.env.QA_ALLOW_WRITES !== '1' || !['localhost', '127.0.0.1'].includes(hostname)) {
      throw new Error('Current mining journey requires a registered test member; local onboarding is not authorized for this target.')
    }
    const join = page.getByRole('dialog', { name: 'Join', exact: true })
    // The local scenario app skips OTP. Social destinations are not part of wallet authentication.
    const social = /^https:\/\/(t\.me|x\.com)\//
    await page.context().route(social, route => route.fulfill({ status: 204, body: '' }))
    try {
      await join.getByRole('link', { name: /Join the Telegram group/ }).click()
      await join.getByRole('link', { name: /Follow on X/ }).click()
      await join.getByRole('button', { name: 'Continue', exact: true }).click()
      await join.locator('input[type="email"]').fill(`wallet-qa-${Date.now()}@example.com`)
      await join.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(join.getByRole('button', { name: 'Open activities', exact: true }).first()).toBeVisible({ timeout: 180_000 })
    } finally {
      await page.context().unroute(social)
    }
  }
  await page.goto('/?tab=mine')
  await expect(page.getByRole('tab', { name: 'My Mine', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 })
  await expect(page.getByRole('tabpanel', { name: 'My Mine', exact: true })).toBeVisible()
  const status = await page.request.get('/api/register/status')
  expect(status.ok()).toBe(true)
  expect((await status.json()).registered, 'Mining is reached with real completed registration').toBe(true)
}
