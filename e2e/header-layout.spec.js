// e2e/header-layout.spec.js —— 顶部导航紧凑度 + Native 控制栏折叠收纳守护。
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

const MAX_HEADER_HEIGHT = 58; // 标题栏紧凑上限,单位 px(基线约 65)
const MAX_TITLE_HEIGHT = 44; // 标题行单行高度上限(折成两行会 >48px)

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

    // 单行标题("Codex Chat" + 状态徽章 + 模式药丸)在 Pixel 5 宽度下不应折行成两行。
    const title = await layoutBox(page, '#header-title');
    expect(
      title.height,
      `标题栏应为单行(实测高度 ${Math.round(title.height)}px)`,
    ).toBeLessThanOrEqual(MAX_TITLE_HEIGHT);
  });

  test('工具控制栏收进抽屉,顶部不再有常驻工具行', async ({ page }) => {
    await connect(page);

    // 顶部不再有工具入口行:控制栏已整体移进左侧抽屉。
    await expect(page.locator('#native-controls-toggle'), '顶部工具入口应已移除').toHaveCount(0);
    await expect(page.locator('#native-controls'), '默认(抽屉关闭)控制栏不在视口内').not.toBeInViewport();

    // 打开抽屉:控制栏进入视口,按钮可见可点。
    await page.locator('#menu-btn').click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    await expect(page.locator('#native-controls'), '开抽屉后控制栏进入视口').toBeInViewport();
    await expect(page.locator('#native-thread-refresh'), '开抽屉后按钮应可见').toBeVisible();

    // 点工具按钮:抽屉关闭,数据面板在主区展开。
    await page.locator('#native-thread-refresh').click();
    await expect(page.locator('#drawer'), '点工具按钮后抽屉应关闭').not.toHaveClass(/open/);
    await expect(page.locator('#native-panel'), '数据面板应在主区展开').toBeVisible();
  });
});
