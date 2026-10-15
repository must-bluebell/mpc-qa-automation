import { expect, test, type Locator } from '@playwright/test'

/** Assert independent expected copy, and keep the actual text visible in Playwright reports. */
export async function expectValidationMessage(locator: Locator, expected: string | RegExp, name: string): Promise<void> {
  await test.step(`Validate message: ${name}`, async () => {
    try {
      await expect(locator).toBeVisible()
      await expect(locator).toHaveText(expected)
    } finally {
      const actual = await locator.innerText({ timeout: 1_000 }).catch(() => null)
      await test.info().attach(`validation-${name}`, {
        body: Buffer.from(JSON.stringify({ expected: expected instanceof RegExp ? expected.toString() : expected, actual }, null, 2)),
        contentType: 'application/json',
      })
    }
  })
}
