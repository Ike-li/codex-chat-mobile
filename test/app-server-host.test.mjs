import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppServerHost } from '../app-server-host.js';
import { ThreadRegistry } from '../thread-registry.js';
import { childEnv } from '../app-server-transport.js';

function fakeChild() {
  const child = new EventEmitter();
  const writes = [];
  const killSignals = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(chunk) {
      writes.push(JSON.parse(String(chunk)));
      return true;
    },
  };
  child.kill = signal => {
    killSignals.push(signal);
    return true;
  };
  return { child, writes, killSignals };
}

function runtime(instanceId) {
  const frames = [];
  const exits = [];
  const errors = [];
  return {
    instanceId,
    frames,
    exits,
    errors,
    observeTransportFrame() {},
    handleFrame(frame) { frames.push(frame); },
    handleTransportExit(detail) { exits.push(detail); },
    handleTransportError(error) { errors.push(error); },
  };
}

test('one host initializes its app-server connection only once for multiple runtimes', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);

  const initializedA = host.ensureInitialized(runtimeA);
  const initializedB = host.ensureInitialized(runtimeB);
  assert.equal(fake.writes.filter(frame => frame.method === 'initialize').length, 1);

  const initialize = fake.writes.find(frame => frame.method === 'initialize');
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: initialize.id, result: {} })}\n`));
  await Promise.all([initializedA, initializedB]);

  assert.deepEqual(fake.writes.map(frame => frame.method), ['initialize', 'initialized']);
  host.dispose();
});

test('failed host initialization resets the single-flight so a later call can retry', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-a');
  registry.register(owner, { instanceId: 'inst-a', threadId: 'thr-a' });
  host.attach(owner);

  const first = host.ensureInitialized(owner);
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"error":{"code":-32000,"message":"init failed"}}\n'));
  await assert.rejects(first, /init failed/);

  const second = host.ensureInitialized(owner);
  assert.equal(fake.writes.filter(frame => frame.method === 'initialize').length, 2);
  fake.child.stdout.emit('data', Buffer.from('{"id":2,"result":{}}\n'));
  await second;
  host.dispose();
});

test('shared host routes a notification only to the runtime owning its thread', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeB, { turnId: 'turn-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);
  host.start();

  const notification = {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr-b', turnId: 'turn-b', itemId: 'item-b', delta: 'B' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(notification)}\n`));

  assert.deepEqual(runtimeA.frames, []);
  assert.deepEqual(runtimeB.frames, [notification]);
  host.dispose();
});

test('host binds a turn from its response before routing the next frame in the same stdout chunk', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-a');
  registry.register(owner, { instanceId: 'inst-a', threadId: 'thr-a' });

  const started = host.request(owner, 'turn/start', { threadId: 'thr-a', input: [] });
  const delta = {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr-a', turnId: 'turn-a', itemId: 'item-a', delta: 'R' },
  };
  fake.child.stdout.emit('data', Buffer.from(
    `${JSON.stringify({ id: 1, result: { turn: { id: 'turn-a' } } })}\n${JSON.stringify(delta)}\n`,
  ));
  await started;

  assert.equal(registry.resolve({ threadId: 'thr-a', turnId: 'turn-a' }), owner);
  assert.deepEqual(owner.frames, [delta]);
  host.dispose();
});

test('host correlates account login notifications back to the requesting runtime', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-login');
  registry.register(owner, { instanceId: 'inst-login' });
  host.attach(owner);

  const start = host.request(owner, 'account/login/start', { type: 'chatgptDeviceCode' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"type":"chatgptDeviceCode","loginId":"login-a"}}\n'));
  await start;
  const completed = {
    method: 'account/login/completed',
    params: { loginId: 'login-a', success: true, error: null },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(completed)}\n`));

  assert.deepEqual(owner.frames, [completed]);
  host.dispose();
});

test('host routes account state updates to the runtime that owns the login flow', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-account');
  registry.register(owner, { instanceId: 'inst-account' });

  const start = host.request(owner, 'account/login/start', { type: 'chatgptDeviceCode' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"type":"chatgptDeviceCode","loginId":"login-account"}}\n'));
  await start;
  const updated = {
    method: 'account/updated',
    params: { authMode: 'chatgpt', planType: 'plus' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(updated)}\n`));

  assert.deepEqual(owner.frames, [updated]);
  host.dispose();
});

test('host routes a thread management notification when that thread has no live runtime', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-control');
  registry.register(owner, { instanceId: 'inst-control' });

  const compact = host.request(owner, 'thread/compact/start', { threadId: 'thr-unloaded' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{}}\n'));
  await compact;
  const notification = {
    method: 'thread/compacted',
    params: { threadId: 'thr-unloaded', turnId: 'turn-compact' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(notification)}\n`));

  assert.deepEqual(owner.frames, [notification]);
  host.dispose();
});

test('host routes thread compaction to its loaded thread owner before the turn is bound', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-compact');
  registry.register(owner, { instanceId: 'inst-compact', threadId: 'thr-compact' });
  host.attach(owner);
  host.start();

  const notification = {
    method: 'thread/compacted',
    params: { threadId: 'thr-compact', turnId: 'turn-not-yet-bound' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(notification)}\n`));

  assert.deepEqual(owner.frames, [notification]);
  host.dispose();
});

test('host publishes status for an unloaded thread without routing it to a control runtime', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const statuses = [];
  const unrouted = [];
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
    onThreadStatus: status => statuses.push(status),
    onUnrouted: frame => unrouted.push(frame),
  });
  const control = runtime('inst-control');
  registry.register(control, { instanceId: 'inst-control' });

  const read = host.request(control, 'thread/read', { threadId: 'thr-unloaded' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"thread":{"id":"thr-unloaded"}}}\n'));
  await read;
  const notification = {
    method: 'thread/status/changed',
    params: { threadId: 'thr-unloaded', status: { type: 'active', activeFlags: [] } },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(notification)}\n`));

  assert.deepEqual(control.frames, []);
  assert.deepEqual(statuses, [{
    threadId: 'thr-unloaded',
    status: { type: 'active', activeFlags: [] },
    revision: 1,
  }]);
  assert.deepEqual(unrouted, []);
  assert.deepEqual(registry.snapshot().map(record => ({
    instanceId: record.instanceId,
    threadId: record.threadId,
  })), [{ instanceId: 'inst-control', threadId: null }]);
  host.dispose();
});

test('host thread status revisions stay monotonic across child restarts', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });

  const first = host.publishThreadStatus({
    method: 'thread/status/changed',
    params: { threadId: 'thr-status', status: { type: 'active', activeFlags: [] } },
  });
  const second = host.publishThreadStatus({
    method: 'thread/status/changed',
    params: { threadId: 'thr-status', status: { type: 'idle' } },
  });
  host.handleExit({ code: 1, signal: null });
  const afterRestart = host.publishThreadStatus({
    method: 'thread/status/changed',
    params: { threadId: 'thr-status', status: { type: 'systemError' } },
  });

  assert.deepEqual(
    [first.revision, second.revision, afterRestart.revision],
    [1, 2, 3],
  );
  host.dispose();
});

test('host routes terminal output by processId to the runtime that spawned it', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-terminal');
  registry.register(owner, { instanceId: 'inst-terminal' });

  const command = host.request(owner, 'command/exec', {
    processId: 'process-a',
    command: ['echo', 'private'],
  });
  const output = {
    method: 'command/exec/outputDelta',
    params: { processId: 'process-a', stream: 'stdout', deltaBase64: 'cHJpdmF0ZQ==' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(output)}\n`));
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"exitCode":0}}\n'));
  await command;

  assert.deepEqual(owner.frames, [output]);
  host.dispose();
});

test('host rejects a processId collision until the owning process exits', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-terminal-a');
  const runtimeB = runtime('inst-terminal-b');
  registry.register(runtimeA, { instanceId: runtimeA.instanceId });
  registry.register(runtimeB, { instanceId: runtimeB.instanceId });

  const first = host.request(runtimeA, 'command/exec', {
    processId: 'shared-process',
    command: ['sleep', '1'],
  });
  const firstFrame = fake.writes.at(-1);
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: firstFrame.id, result: {} })}\n`));
  await first;

  await assert.rejects(
    host.request(runtimeB, 'command/exec', {
      processId: 'shared-process',
      command: ['echo', 'wrong-owner'],
    }, { timeoutMs: 10 }),
    /already owned/,
  );
  assert.equal(fake.writes.filter(frame => frame.method === 'command/exec').length, 1);

  const exited = {
    method: 'process/exited',
    params: { processId: 'shared-process', exitCode: 0 },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(exited)}\n`));
  const second = host.request(runtimeB, 'command/exec', {
    processId: 'shared-process',
    command: ['echo', 'new-owner'],
  });
  const secondFrame = fake.writes.at(-1);
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: secondFrame.id, result: {} })}\n`));
  await second;

  assert.equal(fake.writes.filter(frame => frame.method === 'command/exec').length, 2);
  assert.deepEqual(runtimeA.frames, [exited]);
  assert.deepEqual(runtimeB.frames, []);
  host.dispose();
});

test('host routes remote-control status to the runtime requesting experimental capabilities', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-experimental');
  registry.register(owner, { instanceId: 'inst-experimental' });

  const capabilities = host.request(owner, 'experimentalFeature/list', {});
  const status = {
    method: 'remoteControl/status/changed',
    params: { status: { type: 'connected' }, serverName: 'local' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(status)}\n`));
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"data":[]}}\n'));
  await capabilities;

  assert.deepEqual(owner.frames, [status]);
  host.dispose();
});

test('host rejects an unrouted unknown server request instead of leaving app-server hung', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  host.start();

  fake.child.stdout.emit('data', Buffer.from('{"id":77,"method":"unknown/request","params":{}}\n'));

  assert.deepEqual(fake.writes, [{
    id: 77,
    error: { code: -32601, message: 'Unsupported server request: unknown/request' },
  }]);
  host.dispose();
});

test('host rejects a targeted approval request when no runtime owns its identifiers', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  host.start();

  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    id: 88,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'missing-thread', turnId: 'missing-turn', itemId: 'missing-item' },
  })}\n`));

  assert.deepEqual(fake.writes, [{
    id: 88,
    error: {
      code: -32602,
      message: 'No runtime owns server request: item/commandExecution/requestApproval',
    },
  }]);
  host.dispose();
});

test('host routes a legacy approval by its stable conversationId alias', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-legacy-approval');
  registry.register(owner, { instanceId: owner.instanceId, threadId: 'thr-legacy-approval' });
  host.attach(owner);
  host.start();

  const request = {
    id: 88,
    method: 'applyPatchApproval',
    params: {
      conversationId: 'thr-legacy-approval',
      callId: 'patch-call',
      fileChanges: {},
      reason: 'write files',
      grantRoot: null,
    },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(request)}\n`));

  assert.deepEqual(owner.frames, [request]);
  assert.deepEqual(fake.writes, []);
  host.dispose();
});

test('host drops a frame whose thread and turn identifiers belong to different runtimes', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtimeA, { turnId: 'turn-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeB, { turnId: 'turn-b' });

  const request = host.request(runtimeA, 'turn/start', { threadId: 'thr-a', input: [] });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"turn":{"id":"turn-a"}}}\n'));
  await request;
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr-a', turnId: 'turn-b', itemId: 'foreign', delta: 'must drop' },
  })}\n`));

  assert.deepEqual(runtimeA.frames, []);
  assert.deepEqual(runtimeB.frames, []);
  host.dispose();
});

test('detaching one runtime does not terminate the shared process used by another', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);
  host.start();

  assert.equal(host.detach(runtimeA), true);
  assert.deepEqual(fake.killSignals, []);
  const request = host.request(runtimeB, 'thread/read', { threadId: 'thr-b' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"thread":{"id":"thr-b"}}}\n'));
  await request;

  host.dispose();
  assert.deepEqual(fake.killSignals, ['SIGTERM']);
});

test('shared process exit notifies every attached runtime exactly once', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);
  host.start();

  fake.child.emit('close', 7, 'SIGTERM');

  assert.deepEqual(runtimeA.exits, [{ code: 7, signal: 'SIGTERM' }]);
  assert.deepEqual(runtimeB.exits, [{ code: 7, signal: 'SIGTERM' }]);
  assert.deepEqual(runtimeA.errors, []);
  assert.deepEqual(runtimeB.errors, []);
  host.dispose();
});

test('thread status cache does not grow without bound', () => {
  // threadStatuses 只在 transport 退出/出错/dispose 时整体 clear，每个被 app-server
  // 报过状态的 thread 留一条，跑几天单调增长。
  const fake = fakeChild();
  const host = new AppServerHost({ registry: new ThreadRegistry(), spawnImpl: () => fake.child });
  for (let index = 0; index < 2000; index += 1) {
    host.handleMessage({
      method: 'thread/status/changed',
      params: { threadId: `thr_${index}`, status: { type: 'idle' } },
    });
  }
  assert.ok(host.threadStatuses.size <= 512, `状态缓存涨到 ${host.threadStatuses.size} 条`);
  host.dispose();
});

test('thread status cache keeps the most recently seen threads', () => {
  const fake = fakeChild();
  const host = new AppServerHost({ registry: new ThreadRegistry(), spawnImpl: () => fake.child });
  for (let index = 0; index < 600; index += 1) {
    host.handleMessage({
      method: 'thread/status/changed',
      params: { threadId: `thr_${index}`, status: { type: 'idle' } },
    });
    // 让 thr_0 一直保持活跃
    host.handleMessage({
      method: 'thread/status/changed',
      params: { threadId: 'thr_0', status: { type: 'active' } },
    });
  }
  assert.ok(host.latestThreadStatus('thr_0'), '一直在更新的 thread 不该被挤掉');
  host.dispose();
});

// 测试框架的控制变量不属于业务环境：NODE_TEST_CONTEXT 会让子进程里的 node:test 以为自己
// 是测试子进程，NODE_OPTIONS 会把预加载脚本带进去。codex 仍需继承 PATH / CODEX_HOME /
// 上游配置，所以只剔除这几个，不做白名单。
test('spawn 给 codex 的环境剔除测试框架控制变量，保留业务配置', () => {
  const env = childEnv({
    PATH: '/usr/bin',
    CODEX_HOME: '/home/u/.codex',
    OPENAI_BASE_URL: 'https://upstream.example/v1',
    NODE_TEST_CONTEXT: 'child-v8',
    NODE_TEST_WORKER_ID: '1',
    NODE_CHANNEL_FD: '3',
    NODE_OPTIONS: '--import file:///tmp/x.mjs',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    CODEX_HOME: '/home/u/.codex',
    OPENAI_BASE_URL: 'https://upstream.example/v1',
  });
});
