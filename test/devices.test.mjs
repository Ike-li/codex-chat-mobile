// test/devices.test.mjs —— 设备白名单模块单元测试。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 使用临时目录隔离测试数据
let tempDir;
let origEnv;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ccm-devices-test-'));
  origEnv = process.env.CODEX_DATA_DIR;
  process.env.CODEX_DATA_DIR = tempDir;
});

function cleanup() {
  process.env.CODEX_DATA_DIR = origEnv;
  rmSync(tempDir, { recursive: true, force: true });
}

// ---- isDeviceTrusted ----

test('isDeviceTrusted: returns false for empty/null/undefined token', async () => {
  // 动态导入以使用临时目录
  const { isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(isDeviceTrusted(''), false);
  assert.equal(isDeviceTrusted(null), false);
  assert.equal(isDeviceTrusted(undefined), false);
  assert.equal(isDeviceTrusted(123), false);
  cleanup();
});

test('isDeviceTrusted: returns false for untrusted token', async () => {
  const { isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(isDeviceTrusted('unknown-token'), false);
  cleanup();
});

test('isDeviceTrusted: returns true after approveDevice', async () => {
  const { approveDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  approveDevice('token-abc', { ip: '127.0.0.1', userAgent: 'test' });
  assert.equal(isDeviceTrusted('token-abc'), true);
  cleanup();
});

// ---- addPendingDevice / getPendingDevices ----

test('addPendingDevice: stores device with metadata', async () => {
  const { addPendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('pending-1', { ip: '10.0.0.1', userAgent: 'Mozilla/5.0' });
  const list = getPendingDevices();
  assert.ok(list.length >= 1);
  const found = list.find(d => d.deviceToken === 'pending-1');
  assert.ok(found);
  assert.equal(found.ip, '10.0.0.1');
  assert.equal(found.userAgent, 'Mozilla/5.0');
  assert.ok(found.ts > 0);
  cleanup();
});

test('addPendingDevice: replaces duplicate token', async () => {
  const { addPendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('dup-token', { ip: '10.0.0.1' });
  addPendingDevice('dup-token', { ip: '10.0.0.2' });
  const list = getPendingDevices();
  const matches = list.filter(d => d.deviceToken === 'dup-token');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ip, '10.0.0.2');
  cleanup();
});

test('addPendingDevice: ignores empty/null token', async () => {
  const { addPendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  const before = getPendingDevices().length;
  addPendingDevice('', { ip: '10.0.0.1' });
  addPendingDevice(null, { ip: '10.0.0.1' });
  assert.equal(getPendingDevices().length, before);
  cleanup();
});

// ---- removePendingDevice ----

test('removePendingDevice: removes existing pending device', async () => {
  const { addPendingDevice, removePendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('to-remove', { ip: '10.0.0.1' });
  removePendingDevice('to-remove');
  const list = getPendingDevices();
  assert.ok(!list.find(d => d.deviceToken === 'to-remove'));
  cleanup();
});

test('removePendingDevice: no-op for non-existent token', async () => {
  const { removePendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  const before = getPendingDevices().length;
  removePendingDevice('nonexistent');
  assert.equal(getPendingDevices().length, before);
  cleanup();
});

// ---- approveDevice ----

test('approveDevice: moves device from pending to trusted', async () => {
  const { addPendingDevice, approveDevice, isDeviceTrusted, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('approve-me', { ip: '10.0.0.1' });
  const result = approveDevice('approve-me');
  assert.equal(result, true);
  assert.equal(isDeviceTrusted('approve-me'), true);
  assert.ok(!getPendingDevices().find(d => d.deviceToken === 'approve-me'));
  cleanup();
});

test('approveDevice: returns false for empty/null token', async () => {
  const { approveDevice } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(approveDevice(''), false);
  assert.equal(approveDevice(null), false);
  cleanup();
});

test('approveDevice: returns false and rolls back trust when persistence fails', async () => {
  const { approveDevice, isDeviceTrusted } = await import(`../devices.js?t=${Date.now()}`);
  mkdirSync(join(tempDir, 'trusted-devices.json.tmp'));

  assert.equal(approveDevice('must-not-be-trusted'), false);
  assert.equal(isDeviceTrusted('must-not-be-trusted'), false);
  cleanup();
});

// ---- denyDevice ----

test('denyDevice: removes device from both trusted and pending', async () => {
  const { addPendingDevice, denyDevice, isDeviceTrusted, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('deny-me', { ip: '10.0.0.1' });
  const result = denyDevice('deny-me');
  assert.equal(result, true);
  assert.equal(isDeviceTrusted('deny-me'), false);
  assert.ok(!getPendingDevices().find(d => d.deviceToken === 'deny-me'));
  cleanup();
});

test('denyDevice: returns false for empty/null token', async () => {
  const { denyDevice } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(denyDevice(''), false);
  assert.equal(denyDevice(null), false);
  cleanup();
});

// ---- getLatestPendingDevice ----

test('getLatestPendingDevice: returns null when no pending devices', async () => {
  // 清空 pending 文件
  const pendingFile = join(tempDir, 'pending-devices.json');
  writeFileSync(pendingFile, '[]');
  const { getLatestPendingDevice } = await import(`../devices.js?t=${Date.now()}`);
  assert.equal(getLatestPendingDevice(), null);
  cleanup();
});

test('getLatestPendingDevice: returns most recent device token', async () => {
  const { addPendingDevice, getLatestPendingDevice } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('older', { ip: '10.0.0.1' });
  // 人为制造时间差
  await new Promise(r => setTimeout(r, 10));
  addPendingDevice('newer', { ip: '10.0.0.2' });
  assert.equal(getLatestPendingDevice(), 'newer');
  cleanup();
});

// ---- 文件持久化 ----

test('trusted devices persist to file', async () => {
  const { approveDevice } = await import(`../devices.js?t=${Date.now()}`);
  approveDevice('persist-token');
  const file = join(tempDir, 'trusted-devices.json');
  assert.ok(existsSync(file));
  const data = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(file, 'utf8')));
  assert.ok(data.includes('persist-token'));
  cleanup();
});

test('pending devices persist to file', async () => {
  const { addPendingDevice } = await import(`../devices.js?t=${Date.now()}`);
  addPendingDevice('pending-persist', { ip: '10.0.0.1' });
  const file = join(tempDir, 'pending-devices.json');
  assert.ok(existsSync(file));
  const data = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(file, 'utf8')));
  assert.ok(data.some(d => d.deviceToken === 'pending-persist'));
  cleanup();
});

test('one devices module instance follows CODEX_DATA_DIR changes without crossing stores', async () => {
  const secondDir = mkdtempSync(join(tmpdir(), 'ccm-devices-second-store-'));
  const devices = await import(`../devices.js?t=${Date.now()}`);
  try {
    devices.approveDevice('first-store-token');
    assert.equal(devices.isDeviceTrusted('first-store-token'), true);

    process.env.CODEX_DATA_DIR = secondDir;
    assert.equal(devices.isDeviceTrusted('first-store-token'), false);
    devices.approveDevice('second-store-token');
    assert.equal(devices.isDeviceTrusted('second-store-token'), true);

    process.env.CODEX_DATA_DIR = tempDir;
    assert.equal(devices.isDeviceTrusted('first-store-token'), true);
    assert.equal(devices.isDeviceTrusted('second-store-token'), false);
  } finally {
    rmSync(secondDir, { recursive: true, force: true });
    cleanup();
  }
});

test('device CLI list reads trusted devices from CODEX_DATA_DIR', () => {
  const deviceToken = 'trusted-in-configured-data-dir';
  writeFileSync(join(tempDir, 'trusted-devices.json'), JSON.stringify([deviceToken]));
  try {
    const result = spawnSync(process.execPath, ['scripts/device.js', 'list'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, CODEX_DATA_DIR: tempDir },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(deviceToken));
  } finally {
    cleanup();
  }
});
