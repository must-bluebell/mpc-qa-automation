import { expect, type APIRequestContext, type TestInfo } from '@playwright/test'
import { call } from '../../fixtures/api'

/** The check-in attempt window permits three issuances per five minutes for a fresh member. */
export async function expectCheckInRateLimit(request: APIRequestContext, info: TestInfo): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await call(request, info, 'POST', '/api/relay/challenge', { body: { kind: 'checkin' } })
    const evidence = `Attempt ${attempt}: ${JSON.stringify(response.json)}`
    if (attempt <= 3) {
      expect(response.status, evidence).toBe(200)
      expect(response.json?.challenge, evidence).toEqual(expect.any(String))
      expect(response.json?.typedData, evidence).toEqual(expect.any(Object))
    } else {
      expect(response.status, evidence).toBe(429)
      expect(response.json?.error, evidence).toBe('rate_limited')
      expect(response.json?.retryAfterMs, evidence).toEqual(expect.any(Number))
      expect(response.json?.retryAfterMs, evidence).toBeGreaterThan(0)
      expect(response.json?.retryAfterMs, evidence).toBeLessThanOrEqual(300_000)
    }
  }
}
