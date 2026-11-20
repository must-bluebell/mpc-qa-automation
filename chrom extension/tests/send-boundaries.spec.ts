import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerializedLegacy } from 'viem';
import { test, expect } from './helpers/fixtures.js';
import { TOKEN_ADDRESS } from './helpers/rpc.js';
import { importWallet, openSend, PASSWORD, RECIPIENT, TEST_ADDRESS } from './helpers/wallet.js';

for (const [name, amount, units] of [
  ['0.01 MPC', '0.01', 10000000000000000n],
  ['smallest MPC unit', '0.000000000000000001', 1n],
  ['entire available balance', '1000', 1000000000000000000000n],
] as const) {
  test(`simulated transfer sends exactly ${name} once`, async ({ page, rpc }, info) => {
    await importWallet(page);
    await openSend(page, RECIPIENT, amount);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible();
    expect(rpc.rawTransactions).toHaveLength(0);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Send now', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();

    expect(rpc.rawTransactions).toHaveLength(1);
    const raw = rpc.rawTransactions[0];
    const tx = parseTransaction(raw);
    expect(tx.chainId).toBe(97);
    expect(tx.to?.toLowerCase()).toBe(TOKEN_ADDRESS.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([expect.stringMatching(new RegExp(`^${RECIPIENT}$`, 'i')), units]);
    expect(tx.type).toBe('legacy');
    expect((await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerializedLegacy })).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    const hash = keccak256(raw);
    expect(rpc.calls.filter(call => call.method === 'eth_getTransactionReceipt').map(call => call.params[0])).toContain(hash);
    await info.attach('simulated-transfer-verification', {
      body: JSON.stringify({ simulated: true, chainId: 97, token: TOKEN_ADDRESS, sender: TEST_ADDRESS, recipient: RECIPIENT, amount, units: units.toString(), hash, broadcasts: 1 }, null, 2),
      contentType: 'application/json',
    });
  });
}

test('one smallest unit above balance is rejected without rounding', async ({ page, rpc }) => {
  await importWallet(page);
  await openSend(page, RECIPIENT, '1000.000000000000000001');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This is more MPC than you have.');
  expect(rpc.rawTransactions).toHaveLength(0);
});

test('missing recipient disables review even with a valid amount', async ({ page, rpc }) => {
  await importWallet(page);
  await openSend(page, '', '0.01');
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeDisabled();
  expect(rpc.rawTransactions).toHaveLength(0);
});

test('review requires a password before send is enabled', async ({ page, rpc }) => {
  await importWallet(page);
  await openSend(page, RECIPIENT, '0.01');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send now', exact: true })).toBeDisabled();
  expect(rpc.rawTransactions).toHaveLength(0);
});

test('closing review before confirmation never broadcasts', async ({ page, rpc }) => {
  await importWallet(page);
  await openSend(page, RECIPIENT, '0.01');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('MPC balance', { exact: true })).toBeVisible();
  expect(rpc.rawTransactions).toHaveLength(0);
});
