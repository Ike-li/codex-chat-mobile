// scripts/doctor.js —— 启动前自检脚本
// 检查：CODEX_BIN/codex in PATH、WORK_DIR、data/ 可写、AUTH_TOKEN
import { statSync, accessSync, mkdirSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Load .env if present
try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env') });
} catch { /* dotenv not installed yet or no .env */ }

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    const result = fn();
    console.log(`  ✅ ${label}${result ? ': ' + result : ''}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${label}: ${err.message}`);
    failed++;
  }
}

console.log('\nCodex Chat Mobile — 启动自检\n');

// D1: codex binary
check('CODEX_BIN / codex in PATH', () => {
  const bin = process.env.CODEX_BIN || '';
  if (bin) {
    statSync(bin);
    return bin;
  }
  const found = execSync('which codex', { encoding: 'utf8' }).trim();
  if (!found) throw new Error('未找到 codex 命令');
  return found;
});

// D2: WORK_DIR
check('WORK_DIR 是有效目录', () => {
  const dir = process.env.WORK_DIR;
  if (!dir) throw new Error('WORK_DIR 未设置');
  if (!statSync(dir).isDirectory()) throw new Error(`不是目录: ${dir}`);
  return dir;
});

// D3: data/ writable
check('data/ 目录可写', () => {
  const dataDir = process.env.CODEX_DATA_DIR || join(ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
  return dataDir;
});

// D4: AUTH_TOKEN
check('AUTH_TOKEN 已设置', () => {
  if (!process.env.AUTH_TOKEN) throw new Error('AUTH_TOKEN 未设置（公网访问时需要）');
  return `${process.env.AUTH_TOKEN.slice(0, 4)}****`;
});

// D5: 绑定到非 loopback 时的 token 强度。server-security 会在启动时 fail-closed，
// 这里提前说清楚，免得部署到服务器上才发现起不来。
check('远程绑定的 token 强度', () => {
  const host = process.env.HOST || '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (loopback) return `HOST=${host}（仅本机，无额外要求）`;
  const token = process.env.AUTH_TOKEN || '';
  if (token.length < 32) throw new Error(`HOST=${host} 需要 AUTH_TOKEN ≥32 字符，当前 ${token.length}`);
  return `HOST=${host}，token ${token.length} 字符`;
});

// D6: 无图形界面。这是本项目相对官方 Remote 的差异点——官方要求 host 跑 ChatGPT 桌面 app
// （仅 macOS/Windows）。缺 DISPLAY 是服务器的常态，不该影响任何东西，明确报出来让人放心。
check('无图形界面也能运行', () => {
  const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  return headless ? '未检测到 DISPLAY/WAYLAND_DISPLAY，无需图形界面' : '当前有图形会话（无头环境同样支持）';
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
if (failed > 0) process.exit(1);
