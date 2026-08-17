import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

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
