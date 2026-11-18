import type { ChromeApi } from './chrome-api.js';
import { expect, type Page } from '@playwright/test';

export async function expectSettingsSaved(page: Page, expected: { locale: string; autoLockMinutes: number }) {
  // selectOption finishes before the extension's asynchronous save. Observe the
  // actual stored values before reload; never write settings from the test.
  await expect.poll(() => page.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    const stored = await chrome.storage.local.get('settings.v1');
    return stored['settings.v1'];
  }), { message: 'Language and auto-lock settings must be saved before reload' })
    .toMatchObject(expected);
}
