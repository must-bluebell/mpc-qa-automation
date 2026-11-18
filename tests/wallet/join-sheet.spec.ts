import { test, expect } from '@playwright/test'
import { JoinSheet } from '../../pages/JoinSheet'
import { copy } from '../../pages/copy'

test('Join opening dismisses consent that appears after the initial page load', async ({ page }) => {
  await page.setContent(`<main aria-label="Home"><button disabled>Join Unity</button></main>
    <section role="dialog" aria-label="Audience measurement choice" hidden
      style="position:fixed;inset:0;background:white;z-index:100"><button>Reject</button></section>
    <dialog aria-label="Join"><div role="progressbar" aria-label="Wallet"></div><p></p></dialog>`)
  await page.evaluate((instructions) => {
    const consent = document.querySelector('section')!
    const cta = document.querySelector('main button') as HTMLButtonElement
    const join = document.querySelector('dialog')!
    join.querySelector('p')!.textContent = instructions
    consent.querySelector('button')!.addEventListener('click', () => { consent.hidden = true })
    cta.addEventListener('click', () => join.showModal())
    // Reproduce the deployed race: consent arrives beyond the old three-second probe.
    setTimeout(() => { consent.hidden = false; cta.disabled = false }, 4_000)
  }, copy.join.connectLede)
  await new JoinSheet(page).open()
  await expect(page.getByRole('dialog', { name: 'Audience measurement choice' })).toBeHidden()
  await expect(new JoinSheet(page).sheet()).toBeVisible()
})

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
