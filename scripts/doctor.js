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

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
if (failed > 0) process.exit(1);
