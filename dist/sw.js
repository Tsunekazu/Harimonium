const VERSION = '2026-11-04-2';
const BASE = new URL('./', self.location.href);
const PREFIX = `hari-app:${BASE.pathname}:`;
const CACHE = `${PREFIX}${VERSION}`;
const SHELL = ['./', './index.html', './style.css', './core.mjs', './audio.mjs', './app.mjs', './wake.mjs', './credits.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './audio/manifest.json'];
const absolute = path => new URL(path, BASE).href;
const SHELL_URLS = SHELL.map(absolute);
let repairPending = null;
let versionProbePending = null;
function manifestAssets(manifest) {
  const entries = manifest?.harmonium;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 64 || !manifest.tanpura) return null;
  const files = [...entries, manifest.tanpura].map(entry => entry?.file);
  if (!files.every(file => typeof file === 'string' && /^audio\/[A-Za-z0-9_-]+\.wav$/.test(file))) return null;
  return [...new Set([...SHELL_URLS, ...files.map(absolute)])];
}
async function expectedAssets() {
  const cache = await caches.open(CACHE);
  const response = await cache.match(absolute('./audio/manifest.json'));
  if (!response) return null;
  try { return manifestAssets(await response.json()); }
  catch { return null; }
}
async function sameServerVersion() {
  if (typeof AbortController !== 'function') return false;
  if (!versionProbePending) {
    versionProbePending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(absolute('./sw.js'), { cache: 'reload', signal: controller.signal });
        if (!response.ok) return false;
        // Read only our fixed declaration. Never evaluate the downloaded worker.
        const match = (await response.text()).match(/^const VERSION = '([^'\r\n]+)';\r?$/m);
        return match?.[1] === VERSION;
      } catch { return false; }
      finally { clearTimeout(timeout); }
    })().finally(() => { versionProbePending = null; });
  }
  return versionProbePending;
}
async function repairMissingAssets() {
  if (repairPending) return repairPending;
  repairPending = (async () => {
    const cache = await caches.open(CACHE);
    let assets = await expectedAssets();
    const missing = assets ? (await Promise.all(assets.map(async asset => await cache.match(asset) ? null : asset))).filter(Boolean) : [];
    if (assets && missing.length === 0) return;
    if (!await sameServerVersion()) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      if (!assets) {
        const response = await fetch(absolute('./audio/manifest.json'), { cache: 'reload', signal: controller.signal });
        if (!response.ok) return;
        assets = manifestAssets(await response.clone().json());
        if (!assets) return;
        await cache.put(absolute('./audio/manifest.json'), response);
      }
      // Four workers share one bounded list and deadline. Failures leave existing
      // entries untouched; a later online reopen can retry only what is missing.
      const queue = (await Promise.all(assets.map(async asset => await cache.match(asset) ? null : asset))).filter(Boolean);
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length && !controller.signal.aborted) {
          const asset = queue.shift();
          try {
            const response = await fetch(asset, { cache: 'reload', signal: controller.signal });
            if (response.ok) await cache.put(asset, response);
          } catch { /* Preserve the remaining complete cache on network/quota failure. */ }
        }
      }));
    } catch { /* Readiness below reports incomplete if repair could not finish. */ }
    finally { clearTimeout(timeout); }
  })().finally(() => { repairPending = null; });
  return repairPending;
}
async function rememberKnownFallback(cache, lookup, response) {
  if (!response.ok) return;
  try {
    const assets = await expectedAssets();
    const url = typeof lookup === 'string' ? lookup : lookup.url;
    if (!(assets || SHELL_URLS).includes(url) || !await sameServerVersion()) return;
    await cache.put(lookup, response);
  }
  catch { /* A useful online response must still be returned when storage fails. */ }
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(absolute('./audio/manifest.json'), { cache: 'reload' });
    if (!response.ok) throw new Error('Sound manifest unavailable');
    const manifest = await response.json();
    const assets = manifestAssets(manifest);
    if (!assets) throw new Error('Sound manifest invalid');
    const cache = await caches.open(CACHE);
    await cache.addAll(assets.map(path => new Request(path, { cache: 'reload' })));
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
      await repairMissingAssets();
      const assets = await expectedAssets(); const cache = await caches.open(CACHE);
      ready = assets !== null && (await Promise.all(assets.map(asset => cache.match(asset)))).every(Boolean);
    } catch { ready = false; }
    event.ports[0]?.postMessage({ ready, version: VERSION });
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  let saveResponse = Promise.resolve();
  const response = (async () => {
    const cache = await caches.open(CACHE);
    const lookup = event.request.mode === 'navigate' ? new Request(url.origin + url.pathname) : event.request;
    const cached = await cache.match(lookup);
    if (cached) return cached;
    const response = await fetch(event.request);
    saveResponse = rememberKnownFallback(cache, lookup, response.clone());
    return response;
  })();
  event.respondWith(response);
  // Register during dispatch, before any await. Response delivery does not wait
  // for the optional version probe or cache write, but the worker stays alive.
  event.waitUntil(response.then(() => saveResponse).catch(() => {}));
});
