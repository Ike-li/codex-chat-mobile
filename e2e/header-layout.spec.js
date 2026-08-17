// e2e/header-layout.spec.js —— 顶部导航紧凑度 + Native 控制栏折叠收纳守护。
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

const MAX_HEADER_HEIGHT = 72; // 单行：会话钮 + 工作区胶囊 + home/+

async function layoutBox(page, selector) {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} should have a layout box`).toBeTruthy();
  return box;
}

async function connect(page) {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
}

test.describe('顶部导航紧凑度', () => {
  test('标题栏压薄且不折行', async ({ page }) => {
    await connect(page);
    await expect(page.locator('#header')).toBeVisible();

    const header = await layoutBox(page, '#header');
    expect(
      header.height,
      `标题栏应 ≤ ${MAX_HEADER_HEIGHT}px(实测 ${Math.round(header.height)}px)`,
    ).toBeLessThanOrEqual(MAX_HEADER_HEIGHT);

    await expect(page.locator('#header-context')).toBeVisible();
    await expect(page.locator('#header-project'), '顶栏应显示项目名而不是路径和下拉框').toBeVisible();
    await expect(page.locator('#header-project')).not.toHaveText('');
    await expect(page.locator('#header-home')).toBeVisible();
    await expect(page.locator('#header-new')).toBeVisible();
    await expect(page.locator('#menu-btn')).toBeVisible();
    await expect(page.locator('#status-dot')).toBeVisible();
    await expect(page.locator('#thread-title')).toHaveText('新会话');
    await expect(page.locator('#workdir-container'), '工作区切换只留在抽屉').toBeHidden();
    await expect(page.locator('#header #composer-defaults')).toHaveCount(0);
    await expect(page.locator('#input-area #composer-defaults')).toBeVisible();
    await expect(page.locator('#conn-rtt')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#conn-rtt')).toContainText(/延迟/);
  });

  test('工作区胶囊打开 sheet，首页清空当前会话视图', async ({ page }) => {
    await connect(page);

    await page.locator('#header-context').click();
    await expect(page.locator('#workspace-modal')).toBeVisible();
    await page.locator('#workspace-close').click();
    await expect(page.locator('#workspace-modal')).toBeHidden();

    await page.locator('#msg-input').fill('HEADER_HOME_CLEAR');
    await page.locator('#send-btn').click();
    await expect(page.locator('.msg.user').filter({ hasText: 'HEADER_HOME_CLEAR' })).toBeVisible({
      timeout: 10000,
    });

    await page.locator('#header-home').click();
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('.msg.user').filter({ hasText: 'HEADER_HOME_CLEAR' })).toHaveCount(0);
  });

  test('工具控制栏收进抽屉,顶部不再有常驻工具行', async ({ page }) => {
    await connect(page);

    // 顶部不再有工具入口行:控制栏已整体移进左侧抽屉。
    await expect(page.locator('#native-controls-toggle'), '顶部工具入口应已移除').toHaveCount(0);
    await expect(page.locator('#native-controls'), '默认(抽屉关闭)控制栏不在视口内').not.toBeInViewport();

    await page.locator('#menu-btn').click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    await expect(page.locator('#drawer-tools'), '抽屉主路径不再展示工具面板').toBeHidden();
    await expect(page.locator('#native-thread-refresh'), '工具按钮对用户不可见').toBeHidden();
    await expect(page.locator('#new-session-btn')).toBeVisible();
    await expect(page.locator('#drawer-project')).toBeVisible();
    await expect(page.locator('#drawer-projects')).toBeInViewport();
    await expect.poll(async () => page.locator('#drawer-body').evaluate(el => el.scrollTop)).toBe(0);
  });
});
