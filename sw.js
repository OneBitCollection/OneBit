// One Bit — service worker
// Código do app: busca a versão nova na rede primeiro (para as atualizações chegarem logo)
// e usa a cópia guardada quando estiver sem internet.
// Imagens e fontes: usa a cópia guardada primeiro (mais rápido e economiza dados).
const VERSION = 'onebit-v4';
const APP = VERSION + '-app';
const IMG = 'onebit-img';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'base/catalog.js', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== APP && k !== IMG).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isImage = url =>
  /\/covers\//.test(url.pathname) ||
  url.hostname.endsWith('steamstatic.com') ||
  url.hostname === 'fonts.gstatic.com' ||
  url.hostname === 'fonts.googleapis.com';

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isImage(url)) {
    e.respondWith(
      caches.open(IMG).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) caches.open(APP).then(c => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
  );
});
