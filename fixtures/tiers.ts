import { request as apiRequest } from '@playwright/test'
import { target } from '../config/target'

/**
 * What the current target actually permits.
 *
 * Most of this suite depends on environment wiring we do not control, and an unmet dependency is
 * not a defect. Probing for it lets a tier **skip with a stated reason** instead of failing red —
 * so an incomplete environment reads as "not covered", never as "the app is broken".
 */
export type Capabilities = {
  /**
   * Whether state-changing requests from this origin survive `guardSameOrigin`.
   *
   * 🔴 **Measured false on staging, 2026-08-17.** `globalmpc-webapp.vercel.app` answers
   *    `403 {"error":"cross_origin"}` to any POST whose `Origin` is its own URL, and `200` when the
   *    Origin is `https://app.globalmpc.tech`. So that deployment's `APP_ORIGIN` is set to the
   *    production origin, and **every write from a browser on staging is refused** — sign-in
   *    included. Nothing above tier T0 can run there until that is changed.
   *    (globalmpc-webapp/lib/server/origin.ts:72)
   */
  sameOriginWrites: boolean
  reason?: string
}

let cached: Promise<Capabilities> | undefined

/** Probed once per worker; the answer is a property of the deployment, not of any one test. */
export function capabilities(): Promise<Capabilities> {
  cached ??= probe()
  return cached
}

async function probe(): Promise<Capabilities> {
  const t = target()
  const context = await apiRequest.newContext({ baseURL: t.baseUrl })
  try {
    /**
     * `/api/auth/nonce` is the cheapest guarded write: it issues a nonce into the session and
     * touches nothing else. A browser sends `Origin` on same-origin POSTs, so sending it here
     * reproduces exactly what the app does.
     */
    const res = await context.post('/api/auth/nonce', { headers: { origin: t.baseUrl } })

    if (res.status() === 403 && (await res.text()).includes('cross_origin')) {
      return {
        sameOriginWrites: false,
        reason:
          `${t.baseUrl} rejects its own origin (403 cross_origin) — its APP_ORIGIN is set to a ` +
          `different deployment, so no sign-in or write can succeed from this URL`,
      }
    }

    return res.ok()
      ? { sameOriginWrites: true }
      : {
          sameOriginWrites: false,
          reason: `POST /api/auth/nonce answered ${res.status()} on ${t.baseUrl}`,
        }
  } catch (e) {
    return {
      sameOriginWrites: false,
      reason: `could not reach ${t.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
    }
  } finally {
    await context.dispose()
  }
}
