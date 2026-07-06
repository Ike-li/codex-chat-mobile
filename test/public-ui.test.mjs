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
