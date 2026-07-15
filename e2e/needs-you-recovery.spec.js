import { test, expect } from '@playwright/test';

test('a fresh mobile page recovers and resolves a pending cross-thread approval', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('approve needs-you recovery');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card').filter({ hasText: '需要审批' }).last()).toBeVisible({ timeout: 10000 });

  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const freshPage = await freshContext.newPage();
  try {
    await freshPage.goto('http://localhost:3232/');
    await expect(freshPage.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    const needsPanel = freshPage.locator('#needs-you-panel');
    await expect(needsPanel).toBeVisible({ timeout: 10000 });
    await expect(needsPanel).toContainText('approve needs-you recovery');
    await needsPanel.locator('[data-need-action="open"]').click();

    const recoveredCard = freshPage.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    await expect(recoveredCard).toBeVisible();
    await recoveredCard.locator('.approve-btn[data-d="accept"]').click();
    await expect(recoveredCard).toContainText('已批准');
    await expect(needsPanel).toBeHidden();
  } finally {
    await freshContext.close();
  }
});

test('a needs-you deep link opens the exact pending approval', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
  await page.locator('#msg-input').fill('approve needs-you deep link');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card').filter({ hasText: '需要审批' }).last()).toBeVisible({ timeout: 10000 });

  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const freshPage = await freshContext.newPage();
  try {
    await freshPage.goto('http://localhost:3232/');
    const row = freshPage.locator('#needs-you-panel [data-need-id]').filter({ hasText: 'approve needs-you deep link' });
    await expect(row).toBeVisible({ timeout: 10000 });
    const needId = await row.getAttribute('data-need-id');
    const threadId = (await row.locator('.needs-you-thread').innerText()).trim();

    await freshPage.goto(`http://localhost:3232/?thread=${encodeURIComponent(threadId)}&need=${encodeURIComponent(needId)}`);
    const recoveredCard = freshPage.locator('.tool-card').filter({ hasText: 'approve needs-you deep link' }).last();
    await expect(recoveredCard).toBeVisible({ timeout: 10000 });
    await recoveredCard.locator('.deny-btn').click();
    await expect(recoveredCard).toContainText('已拒绝');
  } finally {
    await freshContext.close();
  }
});
