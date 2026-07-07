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

test.describe('PWA Manifest And Service Worker', () => {
  test('PWA Manifest And Service Worker', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);

    // 1. Request /manifest.webmanifest.
    const manifestResponse = await page.request.get('/manifest.webmanifest');
    expect(manifestResponse.ok()).toBeTruthy();
    const manifest = await manifestResponse.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.theme_color).toBeTruthy();
    expect(Array.isArray(manifest.icons)).toBeTruthy();
    expect(manifest.icons.length).toBeGreaterThan(0);

    // 2. Open / and wait for Service Worker registration.
    await page.goto('/');
    await expect(page).toHaveTitle('Codex Chat');
    const registrationInfo = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const registration = await navigator.serviceWorker.register('/js/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const worker = registration.active || registration.waiting || registration.installing;
      return {
        supported: true,
        scope: registration.scope,
        scriptURL: worker?.scriptURL || null,
      };
    });
    expect(registrationInfo.supported).toBeTruthy();
    expect(registrationInfo.scope).toBe('http://localhost:3232/');
    expect(registrationInfo.scriptURL).toContain('/js/sw.js');

    // 3. Request /js/sw.js.
    const swResponse = await page.request.get('/js/sw.js');
    expect(swResponse.ok()).toBeTruthy();
    expect(swResponse.headers()['service-worker-allowed']).toBe('/');
    const swSource = await swResponse.text();
    expect(swSource).toContain('push');
    expect(swSource).toContain('notificationclick');

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });
});
