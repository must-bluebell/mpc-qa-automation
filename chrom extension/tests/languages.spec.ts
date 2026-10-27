import { readFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, parseUnits, recoverTransactionAddress, type TransactionSerializedLegacy } from 'viem';
import { test, expect } from './helpers/fixtures.js';
import { importWallet, PASSWORD, TEST_ADDRESS } from './helpers/wallet.js';
import { MockRpc, TOKEN_ADDRESS } from './helpers/rpc.js';

// Pinned copy from the supplied build, independent of the UI at test runtime.
// Verifies rendering and fallback regressions, not native-speaker translation quality.
const copy: Record<string, { common: Record<string, string>; settings: Record<string, string>; send: Record<string, any> }> = JSON.parse(readFileSync(new URL('./helpers/locale-copy.json', import.meta.url), 'utf8'));
const recipient = '0xee86a8e2F4343a0E969C3b74309F431bEee74f66';
const locales = ['en', 'ko', 'zh', 'mn'];
async function selectLanguage(page: Page, locale: string) {
  await importWallet(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(await page.getByRole('combobox', { name: 'Language', exact: true }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(locales);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption(locale);
  await expect(page.getByRole('heading', { name: copy[locale].settings.title, exact: true })).toBeVisible();
}
async function sendForm(page: Page, locale: string, amount: string, to = recipient) {
  const { common: c, send: s } = copy[locale];
  await page.reload();
  await page.getByRole('button', { name: c.send, exact: true }).click();
  await expect(page.getByRole('heading', { name: s.title, exact: true })).toBeVisible();
  await expect(page.getByText(s.bnbChainOnly, { exact: true })).toBeVisible();
  await page.getByLabel(s.recipient, { exact: true }).fill(to);
  await page.getByLabel(s.amount, { exact: true }).fill(amount);
}
async function transfer(page: Page, rpc: MockRpc, info: TestInfo, locale: string, amount: string, index: number) {
  const { common: c, send: s } = copy[locale];
  await sendForm(page, locale, amount);
  await page.getByRole('button', { name: s.continue, exact: true }).click();
  await expect(page.getByRole('heading', { name: s.reviewTitle, exact: true })).toBeVisible();
  await expect(page.getByText(s.irreversible, { exact: true })).toBeVisible();
  expect((await page.locator('body').innerText()).replace(/\s/g, '').toLowerCase()).toContain(recipient.toLowerCase());
  expect(rpc.rawTransactions).toHaveLength(index);
  await expect(page.getByRole('button', { name: s.confirm, exact: true })).toBeDisabled();
  await page.getByLabel(c.password, { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: s.confirm, exact: true }).click();
  await expect(page.getByRole('heading', { name: s.confirmedTitle, exact: true })).toBeVisible();
  expect(rpc.rawTransactions).toHaveLength(index + 1);
  const raw = rpc.rawTransactions[index];
  const tx = parseTransaction(raw);
  expect(tx.chainId).toBe(97);
  expect(tx.nonce).toBe(index);
  expect(tx.to?.toLowerCase()).toBe(TOKEN_ADDRESS.toLowerCase());
  expect(tx.value ?? 0n).toBe(0n);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
  expect(decoded.functionName).toBe('transfer');
  expect(String(decoded.args![0]).toLowerCase()).toBe(recipient.toLowerCase());
  expect(decoded.args![1]).toBe(parseUnits(amount, 18));
  expect((await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerializedLegacy })).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  const hash = keccak256(raw);
  expect(rpc.calls.some(call => call.method === 'eth_getTransactionReceipt' && call.params[0] === hash)).toBe(true);
  const explorer = page.getByRole('link', { name: c.viewOnExplorer, exact: true });
  await expect(explorer).toHaveAttribute('href', `https://testnet.bscscan.com/tx/${hash}`);
  await info.attach(`transfer-${locale}-${index + 1}`, { body: JSON.stringify({ simulated: true, locale, recipient, amount, chainId: 97, nonce: tx.nonce, hash, token: TOKEN_ADDRESS, sender: TEST_ADDRESS }, null, 2), contentType: 'application/json' });
  await info.attach(`confirmation-${locale}-${index + 1}`, { body: await page.screenshot(), contentType: 'image/png' });
}

for (const locale of locales) {
  test(`${locale}: settings text and all auto-lock choices persist`, async ({ page }, info) => {
    const { common: c, settings: s } = copy[locale];
    await selectLanguage(page, locale);
    for (const key of ['preferences', 'security', 'networkSection', 'support']) {
      await expect(page.getByRole('heading', { name: s[key], exact: true })).toBeVisible();
    }
    for (const key of ['revealPhrase', 'changePassword', 'removeWallet']) {
      await expect(page.getByRole('button', { name: s[key], exact: true })).toBeVisible();
    }
    for (const key of ['terms', 'privacy', 'help']) {
      await expect(page.getByRole('link', { name: s[key], exact: true })).toHaveAttribute('href', /^https:\/\//);
    }
    await expect(page.getByText(`${s.chainId} 97`, { exact: true })).toBeVisible();
    await expect(page.getByText('bsc-testnet-rpc.publicnode.com', { exact: true })).toBeVisible();
    await expect(page.getByText(s.sendingOn, { exact: true })).toBeVisible();
    await expect(page.getByText(s.version, { exact: true })).toBeVisible();
    for (const minutes of ['1', '2', '5', '15']) {
      await page.getByRole('combobox', { name: s.autoLock, exact: true }).selectOption(minutes);
      await page.reload();
      await page.getByRole('button', { name: c.settings, exact: true }).click();
      await expect(page.getByRole('combobox', { name: s.language, exact: true })).toHaveValue(locale);
      await expect(page.getByRole('combobox', { name: s.autoLock, exact: true })).toHaveValue(minutes);
    }
    await info.attach(`settings-${locale}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('combobox', { name: s.language, exact: true }).selectOption('en');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  });

  test(`${locale}: security settings gates and cancellation use localized text`, async ({ page, rpc }) => {
    const { common: c, settings: s } = copy[locale];
    await selectLanguage(page, locale);
    await page.getByRole('button', { name: s.revealPhrase, exact: true }).click();
    await expect(page.getByRole('heading', { name: s.revealTitle, exact: true })).toBeVisible();
    await expect(page.getByText(s.revealWarning, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: s.revealConfirm, exact: true })).toBeDisabled();
    await page.getByLabel(c.password, { exact: true }).fill('Wrong!Quartz9');
    await page.getByRole('button', { name: s.revealConfirm, exact: true }).click();
    await expect(page.getByLabel(c.password, { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('ol li')).toHaveCount(0);
    await page.getByRole('button', { name: c.back, exact: true }).click();
    await page.getByRole('button', { name: s.changePassword, exact: true }).click();
    await expect(page.getByRole('heading', { name: s.changeTitle, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: s.changeConfirm, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: c.back, exact: true }).click();
    await page.getByRole('button', { name: s.removeWallet, exact: true }).click();
    await expect(page.getByRole('heading', { name: s.removeTitle, exact: true })).toBeVisible();
    await expect(page.getByText(s.removeBody, { exact: true })).toBeVisible();
    const remove = page.getByRole('button', { name: s.removeConfirm, exact: true });
    await expect(remove).toBeDisabled();
    await page.getByRole('checkbox', { name: s.removeCheck, exact: true }).check();
    await page.getByRole('textbox').fill('remove');
    await expect(remove).toBeDisabled();
    await page.getByRole('textbox').fill('REMOVE');
    await expect(remove).toBeEnabled();
    await page.getByRole('button', { name: c.back, exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: c.send, exact: true })).toBeVisible();
    expect(rpc.rawTransactions).toHaveLength(0);
  });

  test(`${locale}: three separate simulated 1 MPC transfers with localized text`, async ({ page, rpc }, info) => {
    test.setTimeout(120_000);
    await selectLanguage(page, locale);
    for (let i = 0; i < 3; i++) await transfer(page, rpc, info, locale, '1', i);
    expect(new Set(rpc.rawTransactions.map(raw => keccak256(raw))).size).toBe(3);
  });

  test(`${locale}: negative transfer inputs show localized errors and never broadcast`, async ({ page, rpc }) => {
    const s = copy[locale].send;
    await selectLanguage(page, locale);
    await sendForm(page, locale, '1');
    for (const [to, amount, error] of [
      ['0x123', '1', 'shape'], [TEST_ADDRESS, '1', 'self'], [TOKEN_ADDRESS, '1', 'tokenContract'],
      [`0x${'0'.repeat(40)}`, '1', 'zeroAddress'],
      [recipient.replace('F4343', 'f4343'), '1', 'checksum'],
      [recipient, '0', 'amountZero'], [recipient, '-1', 'amountFormat'],
      [recipient, '1,1,1', 'amountFormat'], [recipient, '0.0000000000000000001', 'amountPrecision'],
      [recipient, '1000.000000000000000001', 'amountTooHigh'],
    ]) {
      await page.getByLabel(s.recipient, { exact: true }).fill(to);
      await page.getByLabel(s.amount, { exact: true }).fill(amount);
      await page.getByRole('button', { name: s.continue, exact: true }).click();
      await expect(page.getByRole('alert')).toContainText(s.errors[error]);
      expect(rpc.rawTransactions).toHaveLength(0);
    }
  });

  test(`${locale}: failed network receipt uses localized failure text`, async ({ page, rpc }) => {
    const { common: c, send: s } = copy[locale];
    rpc.receiptStatus = '0x0';
    await selectLanguage(page, locale);
    await sendForm(page, locale, '1');
    await page.getByRole('button', { name: s.continue, exact: true }).click();
    await page.getByLabel(c.password, { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: s.confirm, exact: true }).click();
    await expect(page.getByRole('heading', { name: s.failedTitle, exact: true })).toBeVisible();
    await expect(page.getByText(s.failedBody, { exact: true })).toBeVisible();
    expect(rpc.rawTransactions).toHaveLength(1);
    await expect(page.getByRole('heading', { name: s.confirmedTitle, exact: true })).not.toBeVisible();
  });
}

test('simulated 0.001 MPC transfer to the requested wallet is verified', async ({ page, rpc }, info) => {
  await importWallet(page);
  await transfer(page, rpc, info, 'en', '0.001', 0);
});
