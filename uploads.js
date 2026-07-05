// uploads.js —— 附件落盘 + 路径注入。
// 手机选文件 → base64 → 写入 WORK_DIR/.ccm-uploads/ → 绝对路径注入 prompt。
// codex 用 Read 读取，等价终端拖文件进窗口。
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { rejectableSymlinkComponent } from './file-security.js';

const UPLOAD_DIR = '.ccm-uploads';
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 单文件 10MB
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;  // 总量 20MB

// 文件名收敛：只取 basename，去路径分隔/控制/危险字符，去前导点
function sanitizeName(name) {
  const base = basename(String(name ?? '')).replace(/[\x00-\x1f\x7f]/g, '');
  const safe = base.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return safe || 'file';
}

// 纯校验（零 IO），返回错误字符串或 null（通过）
export function validateAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  if (attachments.length > MAX_FILES) {
    return `附件过多（${attachments.length}，上限 ${MAX_FILES}）`;
  }
  let total = 0;
  for (const a of attachments) {
    if (!a || typeof a.data !== 'string' || !a.data) return '附件缺少数据';
    if (typeof a.name !== 'string' || typeof a.mimeType !== 'string') return '附件缺少 name/mimeType';
    const bytes = Buffer.byteLength(a.data, 'base64');
    if (bytes > MAX_FILE_BYTES) {
      return `附件「${a.name}」过大（${(bytes / 1048576).toFixed(1)}MB，单文件上限 10MB）`;
    }
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) {
    return `附件总量过大（${(total / 1048576).toFixed(1)}MB，上限 20MB）`;
  }
  return null;
}

// 落盘：写 WORK_DIR/.ccm-uploads/<ts>-<rand>-<safeName>
// 返回 [{ absPath, name, mimeType, size }]
export async function saveAttachments(workDir, attachments) {
  const dir = join(workDir, UPLOAD_DIR);
  await mkdir(dir, { recursive: true });

  // symlink 穿越检查
  const symlink = rejectableSymlinkComponent(dir);
  if (symlink) throw new Error(`上传目录路径包含可疑符号链接: ${symlink}`);

  const dirResolved = resolve(dir);
  const saved = [];

  for (const a of attachments) {
    const fname = `${Date.now()}-${randomBytes(4).toString('hex')}-${sanitizeName(a.name)}`;
    const absPath = resolve(dir, fname);

    // 路径穿越检查
    if (absPath !== join(dirResolved, fname) || !absPath.startsWith(dirResolved + sep)) {
      throw new Error(`非法附件路径：${a.name}`);
    }

    // O_NOFOLLOW 防 symlink 攻击
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0);
    const fh = await open(absPath, flags, 0o600);
    try {
      await fh.writeFile(Buffer.from(a.data, 'base64'));
      await fh.sync();
    } finally {
      await fh.close();
    }

    saved.push({
      absPath, name: a.name, mimeType: a.mimeType,
      size: Buffer.byteLength(a.data, 'base64')
    });
  }
  return saved;
}

// 路径注入：原文末尾追加 [附件] 段（绝对路径逐行）。
// 等价终端里你说「看下这个文件」。
export function buildPromptText(text, saved) {
  const base = (text || '').trim();
  if (!saved || saved.length === 0) return base;
  const block = '[附件] 已上传到工作目录，可用 Read 读取：\n' + saved.map(s => s.absPath).join('\n');
  return base ? `${base}\n\n${block}` : block;
}

// 给 user_message 事件用的元数据（剥掉 absPath，不泄服务端路径）
export function toEventMeta(saved) {
  return saved.map(s => ({ name: s.name, mimeType: s.mimeType, size: s.size }));
}

// 定期清理过期上传的文件
export async function pruneExpiredUploads(workDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!workDir) return;
  const dir = join(workDir, UPLOAD_DIR);
  
  // symlink 穿越检查
  const symlink = rejectableSymlinkComponent(dir);
  if (symlink) throw new Error(`上传目录路径包含可疑符号链接: ${symlink}`);

  const dirResolved = resolve(dir);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 目录不存在或读取失败，无需清理
    return;
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    const absPath = resolve(dir, e.name);

    // 路径穿越检查
    if (absPath !== join(dirResolved, e.name) || !absPath.startsWith(dirResolved + sep)) {
      continue;
    }

    try {
      const st = await stat(absPath);
      if (Date.now() - st.mtimeMs > maxAgeMs) {
        await unlink(absPath);
      }
    } catch {
      // 忽略单个文件清理错误（可能已被删或无权限）
    }
  }
}

