import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFiles, searchFiles } from '../file-search.js';

test('empty query returns a dictionary-ordered browse list', () => {
  assert.deepEqual(
    matchFiles(['b.js', 'a.js', 'src/c.js'], '', { limit: 2 }),
    ['a.js', 'b.js'],
  );
});

test('basename hits rank ahead of path and subsequence matches', () => {
  assert.deepEqual(
    matchFiles(['src/tool.js', 'notes/app.md', 'app.js', 'lib/apple.js'], 'app'),
    ['app.js', 'lib/apple.js', 'notes/app.md'],
  );
});

test('searchFiles stays inside the supplied cwd and ignores query path traversal', async () => {
  const hits = await searchFiles('/tmp/work', '../etc/passwd', {
    listCandidates: async cwd => {
      assert.equal(cwd, '/tmp/work');
      return ['src/app.js', 'README.md'];
    },
  });
  assert.deepEqual(hits, []);
});

test('searchFiles returns relative hits from the candidate list', async () => {
  const hits = await searchFiles('/tmp/work', 'app', {
    listCandidates: async () => ['src/app.js', 'README.md'],
  });
  assert.deepEqual(hits, ['src/app.js']);
});
