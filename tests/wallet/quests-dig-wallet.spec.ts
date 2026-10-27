import { expect, test, type Page, type Response } from '@playwright/test'
import { QuestsDig, layoutIssues, type QuestState, type Run } from '../../fixtures/quests-dig'
import { connectConfiguredWallet } from '../../fixtures/connected-wallet'
import { injectTestWallet, setWalletFailure } from '../../fixtures/wallet'
import { stubAnalytics } from '../../fixtures/network'
import { usesActivities, openMining } from '../../fixtures/mining-navigation'
import { JoinSheet } from '../../pages/JoinSheet'
import { validationCopy } from '../../pages/validation-copy'
import { getConfiguredWallet } from '../../utils/wallet-generator'
import { target } from '../../config/target'

const contract = '0x80ca104d4dc59d42862b801792abb1909f5a7e5d'
const rpc = 'https://opbnb-mainnet-rpc.bnbchain.org'
const suite = 'Verify Quests, Digging Process, Wallet Transaction, and UI Content'

async function session(page: Page, address: string) {
  const response = await page.request.get('/api/auth/session', { maxRetries: 2 })
  expect(response.ok()).toBe(true)
  expect((await response.json()).address).toBe(address.toLowerCase())
}

function questProgress(state: QuestState) {
  return state.quests.map(q => ({ key: q.key, state: q.state, activityProgress: q.activityProgress, onchainProgress: q.onchainProgress })).sort((a, b) => a.key.localeCompare(b.key))
}

function confirmed(run: Run) {
  return run.records.filter(record => ['included', 'confirmed'].includes(record.state))
}

async function evidence(page: Page, name: string) {
  await test.info().attach(`${name}-text`, { body: Buffer.from(await page.locator('body').innerText()), contentType: 'text/plain' })
  await test.info().attach(`${name}-screenshot`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
}

test.describe(suite, { tag: ['@ui', '@quests-dig-wallet'] }, () => {
  test.describe.configure({ retries: 0 })
  test.beforeEach(() => {
    test.skip(new URL(target().baseUrl).origin !== 'https://app.globalmpc.tech', 'Unity-specific selectors and pinned contract; use npm run test:quests-dig')
    test.skip(usesActivities(), 'This case covers the Unity Dig and Quests interface')
    test.skip(!process.env.QA_SEED_PHRASE, 'Configure QA_SEED_PHRASE and WALLET_ADDRESS locally')
  })

  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 375, height: 812 }]) {
    test(`Quests, UI content, and refresh persistence — ${viewport.name}`, async ({ page }) => {
      const ui = new QuestsDig(page)
      const wallet = await connectConfiguredWallet(page)
      await ui.ready()
      await page.setViewportSize(viewport)
      await ui.ready()
      await session(page, wallet.address)
      const before = await ui.counters()
      const saved = await ui.run()
      const quests = await ui.quests()
      await test.step('Steps 1–7: verify wallet, every quest, counters, rewards, and progress', async () => {
        await ui.verifyQuests(quests)
        expect(await layoutIssues(ui.panel)).toEqual([])
        await evidence(page, `${viewport.name}-quests`)
        await ui.closeQuests()
        expect(await ui.counters()).toEqual(before)
      })
      await test.step('Steps 16–17: verify Dig copy, layout, and persisted session and progress', async () => {
        await expect(page.getByRole('heading', { name: 'Digging', exact: true })).toBeVisible()
        await expect(ui.cart).toHaveText('Send the cart')
        expect(before.available).toBe(Math.min(Math.floor(before.crew / 3), before.left))
        expect(before.available).toBeGreaterThanOrEqual(0)
        await evidence(page, `${viewport.name}-dig`)
        expect(await layoutIssues(page.locator('main').filter({ has: ui.dig }))).toEqual([])
        await page.reload()
        await ui.ready()
        await session(page, wallet.address)
        expect(await ui.counters()).toEqual(before)
        expect(await ui.run()).toMatchObject({ script: saved.script, records: saved.records })
        expect(questProgress(await ui.quests())).toEqual(questProgress(quests))
        await ui.verifyQuests(await ui.quests())
      })
    })
  }

  test('Steps 1–17: exhaust digs, reject, recover from relay failure, approve cart, and verify receipt', async ({ page }) => {
    test.skip(process.env.QA_RUN_QUEST_DIG_CART !== '1' || !!process.env.QA_REPORT_DIR || process.env.QA_ALLOW_WRITES !== '1' || process.env.npm_lifecycle_event !== 'test:quests-dig:cart', 'Run npm run test:quests-dig:cart with QA_ALLOW_WRITES=1 and QA_RUN_QUEST_DIG_CART=1 outside the pipeline')
    test.setTimeout(360_000)
    expect(new URL(target().baseUrl).origin, 'Pinned RecordFor contract belongs to the Unity production deployment').toBe('https://app.globalmpc.tech')
    expect(target().chainId).toBe(56)
    const ui = new QuestsDig(page)
    const account = getConfiguredWallet()
    let preparation: Promise<Response> | undefined
    let releaseApproval: (() => void) | undefined
    let signingError: unknown
    const recordMessages: Array<Record<string, unknown>> = []
    let expectedDigs = 0
    let expectedEnergy = 0
    let expectedCreditEarned = 0
    let expectedCreditSpent = 0
    let submits = 0
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/my-mine/record/submit' && request.method() === 'POST') submits++
    })
    await stubAnalytics(page)
    await injectTestWallet(page, {
      account, chainId: target().chainId,
      beforeSignTypedData: async payload => {
        try {
          expect(payload.primaryType).toBe('RecordFor')
          expect(payload.domain).toMatchObject({ name: 'MpcMyMine', version: '3' })
          expect(Number(payload.domain?.chainId)).toBe(204)
          expect(payload.domain?.verifyingContract?.toLowerCase()).toBe(contract)
          expect(preparation).toBeDefined()
          const response = await preparation!
          expect(response.ok()).toBe(true)
          const prepared = await response.json()
          expect(payload).toMatchObject(prepared.typedData)
          const message = payload.message as Record<string, unknown>
          expect(String(message.user).toLowerCase()).toBe(account.address.toLowerCase())
          expect(Number(message.kind)).toBe(0)
          expect(Number(message.count)).toBe(expectedDigs)
          expect(Number(message.energyUsed)).toBe(expectedEnergy)
          expect(Number(message.day)).toBe(Math.floor(Date.now() / 86_400_000))
          expect(Number(message.deadline)).toBeGreaterThan(Date.now() / 1000)
          expect(message.dataHash).toMatch(/^0x[\da-f]{64}$/i)
          expect(message.challenge).toMatch(/^0x[\da-f]{64}$/i)
          expect(message.submitter).toMatch(/^0x[\da-f]{40}$/i)
          expect(message.submitter).not.toBe('0x0000000000000000000000000000000000000000')
          expect(Number(message.creditEarned)).toBe(expectedCreditEarned)
          expect(Number(message.creditSpent)).toBe(expectedCreditSpent)
          expect(message.goodsIds).toEqual([])
          expect(message.goodsMadeTo).toEqual([])
          expect(message.goodsBurnedTo).toEqual([])
          recordMessages.push(message)
          await test.info().attach(`cart-signature-${recordMessages.length}`, { body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json' })
          // Hold the approval so pending state and duplicate-click protection can be inspected.
          await new Promise<void>(resolve => { releaseApproval = resolve })
        } catch (error) { signingError = error; throw error }
      },
    })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith('Trust Wallet')
    await session(page, account.address)
    await openMining(page)
    await ui.ready()
    const initial = await ui.counters()
    const initialRun = await ui.run()
    const initialQuests = await ui.quests()
    await ui.verifyQuests(initialQuests)
    await ui.closeQuests()
    test.skip(initial.available === 0, 'Precondition blocked: this wallet has no remaining digs; existing records do not count as fresh coverage')
    const accounting = await page.request.get('/my-mine/energy')
    expect(accounting.ok()).toBe(true)
    const balance = await accounting.json()
    expect(balance.wallet).toBe(account.address.toLowerCase())
    expect(Number.isSafeInteger(balance.spent)).toBe(true)
    test.skip(balance.outstanding !== 0 || !await page.getByText(validationCopy.emptyCartHint, { exact: true }).isVisible(),
      'Precondition blocked: start with an empty cart and no outstanding Crew use for exact cart authorization')
    // Pinned Unity LIMITS.cart.batch is 100; a magnet can add a second line per dig.
    // The empty-cart precondition above excludes carried entries. Reserve worst-case room.
    test.skip(initial.available * 2 > 100, 'Precondition blocked: all intended digs must fit in one empty cart, including magnet bonus lines')
    test.skip(!await ui.dig.isEnabled(), 'Precondition blocked: no available cart run or digging is otherwise unavailable')
    expectedDigs = initial.available
    // RecordFor energy and credits are cumulative; authorize only the additional fresh dig cost.
    expectedEnergy = balance.spent + initial.available * 3
    expectedCreditEarned = Math.max(0, ...initialRun.records.map(record => record.creditEarned))
    expectedCreditSpent = Math.max(0, ...initialRun.records.map(record => record.creditSpent))
    await expect(ui.dig).toBeEnabled()
    const startDay = initialQuests.day

    await test.step('Steps 8–9: use every available dig and prevent an extra dig', async () => {
      for (let index = 1; index <= initial.available; index++) {
        if (!await ui.dig.isEnabled()) {
          await evidence(page, 'dig-blocked-before-exhaustion')
          await expect(ui.dig, 'Unexpectedly disabled before exhausting the allowance').toBeEnabled()
        }
        await ui.dig.click()
        const result = page.getByRole('dialog').filter({ visible: true })
        await expect(result).toHaveCount(1)
        await expect(result.getByText(validationCopy.justDug, { exact: true })).toBeVisible()
        await expect(result.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
        await result.getByRole('button', { name: 'Close', exact: true }).click()
        await expect.poll(() => ui.counters()).toEqual({
          available: initial.available - index, left: initial.left - index,
          crew: initial.crew - 3 * index, today: initial.today + index, total: initial.total + index,
        })
      }
      await expect(ui.dig).toBeDisabled()
      const reason = await ui.dig.getAttribute('aria-describedby')
      expect(reason, 'Unavailable digging must have an explanation').toBeTruthy()
      await expect(page.locator(`[id=${JSON.stringify(reason)}]`)).toBeVisible()
      const after = await ui.counters()
      // A real pointer click on a disabled control must not consume more Crew.
      const box = await ui.dig.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
      expect(await ui.counters()).toEqual(after)
      expect(questProgress(await ui.quests())).toEqual(questProgress(initialQuests))
      await page.reload()
      await ui.ready()
      expect(await ui.counters()).toEqual(after)
      await expect(ui.cart).toBeEnabled()
    })
    const exhausted = await ui.counters()
    const recordedBefore = confirmed(initialRun)
    const retained = async () => {
      expect(await ui.counters()).toEqual(exhausted)
      expect(confirmed(await ui.run())).toEqual(recordedBefore)
      expect(questProgress(await ui.quests())).toEqual(questProgress(initialQuests))
      await expect(ui.cart).toBeEnabled()
    }
    await test.step('Additional: rejected wallet approval preserves the cart and quests', async () => {
      await setWalletFailure(page, 'eth_signTypedData_v4', 'rejected')
      await ui.cart.click()
      await expect(page.getByText(/(?:signature|transaction).*(?:cancelled|rejected)/i).first()).toBeVisible()
      expect(recordMessages).toHaveLength(0)
      expect(submits).toBe(0)
      await retained()
      await setWalletFailure(page, 'eth_signTypedData_v4', null)
    })

    async function approve(expectedSignatures: number) {
      preparation = page.waitForResponse(r => new URL(r.url()).pathname === '/my-mine/record' && r.request().method() === 'POST')
      await ui.cart.click()
      await expect.poll(() => {
        if (signingError) throw signingError
        return recordMessages.length
      }).toBe(expectedSignatures)
      const request = recordMessages.at(-1)!
      expect(Number(request.energyUsed)).toBe(expectedEnergy)
      await expect(ui.cart).toBeDisabled()
      const before = submits
      const box = await ui.cart.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2)
      expect(recordMessages).toHaveLength(expectedSignatures)
      expect(submits).toBe(before)
      expect(releaseApproval).toBeDefined()
      releaseApproval!()
      releaseApproval = undefined
    }
    await test.step('Additional: a failed relay request displays an error and preserves retryable progress', async () => {
      // A definitive refusal is retryable. Transport loss is deliberately kept pending by the app.
      await page.route('**/my-mine/record/submit', route => route.fulfill({ status: 400, json: { error: 'refused' } }), { times: 1 })
      const failed = page.waitForResponse(r => new URL(r.url()).pathname === '/my-mine/record/submit' && r.status() === 400)
      await approve(1)
      await failed
      await expect(page.getByText(/failed|could not|try again|did not complete|refused/i).first()).toBeVisible()
      expect(submits).toBe(1)
      await retained()
    })

    let txHash: string
    let recordIndex: number
    await test.step('Steps 10–13: approve one cart signature and verify actual opBNB confirmation', async () => {
      const submission = page.waitForResponse(r => new URL(r.url()).pathname === '/my-mine/record/submit' && r.request().method() === 'POST', { timeout: 120_000 })
      await approve(2)
      const response = await submission
      expect(response.ok()).toBe(true)
      const result = await response.json()
      txHash = result.txHash
      recordIndex = response.request().postDataJSON().moveIndex
      expect(txHash).toMatch(/^0x[\da-f]{64}$/i)
      expect(['sent', 'included', 'confirmed']).toContain(result.state)
      expect(submits).toBe(2) // One intentionally blocked request; one actual relay submission.
      await expect.poll(async () => {
        // dataHash is a public transaction identifier, not the signature or a secret.
        const record = (await ui.run()).records.find(r => r.index === recordIndex && r.dataHash === recordMessages.at(-1)!.dataHash)
        return record?.txHash === txHash && ['included', 'confirmed'].includes(record.state)
      }, { timeout: 120_000 }).toBe(true)
      const chain = await page.request.post(rpc, { data: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } })
      expect((await chain.json()).result).toBe('0xcc')
      let receipt: { transactionHash: string; status: string; to: string; gasUsed: string; logs: unknown[] } | undefined
      await expect.poll(async () => {
        const response = await page.request.post(rpc, { data: { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [txHash] } })
        expect(response.ok()).toBe(true)
        const data = await response.json()
        expect(data.error).toBeUndefined()
        receipt = data.result
        return receipt?.status
      }, { timeout: 120_000 }).toBe('0x1')
      expect(receipt!.transactionHash.toLowerCase()).toBe(txHash.toLowerCase())
      expect(receipt!.to.toLowerCase()).toBe(contract)
      expect(BigInt(receipt!.gasUsed)).toBeGreaterThan(0n)
      expect(receipt!.logs.length).toBeGreaterThan(0)
      const txResponse = await page.request.post(rpc, { data: { jsonrpc: '2.0', id: 3, method: 'eth_getTransactionByHash', params: [txHash] } })
      expect(txResponse.ok()).toBe(true)
      const tx = (await txResponse.json()).result
      expect(tx.to.toLowerCase()).toBe(contract)
      expect(tx.from.toLowerCase()).toBe(String(recordMessages.at(-1)!.submitter).toLowerCase())
      // Bind this receipt to the unique signed record, independently of the app's hash mapping.
      expect(tx.input.toLowerCase()).toContain(String(recordMessages.at(-1)!.dataHash).slice(2).toLowerCase())
      expect(tx.input.toLowerCase()).toContain(String(recordMessages.at(-1)!.challenge).slice(2).toLowerCase())
      expect(tx.input.toLowerCase()).toContain(account.address.slice(2).toLowerCase())
      await test.info().attach('confirmed-cart-receipt', { body: Buffer.from(JSON.stringify({ network: 204, explorer: `https://opbnbscan.com/tx/${txHash}`, receipt })), contentType: 'application/json' })
    })
    await test.step('Steps 14–17: verify one new record, quest eligibility, no duplicate rewards, and persistence', async () => {
      const done = page.getByRole('button', { name: 'Done', exact: true })
      if (await done.isVisible()) await done.click()
      await expect(ui.cart).toBeDisabled()
      await expect(page.getByText(validationCopy.emptyCartHint, { exact: true })).toBeVisible()
      const saved = await ui.run()
      expect(confirmed(saved)).toHaveLength(recordedBefore.length + 1)
      expect(saved.records.filter(r => r.txHash === txHash!)).toHaveLength(1)
      expect(await ui.counters()).toEqual(exhausted)
      await expect.poll(async () => {
        const state = await ui.quests()
        expect(state.day, 'Do not compare counters across a UTC daily reset').toBe(startDay)
        for (const original of initialQuests.quests) {
          const updated = state.quests.find(q => q.questId === original.questId)
          expect(updated).toBeDefined()
          // Sending a cart cannot itself claim a quest reward.
          expect(updated!.state).toBe(original.state)
          if (['daily-dig-5', 'daily-dig-10'].includes(original.key) && original.activityProgress) {
            if (updated!.activityProgress?.current !== original.activityProgress.current + initial.available) return false
          } else if (original.key === 'daily-use-50-crew' && original.activityProgress) {
            if (updated!.activityProgress?.current !== original.activityProgress.current + initial.available * 3) return false
          } else if (original.key === 'mine-first-dig') {
            const progress = updated!.onchainProgress
            if (original.onchainProgress) {
              expect(progress).not.toBeNull()
              expect(progress!.current).toBeGreaterThanOrEqual(progress!.target)
            }
          } else {
            expect(updated!.activityProgress).toEqual(original.activityProgress)
            expect(updated!.onchainProgress).toEqual(original.onchainProgress)
          }
        }
        return true
      }, { timeout: 60_000 }).toBe(true)
      const quests = await ui.quests()
      await ui.verifyQuests(quests)
      await evidence(page, 'post-cart-quests')
      await ui.closeQuests()
      await page.reload()
      await ui.ready()
      await session(page, account.address)
      expect(await ui.counters()).toEqual(exhausted)
      expect(await ui.run()).toMatchObject({ script: saved.script, records: saved.records })
      expect(questProgress(await ui.quests())).toEqual(questProgress(quests))
      await expect(ui.cart).toBeDisabled()
      expect(submits).toBe(2)
      await evidence(page, 'persisted-dig-and-cart')
    })
  })
})
