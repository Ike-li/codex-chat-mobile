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

test('未接管的通知被安全忽略', () => {
  const { session, events } = makeSession();
  for (const m of ['thread/status/changed', 'remoteControl/status/changed']) {
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
  const reasoning = byType(events, 'reasoning')[0].payload;
  assert.equal(reasoning.text, 'thinking…');
  assert.equal(reasoning.channel, 'summary');
  assert.equal(reasoning.kind, 'summary_text_delta');
});

test('reasoning full stream notifications map to reasoning envelopes', () => {
  const { session, events } = makeSession();

  session.handleNotification('item/reasoning/textDelta', {
    threadId: 'thr_reason',
    turnId: 'turn_reason',
    itemId: 'item_reason',
    contentIndex: 0,
    delta: 'full thought',
  });
  session.handleNotification('item/reasoning/summaryPartAdded', {
    threadId: 'thr_reason',
    turnId: 'turn_reason',
    itemId: 'item_reason',
    summaryIndex: 1,
  });

  const [full, part] = byType(events, 'reasoning').map(e => e.payload);
  assert.deepEqual(full, {
    text: 'full thought',
    channel: 'full',
    kind: 'text_delta',
    threadId: 'thr_reason',
    turnId: 'turn_reason',
    itemId: 'item_reason',
    contentIndex: 0,
  });
  assert.deepEqual(part, {
    text: '',
    channel: 'summary',
    kind: 'summary_part_added',
    threadId: 'thr_reason',
    turnId: 'turn_reason',
    itemId: 'item_reason',
    summaryIndex: 1,
  });
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

test('send: busy turn with active currentTurnId steers instead of queueing', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_steer';
  session.ensureReady = async () => {};
  const requests = [];
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn_active', status: 'inProgress' } };
    if (method === 'turn/steer') return { turnId: 'turn_active' };
    return {};
  };

  assert.equal(await session.send('first task'), true);
  assert.equal(await session.send('please adjust course'), true);

  assert.deepEqual(requests.map(r => r.method), ['turn/start', 'turn/steer']);
  assert.deepEqual(requests[1].params, {
    threadId: 'thr_steer',
    input: [{ type: 'text', text: 'please adjust course' }],
    expectedTurnId: 'turn_active',
  });
  assert.equal(session.inputQueue.length, 0);
  assert.equal(byType(events, 'queued_message').length, 0);
  assert.equal(byType(events, 'status').at(-1).payload.reason, 'steer_submitted');
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
  session.enqueueInput('queued after long task');
  await session.abort();

  assert.deepEqual(requests.at(-1), {
    method: 'turn/interrupt',
    params: { threadId: 'thr_abort', turnId: 'turn_abort' }
  });
  assert.equal(session.busy, false);
  assert.equal(session.inputQueue.length, 0);
  assert.equal(byType(events, 'queue_cleared').at(-1).payload.dropped, 1);
});

test('forkThread: sends thread/fork with stable protocol fields', async () => {
  const { session } = makeSession();
  session.sessionId = 'thr_source';
  session.ensureReady = async () => {};
  let forkRequest = null;
  session.request = async (method, params) => {
    if (method === 'thread/fork') {
      forkRequest = params;
      return { thread: { id: 'thr_forked' } };
    }
    return {};
  };

  const response = await session.forkThread({ ephemeral: true });

  assert.deepEqual(forkRequest, {
    threadId: 'thr_source',
    cwd: '/tmp/work',
    approvalPolicy: session.approvalPolicy,
    sandbox: session.sandbox,
    ephemeral: true,
  });
  assert.equal(response.thread.id, 'thr_forked');
});

test('startChatgptDeviceLogin: requests chatgptDeviceCode without starting a thread', async () => {
  const { session, events } = makeSession();
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/login/start') {
      return {
        type: 'chatgptDeviceCode',
        loginId: 'login_1',
        verificationUrl: 'https://openai.com/device',
        userCode: 'ABCD-EFGH',
      };
    }
    return {};
  };
  session.notify = method => calls.push({ method, params: null });

  const response = await session.startChatgptDeviceLogin();

  assert.equal(response.loginId, 'login_1');
  assert.deepEqual(calls.map(c => c.method), ['initialize', 'initialized', 'account/login/start']);
  assert.deepEqual(calls.at(-1).params, { type: 'chatgptDeviceCode' });
  const login = byType(events, 'account_login').at(-1);
  assert.equal(login.payload.status, 'pending');
  assert.equal(login.payload.userCode, 'ABCD-EFGH');
  assert.equal(login.payload.verificationUrl, 'https://openai.com/device');
});

test('account login and update notifications map to frontend envelopes', () => {
  const { session, events } = makeSession();

  session.handleNotification('account/login/completed', {
    loginId: 'login_1',
    success: true,
    error: null,
  });
  session.handleNotification('account/updated', {
    authMode: 'chatgpt',
    planType: 'plus',
  });

  const login = byType(events, 'account_login').at(-1);
  assert.equal(login.payload.status, 'completed');
  assert.equal(login.payload.loginId, 'login_1');
  assert.equal(login.payload.success, true);

  const account = byType(events, 'account_updated').at(-1);
  assert.deepEqual(account.payload, { authMode: 'chatgpt', planType: 'plus' });

  session.handleNotification('account/login/completed', {
    loginId: 'login_2',
    success: false,
    error: 'expired',
  });
  const failed = byType(events, 'account_login').at(-1);
  assert.equal(failed.payload.status, 'failed');
  assert.equal(failed.payload.error, 'expired');
});

test('cancelLogin: sends account/login/cancel and emits canceled state', async () => {
  const { session, events } = makeSession();
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/login/cancel') return { status: 'canceled' };
    return {};
  };
  session.notify = method => calls.push({ method, params: null });

  const response = await session.cancelLogin('login_cancel');

  assert.deepEqual(calls.map(c => c.method), ['initialize', 'initialized', 'account/login/cancel']);
  assert.deepEqual(calls.at(-1).params, { loginId: 'login_cancel' });
  assert.equal(response.status, 'canceled');
  const canceled = byType(events, 'account_login').at(-1);
  assert.equal(canceled.payload.status, 'canceled');
  assert.equal(canceled.payload.loginId, 'login_cancel');
});

test('P1 native controls call stable app-server methods with protocol params', async () => {
  const { session } = makeSession();
  session.sessionId = 'thr_source';
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') return { data: [{ id: 'thr_list', preview: 'hello' }], nextCursor: null };
    if (method === 'thread/rollback') return { thread: { id: 'thr_source', turns: [] } };
    if (method === 'model/list') return { data: [{ id: 'm1', model: 'gpt-5.5', displayName: 'GPT-5.5' }], nextCursor: null };
    if (method === 'modelProvider/capabilities/read') return { namespaceTools: true, imageGeneration: false, webSearch: true };
    if (method === 'fs/readDirectory') return { entries: [] };
    if (method === 'fs/readFile') return { dataBase64: Buffer.from('readme').toString('base64') };
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus' }, requiresOpenaiAuth: false };
    if (method === 'account/usage/read') return { summary: { lifetimeTokens: 10 }, dailyUsageBuckets: [] };
    if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: null, rateLimitResetCredits: null };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'github', authStatus: { type: 'unauthenticated' } }], nextCursor: null };
    if (method === 'skills/list') return { data: [{ cwd: '/tmp/work', skills: [], errors: [] }] };
    if (method === 'externalAgentConfig/detect') return { items: [{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: '/tmp/work', details: null }] };
    if (method === 'externalAgentConfig/import') return { importId: 'import_1' };
    return {};
  };
  session.notify = method => calls.push({ method, params: null });

  await session.listThreads({ archived: true, limit: 25, searchTerm: 'hello' });
  await session.archiveThread('thr_source');
  await session.unarchiveThread('thr_source');
  await session.deleteThread('thr_source');
  await session.renameThread('thr_source', 'Mobile run');
  await session.compactThread();
  await session.rollbackThread({ numTurns: 2 });
  await session.listModels({ includeHidden: true });
  await session.readModelProviderCapabilities();
  await session.readDirectory('/tmp/work');
  await session.readFile('/tmp/work/README.md');
  await session.readAccount();
  await session.readUsage();
  await session.readRateLimits();
  await session.listMcpServerStatus({ limit: 10 });
  await session.listSkills({ forceReload: true });
  await session.detectExternalAgentConfig({ includeHome: false });
  await session.importExternalAgentConfig([{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: '/tmp/work', details: null }]);

  assert.deepEqual(calls.map(c => c.method), [
    'initialize', 'initialized', 'thread/list',
    'thread/archive',
    'thread/unarchive',
    'thread/delete',
    'thread/name/set',
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
  ]);
  assert.deepEqual(calls[2].params, { cwd: '/tmp/work', archived: true, limit: 25, searchTerm: 'hello' });
  assert.deepEqual(calls[5].params, { threadId: 'thr_source' });
  assert.deepEqual(calls[6].params, { threadId: 'thr_source', name: 'Mobile run' });
  assert.deepEqual(calls[7].params, { threadId: 'thr_source' });
  assert.deepEqual(calls[8].params, { threadId: 'thr_source', numTurns: 2 });
  assert.deepEqual(calls[9].params, { includeHidden: true, limit: 100 });
  assert.deepEqual(calls[10].params, {});
  assert.deepEqual(calls[11].params, { path: '/tmp/work' });
  assert.deepEqual(calls[12].params, { path: '/tmp/work/README.md' });
  assert.equal(calls[13].params, undefined);
  assert.equal(calls[14].params, undefined);
  assert.equal(calls[15].params, undefined);
  assert.deepEqual(calls[16].params, { detail: 'Summary', limit: 10, threadId: 'thr_source' });
  assert.deepEqual(calls[17].params, { cwds: ['/tmp/work'], forceReload: true });
  assert.deepEqual(calls[18].params, { includeHome: false, cwds: ['/tmp/work'] });
  assert.deepEqual(calls[19].params, {
    migrationItems: [{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: '/tmp/work', details: null }],
    source: 'mobile',
  });
});

test('P1 notifications map native app-server state to frontend envelopes', () => {
  const { session, events } = makeSession();

  session.handleNotification('thread/archived', { threadId: 'thr_1' });
  session.handleNotification('thread/unarchived', { threadId: 'thr_1' });
  session.handleNotification('thread/deleted', { threadId: 'thr_1' });
  session.handleNotification('thread/name/updated', { threadId: 'thr_1', name: 'New name' });
  session.handleNotification('thread/compacted', { threadId: 'thr_1', turnId: 'turn_1' });
  session.handleNotification('account/rateLimits/updated', { rateLimits: { limitId: 'codex' } });
  session.handleNotification('mcpServer/startupStatus/updated', { threadId: null, name: 'github', status: 'ready', error: null });
  session.handleNotification('skills/changed', { cwd: '/tmp/work' });
  session.handleNotification('externalAgentConfig/import/progress', { importId: 'import_1', itemTypeResults: [] });
  session.handleNotification('externalAgentConfig/import/completed', { importId: 'import_1', itemTypeResults: [] });

  assert.deepEqual(byType(events, 'thread_event').map(e => e.payload.event), ['archived', 'unarchived', 'deleted', 'name_updated']);
  assert.deepEqual(byType(events, 'compact').at(-1).payload, { status: 'compacted', threadId: 'thr_1', turnId: 'turn_1' });
  assert.equal(byType(events, 'rate_limits').at(-1).payload.rateLimits.limitId, 'codex');
  assert.equal(byType(events, 'mcp_status').at(-1).payload.name, 'github');
  assert.equal(byType(events, 'skills_changed').at(-1).payload.cwd, '/tmp/work');
  assert.deepEqual(byType(events, 'external_agent_config_import').map(e => e.payload.status), ['progress', 'completed']);
});

test('P2 admin controls call stable app-server methods with protocol params', async () => {
  const { session } = makeSession();
  session.sessionId = 'thr_admin';
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'mcpServer/tool/call') return { result: { ok: true } };
    return {};
  };
  session.notify = method => calls.push({ method, params: null });

  await session.writeConfigValue({
    keyPath: 'model',
    value: 'gpt-5.5',
    mergeStrategy: 'replace',
    filePath: '/tmp/config.toml',
    expectedVersion: 'v1',
  });
  await session.writeConfigBatch({
    edits: [{ keyPath: 'profiles.mobile.approval_policy', value: 'on-request', mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  });
  await session.installPlugin({ pluginName: 'gh', remoteMarketplaceName: 'official' });
  await session.uninstallPlugin('plugin_gh');
  await session.marketplaceAdd({ source: 'https://example.com/market.git', refName: 'main', sparsePaths: ['plugins'] });
  await session.marketplaceRemove('community');
  await session.marketplaceUpgrade('community');
  await session.writeFile('/tmp/work/admin.txt', Buffer.from('hello').toString('base64'));
  await session.removePath('/tmp/work/admin.txt', { recursive: false, force: true });
  await session.copyPath({ sourcePath: '/tmp/work/a.txt', destinationPath: '/tmp/work/b.txt', recursive: false });
  await session.callMcpTool({ server: 'github', tool: 'search', arguments: { q: 'repo' } });
  await session.logoutAccount();

  assert.deepEqual(calls.map(c => c.method), [
    'initialize', 'initialized',
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
  ]);
  assert.deepEqual(calls[2].params, {
    keyPath: 'model',
    value: 'gpt-5.5',
    mergeStrategy: 'replace',
    filePath: '/tmp/config.toml',
    expectedVersion: 'v1',
  });
  assert.deepEqual(calls[3].params, {
    edits: [{ keyPath: 'profiles.mobile.approval_policy', value: 'on-request', mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  });
  assert.deepEqual(calls[4].params, { pluginName: 'gh', remoteMarketplaceName: 'official' });
  assert.deepEqual(calls[5].params, { pluginId: 'plugin_gh' });
  assert.deepEqual(calls[6].params, { source: 'https://example.com/market.git', refName: 'main', sparsePaths: ['plugins'] });
  assert.deepEqual(calls[7].params, { marketplaceName: 'community' });
  assert.deepEqual(calls[8].params, { marketplaceName: 'community' });
  assert.deepEqual(calls[9].params, { path: '/tmp/work/admin.txt', dataBase64: Buffer.from('hello').toString('base64') });
  assert.deepEqual(calls[10].params, { path: '/tmp/work/admin.txt', recursive: false, force: true });
  assert.deepEqual(calls[11].params, { sourcePath: '/tmp/work/a.txt', destinationPath: '/tmp/work/b.txt', recursive: false });
  assert.deepEqual(calls[12].params, { threadId: 'thr_admin', server: 'github', tool: 'search', arguments: { q: 'repo' } });
  assert.equal(calls[13].params, undefined);
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
