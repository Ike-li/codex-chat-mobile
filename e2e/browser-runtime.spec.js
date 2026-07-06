// spec: .playwright-mcp/codex-chat-mobile-test-plan-draft.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

const forbiddenRuntimeErrors = [
  /TypeError/i,
  /Cannot set properties of null/i,
  /ServiceWorker.*scope/i,
  /The path of the provided scope/i,
  /Refused to load the stylesheet.*fonts\.googleapis\.com/i,
  /Content Security Policy.*fonts\.googleapis\.com/i,
  /style-src[^\n]*fonts\.googleapis\.com/i,
];

test.describe('P0 浏览器运行时', () => {
  test('Browser Runtime Smoke', async ({ page }) => {
    const consoleErrors = [];
    const pageErrors = [];

    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    // 1. Open the home page using the existing Playwright baseURL http://localhost:3232 and scripts/mock-server.js.
    await page.goto('/');
    await expect(page).toHaveTitle('Codex Chat');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // 3. Verify core UI is interactive: #msg-input can be filled, #attach-btn is visible, #send-btn becomes enabled and can send REAL_BROWSER_OK.
    const input = page.locator('#msg-input');
    const sendButton = page.locator('#send-btn');
    await expect(input).toBeVisible();
    await expect(page.locator('#attach-btn')).toBeVisible();
    await expect(sendButton).toBeVisible();
    await input.fill('REAL_BROWSER_OK');
    await expect(input).toHaveValue('REAL_BROWSER_OK');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    await expect(page.locator('.msg.user').filter({ hasText: 'REAL_BROWSER_OK' }).last()).toBeVisible();
    await expect(page.locator('.msg.codex').filter({ hasText: 'REAL_BROWSER_OK' }).last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 2. Collect console and pageerror events while the page loads.
    const runtimeOutput = [...consoleErrors, ...pageErrors].join('\n');
    for (const pattern of forbiddenRuntimeErrors) {
      expect(runtimeOutput, `unexpected browser runtime error matching ${pattern}`).not.toMatch(pattern);
    }
  });
});
