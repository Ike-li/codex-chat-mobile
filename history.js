// history.js —— 读取 Codex CLI 会话历史 JSONL 文件。
// Codex 会话存储在 ~/.codex/sessions/YYYY/MM/DD/<session-id>.jsonl
import { open, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const MAX_READ_BYTES = 1024 * 1024;   // 尾部最多读 1MB
const LIST_LIMIT = 50;                 // 会话列表上限

// ---- 缓存 ----
const _listCache = new Map();          // dir → { ts, result }
const LIST_CACHE_TTL = 8_000;          // 8s

// 递归扫描目录下所有 .jsonl 文件
async function scanSessionFiles(baseDir) {
  const files = [];
  const dirs = [baseDir];
  while (dirs.length) {
    const dir = dirs.shift();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) dirs.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
    }
  }
  return files;
}

// 从 jsonl 头部提取标题（首条 user_message / input_text）、模型、CWD
async function readHeadMeta(filePath) {
  let text;
  try {
    const fh = await open(filePath, 'r');
    const buf = Buffer.alloc(128 * 1024); // 头部 128KB 足够找到首条用户消息
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    text = buf.toString('utf-8', 0, bytesRead);
  } catch {
    return { title: '', model: null, cwd: null };
  }

  let title = '', model = null, firstCmd = '', firstUserText = '', cwd = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    // CWD：来自 session_meta
    if (entry.type === 'session_meta' && entry.payload?.cwd) {
      cwd = entry.payload.cwd;
    }

    // 模型：首条 assistant 消息
    if (!model && entry.type === 'task_started' && entry.payload?.model) {
      model = entry.payload.model;
    }

    // 标题：优先首条 user_message，次 input_text
    if (entry.type === 'event_msg') {
      const p = entry.payload;
      if (p?.type === 'user_message' && p?.message) {
        if (!firstCmd && p.message.startsWith('/')) firstCmd = p.message;
        else if (!p.message.startsWith('/') && !firstUserText) firstUserText = p.message;
      }
    }
    if (!firstUserText && entry.type === 'input_text' && entry.payload?.text) {
      firstUserText = entry.payload.text;
    }

    if (title && model && cwd) {
      // 找到所有元数据后提前退出
      break;
    }
  }
  // 等待更多行直到找到 model（task_started 可能在后面）
  if (!model) {
    const lines = text.split('\n');
    const mid = Math.min(lines.length, 200);
    for (let i = 0; i < mid; i++) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.type === 'task_started' && e.payload?.model) {
          model = e.payload.model;
          break;
        }
      } catch { continue; }
    }
  }

  title = (firstUserText || firstCmd || '(无标题)').slice(0, 80);
  return { title, model, cwd };
}

// 列出 cwd 下的会话列表（匹配 session_meta.cwd）
export async function listSessions(cwd, { baseDir = CODEX_SESSIONS_DIR, limit = LIST_LIMIT } = {}) {
  // 缓存
  const cached = _listCache.get(cwd);
  if (cached && Date.now() - cached.ts < LIST_CACHE_TTL) return cached.result;

  const files = await scanSessionFiles(baseDir);
  if (!files.length) return [];

  // stat 并发
  const statResults = await Promise.allSettled(
    files.map(async f => {
      const st = await stat(f);
      return { file: f, mtimeMs: st.mtimeMs };
    })
  );
  const stated = statResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  // 对最近的多个文件提取元数据并进行过滤（读至 limit * 3 数量以保证有足够数据供过滤）
  const top = stated.slice(0, limit * 3);
  const metas = await Promise.all(top.map(s => readHeadMeta(s.file)));

  // 过滤：匹配 cwd 的会话（通过 session_meta 中的 cwd 字段）
  const out = [];
  for (let i = 0; i < top.length; i++) {
    const id = top[i].file.split('/').pop().replace('.jsonl', '');
    const m = metas[i];
    if (cwd && m.cwd && m.cwd !== cwd) continue;
    out.push({
      id,
      title: m.title,
      model: m.model || null,
      filePath: top[i].file,
      lastUsedAt: Math.round(top[i].mtimeMs)
    });
    if (out.length >= limit) break;
  }

  _listCache.set(cwd, { ts: Date.now(), result: out });
  return out;
}

// 读取会话历史消息（user / assistant 文本）
export async function getSessionHistory(filePath, limit = 50) {
  let text;
  try {
    const { size } = await stat(filePath);
    const start = Math.max(0, size - MAX_READ_BYTES);
    const readLen = size - start;

    const fh = await open(filePath, 'r');
    const buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, start);
    await fh.close();

    text = buf.toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
  } catch {
    return [];
  }

  const lines = text.trim().split('\n');
  const messages = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    let role = null, content = '';

    // event_msg: high-level user/agent message
    if (entry.type === 'event_msg') {
      const p = entry.payload;
      if (p?.type === 'user_message' && p?.message) {
        role = 'user';
        content = p.message;
      } else if (p?.type === 'agent_message' && p?.message) {
        role = 'assistant';
        content = p.message;
      }
    }

    // response_item with message: structured user/assistant/developer content
    if (entry.type === 'response_item' && entry.payload?.type === 'message') {
      const p = entry.payload;
      if (p.role === 'user') {
        role = 'user';
        content = extractContent(p.content);
      } else if (p.role === 'assistant') {
        role = 'assistant';
        content = extractContent(p.content);
      }
      // developer/system messages: skip
    }

    if (role && content.trim()) {
      // 去重：相邻同内容不重复添加
      const last = messages[messages.length - 1];
      if (!last || last.role !== role || last.content !== content.trim()) {
        messages.push({
          role,
          content: content.trim(),
          timestamp: entry.timestamp || null
        });
      }
    }
  }

  return messages.slice(-limit);
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}
