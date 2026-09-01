import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

function resolveCandidate(raw, baseDir) {
  if (!raw) return raw;
  return isAbsolute(raw) ? raw : join(baseDir, raw);
}

export function parseWorkdirSources(raw, {
  baseDir = process.cwd(),
  readFileSync: readFile = readFileSync,
  statSync: stat = statSync,
} = {}) {
  const text = String(raw || '').trim();
  if (!text) return { paths: [], warnings: [] };

  const candidate = resolveCandidate(text, baseDir);
  try {
    const info = stat(candidate);
    if (info.isFile()) {
      const parsed = JSON.parse(readFile(candidate, 'utf8'));
      if (!Array.isArray(parsed)) {
        return { paths: [], warnings: [`WORK_DIRS JSON 不是数组：${text}`] };
      }
      const paths = [];
      const warnings = [];
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry.trim()) {
          paths.push(entry.trim());
          continue;
        }
        if (entry && typeof entry.path === 'string' && entry.path.trim()) {
          paths.push(entry.path.trim());
          continue;
        }
        warnings.push(`WORK_DIRS 忽略无效条目：${JSON.stringify(entry)}`);
      }
      return { paths, warnings };
    }
  } catch (err) {
    if (existsSync(candidate) || /\.json$/i.test(text)) {
      return { paths: [], warnings: [`WORK_DIRS 无法读取 ${text}：${err.message}`] };
    }
  }

  return {
    paths: text.split(',').map(item => item.trim()).filter(Boolean),
    warnings: [],
  };
}

export function resolveWorkdirAllowlist({
  workDir,
  extra = '',
  baseDir = process.cwd(),
  realpathSync: realpath = realpathSync,
  statSync: stat = statSync,
  readFileSync: readFile = readFileSync,
} = {}) {
  const warnings = [];
  let primary;
  try {
    if (!stat(workDir).isDirectory()) throw new Error(`WORK_DIR 不是目录：${workDir}`);
    primary = realpath(workDir);
  } catch (err) {
    throw new Error(err.message.includes('WORK_DIR') ? err.message : `WORK_DIR 不存在：${workDir}（请在 .env 中设置有效路径）`);
  }

  const workDirs = [primary];
  const parsed = parseWorkdirSources(extra, { baseDir, readFileSync: readFile, statSync: stat });
  warnings.push(...parsed.warnings);
  for (const raw of parsed.paths) {
    try {
      const resolved = realpath(raw);
      if (!stat(resolved).isDirectory()) {
        warnings.push(`WORK_DIRS 忽略（不是目录）：${raw}`);
        continue;
      }
      if (!workDirs.includes(resolved)) workDirs.push(resolved);
    } catch {
      warnings.push(`WORK_DIRS 忽略（不存在/不可达）：${raw}`);
    }
  }
  return { workDir: primary, workDirs, warnings };
}

// app-server 的 fs/* 只校验「是不是绝对路径」——它假定 client 与自己同机、物理接触即可信。
// 我们的 client 是远程手机，那个假定不成立，作用域只能由这一侧兜住。
//
// 目的是防误操作，不是防攻击者：能发消息的设备照样可以让 agent 去读同一个文件。它挡住的
// 是「随手翻文件翻到 ~/.ssh/id_rsa」，以及把工作区外的凭据挡在默认视野之外——凭据外泄是
// 唯一撤销设备也收不回的破坏。
//
// 返回 realpath 归一后的绝对路径；不在任何工作区内时返回 null。
export function resolveWithinWorkdirs(rawPath, workDirs = [], {
  realpathSync: realpath = realpathSync,
} = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  if (!isAbsolute(rawPath)) return null;
  if (!Array.isArray(workDirs) || workDirs.length === 0) return null;

  // 目标可以尚不存在（新建文件），此时对最近的已存在祖先做 realpath，再把不存在的尾巴接
  // 回去。不存在的组件不可能是软链接，所以拼回去不会重新打开逃逸口。
  let probe = resolve(rawPath);
  const tail = [];
  for (;;) {
    try {
      probe = realpath(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
  const resolved = tail.length ? join(probe, ...tail) : probe;

  // 必须比到分隔符：只用 startsWith 的话 /srv/work 会顺带放行 /srv/work-other。
  for (const dir of workDirs) {
    if (resolved === dir || resolved.startsWith(dir + sep)) return resolved;
  }
  return null;
}
