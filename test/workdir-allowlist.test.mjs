import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkdirAllowlist } from '../workdir-allowlist.js';

test('WORK_DIRS can load a JSON array of workspace paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-workdirs-'));
  try {
    const alpha = join(root, 'alpha');
    const beta = join(root, 'beta');
    mkdirSync(alpha);
    mkdirSync(beta);
    writeFileSync(join(root, 'workdirs.json'), JSON.stringify([alpha, beta, alpha]));
    const primaryPath = join(root, 'primary');
    mkdirSync(primaryPath);
    const primary = realpathSync(primaryPath);
    const resolved = resolveWorkdirAllowlist({
      workDir: primary,
      extra: 'workdirs.json',
      baseDir: root,
    });
    assert.deepEqual(resolved.workDirs, [primary, realpathSync(alpha), realpathSync(beta)]);
    assert.equal(resolved.warnings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('comma-separated WORK_DIRS still adds extra directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-workdirs-csv-'));
  try {
    const primaryPath = join(root, 'primary');
    const extra = join(root, 'extra');
    mkdirSync(primaryPath);
    mkdirSync(extra);
    const resolved = resolveWorkdirAllowlist({
      workDir: primaryPath,
      extra,
      baseDir: root,
    });
    assert.deepEqual(resolved.workDirs, [realpathSync(primaryPath), realpathSync(extra)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
