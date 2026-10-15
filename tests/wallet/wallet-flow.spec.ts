import { expectValidationMessage } from '../../fixtures/validation-messages'
import { validationCopy } from '../../pages/validation-copy'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { decodeEventLog, parseAbiItem } from 'viem'
import { parseSiweMessage } from 'viem/siwe'
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
    const nonceResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/nonce' && r.request().method() === 'POST')
    const verifyRequest = page.waitForRequest(r => new URL(r.url()).pathname === '/api/auth/verify' && r.method() === 'POST')
    await sheet.connectWith(wallet.walletName)

    const nonce = await (await nonceResponse).json()
    const message = parseSiweMessage((await verifyRequest).postDataJSON().message)
    const origin = new URL(t.baseUrl)
    expect(message.address?.toLowerCase()).toBe(wallet.address.toLowerCase())
    expect(message.domain).toBe(origin.host)
    expect(message.uri).toBe(origin.origin)
    expect(message.version).toBe('1')
    expect(message.chainId).toBe(t.chainId)
    expect(message.nonce).toBe(nonce.nonce)
    expect(message.issuedAt?.getTime()).toBeLessThanOrEqual(Date.now())
    expect(message.expirationTime?.getTime()).toBeGreaterThan(Date.now())
    if (origin.hostname === 'app.globalmpc.tech') expect(message.statement).toBe('MPC Unity sign-in')

    await expect.poll(async () => {
      const response = await page.request.get('/api/auth/session', { maxRetries: 2 })
      if (!response.ok()) return null
      return (await response.json()).address
    }, { timeout: 60_000 }).toBe(wallet.address.toLowerCase())

    const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
    expect(session.ok(), 'GET /api/auth/session should succeed').toBe(true)
    expect((await session.json()).address).toBe(wallet.address.toLowerCase())

    await openMining(page)
    if (origin.hostname === 'app.globalmpc.tech') {
      await expect(page).toHaveURL('https://app.globalmpc.tech/?view=dig')
    }
    // Intentional viewing pause after the connected Digging screen is ready.
    await page.waitForTimeout(10_000)
    const connectedSession = await page.request.get('/api/auth/session', { maxRetries: 2 })
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
    await expectValidationMessage(sheet.error(), copy.join.signRejected, 'signature-cancelled')
    await setWalletFailure(page, 'personal_sign', null)
    await sheet.signInButton().click()
    await expect.poll(async () => {
      const response = await page.request.get('/api/auth/session', { maxRetries: 2 })
      if (!response.ok()) return null
      return (await response.json()).address
    }, { timeout: 60_000 }).toBe(wallet.address.toLowerCase())
    await expect(sheet.error()).not.toBeVisible()

    await openMining(page)
    // Intentional viewing pause after the connected Digging screen is ready.
    await page.waitForTimeout(10_000)

  })
})

// These cases exercise the live app with an injected Trust Wallet provider and real SIWE signing.
// They do not automate the native Trust Wallet extension's permission dialogs.
test.describe('Unity sign-in cases', { tag: ['@ui', '@unity-signin'] }, () => {
  test.beforeEach(async () => {
    expect(process.env.QA_SEED_PHRASE, 'A configured signing wallet is required').toBeTruthy()
  })

  test('Positive 1 - Sign in with Trust Wallet and access Digging', async ({ page }) => {
    const verification = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/verify' && r.request().method() === 'POST')
    const wallet = await connectConfiguredWallet(page)
    const response = await verification
    expect(response.ok()).toBe(true)
    const message = parseSiweMessage(response.request().postDataJSON().message)
    expect(message.address?.toLowerCase()).toBe(wallet.address.toLowerCase())
    expect(message.domain).toBe(new URL(t.baseUrl).host)
    expect(message.uri).toBe(new URL(t.baseUrl).origin)
    expect(message.chainId).toBe(t.chainId)
    expect(message.nonce).toBeTruthy()
    expect(message.expirationTime?.getTime()).toBeGreaterThan(Date.now())
    await expect(page).toHaveURL(new URL('/?view=dig', t.baseUrl).href)
    await expect(page.getByRole('button', { name: 'Open user account', exact: true })).toBeVisible()
  })

  test('Positive 2 - Keep the authenticated Digging session after refresh', async ({ page }) => {
    const wallet = await connectConfiguredWallet(page)
    await page.reload()
    await expect(page).toHaveURL(new URL('/?view=dig', t.baseUrl).href)
    await expect(page.getByRole('button', { name: 'Open user account', exact: true })).toBeVisible()
    const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
    expect(session.status()).toBe(200)
    expect((await session.json()).address).toBe(wallet.address.toLowerCase())
  })

  test('Negative 1 - Reject wallet connection without creating a session', async ({ page }) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(), chainId: t.chainId,
      failOn: { eth_requestAccounts: 'rejected' },
    })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)
    await expectValidationMessage(sheet.error(), copy.join.failRejected, 'connection-cancelled')
    await sheet.expectStep(copy.join.stepWallet)
    const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
    expect(session.status()).toBe(200)
    expect((await session.json()).address).toBeNull()
  })

  test('Negative 2 - Reject the sign-in signature without creating a session', async ({ page }) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(), chainId: t.chainId,
      failOn: { personal_sign: 'rejected' },
    })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)
    await expectValidationMessage(sheet.error(), copy.join.signRejected, 'signature-cancelled')
    await sheet.expectStep(copy.join.stepSign)
    await expect(sheet.addressChip(wallet.address)).toBeVisible()
    await expect(sheet.signInButton()).toBeEnabled()
    const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
    expect(session.status()).toBe(200)
    expect((await session.json()).address).toBeNull()
  })
})

test('W30 - Complete or verify the Silicon digging and cart journey', { tag: ['@ui', '@silicon-cart'] }, async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  // Real production activity: no retries, balance funding, or mocked mining/relay responses.
  const signed: Array<{ message: Record<string, unknown>; domain: unknown }> = []
  let digsToPerform = 3
  let alreadyRecorded = false
  let restoreRunResponse: import('@playwright/test').Response | undefined
  let rejectCartSignature!: (error: unknown) => void
  const rejectedCartSignature = new Promise<never>((_resolve, reject) => { rejectCartSignature = reject })
  void rejectedCartSignature.catch(() => {})
  let preparation: Promise<import('@playwright/test').Response> | undefined
  await stubAnalytics(page)
  const wallet = await injectTestWallet(page, {
    account: getConfiguredWallet(), chainId: t.chainId,
    beforeSignTypedData: async payload => {
      try {
        expect(new URL(page.url()).origin).toBe('https://app.globalmpc.tech')
        expect(payload.primaryType).toBe('RecordFor')
        expect(payload.domain?.name).toBe('MpcMyMine')
        expect(payload.domain?.version).toBe('3')
        expect(Number(payload.domain?.chainId)).toBe(204)
        expect(payload.domain?.verifyingContract?.toLowerCase()).toMatch(/^0x80ca[0-9a-f]{30}5a7e5d$/)
        expect(preparation, 'The signature must match this cart preparation').toBeDefined()
        const preparedResponse = await preparation!
        expect(preparedResponse.ok()).toBe(true)
        const prepared = await preparedResponse.json()
        expect(payload).toMatchObject(prepared.typedData)
        expect(Object.keys(payload.types).sort()).toEqual([...new Set([...Object.keys(prepared.typedData.types), 'EIP712Domain'])].sort())
        const message = payload.message as Record<string, unknown>
        expect(String(message.user).toLowerCase()).toBe(wallet.address.toLowerCase())
        expect(String(message.submitter)).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(String(message.submitter).toLowerCase()).not.toBe('0x0000000000000000000000000000000000000000')
        expect(message.challenge).toMatch(/^0x[0-9a-fA-F]{64}$/)
        expect(message.dataHash).toMatch(/^0x[0-9a-fA-F]{64}$/)
        expect(Number(message.day)).toBe(Math.floor(Date.now() / 86_400_000))
        expect(Number(message.kind)).toBe(0)
        expect(Number(message.count)).toBeGreaterThan(0)
        expect(Number(message.energyUsed)).toBeGreaterThanOrEqual(9)
        expect(Number(message.creditEarned)).toBe(0)
        expect(Number(message.creditSpent)).toBe(0)
        expect(message.goodsIds).toEqual([])
        expect(message.goodsMadeTo).toEqual([])
        expect(message.goodsBurnedTo).toEqual([])
        expect(Number(message.deadline)).toBeGreaterThan(Date.now() / 1000)
        // Fresh count, energy, hashes and deadline come from this run, never the recorded example.
        signed.push({ message, domain: payload.domain })
        await testInfo.attach('verified-RecordFor-signature-request', {
          body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json',
        })
      } catch (error) {
        rejectCartSignature(error)
        throw error
      }
    },
  })
  await test.step('Connect the requested wallet and open Digging', async () => {
    expect(wallet.address.toLowerCase()).toBe('0xe46d2a8c9ae04517373b8c9c468dfa5db2d381df')
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)
    await expect.poll(async () => {
      const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
      return session.ok() ? (await session.json()).address : null
    }).toBe(wallet.address.toLowerCase())
    const restoration = page.waitForResponse(r => new URL(r.url()).pathname === '/my-mine/run' && r.request().method() === 'GET' && r.ok(), { timeout: 60_000 })
    await openMining(page)
    restoreRunResponse = await restoration
    await expect(page.getByText('Syncing today’s activity… You can still browse your mine.', { exact: true }).first()).not.toBeVisible({ timeout: 60_000 })
  })

  const dig = page.getByRole('button', { name: 'Tap the ore to dig', exact: true })
  await test.step('Verify mining prerequisites and select Silicon', async () => {
    await new JoinSheet(page).dismissIfOpen()
    await expect(dig).toBeVisible()
    expect(restoreRunResponse, 'Use the app’s successful, versioned run restoration').toBeDefined()
    const run = await restoreRunResponse!.json()
    await testInfo.attach('cart-resume-state', { body: Buffer.from(JSON.stringify(run)), contentType: 'application/json' })
    expect(Array.isArray(run.script), 'The real saved run must supply mining history').toBe(true)
    expect(Array.isArray(run.records)).toBe(true)
    const records = run.records as Array<{ index: number; state: string; txHash: string; digCount: number }>
    const lastCart = Math.max(-1, ...run.script.map((move: { t: string }, index: number) => move.t === 'settle' && records.some(row => row.index === index && ['confirmed', 'included'].includes(row.state)) ? index : -1))
    const pendingDigs = run.script.slice(lastCart + 1).reduce((count: number, move: { t: string; draws?: unknown[] }) => count + (move.t === 'mine' ? move.draws?.length ?? 0 : 0), 0)
    digsToPerform = Math.max(0, 3 - pendingDigs)
    await testInfo.attach('dig-batch-plan', { body: Buffer.from(JSON.stringify({ targetDigs: 3, pendingDigs, digsToPerform, requiredCrew: digsToPerform * 3 })), contentType: 'application/json' })
    if (pendingDigs > 0) testInfo.annotations.push({ type: 'resumed-cart', description: `Resuming ${pendingDigs} existing digs; execute ${digsToPerform} more before recording the cart.` })
    const snapshot = await page.locator('body').innerText()
    await testInfo.attach('mining-prerequisites', { body: Buffer.from(snapshot), contentType: 'text/plain' })
    await page.screenshot({ path: testInfo.outputPath('mining-prerequisites.png'), fullPage: true })
    if (pendingDigs === 0 && !await dig.isEnabled() && snapshot.includes(validationCopy.cartRunsUsed)) {
      const lastRecord = records.find(row => row.index === lastCart)
      expect(lastRecord, 'A completed batch must have a confirmed owner-scoped cart record').toBeDefined()
      expect(lastRecord!.digCount).toBeGreaterThanOrEqual(3)
      expect(lastRecord!.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/)
      const receiptResponse = await page.request.post('https://opbnb-mainnet-rpc.bnbchain.org', {
        data: { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [lastRecord!.txHash] },
      })
      expect(receiptResponse.ok()).toBe(true)
      const receipt = (await receiptResponse.json()).result
      expect(receipt.transactionHash).toBe(lastRecord!.txHash)
      expect(receipt.status).toBe('0x1')
      expect(receipt.to.toLowerCase()).toBe('0x80ca104d4dc59d42862b801792abb1909f5a7e5d')
      await expectValidationMessage(page.getByText(validationCopy.emptyCartHint, { exact: true }), validationCopy.emptyCartHint, 'completed-cart-empty')
      await expectValidationMessage(page.locator(`[id=${JSON.stringify(await dig.getAttribute('aria-describedby'))}]`), validationCopy.cartRunsUsed, 'cart-daily-limit')
      await expect(page.getByRole('button', { name: 'Send the cart', exact: true })).toBeDisabled()
      alreadyRecorded = true
      digsToPerform = 0
      testInfo.annotations.push({ type: 'coverage', description: 'Completed cart and receipt verified; no new digs, signature, or cart submission in this run.' })
      await testInfo.attach('completed-cart-verification', { body: Buffer.from(JSON.stringify({ freshDigsExecuted: 0, freshCartSubmitted: false, record: lastRecord, receipt })), contentType: 'application/json' })
      return
    }
    if (digsToPerform > 0 && !await dig.isEnabled()) {
      const reasonId = await dig.getAttribute('aria-describedby')
      expect(reasonId, 'Disabled digging must explain why it is unavailable').toBeTruthy()
      if (Number(snapshot.match(/Crew available\s+([\d,]+)\s+Crew/)?.[1]?.replaceAll(',', '')) < 3) {
        await expectValidationMessage(page.locator(`[id=${JSON.stringify(reasonId)}]`), validationCopy.insufficientCrew, 'insufficient-crew')
      }
      testInfo.annotations.push({ type: 'blocked', description: 'Digging is disabled for the connected wallet. See mining-prerequisites for Crew and daily limits.' })
    }
    if (snapshot.includes(validationCopy.emptyCartHint)) {
      await expectValidationMessage(page.getByText(validationCopy.emptyCartHint, { exact: true }), validationCopy.emptyCartHint, 'empty-cart-hint')
      await expectValidationMessage(page.getByText(validationCopy.emptyCart, { exact: true }), validationCopy.emptyCart, 'empty-cart-reason')
    }
    if (digsToPerform > 0) await expect(dig).toBeEnabled()
    const crew = Number(snapshot.match(/Crew available\s+([\d,]+)\s+Crew/)?.[1]?.replaceAll(',', ''))
    const digsLeft = Number(snapshot.match(/Digs left today\s+(\d+)\s*\//)?.[1])
    expect(crew, 'Enough Crew must be available for the remaining digs').toBeGreaterThanOrEqual(digsToPerform * 3)
    expect(digsLeft, 'The remaining batch must fit the daily dig allowance').toBeGreaterThanOrEqual(digsToPerform)
    const silicon = page.getByRole('button', { name: /^Silicon · / })
    if (await silicon.isEnabled()) await silicon.click()
    await expect(silicon).toHaveAttribute('aria-pressed', 'true')
  })

  if (alreadyRecorded) {
    expect(signed).toHaveLength(0)
    return
  }

  for (let attempt = 1; attempt <= digsToPerform; attempt++) {
    await test.step(`Dig ${attempt}: verify the result modal and close it`, async () => {
      await expect(dig).toBeEnabled()
      await dig.click()
      const modal = page.getByRole('dialog').filter({ visible: true })
      await expect(modal).toHaveCount(1)
      await expectValidationMessage(modal.getByText(/^(Silica|Lithium ore|Rare earth ore)$/), /^(Silica|Lithium ore|Rare earth ore)$/, `dig-${attempt}-ore-name`)
      for (const [name, expected] of Object.entries({ fresh: validationCopy.justDug, chance: validationCopy.miningChance, reward: validationCopy.registerReward, duration: validationCopy.creditDuration })) {
        await expectValidationMessage(modal.getByText(expected, { exact: true }), expected, `dig-${attempt}-${name}`)
      }
      await expectValidationMessage(modal.getByRole('button', { name: 'Close', exact: true }), 'Close', `dig-${attempt}-close-action`)
      await testInfo.attach(`dig-${attempt}-modal-text`, { body: Buffer.from(await modal.innerText()), contentType: 'text/plain' })
      await page.screenshot({ path: testInfo.outputPath(`dig-${attempt}-modal.png`), fullPage: true })
      await modal.getByRole('button', { name: /^(Close|Done|OK)$/ }).click()
      await expect(modal).not.toBeVisible()
    })
  }

  await test.step('Send the cart, verify and approve the RecordFor signature', async () => {
    const cart = page.getByRole('button', { name: 'Send the cart', exact: true })
    await expect(cart).toBeEnabled()
    await expectValidationMessage(page.getByText(validationCopy.cartRecordHint, { exact: true }), validationCopy.cartRecordHint, 'cart-recording-instructions')
    preparation = page.waitForResponse(r => new URL(r.url()).pathname === '/my-mine/record' && r.request().method() === 'POST', { timeout: 60_000 })
    const submission = page.waitForResponse(r => new URL(r.url()).pathname === '/my-mine/record/submit' && r.request().method() === 'POST', { timeout: 90_000 })
    await cart.click()
    const response = await Promise.race([submission, rejectedCartSignature])
    expect(response.ok(), 'The real relay must accept the signed cart').toBe(true)
    expect(signed).toHaveLength(1)
    const result = await response.json()
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(['sent', 'included', 'confirmed']).toContain(result.state)
    await testInfo.attach('cart-relay-result', { body: Buffer.from(JSON.stringify(result)), contentType: 'application/json' })
    const moveIndex = response.request().postDataJSON().moveIndex
    const statusUrl = `/my-mine/run?record=${moveIndex}&dataHash=${signed[0]!.message.dataHash}`
    const cid = response.request().headers()['x-mpc-cid']
    await expect.poll(async () => {
      const status = await page.request.get(statusUrl, { headers: { ...(cid ? { 'x-mpc-cid': cid } : {}), ...(restoreRunResponse!.request().headers()['x-mpc-run-protocol'] ? { 'x-mpc-run-protocol': restoreRunResponse!.request().headers()['x-mpc-run-protocol']! } : {}) } })
      expect(status.ok()).toBe(true)
      const record = (await status.json()).records?.find((row: { index: number; dataHash: string }) => row.index === moveIndex && row.dataHash === signed[0]!.message.dataHash)
      return record && ['confirmed', 'included'].includes(record.state) && record.txHash === result.txHash
    }, { timeout: 120_000 }).toBe(true)
    // The exact signed record has confirmed above; verify the persistent result after delivery.
    const done = page.getByRole('button', { name: 'Done', exact: true })
    if (await done.isVisible()) await done.click()
    await expectValidationMessage(page.getByText(validationCopy.emptyCartHint, { exact: true }), validationCopy.emptyCartHint, 'recorded-cart-empty')
    await expect(cart).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('cart-recorded.png'), fullPage: true })
    await expect(page.getByRole('heading', { name: 'Digging', exact: true })).toBeVisible()
    const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
    expect((await session.json()).address).toBe(wallet.address.toLowerCase())
  })
})

test('W31 - Claim Daily check-in when available or verify today’s completed check-in', { tag: ['@ui', '@daily-checkin'] }, async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  let challengeResponse: Promise<import('@playwright/test').Response> | undefined
  let rejectSignature!: (error: unknown) => void
  const rejectedSignature = new Promise<never>((_resolve, reject) => { rejectSignature = reject })
  void rejectedSignature.catch(() => {})
  let signed = 0
  let reward = 0
  let baseReward = 0
  let day = 0
  await stubAnalytics(page)
  const wallet = await injectTestWallet(page, {
    account: getConfiguredWallet(), chainId: t.chainId,
    beforeSignTypedData: async payload => {
      try {
        expect(new URL(page.url()).origin).toBe('https://app.globalmpc.tech')
        expect(payload.primaryType).toBe('CheckInFor')
        expect(payload.domain?.name).toBe('MpcDailyCheckIn')
        expect(payload.domain?.version).toBe('3')
        expect(Number(payload.domain?.chainId)).toBe(204)
        expect(payload.domain?.verifyingContract?.toLowerCase()).toBe('0xbae9db4c257809cd23d660b6c0fe438130cdec8e')
        expect(challengeResponse, 'Only the requested daily check-in may be signed').toBeDefined()
        const prepared = await challengeResponse!
        expect(prepared.ok()).toBe(true)
        const body = await prepared.json()
        expect(prepared.request().postDataJSON().kind).toBe('checkin')
        expect(payload).toMatchObject(body.typedData)
        expect(Object.keys(payload.types).sort()).toEqual([...new Set([...Object.keys(body.typedData.types), 'EIP712Domain'])].sort())
        const message = payload.message as Record<string, unknown>
        expect(String(message.user).toLowerCase()).toBe(wallet.address.toLowerCase())
        expect(message.challenge).toBe(body.challenge)
        expect(message.challenge).toMatch(/^0x[0-9a-fA-F]{64}$/)
        expect(String(message.submitter)).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(String(message.submitter).toLowerCase()).not.toBe('0x0000000000000000000000000000000000000000')
        expect(Number(message.day)).toBe(day)
        expect(Number(message.deadline)).toBeGreaterThan(Date.now() / 1000)
        expect(Number(message.bonus)).toBeGreaterThanOrEqual(0)
        signed++
        expect(signed, 'Approve the check-in exactly once').toBe(1)
        await testInfo.attach('daily-checkin-signature-request', { body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json' })
      } catch (error) {
        rejectSignature(error)
        throw error
      }
    },
  })

  await test.step('Sign in and open Quests from Digging', async () => {
    expect(wallet.address.toLowerCase()).toBe('0xe46d2a8c9ae04517373b8c9c468dfa5db2d381df')
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)
    await expect.poll(async () => {
      const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
      return session.ok() ? (await session.json()).address : null
    }).toBe(wallet.address.toLowerCase())
    await openMining(page)
    await expect(page.getByText('Syncing today’s activity… You can still browse your mine.', { exact: true }).first()).not.toBeVisible({ timeout: 60_000 })
    const quests = page.getByRole('button', { name: /^Quests(?:\s*\d+)?$/ })
    const questsPanel = page.getByRole('dialog', { name: 'Quests', exact: true })
    // Opening this read-only panel can race the mine's initial restore. Never retry a claim.
    await expect(async () => {
      await new JoinSheet(page).dismissIfOpen()
      if (await quests.getAttribute('aria-expanded') !== 'true') {
        await expect(quests).toBeVisible()
        await expect(quests).toBeEnabled()
        // The floating control bobs continuously; verify its state before the pointer click.
        await quests.click({ force: true })
      }
      await expect(questsPanel).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 15_000 })
    await expectValidationMessage(questsPanel.getByText(validationCopy.questsIntro, { exact: true }), validationCopy.questsIntro, 'quests-instructions')
    await expect(page.getByText('Loading today’s check-in…', { exact: true }).filter({ visible: true })).not.toBeVisible({ timeout: 60_000 })
  })

  const daily = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Daily check-in', exact: true }) }).filter({ visible: true })
  const readBalance = async () => {
    const response = await page.request.get('/my-mine/energy')
    expect(response.ok()).toBe(true)
    const body = await response.json()
    expect(body.wallet).toBe(wallet.address.toLowerCase())
    expect(Number.isSafeInteger(body.balance)).toBe(true)
    return body.balance as number
  }
  let before = 0
  let alreadyClaimed = false
  await test.step('Verify today’s check-in eligibility and starting balance', async () => {
    const today = await page.request.get('/api/quiz/today')
    expect(today.ok()).toBe(true)
    const state = await today.json()
    day = state.day
    baseReward = state.baseEnergy
    if (state.checkedIn) {
      await page.getByRole('tab', { name: /^Completed(?:\s*\d+)?$/ }).click()
      await expectValidationMessage(daily.getByText(validationCopy.checkedIn, { exact: true }), validationCopy.checkedIn, 'already-checked-in')
      await expect(daily.getByRole('button', { name: validationCopy.completed, exact: true })).toBeDisabled()
      await expect(daily.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0)
      before = await readBalance()
      alreadyClaimed = true
      testInfo.annotations.push({ type: 'coverage', description: 'Already-claimed state verified; no fresh claim or reward increase is asserted in this run.' })
      await testInfo.attach('checkin-coverage', { body: Buffer.from(JSON.stringify({ day, freshClaimExecuted: false, state: 'already-claimed', balance: before })), contentType: 'application/json' })
      return
    }
    expect(state.checkedIn, 'Daily check-in must be unclaimed today').toBe(false)
    await expect(daily).toContainText('Crew')
    reward = Number((await daily.innerText()).match(/\+(\d+)/)?.[1])
    expect(reward).toBeGreaterThan(0)
    await expect(daily.getByRole('button', { name: 'Claim', exact: true })).toBeEnabled()
    before = await readBalance()
    await page.screenshot({ path: testInfo.outputPath('daily-checkin-before.png'), fullPage: true })
  })

  if (alreadyClaimed) {
    expect(signed).toBe(0)
    expect(await readBalance()).toBe(before)
    await page.screenshot({ path: testInfo.outputPath('daily-checkin-already-completed.png'), fullPage: true })
    await page.getByRole('button', { name: 'Close quests', exact: true }).click()
    return
  }

  await test.step('Claim once and confirm the verified wallet signature', async () => {
    challengeResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/relay/challenge' && r.request().method() === 'POST' && r.request().postDataJSON()?.kind === 'checkin', { timeout: 60_000 })
    const submission = page.waitForResponse(r => new URL(r.url()).pathname === '/api/relay/submit' && r.request().method() === 'POST', { timeout: 120_000 })
    await daily.getByRole('button', { name: 'Claim', exact: true }).click()
    const response = await Promise.race([submission, rejectedSignature])
    expect(response.ok(), 'Daily check-in relay must accept the signed claim').toBe(true)
    expect(signed).toBe(1)
    const result = await response.json()
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(['landed', 'included', 'sent']).toContain(result.state)
    await testInfo.attach('daily-checkin-relay-result', { body: Buffer.from(JSON.stringify(result)), contentType: 'application/json' })
  })

  await test.step('Verify the confirmed check-in and exact Crew credit', async () => {
    await expect.poll(async () => {
      const response = await page.request.get('/api/quiz/today')
      expect(response.ok()).toBe(true)
      const today = await response.json()
      expect(today.day).toBe(day)
      return today.checkedIn
    }, { timeout: 120_000 }).toBe(true)
    await expect.poll(readBalance, { timeout: 120_000 }).toBe(before + reward)
    const success = page.getByRole('dialog', { name: 'You have checked in today.', exact: true })
    await expectValidationMessage(success.getByText(validationCopy.checkedIn, { exact: true }), validationCopy.checkedIn, 'daily-checkin-success')
    await expectValidationMessage(success.getByText(validationCopy.earningToday(reward), { exact: true }), validationCopy.earningToday(reward), 'daily-checkin-reward')
    await expectValidationMessage(success.getByText(validationCopy.baseReward(baseReward), { exact: true }), validationCopy.baseReward(baseReward), 'daily-checkin-base-reward')
    await page.screenshot({ path: testInfo.outputPath('daily-checkin-success.png'), fullPage: true })
    await success.getByRole('button', { name: 'OK', exact: true }).click()
    await page.getByRole('tab', { name: /^Completed(?:\s*\d+)?$/ }).click()
    await expect(daily).toHaveAttribute('data-state', 'claimed')
    await expectValidationMessage(daily.getByText(validationCopy.checkedIn, { exact: true }), validationCopy.checkedIn, 'daily-checkin-completed')
    await expect(daily.getByRole('button', { name: validationCopy.completed, exact: true })).toBeDisabled()
    await testInfo.attach('daily-checkin-balance-change', { body: Buffer.from(JSON.stringify({ asset: 'Crew', chainId: 204, before, reward, after: await readBalance(), day })), contentType: 'application/json' })
    await page.screenshot({ path: testInfo.outputPath('daily-checkin-claimed.png'), fullPage: true })
    await page.getByRole('button', { name: 'Close quests', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Digging', exact: true })).toBeVisible()
  })
})


// Read-only follow-up for a daily claim that has already been submitted; never claims twice.
test('W32 - Verify a previously confirmed Daily check-in and its Crew credit', { tag: ['@ui', '@daily-checkin-verification'] }, async ({ page }, testInfo) => {
  test.skip(!process.env.QA_CHECKIN_EVIDENCE, 'Provide saved claim evidence to verify an existing daily claim')
  const evidence = JSON.parse(readFileSync(process.env.QA_CHECKIN_EVIDENCE!, 'utf8'))
  const wallet = await connectConfiguredWallet(page)
  expect(wallet.address.toLowerCase()).toBe(evidence.wallet)
  const today = await page.request.get('/api/quiz/today')
  expect(today.ok()).toBe(true)
  expect(await today.json()).toMatchObject({ day: evidence.day, checkedIn: true })
  const balance = await page.request.get('/my-mine/energy')
  expect(balance.ok()).toBe(true)
  const currentAccounting = await balance.json()
  expect(currentAccounting.wallet).toBe(evidence.wallet)
  expect(Number.isSafeInteger(currentAccounting.balance)).toBe(true)
  expect(currentAccounting.balance).toBeGreaterThanOrEqual(0)
  expect(evidence.after - evidence.before).toBe(evidence.reward)
  const status = await page.request.get(`/api/activities/${evidence.activityId}/status`)
  expect(status.ok()).toBe(true)
  const result = await status.json()
  expect(result).toMatchObject({ activityId: String(evidence.activityId), kind: 'daily_checkin', status: 'succeeded', finalized: true })
  const receiptResponse = await page.request.post('https://opbnb-mainnet-rpc.bnbchain.org', {
    data: { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [evidence.txHash] },
  })
  expect(receiptResponse.ok()).toBe(true)
  const receipt = (await receiptResponse.json()).result
  expect(receipt.transactionHash).toBe(evidence.txHash)
  expect(receipt.status).toBe('0x1')
  expect(receipt.to.toLowerCase()).toBe('0xbae9db4c257809cd23d660b6c0fe438130cdec8e')
  const eventLog = receipt.logs.find((log: { address: string }) => log.address.toLowerCase() === receipt.to.toLowerCase())
  expect(eventLog, 'The receipt must contain the check-in contract’s reward event').toBeDefined()
  const decoded = decodeEventLog({
    abi: [parseAbiItem('event CheckedIn(address indexed user, uint256 indexed day, address indexed submitter, uint256 baseAmount, uint256 bonusAmount, bytes32 challenge)')],
    data: eventLog.data, topics: eventLog.topics,
  })
  expect(decoded.args.user.toLowerCase()).toBe(evidence.wallet)
  expect(Number(decoded.args.day)).toBe(evidence.day)
  expect(Number(decoded.args.baseAmount + decoded.args.bonusAmount)).toBe(evidence.reward)
  await expect(page.getByText('Syncing today’s activity… You can still browse your mine.', { exact: true }).first()).not.toBeVisible({ timeout: 60_000 })
  const quests = page.getByRole('button', { name: /^Quests(?:\s*\d+)?$/ })
  const panel = page.getByRole('dialog', { name: 'Quests', exact: true })
  await expect(async () => {
    await new JoinSheet(page).dismissIfOpen()
    if (!await panel.isVisible()) {
      await expect(quests).toBeVisible()
      await quests.click({ force: true })
    }
    await expect(panel).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  await expectValidationMessage(panel.getByText(validationCopy.questsIntro, { exact: true }), validationCopy.questsIntro, 'quests-instructions')
  await panel.getByRole('tab', { name: /^Completed(?:\s*\d+)?$/ }).click()
  const daily = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Daily check-in', exact: true }) })
  await expect(daily).toHaveAttribute('data-state', 'claimed')
  await expect(daily).toContainText('Crew')
  await expectValidationMessage(daily.getByText(validationCopy.checkedIn, { exact: true }), validationCopy.checkedIn, 'already-checked-in')
  await expectValidationMessage(daily.getByRole('button', { name: validationCopy.completed, exact: true }), validationCopy.completed, 'completed-checkin-action')
  await expect(daily.getByRole('button', { name: validationCopy.completed, exact: true })).toBeDisabled()
  await expect(daily.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0)
  await testInfo.attach('confirmed-daily-checkin', { body: Buffer.from(JSON.stringify({ ...evidence, activityStatus: result, currentAccounting, receiptReward: Number(decoded.args.baseAmount + decoded.args.bonusAmount) })), contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath('daily-checkin-completed.png'), fullPage: true })
})

test.describe('Additional Unity coverage', { tag: ['@ui', '@unity-additional'] }, () => {
  async function openQuests(page: Page) {
    const panel = page.getByRole('dialog', { name: 'Quests', exact: true })
    const trigger = page.getByRole('button', { name: /^Quests(?:\s*\d+)?$/ })
    await expect(async () => {
      await new JoinSheet(page).dismissIfOpen()
      if (!await panel.isVisible()) {
        await expect(trigger).toBeVisible()
        await expect(trigger).toBeEnabled()
        // The floating button bobs continuously; its state is checked before clicking.
        await trigger.click({ force: true })
      }
      await expect(panel).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 15_000 })
    await expectValidationMessage(panel.getByText(validationCopy.questsIntro, { exact: true }), validationCopy.questsIntro, 'quests-instructions')
    return panel
  }

  async function readyMining(page: Page) {
    const wallet = await connectConfiguredWallet(page)
    await expect(page.getByText('Syncing today’s activity… You can still browse your mine.', { exact: true }).first()).not.toBeVisible({ timeout: 60_000 })
    return wallet
  }

  test('W33 - Positive: close and reopen Quests without losing the wallet session', async ({ page }) => {
    const wallet = await readyMining(page)
    const panel = await openQuests(page)
    await panel.getByRole('button', { name: 'Close quests', exact: true }).click()
    await expect(panel).not.toBeVisible()
    await expect(page).toHaveURL(new URL('/?view=dig', t.baseUrl).href)
    await openQuests(page)
    const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
    expect(session.status()).toBe(200)
    expect((await session.json()).address).toBe(wallet.address.toLowerCase())
  })

  test('W34 - Positive: switch between incomplete and completed quest lists', async ({ page }) => {
    await readyMining(page)
    const panel = await openQuests(page)
    const incomplete = panel.getByRole('tab', { name: /^Incomplete(?:\s*\d+)?$/ })
    const completed = panel.getByRole('tab', { name: /^Completed(?:\s*\d+)?$/ })
    await completed.click()
    await expect(completed).toHaveAttribute('aria-selected', 'true')
    await expect(incomplete).toHaveAttribute('aria-selected', 'false')
    const completedList = panel.getByRole('tabpanel', { name: /^Completed/ })
    await expect(completedList).toBeVisible()
    await expect(completedList.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0)
    const completedActions = completedList.getByRole('button', { name: validationCopy.completed, exact: true })
    await expect(completedActions.first()).toBeVisible()
    for (const action of await completedActions.all()) await expect(action).toBeDisabled()
    await incomplete.click()
    await expect(incomplete).toHaveAttribute('aria-selected', 'true')
    await expect(completed).toHaveAttribute('aria-selected', 'false')
    await expect(panel.getByRole('tabpanel', { name: /^Incomplete/ })).toBeVisible()
    await expect(panel.getByRole('tabpanel', { name: /^Incomplete/ }).getByRole('button', { name: validationCopy.completed, exact: true })).toHaveCount(0)
  })

  test('W35 - Positive: display the available Crew after accounting for pending usage', async ({ page }, testInfo) => {
    const wallet = await readyMining(page)
    const response = await page.request.get('/my-mine/energy')
    expect(response.ok()).toBe(true)
    const accounting = await response.json()
    expect(accounting.wallet).toBe(wallet.address.toLowerCase())
    for (const key of ['balance', 'outstanding', 'available']) {
      expect(Number.isSafeInteger(accounting[key]), `${key} must be an integer`).toBe(true)
      expect(accounting[key]).toBeGreaterThanOrEqual(0)
    }
    expect(accounting.available).toBe(Math.max(0, accounting.balance - accounting.outstanding))
    const crew = page.getByRole('status').filter({ hasText: 'Crew available' })
    await expectValidationMessage(crew, new RegExp(`^Crew available\\s+${accounting.available}\\s+Crew\\s*·\\s*\\d+ digs?$`), 'available-crew')
    await testInfo.attach('crew-accounting', { body: Buffer.from(JSON.stringify(accounting)), contentType: 'application/json' })
  })

  test('W36 - Positive: switch from Ethereum to the required chain before sign-in', async ({ page }) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, { account: getConfiguredWallet(), chainId: 1 })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    const verification = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/verify' && r.request().method() === 'POST')
    await sheet.connectWith(wallet.walletName)
    const response = await verification
    expect(response.ok()).toBe(true)
    expect(parseSiweMessage(response.request().postDataJSON().message).chainId).toBe(t.chainId)
    const chain = await page.evaluate(() => {
      const provider = (window as unknown as { ethereum: { request: (request: { method: string }) => Promise<string> } }).ethereum
      return provider.request({ method: 'eth_chainId' })
    })
    expect(chain).toBe(t.chainIdHex)
    await expect.poll(async () => (await (await page.request.get('/api/auth/session', { maxRetries: 2 })).json()).address).toBe(wallet.address.toLowerCase())
    await openMining(page)
  })

  async function expectRejectedVerification(page: Page, mode: 'wrong-signer' | 'expired', expectedError: string) {
    await stubAnalytics(page)
    const account = getConfiguredWallet()
    const wrongSigner = privateKeyToAccount(generatePrivateKey())
    const wallet = await injectTestWallet(page, { account, chainId: t.chainId })
    // Change only the outgoing request. The real server decides the response and session state.
    await page.route('**/api/auth/verify', async route => {
      const body = route.request().postDataJSON()
      if (mode === 'wrong-signer') {
        body.signature = await wrongSigner.signMessage({ message: body.message })
      } else {
        const issuedAt = new Date(Date.now() - 120_000).toISOString()
        const expiresAt = new Date(Date.now() - 60_000).toISOString()
        expect(body.message).toMatch(/^Expiration Time: .+$/m)
        body.message = body.message
          .replace(/^Issued At: .+$/m, `Issued At: ${issuedAt}`)
          .replace(/^Expiration Time: .+$/m, `Expiration Time: ${expiresAt}`)
        body.signature = await account.signMessage({ message: body.message })
      }
      await route.continue({ postData: JSON.stringify(body) })
    }, { times: 1 })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    const verification = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/verify' && r.request().method() === 'POST')
    await sheet.connectWith(wallet.walletName)
    const rejected = await verification
    expect(rejected.status()).toBe(401)
    const error = await rejected.json()
    expect(error.error).toBe(expectedError)
    await expectValidationMessage(sheet.error(), copy.join.signFailed, `${mode}-sign-in-rejected`)
    await sheet.expectStep(copy.join.stepSign)
    await expect(sheet.signInButton()).toBeEnabled()
    const session = await page.request.get('/api/auth/session', { maxRetries: 2 })
    expect(session.status()).toBe(200)
    expect((await session.json()).address).toBeNull()
    await test.info().attach('authentication-rejection', { body: Buffer.from(JSON.stringify({ mode, status: rejected.status(), error })), contentType: 'application/json' })
  }

  test('W37 - Negative: reject a sign-in message signed by another wallet', async ({ page }) => {
    await expectRejectedVerification(page, 'wrong-signer', 'invalid_signature')
  })

  test('W38 - Negative: reject an expired sign-in message with a valid wallet signature', async ({ page }) => {
    await expectRejectedVerification(page, 'expired', 'message_invalid')
  })
})
