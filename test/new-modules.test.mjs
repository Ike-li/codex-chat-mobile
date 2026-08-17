// test/new-modules.test.mjs —— 本轮新增模块的单元测试。
// 红线：只测数据→数据逻辑，不测 IO 副作用（saveAttachments 除外——它写临时目录）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// ---- uploads.js ----
import { validateAttachments, saveAttachments, toEventMeta, pruneExpiredUploads } from '../uploads.js';

test('validateAttachments: null/empty passes', () => {
  assert.equal(validateAttachments(undefined), null);
  assert.equal(validateAttachments(null), null);
  assert.equal(validateAttachments([]), null);
});

test('validateAttachments rejects every supplied non-array value', () => {
  for (const value of ['base64', { data: 'aA==' }, 1, true]) {
    assert.equal(validateAttachments(value), '附件必须是数组');
  }
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

test('validateAttachments rejects malformed base64 instead of decoding it leniently', () => {
  const err = validateAttachments([{
    name: 'bad.txt',
    mimeType: 'text/plain',
    data: 'aGVsbG8=%%%%',
  }]);

  assert.equal(err, '附件「bad.txt」数据不是合法 base64');
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
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, '.ccm-uploads')).mode & 0o777, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAttachments repairs an existing permissive upload directory to 0700', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-existing-upload-mode-'));
  const uploadDir = join(dir, '.ccm-uploads');
  try {
    mkdirSync(uploadDir, { mode: 0o755 });
    chmodSync(uploadDir, 0o755);
    await saveAttachments(dir, [{
      name: 'mode.txt',
      mimeType: 'text/plain',
      data: Buffer.from('mode').toString('base64'),
    }]);
    if (process.platform !== 'win32') {
      assert.equal(statSync(uploadDir).mode & 0o777, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAttachments does not trust a claimed image MIME type without image bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-fake-image-test-'));
  try {
    const [saved] = await saveAttachments(dir, [{
      name: 'fake.png',
      mimeType: 'image/png',
      data: Buffer.from('not actually an image').toString('base64'),
    }]);

    assert.equal(saved.kind, 'file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAttachments marks structurally valid PNG bytes as a verified image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-real-image-test-'));
  try {
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const [saved] = await saveAttachments(dir, [{
      name: 'pixel.png',
      mimeType: 'application/octet-stream',
      data: onePixelPng,
    }]);

    assert.equal(saved.kind, 'image');
    assert.equal(saved.detectedMimeType, 'image/png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const resolveInstanceId = id => agents.has(id) ? id : null;

  assert.equal(resolveInstanceId('i1'), 'i1');
  assert.equal(resolveInstanceId('i99'), null, 'unknown ids fail closed');
  assert.equal(resolveInstanceId(null), null);
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

// ---- agent-appserver.js 结构化附件 ----
import { CodexAppServerSession } from '../agent-appserver.js';

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
const appJs = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const allContent = html + '\n' + appJs;

test('frontend: instance routing stays in memory without a main-chrome tab strip', () => {
  assert.match(allContent, /handleInstances/, 'has handleInstances function');
  assert.doesNotMatch(html, /id="instance-tabs"/, 'instance tabs are not in main chrome');
  assert.match(html, /id="new-session-btn"/, 'new session lives in the drawer');
});

test('frontend: attachment elements', () => {
  assert.match(allContent, /id="attach-btn"/, 'has attach button');
  assert.match(allContent, /id="attach-tray"/, 'has attach tray');
  assert.match(allContent, /id="file-input"/, 'has file input');
  assert.match(allContent, /readFileAsAttachment/, 'has file reader');
  assert.match(allContent, /renderAttachTray/, 'has tray renderer');
});

test('frontend: status line and new controls', () => {
  assert.match(allContent, /id="status-detail"/, 'has status detail line');
  assert.match(allContent, /handleStatusLine/, 'has status line handler');
  assert.match(allContent, /id="workdir-select"/, 'has workdir selector');
  assert.match(allContent, /id="model-input"/, 'has model input');
  assert.match(allContent, /id="perm-select"/, 'has permission selector');
});

test('frontend: PWA and push elements', () => {
  assert.match(allContent, /manifest\.webmanifest/, 'has manifest link');
  assert.match(allContent, /apple-mobile-web-app-capable/, 'has apple-mobile meta');
  assert.match(allContent, /push-subscribe-btn/, 'has push subscribe button');
});

test('frontend: history browsing uses only app-server thread/read', () => {
  assert.match(allContent, /loadNativeThreadHistory/, 'has native thread history loader');
  assert.match(allContent, /thread:history/, 'emits thread:history event');
  assert.match(allContent, /renderHistoryMessages/, 'renders normalized thread history');
  assert.doesNotMatch(allContent, /function loadHistory/, 'legacy JSONL loader is removed');
  assert.doesNotMatch(allContent, /codexSessions/, 'legacy JSONL session state is removed');
  assert.doesNotMatch(allContent, /session:history/, 'legacy JSONL event is not used');
});
