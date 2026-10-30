import { expect, test } from '@playwright/test';

test('home page renders the human experience tagline', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Human Experience')).toBeVisible();
});

test('clicking a wallet yanks its full address', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const wallet = page.getByRole('button', { name: /^xmr / });
  await expect(wallet).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  await wallet.click();

  await expect(wallet).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^\S+$/);
  await expect(wallet).toHaveText(`xmr ${copied}`);
  await expect(page.getByRole('status')).toHaveText('xmr copied');
});

test('enter on a focused wallet yanks without vim navigating', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/', { waitUntil: 'networkidle' });
  const wallet = page.getByRole('button', { name: /^xmr / });
  await wallet.focus();
  await page.keyboard.press('l');
  await page.keyboard.press('l');
  await expect(page.getByRole('link', { name: 'Socials' })).toHaveClass(/bg-highlight/);
  await page.keyboard.press('Enter');

  const textColor = await page.locator('body').evaluate((body) => getComputedStyle(body).color);
  await expect(wallet).toHaveCSS('color', textColor);
  await expect(wallet).not.toHaveCSS('color', textColor);
  await expect(page).toHaveURL('/');
});
