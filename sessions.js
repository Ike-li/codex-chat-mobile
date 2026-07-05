// sessions.js —— 服务端唯一持久状态：会话元数据，单 JSON 文件，原子写。
// 只存元数据（id/title/cwd/时间戳），永不存消息内容——内容事实源是 codex 自己的 thread。
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeOwnerOnlyFile } from './file-security.js';

// CODEX_SESSIONS_FILE 覆盖路径——仅测试用，让单测指向临时文件、永不碰真实 data/sessions.json。
// 次优先 CODEX_DATA_DIR：E2E 设一个 CODEX_DATA_DIR 即把 sessions 连同其余状态文件一并重定向。
// 优先级：CODEX_SESSIONS_FILE > CODEX_DATA_DIR/sessions.json > data/sessions.json。
const FILE = process.env.CODEX_SESSIONS_FILE
  || join(process.env.CODEX_DATA_DIR || join(import.meta.dirname, 'data'), 'sessions.json');

// 当前会话指针由全局单指针 currentSessionId 升为 currentByCwd（每工作目录一个）。
const EMPTY = () => ({ currentByCwd: {}, sessions: [] });

function load() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return EMPTY();
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) {
    return EMPTY();
  }
  const currentByCwd = (raw.currentByCwd && typeof raw.currentByCwd === 'object' && !Array.isArray(raw.currentByCwd))
    ? Object.fromEntries(Object.entries(raw.currentByCwd).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
    : {};
  return {
    currentByCwd,
    sessions: raw.sessions.filter(s => s && typeof s.id === 'string')
  };
}

let state = load();

let _saveTimer = null;

function save() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveAsync().catch(e => console.error('[sessions] 保存失败（状态未落盘）:', e?.message || e));
  }, 200);
}

let _saveSeq = 0;
async function _saveAsync() {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.${++_saveSeq}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, FILE);
  } catch (e) {
    try { await unlink(tmp); } catch { /* tmp 可能未生成 */ }
    throw e;
  }
}

export function flushSaveSync() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  mkdirSync(dirname(FILE), { recursive: true });
  writeOwnerOnlyFile(FILE, JSON.stringify(state, null, 2));
}

export function getState() {
  return state;
}

export function getCurrent(cwd) {
  return state.currentByCwd[cwd] ?? null;
}

export function setCurrent(cwd, sessionId) {
  if (sessionId) state.currentByCwd[cwd] = sessionId;
  else delete state.currentByCwd[cwd];
  save();
}

export function upsertSession({ id, title, cwd }) {
  const existing = state.sessions.find(s => s.id === id);
  if (existing) {
    existing.lastUsedAt = Date.now();
    if (title && existing.title === '新会话') existing.title = String(title).slice(0, 40);
  } else {
    state.sessions.unshift({
      id,
      title: (title || '新会话').slice(0, 40),
      cwd,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    });
  }
  state.currentByCwd[cwd] = id;
  save();
}

export function getSession(id) {
  if (!id) return null;
  return state.sessions.find(s => s.id === id) || null;
}
