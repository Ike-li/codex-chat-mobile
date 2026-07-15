import { test, expect } from '@playwright/test';

test('disabled privileged features are absent from the mobile controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#menu-btn').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(page.locator('#native-admin-btn')).toBeHidden();
  await expect(page.locator('#native-p3-btn')).toBeHidden();
});
