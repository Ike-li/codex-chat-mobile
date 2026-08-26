import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const appJs = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const workspaceJs = readFileSync(new URL('../public/js/workspace-panel.js', import.meta.url), 'utf8');

test('tool cards and workspace rows use SVG icon() prefixes instead of emoji', () => {
  assert.match(appJs, /tool-name">\$\{icon\('warning'\)\}/);
  assert.match(appJs, /tool-name">\$\{icon\('question'\)\}/);
  assert.match(appJs, /tool-name">\$\{icon\('receipt'\)\}/);
  assert.match(appJs, /tool-name">\$\{icon\('clipboard'\)\}/);
  assert.match(appJs, /tool-name">\$\{icon\('tools'\)\}/);
  assert.match(appJs, /tool-name">\$\{icon\('search'\)\}/);
  assert.match(appJs, /tool-name">\$\{icon\('chart'\)\}/);
  assert.doesNotMatch(appJs, /tool-name">⚠️/);
  assert.doesNotMatch(appJs, /tool-name">📋/);
  assert.doesNotMatch(appJs, /tool-name">🔧/);

  assert.match(workspaceJs, /icon\('folder'\)|icon\("folder"\)/);
  assert.match(workspaceJs, /icon\('file'\)|icon\("file"\)/);
  assert.doesNotMatch(workspaceJs, /📁|📄/);

  assert.match(appJs, /icon\(expanded \? 'folderOpen' : 'folder'\)/);
  assert.doesNotMatch(appJs, /project-icon">\$\{expanded \? '📂'/);
});

test('outbox delivery labels are plain text without emoji prefixes', () => {
  assert.doesNotMatch(appJs, /offline-label[^>]*>⚠️/);
  assert.doesNotMatch(appJs, /'⚠️ 原会话目标/);
  assert.doesNotMatch(appJs, /'⏳ 弱网等待同步/);
  assert.match(appJs, /原会话目标已失效，正在按请求 ID 核对；不会自动重发/);
  assert.match(appJs, /弱网等待同步 \(Offline Queue\)/);
});
