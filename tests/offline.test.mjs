import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const workerSource = await readFile(new URL('sw.js', dist), 'utf8');
const manifest = JSON.parse(await readFile(new URL('audio/manifest.json', dist), 'utf8'));

class MemoryCache {
  entries = new Map();
  constructor(fetch) { this.fetch = fetch; }
  key(input) { return typeof input === 'string' ? input : input.url; }
  async match(input) { return this.entries.get(this.key(input))?.clone(); }
  async put(input, response) { this.entries.set(this.key(input), response.clone()); }
  async addAll(requests) {
    // Match Cache.addAll atomicity: no writes if any request fails.
    const responses = await Promise.all(requests.map(request => this.fetch(request)));
    if (responses.some(response => !response.ok)) throw new TypeError('Cache.addAll failed');
    for (let index = 0; index < requests.length; index++) await this.put(requests[index], responses[index]);
  }
}
function harness(path = '/Hari/', existingCaches = new Map(), source = workerSource) {
  const origin = 'https://example.github.io';
  const base = origin + path;
  const events = new Map();
  const network = { online: true, fail: null, requests: [] };
  const fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;
    network.requests.push(url);
    if (!network.online) throw new TypeError('Network offline');
    if (url === network.fail) return new Response('Unavailable', { status: 503 });
    if (url === base + 'audio/manifest.json') return Response.json(manifest);
    return new Response(`asset:${url}`);
  };
  const caches = {
    async open(key) {
      if (!existingCaches.has(key)) existingCaches.set(key, new MemoryCache(fetch));
      return existingCaches.get(key);
    },
    async keys() { return [...existingCaches.keys()]; },
    async delete(key) { return existingCaches.delete(key); },
  };
  const calls = { claimed: 0, skipped: 0 };
  const self = {
    location: { href: base + 'sw.js' },
    clients: { async claim() { calls.claimed++; } },
    skipWaiting() { calls.skipped++; return Promise.resolve(); },
    addEventListener(type, callback) { events.set(type, callback); },
  };
  vm.runInNewContext(source, { self, caches, fetch, Request, Response, URL });
  const dispatch = (type, detail = {}) => {
    let promise;
    events.get(type)({ ...detail, waitUntil(value) { promise = value; }, respondWith(value) { promise = value; } });
    return promise;
  };
  const status = async () => {
    let result;
    await dispatch('message', { data: { type: 'OFFLINE_STATUS' }, ports: [{ postMessage(value) { result = value; } }] });
    return result;
  };
  const request = (suffix, mode = 'cors', method = 'GET') => ({ url: base + suffix, mode, method });
  return { base, caches, cacheMap: existingCaches, network, calls, dispatch, status, request };
}

test('subpath install caches every required asset, including every recording', async () => {
  const worker = harness('/user-project/hari/');
  await worker.dispatch('install');
  const keys = await worker.caches.keys();
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith('hari-app:/user-project/hari/:'));
  const cache = await worker.caches.open(keys[0]);
  assert.equal((await worker.status()).ready, true);
  for (const asset of [...manifest.harmonium, manifest.tanpura]) assert.ok(await cache.match(worker.base + asset.file));
  for (const url of cache.entries.keys()) {
    assert.ok(url.startsWith(worker.base), `asset must stay under app subpath: ${url}`);
    const relative = url.slice(worker.base.length) || 'index.html';
    await readFile(new URL(relative, dist));
  }
  // All local HTML dependencies and controller imports must survive offline.
  const html = await readFile(new URL('index.html', dist), 'utf8');
  const app = await readFile(new URL('app.mjs', dist), 'utf8');
  const refs = [
    ...[...html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)].map(match => match[1]),
    ...[...app.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map(match => match[1]),
  ];
  for (const ref of refs) assert.ok(await cache.match(new URL(ref, worker.base).href), `uncached dependency ${ref}`);
  assert.equal(worker.calls.skipped, 0, 'install must not force an update');
});

test('failed new install is atomic and preserves an older complete cache', async () => {
  const worker = harness();
  const prior = await worker.caches.open('hari-app:/Hari/:old');
  await prior.put(worker.base + 'index.html', new Response('old working app'));
  worker.network.fail = worker.base + manifest.harmonium[0].file;
  await assert.rejects(worker.dispatch('install'), /addAll failed/);
  assert.equal(await (await prior.match(worker.base + 'index.html')).text(), 'old working app');
  const current = (await worker.caches.keys()).find(key => !key.endsWith(':old'));
  assert.equal((await worker.caches.open(current)).entries.size, 0);
  assert.equal((await worker.status()).ready, false);
  assert.equal(worker.calls.claimed, 0);
  assert.equal(worker.calls.skipped, 0);
});

test('activation removes only old versions for the same base path', async () => {
  const worker = harness('/project/hari/');
  await worker.caches.open('hari-app:/project/hari/:old');
  await worker.caches.open('hari-app:/other/hari/:old');
  await worker.caches.open('hari-app:/:old');
  await worker.caches.open('unrelated-app');
  await worker.dispatch('install');
  await worker.dispatch('activate');
  const keys = await worker.caches.keys();
  assert.ok(!keys.includes('hari-app:/project/hari/:old'));
  for (const key of ['hari-app:/other/hari/:old', 'hari-app:/:old', 'unrelated-app']) assert.ok(keys.includes(key));
  assert.equal(worker.calls.claimed, 1);
  assert.equal(worker.calls.skipped, 0);
  worker.dispatch('message', { data: { type: 'ACTIVATE_UPDATE' } });
  assert.equal(worker.calls.skipped, 1);
});

test('offline root, query navigation, index and credits work; unrelated requests are untouched', async () => {
  const worker = harness();
  await worker.dispatch('install');
  worker.network.online = false;
  for (const suffix of ['', '?launch=installed', 'index.html?ref=home', 'credits.html']) {
    const response = await worker.dispatch('fetch', { request: worker.request(suffix, 'navigate') });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).startsWith('asset:' + worker.base));
  }
  for (const asset of [...manifest.harmonium, manifest.tanpura]) {
    const response = await worker.dispatch('fetch', { request: worker.request(asset.file) });
    assert.equal(response.status, 200);
  }
  for (const request of [
    { url: 'https://example.github.io/Other/', method: 'GET', mode: 'navigate' },
    { url: 'https://another.example/Hari/', method: 'GET', mode: 'navigate' },
    { url: 'https://example.github.io/Hari-other/', method: 'GET', mode: 'navigate' },
    worker.request('index.html', 'cors', 'POST'),
  ]) assert.equal(worker.dispatch('fetch', { request }), undefined);
});

test('readiness becomes false after a missing recording or unreadable manifest', async () => {
  const worker = harness();
  await worker.dispatch('install');
  const cache = await worker.caches.open((await worker.caches.keys())[0]);
  const file = worker.base + manifest.tanpura.file;
  const previous = await cache.match(file);
  cache.entries.delete(file);
  assert.equal((await worker.status()).ready, false);
  await cache.put(file, previous);
  assert.equal((await worker.status()).ready, true);
  await cache.put(worker.base + 'audio/manifest.json', new Response('broken json'));
  assert.equal((await worker.status()).ready, false);
});
