import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as socketClient } from 'socket.io-client';

const ENV_KEYS = [
  'CODEX_SERVER_NO_START',
  'CODEX_DATA_DIR',
  'CODEX_SESSIONS_FILE',
  'WORK_DIR',
  'WORK_DIRS',
  'PORT',
  'HOST',
  'AUTH_TOKEN',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'CODEX_BIN',
  'CODEX_FAKE_RPC_LOG',
];

test('server lifecycle exposes HTTP and Socket.IO behavior without starting Codex', async () => {
  const fixture = await startIsolatedServer();
  try {
    const health = await fetch(`${fixture.url}/health`, {
      headers: { 'x-auth-token': fixture.authToken },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await health.json()).status, 'ok');

    const vapid = await fetch(`${fixture.url}/push/vapid-public-key`);
    assert.equal(vapid.status, 503);
    assert.deepEqual(await vapid.json(), { error: 'push not configured' });

    const subscribe = await fetch(`${fixture.url}/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/sub' }),
    });
    assert.equal(subscribe.status, 503);

    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      const init = await waitForAgentEvent(socket, 'init');
      assert.equal(init.payload.cwd, fixture.workDir);
      assert.deepEqual(init.payload.workDirs, [fixture.workDir, fixture.altWorkDir]);

      const sessionList = await waitForAgentEvent(socket, 'session_list');
      assert.equal(sessionList.payload.cwd, fixture.workDir);

      const pendingDevices = await waitForAgentEvent(socket, 'pending_devices');
      assert.deepEqual(pendingDevices.payload.devices, []);

      socket.emit('user:message', { text: '   ' });
      const emptyMessage = await waitForAgentEvent(socket, 'system');
      assert.equal(emptyMessage.payload.isError, true);
      assert.match(emptyMessage.payload.message, /消息为空/);

      socket.emit('user:message', { text: 'x'.repeat(50001) });
      const longMessage = await waitForAgentEvent(socket, 'system');
      assert.equal(longMessage.payload.isError, true);
      assert.match(longMessage.payload.message, /消息过长/);

      const newAck = await emitWithAck(socket, 'session:new', { cwd: fixture.altWorkDir });
      assert.deepEqual(newAck, { ok: true });
      const switchedInit = await waitForAgentEvent(socket, 'init');
      assert.equal(switchedInit.payload.cwd, fixture.altWorkDir);

      const invalidSelect = await emitWithAck(socket, 'session:select', { sessionId: 42 });
      assert.equal(invalidSelect.ok, false);
      assert.match(invalidSelect.error, /无效会话/);

      const missingSelect = await emitWithAck(socket, 'session:select', { sessionId: 'missing-session' });
      assert.equal(missingSelect.ok, false);
      assert.match(missingSelect.error, /会话不存在/);

      const invalidFork = await emitWithAck(socket, 'session:fork', {});
      assert.equal(invalidFork.ok, false);
      assert.match(invalidFork.error, /没有可分叉/);

      const invalidCancel = await emitWithAck(socket, 'account:loginCancel', {});
      assert.equal(invalidCancel.ok, false);
      assert.match(invalidCancel.error, /无效登录任务/);

      const history = await emitWithAck(socket, 'session:history', { sessionId: 42 });
      assert.deepEqual(history, { messages: [] });

      const catchUp = await emitWithAck(socket, 'catch-up', { sessionId: 'missing-session', lastSeq: 0 });
      assert.deepEqual(catchUp, { replayed: 0, gap: false });

      socket.emit('user:interrupt');
      socket.emit('user:approval', { approvalId: 1, decision: 'decline' });
      socket.emit('session:switch', { instanceId: 'missing-instance' });
      socket.emit('user:approveDevice', { deviceId: '' });
      socket.emit('user:denyDevice', { deviceId: '' });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
  }
});

test('server routes a running user:message through turn/steer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-steer-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      socket.emit('user:message', { text: 'start long run' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');

      socket.emit('user:message', { text: 'steer while running' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'steer_submitted');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const steer = calls.find(call => call.method === 'turn/steer');
      assert.ok(steer, 'running user:message should call turn/steer');
      assert.deepEqual(steer.params, {
        threadId: 'thr_fake',
        input: [{ type: 'text', text: 'steer while running' }],
        expectedTurnId: 'turn_fake',
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server forks the active app-server thread into a new viewed instance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-fork-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      socket.emit('user:message', { text: 'source turn' });
      await waitForAgentEventMatching(socket, 'status', event => event.payload?.reason === 'turn_submitted');

      const ack = await emitWithAck(socket, 'session:fork', { ephemeral: true });
      assert.equal(ack.ok, true);
      assert.equal(ack.sessionId, 'thr_forked');
      assert.ok(ack.instanceId);

      const init = await waitForAgentEventMatching(socket, 'init', event => event.payload?.sessionId === 'thr_forked');
      assert.equal(init.payload.cwd, fixture.workDir);

      const instances = await waitForAgentEventMatching(socket, 'instances', event => event.payload?.viewingInstanceId === ack.instanceId);
      assert.ok(instances.payload.instances.some(item => item.instanceId === ack.instanceId && item.sessionId === 'thr_forked'));

      const sessionList = await waitForAgentEventMatching(socket, 'session_list', event => event.payload?.currentSessionId === 'thr_forked');
      assert.equal(sessionList.payload.cwd, fixture.workDir);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const fork = calls.find(call => call.method === 'thread/fork');
      assert.ok(fork, 'session:fork should call thread/fork');
      assert.deepEqual(fork.params, {
        threadId: 'thr_fake',
        cwd: fixture.workDir,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ephemeral: true,
      });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server starts chatgpt device-code login and forwards account notifications', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-login-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const ack = await emitWithAck(socket, 'account:loginStart', { type: 'chatgptDeviceCode' });
      assert.equal(ack.ok, true);
      assert.equal(ack.loginId, 'login_fake');
      assert.equal(ack.userCode, 'ABCD-EFGH');
      assert.equal(ack.verificationUrl, 'https://openai.com/device');

      const pending = await waitForAgentEventMatching(socket, 'account_login', event => event.payload?.status === 'pending');
      assert.equal(pending.payload.loginId, 'login_fake');

      const completed = await waitForAgentEventMatching(socket, 'account_login', event => event.payload?.status === 'completed');
      assert.equal(completed.payload.success, true);

      const updated = await waitForAgentEvent(socket, 'account_updated');
      assert.deepEqual(updated.payload, { authMode: 'chatgpt', planType: 'plus' });

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const loginStart = calls.find(call => call.method === 'account/login/start');
      assert.deepEqual(loginStart.params, { type: 'chatgptDeviceCode' });
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function startIsolatedServer({ codexBin, rpcLog } = {}) {
  const previous = snapshotEnv();
  const root = mkdtempSync(join(tmpdir(), 'ccm-server-test-'));
  let workDir = join(root, 'work');
  let altWorkDir = join(root, 'alt-work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(altWorkDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  workDir = realpathSync(workDir);
  altWorkDir = realpathSync(altWorkDir);

  process.env.CODEX_SERVER_NO_START = '1';
  process.env.CODEX_DATA_DIR = dataDir;
  process.env.WORK_DIR = workDir;
  process.env.WORK_DIRS = altWorkDir;
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.AUTH_TOKEN = 'server-integration-token';
  if (codexBin) process.env.CODEX_BIN = codexBin;
  if (rpcLog) process.env.CODEX_FAKE_RPC_LOG = rpcLog;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;

  const serverModule = await import(`../server.js?serverIntegration=${Date.now()}-${Math.random()}`);
  const server = serverModule.startServer();
  assert.ok(server && typeof server.address === 'function', 'startServer should return the listening http.Server');
  await once(server, 'listening');
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    workDir,
    altWorkDir,
    authToken: process.env.AUTH_TOKEN,
    async close() {
      await new Promise(resolve => serverModule.stopServer(resolve));
      restoreEnv(previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function connectSocket(url, token) {
  const socket = socketClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token },
  });
  socket.__agentEvents = [];
  socket.on('agent:event', event => {
    socket.__agentEvents.push(event);
  });
  await once(socket, 'connect');
  return socket;
}

function waitForAgentEvent(socket, type) {
  const existingIndex = socket.__agentEvents?.findIndex(event => event?.type === type) ?? -1;
  if (existingIndex >= 0) {
    const [event] = socket.__agentEvents.splice(existingIndex, 1);
    return Promise.resolve(event);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('agent:event', onEvent);
      reject(new Error(`Timed out waiting for agent:event ${type}`));
    }, 5000);
    const onEvent = event => {
      if (event?.type !== type) return;
      const bufferedIndex = socket.__agentEvents?.findIndex(item => item === event) ?? -1;
      if (bufferedIndex >= 0) socket.__agentEvents.splice(bufferedIndex, 1);
      clearTimeout(timer);
      socket.off('agent:event', onEvent);
      resolve(event);
    };
    socket.on('agent:event', onEvent);
  });
}

function waitForAgentEventMatching(socket, type, predicate) {
  const existingIndex = socket.__agentEvents?.findIndex(event => event?.type === type && predicate(event)) ?? -1;
  if (existingIndex >= 0) {
    const [event] = socket.__agentEvents.splice(existingIndex, 1);
    return Promise.resolve(event);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('agent:event', onEvent);
      const seen = (socket.__agentEvents || []).slice(-10).map(event => ({
        type: event?.type,
        reason: event?.payload?.reason,
        message: event?.payload?.message,
      }));
      reject(new Error(`Timed out waiting for matching agent:event ${type}; recent=${JSON.stringify(seen)}`));
    }, 5000);
    const onEvent = event => {
      if (event?.type !== type || !predicate(event)) return;
      const bufferedIndex = socket.__agentEvents?.findIndex(item => item === event) ?? -1;
      if (bufferedIndex >= 0) socket.__agentEvents.splice(bufferedIndex, 1);
      clearTimeout(timer);
      socket.off('agent:event', onEvent);
      resolve(event);
    };
    socket.on('agent:event', onEvent);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

function createFakeCodexBin(root) {
  const file = join(root, 'fake-codex.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.CODEX_FAKE_RPC_LOG;
const threadId = 'thr_fake';
const turnId = 'turn_fake';
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function log(message) {
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + '\\n');
}

rl.on('line', line => {
  const message = JSON.parse(line);
  log(message);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === 'turn/start') return send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
  if (message.method === 'thread/fork') {
    send({ id: message.id, result: { thread: { id: 'thr_forked', forkedFromId: threadId } } });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (message.method === 'account/login/start') {
    send({ id: message.id, result: {
      type: 'chatgptDeviceCode',
      loginId: 'login_fake',
      verificationUrl: 'https://openai.com/device',
      userCode: 'ABCD-EFGH'
    } });
    setTimeout(() => {
      send({ method: 'account/login/completed', params: { loginId: 'login_fake', success: true, error: null } });
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
      setTimeout(() => process.exit(0), 20);
    }, 10);
    return;
  }
  if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId } });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  send({ id: message.id, result: {} });
});
`, 'utf8');
  chmodSync(file, 0o700);
  return file;
}

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnv(previous) {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}
