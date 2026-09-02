import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // 跑任何用例之前先确认后端接的是 mock：reuseExistingServer 在本地为 true，
  // 复用到一个接了真 Codex CLI 的实例会让整轮 E2E 消耗模型额度。
  globalSetup: './e2e/assert-mock-backend.js',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3232',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'node scripts/mock-server.js',
    port: 3232,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
