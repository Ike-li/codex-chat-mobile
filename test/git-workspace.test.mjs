import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePorcelainZ,
  classifyGitEntries,
  assertSafeRelPath,
  listGitChanges,
  readGitDiff,
} from '../git-workspace.js';

test('parsePorcelainZ understands ordinary and rename records', () => {
  const entries = parsePorcelainZ(' M src/a.js\0R  new.js\0old.js\0?? scratch.txt\0');
  assert.deepEqual(entries, [
    { xy: ' M', path: 'src/a.js' },
    { xy: 'R ', path: 'new.js', oldPath: 'old.js' },
    { xy: '??', path: 'scratch.txt' },
  ]);
});

test('classifyGitEntries splits staged, unstaged, untracked and conflicted', () => {
  const groups = classifyGitEntries([
    { xy: 'M ', path: 'staged.js' },
    { xy: ' M', path: 'dirty.js' },
    { xy: 'MM', path: 'both.js' },
    { xy: '??', path: 'new.txt' },
    { xy: 'UU', path: 'conflict.js' },
  ]);
  assert.deepEqual(groups.staged.map(item => item.path), ['staged.js', 'both.js']);
  assert.deepEqual(groups.unstaged.map(item => item.path), ['dirty.js', 'both.js']);
  assert.deepEqual(groups.untracked.map(item => item.path), ['new.txt']);
  assert.deepEqual(groups.conflicted.map(item => item.path), ['conflict.js']);
});

test('assertSafeRelPath rejects absolute, parent, and magic pathspecs', () => {
  assert.equal(assertSafeRelPath('/tmp/work', 'src/a.js'), '/tmp/work/src/a.js');
  assert.equal(assertSafeRelPath('/tmp/work', '../secret'), null);
  assert.equal(assertSafeRelPath('/tmp/work', '/etc/passwd'), null);
  assert.equal(assertSafeRelPath('/tmp/work', 'src/*'), null);
});

test('listGitChanges and readGitDiff use injected git and stay scoped', async () => {
  const calls = [];
  const execFile = (cmd, args, _opts, cb) => {
    calls.push(args.slice(2));
    const key = args.slice(2).join(' ');
    if (key === 'symbolic-ref --short HEAD') return cb(null, 'main\n', '');
    if (key === 'status --porcelain=v1 -z') return cb(null, ' M src/a.js\0', '');
    if (key === 'diff -- src/a.js') return cb(null, '-old\n+new\n', '');
    return cb(new Error(`unexpected ${key}`));
  };

  const status = await listGitChanges('/tmp/work', { execFile });
  assert.equal(status.ok, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.unstaged[0].path, 'src/a.js');

  const diff = await readGitDiff('/tmp/work', 'src/a.js', 'unstaged', { execFile });
  assert.equal(diff.ok, true);
  assert.match(diff.patch, /\+new/);

  const escaped = await readGitDiff('/tmp/work', '../secret', 'unstaged', { execFile });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.code, 'bad_path');
});
