import { expect, test, watchErrors, todo, usesMineTabs } from './fixtures'
import { JoinSheet } from '../../pages/JoinSheet'
import { stubAnalytics } from '../../fixtures/network'
import { skipIfMineClosed } from '../../fixtures/api'

/** Read-only: safe on production, preview and the isolated stack. */

const WIDTHS = [360, 390, 768, 1440] as const
const PUBLIC_PAGES = ['/', '/?tab=quest', '/?tab=mine', '/?tab=vote'] as const
const CRON_PATHS = ['/api/cron/relay-sweep', '/api/cron/funnel-failures', '/api/cron/checkin-reconcile', '/api/cron/quest-reconcile', '/api/cron/chain-index'] as const
const ADMIN_PATHS = ['/api/admin/admins', '/api/admin/roles', '/api/admin/quests', '/api/admin/ledger/export'] as const

test.describe('Landing and navigation', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  test('T0-01 - Home loads with status 200', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
  })

  test('T0-02 - The Join button is visible', async ({ page }) => {
    await page.goto('/')
    await expect(new JoinSheet(page).cta()).toBeVisible()
  })

  test('T0-03 - Clicking Join opens the sheet on the Wallet step', async ({ page }) => {
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await expect(sheet.sheet()).toBeVisible()
    await sheet.expectStep('Wallet')
  })

  test('T0-04 - Home opens with no uncaught errors or console errors', async ({ page }) => {
    const problems = watchErrors(page)
    await page.goto('/')
    await new JoinSheet(page).open()
    expect(problems).toEqual([])
  })

  test('T0-05 - The page title says MPC', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/MPC/)
  })

  // Legacy routes differ by target. Production (checked 2026-11-05) redirects /quests to ?view=quest,
  // /mine to ?view=dig and /vote to ?view=vote; the activities target uses ?tab=<board>.
  const tabs = usesMineTabs()
  const legacy: Array<[string, string, RegExp]> = [
    ['/quests', tabs ? 'quest' : 'quest', tabs ? /[?&]tab=quest(&|$)/ : /[?&]view=quest(&|$)/],
    ['/mine', tabs ? 'mine' : 'dig', tabs ? /[?&]tab=mine(&|$)/ : /[?&]view=dig(&|$)/],
    ['/vote', tabs ? 'vote' : 'vote', tabs ? /[?&]tab=vote(&|$)/ : /[?&]view=vote(&|$)/],
  ]
  for (const [from, , expected] of legacy) {
    test(`T0-06 - Legacy link ${from} redirects to the current board`, async ({ page }) => {
      // Next streams the redirect before replacing the document. Waiting for the
      // original document's load races that replacement (net::ERR_ABORTED).
      await page.goto(from, { waitUntil: 'commit' })
      await expect(page).toHaveURL(expected)
    })
  }
  test('T0-06b - Legacy /join redirects to home', async ({ page }) => {
    await page.goto('/join')
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?(\?|#|$)/)
  })

  for (const path of ['/vote/abc', '/vote/1e3', '/vote/-1']) {
    test(`T0-07 - Malformed proposal ${path} is handled without a server error`, async ({ page }) => {
      const problems = watchErrors(page)
      const response = await page.goto(path)
      expect(response?.status() ?? 0).toBeLessThan(500)
      expect(problems.filter(p => p.startsWith('pageerror'))).toEqual([])
    })
  }

  test('T0-08 - A hostile query value never runs script', async ({ page }) => {
    const dialogs: string[] = []
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await page.goto('/?view=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E')
    await expect(new JoinSheet(page).cta()).toBeVisible()
    expect(dialogs).toEqual([])
  })
})

test.describe('Landing responsive and keyboard behaviour', { tag: ['@ui', '@regression', '@web-module'] }, () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page)
  })

  for (const width of [360, 390, 768] as const) {
    test(`UI-01 - Join button is tappable and the sheet fits at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.goto('/')
      const cta = new JoinSheet(page).cta()
      await expect(cta).toBeVisible()
      const box = await cta.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      await new JoinSheet(page).open()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    })
  }

  test('M-28 - The join flow on a phone fits and every step is reachable (390x844)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.expectStep('Wallet')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const dialogBox = await sheet.sheet().boundingBox()
    expect(dialogBox?.width ?? 0).toBeLessThanOrEqual(390)
  })

  test('UI-02 - Keyboard opens and closes the sheet and returns focus to Join', async ({ page }) => {
    await page.goto('/')
    const sheet = new JoinSheet(page)
    const cta = sheet.cta()
    await cta.focus()
    await page.keyboard.press('Enter')
    await expect(sheet.sheet()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet.sheet()).not.toBeVisible()
    await expect(cta).toBeFocused()
  })

  for (const path of PUBLIC_PAGES) {
    test(`UI-04 - ${path} has no horizontal scroll at every width`, async ({ page }) => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(path)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0)
      }
    })
  }

  test('UI-05 - Reload produces no hydration warning or uncaught error', async ({ page }) => {
    const problems = watchErrors(page)
    await page.goto('/')
    await page.reload()
    await expect(new JoinSheet(page).cta()).toBeVisible()
    expect(problems).toEqual([])
  })

  test('UI-14 - No undefined, NaN or object placeholder appears in visible text', async ({ page }) => {
    for (const path of ['/', '/?tab=vote']) {
      await page.goto(path)
      const text = await page.locator('body').innerText()
      expect(text, path).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]/)
    }
  })
})

test.describe('Reduced motion', { tag: ['@ui', '@web-module'] }, () => {
  test('UI-03 - With reduced motion the sheet opens and shows its final state', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await stubAnalytics(page)
    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await expect(sheet.sheet()).toBeVisible()
  })
})

test.describe('Public security (anonymous)', { tag: ['@security', '@regression', '@web-module'] }, () => {
  test('SEC-02 - Protected APIs refuse anonymous requests with 401', async ({ request }) => {
    for (const path of ['/api/notifications', '/api/energy', '/api/activities']) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(401)
    }
  })

  test('SEC-02b - My Mine run refuses anonymous requests', async ({ request }) => {
    const response = await request.get('/my-mine/run', { maxRedirects: 0 })
    skipIfMineClosed(response.status())
    expect(response.status()).toBe(401)
  })

  test('SEC-03 - Cron endpoints refuse missing, wrong and empty bearer secrets', async ({ request }) => {
    for (const path of CRON_PATHS) {
      for (const headers of [{}, { authorization: 'Bearer not-the-secret' }, { authorization: 'Bearer ' }] as Record<string, string>[]) {
        const response = await request.get(path, { headers, maxRedirects: 0 })
        expect([401, 403], `${path} ${JSON.stringify(headers)}`).toContain(response.status())
      }
    }
  })

  test('SEC-04 - Admin APIs refuse anonymous reads and writes', async ({ request }) => {
    const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost').origin
    for (const path of ADMIN_PATHS) {
      const response = await request.get(path, { headers: { origin }, maxRedirects: 0 })
      expect([401, 403], path).toContain(response.status())
    }
    const write = await request.post('/api/admin/quests', { headers: { origin, 'content-type': 'application/json' }, data: { key: 'qa-anon-probe' }, maxRedirects: 0 })
    expect([401, 403]).toContain(write.status())
  })

  test('SEC-07 - Home is protected against framing (clickjacking) and sniffing', async ({ request }) => {
    const response = await request.get('/', { maxRedirects: 0 })
    const headers = response.headers()
    const frameProtected = /frame-ancestors|DENY|SAMEORIGIN/i.test(`${headers['content-security-policy'] ?? ''} ${headers['x-frame-options'] ?? ''}`)
    expect(frameProtected, 'frame-ancestors or X-Frame-Options').toBe(true)
    expect(headers['x-content-type-options']).toBe('nosniff')
  })

  test('SEC-14 - Unknown routes and malformed bodies leak no stack trace or SQL', async ({ request }) => {
    const unknown = await request.get('/api/does-not-exist-qa')
    const text = await unknown.text()
    expect(text).not.toMatch(/\bat \w+.*\(|Error:|postgres|SELECT |stack/i)
    const malformed = await request.post('/api/telemetry/latency', { headers: { 'content-type': 'application/json' }, data: '{"samples":', maxRedirects: 0 })
    expect(malformed.status()).toBeLessThan(500)
    expect(await malformed.text()).not.toMatch(/\bat \w+.*\(|Error:|postgres|stack/i)
  })

  test('SEC-16 - Environment and git metadata are not served', async ({ request }) => {
    for (const path of ['/.env', '/.git/config', '/.git/HEAD']) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).not.toBe(200)
      expect(await response.text(), path).not.toMatch(/DATABASE|SECRET|\[core\]|ref: refs/)
    }
  })

  test('SEC-21 - Home makes no insecure (http) third-party requests', async ({ page }) => {
    await stubAnalytics(page)
    const insecure: string[] = []
    page.on('request', (req) => {
      if (req.url().startsWith('http://') && !/localhost|127\.0\.0\.1/.test(req.url())) insecure.push(req.url())
    })
    await page.goto('/')
    await new JoinSheet(page).open()
    expect(insecure).toEqual([])
  })

  todo('SEC-09', 'Stored XSS in quest names and admin text is escaped', 'Needs an admin session (ADMIN credentials are not configured). Reflected XSS is covered by T0-08.')
  todo('SEC-12', 'A preview signature replayed on production is refused', 'Needs a signature from preview; cannot be produced from this environment safely.')
  todo('SEC-20', 'Telegram webhook refuses replays with an old timestamp', 'Webhook timestamp window is not defined in the source; cannot assert a value.')
})
