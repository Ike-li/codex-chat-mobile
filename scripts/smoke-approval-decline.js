// scripts/smoke-approval-decline.js —— 全栈审批拒绝闭环 E2E。
// 触发审批（read-only 沙箱 + on-failure）→ 客户端拒绝 → 验证命令未执行、文件未创建。
// 用法：node scripts/smoke-approval-decline.js   （需 codex 已登录；会消耗少量额度）
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3197;
const WORK_DIR = process.env.SMOKE_DECLINE_WORK_DIR || '/tmp/codex-ccm-decline';
const DATA_DIR = process.env.SMOKE_DECLINE_DATA_DIR || `/tmp/codex-ccm-decline-data-${Date.now()}`;
const TARGET = join(WORK_DIR, 'decline-me.txt');

mkdirSync(WORK_DIR, { recursive: true });
try { rmSync(TARGET, { force: true }); } catch { /* noop */ }

const server = spawn('node', ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    CODEX_APPROVAL_POLICY: 'on-failure',
    CODEX_SANDBOX: 'read-only',
    WORK_DIR,
    CODEX_DATA_DIR: DATA_DIR,
    AUTH_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function cleanup(code) {
  try { server.kill('SIGTERM'); } catch { /* noop */ }
  process.exit(code);
}

const hard = setTimeout(() => {
  console.error('❌ TIMEOUT');
  cleanup(1);
}, 110000);

let ready;
const readyP = new Promise(resolve => { ready = resolve; });
server.stdout.on('data', d => {
  process.stdout.write(`[server] ${d}`);
  if (d.toString().includes('运行在')) ready();
});
server.stderr.on('data', d => process.stderr.write(`[server-err] ${d}`));

await Promise.race([
  readyP,
  new Promise((_, reject) => setTimeout(() => reject(new Error('start timeout')), 15000))
]).catch(err => {
  console.error(err.message);
  cleanup(1);
});

const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
const events = [];
let declined = false;
let settled = false;

function finish(reason) {
  if (settled) return;
  settled = true;
  clearTimeout(hard);
  const toolOk = events.some(e => e.type === 'tool_result' && e.payload?.ok);
  const fileAbsent = !existsSync(TARGET);
  const sawStop = events.some(e => e.type === 'error' || e.type === 'result');

  console.log('\n=== APPROVAL DECLINE E2E ===');
  console.log(`reason:${reason} | approval_declined:${declined} | tool_ok:${toolOk} | file_absent:${fileAbsent} | saw_stop:${sawStop}`);
  const pass = declined && !toolOk && fileAbsent && sawStop;
  console.log(pass ? '✅ PASS（拒绝审批→命令未执行）' : '❌ FAIL');
  cleanup(pass ? 0 : 1);
}

socket.on('connect', () => {
  console.log('[client] connected');
  socket.emit('user:message', {
    text: 'Use the shell tool to create a file: run `echo hi > decline-me.txt` in the current directory. You must actually run the command.'
  });
});
socket.on('connect_error', err => {
  console.error('connect_error', err.message);
  cleanup(1);
});
socket.on('agent:event', ev => {
  events.push(ev);
  if (['approval_request', 'tool_result', 'result', 'error'].includes(ev.type)) {
    console.log(`[evt] ${ev.type} ${JSON.stringify(ev.payload ?? {}).slice(0, 160)}`);
  }
  if (ev.type === 'approval_request') {
    declined = true;
    console.log('[client] auto-decline id=', ev.payload.approvalId);
    socket.emit('user:approval', { approvalId: ev.payload.approvalId, decision: 'decline' });
  }
  if (ev.type === 'error') finish('error');
  if (ev.type === 'result') finish('result');
});
