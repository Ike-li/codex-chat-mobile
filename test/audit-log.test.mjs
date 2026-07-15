import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendJsonlAuditRecord } from '../audit-log.js';

test('JSONL audit appends owner-only records and retains only one bounded rotation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-audit-log-'));
  const auditPath = join(root, 'security-audit.jsonl');
  try {
    for (let index = 0; index < 20; index += 1) {
      appendJsonlAuditRecord(auditPath, {
        event: 'auth_failure',
        outcome: 'denied',
        index,
      }, { maxBytes: 240, now: () => index });
    }

    assert.deepEqual(readdirSync(root).sort(), [
      'security-audit.jsonl',
      'security-audit.jsonl.1',
    ]);
    const retained = [auditPath, `${auditPath}.1`].flatMap(path => (
      readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    ));
    assert.ok(retained.length < 20);
    assert.equal(retained.some(record => record.index === 19), true);
    for (const path of [auditPath, `${auditPath}.1`]) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.ok(statSync(path).size <= 240);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
