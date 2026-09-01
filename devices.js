// devices.js —— 管理受信任和等待确认的设备指纹列表。
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { writeOwnerOnlyFile } from './file-security.js';

const HERE = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
// CODEX_DATA_DIR 覆盖部署状态根，与 server.js 和管理脚本使用同一目录。
const DEFAULT_DATA_DIR = join(HERE, 'data');
const dataDir = () => process.env.CODEX_DATA_DIR || DEFAULT_DATA_DIR;
const trustedDevicesFile = () => join(dataDir(), 'trusted-devices.json');
const pendingDevicesFile = () => join(dataDir(), 'pending-devices.json');

// deviceToken -> { deviceToken, ip, userAgent, approvedAt, lastSeenAt }
// 旧版本存的是扁平字符串数组，读到那种格式时字段留空——升级不该把已批准的设备踢下线，
// 也不该给缺失的信息编一个值。
let trustedDevices = new Map();
let pendingDevices = []; // Array of { deviceToken, ip, userAgent, ts }
let lastTrustedSignature = null;
let lastPendingSignature = null;

function cacheSignature(file, stat) {
  return `${resolve(file)}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

export function loadTrustedDevices({ force = false } = {}) {
  const file = trustedDevicesFile();
  try {
    if (!existsSync(file)) {
      trustedDevices = new Map();
      lastTrustedSignature = null;
      return;
    }
    const signature = cacheSignature(file, statSync(file));
    if (!force && signature === lastTrustedSignature) return;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    trustedDevices = new Map();
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (typeof entry === 'string' && entry.trim()) {
          trustedDevices.set(entry, normalizeDeviceRecord({ deviceToken: entry }));
          continue;
        }
        const token = typeof entry?.deviceToken === 'string' ? entry.deviceToken.trim() : '';
        if (token) trustedDevices.set(token, normalizeDeviceRecord(entry));
      }
    }
    lastTrustedSignature = signature;
  } catch (err) {
    console.error('[devices] 读取 trusted-devices.json 失败:', err.message);
    trustedDevices = new Map();
  }
}

export function saveTrustedDevices() {
  const file = trustedDevicesFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeOwnerOnlyFile(file, JSON.stringify([...trustedDevices.values()], null, 2));
    return true;
  } catch (err) {
    console.error('[devices] 保存 trusted-devices.json 失败:', err.message);
    return false;
  }
}

export function loadPendingDevices({ force = false } = {}) {
  const file = pendingDevicesFile();
  try {
    if (!existsSync(file)) {
      pendingDevices = [];
      lastPendingSignature = null;
      return;
    }
    const signature = cacheSignature(file, statSync(file));
    if (!force && signature === lastPendingSignature) return;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(data)) {
      pendingDevices = data.filter(d => d && typeof d.deviceToken === 'string');
    } else {
      pendingDevices = [];
    }
    lastPendingSignature = signature;
  } catch (err) {
    pendingDevices = [];
  }
}

export function savePendingDevices() {
  const file = pendingDevicesFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeOwnerOnlyFile(file, JSON.stringify(pendingDevices, null, 2));
    return true;
  } catch (err) {
    console.error('[devices] 保存 pending-devices.json 失败:', err.message);
    return false;
  }
}

function normalizeDeviceRecord(entry) {
  const num = value => (Number.isFinite(value) && value > 0 ? value : null);
  return {
    deviceToken: entry.deviceToken,
    ip: typeof entry.ip === 'string' && entry.ip ? entry.ip : null,
    userAgent: typeof entry.userAgent === 'string' && entry.userAgent ? entry.userAgent : null,
    approvedAt: num(entry.approvedAt),
    lastSeenAt: num(entry.lastSeenAt) ?? num(entry.approvedAt),
    // 只存哈希：设备表被读走时不该等于交出所有设备的通行证。
    secretHash: typeof entry.secretHash === 'string' && entry.secretHash ? entry.secretHash : null,
  };
}

function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

// 共享 token 是**注册凭证**，只在新设备首次接入时用一次；此后设备用这里签发的专属凭证。
// 这样轮换共享 token 只阻断新设备注册，已注册的设备不受影响——现状是改 AUTH_TOKEN 要
// 重启且所有人重登，与 R-SEC-1 想要的方向相反。
export function issueDeviceSecret(deviceToken) {
  loadTrustedDevices({ force: true });
  const record = trustedDevices.get(deviceToken);
  if (!record) return null;
  const secret = randomBytes(32).toString('base64url');
  record.secretHash = hashSecret(secret);
  if (!saveTrustedDevices()) return null;
  return secret;
}

export function verifyDeviceSecret(deviceToken, secret) {
  if (typeof deviceToken !== 'string' || typeof secret !== 'string' || !secret) return false;
  loadTrustedDevices();
  const record = trustedDevices.get(deviceToken);
  if (!record?.secretHash) return false;
  const expected = Buffer.from(record.secretHash, 'hex');
  const actual = Buffer.from(hashSecret(secret), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function getTrustedDevices() {
  loadTrustedDevices();
  return [...trustedDevices.values()];
}

// 最近活跃只在内存里推进，落盘由调用方按需触发——每次握手都写一次文件不划算。
export function touchDevice(deviceToken, { now = Date.now(), persist = true } = {}) {
  loadTrustedDevices();
  const record = trustedDevices.get(deviceToken);
  if (!record) return false;
  record.lastSeenAt = now;
  if (persist) saveTrustedDevices();
  return true;
}

export function isDeviceTrusted(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  loadTrustedDevices();
  return trustedDevices.has(deviceToken);
}

export function getTrustedDeviceTokens() {
  loadTrustedDevices();
  return new Set(trustedDevices.keys());
}

export function addPendingDevice(deviceToken, info) {
  if (!deviceToken || typeof deviceToken !== 'string') return;
  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  pendingDevices.push({
    deviceToken,
    ...info,
    ts: Date.now()
  });
  savePendingDevices();
}

export function removePendingDevice(deviceToken) {
  if (!deviceToken) return;
  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();
}

export function getPendingDevices() {
  loadPendingDevices();
  return [...pendingDevices].sort((a, b) => b.ts - a.ts);
}

export function getLatestPendingDevice() {
  const list = getPendingDevices();
  return list.length > 0 ? list[0].deviceToken : null;
}

export function approveDevice(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  loadTrustedDevices({ force: true });
  const previousTrustedDevices = new Map(trustedDevices);
  // pending 阶段记下的 IP / UA 在这里落进设备表，而不是被丢掉——设备列表要靠它们回答
  // 「这台是什么设备、什么时候接进来的」。
  loadPendingDevices();
  const pending = pendingDevices.find(d => d.deviceToken === deviceToken);
  const now = Date.now();
  trustedDevices.set(deviceToken, normalizeDeviceRecord({
    deviceToken,
    ip: pending?.ip ?? null,
    userAgent: pending?.userAgent ?? null,
    approvedAt: now,
    lastSeenAt: now,
  }));
  if (!saveTrustedDevices()) {
    trustedDevices = previousTrustedDevices;
    return false;
  }

  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();
  return true;
}

export function denyDevice(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  loadTrustedDevices({ force: true });
  const previousTrustedDevices = new Map(trustedDevices);
  trustedDevices.delete(deviceToken);
  if (!saveTrustedDevices()) {
    trustedDevices = previousTrustedDevices;
    return false;
  }

  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();
  return true;
}

loadTrustedDevices({ force: true });
loadPendingDevices({ force: true });
