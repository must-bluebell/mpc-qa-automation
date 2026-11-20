import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress, type TransactionSerializedLegacy } from 'viem';
import { TOKEN_ADDRESS } from './helpers/rpc.js';
import { test,expect } from './helpers/fixtures.js';
import { importWallet,openSend,RECIPIENT,TEST_ADDRESS,PASSWORD } from './helpers/wallet.js';
for (const [name,to,amount,error] of [
  ['malformed address','0x123','1','Enter a full address: 0x and 40 characters.'],
  ['zero address',`0x${'0'.repeat(40)}`,'1','This address cannot receive tokens.'],
  ['self transfer',TEST_ADDRESS,'1','This is your own address.'],
  ['zero amount',RECIPIENT,'0','Enter an amount above zero.'],
  ['negative amount',RECIPIENT,'-1','Enter a number, for example 12.5.'],
  ['excess precision',RECIPIENT,'0.0000000000000000001','MPC has at most 18 decimals.'],
  ['insufficient token balance',RECIPIENT,'1001','This is more MPC than you have.'],
]) test(`send rejects ${name}`,async({page,rpc})=>{
  await importWallet(page); await openSend(page,to,amount);
  await expect(page.getByText('Available: 1,000 MPC',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(error);
  expect(rpc.rawTransactions).toHaveLength(0);
});
test('send requires both fields and Max uses available balance',async({page})=>{
  await importWallet(page); await openSend(page,RECIPIENT,'');
  await expect(page.getByRole('button',{name:'Review',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Max',exact:true}).click();
  await expect(page.getByLabel('Amount (MPC)')).toHaveValue('1000');
  await expect(page.getByRole('button',{name:'Review',exact:true})).toBeEnabled();
});
for (const [status,title] of [['0x1','Transfer confirmed'],['0x0','Transfer failed on the network']]) {
  test(`simulated transfer receipt ${status}: validates signed recipient amount and chain`,async({page,rpc})=>{
    rpc.receiptStatus=status;
    await importWallet(page); await openSend(page,RECIPIENT,'2.5');
    await page.getByRole('button',{name:'Review',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Review transfer'})).toBeVisible();
    expect((await page.locator('body').innerText()).replace(/\s/g,'').toLowerCase()).toContain(RECIPIENT);
    await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
    await page.getByRole('button',{name:'Send now',exact:true}).click();
    await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
    expect(rpc.rawTransactions).toHaveLength(1);
    const tx=parseTransaction(rpc.rawTransactions[0]);
    expect(tx.chainId).toBe(97);
    expect(tx.to?.toLowerCase()).toBe(TOKEN_ADDRESS.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    const decoded=decodeFunctionData({abi:erc20Abi,data:tx.data!});
    expect(decoded.functionName).toBe('transfer');
    expect(String(decoded.args![0]).toLowerCase()).toBe(RECIPIENT);
    expect(decoded.args![1]).toBe(2500000000000000000n);
    expect((await recoverTransactionAddress({serializedTransaction:rpc.rawTransactions[0] as TransactionSerializedLegacy})).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });
}
test('wrong RPC chain blocks signing and broadcasting',async({page,rpc})=>{
  rpc.chainId='0x38'; await importWallet(page); await openSend(page);
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByRole('button',{name:'Send now',exact:true}).click();
  await expect(page.getByText('The network connection is not BNB Smart Chain. Nothing was sent.',{exact:true})).toBeVisible();
  expect(rpc.rawTransactions).toHaveLength(0);
});
test('high gas price blocks review without broadcasting',async({page,rpc})=>{
  rpc.gasPrice=`0x${(51n*10n**9n).toString(16)}`;
  await importWallet(page); await openSend(page);
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('The network fee is unusually high');
  expect(rpc.rawTransactions).toHaveLength(0);
});
test('insufficient BNB blocks signing',async({page,rpc})=>{
  rpc.bnb=0n; await importWallet(page); await openSend(page);
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByRole('button',{name:'Send now',exact:true}).click();
  await expect(page.getByText(/You need .* BNB for the network fee/)).toBeVisible();
  expect(rpc.rawTransactions).toHaveLength(0);
});
test('wrong transfer password cannot broadcast',async({page,rpc})=>{
  await importWallet(page); await openSend(page);
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('Wrong!Quartz9');
  await page.getByRole('button',{name:'Send now',exact:true}).click();
  await expect(page.getByText(/Wrong password/)).toBeVisible();
  expect(rpc.rawTransactions).toHaveLength(0);
});
