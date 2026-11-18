import { test, expect } from './helpers/fixtures.js';
import { importWallet, passwordStep, setPassword, startImport, PASSWORD } from './helpers/wallet.js';

test('imports a public test wallet and opens dashboard', async ({page}) => {
  await importWallet(page);
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
});
for (const [name,phrase,error] of [
  ['word count','abandon abandon','A recovery phrase has 12, 15, 18, 21 or 24 words.'],
  ['unknown word', `${'abandon '.repeat(11)}notaword`, 'One of the words is not a recovery phrase word. Check the spelling.'],
  ['checksum', 'abandon '.repeat(12).trim(), 'These words are not a valid recovery phrase. Check the words and their order.'],
] as const) test(`import rejects invalid ${name}`, async ({page}) => {
  await startImport(page); await page.getByLabel('Recovery phrase',{exact:true}).fill(phrase);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(error);
  await expect(page.getByLabel('Recovery phrase',{exact:true})).toHaveAttribute('aria-invalid','true');
});
for (const [name,password,error] of [
  ['short','Ab!9','Use at least 10 characters.'],
  ['numeric','928374650192','Use letters too, not only numbers.'],
  ['repetitive','aaaaaaaaaaaa','Use more different characters.'],
  ['long','Xr!9'.repeat(33),'Use at most 128 characters.'],
] as const) test(`password rejects ${name} input`, async ({page}) => {
  await passwordStep(page); await setPassword(page,'Import wallet',password);
  await expect(page.getByText(error,{exact:true})).toBeVisible();
  await expect(page.getByLabel('New password',{exact:true})).toHaveAttribute('aria-invalid','true');
});
test('password confirmation must match and passwords are masked',async ({page})=>{
  await passwordStep(page);
  await page.getByLabel('New password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password',{exact:true}).fill('Different!Quartz9');
  await expect(page.getByLabel('New password',{exact:true})).toHaveAttribute('type','password');
  await page.getByRole('button',{name:'Import wallet',exact:true}).click();
  await expect(page.getByText('The passwords do not match.',{exact:true})).toBeVisible();
});
test('creates a new wallet after verifying backup words',async ({page})=>{
  await page.getByRole('button',{name:'Create a new wallet'}).click();
  await page.getByRole('button',{name:'I understand',exact:true}).click();
  await expect(page.locator('ol li')).toHaveCount(12);
  await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeDisabled();
  const hold = page.getByRole('button',{name:/hold/i});
  await hold.focus(); await page.keyboard.down('Space');
  const words = await page.locator('ol li span:last-child').allTextContents();
  expect(words.every(word=>/^[a-z]+$/.test(word))).toBe(true);
  await page.keyboard.up('Space');
  await expect(page.locator('ol li span:last-child').first()).toHaveText('•••••');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  for (const input of await page.locator('input[id^="word-"]').all()) await input.fill('wrong');
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Those words do not match');
  for (const input of await page.locator('input[id^="word-"]').all()) {
    const position = Number((await input.getAttribute('id'))!.split('-')[1]);
    const word = words[position];
    if (!word) throw new Error(`Missing recovery word at position ${position}`);
    await input.fill(word);
  }
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await setPassword(page,'Create wallet');
  await expect(page.getByText('MPC balance',{exact:true})).toBeVisible();
});
