// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

const forbiddenRuntimeErrors = [
  /TypeError/i,
  /ServiceWorker.*scope/i,
  /The path of the provided scope/i,
  /scope.*not under the max scope allowed/i,
  /Content Security Policy/i,
  /Refused to load/i,
  /Refused to connect/i,
  /Refused to apply/i,
];

function collectRuntimeErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => {
    errors.push(error.message);
  });
  return errors;
}

function expectNoForbiddenRuntimeErrors(errors) {
  const output = errors.join('\n');
  for (const pattern of forbiddenRuntimeErrors) {
    expect(output, `unexpected browser runtime error matching ${pattern}`).not.toMatch(pattern);
  }
}



test.describe('Popovers And Slash Suggestions', () => {
  test('Popovers And Slash Suggestions', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);

    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // 1. Type `/` into `#msg-input`.
    const input = page.locator('#msg-input');
    await expect(input).toBeVisible();
    await input.pressSequentially('/');
    const slashPopup = page.locator('#slash-popup');
    await expect(slashPopup).toBeVisible();
    for (const command of ['/status', '/diff', '/review', '/permissions']) {
      await expect(slashPopup.locator(`.slash-item[data-cmd="${command}"]`).first(), `${command} slash item should be visible`).toBeVisible();
    }

    // 2. Click a slash item.
    await slashPopup.locator('.slash-item[data-cmd="/status"]').first().click();
    await expect(input).toHaveValue(/^\/status\s/);

    const defaults = page.locator('[data-testid="composer-defaults"]');
    await expect(defaults).toBeVisible();
    const defaultsBox = await defaults.boundingBox();
    expect(defaultsBox.height, 'composer chips must stay on one line').toBeLessThanOrEqual(40);
    await expect(page.locator('#model-trigger-text')).not.toHaveText('');
    await expect(page.locator('#perm-trigger-text')).toHaveText(/按请求|权限|默认/);

    await defaults.click();
    await expect(page.locator('#session-settings')).toBeVisible();
    await expect(page.locator('#mode-list .popover-item[data-mode="default"]')).toBeVisible();
    await page.locator('#mode-list .popover-item[data-mode="plan"]').click();
    await expect(page.locator('#mode-list .popover-item[data-mode="plan"]')).toHaveClass(/selected/);
    await expect(page.locator('#mode-trigger-text')).toHaveText('计划');
    await expect(page.locator('.msg.user')).toHaveCount(0);
    await expect(page.locator('#state-label')).toHaveText('idle');
    for (const approval of ['untrusted', 'on-failure', 'on-request', 'never']) {
      await expect(page.locator(`#approval-list [data-approval="${approval}"]`)).toBeVisible();
    }
    for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
      await expect(page.locator(`#sandbox-list [data-sandbox="${sandbox}"]`)).toBeVisible();
    }
    const miniModel = page.locator('#model-list .popover-item[data-model="gpt-5.4-mini"]').first();
    await expect(miniModel).toBeVisible({ timeout: 10000 });
    await miniModel.click();
    await expect(page.locator('#model-trigger-text')).toContainText('5.4-Mini');
    await page.locator('#session-settings-close').click();
    await expect(page.locator('#session-settings')).toBeHidden();
    await expect(page.locator('.msg.user')).toHaveCount(0);
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await input.fill('/plan');
    await input.press('Enter');
    await expect(page.locator('.msg.user')).toHaveCount(0);
    await expect(page.locator('#msg-input')).toHaveValue('');
    await expect(page.locator('#mode-trigger-text')).toHaveText('计划');

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });
});
