import { expect, test } from '@playwright/test';

test('home page renders the human experience tagline', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Human Experience')).toBeVisible();
});

test('clicking a wallet yanks its full address', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const wallet = page.getByRole('button', { name: /^xmr / });
  await wallet.click();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^\S+$/);
  await expect(wallet).toHaveText(`xmr ${copied}`);
});
