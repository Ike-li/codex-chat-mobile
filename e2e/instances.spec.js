// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

const forbiddenRuntimeErrors = [
  /TypeError/i,
  /ServiceWorker.*scope/i,
  /The path of the provided scope/i,
  /scope.*not under the max scope allowed/i,
  /Content Security Policy/i,
  /Refused to load.*Content Security Policy/i,
  /Refused to connect.*Content Security Policy/i,
  /Refused to apply.*Content Security Policy/i,
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

async function sendMessage(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

async function expectCurrentExchange(page, text, userIndex, codexIndex) {
  await expect(page.locator('.msg.user').filter({ hasText: text }).nth(userIndex)).toBeVisible();
  await expect(page.locator('.msg.codex').filter({ hasText: `Mock response to: ${text}` }).nth(codexIndex)).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
}

test.describe('Multi Instance Tabs', () => {
  test('Multi Instance Tabs', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    const firstMessage = `first multi instance message ${Date.now()}`;
    const secondMessage = `second multi instance message ${Date.now()}`;

    // 1. Open `/`, wait until `#state-label` is not `offline`.
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // 2. Send the first normal message and wait for the corresponding mock response.
    const firstUserMessages = page.locator('.msg.user').filter({ hasText: firstMessage });
    const firstCodexMessages = page.locator('.msg.codex').filter({ hasText: `Mock response to: ${firstMessage}` });
    const firstUserIndex = await firstUserMessages.count();
    const firstCodexIndex = await firstCodexMessages.count();
    await sendMessage(page, firstMessage);
    await expectCurrentExchange(page, firstMessage, firstUserIndex, firstCodexIndex);

    // 3. Confirm `#new-instance-btn` is visible, then click it.
    const newInstanceButton = page.locator('#new-instance-btn');
    await expect(newInstanceButton).toBeVisible({ timeout: 10000 });
    await newInstanceButton.click();

    // 4. Wait for `#instance-tabs` to be visible, confirm `.instance-tab` count is at least 1, and confirm `#new-instance-btn` remains visible.
    const instanceTabs = page.locator('#instance-tabs');
    await expect(instanceTabs).toBeVisible({ timeout: 10000 });
    const tabButtons = instanceTabs.locator('.instance-tab');
    await expect.poll(async () => tabButtons.count(), {
      message: 'instance tabs should stay rendered after creating a new instance',
      timeout: 10000,
    }).toBeGreaterThanOrEqual(1);
    await expect(newInstanceButton).toBeVisible();

    // 5. Send the second normal message and wait for the corresponding mock response.
    const secondUserMessages = page.locator('.msg.user').filter({ hasText: secondMessage });
    const secondCodexMessages = page.locator('.msg.codex').filter({ hasText: `Mock response to: ${secondMessage}` });
    const secondUserIndex = await secondUserMessages.count();
    const secondCodexIndex = await secondCodexMessages.count();
    await sendMessage(page, secondMessage);
    await expectCurrentExchange(page, secondMessage, secondUserIndex, secondCodexIndex);

    // 6. If `.instance-tab` exists, click the first tab, then confirm there is no pageerror/TypeError and tabs remain stable.
    if (await tabButtons.count()) {
      await tabButtons.first().click();
    }
    await expect(instanceTabs).toBeVisible();
    await expect.poll(async () => tabButtons.count(), {
      message: 'instance tabs should remain stable after tab switching',
      timeout: 10000,
    }).toBeGreaterThanOrEqual(1);
    await expect(newInstanceButton).toBeVisible();
    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });
});
