import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  'CODEX_P3_EXPERIMENTAL',
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

test('server exposes P1 native app-server controls over Socket.IO', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-p1-controls-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const threadList = await emitWithAck(socket, 'thread:list', { archived: false });
      assert.equal(threadList.ok, true);
      assert.equal(threadList.threads[0].id, 'thr_fake');

      assert.equal((await emitWithAck(socket, 'thread:rename', { threadId: 'thr_fake', name: 'Mobile run' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:archive', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:unarchive', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:compact', { threadId: 'thr_fake' })).ok, true);
      assert.equal((await emitWithAck(socket, 'thread:rollback', { threadId: 'thr_fake', numTurns: 2 })).ok, true);

      const compact = await waitForAgentEvent(socket, 'compact');
      assert.equal(compact.payload.status, 'compacted');

      const models = await emitWithAck(socket, 'models:read', {});
      assert.equal(models.ok, true);
      assert.equal(models.models[0].model, 'gpt-5.5');
      assert.equal(models.capabilities.webSearch, true);

      const dir = await emitWithAck(socket, 'fs:readDirectory', { path: fixture.workDir });
      assert.equal(dir.ok, true);
      assert.equal(dir.entries[0].fileName, 'README.md');

      const file = await emitWithAck(socket, 'fs:readFile', { path: join(fixture.workDir, 'README.md') });
      assert.equal(file.ok, true);
      assert.equal(Buffer.from(file.dataBase64, 'base64').toString('utf8'), 'hello from fake file');

      const account = await emitWithAck(socket, 'account:read', {});
      assert.equal(account.ok, true);
      assert.equal(account.account.account.type, 'chatgpt');
      assert.equal(account.usage.summary.lifetimeTokens, 123);
      assert.equal(account.rateLimits.rateLimits.limitId, 'codex');

      const mcp = await emitWithAck(socket, 'mcp:read', {});
      assert.equal(mcp.ok, true);
      assert.equal(mcp.servers[0].name, 'github');

      const skills = await emitWithAck(socket, 'skills:read', {});
      assert.equal(skills.ok, true);
      assert.equal(skills.entries[0].cwd, fixture.workDir);

      const detected = await emitWithAck(socket, 'externalAgentConfig:detect', {});
      assert.equal(detected.ok, true);
      assert.equal(detected.items[0].description, 'AGENTS.md');

      const imported = await emitWithAck(socket, 'externalAgentConfig:import', { migrationItems: detected.items });
      assert.equal(imported.ok, true);
      assert.equal(imported.importId, 'import_fake');

      const deleted = await emitWithAck(socket, 'thread:delete', { threadId: 'thr_fake' });
      assert.equal(deleted.ok, true);

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const methods = calls.map(call => call.method).filter(Boolean);
      for (const method of [
        'thread/list',
        'thread/name/set',
        'thread/archive',
        'thread/unarchive',
        'thread/compact/start',
        'thread/rollback',
        'model/list',
        'modelProvider/capabilities/read',
        'fs/readDirectory',
        'fs/readFile',
        'account/read',
        'account/usage/read',
        'account/rateLimits/read',
        'mcpServerStatus/list',
        'skills/list',
        'externalAgentConfig/detect',
        'externalAgentConfig/import',
        'thread/delete',
      ]) {
        assert.ok(methods.includes(method), `expected ${method}`);
      }
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server gates P2 admin app-server controls with unlock, per-action confirmation, and audit log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-p2-admin-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const filePath = join(fixture.workDir, 'admin.txt');
      const denied = await emitWithAck(socket, 'admin:fsWriteFile', {
        path: filePath,
        dataBase64: Buffer.from('secret file body').toString('base64'),
        adminConfirm: 'admin:fsWriteFile',
      });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /Admin/);

      const badUnlock = await emitWithAck(socket, 'admin:unlock', { confirmText: 'yes' });
      assert.equal(badUnlock.ok, false);

      const unlock = await emitWithAck(socket, 'admin:unlock', { confirmText: 'ENABLE ADMIN' });
      assert.equal(unlock.ok, true);
      assert.equal(unlock.adminMode, true);

      const missingActionConfirm = await emitWithAck(socket, 'admin:fsWriteFile', {
        path: filePath,
        dataBase64: Buffer.from('secret file body').toString('base64'),
      });
      assert.equal(missingActionConfirm.ok, false);
      assert.match(missingActionConfirm.error, /confirm/i);

      const actions = [
        ['admin:configWrite', { keyPath: 'model', value: 'gpt-5.5', mergeStrategy: 'replace' }],
        ['admin:configBatchWrite', { edits: [{ keyPath: 'approval_policy', value: 'on-request', mergeStrategy: 'upsert' }], reloadUserConfig: true }],
        ['admin:pluginInstall', { pluginName: 'gh', remoteMarketplaceName: 'official' }],
        ['admin:pluginUninstall', { pluginId: 'plugin_gh' }],
        ['admin:marketplaceAdd', { source: 'https://example.com/market.git', refName: 'main' }],
        ['admin:marketplaceRemove', { marketplaceName: 'community' }],
        ['admin:marketplaceUpgrade', { marketplaceName: 'community' }],
        ['admin:fsWriteFile', { path: filePath, dataBase64: Buffer.from('secret file body').toString('base64') }],
        ['admin:fsRemove', { path: filePath, recursive: false, force: true }],
        ['admin:fsCopy', { sourcePath: join(fixture.workDir, 'a.txt'), destinationPath: join(fixture.workDir, 'b.txt'), recursive: false }],
        ['admin:mcpToolCall', { threadId: 'thr_fake', server: 'github', tool: 'search', arguments: { secret: 'should-not-log' } }],
        ['admin:accountLogout', {}],
      ];
      for (const [event, payload] of actions) {
        const ack = await emitWithAck(socket, event, { ...payload, adminConfirm: event });
        assert.equal(ack.ok, true, `${event}: ${ack.error || ''}`);
      }

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const methods = calls.map(call => call.method).filter(Boolean);
      for (const method of [
        'config/value/write',
        'config/batchWrite',
        'plugin/install',
        'plugin/uninstall',
        'marketplace/add',
        'marketplace/remove',
        'marketplace/upgrade',
        'fs/writeFile',
        'fs/remove',
        'fs/copy',
        'mcpServer/tool/call',
        'account/logout',
      ]) {
        assert.ok(methods.includes(method), `expected ${method}`);
      }

      const auditPath = join(fixture.dataDir, 'admin-audit.jsonl');
      assert.equal(statSync(auditPath).mode & 0o777, 0o600);
      const audit = readFileSync(auditPath, 'utf8');
      assert.match(audit, /"event":"unlock"/);
      assert.match(audit, /"event":"success"/);
      assert.match(audit, /"event":"denied"/);
      assert.match(audit, /"action":"admin:mcpToolCall"/);
      assert.doesNotMatch(audit, /secret file body/);
      assert.doesNotMatch(audit, /should-not-log/);
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server exposes P3 experimental controls only behind feature flag', async () => {
  const disabledFixture = await startIsolatedServer();
  try {
    const socket = await connectSocket(disabledFixture.url, disabledFixture.authToken);
    try {
      const denied = await emitWithAck(socket, 'p3:terminalSpawn', { command: ['bash'] });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /P3.*disabled/i);
    } finally {
      socket.disconnect();
    }
  } finally {
    await disabledFixture.close();
  }

  const root = mkdtempSync(join(tmpdir(), 'ccm-p3-test-'));
  const rpcLog = join(root, 'rpc.jsonl');
  const codexBin = createFakeCodexBin(root);
  const fixture = await startIsolatedServer({ codexBin, rpcLog, p3Experimental: true });
  try {
    const socket = await connectSocket(fixture.url, fixture.authToken);
    try {
      await waitForAgentEvent(socket, 'init');

      const capabilities = await emitWithAck(socket, 'p3:capabilities', { cwd: fixture.workDir });
      assert.equal(capabilities.ok, true);

      const terminal = await emitWithAck(socket, 'p3:terminalSpawn', {
        cwd: fixture.workDir,
        processId: 'term_server',
        command: ['bash', '-lc', 'echo p3'],
        cols: 100,
        rows: 30,
      });
      assert.equal(terminal.ok, true);
      const termOutput = await waitForAgentEvent(socket, 'term_output');
      assert.equal(termOutput.payload.processId, 'term_server');
      assert.equal(termOutput.payload.text, 'p3\n');

      const write = await emitWithAck(socket, 'p3:terminalWrite', { processId: 'term_server', text: 'pwd\n' });
      assert.equal(write.ok, true);
      const resize = await emitWithAck(socket, 'p3:terminalResize', { processId: 'term_server', cols: 120, rows: 40 });
      assert.equal(resize.ok, true);
      const terminate = await emitWithAck(socket, 'p3:terminalTerminate', { processId: 'term_server' });
      assert.equal(terminate.ok, true);

      const turns = await emitWithAck(socket, 'p3:threadTurns', { threadId: 'thr_fake' });
      assert.equal(turns.ok, true);
      assert.equal(turns.source, 'thread/read');
      assert.equal(turns.turns[0].id, 'turn_fake');

      const search = await emitWithAck(socket, 'p3:threadSearch', { query: 'fake', limit: 5 });
      assert.equal(search.ok, true);
      assert.equal(search.source, 'thread/list');
      assert.equal(search.results[0].id, 'thr_fake');

      const realtime = await waitForAgentEvent(socket, 'realtime');
      assert.equal(realtime.payload.event, 'sdp');
      const remote = await waitForAgentEvent(socket, 'remote_control');
      assert.equal(remote.payload.serverName, 'local');

      const calls = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const initialize = calls.find(call => call.method === 'initialize');
      assert.equal(initialize.params.capabilities.experimentalApi, true);
      const methods = calls.map(call => call.method).filter(Boolean);
      for (const method of [
        'experimentalFeature/list',
        'command/exec',
        'command/exec/write',
        'command/exec/resize',
        'command/exec/terminate',
        'thread/read',
        'thread/list',
      ]) {
        assert.ok(methods.includes(method), `expected ${method}`);
      }
    } finally {
      socket.disconnect();
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function startIsolatedServer({ codexBin, rpcLog, p3Experimental = false } = {}) {
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
  if (p3Experimental) process.env.CODEX_P3_EXPERIMENTAL = '1';
  else delete process.env.CODEX_P3_EXPERIMENTAL;
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
    dataDir,
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
	  if (message.method === 'thread/list') return send({ id: message.id, result: { data: [{
	    id: threadId,
	    sessionId: threadId,
	    preview: 'fake thread',
	    name: 'Fake thread',
	    modelProvider: 'openai',
	    createdAt: 1710000000,
	    updatedAt: 1710000100,
	    recencyAt: 1710000100,
	    cwd: process.env.WORK_DIR,
	    status: { type: 'idle' },
	    turns: []
	  }], nextCursor: null, backwardsCursor: null } });
	  if (message.method === 'thread/name/set') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/archive') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/unarchive') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/delete') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/compact/start') {
	    send({ id: message.id, result: {} });
	    setTimeout(() => send({ method: 'thread/compacted', params: { threadId: message.params.threadId, turnId } }), 5);
	    return;
	  }
	  if (message.method === 'thread/rollback') return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
	  if (message.method === 'model/list') return send({ id: message.id, result: { data: [{ id: 'model_1', model: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', inputModalities: ['text'], serviceTiers: [], defaultServiceTier: null, isDefault: true }], nextCursor: null } });
	  if (message.method === 'modelProvider/capabilities/read') return send({ id: message.id, result: { namespaceTools: true, imageGeneration: false, webSearch: true } });
	  if (message.method === 'fs/readDirectory') return send({ id: message.id, result: { entries: [{ fileName: 'README.md', isDirectory: false, isFile: true }] } });
	  if (message.method === 'fs/readFile') return send({ id: message.id, result: { dataBase64: Buffer.from('hello from fake file').toString('base64') } });
	  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus' }, requiresOpenaiAuth: false } });
	  if (message.method === 'account/usage/read') return send({ id: message.id, result: { summary: { lifetimeTokens: 123, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: [] } });
	  if (message.method === 'account/rateLimits/read') return send({ id: message.id, result: { rateLimits: { limitId: 'codex', limitName: 'Codex', primary: null, secondary: null, credits: null, individualLimit: null, planType: 'plus', rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: null } });
	  if (message.method === 'mcpServerStatus/list') return send({ id: message.id, result: { data: [{ name: 'github', serverInfo: null, tools: {}, resources: [], resourceTemplates: [], authStatus: 'notLoggedIn' }], nextCursor: null } });
	  if (message.method === 'skills/list') return send({ id: message.id, result: { data: [{ cwd: process.env.WORK_DIR, skills: [], errors: [] }] } });
	  if (message.method === 'externalAgentConfig/detect') return send({ id: message.id, result: { items: [{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: process.env.WORK_DIR, details: null }] } });
	  if (message.method === 'externalAgentConfig/import') return send({ id: message.id, result: { importId: 'import_fake' } });
	  if (message.method === 'config/value/write') return send({ id: message.id, result: {} });
	  if (message.method === 'config/batchWrite') return send({ id: message.id, result: {} });
	  if (message.method === 'plugin/install') return send({ id: message.id, result: {} });
	  if (message.method === 'plugin/uninstall') return send({ id: message.id, result: {} });
	  if (message.method === 'marketplace/add') return send({ id: message.id, result: {} });
	  if (message.method === 'marketplace/remove') return send({ id: message.id, result: {} });
	  if (message.method === 'marketplace/upgrade') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/writeFile') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/remove') return send({ id: message.id, result: {} });
	  if (message.method === 'fs/copy') return send({ id: message.id, result: {} });
	  if (message.method === 'mcpServer/tool/call') return send({ id: message.id, result: { result: { ok: true } } });
	  if (message.method === 'account/logout') return send({ id: message.id, result: {} });
	  if (message.method === 'experimentalFeature/list') {
	    send({ method: 'thread/realtime/sdp', params: { threadId, sdp: 'v=0' } });
	    send({ method: 'remoteControl/status/changed', params: { status: { type: 'connected' }, serverName: 'local', installationId: 'install_fake', environmentId: 'env_fake' } });
	    return send({ id: message.id, result: { data: [{ name: 'p3-terminal', enabled: true }] } });
	  }
	  if (message.method === 'command/exec') {
	    send({ method: 'command/exec/outputDelta', params: { processId: message.params.processId, stream: 'stdout', deltaBase64: Buffer.from('p3\\n').toString('base64'), capReached: false } });
	    return send({ id: message.id, result: { exitCode: 0 } });
	  }
	  if (message.method === 'command/exec/write') return send({ id: message.id, result: {} });
	  if (message.method === 'command/exec/resize') return send({ id: message.id, result: {} });
	  if (message.method === 'command/exec/terminate') return send({ id: message.id, result: {} });
	  if (message.method === 'thread/read') return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [{ id: turnId, items: [{ id: 'item_fake' }] }] } } });
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
