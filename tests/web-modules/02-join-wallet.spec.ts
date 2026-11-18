import { expect, test, todo, skipWhen, switchNetwork, freshAccount, COPY, CHAIN_NAME, connectWalletOnly, connectFresh, fetchNonce, siweMessage, verifySiwe, sessionAddress, watchErrors } from './fixtures'
import { JoinSheet } from '../../pages/JoinSheet'
import { target } from '../../config/target'
import { call, writesAllowed, requireWrites } from '../../fixtures/api'
import { stubAnalytics } from '../../fixtures/network'
import { injectTestWallet, setWalletFailure } from '../../fixtures/wallet'

/**
 * Connect, sign and wallet failures. Failure cases stop before any session is created, so they are
 * read-only. Cases that create a session are gated and run on the isolated stack.
 */

test.describe('Connect and sign-in', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('T1-01 - A wallet that announces itself is shown by its name, not "Injected"', async ({ page }) => {
    await injectTestWallet(page, { account: freshAccount(), chainId: target().chainId, walletName: 'Trust Wallet' })
    await stubAnalytics(page)
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await expect(sheet.walletRow('Trust Wallet')).toBeVisible()
    await expect(sheet.sheet().getByRole('button', { name: 'Injected', exact: true })).toHaveCount(0)
  })

  test('T1-03 - Reaching the sign step shows the connected address, read-only', async ({ page }) => {
    const wallet = await connectWalletOnly(page, { failOn: { personal_sign: 'rejected' } })
    const sheet = new JoinSheet(page)
    await sheet.expectStep('Sign')
    await expect(sheet.addressChip(wallet.address.toLowerCase())).toBeVisible()
  })

  test('T1-05 - With no wallet installed the sheet offers WalletConnect', async ({ page }) => {
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await expect(sheet.walletConnectRow()).toBeVisible()
  })

  test('T1-06 - The shown address matches the wallet account exactly (lowercase form)', async ({ page }) => {
    const wallet = await connectWalletOnly(page, { failOn: { personal_sign: 'rejected' } })
    const sheet = new JoinSheet(page)
    await sheet.expectStep('Sign')
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    await expect(sheet.addressChip(wallet.address.toLowerCase())).toBeVisible()
  })

  for (const chainId of [1, 204]) {
    test(`T1-08 - Wallet on chain ${chainId} is asked to switch to ${CHAIN_NAME()}`, async ({ page }) => {
      skipWhen(!writesAllowed(), 'The switch prompt is verified on the isolated stack only.')
      await connectWalletOnly(page, { chainId, failOn: { wallet_switchEthereumChain: 'unknown' } })
      await expect(switchNetwork(page)).toBeVisible({ timeout: 20_000 })
    })
  }

  test('T1-02 - Connect and sign create a session and move to Community (gated)', async ({ page, newcomer }) => {
    expect(await sessionAddress(page)).toBe(newcomer.address.toLowerCase())
    await new JoinSheet(page).expectStep('Community')
  })

  test('T1-09 - The sign message names the site and the network and carries a nonce (gated)', async ({ page }) => {
    requireWrites()
    const [verify] = await Promise.all([
      page.waitForRequest(req => new URL(req.url()).pathname === '/api/auth/verify' && req.method() === 'POST'),
      connectWalletOnly(page),
    ])
    const body = JSON.parse(verify.postData() ?? '{}') as { message?: string }
    const message = body.message ?? ''
    const origin = new URL(target().baseUrl)
    expect(message).toContain(origin.host)
    expect(message).toContain(`Chain ID: ${target().chainId}`)
    expect(message).toMatch(/Nonce: \S+/)
  })

  test('T1-10 - The same signed message cannot be used twice (gated)', async ({ request }, info) => {
    const account = freshAccount()
    const nonce = await fetchNonce(request, info)
    const message = await siweMessage(account, nonce)
    const signature = await account.signMessage({ message })
    expect((await verifySiwe(request, info, message, signature)).status).toBe(200)
    const replay = await verifySiwe(request, info, message, signature)
    expect(replay.status).toBe(401)
    expect(['nonce_replayed', 'nonce_missing']).toContain(replay.json?.error)
  })

  test('T1-11 - A signature from a different wallet is refused (gated)', async ({ request }, info) => {
    const owner = freshAccount()
    const stranger = freshAccount()
    const nonce = await fetchNonce(request, info)
    const message = await siweMessage(owner, nonce)
    const signature = await stranger.signMessage({ message })
    const res = await verifySiwe(request, info, message, signature)
    expect(res.status).toBe(401)
    const session = await call(request, info, 'GET', '/api/auth/session')
    expect(session.json?.address ?? null).toBeNull()
  })

  test('T1-13 - An edited domain in the message is refused (gated)', async ({ request }, info) => {
    const account = freshAccount()
    const nonce = await fetchNonce(request, info)
    const message = await siweMessage(account, nonce, { domain: 'evil.example' })
    const signature = await account.signMessage({ message })
    expect((await verifySiwe(request, info, message, signature)).status).toBe(401)
  })

  test('T1-14 - The session cookie is HttpOnly, SameSite and Secure on HTTPS (gated)', async ({ request }, info) => {
    const account = freshAccount()
    const nonce = await fetchNonce(request, info)
    const message = await siweMessage(account, nonce)
    const signature = await account.signMessage({ message })
    const res = await verifySiwe(request, info, message, signature)
    expect(res.status).toBe(200)
    const cookies = await request.storageState()
    const session = cookies.cookies.find(cookie => /^(?:__Host-)?mpc_session$/.test(cookie.name))
    expect(session).toBeDefined()
    expect(session?.httpOnly).toBe(true)
    expect(session?.sameSite).toBe('Lax')
    expect(session?.secure).toBe(new URL(target().baseUrl).protocol === 'https:')
  })

  test('T1-16 - Refreshing while the sign-in is pending keeps the sheet on its step', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { personal_sign: 'pending' } })
    await page.reload()
    await expect(new JoinSheet(page).sheet()).toBeVisible()
    expect(await sessionAddress(page)).toBeNull()
  })

  todo('T1-04', 'A wallet with no name is not listed', 'Covered by the unit test for visibleInjectedWallets in the app repo (JoinFlow.test.ts); needs an unnamed provider, which the mock wallet cannot produce.')
  todo('T1-07', 'Switching the account in the wallet mid-sheet is followed', 'Manual by design (M-27): needs two accounts switched inside the wallet UI.')
  todo('T1-12', 'A signed message older than its TTL is refused', 'Needs the nonce TTL to elapse; the TTL constant is not in the source tree to set a shorter value.')
  todo('T1-15', 'Disconnect ends the session and a protected deep link asks to sign in', 'Covered in the member flow (member context). See 04-sbt-checkin-quests.spec.ts.')
})

test.describe('Wallet failure messages', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    // The wallet error alert does not render on production with the mock wallet; the existing
    // tests/wallet/wallet-errors.spec.ts fails the same way there. These run on the isolated stack.
    skipWhen(!writesAllowed(), 'Wallet failure alerts are verified on the isolated stack only.')
    await stubAnalytics(page)
  })

  test('T1F-01 - Rejected connect says the request was cancelled', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { eth_requestAccounts: 'rejected' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.rejected)
  })

  test('T1F-02 - Connect while a wallet request is open says a request is waiting', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { eth_requestAccounts: 'pending' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.pending)
  })

  test('T1F-03 - Connect with a locked wallet asks the user to unlock it', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { eth_requestAccounts: 'locked' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.locked)
  })

  test('T1F-04 - Connect with no wallet offers WalletConnect', async ({ page }) => {
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await expect(sheet.walletConnectRow()).toBeVisible()
  })

  test('T1F-05 - An unknown connect failure shows a plain sentence', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { eth_requestAccounts: 'unknown' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.connectUnknown)
  })

  test('T1F-06 - Rejected signature says the signature was not completed (wording gap G2)', async ({ page }) => {
    // Plan says "declined"; the app says "cancelled". Accept either until the wording is decided.
    await connectWalletOnly(page, { failOn: { personal_sign: 'rejected' } })
    await expect(new JoinSheet(page).error()).toContainText(/cancelled|declined/i)
  })

  test('T1F-07 - Signing while a wallet request is open says a request is waiting', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { personal_sign: 'pending' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.pending)
  })

  test('T1F-08 - Signing with a locked wallet asks the user to unlock it', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { personal_sign: 'locked' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.locked)
  })

  test('T1F-09 - Signing with no wallet says signing failed', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { personal_sign: 'no_wallet' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.signUnavailable)
  })

  test('T1F-10 - An unknown signing failure says signing failed', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { personal_sign: 'unknown' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.signFailed)
  })

  test('T1F-11 - Rejected network switch names the network needed', async ({ page }) => {
    await connectWalletOnly(page, { chainId: 1, failOn: { wallet_switchEthereumChain: 'unknown' } })
    await expect(switchNetwork(page)).toBeVisible()
    await setWalletFailure(page, 'wallet_switchEthereumChain', 'rejected')
    await switchNetwork(page).click()
    await expect(new JoinSheet(page).error()).toContainText(COPY.switchRejected(CHAIN_NAME()))
  })

  test('T1F-12 - Switching while a wallet request is open says a request is waiting', async ({ page }) => {
    await connectWalletOnly(page, { chainId: 1, failOn: { wallet_switchEthereumChain: 'pending' } })
    await switchNetwork(page).click()
    await expect(new JoinSheet(page).error()).toContainText(COPY.pending)
  })

  test('T1F-13 - Switching with a locked wallet asks the user to unlock it', async ({ page }) => {
    await connectWalletOnly(page, { chainId: 1, failOn: { wallet_switchEthereumChain: 'locked' } })
    await switchNetwork(page).click()
    await expect(new JoinSheet(page).error()).toContainText(COPY.locked)
  })

  test('T1F-14 - Switching with no wallet shows a plain error (wording gap G1)', async ({ page }) => {
    // Known gap G1: the app shows the wrong-network copy here. Expected to fail until fixed.
    test.fail(true, 'G1: switch-no-wallet currently shows the wrong-network message')
    await connectWalletOnly(page, { chainId: 1, failOn: { wallet_switchEthereumChain: 'no_wallet' } })
    await switchNetwork(page).click()
    await expect(new JoinSheet(page).error()).not.toContainText(COPY.wrongChain(CHAIN_NAME()))
    await expect(new JoinSheet(page).error()).not.toBeEmpty()
  })

  test('T1F-15 - An unknown switch failure shows a plain error (wording gap G1)', async ({ page }) => {
    test.fail(true, 'G1: switch-unknown currently shows the wrong-network message')
    await connectWalletOnly(page, { chainId: 1, failOn: { wallet_switchEthereumChain: 'unknown' } })
    await switchNetwork(page).click()
    await expect(new JoinSheet(page).error()).not.toContainText(COPY.wrongChain(CHAIN_NAME()))
  })

  test('T1F-16 - A switch rejected during connect is reported as a connect cancellation', async ({ page }) => {
    await connectWalletOnly(page, { chainId: 1, failOn: { wallet_switchEthereumChain: 'rejected' } })
    await expect(new JoinSheet(page).error()).toContainText(COPY.rejected)
  })

  test('T1F-17 - No failure message shows a raw error code', async ({ page }) => {
    await connectWalletOnly(page, { failOn: { eth_requestAccounts: 'rejected' } })
    const text = await new JoinSheet(page).sheet().innerText()
    expect(text).not.toMatch(/\b(4001|4100|4200|4900|4901|-32002|-32603)\b|\bEIP-\d+/)
  })
})

test.describe('Wallet switch and account handling', { tag: ['@ui', '@web-module'] }, () => {
  todo('UI-08', 'Account switch mid-action clears previous account data and closes confirmation modals', 'Needs the mock wallet to change account while a modal is open; the mock exposes no account-change hook yet.')
})
