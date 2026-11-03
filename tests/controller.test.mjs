// Code-level DOM integration only. This does not exercise a real browser,
// layout, Web Audio, autoplay policy, Android, or service-worker behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const [html, controllerSource, coreSource] = await Promise.all([
  readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../dist/core.mjs', import.meta.url), 'utf8'),
]);
const SETTINGS = 'hari-settings-v1';
const TIMER = 'hari-timer-v1';
const initialTime = new Date(2026, 10, 4, 8, 0).getTime();
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness({ stored = {}, gate = null, bellGate = null, audioFailure = null, bellFailure = null, storageFailure = false, serviceWorker = null } = {}) {
  const { document, window } = parseHTML(html);
  document.hidden = false;
  const clock = { now: initialTime };
  const intervals = []; const timeouts = []; const location = { reloads: 0, reload() { this.reloads++; } };
  const storage = new Map(Object.entries(stored).map(([key, value]) => [key, JSON.stringify(value)]));
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  let audio;
  class AudioStub {
    constructor() {
      audio = this; this.voices = new Map(); this.ready = false; this.context = null;
      this.accompaniment = 'silent'; this.bells = 0; this.enables = 0; this.bellEnables = 0; this.stops = 0;
      this.accompanimentCalls = [];
    }
    async enable() {
      this.enables++;
      await this.enableBell();
      if (gate) await gate.promise;
      if (audioFailure) throw new Error(audioFailure);
      this.ready = true;
    }
    async enableBell() {
      this.bellEnables++;
      if (bellGate) await bellGate.promise;
      if (bellFailure) throw new Error(bellFailure);
      this.context ??= new EventTarget(); this.context.state = 'running';
    }
    setLevels(volume, balance) { this.volume = volume; this.balance = balance; }
    setAccompaniment(mode) { this.accompanimentCalls.push(mode); this.accompaniment = mode; return mode === 'silent' || this.ready; }
    noteOn(id) { this.voices.set(id, true); }
    noteOff(id) { this.voices.delete(id); }
    stop() { this.stops++; this.voices.clear(); this.accompaniment = 'silent'; }
    bell() { if (this.context?.state !== 'running') return false; this.bells++; return true; }
  }
  class AwakeStub { setWanted(value) { this.wanted = value; } refresh() {} }
  class MessageChannelStub {
    constructor() {
      this.port1 = { onmessage: null, close() {} };
      this.port2 = { receive: data => this.port1.onmessage?.({ data }) };
    }
  }
  const context = vm.createContext({
    document, window, navigator: serviceWorker ? { serviceWorker } : {}, Date: ClockDate, console, location,
    localStorage: {
      getItem: key => { if (storageFailure) throw Error('denied'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageFailure) throw Error('denied'); storage.set(key, value); },
    },
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    setTimeout: (callback, delay) => { const entry = { callback, delay, canceled: false }; timeouts.push(entry); return entry; },
    clearTimeout: entry => { if (entry) entry.canceled = true; }, isSecureContext: Boolean(serviceWorker), MessageChannel: MessageChannelStub,
  });
  const core = new vm.SourceTextModule(coreSource, { context });
  const audioModule = new vm.SyntheticModule(['HariAudio'], function () { this.setExport('HariAudio', AudioStub); }, { context });
  const awakeModule = new vm.SyntheticModule(['ScreenAwake'], function () { this.setExport('ScreenAwake', AwakeStub); }, { context });
  const controller = new vm.SourceTextModule(controllerSource, { context });
  await controller.link(specifier => ({ './core.mjs': core, './audio.mjs': audioModule, './wake.mjs': awakeModule })[specifier]);
  await controller.evaluate();
  await settle();
  const $ = id => document.getElementById(id);
  async function click(id) { $(id).dispatchEvent(new window.Event('click', { bubbles: true })); await settle(); }
  async function chooseSound(sound) { document.querySelector(`[data-sound="${sound}"]`).dispatchEvent(new window.Event('click', { bubbles: true })); await settle(); }
  async function visibility(hidden) { document.hidden = hidden; document.dispatchEvent(new window.Event('visibilitychange')); await settle(); }
  return { $, audio, clock, storage, document, window, location, click, chooseSound, visibility,
    fireTimeout: async delay => { for (const entry of timeouts) if (entry.delay === delay && !entry.canceled) { entry.canceled = true; entry.callback(); } await settle(); },
    tick: async () => { for (const fn of intervals) fn(); await settle(); },
    timer: () => JSON.parse(storage.get(TIMER) ?? 'null'),
    settings: () => JSON.parse(storage.get(SETTINGS) ?? 'null'),
  };
}

test('Begin, pause, resume and reset drive the actual controller and preserve manual marks', async () => {
  const h = await harness();
  assert.equal(h.$('practice-stage').dataset.state, 'idle');
  await h.click('timer-start');
  assert.equal(h.timer().state, 'running');
  assert.equal(h.audio.accompaniment, 'sa');
  h.clock.now += 60_000; await h.tick();
  assert.equal(h.$('countdown').textContent, '09:00');
  await h.click('timer-start');
  assert.equal(h.timer().state, 'paused');
  assert.equal(h.audio.accompaniment, 'silent');
  h.clock.now += 600_000; await h.tick();
  assert.equal(h.$('countdown').textContent, '09:00');
  await h.click('timer-start'); assert.equal(h.timer().state, 'running');
  await h.click('timer-reset');
  assert.equal(h.timer().state, 'idle');
  assert.equal(h.$('countdown').textContent, '10:00');
  assert.deepEqual(h.settings().marks, {});
});

test('Stop during pending decode prevents a late timer or tone start', async () => {
  const gate = deferred(); const h = await harness({ gate });
  await h.click('timer-start');
  assert.equal(h.$('timer-start').disabled, true);
  await h.click('stop');
  gate.resolve(); await settle();
  assert.equal(h.$('practice-stage').dataset.state, 'idle');
  assert.equal(h.audio.accompaniment, 'silent');
  assert.equal(h.$('timer-start').disabled, false);
});

test('restoring a running timer requires explicit sound resumption', async () => {
  const h = await harness({ stored: {
    [TIMER]: { version: 1, minutes: 15, state: 'running', remaining: 300_000, endAt: initialTime + 300_000 },
  } });
  assert.equal(h.$('countdown').textContent, '05:00');
  assert.equal(h.$('practice-stage').dataset.state, 'running');
  assert.equal(h.$('session-return').hidden, false);
  assert.equal(h.audio.enables, 0);
  await h.click('session-return');
  assert.equal(h.audio.accompaniment, 'sa');
  assert.equal(h.$('session-return').hidden, true);
});

test('expired reload completes quietly and does not create practice marks', async () => {
  const marks = { '2026-11-03': { morning: true, evening: false } };
  const h = await harness({ stored: {
    [SETTINGS]: { marks },
    [TIMER]: { version: 1, minutes: 10, state: 'running', remaining: 60_000, endAt: initialTime - 60_000 },
  } });
  assert.equal(h.$('practice-stage').dataset.state, 'complete');
  await h.tick(); assert.equal(h.audio.bells, 0);
  await h.click('morning');
  assert.deepEqual(h.settings().marks, { ...marks, '2026-11-04': { morning: true, evening: false } });
  await h.click('morning');
  assert.equal(h.settings().marks['2026-11-04'].morning, false);
});

test('hidden sessions keep wallclock time, stop sound and return with a resume action', async () => {
  const h = await harness(); await h.click('timer-start');
  h.clock.now += 30_000; await h.visibility(true);
  assert.equal(h.audio.accompaniment, 'silent');
  h.clock.now += 30_000; await h.visibility(false);
  assert.equal(h.$('countdown').textContent, '09:00');
  assert.equal(h.$('session-return').hidden, false);
  assert.equal(h.audio.accompaniment, 'silent');
  await h.click('session-return'); assert.equal(h.audio.accompaniment, 'sa');
});

test('normal visible completion chimes once and leaves marks entirely manual', async () => {
  const h = await harness(); await h.click('timer-start');
  h.clock.now += 600_000; await h.tick(); await h.tick();
  assert.equal(h.$('practice-stage').dataset.state, 'complete');
  assert.equal(h.audio.bells, 1);
  assert.deepEqual(h.settings().marks, {});
  assert.match(h.$('timer-announcement').textContent, /complete/);
});

test('completion after a hidden/suspended interval never replays a stale bell', async () => {
  const h = await harness(); await h.click('timer-start'); await h.visibility(true);
  h.clock.now += 800_000; await h.visibility(false); await h.tick();
  assert.equal(h.audio.bells, 0);
  assert.equal(h.$('practice-stage').dataset.state, 'complete');
  assert.equal(h.$('session-return').hidden, true);
});

test('storage denial leaves the timer and manual marks usable for this visit', async () => {
  const h = await harness({ storageFailure: true });
  await h.click('timer-start');
  assert.equal(h.$('practice-stage').dataset.state, 'running');
  await h.click('morning');
  assert.equal(h.$('morning').getAttribute('aria-pressed'), 'true');
  assert.match(h.$('storage-status').textContent, /only last for this visit/);
});

test('context interruption stops intent and exposes explicit recovery', async () => {
  const h = await harness(); await h.click('timer-start');
  // Audio engine is independently responsible for actually stopping its nodes.
  h.audio.stop(); h.audio.ready = false; h.audio.context.state = 'suspended';
  h.audio.context.dispatchEvent(new Event('statechange')); await settle();
  assert.equal(h.$('session-return').hidden, false);
  assert.equal(h.$('practice-stage').dataset.state, 'running');
  await h.click('session-return');
  assert.equal(h.audio.accompaniment, 'sa');
});

test('saving a manual mark at the deadline still processes completion', async () => {
  const h = await harness(); await h.click('timer-start');
  h.clock.now += 600_000;
  await h.click('morning'); await h.tick();
  assert.equal(h.$('practice-stage').dataset.state, 'complete');
  assert.match(h.$('timer-announcement').textContent, /complete/);
  assert.equal(h.audio.bells, 1);
});

test('a silent timer remains usable when optional audio files fail to load', async () => {
  const h = await harness({ audioFailure: 'Sound file unavailable', stored: { [SETTINGS]: { sound: 'silent' } } });
  await h.click('timer-start');
  assert.equal(h.$('practice-stage').dataset.state, 'running');
  assert.equal(h.audio.accompaniment, 'silent');
  assert.equal(h.audio.enables, 0);
  h.clock.now += 600_000; await h.tick();
  assert.equal(h.audio.bells, 1);
});

test('a silent timer starts immediately while optional finishing bell is pending or unavailable', async () => {
  const bellGate = deferred();
  const h = await harness({ bellGate, stored: { [SETTINGS]: { sound: 'silent' } } });
  await h.click('timer-start');
  assert.equal(h.$('practice-stage').dataset.state, 'running');
  assert.equal(h.timer().state, 'running');
  bellGate.reject(Error('Web Audio unavailable')); await settle();
  assert.match(h.$('sound-status').textContent, /bell is unavailable/);
  h.clock.now += 600_000; await h.tick();
  assert.equal(h.$('practice-stage').dataset.state, 'complete');
  assert.equal(h.audio.bells, 0);
  assert.deepEqual(h.settings().marks, {});
});

test('a restored silent session can enable its bell without loading optional recordings', async () => {
  const h = await harness({ audioFailure: 'Sound file unavailable', stored: {
    [SETTINGS]: { sound: 'silent' },
    [TIMER]: { version: 1, minutes: 10, state: 'running', remaining: 60_000, endAt: initialTime + 60_000 },
  } });
  await h.click('session-return');
  assert.equal(h.audio.enables, 0);
  assert.equal(h.$('session-return').hidden, true);
  h.clock.now += 60_000; await h.tick();
  assert.equal(h.audio.bells, 1);
});

test('offline readiness is reported unconfirmed if serviceWorker.ready never resolves', async () => {
  const worker = new EventTarget();
  worker.register = async () => Object.assign(new EventTarget(), { installing: null, waiting: null, active: null });
  worker.ready = new Promise(() => {});
  const h = await harness({ serviceWorker: worker });
  assert.match(h.$('offline-status').textContent, /Saving/);
  await h.fireTimeout(15000);
  assert.match(h.$('offline-status').textContent, /not been confirmed/);
});

test('an update requested before Begin never reloads an active session', async () => {
  const messages = [];
  const waiting = { postMessage: message => messages.push(message) };
  const worker = new EventTarget();
  worker.controller = {};
  worker.register = async () => Object.assign(new EventTarget(), { installing: null, waiting, active: {} });
  worker.ready = new Promise(() => {});
  const h = await harness({ serviceWorker: worker });
  assert.equal(h.$('update').hidden, false);
  await h.click('update');
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'ACTIVATE_UPDATE' }]);
  await h.click('timer-start');
  worker.dispatchEvent(new Event('controllerchange')); await settle();
  assert.equal(h.location.reloads, 0);
  assert.equal(h.$('update').textContent, 'Reload update');
  assert.equal(h.$('update').disabled, false);
  await h.click('update'); assert.equal(h.location.reloads, 0);
  await h.click('timer-reset'); await h.click('update');
  assert.equal(h.location.reloads, 1);
});

test('a running silent session can load and start One tone or Tanpura on explicit selection', async () => {
  for (const sound of ['sa', 'tanpura']) {
    const h = await harness({ stored: { [SETTINGS]: { sound: 'silent' } } });
    await h.click('timer-start');
    const deadline = h.timer().endAt;
    assert.equal(h.audio.enables, 0);
    await h.chooseSound(sound);
    assert.equal(h.audio.enables, 1);
    assert.equal(h.audio.accompaniment, sound);
    assert.equal(h.settings().sound, sound);
    assert.equal(h.timer().state, 'running');
    assert.equal(h.timer().endAt, deadline);
  }
});

test('switching back to Silence during recording load cancels stale accompaniment intent', async () => {
  const gate = deferred();
  const h = await harness({ gate, stored: { [SETTINGS]: { sound: 'silent' } } });
  await h.click('timer-start');
  const deadline = h.timer().endAt;
  await h.chooseSound('sa');
  assert.equal(h.audio.enables, 1);
  await h.chooseSound('silent');
  gate.resolve(); await settle();
  assert.equal(h.audio.accompaniment, 'silent');
  assert.equal(h.audio.accompanimentCalls.includes('sa'), false);
  assert.equal(h.settings().sound, 'silent');
  assert.equal(h.timer().state, 'running');
  assert.equal(h.timer().endAt, deadline);
  assert.equal(h.$('timer-start').disabled, false);
});
