// 인터넷이 약하거나 없어도 앱 화면이 바로 열리도록 앱 파일을 저장해 둠 (일정 데이터는 앱이 따로 저장)
const CACHE = 'couple-cal-v4-event-time';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './calendar-tools.js', './bridge-ui.js', './bridge.gs.txt'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('couple-cal-') && k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return; // Firebase 요청은 건드리지 않음
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; });
    if (req.mode === 'navigate') {
      // 3초 안에 새 화면이 안 오면 저장해 둔 화면을 먼저 보여줌
      const fast = await Promise.race([net.catch(() => null), new Promise(res => setTimeout(() => res(null), 3000))]);
      if (fast && fast.ok) return fast;
      const cached = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || (await cache.match('./'));
      return cached || fast || net;
    }
    try { return await net; }
    catch { return (await cache.match(req, { ignoreSearch: true })) || Response.error(); }
  })());
});
