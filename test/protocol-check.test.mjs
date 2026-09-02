import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_METHOD_ALLOWLIST,
  EXPERIMENTAL_METHOD_ALLOWLIST,
  collectBridgeMethodUsage,
  diffMethodSets,
  diffProtocolFiles,
  diffTypeSets,
  findMissingProtocolCoverage,
  formatMissingProtocolCoverage,
  formatProtocolDrift,
  hasProtocolDrift,
  parseProtocolMethods,
  readPinnedCodexVersion,
  readProtocolMethodSets,
  readProtocolTypeSet,
  LEGACY_FIELD_ALLOWLIST,
  parseNotificationParamsTypes,
  readTypeFields,
  readAllNotificationParamsFields,
  collectNotificationFieldUsage,
  findUnknownNotificationFields,
  formatUnknownNotificationFields,
} from '../scripts/protocol-check.mjs';

const root = process.cwd();
const protocolDir = join(root, '.protocol', 'stable');

function currentBridgeUsage() {
  return collectBridgeMethodUsage({
    agentAppserverSource: readFileSync(join(root, 'agent-appserver.js'), 'utf8'),
    approvalBrokerSource: readFileSync(join(root, 'approval-broker.js'), 'utf8'),
  });
}

test('protocol check accepts current bridge methods against the stable export fixture', () => {
  const protocol = readProtocolMethodSets(protocolDir);
  const usage = currentBridgeUsage();

  assert.deepEqual(findMissingProtocolCoverage({ usage, protocol }), []);
});

test('protocol check reports a bridge method missing from the generated protocol export', () => {
  const protocol = readProtocolMethodSets(protocolDir);
  const usage = currentBridgeUsage();
  usage.clientRequests.add('thread/nonexistentForTest');

  const missing = findMissingProtocolCoverage({ usage, protocol });

  assert.deepEqual(missing, [{
    direction: 'clientRequests',
    protocolType: 'ClientRequest',
    method: 'thread/nonexistentForTest',
  }]);
  assert.match(formatMissingProtocolCoverage(missing), /ClientRequest/);
  assert.match(formatMissingProtocolCoverage(missing), /thread\/nonexistentForTest/);
});

test('protocol check exempts probed experimental client requests such as thread/settings/update', () => {
  const protocol = readProtocolMethodSets(protocolDir);
  const usage = {
    serverNotifications: new Set(),
    clientRequests: new Set(['thread/settings/update']),
    clientNotifications: new Set(),
    serverRequests: new Set(),
  };

  assert.equal(EXPERIMENTAL_METHOD_ALLOWLIST.has('thread/settings/update'), true);
  assert.equal(protocol.clientRequests.has('thread/settings/update'), false);
  assert.deepEqual(findMissingProtocolCoverage({ usage, protocol }), []);
});

test('protocol check exempts explicit legacy methods such as turn/failed', () => {
  const protocol = readProtocolMethodSets(protocolDir);
  const usage = {
    serverNotifications: new Set(['turn/failed']),
    clientRequests: new Set(),
    clientNotifications: new Set(),
    serverRequests: new Set(),
  };

  assert.equal(LEGACY_METHOD_ALLOWLIST.has('turn/failed'), true);
  assert.deepEqual(findMissingProtocolCoverage({ usage, protocol }), []);
});

test('collectBridgeMethodUsage reads the handleNotification definition, not an earlier call site', () => {
  // Regression: extractFunctionBody matched `this.handleNotification(` before the real
  // method definition, so `msg.params || {}` was mistaken for the body and zero cases
  // were collected — silently voiding the notification coverage gate.
  const agentAppserverSource = [
    'class Bridge {',
    '  onMessage(msg) {',
    '    this.handleNotification(msg.method, msg.params || {});',
    '  }',
    '  handleNotification(method, params) {',
    '    switch (method) {',
    "      case 'turn/completed': return this.done(params);",
    "      case 'item/started': return this.start(params);",
    '    }',
    '  }',
    '}',
  ].join('\n');

  const usage = collectBridgeMethodUsage({ agentAppserverSource, approvalBrokerSource: '' });

  assert.deepEqual([...usage.serverNotifications].sort(), ['item/started', 'turn/completed']);
});

test('collectBridgeMethodUsage extracts the real handleNotification cases so notification coverage is enforced', () => {
  const usage = currentBridgeUsage();

  assert.ok(
    usage.serverNotifications.size >= 30,
    `notification coverage set should be populated, got ${usage.serverNotifications.size}`,
  );
  for (const method of ['turn/completed', 'item/started', 'item/completed']) {
    assert.ok(usage.serverNotifications.has(method), `missing handled notification ${method}`);
  }
});

test('protocol drift report describes method, type, and generated file changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-drift-'));
  try {
    const baseline = join(dir, 'baseline');
    const current = join(dir, 'current');
    writeProtocolFixture(baseline, {
      ServerNotification: ['turn/completed'],
      ClientRequest: ['turn/start'],
      ServerRequest: ['item/commandExecution/requestApproval'],
      ClientNotification: ['initialized'],
      ExtraOnlyInBaseline: [],
      Changed: ['old/method'],
    });
    writeProtocolFixture(current, {
      ServerNotification: ['turn/completed', 'error'],
      ClientRequest: ['turn/start'],
      ServerRequest: [],
      ClientNotification: ['initialized'],
      ExtraOnlyInCurrent: [],
      Changed: ['new/method'],
    });

    const methodDiff = diffMethodSets(readProtocolMethodSets(baseline), readProtocolMethodSets(current));
    const typeDiff = diffTypeSets(readProtocolTypeSet(baseline), readProtocolTypeSet(current));
    const fileDiff = diffProtocolFiles(baseline, current);
    const report = formatProtocolDrift({ methodDiff, typeDiff, fileDiff });

    assert.equal(hasProtocolDrift({ methodDiff, typeDiff, fileDiff }), true);
    assert.match(report, /ServerNotification methods/);
    assert.match(report, /error/);
    assert.match(report, /item\/commandExecution\/requestApproval/);
    assert.match(report, /Type files/);
    assert.match(report, /ExtraOnlyInCurrent/);
    assert.match(report, /ExtraOnlyInBaseline/);
    assert.match(report, /Generated files/);
    assert.match(report, /Changed\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol helpers parse generated method literals and pinned version files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-pin-'));
  try {
    const pinFile = join(dir, '.codex-version');
    writeFileSync(pinFile, '0.142.5\n');

    assert.equal(readPinnedCodexVersion(pinFile), '0.142.5');
    assert.deepEqual(parseProtocolMethods(`
      export type ServerNotification =
        | { "method": "turn/completed", "params": unknown }
        | { 'method': 'error', 'params': unknown };
    `), new Set(['turn/completed', 'error']));
    assert.equal(formatProtocolDrift({
      methodDiff: {
        ServerNotification: { added: [], removed: [] },
        ClientRequest: { added: [], removed: [] },
        ServerRequest: { added: [], removed: [] },
        ClientNotification: { added: [], removed: [] },
      },
      typeDiff: { added: [], removed: [] },
      fileDiff: { added: [], removed: [], changed: [] },
    }), 'Protocol export drift: OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 这条测的是「PATH 上的 codex 与 pin 一致时,CLI 走完全程并报 OK」,而不是「pin 恰好等于
// 某个版本号」。把版本号写死会让每次协议升级都顺带改这里,改的还是与被测行为无关的字面量
// ——0.142.5 → 0.147.0 那次就是这么红的。让假 codex 直接照着事实源报版本。
test('protocol check CLI succeeds against a pinned fake codex export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-cli-'));
  const pinned = readFileSync(join(root, '.codex-version'), 'utf8').trim();
  try {
    const fakeBin = join(dir, 'bin');
    const fakeCodex = join(fakeBin, 'codex');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      "import { cpSync, rmSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const args = process.argv.slice(2);",
      `if (args[0] === '--version') { console.log('codex-cli ${pinned}'); process.exit(0); }`,
      "if (args[0] === 'app-server' && args[1] === 'generate-ts') {",
      "  const out = args[args.indexOf('--out') + 1];",
      "  rmSync(out, { recursive: true, force: true });",
      "  cpSync(join(process.env.CCM_REPO_ROOT, '.protocol', 'stable'), out, { recursive: true });",
      "  process.exit(0);",
      "}",
      "console.error(`unexpected fake codex args: ${args.join(' ')}`);",
      "process.exit(2);",
    ].join('\n'));
    chmodSync(fakeCodex, 0o755);

    const result = spawnSync(process.execPath, ['scripts/protocol-check.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CCM_REPO_ROOT: root,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`Codex protocol pin: ${pinned.replace(/\./g, '\\.')}`));
    assert.match(result.stdout, /Protocol export drift: OK/);
    assert.match(result.stdout, /Protocol coverage: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeProtocolFixture(dir, methodFiles) {
  mkdirSync(dir, { recursive: true });
  for (const [typeName, methods] of Object.entries(methodFiles)) {
    const body = methods.length
      ? methods.map(method => `| { "method": "${method}", "params": unknown }`).join('\n')
      : '| { "type": "placeholder" }';
    writeFileSync(join(dir, `${typeName}.ts`), `export type ${typeName} =\n${body};\n`);
  }
}

// 字段级漂移。此前 protocol:check 只比对方法名和「上游生成的文件有没有变」，
// 从不校验我们的代码读的 params 字段是否真的存在于协议里。上游把字段改个名，
// 我们读到的是 undefined —— 没有异常、没有失败用例，功能静默失效，而单元测试
// 用的是我们自己写的、同样假设错误的 fixture，两层一起说谎。
test('通知字段用法对得上协议：解析 ServerNotification 的 method → params 类型', () => {
  const source = `
export type ServerNotification = { "method": "turn/started", "params": TurnStartedNotification } | { "method": "process/exited", "params": ProcessExitedNotification };
`;
  const map = parseNotificationParamsTypes(source);
  assert.equal(map.get('turn/started'), 'TurnStartedNotification');
  assert.equal(map.get('process/exited'), 'ProcessExitedNotification');
  assert.equal(map.size, 2);
});

test('通知字段用法对得上协议：读出 params 类型声明的顶层字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-fields-'));
  try {
    writeFileSync(join(dir, 'ThingNotification.ts'),
      'export type ThingNotification = { threadId: string, threadName?: string, };\n');
    const fields = readTypeFields(dir, 'ThingNotification');
    assert.deepEqual([...fields].sort(), ['threadId', 'threadName']);
    assert.equal(readTypeFields(dir, 'MissingNotification'), null, '找不到的类型返回 null 而不是空集合');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('通知字段用法对得上协议：从 handleNotification 抽出每个 method 读的字段', () => {
  const source = `
  handleNotification(method, params) {
    switch (method) {
      case 'turn/started':
        this.emit('x', { id: params.turnId });
        break;
      case 'process/exited':
        this.emit('y', { h: params.processHandle, code: params.exitCode });
        break;
    }
  }
`;
  const usage = collectNotificationFieldUsage(source);
  assert.deepEqual([...usage.get('turn/started')], ['turnId']);
  assert.deepEqual([...usage.get('process/exited')].sort(), ['exitCode', 'processHandle']);
});

test('通知字段用法对得上协议：报告协议里不存在的字段，白名单里的兼容回退除外', () => {
  const usage = new Map([
    ['turn/started', new Set(['turnId', 'bogusField'])],
    ['process/exited', new Set(['processHandle', 'processId'])],
  ]);
  const paramsTypes = new Map([
    ['turn/started', 'TurnStartedNotification'],
    ['process/exited', 'ProcessExitedNotification'],
  ]);
  const declared = new Map([
    ['TurnStartedNotification', new Set(['turnId'])],
    ['ProcessExitedNotification', new Set(['processHandle', 'exitCode'])],
  ]);
  const allowlist = new Map([['process/exited', new Set(['processId'])]]);

  const unknown = findUnknownNotificationFields({ usage, paramsTypes, declared, allowlist });
  assert.deepEqual(unknown, [
    { method: 'turn/started', paramsType: 'TurnStartedNotification', fields: ['bogusField'] },
  ], 'bogusField 要报出来，白名单里的 processId 不报');
  assert.match(formatUnknownNotificationFields(unknown), /bogusField/);
  assert.match(formatUnknownNotificationFields([]), /OK/);
});

test('通知字段用法对得上协议：真实的 agent-appserver.js 对着真实协议没有未知字段', () => {
  const unknown = findUnknownNotificationFields({
    usage: collectNotificationFieldUsage(readFileSync(join(root, 'agent-appserver.js'), 'utf8')),
    paramsTypes: parseNotificationParamsTypes(readFileSync(join(protocolDir, 'ServerNotification.ts'), 'utf8')),
    declared: readAllNotificationParamsFields(protocolDir),
    allowlist: LEGACY_FIELD_ALLOWLIST,
  });
  assert.deepEqual(unknown, [], formatUnknownNotificationFields(unknown));
});
