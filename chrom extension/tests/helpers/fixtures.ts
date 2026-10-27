import { test as base, expect, chromium, type BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { MockRpc } from './rpc.js';
export const extensionPath = resolve(process.env.EXTENSION_PATH ?? `${homedir()}/Downloads/mpc-wallet-dev-0.1.0.0`);
export const manifest = JSON.parse(readFileSync(resolve(extensionPath, 'manifest.json'), 'utf8'));
if (!manifest.key) throw new Error('EXTENSION_PATH must have a manifest public key for stable extension ID.');
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0,16)]
  .map(b => String.fromCharCode(97+(b>>4),97+(b&15))).join('');
export const popupUrl = `chrome-extension://${extensionId}/${manifest.action.default_popup}`;
export const test = base.extend<{ rpc: MockRpc }>({
  rpc: async ({}, use) => { await use(new MockRpc()); },
  context: async ({ rpc, headless }, use, info) => {
    const context: BrowserContext = await chromium.launchPersistentContext('', {
      channel:'chromium', headless, locale:'en-US', viewport:{width:420,height:800},
      args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`],
    });
    await rpc.install(context);
    await context.tracing.start({ screenshots:true, snapshots:true });
    try { await use(context); }
    finally {
      if (info.status !== info.expectedStatus) {
        const path = info.outputPath('trace.zip');
        await context.tracing.stop({path});
        await info.attach('trace', {path, contentType:'application/zip'});
        for (const [i,page] of context.pages().entries()) {
          if (!page.isClosed()) await info.attach(`page-${i}`, {body:await page.screenshot(),contentType:'image/png'}).catch(()=>{});
        }
      } else await context.tracing.stop();
      await info.attach('rpc-summary', {body:JSON.stringify({methods:rpc.calls.map(c=>c.method),broadcasts:rpc.rawTransactions.length,unexpected:rpc.unexpected},null,2),contentType:'application/json'});
      await context.close();
      expect(rpc.unexpected, 'All external traffic must be explicitly mocked').toEqual([]);
    }
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await page.goto(popupUrl);
    await use(page);
  },
});
export { expect };
