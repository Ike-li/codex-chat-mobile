#!/usr/bin/env node
// scripts/mock-server.js —— E2E 测试用 mock 服务器。
// 设置环境变量并启动 server.js，使用 mock codex app-server。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MOCK_CODEX = join(HERE, 'mock-codex.sh');
const TEMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-e2e-'));
const DATA_DIR = join(TEMP_DIR, 'data');
mkdirSync(DATA_DIR, { recursive: true });
// Initialize device files so server doesn't error
writeFileSync(join(DATA_DIR, 'trusted-devices.json'), '[]');
writeFileSync(join(DATA_DIR, 'pending-devices.json'), '[]');
writeFileSync(join(TEMP_DIR, 'README.md'), 'e2e workspace\n');
mkdirSync(join(TEMP_DIR, 'src'), { recursive: true });
writeFileSync(join(TEMP_DIR, 'src', 'app.js'), 'export {}\n');

// Set environment variables for test mode
process.env.CODEX_BIN = MOCK_CODEX;
process.env.PORT = '3232';
process.env.HOST = '127.0.0.1';
process.env.WORK_DIR = TEMP_DIR;
process.env.WORK_DIRS = TEMP_DIR;
process.env.CODEX_DATA_DIR = DATA_DIR;
process.env.CODEX_SANDBOX = 'read-only';
process.env.CODEX_APPROVAL_POLICY = 'on-request';
process.env.AUTH_TOKEN = ''; // No auth for E2E testing

// Import and run server.js
await import(join(ROOT, 'server.js'));
