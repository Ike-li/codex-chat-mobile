// spec: specs/codex-chat-mobile-playwright-plan.md
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

async function expectPopoverInViewport(page, selector, label) {
  const popover = page.locator(selector);
  await expect(popover, `${label} should be visible`).toBeVisible();
  const box = await popover.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight,
      visible: view.getComputedStyle(element).display !== 'none',
    };
  });

  expect(box.visible, `${label} should not be display:none`).toBeTruthy();
  expect(box.width, `${label} should have width`).toBeGreaterThan(0);
  expect(box.height, `${label} should have height`).toBeGreaterThan(0);
  expect(box.left, `${label} should not overflow left`).toBeGreaterThanOrEqual(0);
  expect(box.top, `${label} should not overflow top`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${label} should not overflow right`).toBeLessThanOrEqual(box.viewportWidth + 1);
  expect(box.bottom, `${label} should not overflow bottom`).toBeLessThanOrEqual(box.viewportHeight + 1);
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

    // 3. Open `#mode-trigger`, `#perm-trigger`, and `#model-trigger`.
    await page.locator('#mode-trigger').click();
    await expectPopoverInViewport(page, '#mode-popover', 'mode popover');

    await page.locator('#perm-trigger').click();
    await expectPopoverInViewport(page, '#perm-popover', 'permission popover');

    await page.locator('#model-trigger').click();
    await expectPopoverInViewport(page, '#model-popover', 'model popover');
    await page.locator('#model-popover .model-list .popover-item[data-model="gpt-5.4-mini"]').first().click();
    await expect(page.locator('#model-trigger-text')).toContainText('5.4-mini');
    await expect(page.locator('.msg.user').last()).toContainText('/model gpt-5.4-mini');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });
});
