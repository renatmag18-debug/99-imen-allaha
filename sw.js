// Minimal service worker — exists so browsers treat this site as an
// installable app (add to home screen / install as desktop app), and so
// push notifications can be delivered/shown while the app is closed.
// It does NOT cache anything, so installed users always get the live site
// and Firebase's realtime connections are never intercepted.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDk_VEd7etsz22k3M41kSObWYhv9SfeGkw",
  authDomain: "ism-friends.firebaseapp.com",
  databaseURL: "https://ism-friends-default-rtdb.firebaseio.com",
  projectId: "ism-friends",
  storageBucket: "ism-friends.firebasestorage.app",
  messagingSenderId: "174262670691",
  appId: "1:174262670691:web:63a740ffd5436c19c2ef56"
});

const messaging = firebase.messaging();
// Push payloads are data-only (no top-level "notification" field) — that's
// deliberate. When a "notification" field is present, some browsers show it
// automatically AND this handler fires too, producing two notifications for
// one push. With data-only, showNotification() below is the only place a
// notification gets created.
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  self.registration.showNotification(d.title || '99 имён Аллаха', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    tag: d.tag || 'ism-notify',
    data: { link: d.link || './' }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(link);
    })
  );
});
