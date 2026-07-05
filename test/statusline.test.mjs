// test/statusline.test.mjs —— statusline 模块单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { buildStatusLine } from '../statusline.js';

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-test-'));
  // Init git repo
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

// ---- buildStatusLine 基础测试 ----

test('statusline buildStatusLine: includes project name', async () => {
  const payload = await buildStatusLine({ agent: null, cwd: '/home/user/my-project', versions: null });
  assert.equal(payload.project, 'my-project');
  assert.equal(payload.cwd, '/home/user/my-project');
});

test('statusline buildStatusLine: null agent yields basic payload', async () => {
  const payload = await buildStatusLine({ agent: null, cwd: null, versions: null });
  assert.equal(payload.ts > 0, true);
  // state is undefined when no agent — only set when agent exists
  assert.equal(payload.state, undefined);
});

test('statusline buildStatusLine: agent 状态信息', async () => {
  const agent = {
    statusPayload: () => ({
      sessionId: 'sess_123',
      state: 'busy',
      busy: true,
      queueLength: 2,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    }),
  };
  const payload = await buildStatusLine({ agent, cwd: '/tmp/test', versions: { codex: '1.0.0' } });
  assert.equal(payload.sessionId, 'sess_123');
  assert.equal(payload.state, 'busy');
  assert.equal(payload.busy, true);
  assert.equal(payload.queueLength, 2);
  assert.equal(payload.approvalPolicy, 'on-request');
  assert.equal(payload.sandbox, 'read-only');
  assert.equal(payload.versions.codex, '1.0.0');
});

test('statusline buildStatusLine: cwd 末尾斜杠被清理', async () => {
  const payload = await buildStatusLine({ agent: null, cwd: '/tmp/test/', versions: null });
  assert.equal(payload.project, 'test');
});

// ---- git 集成测试 ----

test('git 状态: 在 git 仓库中返回分支信息', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'test.txt'), 'hello');
    execSync('git add . && git commit -q -m "init"', { cwd: dir, stdio: 'ignore' });
    const payload = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    assert.ok(payload.git);
    assert.equal(typeof payload.git.branch, 'string');
    // Default branch name varies by platform (main/master)
    assert.ok(['main', 'master'].includes(payload.git.branch));
    assert.equal(payload.git.changed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git 状态: 检测未提交的更改', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'a.txt'), 'initial');
    execSync('git add . && git commit -q -m "init"', { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'b.txt'), 'new file');
    writeFileSync(join(dir, 'a.txt'), 'modified');
    const payload = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    assert.ok(payload.git);
    assert.equal(payload.git.changed > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git 状态: 非 git 目录返回 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-nogit-'));
  try {
    const payload = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    assert.equal(payload.git, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- contextCost 测试 (通过 agent.lastUsage) ----

test('context usage: 计算总 token 和缓存命中率', async () => {
  const agent = {
    statusPayload: () => ({ state: 'idle' }),
    lastUsage: {
      input_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 300,
    },
  };
  const payload = await buildStatusLine({ agent, cwd: null, versions: null });
  assert.ok(payload.ctx);
  assert.equal(payload.ctx.totalInputTokens, 1800);
  assert.equal(payload.ctx.in, 1000);
  assert.equal(payload.ctx.w, 500);
  assert.equal(payload.ctx.r, 300);
  assert.equal(payload.ctx.cacheHitPct, Math.round((300 / 1800) * 100));
});

test('context usage: 无 usage 时不设置 ctx', async () => {
  const agent = {
    statusPayload: () => ({ state: 'idle' }),
    lastUsage: null,
  };
  const payload = await buildStatusLine({ agent, cwd: null, versions: null });
  assert.equal(payload.ctx, undefined);
});

test('context usage: 零 token 时缓存命中率为 0', async () => {
  const agent = {
    statusPayload: () => ({ state: 'idle' }),
    lastUsage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
  const payload = await buildStatusLine({ agent, cwd: null, versions: null });
  assert.ok(payload.ctx);
  assert.equal(payload.ctx.cacheHitPct, 0);
});

// ---- git 缓存测试 ----

test('git 缓存: 短时间内重复调用返回缓存结果', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'test.txt'), 'hello');
    execSync('git add . && git commit -q -m "init"', { cwd: dir, stdio: 'ignore' });
    const p1 = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    const p2 = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    assert.deepEqual(p1.git, p2.git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
