// scripts/smoke-approval.js —— 全栈审批闭环 E2E。
// 触发审批（read-only 沙箱 + on-failure）→ 客户端自动批准 → 命令执行 → 完成。
// 用法：node scripts/smoke-approval.js   （需 codex 已登录；会消耗少量额度）
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3198;
const server = spawn('node', ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT),
    CODEX_APPROVAL_POLICY: 'on-failure', CODEX_SANDBOX: 'read-only',
    WORK_DIR: process.env.SMOKE_WORK_DIR || '/tmp/codex-ccm-approval', AUTH_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
function cleanup(code) { try { server.kill('SIGTERM'); } catch { /* noop */ } process.exit(code); }
const hard = setTimeout(() => { console.error('❌ TIMEOUT'); cleanup(1); }, 110000);

let ready; const readyP = new Promise(r => { ready = r; });
server.stdout.on('data', d => { process.stdout.write(`[server] ${d}`); if (d.toString().includes('运行在')) ready(); });
server.stderr.on('data', d => process.stderr.write(`[server-err] ${d}`));
await Promise.race([readyP, new Promise((_, j) => setTimeout(() => j(new Error('start timeout')), 15000))]).catch(e => { console.error(e.message); cleanup(1); });

const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
const events = [];
let approved = false;
socket.on('connect', () => {
  console.log('[client] connected');
  socket.emit('user:message', { text: 'Use the shell tool to create a file: run `echo hi > approve-me.txt` in the current directory. You must actually run the command.' });
});
socket.on('connect_error', e => { console.error('connect_error', e.message); cleanup(1); });
socket.on('agent:event', ev => {
  events.push(ev);
  if (['approval_request', 'tool_result', 'result', 'error'].includes(ev.type)) console.log(`[evt] ${ev.type} ${JSON.stringify(ev.payload ?? {}).slice(0, 120)}`);
  if (ev.type === 'approval_request') {
    approved = true;
    console.log('[client] auto-approve id=', ev.payload.approvalId);
    socket.emit('user:approval', { approvalId: ev.payload.approvalId, decision: 'accept' });
  }
  if (ev.type === 'result') {
    clearTimeout(hard);
    const okTool = events.some(e => e.type === 'tool_result' && e.payload.ok);
    console.log('\n=== APPROVAL E2E ===');
    console.log(`approval_requested:${approved} | tool_ok:${okTool}`);
    const pass = approved && okTool;
    console.log(pass ? '✅ PASS（审批→执行→完成）' : '❌ FAIL');
    cleanup(pass ? 0 : 1);
  }
});
