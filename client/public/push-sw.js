/*
 * WEB PUSH, IN THE SERVICE WORKER — imported by the generated worker
 * (vite.config.ts `workbox.importScripts`).
 *
 * Every push is SHOWN (iOS revokes a subscription whose pushes are not), with
 * the server's short title and body. A press focuses an open KAS window and
 * takes it to the work, or opens one there. Only a path on THIS origin is ever
 * opened — anything else falls back to the app's home.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_err) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'KAS';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      lang: 'vi',
      data: { url: data.url || '/app' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = new URL('/app', self.location.origin);
  try {
    const wanted = new URL((event.notification.data && event.notification.data.url) || '/app', self.location.origin);
    if (wanted.origin === self.location.origin) target = wanted;
  } catch (_err) {
    // keep the home page
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.focus();
          if ('navigate' in client) await client.navigate(target.href);
          return;
        } catch (_err) {
          // A window this worker does not control cannot be navigated: open one.
          break;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
