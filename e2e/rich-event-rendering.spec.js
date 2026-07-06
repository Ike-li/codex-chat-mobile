// spec: .playwright-mcp/codex-chat-mobile-test-plan-draft.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

async function sendMessage(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

test.describe('P0 协议桥、审批与 Socket.IO', () => {
  test('Rich Event Rendering', async ({ page }) => {
    // 1. Open the home page with the existing baseURL and wait until #state-label is idle.
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 2. Send approve this command.
    const approvalCards = page.locator('.tool-card').filter({ hasText: '需要审批' });
    const approvalCountBeforeApprove = await approvalCards.count();
    await sendMessage(page, 'approve this command');
    const approveCard = approvalCards.nth(approvalCountBeforeApprove);
    await expect(approveCard).toBeVisible({ timeout: 10000 });
    await expect(approveCard).toContainText('approve this command');
    await expect(approveCard).toContainText('needs execution');
    await expect(approveCard.getByRole('button', { name: '批准' })).toBeVisible();
    await expect(approveCard.getByRole('button', { name: '拒绝' })).toBeVisible();

    // 3. Click approve.
    await approveCard.getByRole('button', { name: '批准' }).click();
    await expect(approveCard).toContainText('已批准');
    await expect(page.getByText('exit: 0').last()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('command approved and executed').last()).toBeVisible();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 4. Send approve this command again.
    const approvalCountBeforeDecline = await approvalCards.count();
    await sendMessage(page, 'approve this command');
    const declineCard = approvalCards.nth(approvalCountBeforeDecline);
    await expect(declineCard).toBeVisible({ timeout: 10000 });
    await expect(declineCard).toContainText('approve this command');
    await declineCard.getByRole('button', { name: '拒绝' }).click();
    await expect(declineCard).toContainText('已拒绝');
    await expect(page.locator('.error-msg').last()).toContainText('Approval declined by user', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 5. Send /status.
    await sendMessage(page, '/status');
    await expect(page.getByText('当前没有活跃目标').last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 6. Send a normal message.
    await sendMessage(page, 'rich event plain message');
    await expect(page.locator('.msg.user').last()).toContainText('rich event plain message');
    await expect(page.locator('.msg.codex').last()).toContainText('Mock response to: rich event plain message', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });
});
