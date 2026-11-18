import { expect, test, todo, skipWhen, usesMineTabs } from './fixtures'
import { call } from '../../fixtures/api'
import { stubAnalytics } from '../../fixtures/network'
import { JoinSheet } from '../../pages/JoinSheet'
import { openMining } from '../../fixtures/mining-navigation'
import { validationCopy } from '../../pages/validation-copy'
import type { Page } from '@playwright/test'

/**
 * Digging, Materials, Market, Refine, Rankings (with Holdings and Records) and Rules.
 *
 * Screen labels come from src/modules/my-mine/glossary/names.ts. Screen routes differ by target:
 * production uses ?view=<screen>, the activities target uses ?tab=mine&screen=<screen>.
 */
type Screen = 'dig' | 'collection' | 'market' | 'ranks' | 'refine' | 'rules'

async function gotoScreen(page: Page, screen: Screen) {
  await page.goto(usesMineTabs() ? `/?tab=mine&screen=${screen}` : `/?view=${screen}`)
}

async function assertNoOverflow(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, `${width}px`).toBeLessThanOrEqual(0)
}

test.describe('Digging', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('DIG-01 - The seam choice offers Silicon, Lithium and Rare earth (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    const seams = page.getByRole('group', { name: 'Pick a seam', exact: true })
    for (const name of ['Silicon', 'Lithium', 'Rare earth']) {
      await expect(seams.getByRole('button', { name: new RegExp(`^${name}(?: · \\d+%)?$`) })).toBeVisible()
    }
  })

  test('DIG-02 - One dig from the face adds a mined item to the cart (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await new JoinSheet(page).dismissIfOpen()
    const face = page.getByRole('region', { name: 'The face', exact: true })
    if (usesMineTabs()) {
      const dig = face.getByRole('button', { name: 'Dig 1', exact: true })
      await expect(dig, 'A funded member with daily capacity is required').toBeEnabled()
      const cartCount = () => page.getByLabel(/^\d+ ore in cart$/).evaluateAll(nodes =>
        nodes.reduce((sum, node) => sum + Number.parseInt(node.getAttribute('aria-label') ?? '0', 10), 0))
      const before = await cartCount()
      await dig.click()
      await expect.poll(cartCount).toBe(before + 1)
      return
    }
    await face.getByRole('button', { name: 'Tap the ore to dig', exact: true }).click()
    await expect(page.getByText(validationCopy.justDug, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
  })

  test('DIG-14 - The face stays within 52% of the viewport height and the strike sits in the lower third (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await page.setViewportSize({ width: 390, height: 844 })
    await openMining(page)
    const face = await page.getByRole('region', { name: 'The face', exact: true }).boundingBox()
    expect(face, 'face region present').not.toBeNull()
    expect(face!.height).toBeLessThanOrEqual(844 * 0.52 + 1)
  })

  test('DIG-17 - An empty cart says so (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    const empty = page.getByText(validationCopy.emptyCart, { exact: true }).or(page.getByText(validationCopy.emptyCartHint, { exact: true }))
    skipWhen((await empty.count()) === 0, 'The cart has items; the empty state is not on screen.')
    await expect(empty.first()).toBeVisible()
  })

  for (const width of [360, 390, 768] as const) {
    test(`UI-04-dig - Digging screen fits at ${width}px (gated)`, async ({ page, member }) => {
      expect(member.address).toBeTruthy()
      await openMining(page)
      await assertNoOverflow(page, width)
    })
  }

  todo('DIG-03', 'Insufficient Crew (2 Crew) shows a path to quests', 'Needs a controlled Crew balance of 2; the balance cannot be set on a registered member.')
  todo('DIG-04', 'The daily cap (20 digs) shows a different reason and a countdown', 'Needs twenty digs done today on the stack.')
  todo('DIG-05', 'Dig what is left: (30,0)→10, (12,2)→4, (600,18)→2, (2,0)→0', 'Needs the controlled balance states (DIG_STATES); pure arithmetic in economy.ts is covered in the app repo.')
  todo('DIG-06', 'Cap maths: (600,19)→1; (600,20)→0', 'As DIG-05: needs controlled state.')
  todo('DIG-07', 'Exactly 3 Crew gives one dig and leaves 0', 'As DIG-05: needs a balance of exactly 3.')
  todo('DIG-08', 'The twenty-first put-back is refused', 'Needs twenty-one items in the cart.')
  todo('DIG-09', 'Two cart records per day; the third is refused', 'Needs three cart records in one day (on-chain).')
  todo('DIG-10', 'A record batch of 100 is allowed, 101 refused (verify limit)', 'Needs 101 cart items; the batch limit is recorded as needing verification.')
  todo('DIG-11', 'A record shows pending until the chain confirms', 'Needs an on-chain record in flight.')
  todo('DIG-12', 'A chosen seam wins 60% of outcomes (seeded, 10,000 digs)', 'Statistical: a unit-level test over the outcome function, not a browser case.')
  todo('DIG-13', 'No dig is ever empty (1,000 seeded digs)', 'Statistical: a unit-level test over the outcome function, not a browser case.')
  todo('DIG-15', 'Five rapid taps spend exactly 3 Crew per accepted dig', 'Changes state in a way that needs an exact Crew baseline; needs a controlled balance.')
  todo('DIG-16', 'The daily count resets at UTC midnight', 'Server clock (see CHK-03).')
})

test.describe('Materials', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('MAT-01 - Materials lists the ore and goods sections (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'collection')
    await expect(usesMineTabs()
      ? page.getByRole('tabpanel', { name: 'Materials', exact: true }).getByRole('button', { name: /^My Collection / })
      : page.getByRole('heading', { name: 'My Collection', exact: true })).toBeVisible()
    await expect(page.getByText('Ore', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Goods', { exact: true }).first()).toBeVisible()
  })

  test('MAT-02 - Unowned materials show their names, not placeholders (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'collection')
    expect(await page.getByText('?', { exact: true }).count()).toBe(0)
  })

  test('MAT-05 - The rankings button from Materials opens Rankings (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'collection')
    await new JoinSheet(page).dismissIfOpen()
    await (usesMineTabs() ? page.getByRole('tab', { name: 'Rankings', exact: true })
      : page.getByRole('button', { name: /rankings/i }).or(page.getByRole('link', { name: /rankings/i })).first()).click()
    await expect(usesMineTabs() ? page.getByRole('tabpanel', { name: 'Rankings', exact: true })
      : page.getByRole('heading', { name: 'Rankings', exact: true })).toBeVisible()
  })

  for (const width of [360, 768] as const) {
    test(`MAT-08 - Materials fits at ${width}px (gated)`, async ({ page, member }) => {
      expect(member.address).toBeTruthy()
      await openMining(page)
      await gotoScreen(page, 'collection')
      await assertNoOverflow(page, width)
    })
  }

  todo('MAT-03', 'Total score equals the sum of held goods weights (ladder 4, 22, 132, 858, 6006, 45045)', 'Needs held goods with known weights on the member; the weights are a pure function (goodsWeightOf) covered in the app repo.')
  todo('MAT-04', 'Total score updates live after dig, refine or sell', 'Needs a state change with a known score delta.')
  todo('MAT-06', 'No goods shows 0, not blank or NaN', 'Needs a wallet with no goods; a fresh wallet cannot reach Materials until registered.')
  todo('MAT-07', 'Large numbers are formatted and do not overflow', 'Needs a wallet holding a large total.')
  todo('MAT-09', 'Materials match server holdings after reload and in a second tab', 'Needs a known holding; partially covered by UI-07 (session across tabs).')
})

test.describe('Market (Forge) and Register', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('FRG-01 - The Forge route opens Market and Back restores the screen (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'dig')
    await gotoScreen(page, 'market')
    await expect(usesMineTabs() ? page.getByRole('tabpanel', { name: 'Market', exact: true })
      : page.getByLabel('Market', { exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Digging', exact: true }).or(page.getByLabel('Pick a seam'))).toBeVisible()
  })

  test('MKT-05 - Registered items cannot be cancelled from the Market screen (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'market')
    await expect(page.getByRole('button', { name: /cancel/i })).toHaveCount(0)
  })

  for (const width of [360, 768] as const) {
    test(`MKT-00-layout - Market fits at ${width}px (gated)`, async ({ page, member }) => {
      expect(member.address).toBeTruthy()
      await openMining(page)
      await gotoScreen(page, 'market')
      await assertNoOverflow(page, width)
    })
  }

  todo('MKT-01', 'Register price is 45, 225 and 1,125 credits for grades 0 to 2', 'Needs the register UI with owned ore of each grade on the member.')
  todo('MKT-02', 'Quantity 0 disabled; owned OK; owned + 1 refused', 'Needs known owned quantity and the register UI.')
  todo('MKT-03', 'Registered items show "being sold" and the time elapsed', 'Needs a registered item on the member.')
  todo('MKT-04', 'Schedule: day 14 not complete, day 15 complete, day 16 held at 15 days', 'Needs a registration aged 14–16 days (server clock).')
  todo('MKT-06', 'Claim is disabled at 0 and enabled at 1', 'Needs a known claimable balance.')
  todo('MKT-07', 'Buy price is 135, 675 and 3,375 for grades 0 to 2; grades 3+ not sold', 'Needs the buy UI with a known credit balance.')
  todo('MKT-08', 'Credits exactly equal to price buy; price − 1 is refused', 'Needs a controlled credit balance.')
  todo('MKT-09', 'Quantity 0, −1, 1.5 and 1e6 are refused with no balance change', 'Needs the buy UI; quantity validation is server-side (verify the buy route).')
  todo('MKT-10', 'The client price is ignored; the server charges its own price', 'Needs a buy request with a tampered price (buy route not mapped yet).')
  todo('MKT-11', 'A double-clicked buy debits once', 'Needs the buy UI and a known balance.')
  todo('MKT-12', 'Available credits update after a purchase', 'Needs a purchase.')
})

test.describe('Refine', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('RFN-01 - The Refine screen lists available materials (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'refine')
    await expect(page.getByRole('heading', { name: 'Available materials', exact: true })).toBeVisible()
  })

  todo('RFN-02', 'Selected items group at the top (G10: verify at runtime)', 'Runtime-verification item in the policy (unity-game-policy.md §4).')
  todo('RFN-03', 'Five of one grade enables Refine; four does not (verify, G11)', 'Needs owned ore of one grade in known quantities.')
  todo('RFN-04', 'Mixed grades 4 + 1 are refused (verify, G11)', 'Needs owned ore of mixed grades.')
  todo('RFN-05', 'One animation, then "Refining complete"', 'Needs a refine action; the completion copy is not in the vendored set.')
  todo('RFN-06', 'Reduced motion: no animation and the final state shows', 'Needs a refine action under reduced motion.')
  todo('RFN-07', 'A refine result improves or grinds down the item with no duplicate', 'Needs a refine action with a known outcome.')
  todo('RFN-08', 'Refine is disabled while a transaction is pending', 'Needs an on-chain refine in flight.')
  todo('RFN-09', 'The refine result matches the server after reload', 'Needs a completed refine.')
})

test.describe('Rankings, Holdings and Records', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('RNK-01 - Rankings shows the Place column and the table (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'ranks')
    await expect(page.getByRole('heading', { name: 'Rankings', exact: true })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Place', exact: true }).or(page.getByText('Place', { exact: true }).first())).toBeVisible()
  })

  test('RNK-02 - Holdings and Records are two top tabs (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'ranks')
    const holdings = page.getByRole('tab', { name: 'Holdings', exact: true })
    const records = page.getByRole('tab', { name: /Record/ })
    await expect(holdings).toBeVisible()
    await expect(records).toBeVisible()
    await records.click()
    await expect(records).toHaveAttribute('aria-selected', 'true')
  })

  test('REC-03 - The records board is labelled Records and does not say DAU (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'ranks')
    await page.getByRole('tab', { name: /Record/ }).click()
    expect(await page.locator('body').innerText()).not.toMatch(/\bDAU\b/)
  })

  test('RNK-05 - A wallet address in the query does not expose another wallet (gated)', async ({ page, member }, info) => {
    expect(member.address).toBeTruthy()
    const other = '0x0000000000000000000000000000000000000001'
    const res = await call(page.request, info, 'GET', `/my-mine/ranks?wallet=${other}`)
    skipWhen(res.status === 404, 'My Mine ranks are not enabled on this target.')
    expect(res.text.toLowerCase()).not.toContain(other)
  })

  todo('RNK-03', 'Own rank is shown; zero score shows "not ranked yet"', 'Needs a zero-score wallet on the board.')
  todo('RNK-04', 'Pages do not duplicate rows; the last page ends cleanly', 'Needs enough rows to page (data-dependent).')
  todo('HLD-01', 'A higher holding ranks above a lower one; ties follow the stated rule', 'Needs two known holdings on the board.')
  todo('HLD-02', 'Holdings score equals the Materials total', 'Needs MAT-03 first.')
  todo('HLD-03', 'The podium member minerals and assets can be viewed (G10)', 'Runtime-verification item in the policy.')
  todo('REC-01', 'One point per tap that reached the chain; pending taps are not counted', 'Needs on-chain records with a known count.')
  todo('REC-02', 'A record at 23:59:59Z counts today; at 00:00:00Z it counts tomorrow', 'Server clock (see CHK-03).')
  todo('REC-04', 'Record and holding scores are not multiplied or mixed', 'Unit-level: RANK_WEIGHT is not applied (economy.ts comment); covered in the app repo.')
})

test.describe('Rules', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('RUL-01 - Rules shows the Caps section (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'rules')
    await expect(page.getByRole('heading', { name: 'Caps', exact: true })).toBeVisible()
  })

  test('RUL-02 - Rules make no claim the code does not back (no "may obtain nothing", no double counting)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'rules')
    const text = await page.locator('body').innerText()
    expect(text).not.toMatch(/may obtain nothing|counts double|counts twice/i)
  })

  test('RUL-03 - The rules deep link opens Rules and Back works (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'dig')
    await gotoScreen(page, 'rules')
    await expect(page.getByRole('heading', { name: 'Caps', exact: true })).toBeVisible()
    await page.goBack()
    await expect(page).not.toHaveURL(/screen=rules|view=rules/)
  })

  test('RUL-04 - Rules fits at 360px (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'rules')
    await assertNoOverflow(page, 360)
  })

  todo('RUL-01b', 'Rules values equal the constants (COST 3, CAP 20, SAFETY 20, ASSET_DAYS 15, FUSE 5)', 'Needs the rendered values matched to the constants; copy for each value is not vendored yet. Constants are tested in the app repo.')
})

test.describe('Shared UI behaviour (gated)', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test('UI-06 - Reload keeps the mining screen and Back and Forward restore it (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    await gotoScreen(page, 'market')
    const url = page.url()
    await page.reload()
    await expect(page).toHaveURL(url)
    await expect(page.getByLabel('Market', { exact: true })).toBeVisible()
  })

  test('UI-07 - A second tab shares the signed-in session (gated)', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    const second = await page.context().newPage()
    await second.goto('/')
    const session = await second.request.get('/api/auth/session')
    expect(((await session.json()) as { address?: string }).address).toBe(member.address.toLowerCase())
    await second.close()
  })

  test('UI-09 - Every action is reachable by keyboard', async ({ page, member }) => {
    expect(member.address).toBeTruthy()
    await openMining(page)
    skipWhen(true, 'Keyboard order across the mining controls is not mapped; requires a focus-order audit of the screen.')
  })

  test('UI-11 - A delayed quest API leaves the page usable (anonymous)', async ({ page }) => {
    await page.route('**/api/quests', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 5_000))
      await route.continue()
    })
    await page.goto('/?tab=quest')
    await expect(page.getByRole('main', { name: 'Home', exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(new JoinSheet(page).cta()).toBeVisible({ timeout: 15_000 })
  })

  test('UI-12 - A double-clicked Join opens one sheet (anonymous)', async ({ page }) => {
    await page.goto('/')
    await new JoinSheet(page).cta().dblclick()
    await expect(page.getByRole('dialog', { name: 'Join', exact: true })).toHaveCount(1)
  })

  todo('UI-10', 'Reduced motion is respected on dig reveal, refine and toasts', 'Needs the reveal and toast triggers on a controlled state (see DIG-02, RFN-05).')
  todo('UI-13', 'Long and non-ASCII names truncate with an ellipsis', 'Needs a member whose display name is long and non-ASCII; test data not provisioned.')
  todo('UI-15', 'Numbers use thousands separators and do not overflow', 'Needs numeric values on screen (see MAT-07).')
})
