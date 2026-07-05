// sw.js — Service Worker for Web Push notifications only.
// No caching, no offline support.
self.addEventListener('push', e => {
  const data = e.data?.json() ?? {};
  const title = data.title || 'Codex';
  const body  = data.body  || '';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon:     '/icons/icon.svg',
    badge:    '/icons/icon.svg',
    tag:      'ccm-push',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const w = list.find(c => new URL(c.url).origin === self.location.origin);
      return w ? w.focus() : clients.openWindow('/');
    })
  );
});
