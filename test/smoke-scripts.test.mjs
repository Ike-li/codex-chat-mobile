import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('real approval decline smoke script is present and checks non-execution', () => {
  const url = new URL('../scripts/smoke-approval-decline.js', import.meta.url);
  assert.equal(existsSync(url), true);
  const script = readFileSync(url, 'utf8');
  assert.match(script, /decision:\s*'decline'/);
  assert.match(script, /file_absent/);
  assert.match(script, /!toolOk && fileAbsent/);
});
