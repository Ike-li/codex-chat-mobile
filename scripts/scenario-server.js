// Browser acceptance server: deterministic Codex-like Socket.IO event stream.
// It serves the real mobile UI while simulating app-server events for scenario checks.
import { createServer } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { Server } from 'socket.io';

const PORT = Number(process.env.SCENARIO_PORT || process.env.PORT) || 3227;
const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const WORK_DIR = process.env.WORK_DIR || '/tmp/codex-chat-mobile-scenario';
const SESSION_ID = 'thr_scenario_mobile';

const app = express();
app.use(express.static(join(ROOT, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    if (filePath.endsWith('/js/sw.js')) res.setHeader('Service-Worker-Allowed', '/');
  }
}));
app.get('/health', (_req, res) => res.json({ status: 'ok', scenario: true, sessionId: SESSION_ID }));

const httpServer = createServer(app);
const io = new Server(httpServer);
const buffers = new Map();
let globalInstance = 0;

function makeState() {
  return {
    epoch: `scenario.${Date.now()}.${++globalInstance}`,
    seq: 0,
    busy: false,
    lastUserText: '',
    awaitingApproval: null,
    threads: [{
      id: SESSION_ID,
      title: 'Scenario acceptance',
      cwd: WORK_DIR,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    }]
  };
}

function emitEvent(socket, state, type, payload) {
  const envelope = {
    seq: ++state.seq,
    epoch: state.epoch,
    sessionId: SESSION_ID,
    instanceId: 'scenario',
    cwd: WORK_DIR,
    ts: Date.now(),
    type,
    payload
  };
  if (!buffers.has(socket.id)) buffers.set(socket.id, []);
  buffers.get(socket.id).push(envelope);
  socket.emit('agent:event', envelope);
  return envelope;
}

function emitServer(socket, type, payload) {
  socket.emit('agent:event', {
    seq: 0,
    epoch: 'server',
    sessionId: SESSION_ID,
    ts: Date.now(),
    type,
    payload
  });
}

function emitStatus(socket, state, reason, extra = {}) {
  emitEvent(socket, state, 'status', {
    reason,
    state: extra.state || (state.awaitingApproval ? 'awaiting_approval' : (state.busy ? 'running' : 'idle')),
    sessionId: SESSION_ID,
    instanceId: 'scenario',
    cwd: WORK_DIR,
    busy: state.busy,
    queueLength: 0,
    pendingApprovals: state.awaitingApproval ? 1 : 0,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    childRunning: true,
    lastActivity: Date.now()
  });
}

function finish(socket, state, ok = true, status = ok ? 'completed' : 'failed') {
  state.busy = false;
  emitEvent(socket, state, 'result', { ok, status });
  emitStatus(socket, state, 'turn_completed');
}

async function sendText(socket, state, text) {
  for (const part of text.match(/.{1,24}/gs) || []) {
    emitEvent(socket, state, 'text_delta', { text: part });
    await delay(20);
  }
}

async function handleMessage(socket, state, text) {
  state.busy = true;
  state.lastUserText = text;
  emitEvent(socket, state, 'user_message', { text });
  emitStatus(socket, state, 'turn_started');

  if (text.startsWith('/')) {
    await sendText(socket, state, `CLI command accepted: ${text}\nModel/reasoning controls are delegated to Codex slash command handling.`);
    finish(socket, state);
    return;
  }

  if (/create|创建|task/i.test(text)) {
    emitEvent(socket, state, 'plan', { plan: [
      { step: '创建任务', status: 'completed' },
      { step: '恢复会话', status: 'completed' },
      { step: '审核结果', status: 'pending' }
    ] });
    await sendText(socket, state, 'Created task in scenario session. Resume token and recent output are preserved.');
    emitEvent(socket, state, 'diff', { diff: '--- a/task.md\n+++ b/task.md\n@@\n+ Scenario task created\n' });
    finish(socket, state);
    return;
  }

  if (/permission|权限|approve/i.test(text)) {
    state.awaitingApproval = { id: 501, command: 'printf ok > scenario.txt' };
    emitEvent(socket, state, 'approval_request', {
      approvalId: 501,
      kind: 'item/commandExecution/requestApproval',
      command: state.awaitingApproval.command,
      cwd: WORK_DIR,
      reason: 'Scenario requires explicit shell approval.',
      availableDecisions: ['accept', 'decline']
    });
    emitStatus(socket, state, 'approval_requested', { state: 'awaiting_approval' });
    return;
  }

  if (/fail|失败|retry/i.test(text)) {
    emitEvent(socket, state, 'tool_use', {
      toolUseId: 'cmd_fail',
      name: 'ShellCall',
      inputSummary: 'node missing-script.js'
    });
    emitEvent(socket, state, 'tool_output_delta', {
      toolUseId: 'cmd_fail',
      stream: 'stderr',
      text: '\u001b[31mError: missing-script.js not found\u001b[0m\n'
    });
    emitEvent(socket, state, 'tool_result', {
      toolUseId: 'cmd_fail',
      ok: false,
      status: 'failed',
      exitCode: 1,
      outputSummary: 'Error: missing-script.js not found'
    });
    emitEvent(socket, state, 'error', { message: 'Command failed with exit code 1', recoverable: true });
    finish(socket, state, false, 'failed');
    return;
  }

  if (/long|日志|log/i.test(text)) {
    emitEvent(socket, state, 'tool_use', {
      toolUseId: 'cmd_long',
      name: 'ShellCall',
      inputSummary: 'for i in {1..80}; do echo line-$i; done'
    });
    for (let i = 1; i <= 80; i += 1) {
      emitEvent(socket, state, 'tool_output_delta', {
        toolUseId: 'cmd_long',
        stream: 'stdout',
        text: `line-${String(i).padStart(2, '0')} scenario long log output\n`
      });
      if (i % 20 === 0) await delay(10);
    }
    emitEvent(socket, state, 'tool_result', {
      toolUseId: 'cmd_long',
      ok: true,
      status: 'completed',
      exitCode: 0,
      outputSummary: '80 log lines emitted'
    });
    await sendText(socket, state, 'Long log command completed and remains scrollable.');
    finish(socket, state);
    return;
  }

  await sendText(socket, state, 'Scenario response complete.');
  finish(socket, state);
}

async function handleApproval(socket, state, payload) {
  const decision = payload?.decision || 'decline';
  if (!state.awaitingApproval) return;
  const approval = state.awaitingApproval;
  state.awaitingApproval = null;
  if (decision !== 'accept') {
    emitEvent(socket, state, 'error', { message: 'Permission declined; command was not executed.', recoverable: true });
    finish(socket, state, false, 'failed');
    return;
  }
  emitEvent(socket, state, 'tool_use', {
    toolUseId: 'cmd_permission',
    name: 'ShellCall',
    inputSummary: approval.command
  });
  emitEvent(socket, state, 'tool_output_delta', { toolUseId: 'cmd_permission', stream: 'stdout', text: 'ok\n' });
  emitEvent(socket, state, 'tool_result', {
    toolUseId: 'cmd_permission',
    ok: true,
    status: 'completed',
    exitCode: 0,
    outputSummary: 'ok'
  });
  await sendText(socket, state, 'Permission approved and command completed.');
  finish(socket, state);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

io.on('connection', socket => {
  const state = makeState();
  emitServer(socket, 'init', { sessionId: SESSION_ID, cwd: WORK_DIR, versions: { codex: 'scenario-codex 0.0.0' } });
  emitStatus(socket, state, 'connect');

  socket.on('user:message', payload => {
    const text = typeof payload === 'string' ? payload : payload?.text;
    if (typeof text === 'string' && text.trim()) handleMessage(socket, state, text.trim());
  });
  socket.on('user:approval', payload => handleApproval(socket, state, payload));
  socket.on('user:interrupt', () => {
    state.busy = false;
    state.awaitingApproval = null;
    emitEvent(socket, state, 'queue_cleared', { reason: 'interrupt', dropped: 0 });
    emitStatus(socket, state, 'interrupt');
  });
  socket.on('session:new', (_payload, ack) => {
    emitServer(socket, 'init', { sessionId: SESSION_ID, cwd: WORK_DIR, versions: { codex: 'scenario-codex 0.0.0' } });
    if (typeof ack === 'function') ack({ ok: true });
  });
  socket.on('thread:list', (_payload, ack) => {
    if (typeof ack === 'function') {
      ack({ ok: true, threads: state.threads, nextCursor: null, backwardsCursor: null });
    }
  });
  socket.on('thread:select', (payload, ack) => {
    const threadId = payload?.threadId || SESSION_ID;
    emitServer(socket, 'init', { sessionId: SESSION_ID, cwd: WORK_DIR, versions: { codex: 'scenario-codex 0.0.0' } });
    if (typeof ack === 'function') {
      ack({ ok: true, sessionId: threadId, threadId, instanceId: 'scenario', cwd: WORK_DIR });
    }
  });
  socket.on('thread:history', (payload, ack) => {
    const threadId = payload?.threadId || SESSION_ID;
    const messages = state.lastUserText ? [{ role: 'user', content: state.lastUserText }] : [];
    if (typeof ack === 'function') {
      ack({
        ok: true,
        thread: { id: threadId, name: 'Scenario acceptance', cwd: WORK_DIR, turns: [] },
        messages,
        source: 'thread/read',
      });
    }
  });
  socket.on('catch-up', ({ lastSeq } = {}, ack) => {
    const events = (buffers.get(socket.id) || []).filter(e => e.seq > Number(lastSeq || 0));
    for (const event of events) socket.emit('agent:event', event);
    if (typeof ack === 'function') ack({ replayed: events.length, gap: false });
  });
  socket.on('disconnect', () => buffers.delete(socket.id));
});

httpServer.listen(PORT, () => {
  console.log(`[scenario] listening on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
