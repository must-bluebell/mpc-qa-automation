import { expect, type Locator, type Page } from '@playwright/test'
import { addressChipName, copy } from './copy'

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
    return this.page.getByRole('main', { name: 'Home', exact: true }).getByRole('button', { name: copy.landing.join, exact: true })
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
    return this.sheet().getByRole('button', { name: copy.join.switchChain })
  }

  /** JoinFlow renders failure copy as `role="alert"`. */
  error(): Locator {
    return this.sheet().getByRole('alert')
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    const consent = this.page.getByRole('dialog', { name: 'Audience measurement choice', exact: true })
    const needsChoice = await consent.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)
    if (needsChoice) await consent.getByRole('button', { name: 'Reject', exact: true }).click()
    await this.cta().click()
    await expect(this.sheet()).toBeVisible()
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

  /** Asserts which step the sheet is standing on, by the step bar's accessible name. */
  async expectStep(stepName: string): Promise<void> {
    await expect(this.stepBar()).toHaveAccessibleName(stepName, { timeout: 20_000 })
  }
}
