import { expect, test } from '@playwright/test';

test('home page renders the human experience tagline', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Human Experience')).toBeVisible();
});
