import type { ChromeApi } from './helpers/chrome-api.js';
import {test,expect,manifest} from './helpers/fixtures.js';
test('installed extension has only storage permission and no web injection',async({page})=>{
  const installed = await page.evaluate(async()=>{
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    return {manifest:chrome.runtime.getManifest(),permissions:await chrome.permissions.getAll()};
  });
  expect(installed.manifest.version).toBe(manifest.version);
  expect(installed.permissions.permissions).toEqual(['storage']);
  expect(installed.permissions.origins ?? []).toEqual([]);
  expect(installed.manifest.content_scripts ?? []).toEqual([]);
  expect(installed.manifest.externally_connectable).toBeUndefined();
  const csp = installed.manifest.content_security_policy;
  if (!csp || typeof csp === 'string') throw new Error('Expected Manifest V3 CSP');
  expect(csp.extension_pages).toContain("script-src 'self'");
  expect(csp.extension_pages).not.toMatch(/unsafe-eval|unsafe-inline/);
});
