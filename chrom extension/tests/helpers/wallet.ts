import { expect, type Page } from '@playwright/test';
export const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const TEST_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
export const RECIPIENT = '0xe46d2a8c9ae04517373b8c9c468dfa5db2d381df';
export const PASSWORD = 'Cobalt!River9$Quartz';
export async function startImport(page: Page) {
  await page.getByRole('button', {name:'I already have a recovery phrase'}).click();
  await page.getByRole('button', {name:'I understand',exact:true}).click();
}
export async function passwordStep(page: Page) {
  await startImport(page);
  await page.getByLabel('Recovery phrase',{exact:true}).fill(PHRASE);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Is this your wallet?'})).toBeVisible();
  expect((await page.locator('body').innerText()).replace(/\s/g,'').toLowerCase()).toContain(TEST_ADDRESS.toLowerCase());
  await page.getByRole('button',{name:'Yes, this is my wallet'}).click();
}
export async function setPassword(page: Page, submit = 'Import wallet', password = PASSWORD) {
  await page.getByLabel('New password',{exact:true}).fill(password);
  await page.getByLabel('Confirm password',{exact:true}).fill(password);
  await page.getByRole('button',{name:submit,exact:true}).click();
}
export async function importWallet(page: Page) {
  await passwordStep(page); await setPassword(page);
  await expect(page.getByText('MPC balance',{exact:true})).toBeVisible();
}
export async function openSend(page: Page, to = RECIPIENT, amount = '1') {
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByLabel('Recipient address').fill(to);
  await page.getByLabel('Amount (MPC)').fill(amount);
}
