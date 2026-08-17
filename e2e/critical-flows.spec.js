// e2e/critical-flows.spec.js —— 关键用户旅程 E2E 测试。
import { test, expect } from '@playwright/test';

function latestApprovalCard(page) {
  return page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
}

test.describe('关键用户旅程', () => {

  test('创建任务 + 流式输出', async ({ page }) => {
    await page.goto('/');

    // Wait for the page to load and socket to connect
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // Type a message and send
    const input = page.locator('#msg-input');
    await input.fill('hello world');
    await page.locator('#send-btn').click();

    // User message bubble should appear
    await expect(page.locator('.msg.user').filter({ hasText: 'hello world' }).last()).toBeVisible();

    // Codex response should stream in (mock returns "Mock response to: hello world")
    await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: hello world' }).last()).toBeVisible({ timeout: 10000 });

    // Status should return to idle
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  test('斜杠命令 /status', async ({ page }) => {
    await page.goto('/');

    // Wait for connection and idle state
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // Send /status command
    const input = page.locator('#msg-input');
    await input.fill('/status');
    await page.locator('#send-btn').click();

    // Wait for idle again (response complete)
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // Should receive status response - use text locator to find the specific message
    await expect(page.getByText('当前没有活跃目标').last()).toBeVisible({ timeout: 10000 });
  });

  test('发送中断信号', async ({ page }) => {
    await page.goto('/');

    // Wait for connection and idle
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // Send a message
    const input = page.locator('#msg-input');
    await input.fill('long task');
    await page.locator('#send-btn').click();

    // Wait for state to leave idle (message sent)
    await expect(page.locator('#state-label')).not.toHaveText('idle', { timeout: 5000 });

    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'stop');
    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await expect(page.getByText('已中断').last()).toBeVisible({ timeout: 10000 });
  });

  test('进行中可追加一条，停止钮仍可中断', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('SLOW_TURN');
    await page.locator('#send-btn').click();
    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'stop', { timeout: 5000 });
    await expect(page.locator('#followup-btn')).toBeHidden();

    await page.locator('#msg-input').fill('FOLLOW_UP');
    await expect(page.locator('#followup-btn')).toBeVisible();
    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'stop');
    await page.locator('#followup-btn').click();

    await expect(page.locator('.msg.user').filter({ hasText: 'FOLLOW_UP' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('已向当前运行任务追加指令').last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#followup-btn')).toBeHidden();
    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'stop');

    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  test('页面加载后显示 header 元素', async ({ page }) => {
    await page.goto('/');

    // Header should be visible
    await expect(page.locator('#header')).toBeVisible();
    await expect(page.locator('#header-context')).toBeVisible();
    await expect(page.locator('#status-dot')).toBeVisible();
    // session-meta is hidden by default (CSS display:none), only shown on tap
    await expect(page.locator('#session-meta')).toBeAttached();
  });

  test('助手回复按 Markdown 渲染', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('MARKDOWN_FIXTURE');
    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const bubble = page.locator('.msg.codex .bubble.md').last();
    await expect(bubble.locator('strong')).toHaveText('bold');
    await expect(bubble.locator('code')).toHaveText('code');
    await expect(bubble.locator('li')).toHaveCount(2);
  });

  test('输入区域元素存在', async ({ page }) => {
    await page.goto('/');

    // Input area elements
    await expect(page.locator('#msg-input')).toBeVisible();
    await expect(page.locator('#send-btn')).toBeHidden();
    await expect(page.locator('#interrupt-btn')).toHaveCount(0);
    await expect(page.locator('#attach-btn')).toBeVisible();
  });

  test('移动端视口布局正确', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // Header should be visible
    await expect(page.locator('#header')).toBeVisible();

    // Input area should be at the bottom
    const inputArea = page.locator('#input-area');
    await expect(inputArea).toBeVisible();

    // Messages container should exist
    await expect(page.locator('#messages')).toBeAttached();
  });

  test('软键盘弹起时布局自适应', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 520 }); // Simulate keyboard up
    await page.goto('/');

    // Input should still be visible
    await expect(page.locator('#msg-input')).toBeVisible();
    await expect(page.locator('#attach-btn')).toBeVisible();
  });

  test('会话恢复：刷新后重新连接', async ({ page }) => {
    await page.goto('/');

    // Wait for connection
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // Send a message first
    const input = page.locator('#msg-input');
    await input.fill('before refresh');
    await page.locator('#send-btn').click();

    // Wait for response
    await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: before refresh' }).last()).toBeVisible({ timeout: 10000 });

    // Refresh the page
    await page.reload();

    // Should reconnect
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('.msg.user').filter({ hasText: 'before refresh' }).last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: before refresh' }).last()).toBeVisible({ timeout: 10000 });
  });

  test('审批流程：发送需要审批的命令并批准', async ({ page }) => {
    await page.goto('/');

    // Wait for connection and idle
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // Send a message that triggers approval (mock recognizes 'approve' keyword)
    const input = page.locator('#msg-input');
    await input.fill('approve this command');
    await page.locator('#send-btn').click();

    // Wait for approval card to appear (uses .approve-btn class)
    const approveCard = latestApprovalCard(page);
    await expect(approveCard).toBeVisible({ timeout: 10000 });

    // Click the approve button
    await approveCard.getByRole('button', { name: '批准' }).click();

    // Wait for the turn to complete (command executed after approval)
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 15000 });

    // Should see the tool result with exit: 0 (command executed successfully)
    await expect(page.getByText('exit: 0').last()).toBeVisible({ timeout: 10000 });
  });

  test('审批流程：拒绝审批', async ({ page }) => {
    await page.goto('/');

    // Wait for connection and idle
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // Send a message that triggers approval
    const input = page.locator('#msg-input');
    await input.fill('approve this command');
    await page.locator('#send-btn').click();

    // Wait for approval card to appear
    const declineCard = latestApprovalCard(page);
    await expect(declineCard).toBeVisible({ timeout: 10000 });

    // Click the decline button (uses .deny-btn class)
    await declineCard.getByRole('button', { name: '拒绝' }).click();

    // Wait for the turn to complete (declined)
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 15000 });

    // Should see decline message
    await expect(page.locator('.msg.system-msg, .msg.error-msg').filter({ hasText: 'declined' }).last()).toBeVisible({ timeout: 10000 });
  });

});
