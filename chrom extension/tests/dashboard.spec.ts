import {test,expect} from './helpers/fixtures.js';
import {importWallet,TEST_ADDRESS,PASSWORD} from './helpers/wallet.js';

test('dashboard displays simulated MPC and BNB balances with history navigation',async({page,rpc})=>{
  await importWallet(page);
  await expect(page.getByText('1,000',{exact:true})).toBeVisible();
  await expect(page.getByText('1 BNB',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'View all',exact:true}).click();
  await expect(page.getByRole('heading',{name:'History',exact:true})).toBeVisible();
  expect(rpc.calls.some(c=>c.method==='eth_getLogs')).toBe(true);
});
test('receive displays imported address, QR code and network warning',async({page})=>{
  await importWallet(page); await page.getByRole('button',{name:'Receive',exact:true}).click();
  await expect(page.getByRole('img',{name:'QR code of your wallet address'})).toBeVisible();
  expect((await page.locator('body').innerText()).replace(/\s/g,'').toLowerCase()).toContain(TEST_ADDRESS.toLowerCase());
  await expect(page.getByRole('alert')).toContainText('Assets sent on another network may be lost');
  await page.getByRole('button',{name:'Copy',exact:true}).click();
  await expect(page.getByRole('button',{name:'Copied',exact:true})).toBeVisible();
});
test('lock rejects wrong password then unlocks with correct password',async({page})=>{
  await importWallet(page); await page.getByRole('button',{name:'Lock',exact:true}).click();
  await expect(page.getByText('MPC balance',{exact:true})).not.toBeVisible();
  await page.getByLabel('Password',{exact:true}).fill('Wrong!Quartz9');
  await page.getByRole('button',{name:'Unlock',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('MPC balance',{exact:true})).not.toBeVisible();
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByRole('button',{name:'Unlock',exact:true}).click();
  await expect(page.getByText('MPC balance',{exact:true})).toBeVisible();
});
test('settings persist auto-lock and language after reload',async({page})=>{
  await importWallet(page); await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByText('Chain ID 97',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Lock after'}).selectOption('5');
  await page.getByRole('combobox',{name:'Language'}).selectOption('ko');
  await expect(page.getByRole('combobox',{name:'언어'})).toHaveValue('ko');
  await page.reload();
  await page.getByRole('button',{name:'설정',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'언어'})).toHaveValue('ko');
  await expect(page.getByRole('combobox',{name:'자동 잠금'})).toHaveValue('5');
  await page.getByRole('combobox',{name:'언어'}).selectOption('en');
  await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
});
test('dashboard warns when wallet has no BNB',async({page,rpc})=>{
  rpc.bnb=0n; await importWallet(page);
  await expect(page.getByText('You need a little BNB to pay network fees before you can send MPC.',{exact:true})).toBeVisible();
});
test('dashboard hides balances and disables send for wrong token',async({page,rpc})=>{
  rpc.symbol='FAKE'; await importWallet(page);
  await expect(page.getByText(/The configured token contract is not MPC/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
  await expect(page.getByText('1,000',{exact:true})).not.toBeVisible();
});
test('dashboard reports network failure and recovers on retry',async({page,rpc})=>{
  rpc.offline=true; await importWallet(page);
  await expect(page.getByText('Balances could not be loaded.',{exact:true})).toBeVisible({timeout:25000});
  rpc.offline=false; await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByText('1,000',{exact:true})).toBeVisible();
});
