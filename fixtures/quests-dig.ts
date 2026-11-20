import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { validationCopy } from '../pages/validation-copy'
import questCopy from '../pages/quest-copy.json' with { type: 'json' }

export type Quest = {
  key: string; questId: string; state: string; amount: number; rewardAsset: string
  content: { title: string; description: string }
  requires: { key: string; name: string } | null
  activityProgress: { current: number; target: number; status: string } | null
  onchainProgress: { current: number; target: number; status: string } | null
}
export type QuestState = { day: number; quests: Quest[]; nextCursor: string | null; confirmingCount: number }
export type Run = {
  script: Array<{ t: string; draws?: unknown[] }>
  records: Array<{ index: number; state: string; txHash: string; dataHash: string; digCount: number; creditEarned: number; creditSpent: number }>
}

/** Real UI and owner-scoped API reads. No simulated balances, quests, or successful receipts. */
export class QuestsDig {
  readonly dig: Locator
  readonly cart: Locator
  readonly panel: Locator
  private restoration?: Response

  constructor(readonly page: Page) {
    this.dig = page.getByRole('button', { name: 'Tap the ore to dig', exact: true })
    this.cart = page.getByRole('button', { name: 'Send the cart', exact: true })
    this.panel = page.getByRole('dialog', { name: 'Quests', exact: true })
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/my-mine/run' && response.request().method() === 'GET' && response.ok()) this.restoration = response
    })
  }

  async ready() {
    await expect(this.dig).toBeVisible({ timeout: 60_000 })
    await expect(this.page.getByText('Syncing today’s activity… You can still browse your mine.', { exact: true }).first()).not.toBeVisible({ timeout: 60_000 })
    await expect(this.page.getByText(validationCopy.miningIntro, { exact: true })).toBeVisible()
  }

  async quests(): Promise<QuestState> {
    const response = await this.page.request.get('/api/quests')
    expect(response.ok(), 'Owner-scoped quests must load').toBe(true)
    const result = await response.json()
    expect(result.viewer).toBe('ok')
    expect(result.nextCursor, 'Do not silently omit paginated quests').toBeNull()
    expect(Array.isArray(result.quests)).toBe(true)
    expect(new Set(result.quests.map((q: Quest) => q.questId)).size).toBe(result.quests.length)
    return result
  }

  async run(): Promise<Run> {
    await expect.poll(() => Boolean(this.restoration), { message: 'Capture the versioned saved run', timeout: 60_000 }).toBe(true)
    const headers = this.restoration!.request().headers()
    const response = await this.page.request.get('/my-mine/run', { headers: Object.fromEntries(
      ['x-mpc-cid', 'x-mpc-run-protocol'].filter(key => headers[key]).map(key => [key, headers[key]!]),
    ) })
    expect(response.ok()).toBe(true)
    const run = await response.json()
    expect(Array.isArray(run.script)).toBe(true)
    expect(Array.isArray(run.records)).toBe(true)
    return run
  }

  async counters() {
    const text = await this.page.locator('body').innerText()
    const number = (pattern: RegExp) => {
      const match = text.match(pattern)
      expect(match, `Missing dig counter: ${pattern}`).not.toBeNull()
      return Number(match![1]!.replaceAll(',', ''))
    }
    return {
      available: number(/Digs available now\s+([\d,]+)\s*\//),
      left: number(/Digs left today:?\s+([\d,]+)\s*\//),
      crew: number(/Crew available\s+([\d,]+)\s+Crew/),
      today: number(/DUG TODAY\s+([\d,]+)/i),
      total: number(/TOTAL DIGS\s+([\d,]+)/i),
    }
  }

  async openQuests() {
    if (!await this.panel.isVisible()) await this.page.getByRole('button', { name: /^Quests(?:\s*\d+)?$/ }).click({ force: true })
    await expect(this.panel).toBeVisible()
    await expect(this.panel.getByText(validationCopy.questsIntro, { exact: true })).toBeVisible()
    await expect(this.panel.getByText('Loading today’s check-in…', { exact: true })).not.toBeVisible()
  }

  async closeQuests() {
    await this.panel.getByRole('button', { name: 'Close quests', exact: true }).click()
    await expect(this.panel).not.toBeVisible()
  }

  async verifyQuests(state: QuestState) {
    await this.openQuests()
    const dailyResponse = await this.page.request.get('/api/quiz/today')
    expect(dailyResponse.ok()).toBe(true)
    const daily = await dailyResponse.json()
    expect(daily.day).toBe(state.day)
    const completeCount = state.quests.filter(q => q.state === 'done').length + Number(daily.checkedIn)
    const incompleteCount = state.quests.length + 1 - completeCount
    await expect(this.panel.getByText(`${incompleteCount} remaining · ${completeCount} completed`, { exact: true })).toBeVisible()
    for (const completed of [false, true]) {
      const label = completed ? 'Completed' : 'Incomplete'
      const count = completed ? completeCount : incompleteCount
      const tab = this.panel.getByRole('tab', { name: `${label} ${count}`, exact: true })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      const list = this.panel.getByRole('tabpanel', { name: `${label} ${count}`, exact: true })
      await expect(list.getByRole('article')).toHaveCount(count)
      if (Boolean(daily.checkedIn) === completed) {
        const checkin = list.getByRole('article').filter({ has: this.page.getByRole('heading', { name: 'Daily check-in', exact: true }) })
        await expect(checkin).toHaveCount(1)
        if (completed) {
          await expect(checkin.getByRole('button', { name: 'Completed', exact: true })).toBeDisabled()
          await expect(checkin).toContainText(validationCopy.checkedIn)
        } else {
          await expect(checkin.getByRole('button', { name: 'Completed', exact: true })).toHaveCount(0)
          await expect(checkin.getByRole('button', { name: 'Claim', exact: true })).toBeVisible()
        }
        expect(await layoutIssues(checkin)).toEqual([])
      }
      for (const quest of state.quests.filter(q => (q.state === 'done') === completed)) {
        const row = list.getByRole('article').filter({ has: this.page.getByRole('heading', { name: quest.content.title, exact: true }) })
        await expect(row).toHaveCount(1)
        await row.scrollIntoViewIfNeeded()
        // Expand descriptions that the product deliberately collapses to two lines.
        const expand = row.locator('button[aria-expanded="false"]')
        if (await expand.count()) await expand.click()
        await expect(row).toHaveAttribute('data-state', completed ? 'claimed' : 'active')
        await expect(row).toContainText(quest.content.description)
        await expect(row).toContainText(`+${quest.amount}`)
        await expect(row).toContainText(quest.rewardAsset === 'crew' ? 'Crew' : 'Energy')
        const baseline = (questCopy as Record<string, { title: string; description: string }>)[quest.key]
        if (baseline) expect(quest.content).toMatchObject(baseline)
        expect(`${quest.content.title} ${quest.content.description}`).not.toMatch(/undefined|null|NaN|\ufffd|<[^>]+>/)
        if (completed) {
          await expect(row.getByRole('button', { name: 'Completed', exact: true })).toBeDisabled()
          await expect(row.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0)
        } else {
          await expect(row.getByRole('button', { name: 'Completed', exact: true })).toHaveCount(0)
          const progress = quest.activityProgress
          if (progress && progress.target > 1) {
            const bar = row.getByRole('progressbar')
            await expect(bar).toHaveAttribute('max', String(progress.target))
            await expect(bar).toHaveAttribute('value', String(Math.min(progress.current, progress.target)))
          }
          const unmet = [quest.activityProgress, quest.onchainProgress].some(p => p && p.current < p.target)
          const claim = row.getByRole('button', { name: /^(Claim|Verify & claim)$/ })
          if (unmet && await claim.count()) await expect(claim).toBeDisabled()
          if (['daily-dig-5', 'daily-dig-10', 'daily-use-50-crew'].includes(quest.key) && progress && progress.current >= progress.target) {
            await expect(row.getByRole('button', { name: 'Claim', exact: true })).toBeEnabled()
          }
          if (quest.key === 'mine-first-dig' && quest.onchainProgress && !unmet && quest.state === 'available') {
            await expect(claim).toBeEnabled()
          }
          if (quest.state === 'locked' && quest.requires) await expect(row).toContainText(quest.requires.name)
        }
        expect(await layoutIssues(row), `Quest layout: ${quest.key}`).toEqual([])
      }
      expect(await layoutIssues(this.panel), `${label} layout`).toEqual([])
    }
  }
}

/** Check horizontal clipping of visible text and controls, including expanded quest descriptions. */
export async function layoutIssues(root: Locator): Promise<string[]> {
  return root.evaluate(element => {
    const errors: string[] = []
    for (const node of [element, ...element.querySelectorAll('button, h1, h2, h3, [role="heading"], p, [id], progress')]) {
      const html = node as HTMLElement
      const style = getComputedStyle(html), rect = html.getBoundingClientRect()
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || html.classList.contains('sr-only')) continue
      const text = html.innerText?.trim()
      if (text && (rect.left < -1 || rect.right > innerWidth + 1 || html.scrollWidth > html.clientWidth + 2)) errors.push(text.slice(0, 100))
    }
    return errors
  })
}
