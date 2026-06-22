const CACHE = 'giogio-v1';
const SHELL = ['/shenron', '/manifest.json'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;                 // POST(act 系) は触らない
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // 同一オリジンのみ（CDN/Tailwind は素通し）
  if (/^\/(api|mcp|oauth|\.well-known)\//.test(url.pathname)) return; // network-only
  // app shell: cache-first, fallback network → 取れたら更新
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
      return res;
    }).catch(() => caches.match('/shenron')))
  );
});
