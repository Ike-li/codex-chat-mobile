// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

async function connect(page) {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
}

test.describe('工作区、@ 引用与历史卡片', () => {
  test('顶栏打开只读工作区，composer 可用 @ 搜索文件', async ({ page }) => {
    await connect(page);
    await expect(page.locator('#conn-banner')).toBeHidden();

    await page.locator('#header-project').click();
    await expect(page.locator('#workspace-modal')).toBeVisible();
    await expect(page.locator('#file-browse-body')).toContainText(/README|空目录|无法读取/i);

    await page.locator('#workspace-tab-changes').click();
    await expect(page.locator('#git-changes-body')).toBeVisible();
    await page.locator('#workspace-close').click();
    await expect(page.locator('#workspace-modal')).toBeHidden();

    const input = page.locator('#msg-input');
    await input.fill('@');
    await input.pressSequentially('app');
    await expect(page.locator('#at-mention-popup')).toBeVisible();
    await expect(page.locator('#at-mention-popup')).toContainText(/app\.js|没有匹配|无法搜索/);
  });

  test('历史 snapshot 重建文件变更卡片', async ({ page }) => {
    await connect(page);
    await page.locator('#msg-input').fill('FILE_CHANGE_FIXTURE');
    await page.locator('#send-btn').click();
    await expect(page.locator('.file-change-card').last()).toBeVisible({ timeout: 10000 });

    await page.reload();
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('.file-change-card').last()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.file-change-card').last()).toContainText('src/example.js');
  });
});
