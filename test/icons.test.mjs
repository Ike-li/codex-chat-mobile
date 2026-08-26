import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icon, ICONS } from '../public/js/icons.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const cliSettings = readFileSync(new URL('../public/js/cli-settings.js', import.meta.url), 'utf8');

test('icons.js exports stroke SVG markup with the shared chrome convention', () => {
  assert.ok(existsSync(new URL('../public/js/icons.js', import.meta.url)));
  const sample = icon('shield');
  assert.match(sample, /<svg\b/);
  assert.match(sample, /viewBox="0 0 24 24"/);
  assert.match(sample, /stroke="currentColor"/);
  assert.match(sample, /stroke-width="2\.2"/);
  assert.match(sample, /fill="none"/);
  assert.match(sample, /aria-hidden="true"/);
  assert.match(sample, /class="[^"]*\bui-icon\b/);
  assert.equal(icon('not-a-real-icon'), '');
});

test('P0/P1 surfaces resolve through icon names instead of emoji', () => {
  for (const name of [
    'compass', 'chart', 'clipboard', 'search', 'notepad', 'broom', 'shield',
    'chat', 'tools', 'warning', 'hammer', 'pencil', 'refresh', 'hand', 'eye',
    'skull', 'star', 'bot', 'zap', 'circle', 'plus',
  ]) {
    assert.ok(ICONS[name], `missing icon "${name}"`);
    assert.match(icon(name), /<svg\b/);
  }

  // 静态壳用 data-icon 占位,由 hydrateIcons 注入 SVG,避免 HTML/JS 两套 path 漂移。
  assert.match(appJs, /hydrateIcons\(\)/);
  assert.match(
    readFileSync(new URL('../public/js/icons.js', import.meta.url), 'utf8'),
    /\[data-icon\]/,
  );
  for (const name of ['compass', 'chart', 'clipboard', 'search', 'notepad', 'broom', 'shield', 'chat', 'tools', 'warning', 'hammer', 'pencil', 'plus', 'hourglass']) {
    assert.match(html, new RegExp(`data-icon="${name}"`));
  }

  // slash / empty / mode / tools 标题不再内嵌 emoji 字符。
  assert.doesNotMatch(html, /class="slash-icon">[^<]*[\u{1F300}-\u{1FAFF}]/u);
  assert.doesNotMatch(html, /class="suggestion-icon">[^<]*[\u{1F300}-\u{1FAFF}⚒✎]/u);
  assert.doesNotMatch(html, /drawer-section-label">[^<]*🛠/);
  assert.doesNotMatch(html, /fab-icon">[^<]*📝/);
});

test('settings option icons are names consumed by renderPopoverItems', () => {
  assert.match(cliSettings, /iconName:\s*'shield'/);
  assert.match(cliSettings, /iconName:\s*'refresh'/);
  assert.match(cliSettings, /iconName:\s*'hand'/);
  assert.match(cliSettings, /iconName:\s*'warning'/);
  assert.match(cliSettings, /iconName:\s*'eye'/);
  assert.match(cliSettings, /iconName:\s*'notepad'/);
  assert.match(cliSettings, /iconName:\s*'skull'/);
  assert.doesNotMatch(cliSettings, /icon:\s*'🛡️'/);
  assert.doesNotMatch(cliSettings, /icon:\s*'⚠️'/);

  assert.match(appJs, /function renderPopoverItems/);
  assert.match(appJs, /if \(item\.iconName\) return icon\(item\.iconName\)/);
  assert.match(appJs, /iconName:\s*model\.isDefault\s*\?\s*'star'\s*:\s*'bot'/);
  assert.match(appJs, /icon\('skull'\)/);
});
