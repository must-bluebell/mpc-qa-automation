import { expectValidationMessage } from '../../fixtures/validation-messages'
import { expect, test } from '@playwright/test'
import { chainName, target } from '../../config/target'
import { stubAnalytics } from '../../fixtures/network'
import { capabilities } from '../../fixtures/tiers'
import { injectTestWallet, setWalletFailure, type WalletFailure } from '../../fixtures/wallet'
import { copy, switchCopy } from '../../pages/copy'
import { JoinSheet } from '../../pages/JoinSheet'
import { getConfiguredWallet } from '../../utils/wallet-generator'

const t = target()
const CHAIN = chainName(t)

/**
 * T1f — the failure table.
 *
 * `JoinFlow` maps every wallet failure through a 3×5 table (`failureTextOf`: connect / sign /
 * switch × rejected / pending / no_wallet / locked / unknown), and each cell exists because the
 * user's next action differs. The table's own comment records why it was built: an earlier version
 * collapsed everything that was not a rejection into "wallet not found, install it and refresh",
 * which **sent people whose wallet was fine off to reinstall it**.
 *
 * 🔴 A mock is the only thing that can check this. Driving all fifteen cells with a real wallet
 *    would mean reproducing a locked extension, a stuck pending request and a failed network switch
 *    on demand. Here each is one error object.
 */

const ERROR_CASE_NAMES: Record<WalletFailure, string> = {
  rejected: 'rejected request',
  pending: 'pending request',
  locked: 'locked wallet',
  no_wallet: 'unavailable wallet',
  unknown: 'unexpected wallet error',
}
const ERROR_CASE_ORDER: WalletFailure[] = ['rejected', 'pending', 'locked', 'no_wallet', 'unknown']
const errorCaseName = (start: number, action: string, failure: WalletFailure): string =>
  `W${String(start + ERROR_CASE_ORDER.indexOf(failure)).padStart(2, '0')} - ${action}: ${ERROR_CASE_NAMES[failure]}`

type Cell = { failure: WalletFailure; expected: string }

/**
 * Connect axis. 🔴 `no_wallet` expects the **WalletConnect** wording, not `failNoWallet`:
 * `connectFailureText` substitutes it whenever a fallback connector exists, and one always does.
 * (JoinFlow.tsx:634)
 */
const CONNECT_CELLS: Cell[] = [
  { failure: 'rejected', expected: copy.join.failRejected },
  { failure: 'pending', expected: copy.join.failPending },
  { failure: 'locked', expected: copy.join.failLocked },
  { failure: 'no_wallet', expected: copy.join.failNoWalletWithWc },
  { failure: 'unknown', expected: copy.join.failUnknown },
]

/** Sign axis. Both `no_wallet` and `unknown` fold into one sentence — deliberately, per the table. */
const SIGN_CELLS: Cell[] = [
  { failure: 'rejected', expected: copy.join.signRejected },
  { failure: 'pending', expected: copy.join.failPending },
  { failure: 'locked', expected: copy.join.failLocked },
  { failure: 'no_wallet', expected: copy.join.signFailed },
  { failure: 'unknown', expected: copy.join.signFailed },
]

/** Switch axis. Two cells interpolate the chain's display name. */
const SWITCH_CELLS: Cell[] = [
  { failure: 'rejected', expected: switchCopy.switchRejected(CHAIN) },
  { failure: 'pending', expected: copy.join.failPending },
  { failure: 'locked', expected: copy.join.failLocked },
  { failure: 'no_wallet', expected: switchCopy.wrongChain(CHAIN) },
  { failure: 'unknown', expected: switchCopy.wrongChain(CHAIN) },
]

/** A chain the app is not built for, so the flow is forced down the switch path. */
const WRONG_CHAIN = 1

test.describe('Wallet connection errors', { tag: ['@ui', '@feature-wallet', '@critical', '@regression', '@WALLET-01'] }, () => {
  test.skip(() => !process.env.QA_SEED_PHRASE, 'QA_SEED_PHRASE is not set')

  test('W25 - Recover from a failed connection without reloading', async ({ page }) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(), chainId: t.chainId,
      failOn: { eth_requestAccounts: 'rejected', personal_sign: 'rejected' },
    })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)
    await expectValidationMessage(sheet.error(), copy.join.failRejected, 'connection-cancelled')
    await sheet.expectStep(copy.join.stepWallet)
    await setWalletFailure(page, 'eth_requestAccounts', null)
    await sheet.connectWith(wallet.walletName)
    await sheet.expectStep(copy.join.stepSign)
    await expect(sheet.addressChip(wallet.address)).toBeVisible()
    await expectValidationMessage(sheet.error(), copy.join.signRejected, 'signature-cancelled-after-reconnection')
  })

  test('W26 - Repeated connection failures never create a signed-in session', async ({ page }) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(), chainId: t.chainId, failOn: { eth_requestAccounts: 'rejected' },
    })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    for (let attempt = 0; attempt < 2; attempt++) {
      await sheet.connectWith(wallet.walletName)
      await expectValidationMessage(sheet.error(), copy.join.failRejected, 'connection-cancelled')
      await sheet.expectStep(copy.join.stepWallet)
    }
    const session = await page.request.get('/api/auth/session')
    expect(session.status()).toBe(200)
    expect((await session.json()).address).toBeNull()
  })

  for (const { failure, expected } of CONNECT_CELLS) {
    test(errorCaseName(4, 'Explain failed wallet connection', failure), async ({ page }, testInfo) => {
      await stubAnalytics(page)
      const wallet = await injectTestWallet(page, {
        account: getConfiguredWallet(),
        chainId: t.chainId,
        failOn: { eth_requestAccounts: failure },
      })

      await page.goto('/')
      const sheet = new JoinSheet(page)
      await sheet.open()
      await sheet.connectWith(wallet.walletName)

      await expectValidationMessage(sheet.error(), expected, `${failure}-wallet-error`)
      // The flow must not advance on a failed connect.
      await sheet.expectStep(copy.join.stepWallet)
    })
  }
})

/**
 * The switch axis belongs to the **explicit** "Switch network" button (`onSwitchChain`), and that
 * button only exists after an automatic switch has already failed:
 * `needsSwitch = (switchAttemptFailed || activeLeavesTheBrowser) && isConnected && walletChainId !== CHAIN.id`
 * (JoinFlow.tsx:441). So each test here fails the switch twice — once to raise the button, then
 * again with the reason under test.
 */
test.describe('Wallet network errors', { tag: ['@ui', '@feature-wallet', '@critical', '@regression', '@WALLET-01'] }, () => {
  test.skip(() => !process.env.QA_SEED_PHRASE, 'QA_SEED_PHRASE is not set')

  for (const { failure, expected } of SWITCH_CELLS) {
    test(errorCaseName(9, 'Explain failed network switch', failure), async ({ page }, testInfo) => {
      await stubAnalytics(page)
      // Connect on a chain the app is not built for. The automatic switch attempt then fails,
      // which is what raises the explicit button. All of this happens before any server call.
      const wallet = await injectTestWallet(page, {
        account: getConfiguredWallet(),
        chainId: WRONG_CHAIN,
        failOn: { wallet_switchEthereumChain: 'unknown' },
      })

      await page.goto('/')
      const sheet = new JoinSheet(page)
      await sheet.open()
      await sheet.connectWith(wallet.walletName)

      await expect(sheet.switchChainButton()).toBeVisible()

      // Now fail it for the reason actually under test.
      await setWalletFailure(page, 'wallet_switchEthereumChain', failure)
      await sheet.switchChainButton().click()

      await expectValidationMessage(sheet.error(), expected, `${failure}-wallet-error`)
    })
  }
})

test.describe('Wallet connection network cancellation', { tag: ['@ui', '@feature-wallet', '@critical', '@regression', '@WALLET-01'] }, () => {
  test.skip(() => !process.env.QA_SEED_PHRASE, 'QA_SEED_PHRASE is not set')

  /**
   * 🔴 **Locks in a behaviour worth knowing about, not an ideal one.** When the user rejects the
   *    network switch that wagmi performs *inside* `connect`, the rejection surfaces on the
   *    **connect** axis, so the user is told "the request was cancelled" rather than the switch
   *    axis's more useful "signing is only possible on {chain}". The specific sentence
   *    `switchRejected` was written for this situation and is not what appears here.
   *
   *    The other four reasons do reach JoinFlow's own switch handler and produce switch-axis copy;
   *    only a 4001 rejection is intercepted this early. Worth raising with the app team — it is a
   *    copy-precision issue, not a functional break, so it is recorded rather than asserted as
   *    correct.
   */
  test('W14 - Show cancellation when network switching is rejected during connection', async ({ page }, testInfo) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: WRONG_CHAIN,
      failOn: { wallet_switchEthereumChain: 'rejected' },
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)

    await expectValidationMessage(sheet.error(), copy.join.failRejected, 'connection-cancelled')
  })
})

test.describe('Wallet signature errors', { tag: ['@ui', '@feature-wallet', '@critical', '@regression', '@WALLET-01'] }, () => {
  test.beforeEach(async () => {
    test.skip(!process.env.QA_SEED_PHRASE, 'QA_SEED_PHRASE is not set')
    // The signature axis is only reached after `/api/auth/nonce` succeeds, so it needs a target
    // that accepts writes from this origin.
    const caps = await capabilities()
    test.skip(!caps.sameOriginWrites, caps.reason ?? 'the target refuses writes from this origin')
  })

  for (const { failure, expected } of SIGN_CELLS) {
    test(errorCaseName(15, 'Explain failed message signing', failure), async ({ page }, testInfo) => {
      await stubAnalytics(page)
      const wallet = await injectTestWallet(page, {
        account: getConfiguredWallet(),
        chainId: t.chainId,
        failOn: { personal_sign: failure },
      })

      await page.goto('/')
      const sheet = new JoinSheet(page)
      await sheet.open()
      await sheet.connectWith(wallet.walletName)

      await expectValidationMessage(sheet.error(), expected, `${failure}-wallet-error`)
      // A failed signature holds the flow on the sign step, with a retry button.
      await sheet.expectStep(copy.join.stepSign)
    })
  }
})
