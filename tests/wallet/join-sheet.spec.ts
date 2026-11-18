import { test, expect } from '@playwright/test'
import { JoinSheet } from '../../pages/JoinSheet'

test('Join controls distinguish the primary network action from feedback actions', async ({ page }) => {
  await page.setContent(`<dialog open aria-label="Join">
    <div role="alert" aria-label="Wallet request"><p>Switch failed</p><button>Switch network</button></div>
    <button onclick="this.textContent='Requested'">Switch network</button>
  </dialog>`)
  const sheet = new JoinSheet(page)
  await sheet.switchChainButton().click()
  await expect(page.getByRole('button', { name: 'Requested', exact: true })).toBeVisible()
  await expect(sheet.error()).toHaveText('Switch failed')
})

test('Join feedback reads cancellation and pending status without requiring an alert', async ({ page }) => {
  await page.setContent(`<dialog open aria-label="Join"><div role="status" aria-label="Wallet request">
    <p>A request is already waiting in your wallet.</p><button>Open wallet</button>
  </div></dialog>`)
  await expect(new JoinSheet(page).error()).toHaveText('A request is already waiting in your wallet.')
})

test('Join feedback still reads the legacy error paragraph', async ({ page }) => {
  await page.setContent('<dialog open aria-label="Join"><p role="alert">Could not connect.</p></dialog>')
  await expect(new JoinSheet(page).error()).toHaveText('Could not connect.')
})
