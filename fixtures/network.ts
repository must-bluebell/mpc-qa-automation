import type { Page } from '@playwright/test'

/**
 * Third-party analytics hosts, served locally as empty scripts.
 *
 * ## Why this exists
 *
 * The app loads Google Analytics (`components/analytics/GoogleAnalytics.tsx`). Whether that request
 * succeeds depends on the network the test happens to run on: a machine behind a VPN, a Pi-hole, or
 * any DNS-level blocker resolves `www.googletagmanager.com` to `0.0.0.0` and the browser logs
 * `net::ERR_CONNECTION_REFUSED`. Measured on the dev machine, 2026-08-17.
 *
 * 🔴 **Do not solve this by allowlisting the error text.** "Ignore connection-refused errors" would
 *    also swallow a refused connection to our own API, which is a real defect. The variable is the
 *    third-party request, so the fix is to remove the variable: answer it here with an empty 200 so
 *    the outcome is identical on a blocked machine and an open one.
 *
 * 🔴 **Only third-party analytics.** Never route the app's own origin or `/api/**` through this —
 *    stubbing those would hide exactly the failures this suite exists to catch.
 */
const ANALYTICS_HOSTS = [
  '**://*.googletagmanager.com/**',
  '**://*.google-analytics.com/**',
  '**://*.analytics.google.com/**',
]

export async function stubAnalytics(page: Page): Promise<void> {
  for (const pattern of ANALYTICS_HOSTS) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '/* analytics stubbed by the QA agent */',
      }),
    )
  }
}
