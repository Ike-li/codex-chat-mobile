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
      }, { maxBytes: 240, maxGenerations: 1, now: () => index });
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

// 原设计只留一代（base + .1），约 2 MiB。D6 把文件读写纳入审计、R-SEC-2 还要扩到消息、
// 附件与策略变更之后，这个窗口太短——而审计里最有价值的恰恰是旧记录，入侵往往事后才发现。
// 仍然保持有界：自托管服务不能让日志无限长。
test('审计日志按代数滚动，丢最旧的一代而不是每次都清空上一代', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-audit-gen-'));
  const auditPath = join(root, 'security-audit.jsonl');
  try {
    for (let index = 0; index < 40; index += 1) {
      appendJsonlAuditRecord(auditPath, { event: 'fs_denied', index }, {
        maxBytes: 120,
        maxGenerations: 3,
        now: () => index,
      });
    }

    assert.deepEqual(readdirSync(root).sort(), [
      'security-audit.jsonl',
      'security-audit.jsonl.1',
      'security-audit.jsonl.2',
      'security-audit.jsonl.3',
    ], '保留 maxGenerations 代，不多不少');

    const byGeneration = ['', '.1', '.2', '.3'].map(suffix => (
      readFileSync(`${auditPath}${suffix}`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    ));
    // 代号越大越旧：.3 里的记录必须早于 .1，否则滚动方向反了。
    const newestOf = records => Math.max(...records.map(record => record.index));
    assert.ok(newestOf(byGeneration[0]) > newestOf(byGeneration[1]));
    assert.ok(newestOf(byGeneration[1]) > newestOf(byGeneration[2]));
    assert.ok(newestOf(byGeneration[2]) > newestOf(byGeneration[3]));
    assert.equal(newestOf(byGeneration[0]), 39, '最新一条必须在活动文件里');

    for (const suffix of ['', '.1', '.2', '.3']) {
      assert.equal(statSync(`${auditPath}${suffix}`).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
