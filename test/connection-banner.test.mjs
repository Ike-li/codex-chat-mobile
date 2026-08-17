import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONN_BANNER_CONNECTING_DELAY_MS,
  CONN_BANNER_DISCONNECT_DELAY_MS,
  CONN_BANNER_RETRY_DELAY_MS,
  CONN_BANNER_RECONNECTED_LINGER_MS,
  resolveConnectionBanner,
} from '../public/js/connection-banner.js';

test('first connect stays quiet until the delay, then shows connecting', () => {
  assert.equal(resolveConnectionBanner({
    phase: 'connecting',
    elapsedMs: CONN_BANNER_CONNECTING_DELAY_MS - 1,
  }), null);

  const shown = resolveConnectionBanner({
    phase: 'connecting',
    elapsedMs: CONN_BANNER_CONNECTING_DELAY_MS,
  });
  assert.equal(shown.tone, 'info');
  assert.equal(shown.label, '连接中…');
  assert.equal(shown.spinner, true);
  assert.equal(shown.retry, false);
});

test('retry appears only after the later retry delay', () => {
  const beforeRetry = resolveConnectionBanner({
    phase: 'offline',
    elapsedMs: CONN_BANNER_RETRY_DELAY_MS - 1,
  });
  assert.equal(beforeRetry.retry, false);

  const afterRetry = resolveConnectionBanner({
    phase: 'offline',
    elapsedMs: CONN_BANNER_RETRY_DELAY_MS,
  });
  assert.equal(afterRetry.tone, 'warn');
  assert.equal(afterRetry.label, '连接断开，自动重连中…');
  assert.equal(afterRetry.retry, true);
  assert.match(afterRetry.detail, /已断开/);
});

test('a brief reconnect after a visible banner lingers, then hides', () => {
  assert.equal(resolveConnectionBanner({
    phase: 'online',
    elapsedMs: 0,
    wasVisible: false,
  }), null);

  const linger = resolveConnectionBanner({
    phase: 'online',
    elapsedMs: 0,
    wasVisible: true,
  });
  assert.equal(linger.tone, 'success');
  assert.equal(linger.label, '已重新连接');
  assert.equal(linger.spinner, false);

  assert.equal(resolveConnectionBanner({
    phase: 'online',
    elapsedMs: CONN_BANNER_RECONNECTED_LINGER_MS,
    wasVisible: true,
  }), null);
});

test('auth overlay and invalid clocks hide the banner', () => {
  assert.equal(resolveConnectionBanner({
    phase: 'offline',
    elapsedMs: CONN_BANNER_DISCONNECT_DELAY_MS + 10,
    suppressed: true,
  }), null);
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: NaN }), null);
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: -1 }), null);
});
