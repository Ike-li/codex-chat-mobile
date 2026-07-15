// devices.js —— 管理受信任和等待确认的设备指纹列表。
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOwnerOnlyFile } from './file-security.js';

const HERE = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
// CODEX_DATA_DIR 覆盖部署状态根，与 server.js 和管理脚本使用同一目录。
const DEFAULT_DATA_DIR = join(HERE, 'data');
const dataDir = () => process.env.CODEX_DATA_DIR || DEFAULT_DATA_DIR;
const trustedDevicesFile = () => join(dataDir(), 'trusted-devices.json');
const pendingDevicesFile = () => join(dataDir(), 'pending-devices.json');

let trustedDevices = new Set();
let pendingDevices = []; // Array of { deviceToken, ip, userAgent, ts }

export function loadTrustedDevices() {
  const file = trustedDevicesFile();
  try {
    if (!existsSync(file)) {
      trustedDevices = new Set();
      return;
    }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(data)) {
      trustedDevices = new Set(data.filter(id => typeof id === 'string' && id.trim().length > 0));
    } else {
      trustedDevices = new Set();
    }
  } catch (err) {
    console.error('[devices] 读取 trusted-devices.json 失败:', err.message);
    trustedDevices = new Set();
  }
}

export function saveTrustedDevices() {
  const file = trustedDevicesFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeOwnerOnlyFile(file, JSON.stringify([...trustedDevices], null, 2));
    return true;
  } catch (err) {
    console.error('[devices] 保存 trusted-devices.json 失败:', err.message);
    return false;
  }
}

export function loadPendingDevices() {
  const file = pendingDevicesFile();
  try {
    if (!existsSync(file)) {
      pendingDevices = [];
      return;
    }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(data)) {
      pendingDevices = data.filter(d => d && typeof d.deviceToken === 'string');
    } else {
      pendingDevices = [];
    }
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

export function isDeviceTrusted(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  loadTrustedDevices();
  return trustedDevices.has(deviceToken);
}

export function getTrustedDeviceTokens() {
  loadTrustedDevices();
  return new Set(trustedDevices);
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
  loadTrustedDevices();
  const previousTrustedDevices = new Set(trustedDevices);
  trustedDevices.add(deviceToken);
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
  loadTrustedDevices();
  const previousTrustedDevices = new Set(trustedDevices);
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

loadTrustedDevices();
loadPendingDevices();
