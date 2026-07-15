import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('service worker preserves a needs-you tag and opens its deep link', async () => {
  const source = readFileSync(new URL('../public/js/sw.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const notifications = [];
  const opened = [];
  const context = {
    URL,
    self: {
      location: { origin: 'https://codex.example' },
      registration: {
        showNotification: async (title, options) => notifications.push({ title, options }),
      },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
    clients: {
      matchAll: async () => [],
      openWindow: async url => opened.push(url),
    },
  };
  vm.runInNewContext(source, context);

  let pushWork;
  listeners.get('push')({
    data: {
      json: () => ({
        title: 'Codex 待审批',
        body: '有操作等待审批',
        tag: 'need:need_abc',
        data: { url: '/?thread=thr_1&need=need_abc', needId: 'need_abc' },
      }),
    },
    waitUntil: promise => { pushWork = promise; },
  });
  await pushWork;
  assert.equal(notifications[0].options.tag, 'need:need_abc');
  assert.deepEqual(notifications[0].options.data, {
    url: '/?thread=thr_1&need=need_abc',
    needId: 'need_abc',
  });

  let clickWork;
  listeners.get('notificationclick')({
    notification: {
      data: notifications[0].options.data,
      close() {},
    },
    waitUntil: promise => { clickWork = promise; },
  });
  await clickWork;
  assert.deepEqual(opened, ['/?thread=thr_1&need=need_abc']);
});
