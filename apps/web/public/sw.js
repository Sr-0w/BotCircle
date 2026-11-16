/* #64: BotCircle Web Push. Shows what the server sends (a short title and line), never runs anything. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const samePlace = (clientUrl, url) => {
  try { const a = new URL(clientUrl), b = new URL(url, self.location.origin); return a.hash.replace(/\?.*$/, '') === b.hash.replace(/\?.*$/, ''); } catch { return false; }
};

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'BotCircle', body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    if (data.close) {
      for (const n of await self.registration.getNotifications({ tag: data.tag })) n.close();
      return;
    }
    // Already looking at it in a focused tab: the page shows it; no system notification (approvals still show).
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (data.category !== 'approvals' && windows.some((c) => c.focused && samePlace(c.url, data.url || '/'))) return;
    await self.registration.showNotification(data.title || 'BotCircle', {
      body: data.body || '', tag: data.tag, icon: '/favicon.svg', badge: '/favicon.svg',
      data: { url: data.url || '/', id: data.id }, requireInteraction: data.category === 'approvals',
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) { await open.focus(); open.postMessage({ type: 'od:navigate', url }); return; }
    await self.clients.openWindow(url);
  })());
});
