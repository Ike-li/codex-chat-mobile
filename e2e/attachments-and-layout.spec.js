// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

const sampleFile = {
  name: 'sample-note.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('small attachment from Playwright\n', 'utf8'),
};

async function uploadSampleFile(page) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#attach-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sampleFile);
}

async function visibleBox(locator, label) {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} should have a layout box`).toBeTruthy();
  expect(box.width, `${label} should have width`).toBeGreaterThan(0);
  expect(box.height, `${label} should have height`).toBeGreaterThan(0);
  return box;
}

async function expectMobileLayout(page, size) {
  await page.setViewportSize(size);
  const header = page.locator('#header');
  const messages = page.locator('#messages');
  const composer = page.locator('#input-area');
  const sendButton = page.locator('#send-btn');
  const attachButton = page.locator('#attach-btn');

  const headerBox = await visibleBox(header, `header at ${size.width}x${size.height}`);
  const messagesBox = await visibleBox(messages, `messages at ${size.width}x${size.height}`);
  const composerBox = await visibleBox(composer, `composer at ${size.width}x${size.height}`);
  const sendBox = await visibleBox(sendButton, `send button at ${size.width}x${size.height}`);
  const attachBox = await visibleBox(attachButton, `attach button at ${size.width}x${size.height}`);

  expect(headerBox.y, 'header should start inside viewport').toBeGreaterThanOrEqual(0);
  expect(headerBox.y + headerBox.height, 'header should not overlap messages').toBeLessThanOrEqual(messagesBox.y + 1);
  expect(messagesBox.y + messagesBox.height, 'messages should not overlap composer').toBeLessThanOrEqual(composerBox.y + 1);
  expect(composerBox.y + composerBox.height, 'composer should stay inside viewport').toBeLessThanOrEqual(size.height + 1);

  for (const [name, box] of [['send button', sendBox], ['attach button', attachBox]]) {
    expect(box.x, `${name} should not be clipped on the left`).toBeGreaterThanOrEqual(0);
    expect(box.y, `${name} should not be clipped at the top`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} should stay inside viewport width`).toBeLessThanOrEqual(size.width + 1);
    expect(box.y + box.height, `${name} should stay inside viewport height`).toBeLessThanOrEqual(size.height + 1);
  }
}

test.describe('P1 文件与移动布局', () => {
  test('Attachments And Responsive Layout', async ({ page }) => {
    // 1. Open the home page with the existing baseURL and wait until #state-label is not offline.
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#msg-input')).toBeVisible();
    await expect(page.locator('#attach-btn')).toBeVisible();
    await expect(page.locator('#send-btn')).toBeVisible();
    await expect(page.locator('#header')).toBeVisible();
    await expect(page.locator('#messages')).toBeAttached();
    await expect(page.locator('#input-area')).toBeVisible();

    // 2. Click #attach-btn, use the file chooser to upload a small text file named sample-note.txt.
    await uploadSampleFile(page);
    const tray = page.locator('#attach-tray');
    await expect(tray).toBeVisible();
    await expect(tray.locator('.attach-chip-name')).toContainText('sample-note.txt');

    // 3. Remove the uploaded attachment using .attach-chip-remove.
    await page.locator('.attach-chip-remove').click();
    await expect.soft(tray).toBeHidden();
    await uploadSampleFile(page);
    await expect(tray).toBeVisible();
    await expect(tray.locator('.attach-chip-name')).toContainText('sample-note.txt');

    // 4. Fill #msg-input and click #send-btn.
    await page.locator('#msg-input').fill('attachment smoke');
    await page.locator('#send-btn').click();
    const userMessage = page.locator('.msg.user').last();
    await expect(userMessage).toContainText('sample-note.txt');
    await expect(userMessage).toContainText('attachment smoke');
    await expect.soft(tray).toBeHidden();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 5. Resize to 390x844, 844x390, and 390x520.
    for (const size of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 390, height: 520 },
    ]) {
      await expectMobileLayout(page, size);
    }
  });
});
