// FloorFeed service worker: wallet-alert push notifications only (no caching).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'FloorFeed', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(p.title || 'FloorFeed', {
    body: p.body || '',
    icon: '/icon-512.png',
    image: p.image || undefined,
    tag: p.tag,
    data: { url: p.url || '/alerts' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/alerts', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.location.origin));
    if (open) { await open.focus(); return open.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
