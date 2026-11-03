const VERSION = '2026-11-04-1';
const BASE = new URL('./', self.location.href);
const PREFIX = `hari-app:${BASE.pathname}:`;
const CACHE = `${PREFIX}${VERSION}`;
const SHELL = ['./', './index.html', './style.css', './core.mjs', './audio.mjs', './app.mjs', './wake.mjs', './credits.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './audio/manifest.json'];
const absolute = path => new URL(path, BASE).href;
async function expectedAssets() {
  const cache = await caches.open(CACHE);
  const response = await cache.match(absolute('./audio/manifest.json'));
  if (!response) return null;
  const manifest = await response.json();
  return [...SHELL, ...manifest.harmonium.map(sample => `./${sample.file}`), `./${manifest.tanpura.file}`].map(absolute);
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(absolute('./audio/manifest.json'), { cache: 'reload' });
    if (!response.ok) throw new Error('Sound manifest unavailable');
    const manifest = await response.json();
    const assets = [...SHELL, ...manifest.harmonium.map(sample => `./${sample.file}`), `./${manifest.tanpura.file}`];
    const cache = await caches.open(CACHE);
    await cache.addAll(assets.map(path => new Request(absolute(path), { cache: 'reload' })));
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') { self.skipWaiting(); return; }
  if (event.data?.type === 'OFFLINE_STATUS') event.waitUntil((async () => {
    let ready = false;
    try {
      const assets = await expectedAssets(); const cache = await caches.open(CACHE);
      ready = assets !== null && (await Promise.all(assets.map(asset => cache.match(asset)))).every(Boolean);
    } catch { ready = false; }
    event.ports[0]?.postMessage({ ready, version: VERSION });
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const lookup = event.request.mode === 'navigate' ? new Request(url.origin + url.pathname) : event.request;
    return await cache.match(lookup) || fetch(event.request);
  })());
});
