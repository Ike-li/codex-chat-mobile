// test/agent-appserver-branches.test.mjs —— 补齐 CodexAppServerSession 此前未覆盖的
// 错误路径、进程生命周期、JSON-RPC 请求/响应闭环与边界分支。
// 与 agent-appserver.test.mjs(通知映射契约)互补,聚焦「可观察行为」而非镜像实现:
// 失败恢复、resume vs 新建、队列满、进程死亡、附件路径不外泄等。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerSession } from '../agent-appserver.js';

function makeSession(overrides = {}) {
  const events = [];
  const session = new CodexAppServerSession({
    instanceId: 'inst_branch',
    resumeId: null,
    cwd: '/tmp/work',
    codexBin: 'codex',
    idleTimeoutMs: 600000,
    onEvent: env => events.push(env),
    onSessionId: () => {},
    onExit: () => {},
    ...overrides,
  });
  return { session, events };
}
const byType = (events, type) => events.filter(e => e.type === type);
// 注入假子进程,拦截写往 app-server stdin 的 JSON-RPC(外部边界)。
function fakeChild() {
  const writes = [];
  return { writes, child: { stdin: { write: s => writes.push(s) } } };
}

// ---- 构造默认值 ----

test('constructor: 缺省 codexBin/idleTimeout 使用默认值', () => {
  const s = new CodexAppServerSession({ instanceId: 'i', cwd: '/tmp', onEvent() {}, onSessionId() {}, onExit() {} });
  assert.equal(s.codexBin, 'codex');
  assert.equal(s.idleTimeoutMs, 600000);
});

// ---- JSON-RPC 请求/响应闭环 ----

test('request: 写出 {method,id,params} 并在响应到达时 resolve', async () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child; // 使 spawnIfNeeded 短路,不真正 spawn
  const p = session.request('thread/start', { cwd: '/tmp/work' });
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.method, 'thread/start');
  assert.equal(sent.id, 1);
  assert.deepEqual(sent.params, { cwd: '/tmp/work' });
  session.handleLine(JSON.stringify({ id: sent.id, result: { thread: { id: 'thr_1' } } }));
  assert.deepEqual(await p, { thread: { id: 'thr_1' } });
  assert.equal(session.pending.size, 0);
});

test('request: 响应带 error 时 reject', async () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  const p = session.request('turn/start', {});
  const id = JSON.parse(writes[0]).id;
  session.handleLine(JSON.stringify({ id, error: { message: '越权' } }));
  await assert.rejects(p, /越权/);
  assert.equal(session.pending.size, 0);
});

test('handleLine: 未知 id 的响应被安全忽略', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleLine(JSON.stringify({ id: 4242, result: {} })));
  assert.equal(events.length, 0);
});

test('notify: 写出无 id 的通知帧', () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  session.notify('initialized', { x: 1 });
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.method, 'initialized');
  assert.equal(sent.id, undefined);
  assert.deepEqual(sent.params, { x: 1 });
});

test('onStdout: 跨 chunk 分割的一行被正确重组', () => {
  const { session, events } = makeSession();
  session.onStdout(Buffer.from('{"method":"item/agentMessage/del'));
  assert.equal(events.length, 0); // 半行,暂存不处理
  session.onStdout(Buffer.from('ta","params":{"delta":"Hi"}}\n'));
  const td = byType(events, 'text_delta');
  assert.equal(td.length, 1);
  assert.equal(td[0].payload.text, 'Hi');
});

// ---- ensureReady:新建 vs 恢复 thread ----

test('ensureReady: 无 sessionId → thread/start,记录 sessionId 并回调 onSessionId', async () => {
  let sidCb = null;
  const { session } = makeSession({ onSessionId: id => { sidCb = id; } });
  session.child = fakeChild().child;
  const calls = [];
  session.request = async m => { calls.push(m); return m === 'thread/start' ? { thread: { id: 'thr_new' } } : {}; };
  session.notify = () => {};
  await session.ensureReady();
  assert.ok(calls.includes('initialize'));
  assert.ok(calls.includes('thread/start'));
  assert.ok(!calls.includes('thread/resume'));
  assert.equal(session.sessionId, 'thr_new');
  assert.equal(sidCb, 'thr_new');
});

test('ensureReady: 有 sessionId → thread/resume,不新建', async () => {
  const { session } = makeSession({ resumeId: 'thr_existing' });
  session.child = fakeChild().child;
  const calls = [];
  session.request = async m => { calls.push(m); return {}; };
  session.notify = () => {};
  await session.ensureReady();
  assert.ok(calls.includes('thread/resume'));
  assert.ok(!calls.includes('thread/start'));
  assert.equal(session.sessionId, 'thr_existing');
});

test('ensureReady: 只执行一次(缓存 ready promise)', async () => {
  const { session } = makeSession();
  session.child = fakeChild().child;
  let starts = 0;
  session.request = async m => { if (m === 'thread/start') starts++; return { thread: { id: 't' } }; };
  session.notify = () => {};
  await session.ensureReady();
  await session.ensureReady();
  assert.equal(starts, 1);
});

// ---- 输入队列与回合失败 ----

test('enqueueInput: 队列满时拒绝并发系统错误', () => {
  const { session, events } = makeSession();
  session.inputQueueLimit = 2;
  session.inputQueue = [{ text: 'a' }, { text: 'b' }];
  assert.equal(session.enqueueInput('c'), false);
  const sys = byType(events, 'system').at(-1);
  assert.ok(sys.payload.isError);
  assert.match(sys.payload.message, /队列已满/);
});

test('startTurn: turn/start 抛错 → error(recoverable) 且 busy 复位、返回 false', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_x';
  session.child = fakeChild().child;
  session.ensureReady = async () => {};
  session.request = async () => { throw new Error('rpc 挂了'); };
  const r = await session.startTurn('do it');
  assert.equal(r, false);
  assert.equal(session.busy, false);
  const err = byType(events, 'error').at(-1);
  assert.match(err.payload.message, /turn\/start 失败/);
  assert.equal(err.payload.recoverable, true);
});

test('startTurn: 带附件 → 注入路径且 user_message 只含元数据(无 absPath)', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_att';
  session.child = fakeChild().child;
  session.ensureReady = async () => {};
  let sentInput = null;
  session.request = async (m, p) => { if (m === 'turn/start') sentInput = p.input[0].text; return {}; };
  await session.startTurn('读文件', [{ name: 'a.txt', mimeType: 'text/plain', size: 10, absPath: '/w/.ccm-uploads/a.txt' }]);
  assert.match(sentInput, /\/w\/\.ccm-uploads\/a\.txt/); // 路径注入 prompt
  const um = byType(events, 'user_message').at(-1);
  assert.equal(um.payload.text, '读文件');
  assert.deepEqual(um.payload.attachments, [{ name: 'a.txt', mimeType: 'text/plain', size: 10 }]); // 不含 absPath
});

test('scheduleDrain: 重复调用只排一次', async () => {
  const { session } = makeSession();
  let drains = 0;
  session.drainQueue = async () => { drains++; };
  session.scheduleDrain();
  session.scheduleDrain(); // 第二次应被 drainScheduled 短路
  await new Promise(r => setTimeout(r, 10));
  assert.equal(drains, 1);
});

test('scheduleDrain: drainQueue 抛错 → error(queue_error)', async () => {
  const { session, events } = makeSession();
  session.drainQueue = async () => { throw new Error('drain 崩了'); };
  session.scheduleDrain();
  await new Promise(r => setTimeout(r, 10));
  const err = byType(events, 'error').at(-1);
  assert.ok(err, '应 emit error');
  assert.match(err.payload.message, /队列继续执行失败/);
});

// ---- 通知与 item 的边界分支 ----

test('turn/failed: 顶层 error.message 兜底', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/failed', { error: { message: '顶层失败' } });
  assert.match(byType(events, 'error').at(-1).payload.message, /顶层失败/);
});

test('turn/failed: 无任何错误信息 → 默认「任务失败」', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/failed', {});
  assert.match(byType(events, 'error').at(-1).payload.message, /任务失败/);
});

test('handleCommandOutputDelta: 空输出不发事件', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', { itemId: 'c1', delta: '' });
  assert.equal(byType(events, 'tool_output_delta').length, 0);
});

test('handleCommandOutputDelta: text/output 兜底 + stream 默认 stdout', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', { toolUseId: 'c2', text: 'from-text' });
  const td = byType(events, 'tool_output_delta').at(-1);
  assert.equal(td.payload.toolUseId, 'c2');
  assert.equal(td.payload.text, 'from-text');
  assert.equal(td.payload.stream, 'stdout');
});

test('item/completed(fileChange): kind 为字符串或缺失时归一', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'fileChange', id: 'f2', status: 'completed', changes: [
    { path: '/w/s.txt', kind: 'delete', diff: '' }, // 字符串 kind
    { path: '/w/m.txt', diff: '' },                 // 缺失 kind
  ] } });
  const fc = byType(events, 'file_change').at(-1);
  assert.equal(fc.payload.files[0].kind, 'delete');
  assert.equal(fc.payload.files[1].kind, 'modify');
});

test('item/started(mcpToolCall): arguments 为字符串时原样截断', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'mcpToolCall', id: 'm3', serverName: 's', toolName: 't', arguments: 'raw-string-args' } });
  assert.match(byType(events, 'mcp_use').at(-1).payload.inputSummary, /raw-string-args/);
});

// ---- buildPromptText 附件块 ----

test('buildPromptText: 有附件无正文 → 仅附件块', () => {
  const { session } = makeSession();
  const out = session.buildPromptText('', [{ absPath: '/w/a.txt' }]);
  assert.match(out, /\[附件\]/);
  assert.match(out, /\/w\/a\.txt/);
  assert.ok(!out.startsWith('\n'));
});

test('buildPromptText: 有正文有附件 → 正文 + 附件块', () => {
  const { session } = makeSession();
  const out = session.buildPromptText('看这个', [{ absPath: '/w/a.txt' }]);
  assert.match(out, /看这个[\s\S]*\[附件\][\s\S]*\/w\/a\.txt/);
});

// ---- 中断/回应/清理的边界 ----

test('abort: 无子进程时不发 turn/interrupt,但仍复位状态并清队列', () => {
  const { session, events } = makeSession();
  session.child = null;
  session.busy = true;
  session.inputQueue = [{ text: 'q' }];
  session.abort();
  assert.equal(session.busy, false);
  assert.equal(byType(events, 'status').at(-1).payload.reason, 'interrupt_cleared_queue');
});

test('abort: 有进程但无排队输入时状态为 interrupt', () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_a';
  session.notify = () => {};
  session.child = fakeChild().child;
  session.busy = true;
  session.abort();
  assert.equal(byType(events, 'status').at(-1).payload.reason, 'interrupt');
});

test('respond: 无子进程时静默返回(不抛错)', () => {
  const { session } = makeSession();
  session.child = null;
  assert.doesNotThrow(() => session.respond(1, {}));
});

test('respondApproval: 缺省 decision 时回 decline', () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  session.pendingApprovals.add(3);
  assert.equal(session.respondApproval(3), true);
  assert.deepEqual(JSON.parse(writes[0]).result, { decision: 'decline' });
});

test('dispose: reject 所有在途请求且 child.kill 抛错被吞掉', async () => {
  const { session } = makeSession();
  session.child = { stdin: { write() {} }, kill: () => { throw new Error('kill failed'); }, on() {} };
  const p = new Promise((res, rej) => session.pending.set(1, { resolve: res, reject: rej }));
  assert.doesNotThrow(() => session.dispose());
  assert.equal(session.disposed, true);
  assert.equal(session.child, null);
  await assert.rejects(p, /disposed/);
});

// ---- 进程生命周期(真实子进程,确定性触发)----

test('spawnIfNeeded: 启动失败(ENOENT)→ emit error(不可恢复)', async () => {
  const events = [];
  let seen;
  const errored = new Promise(res => { seen = res; });
  const session = new CodexAppServerSession({
    instanceId: 'enoent', cwd: '/tmp', codexBin: '/nonexistent/codex-xxx', idleTimeoutMs: 600000,
    onEvent: e => { events.push(e); if (e.type === 'error') seen(); },
    onSessionId() {}, onExit() {},
  });
  session.spawnIfNeeded();
  await Promise.race([errored, new Promise(r => setTimeout(r, 1500))]);
  const err = events.find(e => e.type === 'error' && /启动失败/.test(e.payload.message));
  assert.ok(err, '应 emit 启动失败 error');
  assert.equal(err.payload.recoverable, false);
  session.dispose();
});

test('spawnIfNeeded: 子进程退出 → busy 复位、child 置空、onExit 触发、清理 idleTimer', async () => {
  let resolveExit;
  const exited = new Promise(res => { resolveExit = res; });
  const { session } = makeSession({ codexBin: 'true', onExit: () => resolveExit() });
  session.busy = true;
  session.spawnIfNeeded();
  await Promise.race([exited, new Promise(r => setTimeout(r, 1500))]);
  assert.equal(session.busy, false);
  assert.equal(session.child, null);
  assert.equal(session.idleTimer, null);
});

// ---- 协议字段缺省时的降级(对上游省略可选字段的鲁棒性)----

test('审批请求缺少可选字段 → command/cwd/reason 为 null,decisions 用默认', () => {
  const { session, events } = makeSession();
  session.handleLine(JSON.stringify({ method: 'item/x/requestApproval', id: 1 })); // 无 params
  const ar = byType(events, 'approval_request')[0];
  assert.equal(ar.payload.command, null);
  assert.equal(ar.payload.cwd, null);
  assert.equal(ar.payload.reason, null);
  assert.deepEqual(ar.payload.availableDecisions, ['accept', 'decline']);
});

test('通知缺少 params → 不崩溃、不误发', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleLine(JSON.stringify({ method: 'item/agentMessage/delta' })));
  assert.equal(byType(events, 'text_delta').length, 0);
});

test('响应 error 无 message → 以 JSON 字符串 reject', async () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  const p = session.request('x', {});
  const id = JSON.parse(writes[0]).id;
  session.handleLine(JSON.stringify({ id, error: { code: -32000 } }));
  await assert.rejects(p, /-32000/);
});

test('tokenUsage 无 .last → 直接用 tokenUsage', () => {
  const { session, events } = makeSession();
  session.handleNotification('thread/tokenUsage/updated', { tokenUsage: { totalTokens: 42 } });
  assert.deepEqual(byType(events, 'usage').at(-1).payload.usage, { totalTokens: 42 });
  assert.deepEqual(session.lastUsage, { totalTokens: 42 });
});

test('plan 缺失 → 空数组', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/plan/updated', { explanation: 'x' });
  assert.deepEqual(byType(events, 'plan').at(-1).payload.plan, []);
});

test('outputDelta: output 字段兜底 + item.id 兜底;全空则早退', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', { item: { id: 'ci' }, output: 'via-output' });
  const td = byType(events, 'tool_output_delta').at(-1);
  assert.equal(td.payload.text, 'via-output');
  assert.equal(td.payload.toolUseId, 'ci');
  const before = events.length;
  session.handleNotification('item/commandExecution/outputDelta', {}); // 无 delta/text/output
  assert.equal(events.length, before);
});

test('outputDelta: 无任何 id → toolUseId 为 null', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', { text: 'x' });
  assert.equal(byType(events, 'tool_output_delta').at(-1).payload.toolUseId, null);
});

test('handleItem: item 无 type → 忽略', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleNotification('item/started', { item: { id: 'x' } }));
  assert.equal(events.length, 0);
});

test('commandExecution: 缺 command/status → 空命令 + 默认 completed', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'commandExecution', id: 'c' } });
  assert.equal(byType(events, 'tool_use').at(-1).payload.inputSummary, '');
  session.handleNotification('item/completed', { item: { type: 'commandExecution', id: 'c', exitCode: 0 } });
  assert.equal(byType(events, 'tool_result').at(-1).payload.status, 'completed');
});

test('commandExecution: 超长输出被截断', () => {
  const { session, events } = makeSession();
  const big = 'x'.repeat(700);
  session.handleNotification('item/completed', { item: { type: 'commandExecution', id: 'c', exitCode: 0, aggregatedOutput: big } });
  const sum = byType(events, 'tool_result').at(-1).payload.outputSummary;
  assert.ok(sum.length < big.length);
  assert.match(sum, /已截断/);
});

test('fileChange: 缺 changes → 空文件列表', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'fileChange', id: 'f', status: 'completed' } });
  assert.deepEqual(byType(events, 'file_change').at(-1).payload.files, []);
});

test('mcpToolCall: 缺 server/tool/arguments → unknown + {}', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'mcpToolCall', id: 'm' } });
  const mu = byType(events, 'mcp_use').at(-1);
  assert.equal(mu.payload.serverName, 'unknown');
  assert.equal(mu.payload.toolName, 'unknown');
  assert.equal(mu.payload.inputSummary, '{}');
});

test('mcp_result: 无 error 无 result → 空摘要;非字符串 result → 空', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'mcpToolCall', id: 'm1' } });
  assert.equal(byType(events, 'mcp_result').at(-1).payload.outputSummary, '');
  session.handleNotification('item/completed', { item: { type: 'mcpToolCall', id: 'm2', result: 12345 } });
  assert.equal(byType(events, 'mcp_result').at(-1).payload.outputSummary, '');
});

test('webSearch: 缺 results → 空;结果缺 snippet → 空串', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'webSearch', id: 'w', query: 'q', results: [{ title: 't', url: 'u' }] } });
  assert.equal(byType(events, 'search').at(-1).payload.results[0].snippet, '');
  session.handleNotification('item/completed', { item: { type: 'webSearch', id: 'w2', query: 'q2' } });
  assert.deepEqual(byType(events, 'search').at(-1).payload.results, []);
});

test('startTurn: 抛非 Error 值 → String(err) 兜底', async () => {
  const { session, events } = makeSession();
  session.sessionId = 't';
  session.child = fakeChild().child;
  session.ensureReady = async () => {};
  session.request = async () => { throw 'plain-string-error'; };
  assert.equal(await session.startTurn('x'), false);
  assert.match(byType(events, 'error').at(-1).payload.message, /plain-string-error/);
});

test('scheduleDrain: 抛非 Error 值 → String(err) 兜底', async () => {
  const { session, events } = makeSession();
  session.drainQueue = async () => { throw 'drain-plain'; };
  session.scheduleDrain();
  await new Promise(r => setTimeout(r, 10));
  assert.match(byType(events, 'error').at(-1).payload.message, /drain-plain/);
});

test('abort: notify 抛错被吞掉,状态仍复位', () => {
  const { session } = makeSession();
  session.sessionId = 't';
  session.busy = true;
  session.child = fakeChild().child;
  session.notify = () => { throw new Error('write fail'); };
  assert.doesNotThrow(() => session.abort());
  assert.equal(session.busy, false);
});

test('ensureReady: thread/start 返回 threadId(无 thread.id)也能记录', async () => {
  const { session } = makeSession();
  session.child = fakeChild().child;
  session.request = async m => (m === 'thread/start' ? { threadId: 'thr_alt' } : {});
  session.notify = () => {};
  await session.ensureReady();
  assert.equal(session.sessionId, 'thr_alt');
});

test('ensureReady: thread/start 无 id → sessionId 保持 null,不回调', async () => {
  let cb = 0;
  const { session } = makeSession({ onSessionId: () => { cb++; } });
  session.child = fakeChild().child;
  session.request = async () => ({});
  session.notify = () => {};
  await session.ensureReady();
  assert.equal(session.sessionId, null);
  assert.equal(cb, 0);
});

test('eventsSince: 空 buffer 不崩溃', () => {
  const { session } = makeSession();
  const r = session.eventsSince(0);
  assert.deepEqual(r.events, []);
  assert.equal(r.gap, false);
});

test('emitStatus: disposed 后不再发状态', () => {
  const { session, events } = makeSession();
  session.disposed = true;
  session.emitStatus('x');
  assert.equal(byType(events, 'status').length, 0);
});

test('numberFromEnv: 合法环境变量覆盖默认队列上限;非法值回退默认', () => {
  const prev = process.env.CODEX_INPUT_QUEUE_LIMIT;
  try {
    process.env.CODEX_INPUT_QUEUE_LIMIT = '5';
    assert.equal(makeSession().session.inputQueueLimit, 5);
    process.env.CODEX_INPUT_QUEUE_LIMIT = '0'; // 0 不合法
    assert.equal(makeSession().session.inputQueueLimit, 20);
  } finally {
    if (prev === undefined) delete process.env.CODEX_INPUT_QUEUE_LIMIT;
    else process.env.CODEX_INPUT_QUEUE_LIMIT = prev;
  }
});

test('LOG_STDERR: 开启时 ensureReady 记录日志(不影响会话结果)', async () => {
  const prev = process.env.LOG_STDERR;
  const origErr = console.error;
  process.env.LOG_STDERR = '1';
  console.error = () => {}; // 静音日志输出
  try {
    const s1 = makeSession({ resumeId: 'thr_r' }).session; // resume 路径
    s1.child = fakeChild().child;
    s1.request = async () => ({}); s1.notify = () => {};
    await s1.ensureReady();
    const s2 = makeSession().session; // start 路径
    s2.child = fakeChild().child;
    s2.request = async m => (m === 'thread/start' ? { thread: { id: 't' } } : {}); s2.notify = () => {};
    await s2.ensureReady();
    assert.equal(s1.sessionId, 'thr_r');
    assert.equal(s2.sessionId, 't');
  } finally {
    console.error = origErr;
    if (prev === undefined) delete process.env.LOG_STDERR;
    else process.env.LOG_STDERR = prev;
  }
});
