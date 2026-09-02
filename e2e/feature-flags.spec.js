import { test, expect } from '@playwright/test';

// Labs 仍是实验开关，默认关闭就不该出现在控制栏里。宿主配置不再是特性开关——解锁机制拆除后
// 它是直达但逐动作确认的普通操作，所以入口常驻可见。
test('disabled experimental features are absent from the mobile controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#menu-btn').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(page.locator('#native-p3-btn')).toBeHidden();
  await expect(page.locator('#native-admin-btn')).toBeVisible();
});
