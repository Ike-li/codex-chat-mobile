import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_METHOD_ALLOWLIST,
  collectBridgeMethodUsage,
  findMissingProtocolCoverage,
  formatMissingProtocolCoverage,
  readProtocolMethodSets,
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
