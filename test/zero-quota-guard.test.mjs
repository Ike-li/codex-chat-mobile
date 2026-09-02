// test/zero-quota-guard.test.mjs —— 守护「日常回归不消耗模型额度」这条项目规则。
//
// AGENTS.md 写着「默认不要调用真实 Codex CLI 或消耗模型额度；E2E 日常回归必须走 mock server」。
// 这条规则此前没有任何机制守护 —— 它只是一句文档，违反了不会有任何东西变红，
// 代价却是静默烧额度。这里补三道：mock 后端探测必须挂在 globalSetup 上、
// E2E webServer 必须指向 mock 脚本、mock 脚本必须真的把 CODEX_BIN 指向假二进制。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => readFileSync(join(ROOT, relativePath), 'utf8');

test('Playwright 在跑用例前先探测后端是不是 mock', () => {
  const config = read('playwright.config.js');
  assert.match(
    config,
    /globalSetup:\s*'\.\/e2e\/assert-mock-backend\.js'/,
    'globalSetup 被摘掉后，reuseExistingServer 复用真 CLI 实例就没有任何拦截',
  );
});

test('E2E 的 webServer 起的是 mock 脚本', () => {
  const config = read('playwright.config.js');
  assert.match(
    config,
    /command:\s*'node scripts\/mock-server\.js'/,
    'webServer.command 必须是 mock 入口，直接起 server.js 会接上宿主机真实的 CODEX_BIN',
  );
});

test('mock 入口把 CODEX_BIN 指向假二进制而不是真 codex', () => {
  const mockServer = read('scripts/mock-server.js');
  assert.match(
    mockServer,
    /process\.env\.CODEX_BIN\s*=\s*MOCK_CODEX/,
    'mock-server.js 必须显式覆盖 CODEX_BIN，否则 server.js 会 which codex 找到真的',
  );

  const mockCodex = read('scripts/mock-codex.sh');
  assert.match(
    mockCodex,
    /echo "mock-codex/,
    'mock-codex.sh 的 --version 必须自报 mock-codex —— assert-mock-backend.js 拿它当运行时判据',
  );
});
