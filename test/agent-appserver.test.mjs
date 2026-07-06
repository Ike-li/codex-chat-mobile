// test/agent-appserver.test.mjs —— CodexAppServerSession 对 app-server JSON-RPC 通知的映射契约。
// 真实通知形状（已探针采样 / 官方 README）：
//   item/agentMessage/delta  {threadId,turnId,itemId,delta}
//   item/started|completed    {item:{type,id,...}, threadId, turnId}
//     agentMessage:     {type:"agentMessage", id, text}
//     commandExecution: {type:"commandExecution", id, command, aggregatedOutput, exitCode, status}
//   turn/completed   {threadId, turn:{id, status:"completed"}}
//   turn/failed      {threadId, turn:{error:{message}}}
//   thread/tokenUsage/updated  {threadId, turnId, tokenUsage:{last:{...}}}
//   turn/diff/updated  {threadId, turnId, diff}
// Items now covered: agentMessage / commandExecution / fileChange / mcpToolCall / webSearch / reasoning
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerSession } from '../agent-appserver.js';

function makeSession(overrides = {}) {
  const events = [];
  const session = new CodexAppServerSession({
    instanceId: 'inst_test',
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

test('item/agentMessage/delta: 流式 → 多条 text_delta', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/agentMessage/delta', { delta: 'P' });
  session.handleNotification('item/agentMessage/delta', { delta: 'ONG' });
  const td = byType(events, 'text_delta');
  assert.equal(td.length, 2);
  assert.equal(td.map(e => e.payload.text).join(''), 'PONG');
});

test('item/completed(agentMessage): 不重复发正文（已由 delta 给出）', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'PONG' } });
  assert.equal(byType(events, 'text_delta').length, 0);
});

test('item/started(commandExecution): → tool_use', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'commandExecution', id: 'c1', command: "ls -a", aggregatedOutput: '', exitCode: null, status: 'in_progress' } });
  const tu = byType(events, 'tool_use')[0];
  assert.ok(tu);
  assert.equal(tu.payload.toolUseId, 'c1');
  assert.match(tu.payload.inputSummary, /ls -a/);
});

test('item/completed(commandExecution): → tool_result', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'a\nb\n', exitCode: 0, status: 'completed' } });
  const tr = byType(events, 'tool_result')[0];
  assert.ok(tr);
  assert.equal(tr.payload.ok, true);
  assert.equal(tr.payload.exitCode, 0);
  assert.equal(tr.payload.status, 'completed');
  assert.match(tr.payload.outputSummary, /a\nb/);
});

test('turn/completed: → result 且 busy 置为 false', () => {
  const { session, events } = makeSession();
  session.busy = true;
  session.handleNotification('turn/completed', { turn: { id: 't1', status: 'completed' } });
  assert.ok(byType(events, 'result')[0]);
  assert.equal(session.busy, false);
});

test('turn/failed: → error', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/failed', { turn: { error: { message: 'boom' } } });
  assert.match(byType(events, 'error')[0].payload.message, /boom/);
});

test('thread/tokenUsage/updated: → usage', () => {
  const { session, events } = makeSession();
  session.handleNotification('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 10 } } });
  assert.deepEqual(byType(events, 'usage')[0].payload.usage, { totalTokens: 10 });
});

test('噪音通知被忽略', () => {
  const { session, events } = makeSession();
  for (const m of ['mcpServer/startupStatus/updated', 'skills/changed', 'account/rateLimits/updated', 'thread/status/changed', 'remoteControl/status/changed']) {
    assert.doesNotThrow(() => session.handleNotification(m, {}));
  }
  assert.equal(events.length, 0);
});

test('handleLine: server→client 审批请求 → approval_request + 记录 pending', () => {
  const { session, events } = makeSession();
  session.handleLine(JSON.stringify({
    method: 'item/commandExecution/requestApproval', id: 7,
    params: { threadId: 't', turnId: 'u', itemId: 'c', command: 'echo hi > f.txt', cwd: '/w', reason: 'retry without sandbox?', availableDecisions: ['accept', 'cancel'] },
  }));
  const ar = byType(events, 'approval_request')[0];
  assert.ok(ar, '应 emit approval_request');
  assert.equal(ar.payload.approvalId, 7);
  assert.match(ar.payload.command, /echo hi/);
  assert.equal(ar.payload.cwd, '/w');
  assert.ok(session.pendingApprovals.has(7));
});

test('respondApproval: 写出 JSON-RPC 响应 {id,result:{decision}} 并清除 pending', () => {
  const { session } = makeSession();
  const writes = [];
  session.child = { stdin: { write: s => writes.push(s) } };
  session.pendingApprovals.add(7);
  assert.equal(session.respondApproval(7, 'accept'), true);
  assert.equal(session.pendingApprovals.has(7), false);
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.id, 7);
  assert.deepEqual(sent.result, { decision: 'accept' });
});

test('respondApproval: 未知 id 返回 false', () => {
  const { session } = makeSession();
  session.child = { stdin: { write: () => {} } };
  assert.equal(session.respondApproval(999, 'accept'), false);
});

test('未知 server 请求被安全兜底回应（不挂起 agent）', () => {
  const { session } = makeSession();
  const writes = [];
  session.child = { stdin: { write: s => writes.push(s) } };
  session.handleLine(JSON.stringify({ method: 'some/unknownRequest', id: 5, params: {} }));
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.id, 5);
  assert.deepEqual(sent.error, {
    code: -32601,
    message: 'Unsupported server request: some/unknownRequest'
  });
});

test('item/completed(fileChange): → file_change（文件列表 + kind + diff）', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/w/a.txt', kind: { type: 'add' }, diff: 'aaa\n' }, { path: '/w/b.txt', kind: { type: 'modify' }, diff: '-x\n+y\n' }] } });
  const fc = byType(events, 'file_change')[0];
  assert.ok(fc, '应 emit file_change');
  assert.equal(fc.payload.files.length, 2);
  assert.equal(fc.payload.files[0].path, '/w/a.txt');
  assert.equal(fc.payload.files[0].kind, 'add');
  assert.equal(fc.payload.files[1].kind, 'modify');
});

test('turn/plan/updated: → plan', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/plan/updated', { plan: [{ step: 'do x', status: 'pending' }, { step: 'do y', status: 'completed' }] });
  const p = byType(events, 'plan')[0];
  assert.ok(p, '应 emit plan');
  assert.equal(p.payload.plan.length, 2);
  assert.equal(p.payload.plan[0].step, 'do x');
});

test('item/reasoning/summaryTextDelta: → reasoning', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/reasoning/summaryTextDelta', { delta: 'thinking…' });
  assert.equal(byType(events, 'reasoning')[0].payload.text, 'thinking…');
});

test('item/started(mcpToolCall): → mcp_use', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'mcpToolCall', id: 'mcp1', serverName: 'github', toolName: 'search_repos', arguments: { q: 'codex' } } });
  const mu = byType(events, 'mcp_use')[0];
  assert.ok(mu, '应 emit mcp_use');
  assert.equal(mu.payload.toolUseId, 'mcp1');
  assert.equal(mu.payload.serverName, 'github');
  assert.equal(mu.payload.toolName, 'search_repos');
  assert.match(mu.payload.inputSummary, /codex/);
});

test('item/completed(mcpToolCall): → mcp_result', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'mcpToolCall', id: 'mcp1', serverName: 'github', toolName: 'search_repos', result: '[{"name":"codex"}]' } });
  const mr = byType(events, 'mcp_result')[0];
  assert.ok(mr, '应 emit mcp_result');
  assert.equal(mr.payload.toolUseId, 'mcp1');
  assert.equal(mr.payload.ok, true);
  assert.match(mr.payload.outputSummary, /codex/);
});

test('item/completed(mcpToolCall with error): → mcp_result ok=false', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'mcpToolCall', id: 'mcp2', serverName: 'github', toolName: 'bad', error: { message: 'timeout' } } });
  const mr = byType(events, 'mcp_result')[0];
  assert.equal(mr.payload.ok, false);
  assert.match(mr.payload.outputSummary, /timeout/);
});

test('item/completed(webSearch): → search', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'webSearch', id: 'ws1', query: 'codex cli', results: [{ title: 'Codex CLI', url: 'https://example.com', snippet: 'The official CLI' }] } });
  const se = byType(events, 'search')[0];
  assert.ok(se, '应 emit search');
  assert.equal(se.payload.query, 'codex cli');
  assert.equal(se.payload.results.length, 1);
  assert.equal(se.payload.results[0].title, 'Codex CLI');
});

test('turn/diff/updated: → diff', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/diff/updated', { diff: '-old\n+new' });
  const df = byType(events, 'diff')[0];
  assert.ok(df, '应 emit diff');
  assert.match(df.payload.diff, /\+new/);
});

test('send: busy turn queues mobile input and drains FIFO after completion', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_test';
  session.ensureReady = async () => {};
  const started = [];
  session.request = async (method, params) => {
    if (method === 'turn/start') started.push(params.input[0].text);
    return {};
  };

  assert.equal(await session.send('first task'), true);
  assert.equal(await session.send('/diff'), true);
  assert.equal(await session.send('second task'), true);

  assert.deepEqual(started, ['first task']);
  assert.deepEqual(byType(events, 'queued_message').map(e => e.payload.text), ['/diff', 'second task']);
  assert.equal(byType(events, 'queued_message').at(-1).payload.queueLength, 2);

  session.handleNotification('turn/completed', { turn: { id: 't1', status: 'completed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['first task', '/diff']);

  session.handleNotification('turn/completed', { turn: { id: 't2', status: 'completed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['first task', '/diff', 'second task']);
});

test('status: exposes busy queue approval and sandbox state', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_status';
  session.ensureReady = async () => {};
  session.request = async () => ({});

  await session.send('run tests');
  await session.send('/status');
  session.handleServerRequest(42, 'item/commandExecution/requestApproval', {
    command: 'npm test',
    cwd: '/tmp/work',
    reason: 'needs execution',
    availableDecisions: ['accept', 'decline'],
  });

  const status = byType(events, 'status').at(-1).payload;
  assert.equal(status.state, 'awaiting_approval');
  assert.equal(status.busy, true);
  assert.equal(status.queueLength, 1);
  assert.equal(status.pendingApprovals, 1);
  assert.equal(status.approvalPolicy, session.approvalPolicy);
  assert.equal(status.sandbox, session.sandbox);
});

test('abort: interrupts active turn and clears queued phone input', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_abort';
  session.ensureReady = async () => {};
  const requests = [];
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn_abort', status: 'inProgress' } };
    return {};
  };
  session.child = { stdin: { write: () => {} } };

  await session.send('long task');
  await session.send('queued after long task');
  await session.abort();

  assert.deepEqual(requests.at(-1), {
    method: 'turn/interrupt',
    params: { threadId: 'thr_abort', turnId: 'turn_abort' }
  });
  assert.equal(session.busy, false);
  assert.equal(session.inputQueue.length, 0);
  assert.equal(byType(events, 'queue_cleared').at(-1).payload.dropped, 1);
});

test('item/commandExecution/outputDelta: streams raw terminal output including ANSI', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', {
    itemId: 'cmd1',
    delta: '\u001b[32mPASS\u001b[0m\n',
    stream: 'stdout',
  });
  const td = byType(events, 'tool_output_delta')[0];
  assert.ok(td);
  assert.equal(td.payload.toolUseId, 'cmd1');
  assert.equal(td.payload.text, '\u001b[32mPASS\u001b[0m\n');
  assert.equal(td.payload.stream, 'stdout');
});

// ---- 边界条件和错误路径 ----

test('handleLine: 忽略无效 JSON', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleLine('not valid json{{{'));
  assert.equal(events.length, 0);
});

test('handleLine: 忽略空行', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleLine(''));
  assert.doesNotThrow(() => session.handleLine('   '));
  assert.equal(events.length, 0);
});

test('item/completed(agentMessage with empty text): 不发 text_delta', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'agentMessage', id: 'm_empty', text: '' } });
  assert.equal(byType(events, 'text_delta').length, 0);
});

test('item/agentMessage/delta with empty delta: 不发 text_delta', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/agentMessage/delta', { delta: '' });
  assert.equal(byType(events, 'text_delta').length, 0);
});

test('item/completed(commandExecution with non-zero exit): ok=false', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', {
    item: { type: 'commandExecution', id: 'c_fail', command: 'false', aggregatedOutput: '', exitCode: 1, status: 'completed' }
  });
  const tr = byType(events, 'tool_result')[0];
  assert.ok(tr);
  assert.equal(tr.payload.ok, false);
  assert.equal(tr.payload.exitCode, 1);
});

test('item/completed(unknown item type): emits raw_item without crashing', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleNotification('item/completed', { item: { type: 'unknownType', id: 'x1' } }));
  const raw = byType(events, 'raw_item').at(-1);
  assert.ok(raw);
  assert.equal(raw.payload.completed, true);
  assert.equal(raw.payload.item.type, 'unknownType');
  assert.equal(raw.payload.item.id, 'x1');
});

test('dispose: 标记 disposed 并清理', () => {
  const { session } = makeSession();
  session.child = { stdin: { write: () => {} }, kill: () => {}, on: () => {} };
  session.idleTimer = setInterval(() => {}, 1000);
  session.dispose();
  assert.equal(session.disposed, true);
  assert.equal(session.child, null);
});

test('buildPromptText: 空文本 + 空附件返回空字符串', () => {
  const { session } = makeSession();
  assert.equal(session.buildPromptText('', []), '');
  assert.equal(session.buildPromptText(null, null), '');
});

test('buildPromptText: 仅文本无附件返回原文', () => {
  const { session } = makeSession();
  assert.equal(session.buildPromptText('hello', null), 'hello');
  assert.equal(session.buildPromptText('hello', []), 'hello');
});

test('send: 空文本返回 false', async () => {
  const { session } = makeSession();
  assert.equal(await session.send(''), false);
  assert.equal(await session.send('   '), false);
  assert.equal(await session.send(null), false);
});

test('send: disposed session returns false', async () => {
  const { session } = makeSession();
  session.disposed = true;
  assert.equal(await session.send('hello'), false);
});

test('handleServerRequest: 非审批请求被安全兜底回应', () => {
  const { session } = makeSession();
  const writes = [];
  session.child = { stdin: { write: s => writes.push(s) } };
  session.handleLine(JSON.stringify({ method: 'thread/unknownMethod', id: 99, params: {} }));
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.id, 99);
  assert.deepEqual(sent.error, {
    code: -32601,
    message: 'Unsupported server request: thread/unknownMethod'
  });
});

// ---- 未覆盖路径补充 ----

test('checkIdle: busy 超时触发中断', () => {
  const { session, events } = makeSession();
  session.busy = true;
  session.lastActivity = Date.now() - 700000; // 超过 10 分钟
  session.idleTimeoutMs = 600000;
  session.child = { stdin: { write: () => {} }, on: () => {}, kill: () => {} };
  session.sessionId = 'idle_test';
  session.checkIdle();
  const err = events.find(e => e.type === 'error');
  assert.ok(err, '应 emit error 事件');
  assert.match(err.payload.message, /静默/);
  assert.equal(session.busy, false);
});

test('checkIdle: 非 busy 状态不触发', () => {
  const { session, events } = makeSession();
  session.busy = false;
  session.lastActivity = Date.now() - 700000;
  session.checkIdle();
  assert.equal(events.length, 0);
});

test('checkIdle: 未超时不触发', () => {
  const { session, events } = makeSession();
  session.busy = true;
  session.lastActivity = Date.now();
  session.idleTimeoutMs = 600000;
  session.checkIdle();
  assert.equal(events.length, 0);
});

test('emit: buffer 超过上限时裁剪', () => {
  const { session } = makeSession();
  // 填充 buffer 到上限
  for (let i = 0; i < 500; i++) {
    session.emit('text_delta', { text: `char ${i}` });
  }
  assert.equal(session.buffer.length, 500);
  assert.equal(session.bufferTrimmed, false);
  // 再发一条，触发裁剪
  session.emit('text_delta', { text: 'overflow' });
  assert.equal(session.buffer.length, 500);
  assert.equal(session.bufferTrimmed, true);
  // 最旧的事件被移除
  assert.equal(session.buffer[0].payload.text, 'char 1');
});

test('eventsSince: 返回指定 seq 之后的事件', () => {
  const { session } = makeSession();
  session.emit('text_delta', { text: 'a' }); // seq 1
  session.emit('text_delta', { text: 'b' }); // seq 2
  session.emit('text_delta', { text: 'c' }); // seq 3
  const result = session.eventsSince(1);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].payload.text, 'b');
  assert.equal(result.events[1].payload.text, 'c');
  assert.equal(result.gap, false);
});

test('eventsSince: buffer 裁剪后正确返回剩余事件', () => {
  const { session } = makeSession();
  // 填充 buffer 到上限触发裁剪
  for (let i = 0; i < 501; i++) {
    session.emit('text_delta', { text: `char ${i}` });
  }
  assert.equal(session.bufferTrimmed, true);
  assert.equal(session.buffer.length, 500);
  // 返回 seq > 500 的事件（只有最后一条）
  const result = session.eventsSince(500);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload.text, 'char 500');
});

test('clearQueue: 清空队列并返回丢弃数量', () => {
  const { session, events } = makeSession();
  session.inputQueue = [{ text: 'a' }, { text: 'b' }];
  const dropped = session.clearQueue('test_clear');
  assert.equal(dropped, 2);
  assert.equal(session.inputQueue.length, 0);
  const qe = events.find(e => e.type === 'queue_cleared');
  assert.ok(qe);
  assert.equal(qe.payload.dropped, 2);
  assert.equal(qe.payload.reason, 'test_clear');
});
