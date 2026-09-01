// test/devices.test.mjs —— 设备白名单模块单元测试。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
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

test('addPendingDevice: leaves pending capacity enforcement to the server boundary', async () => {
  const { addPendingDevice, getPendingDevices } = await import(`../devices.js?t=${Date.now()}`);
  for (let index = 0; index < 65; index += 1) {
    addPendingDevice(`pending-${index}`, { ip: '10.0.0.1' });
  }

  assert.equal(getPendingDevices().length, 65);
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
  assert.ok(data.some(record => record.deviceToken === 'persist-token'));
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

test('device caches include the data file path when stores have identical mtimes', async () => {
  const secondDir = mkdtempSync(join(tmpdir(), 'ccm-devices-same-mtime-store-'));
  const sharedMtime = new Date('2025-01-01T00:00:00.000Z');
  const firstTrustedFile = join(tempDir, 'trusted-devices.json');
  const secondTrustedFile = join(secondDir, 'trusted-devices.json');
  const firstPendingFile = join(tempDir, 'pending-devices.json');
  const secondPendingFile = join(secondDir, 'pending-devices.json');

  writeFileSync(firstTrustedFile, JSON.stringify(['store-one-token']));
  writeFileSync(secondTrustedFile, JSON.stringify(['store-two-token']));
  writeFileSync(firstPendingFile, JSON.stringify([{ deviceToken: 'pending-one', ts: 1 }]));
  writeFileSync(secondPendingFile, JSON.stringify([{ deviceToken: 'pending-two', ts: 1 }]));
  for (const file of [firstTrustedFile, secondTrustedFile, firstPendingFile, secondPendingFile]) {
    utimesSync(file, sharedMtime, sharedMtime);
  }

  const devices = await import(`../devices.js?same-mtime=${Date.now()}`);
  try {
    assert.equal(devices.isDeviceTrusted('store-one-token'), true);
    assert.deepEqual(devices.getPendingDevices().map(device => device.deviceToken), ['pending-one']);

    process.env.CODEX_DATA_DIR = secondDir;
    assert.equal(devices.isDeviceTrusted('store-one-token'), false);
    assert.equal(devices.isDeviceTrusted('store-two-token'), true);
    assert.deepEqual(devices.getPendingDevices().map(device => device.deviceToken), ['pending-two']);
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

// R-SEC-1：设备表此前是扁平字符串数组，IP / UA / 时间在批准瞬间被丢弃——设备列表页因此
// 无法回答「这台是什么设备、什么时候接进来的、最近还在不在用」，而那正是判断要不要撤销
// 它的依据。
test('设备记录保留元数据，且能读回旧的扁平数组', async () => {
  const { addPendingDevice, approveDevice, getTrustedDevices, touchDevice } =
    await import(`../devices.js?meta=${Date.now()}`);

  addPendingDevice('dev_meta', { ip: '10.0.0.9', userAgent: 'iPhone Safari' });
  assert.equal(approveDevice('dev_meta'), true);

  const [record] = getTrustedDevices();
  assert.equal(record.deviceToken, 'dev_meta');
  assert.equal(record.ip, '10.0.0.9', '批准时不该丢掉来源 IP');
  assert.equal(record.userAgent, 'iPhone Safari');
  assert.ok(record.approvedAt > 0, '需要首次注册时间');
  assert.equal(record.lastSeenAt, record.approvedAt);

  touchDevice('dev_meta', { now: record.approvedAt + 5000 });
  assert.equal(getTrustedDevices()[0].lastSeenAt, record.approvedAt + 5000, '最近活跃要能更新');
});

test('旧格式的扁平数组仍可读，缺失字段留空而不是伪造', async () => {
  writeFileSync(join(tempDir, 'trusted-devices.json'), JSON.stringify(['dev_legacy']));
  const { getTrustedDevices, isDeviceTrusted } =
    await import(`../devices.js?legacy=${Date.now()}`);

  assert.equal(isDeviceTrusted('dev_legacy'), true, '旧格式设备不能因为升级就被踢下线');
  const [record] = getTrustedDevices();
  assert.equal(record.deviceToken, 'dev_legacy');
  assert.equal(record.ip, null, '旧记录没有这些信息，留空而不是编一个');
  assert.equal(record.approvedAt, null);
});

// R-SEC-1 的核心：共享 token 降级为**注册凭证**，只在新设备首次接入时用一次；此后设备
// 用服务端为它签发的专属凭证。这样轮换共享 token 只阻断新设备注册，不会把已注册设备
// 全部踢下线——而那正是当前「改 AUTH_TOKEN 要重启且所有人重登」的问题。
test('批准设备时签发专属凭证，可据此认证且可单独撤销', async () => {
  const { addPendingDevice, approveDevice, issueDeviceSecret, verifyDeviceSecret, denyDevice } =
    await import(`../devices.js?secret=${Date.now()}`);

  addPendingDevice('dev_a', { ip: '10.0.0.1' });
  approveDevice('dev_a');
  const secret = issueDeviceSecret('dev_a');
  assert.equal(typeof secret, 'string');
  assert.ok(secret.length >= 32, '凭证要有足够熵，它替代共享 token 承担日常认证');

  assert.equal(verifyDeviceSecret('dev_a', secret), true);
  assert.equal(verifyDeviceSecret('dev_a', 'wrong'), false);
  assert.equal(verifyDeviceSecret('dev_b', secret), false, '凭证绑定到具体设备');

  denyDevice('dev_a');
  assert.equal(verifyDeviceSecret('dev_a', secret), false, '撤销设备后其凭证立即失效');
});

test('凭证不以明文落盘', async () => {
  const { addPendingDevice, approveDevice, issueDeviceSecret } =
    await import(`../devices.js?hash=${Date.now()}`);
  addPendingDevice('dev_h', {});
  approveDevice('dev_h');
  const secret = issueDeviceSecret('dev_h');

  const raw = await import('node:fs').then(fs => fs.readFileSync(join(tempDir, 'trusted-devices.json'), 'utf8'));
  assert.ok(!raw.includes(secret), '设备表被读走时不该等于交出所有设备的通行证');
});
