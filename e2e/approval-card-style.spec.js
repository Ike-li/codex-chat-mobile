// e2e/approval-card-style.spec.js —— 审批卡按钮的视觉层级守护。
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

// 刺眼的实心大红 var(--error) = #df1c1c。拒绝按钮改为次要样式后不应再是这个背景。
const HARSH_RED = 'rgb(223, 28, 28)';

test.describe('审批卡按钮视觉层级', () => {
  test('拒绝按钮为克制的次要样式,批准按钮为主操作绿', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    await page.locator('#msg-input').fill('approve this command');
    await page.locator('#send-btn').click();

    const card = page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    await expect(card).toBeVisible({ timeout: 10000 });

    const denyBg = await card.locator('.deny-btn').evaluate(
      el => el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor,
    );
    expect(denyBg, '拒绝按钮不应是刺眼的实心大红').not.toBe(HARSH_RED);

    // 批准是主操作,保持 OpenAI 绿实心 —— 白字压底改用文字档 var(--accent-text) #0d8265(4.77:1)。
    const approveBg = await card.locator('.approve-btn').first().evaluate(
      el => el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor,
    );
    expect(approveBg, '批准按钮应保持主操作绿').toBe('rgb(13, 130, 101)');

    const cardBox = await card.boundingBox();
    const messagesBox = await page.locator('#messages').boundingBox();
    expect(cardBox, '审批卡应有布局盒').toBeTruthy();
    expect(messagesBox, '消息区应有布局盒').toBeTruthy();
    expect(
      cardBox.width,
      `审批卡应拉满阅读栏(实测 ${Math.round(cardBox.width)} / ${Math.round(messagesBox.width)})`,
    ).toBeGreaterThan(messagesBox.width * 0.8);

    // 清理:响应审批并等待回到 idle,避免遗留未决状态污染共享 mock server 上的后续用例。
    await card.locator('.approve-btn[data-d="accept"]').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });
});
