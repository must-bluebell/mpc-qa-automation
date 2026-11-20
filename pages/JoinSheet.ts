import { validationCopy } from './validation-copy'
import { expectValidationMessage } from '../fixtures/validation-messages'
import { expect, type Locator, type Page } from '@playwright/test'
import { addressChipName, copy } from './copy'

/** How long to wait for the analytics choice banner before deciding it is not coming. */
const CONSENT_WINDOW_MS = 8_000
/** How long the Join CTA may stay covered by the analytics banner before the case fails. */
const CTA_CLEAR_TIMEOUT_MS = 40_000
/** One pointer attempt at the CTA; a refused attempt is retried by `clickCta`. */
const CTA_ATTEMPT_MS = 10_000

/**
 * Every locator in the suite lives here. Tests describe behaviour; this file knows how to find
 * things.
 *
 * ## Why role and name, and not data-testid
 *
 * globalmpc-webapp has **no `data-testid` attributes at all** (audited: 0 hits repo-wide), and its
 * class names are Tailwind utilities composed through `cx()` under a SHA-pinned design system — so
 * they are genuinely unusable as selectors. What it does have is good accessibility semantics, and
 * `getByRole(role, { name })` is Playwright's recommended locator anyway.
 *
 * If `data-testid` attributes are added to the app later, this is the only file that changes.
 */
export class JoinSheet {
  constructor(private readonly page: Page) {}

  /**
   * The landing CTA that opens the sheet.
   *
   * 🔴 **Must be matched by role, not by text.** While the app decides whether you already hold an
   *    SBT it renders a same-sized placeholder containing this exact string, as a
   *    `<span role="status">` that is transparent and non-interactive — deliberately, so the label
   *    cannot change under a user's finger mid-press. `getByText` would match both and fail on
   *    strict mode; the button role matches only the real one. (Landing.tsx:437-470)
   */
  cta(): Locator {
    const home = this.page.getByRole('main', { name: 'Home', exact: true })
    // Unity deployments renamed the CTA; older targets still use the vendored waitlist copy.
    return home.getByRole('button', { name: 'Join Unity', exact: true })
      .or(home.getByRole('button', { name: copy.landing.join, exact: true }))
  }

  /** `Modal` is a native `<dialog>` with `aria-label={label}`; JoinFlow passes `t.title`. */
  sheet(): Locator {
    return this.page.getByRole('dialog', { name: copy.join.title })
  }

  /**
   * The step bar carries the **current** step's name as its accessible name, which makes it the
   * cleanest way to assert where the flow is standing. (JoinFlow.tsx:1182-1186)
   */
  stepBar(): Locator {
    return this.sheet().getByRole('progressbar')
  }

  /** Shown while the injected-wallet probe is still running (up to `INJECTED_PROBE_GRACE_MS`). */
  detecting(): Locator {
    return this.sheet().getByText(copy.join.connectDetecting)
  }

  /**
   * A wallet row. The label is `connector.name` — the name the wallet announced over EIP-6963 —
   * so for the mock it is whatever `injectTestWallet` was given. (JoinFlow.tsx:596)
   */
  walletRow(name: string): Locator {
    return this.sheet().getByRole('button', { name })
  }

  walletConnectRow(): Locator {
    return this.sheet().getByRole('button', { name: copy.join.connectWalletConnect })
  }

  /** The address chip on the sign step. Its accessible name carries the full lowercase address. */
  addressChip(address: string): Locator {
    return this.sheet().getByRole('button', { name: addressChipName(address) })
  }

  signInButton(): Locator {
    return this.sheet().getByRole('button', { name: copy.join.signIn, exact: true })
  }

  switchChainButton(): Locator {
    // Feedback can offer a second switch action. Use the primary form control.
    return this.sheet().getByRole('button', { name: copy.join.switchChain, exact: true })
      .and(this.sheet().locator('button:not([aria-label="Wallet request"] button)'))
  }

  /** Recoverable wallet requests use status; failures use alert. Exclude action labels. */
  error(): Locator {
    return this.sheet().locator('p[role="alert"], [aria-label="Wallet request"] p')
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /** The analytics choice banner. Its accessible name is fixed by the app. */
  consentDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Audience measurement choice', exact: true })
  }

  /**
   * Rejects analytics consent when it is shown within a bounded window, and confirms it has gone.
   *
   * The banner arrives after hydration, sometimes several seconds after the CTA is already visible.
   * It is handled here rather than through `addLocatorHandler`, which never completed its Reject
   * click on the deployed app (hosted-full 20261118-113042-hosted-full-6af3). A banner that arrives
   * after this window is handled by `clickCta`.
   */
  async dismissConsent(): Promise<void> {
    const appeared = await this.consentDialog().waitFor({ state: 'visible', timeout: CONSENT_WINDOW_MS }).then(() => true, () => false)
    if (appeared) await this.rejectConsent()
  }

  /** Rejects the banner if it is showing now, and confirms it has closed. */
  private async rejectConsent(): Promise<void> {
    const consent = this.consentDialog()
    const reject = consent.getByRole('button', { name: 'Reject', exact: true })
    await reject.click({ timeout: 5_000 }).catch(async () => {
      // A banner still in its entrance transition can refuse a pointer click. The button's own click
      // handler is the same action, so fall back to it rather than failing the whole case.
      await reject.evaluate((button: HTMLElement) => button.click())
    })
    await expect(consent, 'Analytics consent should close after Reject').toBeHidden({ timeout: 10_000 })
  }

  /**
   * Clicks the Join CTA, clearing the analytics banner whenever it covers the button.
   *
   * The banner can arrive after `dismissConsent` has given up, while the click is already waiting,
   * and it then intercepts every pointer attempt (16 chromium cases in hosted-full
   * 20261120-045156-hosted-full-c443 waited 30 seconds on it). Playwright never dispatches a click
   * that is intercepted, so each refused attempt is safe to repeat. After a refused attempt the
   * banner is rejected if it is now showing, and the click is tried again until the budget runs out.
   */
  async clickCta(): Promise<void> {
    await this.dismissConsent()
    const deadline = Date.now() + CTA_CLEAR_TIMEOUT_MS
    for (;;) {
      try {
        await this.cta().click({ timeout: CTA_ATTEMPT_MS })
        return
      } catch (error) {
        if (Date.now() >= deadline) throw error
        if (await this.consentDialog().isVisible()) await this.rejectConsent()
      }
    }
  }

  async open(expectedStep: 'Wallet' | 'Community' = 'Wallet'): Promise<void> {
    await this.clickCta()
    await expect(this.sheet()).toBeVisible()
    await this.expectStep(expectedStep)
    const instructions = expectedStep === 'Community' ? validationCopy.communityIntro : copy.join.connectLede
    await expectValidationMessage(this.sheet().getByText(instructions, { exact: true }), instructions, expectedStep === 'Community' ? 'community-instructions' : 'wallet-connect-instructions')
  }

  /**
   * Click the mock wallet's row, once the probe has found it.
   *
   * The probe is not instant — wagmi waits up to 1s for late injection and the app matches that
   * budget — so the row is awaited rather than assumed present.
   */
  async connectWith(walletName: string): Promise<void> {
    const row = this.walletRow(walletName)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
  }

  /** A delayed onboarding sheet can cover the authenticated mining/Quests controls. */
  async dismissIfOpen(): Promise<void> {
    if (!await this.sheet().isVisible()) return
    const community = this.sheet().getByText(validationCopy.communityIntro, { exact: true })
    if (await community.isVisible()) {
      await expectValidationMessage(community, validationCopy.communityIntro, 'community-instructions')
    }
    const telegram = this.sheet().getByRole('alert').filter({ hasText: validationCopy.telegramUnavailable })
    if (await telegram.isVisible()) {
      await expectValidationMessage(telegram, validationCopy.telegramUnavailable, 'telegram-membership-unavailable')
    }
    try {
      await this.sheet().getByRole('button', { name: /^(Close Join|Later)$/ }).filter({ visible: true }).first().click({ timeout: 5_000 })
    } catch (error) {
      // A busy sign-in sheet can dismiss itself while Playwright waits for its close button.
      if (await this.sheet().isVisible()) throw error
    }
    await expect(this.sheet()).not.toBeVisible()
  }

  /** Asserts which step the sheet is standing on, by the step bar's accessible name. */
  async expectStep(stepName: string): Promise<void> {
    await expect(this.stepBar()).toHaveAccessibleName(stepName, { timeout: 20_000 })
  }
}
