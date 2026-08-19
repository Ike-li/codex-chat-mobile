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

test('protocol check CLI succeeds against a pinned fake codex export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-cli-'));
  try {
    const fakeBin = join(dir, 'bin');
    const fakeCodex = join(fakeBin, 'codex');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      "import { cpSync, rmSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('codex-cli 0.142.5'); process.exit(0); }",
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
    assert.match(result.stdout, /Codex protocol pin: 0\.142\.5/);
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
