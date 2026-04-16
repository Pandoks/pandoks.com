import { expect, test } from '@playwright/test';

test('preloaded routes do not refetch on repeated navigation', async ({ page }) => {
  await page.goto('/');

  // Wait for idle preloading to complete
  await page.waitForFunction(() => {
    return performance.getEntriesByType('resource').some((e) => e.name.includes('__data.json'));
  }, { timeout: 10000 });

  // Small buffer for all preloads to settle
  await page.waitForTimeout(1000);

  // First navigation to /blog — should use preloaded cache
  await page.click('a[href="/blog"]');
  await page.waitForURL('/blog');

  // Navigate away to /socials
  await page.click('a[href="/socials"]');
  await page.waitForURL('/socials');

  // Clear resource timing entries so we can detect new fetches
  await page.evaluate(() => performance.clearResourceTimings());

  // Navigate back to /blog — should still use cached data, no new fetch
  await page.click('a[href="/blog"]');
  await page.waitForURL('/blog');

  // Allow any pending fetches to complete
  await page.waitForTimeout(500);

  const dataFetches = await page.evaluate(() =>
    performance.getEntriesByType('resource').filter((e) => e.name.includes('__data.json')).length
  );

  expect(dataFetches).toBe(0);
});
