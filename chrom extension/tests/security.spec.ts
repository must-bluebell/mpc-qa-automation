import { test, expect } from './helpers/fixtures.js';
import { importWallet, PASSWORD, PHRASE, setPassword } from './helpers/wallet.js';

test('password change requires old password and invalidates it', async ({page}) => {
  await importWallet(page);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Change password',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const next='Jasper!Cedar7$Moon';
  await setPassword(page,'Save new password',next);
  await expect(page.getByText('Password changed.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Lock',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByRole('button',{name:'Unlock',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Wrong password');
  await page.getByLabel('Password',{exact:true}).fill(next);
  await page.getByRole('button',{name:'Unlock',exact:true}).click();
  await expect(page.getByText('MPC balance',{exact:true})).toBeVisible();
});
test('phrase reveal requires password and hides words after release',async({page})=>{
  await importWallet(page); await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Show recovery phrase',exact:true}).click();
  await expect(page.locator('ol li')).toHaveCount(0);
  await page.getByLabel('Password',{exact:true}).fill('Wrong!Quartz9');
  await page.getByRole('button',{name:'Show phrase',exact:true}).click();
  await expect(page.getByText(/Wrong password/)).toBeVisible();
  await expect(page.locator('ol li')).toHaveCount(0);
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByRole('button',{name:'Show phrase',exact:true}).click();
  const hold=page.getByRole('button',{name:/hold/i});
  await hold.focus(); await page.keyboard.down('Space');
  expect((await page.locator('ol li span:last-child').allTextContents()).join(' ')).toBe(PHRASE);
  await page.keyboard.up('Space');
  await expect(page.locator('ol li span:last-child').first()).toHaveText('•••••');
});
test('removal requires backup acknowledgement and exact typed confirmation',async({page})=>{
  await importWallet(page); await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Remove wallet from this browser',exact:true}).click();
  const remove=page.getByRole('button',{name:'Remove wallet',exact:true});
  await expect(remove).toBeDisabled(); await page.getByRole('checkbox').check();
  await expect(remove).toBeDisabled(); await page.getByLabel('Type REMOVE to confirm.').fill('remove');
  await expect(remove).toBeDisabled(); await page.getByLabel('Type REMOVE to confirm.').fill('REMOVE');
  await remove.click();
  await expect(page.getByRole('button',{name:'Create a new wallet'})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button',{name:'Create a new wallet'})).toBeVisible();
});
test('five wrong passwords trigger lockout that survives reload',async({page})=>{
  await importWallet(page); await page.getByRole('button',{name:'Lock',exact:true}).click();
  for (let i=0;i<5;i++) {
    await page.getByLabel('Password',{exact:true}).fill('Wrong!Quartz9');
    await page.getByRole('button',{name:'Unlock',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText(i===4?'Too many wrong passwords':`Wrong password. ${4-i}`);
  }
  await expect(page.getByLabel('Password',{exact:true})).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Too many wrong passwords');
  await expect(page.getByRole('button',{name:'Unlock',exact:true})).toBeDisabled();
});
