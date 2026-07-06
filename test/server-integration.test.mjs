import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

async function startIsolatedServer() {
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
    }, 1500);
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

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(1500).emit(event, payload, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
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
