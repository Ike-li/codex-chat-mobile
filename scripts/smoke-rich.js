// scripts/smoke-rich.js —— 全栈富事件 E2E：让 codex 改文件，验证 file_change 信封到达客户端。
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3197;
const server = spawn('node', ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT),
    CODEX_APPROVAL_POLICY: 'never', CODEX_SANDBOX: 'workspace-write',
    WORK_DIR: '/tmp/codex-ccm-rich', AUTH_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
function cleanup(code) { try { server.kill('SIGTERM'); } catch { /* noop */ } process.exit(code); }
const hard = setTimeout(() => { console.error('❌ TIMEOUT'); cleanup(1); }, 110000);
let ready; const readyP = new Promise(r => { ready = r; });
server.stdout.on('data', d => { if (d.toString().includes('运行在')) ready(); });
server.stderr.on('data', () => {});
await Promise.race([readyP, new Promise((_, j) => setTimeout(() => j(new Error('start timeout')), 15000))]).catch(e => { console.error(e.message); cleanup(1); });

const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
const events = [];
socket.on('connect', () => socket.emit('user:message', { text: 'Create two files in the current directory using your file tools: a.txt containing aaa and b.txt containing bbb.' }));
socket.on('connect_error', e => { console.error('connect_error', e.message); cleanup(1); });
socket.on('agent:event', ev => {
  events.push(ev);
  if (['file_change', 'plan', 'result', 'error'].includes(ev.type)) console.log(`[evt] ${ev.type} ${JSON.stringify(ev.payload ?? {}).slice(0, 160)}`);
  if (ev.type === 'result') {
    clearTimeout(hard);
    const fc = events.find(e => e.type === 'file_change');
    console.log('\n=== RICH E2E ===');
    const pass = !!fc && (fc.payload.files || []).length > 0;
    console.log(`file_change:${!!fc} files:${fc ? fc.payload.files.length : 0}`);
    console.log(pass ? '✅ PASS（file_change 到达）' : '❌ FAIL');
    cleanup(pass ? 0 : 1);
  }
});
