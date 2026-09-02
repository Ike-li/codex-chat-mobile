import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppServerTransport } from '../app-server-transport.js';

function fakeChild() {
  const child = new EventEmitter();
  const writes = [];
  const killSignals = [];

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
  };
  child.kill = signal => {
    killSignals.push(signal);
    return true;
  };

  return { child, writes, killSignals };
}

function harness(overrides = {}) {
  const spawned = [];
  const messages = [];
  const exits = [];
  const errors = [];
  const children = [];
  const spawnImpl = (...args) => {
    const fake = fakeChild();
    children.push(fake);
    spawned.push(args);
    return fake.child;
  };
  const transport = new AppServerTransport({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    spawnImpl,
    onMessage: message => messages.push(message),
    onExit: detail => exits.push(detail),
    onError: error => errors.push(error),
    ...overrides,
  });
  return { transport, spawned, messages, exits, errors, children };
}

function jsonWrites(fake) {
  return fake.writes.map(line => JSON.parse(line));
}

// 请求超时定时器在生产代码里是 unref 的（app-server-transport.js 的 request）。
// 服务器进程始终有 HTTP listener 吊着事件循环，所以线上无影响；但在测试里
// 事件循环会在这个定时器触发前排空，node --test 判定「promise 仍挂起而事件
// 循环已结束」，把本测试连同其后所有测试标记为 cancelled —— 退出码是 1，
// 但计数显示 `fail 0`，很容易被当成通过。用一个 ref 住的定时器撑住这段等待。
async function withLiveEventLoop(fn) {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

test('start spawns one stdio app-server child and is idempotent while it is alive', () => {
  const { transport, spawned, children } = harness();

  transport.start();
  transport.start();

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][0], '/fake/codex');
  assert.deepEqual(spawned[0][1], ['app-server']);
  assert.equal(spawned[0][2].cwd, '/workspace');
  assert.deepEqual(spawned[0][2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(children.length, 1);
});

test('stdout JSONL is reconstructed across chunks and forwards non-response frames', () => {
  const { transport, messages, errors, children } = harness();
  transport.start();
  const [{ child }] = children;

  child.stdout.emit('data', Buffer.from('{"method":"turn/sta'));
  child.stdout.emit('data', Buffer.from('rted","params":{"threadId":"thr_1"}}\n{"method":"item/started",'));
  child.stdout.emit('data', Buffer.from('"params":{"threadId":"thr_1"}}\n'));

  assert.deepEqual(messages, [
    { method: 'turn/started', params: { threadId: 'thr_1' } },
    { method: 'item/started', params: { threadId: 'thr_1' } },
  ]);
  assert.equal(errors.length, 0);
});

test('stdout activity is reported even before a complete JSONL frame arrives', () => {
  let activityCount = 0;
  const { transport, messages, children } = harness({
    onActivity: () => { activityCount += 1; },
  });
  transport.start();
  const [{ child }] = children;

  child.stdout.emit('data', Buffer.from('{"method":"partial'));

  assert.equal(activityCount, 1);
  assert.deepEqual(messages, []);
});

test('stdout reconstruction preserves UTF-8 characters split across buffer chunks', () => {
  const { transport, messages, children } = harness();
  transport.start();
  const [{ child }] = children;
  const frame = Buffer.from(`${JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { delta: '🙂' },
  })}\n`);
  const emojiStart = frame.indexOf(Buffer.from('🙂'));

  child.stdout.emit('data', frame.subarray(0, emojiStart + 1));
  child.stdout.emit('data', frame.subarray(emojiStart + 1));

  assert.deepEqual(messages, [{
    method: 'item/agentMessage/delta',
    params: { delta: '🙂' },
  }]);
});

test('stderr is drained and forwarded without entering the JSONL parser', () => {
  const stderr = [];
  const { transport, messages, errors, children } = harness({
    onStderr: chunk => stderr.push(String(chunk)),
  });
  transport.start();
  const [{ child }] = children;

  child.stderr.emit('data', Buffer.from('diagnostic only\n'));

  assert.deepEqual(stderr, ['diagnostic only\n']);
  assert.deepEqual(messages, []);
  assert.deepEqual(errors, []);
});

test('request assigns ids and resolves or rejects from JSON-RPC responses', async () => {
  const { transport, children } = harness();
  transport.start();
  const [fake] = children;

  const success = transport.request('thread/list', { limit: 10 });
  const first = jsonWrites(fake)[0];
  assert.deepEqual(first, { method: 'thread/list', id: 1, params: { limit: 10 } });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"data":[]}}\n'));
  assert.deepEqual(await success, { data: [] });

  const failure = transport.request('turn/start', { threadId: 'thr_1' });
  const second = jsonWrites(fake)[1];
  assert.equal(second.id, 2);
  fake.child.stdout.emit('data', Buffer.from('{"id":2,"error":{"code":-32000,"message":"boom","data":{"retry":false}}}\n'));
  await assert.rejects(failure, error => {
    assert.match(error.message, /boom/);
    assert.equal(error.code, -32000);
    assert.deepEqual(error.data, { retry: false });
    return true;
  });
});

test('frame observer sees correlated outbound requests and inbound responses', async () => {
  const frames = [];
  const { transport, children } = harness({
    onFrame: event => frames.push(event),
  });
  transport.start();
  const [fake] = children;

  const pending = transport.request('thread/list', { limit: 5 });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"data":[]}}\n'));
  await pending;

  assert.deepEqual(frames, [
    {
      direction: 'outbound',
      method: 'thread/list',
      frame: { method: 'thread/list', id: 1, params: { limit: 5 } },
    },
    {
      direction: 'inbound',
      method: 'thread/list',
      frame: { id: 1, result: { data: [] } },
    },
  ]);
});

test('request context is returned only to frame observers and never written on the wire', async () => {
  const frames = [];
  const context = { owner: 'runtime-a' };
  const { transport, children } = harness({
    onFrame: event => frames.push(event),
  });
  transport.start();
  const [fake] = children;

  const pending = transport.request('thread/read', { threadId: 'thr-a' }, { context });
  assert.deepEqual(jsonWrites(fake)[0], {
    method: 'thread/read',
    id: 1,
    params: { threadId: 'thr-a' },
  });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"thread":{"id":"thr-a"}}}\n'));
  await pending;

  assert.equal(frames[0].context, context);
  assert.equal(frames[1].context, context);
});

test('notify and response helpers write the expected JSON-RPC frames', () => {
  const { transport, children } = harness();
  transport.start();
  const [fake] = children;

  transport.notify('initialized', {});
  transport.respond('approval-1', { decision: 'accept' });
  transport.respondError(9, -32601, 'unsupported');
  transport.send({ method: 'custom/event', params: { ok: true } });

  assert.deepEqual(jsonWrites(fake), [
    { method: 'initialized', params: {} },
    { id: 'approval-1', result: { decision: 'accept' } },
    { id: 9, error: { code: -32601, message: 'unsupported' } },
    { method: 'custom/event', params: { ok: true } },
  ]);
});

test('request timeout rejects and a malformed line reports an error without stopping parsing', async () => {
  const { transport, messages, errors, children } = harness();
  transport.start();
  const [fake] = children;

  const pending = transport.request('thread/read', { threadId: 'thr_1' }, { timeoutMs: 10 });
  await withLiveEventLoop(() => assert.rejects(pending, /thread\/read timed out after 10ms/));

  fake.child.stdout.emit('data', Buffer.from('not-json\n{"method":"thread/started","params":{"threadId":"thr_2"}}\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Invalid JSON from codex app-server/);
  assert.deepEqual(messages, [
    { method: 'thread/started', params: { threadId: 'thr_2' } },
  ]);
});

test('child exit rejects every pending request, reports exit, and allows an explicit restart', async () => {
  const { transport, spawned, exits, children } = harness();
  transport.start();
  const firstChild = children[0].child;
  const one = transport.request('thread/read', { threadId: 'one' });
  const two = transport.request('thread/read', { threadId: 'two' });

  firstChild.emit('close', 7, 'SIGTERM');

  await assert.rejects(one, /exited.*code 7.*SIGTERM/i);
  await assert.rejects(two, /exited.*code 7.*SIGTERM/i);
  assert.deepEqual(exits, [{ code: 7, signal: 'SIGTERM' }]);

  transport.start();
  assert.equal(spawned.length, 2);
});

test('child error rejects pending work and is reported through onError', async () => {
  const { transport, errors, children } = harness();
  transport.start();
  const [fake] = children;
  const pending = transport.request('thread/list', {});
  const failure = new Error('spawn failed');

  fake.child.emit('error', failure);

  await assert.rejects(pending, /spawn failed/);
  assert.equal(errors[0], failure);
});

test('dispose is idempotent, terminates the child, and rejects pending requests', async () => {
  const { transport, exits, children } = harness();
  assert.throws(() => transport.send({ method: 'before/start' }), /not started/);
  transport.start();
  const [fake] = children;
  const pending = transport.request('turn/start', {});

  transport.dispose();
  transport.dispose();

  await assert.rejects(pending, /disposed/);
  assert.deepEqual(fake.killSignals, ['SIGTERM']);
  assert.throws(() => transport.start(), /disposed/);
  assert.throws(() => transport.send({ method: 'after/dispose' }), /disposed/);

  fake.child.emit('close', 0, null);
  assert.deepEqual(exits, []);
});
