// Minimal service worker — only exists so browsers treat this site as an
// installable app (add to home screen / install as desktop app). It does
// NOT cache anything, so installed users always get the live site and
// Firebase's realtime connections are never intercepted.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
