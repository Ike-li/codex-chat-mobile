import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('mobile shell exposes session state and quick terminal controls', () => {
  assert.match(html, /id="session-meta"/);
  assert.match(html, /id="send-btn"/);
  assert.match(html, /id="interrupt-btn"/);
  assert.match(html, /id="attach-btn"/);
  assert.match(html, /id="model-trigger"/);
  assert.match(html, /id="perm-trigger"/);
});

test('client handles queued input, reconnect catch-up, status, and ANSI output', () => {
  assert.match(html, /case 'status'/);
  assert.match(html, /case 'queued_message'/);
  assert.match(html, /case 'dequeued_message'/);
  assert.match(html, /case 'tool_output_delta'/);
  assert.match(html, /socket\.emit\('catch-up'/);
  assert.match(html, /function renderAnsi/);
  assert.match(html, /function retryLastFailed/);
  assert.match(html, /function copyLatestOutput/);
  assert.match(html, /aria-live="polite"/);
});

test('copy buffer is restored from replayed Codex output events', () => {
  assert.match(html, /let latestOutputText = '';/);
  assert.match(html, /function rememberOutput\(text\)/);
  assert.match(html, /rememberOutput\(streamText\)/);
  assert.match(html, /rememberOutput\(msg\)/);
  assert.match(html, /const text = latestOutputText\.trim\(\)/);
  assert.match(html, /function fallbackCopyText\(text\)/);
  assert.match(html, /fallbackCopyText\(text\)/);
  assert.match(html, /function showCopyFallback\(text\)/);
  assert.match(html, /copy-fallback/);
});

test('mobile keyboard uses visual viewport safe area instead of fixed screen height', () => {
  assert.match(html, /--app-height/);
  assert.match(html, /--keyboard-inset/);
  assert.match(html, /visualViewport/);
  assert.match(html, /function syncVisualViewport\(\)/);
  assert.match(html, /resize', syncVisualViewport/);
  assert.match(html, /scroll', syncVisualViewport/);
});

test('client checks auth requirement before opening the socket', () => {
  assert.match(html, /id="auth-gate"/);
  assert.match(html, /id="auth-token-input"/);
  assert.match(html, /autoConnect: false/);
  assert.match(html, /function bootstrapAuth\(\)/);
  assert.match(html, /fetch\('\/health'/);
  assert.match(html, /connectSocket\(\{ allowEmpty: true \}\)/);
  assert.match(html, /function connectSocket\(/);
  assert.match(html, /bootstrapAuth\(\);/);
  assert.match(html, /authForm\.addEventListener\('submit'/);
  assert.match(html, /socket\.connect\(\)/);
  assert.match(html, /socket\.on\('connect_error'/);
});

test('client renders rich approval, user input, and raw item cards', () => {
  assert.match(html, /case 'user_input_request'/);
  assert.match(html, /case 'raw_item'/);
  assert.match(html, /function renderApprovalDetails/);
  assert.match(html, /function handleUserInputRequest/);
  assert.match(html, /function handleRawItem/);
  assert.match(html, /payload\.changes/);
  assert.match(html, /payload\.permissions/);
  assert.match(html, /JSON\.stringify\(payload\.item/);
});

test('client renders ChatGPT device-code login envelopes', () => {
  assert.match(html, /id="account-login-btn"/);
  assert.match(html, /id="account-login-panel"/);
  assert.match(html, /case 'account_login'/);
  assert.match(html, /case 'account_updated'/);
  assert.match(html, /function startChatgptDeviceLogin/);
  assert.match(html, /function handleAccountLogin/);
  assert.match(html, /function handleAccountUpdated/);
  assert.match(html, /socket\.emit\('account:loginStart'/);
  assert.match(html, /socket\.emit\('account:loginCancel'/);
});

test('client renders summary and full reasoning streams separately', () => {
  assert.match(html, /case 'reasoning'/);
  assert.match(html, /function appendReasoning/);
  assert.match(html, /summary_part_added/);
  assert.match(html, /reasoning-summary/);
  assert.match(html, /reasoning-full/);
  assert.match(html, /payload\.channel/);
});

test('client exposes session fork control', () => {
  assert.match(html, /fork-instance-btn/);
  assert.match(html, /function forkCurrentSession/);
  assert.match(html, /socket\.emit\('session:fork'/);
});

test('client exposes P1 native app-server controls and readonly status panels', () => {
  for (const id of [
    'native-controls',
    'native-thread-refresh',
    'native-compact-btn',
    'native-rollback-btn',
    'native-models-btn',
    'native-files-btn',
    'native-account-btn',
    'native-mcp-btn',
    'native-skills-btn',
    'native-import-btn',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  for (const event of [
    'thread:list',
    'thread:archive',
    'thread:unarchive',
    'thread:delete',
    'thread:rename',
    'thread:compact',
    'thread:rollback',
    'models:read',
    'fs:readDirectory',
    'fs:readFile',
    'account:read',
    'mcp:read',
    'skills:read',
    'externalAgentConfig:detect',
    'externalAgentConfig:import',
  ]) {
    assert.match(html, new RegExp(`socket\\.emit\\('${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(html, /function refreshNativeThreads/);
  assert.match(html, /function renderNativeThreadList/);
  assert.match(html, /function startCompact/);
  assert.match(html, /function rollbackThread/);
  assert.match(html, /function loadNativeModels/);
  assert.match(html, /function openFileBrowser/);
  assert.match(html, /function readNativeFile/);
  assert.match(html, /function loadAccountPanel/);
  assert.match(html, /function loadMcpPanel/);
  assert.match(html, /function loadSkillsPanel/);
  assert.match(html, /function detectExternalAgentConfig/);

  for (const [id, handler] of [
    ['native-thread-refresh', 'refreshNativeThreads'],
    ['native-compact-btn', 'startCompact'],
    ['native-rollback-btn', 'rollbackThread'],
    ['native-models-btn', 'loadNativeModels'],
    ['native-account-btn', 'loadAccountPanel'],
    ['native-mcp-btn', 'loadMcpPanel'],
    ['native-skills-btn', 'loadSkillsPanel'],
    ['native-import-btn', 'detectExternalAgentConfig'],
  ]) {
    assert.match(html, new RegExp(`\\$\\('${id}'\\)\\.onclick = ${handler}`));
  }
  assert.match(html, /\$\('native-files-btn'\)\.onclick = \(\) => openFileBrowser\(serverCwd\)/);
});
