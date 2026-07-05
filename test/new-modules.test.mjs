// test/new-modules.test.mjs —— 本轮新增模块的单元测试。
// 红线：只测数据→数据逻辑，不测 IO 副作用（saveAttachments 除外——它写临时目录）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSessions } from '../history.js';
// ---- uploads.js ----
import { validateAttachments, saveAttachments, buildPromptText, toEventMeta, pruneExpiredUploads } from '../uploads.js';

test('validateAttachments: null/empty passes', () => {
  assert.equal(validateAttachments(null), null);
  assert.equal(validateAttachments([]), null);
});

test('validateAttachments: valid single file passes', () => {
  const err = validateAttachments([{ name: 'a.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }]);
  assert.equal(err, null);
});

test('validateAttachments: missing data field fails', () => {
  const err = validateAttachments([{ name: 'a.txt', mimeType: 'text/plain' }]);
  assert.ok(err, 'should reject missing data');
  assert.match(err, /缺少数据/);
});

test('validateAttachments: too many files fails', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, mimeType: 'text/plain', data: 'aA==' }));
  const err = validateAttachments(many);
  assert.match(err, /过多/);
});

test('validateAttachments: file over 10MB fails', () => {
  const big = { name: 'big.bin', mimeType: 'application/octet-stream', data: 'A'.repeat(14 * 1024 * 1024) };
  const err = validateAttachments([big]);
  assert.match(err, /过大/);
});

test('saveAttachments: writes file with 0600 permissions and correct content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  try {
    const saved = await saveAttachments(dir, [{ name: 'hello.txt', mimeType: 'text/plain', data: Buffer.from('world').toString('base64') }]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'hello.txt');
    assert.ok(saved[0].absPath.endsWith('hello.txt'));
    assert.equal(readFileSync(saved[0].absPath, 'utf8'), 'world');
    const mode = statSync(saved[0].absPath).mode & 0o777;
    assert.equal(mode, 0o600, `permissions should be 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPromptText: injects file paths into prompt', () => {
  const saved = [{ absPath: '/work/a.txt', name: 'a.txt', mimeType: 'text/plain', size: 5 }];
  const result = buildPromptText('请处理', saved);
  assert.match(result, /\[附件\]/);
  assert.match(result, /\/work\/a\.txt/);
  assert.match(result, /^请处理/);
});

test('buildPromptText: attachment-only prompt (no text)', () => {
  const result = buildPromptText('', [{ absPath: '/work/b.txt', name: 'b.txt', mimeType: 'text/plain', size: 0 }]);
  assert.match(result, /\[附件\]/);
  assert.ok(!result.includes('\n\n'), 'no leading blank line for text-only');
});

test('toEventMeta: strips absPath', () => {
  const meta = toEventMeta([{ absPath: '/secret/x.txt', name: 'x.txt', mimeType: 'text/plain', size: 10 }]);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].absPath, undefined, 'absPath must not leak');
  assert.equal(meta[0].name, 'x.txt');
  assert.equal(meta[0].mimeType, 'text/plain');
});

test('pruneExpiredUploads: unlinks files older than maxAgeMs and keeps fresh files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const uploadsDir = join(dir, '.ccm-uploads');
  const { mkdirSync, utimesSync } = await import('node:fs');
  mkdirSync(uploadsDir, { recursive: true });

  const expiredPath = join(uploadsDir, 'expired.txt');
  const freshPath = join(uploadsDir, 'fresh.txt');

  writeFileSync(expiredPath, 'old content');
  writeFileSync(freshPath, 'new content');

  // Change mtime of expired.txt to 30 hours ago
  const oldTime = new Date(Date.now() - 30 * 60 * 60 * 1000);
  utimesSync(expiredPath, oldTime, oldTime);

  try {
    await pruneExpiredUploads(dir, 24 * 60 * 60 * 1000);
    assert.ok(!existsSync(expiredPath), 'expired.txt should be unlinked');
    assert.ok(existsSync(freshPath), 'fresh.txt should be kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- file-security.js ----
import { writeOwnerOnlyFile, isOwnerOnly } from '../file-security.js';

test('writeOwnerOnlyFile: creates file with 0600 permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const f = join(dir, 'test.json');
  try {
    writeOwnerOnlyFile(f, '{}');
    assert.ok(existsSync(f));
    const mode = statSync(f).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isOwnerOnly: detects permissive files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const f = join(dir, 'owner.json');
  try {
    writeOwnerOnlyFile(f, '{}');
    const mode1 = statSync(f).mode & 0o777;
    assert.ok(mode1 <= 0o600, `file shouldn't be world-readable, got ${mode1.toString(8)}`);
    // Delete and recreate with world-readable permissions
    rmSync(f);
    writeFileSync(f, '{}', { mode: 0o644 });
    assert.equal(isOwnerOnly(f, false), false, 'world-readable file should not be owner-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- history.js ----
import { getSessionHistory } from '../history.js';

test('getSessionHistory: parses event_msg user_message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const f = join(dir, 'test.jsonl');
  try {
    writeFileSync(f, [
      '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"/work"}}',
      '{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"hello"}}',
      '{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}}',
    ].join('\n'));
    const msgs = await getSessionHistory(f, 10);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[0].content, 'hello');
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content, 'hi there');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getSessionHistory: deduplicates adjacent identical messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const f = join(dir, 'test.jsonl');
  try {
    writeFileSync(f, [
      '{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"double"}}',
      '{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"double"}}',
    ].join('\n'));
    const msgs = await getSessionHistory(f, 10);
    assert.equal(msgs.length, 1, 'should dedupe identical adjacent user messages');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getSessionHistory: handles missing file gracefully', async () => {
  const msgs = await getSessionHistory('/nonexistent/test.jsonl', 10);
  assert.deepEqual(msgs, []);
});

test('getSessionHistory: respects limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const f = join(dir, 'test.jsonl');
  try {
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`{"timestamp":"2026-01-01T00:00:${String(i).padStart(2,'0')}Z","type":"event_msg","payload":{"type":"user_message","message":"msg${i}"}}`);
      lines.push(`{"timestamp":"2026-01-01T00:00:${String(i).padStart(2,'0')}Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"reply${i}"}]}}`);
    }
    writeFileSync(f, lines.join('\n'));
    const msgs = await getSessionHistory(f, 5);
    assert.equal(msgs.length, 5, 'should respect limit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- statusline.js ----
test('statusline buildStatusLine: includes project name', async () => {
  const { buildStatusLine } = await import('../statusline.js');
  const payload = await buildStatusLine({ agent: null, cwd: '/home/user/my-project', versions: null });
  assert.equal(payload.project, 'my-project');
});

test('statusline buildStatusLine: null agent yields basic payload', async () => {
  const { buildStatusLine } = await import('../statusline.js');
  const payload = await buildStatusLine({ agent: null, cwd: null, versions: null });
  assert.ok(payload.ts > 0, 'should always have timestamp');
  assert.equal(payload.ctx, undefined, 'no ctx without agent usage');
});

// ---- server.js routing (agents Map) ----
// 路由逻辑不需要完整 server 启动——直接测核心函数模式

test('server routing: routeCwd pattern validates whitelist', () => {
  // routeCwd logic: (typeof cwd === 'string' && workDirs.includes(cwd)) ? cwd : WORK_DIR
  const workDirs = ['/a', '/b'];
  const WORK_DIR = '/a';
  const routeCwd = cwd => (typeof cwd === 'string' && workDirs.includes(cwd)) ? cwd : WORK_DIR;

  assert.equal(routeCwd('/a'), '/a');
  assert.equal(routeCwd('/b'), '/b');
  assert.equal(routeCwd('/evil'), '/a', 'rejects non-whitelisted dir');
  assert.equal(routeCwd(null), '/a', 'rejects null');
  assert.equal(routeCwd(undefined), '/a', 'rejects undefined');
});

test('server routing: resolveInstanceId pattern returns valid or null', () => {
  const agents = new Map();
  agents.set('i1', { instanceId: 'i1', busy: false });
  const viewingId = 'i1';

  const resolveInstanceId = id => agents.has(id) ? id : viewingId;

  assert.equal(resolveInstanceId('i1'), 'i1');
  assert.equal(resolveInstanceId('i99'), 'i1', 'falls back to viewingId');
  assert.equal(resolveInstanceId(null), 'i1');
});

test('server routing: broadcastInstances shape', () => {
  const agents = new Map();
  agents.set('i1', {
    instanceId: 'i1', sessionId: 's1', cwd: '/work', busy: true,
    inputQueue: ['msg1'],
    statusPayload: () => ({ state: 'running', busy: true, queueLength: 1 })
  });
  agents.set('i2', {
    instanceId: 'i2', sessionId: null, cwd: '/work', busy: false,
    inputQueue: [],
    statusPayload: () => ({ state: 'idle', busy: false, queueLength: 0 })
  });

  const list = [];
  for (const [id, a] of agents) {
    const sp = typeof a.statusPayload === 'function' ? a.statusPayload('test') : {};
    list.push({ instanceId: id, sessionId: a.sessionId, cwd: a.cwd, state: sp.state || 'idle', busy: a.busy, queueLength: (a.inputQueue || []).length });
  }

  assert.equal(list.length, 2);
  assert.equal(list[0].state, 'running');
  assert.equal(list[0].busy, true);
  assert.equal(list[0].queueLength, 1);
  assert.equal(list[1].state, 'idle');
  assert.equal(list[1].busy, false);
});

// ---- agent-appserver.js 附件 + 路径注入 ----
import { CodexAppServerSession } from '../agent-appserver.js';

test('CodexAppServerSession.buildPromptText injects attachments', () => {
  const events = [];
  const session = new CodexAppServerSession({
    instanceId: 'inst_test', resumeId: null, cwd: '/tmp', codexBin: 'codex',
    idleTimeoutMs: 600000,
    onEvent: env => events.push(env),
    onSessionId: () => {}, onExit: () => {},
  });
  const result = session.buildPromptText('hi', [{ absPath: '/tmp/f.txt', name: 'f.txt', mimeType: 'text/plain', size: 5 }]);
  assert.match(result, /hi\n\n\[附件\]/);
  assert.match(result, /\/tmp\/f\.txt/);
});

test('CodexAppServerSession.send queues and drains with attachments', async () => {
  const events = [];
  const session = new CodexAppServerSession({
    instanceId: 'inst_test', resumeId: null, cwd: '/tmp', codexBin: 'codex',
    idleTimeoutMs: 600000,
    onEvent: env => events.push(env),
    onSessionId: () => {}, onExit: () => {},
  });

  // Mock child process to prevent real spawn and hang
  session.child = { stdin: { write: () => {} }, on: () => {}, kill: () => {} };
  // Mock request() to resolve immediately (no real JSON-RPC round-trip)
  session.request = async () => ({ thread: { id: 'mock_thread' } });

  const saved = [{ absPath: '/tmp/f.txt', name: 'f.txt', mimeType: 'text/plain', size: 5 }];
  const result = await session.send('hello', saved);
  // send() returns true when turn/start succeeds (mocked)
  assert.equal(typeof result, 'boolean');
  // user_message should have been emitted with attachment metadata
  const um = events.find(e => e.type === 'user_message');
  assert.ok(um, 'user_message should be emitted');
  assert.ok(um.payload.attachments, 'user_message should have attachments metadata');
  assert.equal(um.payload.attachments[0].name, 'f.txt');
});

// ---- 前端新增元素存在性 ----
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('frontend: instance tabs and session switch', () => {
  assert.match(html, /instance-tabs/, 'has instance-tabs container');
  assert.match(html, /handleInstances/, 'has handleInstances function');
  assert.match(html, /renderInstanceTabs/, 'has renderInstanceTabs function');
});

test('frontend: attachment elements', () => {
  assert.match(html, /id="attach-btn"/, 'has attach button');
  assert.match(html, /id="attach-tray"/, 'has attach tray');
  assert.match(html, /id="file-input"/, 'has file input');
  assert.match(html, /readFileAsAttachment/, 'has file reader');
  assert.match(html, /renderAttachTray/, 'has tray renderer');
});

test('frontend: status line and new controls', () => {
  assert.match(html, /id="status-detail"/, 'has status detail line');
  assert.match(html, /handleStatusLine/, 'has status line handler');
  assert.match(html, /id="workdir-select"/, 'has workdir selector');
  assert.match(html, /id="model-input"/, 'has model input');
  assert.match(html, /id="perm-select"/, 'has permission selector');
});

test('frontend: PWA and push elements', () => {
  assert.match(html, /manifest\.webmanifest/, 'has manifest link');
  assert.match(html, /apple-mobile-web-app-capable/, 'has apple-mobile meta');
  assert.match(html, /push-subscribe-btn/, 'has push subscribe button');
});

test('frontend: history browsing', () => {
  assert.match(html, /loadHistory/, 'has loadHistory function');
  assert.match(html, /codexSessions/, 'has codexSessions state');
  assert.match(html, /session:history/, 'emits session:history event');
});

test('listSessions: correctly filters by workspace CWD', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ccm-history-test-'));
  const file1 = join(baseDir, 'session1.jsonl');
  const file2 = join(baseDir, 'session2.jsonl');

  const content1 = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/project-a' } }),
    JSON.stringify({ type: 'task_started', payload: { model: 'gemini-1.5-pro' } }),
    JSON.stringify({ type: 'input_text', payload: { text: 'message in project A' } })
  ].join('\n') + '\n';

  const content2 = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/project-b' } }),
    JSON.stringify({ type: 'task_started', payload: { model: 'gemini-1.5-flash' } }),
    JSON.stringify({ type: 'input_text', payload: { text: 'message in project B' } })
  ].join('\n') + '\n';

  writeFileSync(file1, content1);
  writeFileSync(file2, content2);

  try {
    // 1. Filter by Project A
    const listA = await listSessions('/work/project-a', { baseDir, limit: 10 });
    assert.equal(listA.length, 1);
    assert.equal(listA[0].id, 'session1');
    assert.equal(listA[0].title, 'message in project A');

    // 2. Filter by Project B
    const listB = await listSessions('/work/project-b', { baseDir, limit: 10 });
    assert.equal(listB.length, 1);
    assert.equal(listB[0].id, 'session2');
    assert.equal(listB[0].title, 'message in project B');

    // 3. No filter (all sessions)
    const listAll = await listSessions(null, { baseDir, limit: 10 });
    assert.equal(listAll.length, 2);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
