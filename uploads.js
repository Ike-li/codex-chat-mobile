// uploads.js —— 附件校验与安全落盘。
// 手机选文件 → base64 → 写入 WORK_DIR/.ccm-uploads/ → 交给结构化 UserInput。
import { chmod, lstat, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { rejectableSymlinkComponent } from './file-security.js';

const UPLOAD_DIR = '.ccm-uploads';
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 单文件 10MB
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;  // 总量 20MB
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_IEND = Buffer.from('0000000049454e44ae426082', 'hex');

function detectImageMimeType(content) {
  if (
    content.length >= 45
    && content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && content.readUInt32BE(8) === 13
    && content.toString('ascii', 12, 16) === 'IHDR'
    && content.readUInt32BE(16) > 0
    && content.readUInt32BE(20) > 0
    && content.subarray(content.length - PNG_IEND.length).equals(PNG_IEND)
  ) {
    return 'image/png';
  }
  return null;
}

function decodeBase64Strict(data) {
  if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const unpadded = data.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  if (data.includes('=') && data.length % 4 !== 0) return null;
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== unpadded) return null;
  return decoded;
}

// 文件名收敛：只取 basename，去路径分隔/控制/危险字符，去前导点
function sanitizeName(name) {
  // eslint-disable-next-line no-control-regex -- 过滤文件名中的控制字符属安全收敛
  const base = basename(String(name ?? '')).replace(/[\x00-\x1f\x7f]/g, '');
  const safe = base.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return safe || 'file';
}

// 纯校验（零 IO），返回错误字符串或 null（通过）
export function validateAttachments(attachments) {
  if (attachments === undefined || attachments === null) return null;
  if (!Array.isArray(attachments)) return '附件必须是数组';
  if (attachments.length === 0) return null;
  if (attachments.length > MAX_FILES) {
    return `附件过多（${attachments.length}，上限 ${MAX_FILES}）`;
  }
  let total = 0;
  for (const a of attachments) {
    if (!a || typeof a.data !== 'string' || !a.data) return '附件缺少数据';
    if (typeof a.name !== 'string' || typeof a.mimeType !== 'string') return '附件缺少 name/mimeType';
    const decoded = decodeBase64Strict(a.data);
    if (!decoded) return `附件「${a.name}」数据不是合法 base64`;
    const bytes = decoded.length;
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
  let symlink = rejectableSymlinkComponent(dir);
  if (symlink) throw new Error(`上传目录路径包含可疑符号链接: ${symlink}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  symlink = rejectableSymlinkComponent(dir);
  if (symlink) throw new Error(`上传目录路径包含可疑符号链接: ${symlink}`);
  const directoryStat = await lstat(dir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('上传目录必须是普通目录');
  }
  await chmod(dir, 0o700);

  const dirResolved = resolve(dir);
  const saved = [];

  for (const a of attachments) {
    const content = decodeBase64Strict(a.data);
    if (!content) throw new Error(`附件「${a.name}」数据不是合法 base64`);
    const detectedMimeType = detectImageMimeType(content);
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
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }

    saved.push({
      absPath, name: a.name, mimeType: a.mimeType,
      size: content.length,
      kind: detectedMimeType ? 'image' : 'file',
      ...(detectedMimeType ? { detectedMimeType } : {}),
    });
  }
  return saved;
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

  try {
    const directoryStat = await lstat(dir);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('上传目录必须是普通目录');
    }
    await chmod(dir, 0o700);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }

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
