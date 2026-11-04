import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HariAudio } from '../dist/audio.mjs';

const assetRoot = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('audio/manifest.json', assetRoot), 'utf8'));

class Param {
  value = 0;
  events = [];
  record(type, value, time) {
    assert.ok(Number.isFinite(value));
    assert.ok(Number.isFinite(time) && time >= 0);
    this.events.push([type, value, time]);
    return this;
  }
  setValueAtTime(value, time) { return this.record('set', value, time); }
  linearRampToValueAtTime(value, time) { return this.record('linear', value, time); }
  exponentialRampToValueAtTime(value, time) { assert.ok(value > 0); return this.record('exponential', value, time); }
  setTargetAtTime(value, time, constant) { assert.ok(constant > 0); return this.record('target', value, time); }
  cancelAndHoldAtTime(time) { return this.record('hold', 0, time); }
  cancelScheduledValues(time) { return this.record('cancel', 0, time); }
}
class Node {
  connections = new Set();
  constructor(context) { this.context = context; context.nodes.push(this); }
  connect(target) {
    assert.equal(target.context, this.context, 'nodes must share one context');
    this.connections.add(target);
    return target;
  }
  disconnect() { this.connections.clear(); }
}
class Source extends Node {
  playbackRate = new Param();
  frequency = new Param();
  started = false;
  ended = false;
  stopAt = Infinity;
  start(time = 0) { assert.ok(!this.started); assert.ok(time >= 0); this.started = true; }
  stop(time = 0) { assert.ok(this.started, 'stop requires a started source'); assert.ok(time >= 0); this.stopAt = time; }
}
class Context {
  static instances = [];
  static allowResume = true;
  nodes = [];
  listeners = [];
  state = 'suspended';
  currentTime = 0;
  constructor() { this.destination = new Node(this); Context.instances.push(this); }
  addEventListener(name, callback) { assert.equal(name, 'statechange'); this.listeners.push(callback); }
  changeState(state) { this.state = state; for (const listener of this.listeners) listener(); }
  async resume() { if (Context.allowResume) this.changeState('running'); }
  createGain() { const node = new Node(this); node.gain = new Param(); return node; }
  createDynamicsCompressor() {
    const node = new Node(this);
    for (const field of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[field] = new Param();
    return node;
  }
  createBufferSource() { return new Source(this); }
  createOscillator() { return new Source(this); }
  async decodeAudioData(buffer) { assert.ok(buffer.byteLength > 0); return { decoded: true }; }
  advance(seconds) {
    this.currentTime += seconds;
    for (const node of this.nodes) {
      if (node instanceof Source && node.started && !node.ended && node.stopAt <= this.currentTime) {
        node.ended = true;
        node.onended?.();
      }
    }
  }
}

async function fixture(t, fetchOverride) {
  const previousContext = globalThis.AudioContext;
  const previousFetch = globalThis.fetch;
  Context.instances = [];
  Context.allowResume = true;
  let fetches = 0;
  globalThis.AudioContext = Context;
  globalThis.fetch = fetchOverride || (async path => {
    fetches++;
    if (path.endsWith('manifest.json')) return { ok: true, json: async () => structuredClone(manifest) };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) };
  });
  t.after(() => { globalThis.AudioContext = previousContext; globalThis.fetch = previousFetch; });
  const audio = new HariAudio();
  return { audio, fetches: () => fetches };
}

test('concurrent enable shares one context and one complete load without starting sound', async t => {
  const { audio, fetches } = await fixture(t);
  await Promise.all([audio.enable(), audio.enable(), audio.enable()]);
  assert.equal(Context.instances.length, 1);
  assert.equal(fetches(), manifest.harmonium.length + 2);
  assert.equal(audio.ready, true);
  assert.equal(audio.active.size, 0);
  assert.ok(audio.compressor.connections.has(audio.master));
  assert.ok(audio.master.connections.has(audio.context.destination));
});

test('failed or blocked enable is truthful and retryable', async t => {
  let fail = true;
  const { audio } = await fixture(t, async path => {
    if (path.endsWith('manifest.json')) return { ok: true, json: async () => structuredClone(manifest) };
    return { ok: !fail, arrayBuffer: async () => new ArrayBuffer(16) };
  });
  Context.allowResume = false;
  await assert.rejects(audio.enable(), /paused/);
  assert.equal(audio.ready, false);
  Context.allowResume = true;
  await assert.rejects(audio.enable(), /missing/);
  assert.equal(audio.samplesReady, false);
  assert.equal(audio.noteOn('a', 48), false);
  fail = false;
  await audio.enable();
  assert.equal(audio.ready, true);
  assert.equal(Context.instances.length, 1);
});

test('stop during loading never creates delayed audio', async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { audio } = await fixture(t, async path => {
    if (path.endsWith('manifest.json')) return { ok: true, json: async () => { await gate; return structuredClone(manifest); } };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) };
  });
  const pending = audio.enable();
  audio.stop();
  finish();
  await pending;
  assert.equal(audio.active.size, 0);
  assert.equal(audio.accompaniment, null);
});

test('independent contacts, tuning correction and bounded held polyphony', async t => {
  const { audio } = await fixture(t);
  await audio.enable();
  assert.equal(audio.noteOn('a', 48, 25), true);
  assert.equal(audio.noteOn('a', 48), false);
  assert.equal(audio.noteOn('b', 48, 25), true);
  const voice = audio.voices.get('a');
  const sample = manifest.harmonium.find(sample => sample.midi === 48);
  assert.ok(Math.abs(voice.source.playbackRate.value - 2 ** ((25 - sample.tuningCents) / 1200)) < 1e-12);
  audio.noteOff('a');
  audio.noteOff('a');
  assert.equal(audio.voices.size, 1);
  assert.equal(audio.voices.has('b'), true);
  audio.context.advance(.2);
  assert.equal(voice.source.connections.size, 0);
  assert.equal(voice.gain.connections.size, 0);
  for (let i = 0; i < 30; i++) audio.noteOn(i, 60);
  assert.equal(audio.voices.size, 16);
  assert.equal(audio.noteOn('bad', NaN), false);
  assert.equal(audio.noteOn('bad', 48, 101), false);
});

test('Sa and tanpura crossfade independently of keys, silence releases only accompaniment', async t => {
  const { audio } = await fixture(t);
  await audio.enable();
  audio.noteOn('key', 60);
  assert.equal(audio.setAccompaniment('sa', 48, 10), true);
  const sa = audio.accompaniment;
  audio.setAccompaniment('sa', 48, 10);
  assert.equal(audio.accompaniment, sa, 'unchanged settings should not restart loop');
  audio.context.advance(1);
  audio.setAccompaniment('tanpura', 59, -25);
  const tanpura = audio.accompaniment;
  assert.notEqual(tanpura, sa);
  assert.ok(Math.abs(tanpura.source.playbackRate.value - 2 ** (-1.25 / 12)) < 1e-12);
  assert.equal(audio.voices.size, 1);
  audio.context.advance(.5);
  assert.ok(sa.ended);
  audio.setAccompaniment('silent');
  assert.equal(audio.accompaniment, null);
  assert.equal(audio.voices.size, 1);
  audio.context.advance(.5);
  assert.ok(tanpura.ended);
  assert.throws(() => audio.setAccompaniment('unknown'), RangeError);
});

test('stop releases keys, old crossfade tails and all bell oscillators', async t => {
  const { audio } = await fixture(t);
  await audio.enable();
  audio.noteOn('key', 48);
  audio.setAccompaniment('sa', 48);
  audio.setAccompaniment('tanpura', 48);
  audio.bell();
  assert.equal(audio.active.size, 6);
  audio.stop();
  audio.stop();
  assert.equal(audio.voices.size, 0);
  assert.equal(audio.accompaniment, null);
  audio.context.advance(.11);
  assert.equal(audio.active.size, 0);
  for (const source of audio.context.nodes.filter(node => node instanceof Source)) assert.equal(source.connections.size, 0);
});

test('suspension and interruption disconnect sound immediately and require explicit restart', async t => {
  const { audio } = await fixture(t);
  await audio.enable();
  for (const state of ['suspended', 'interrupted']) {
    audio.noteOn('key', 48);
    audio.setAccompaniment('sa', 48);
    audio.bell();
    const sources = [...audio.active];
    audio.context.changeState(state);
    assert.equal(audio.ready, false);
    assert.equal(audio.active.size, 0);
    assert.equal(audio.voices.size, 0);
    assert.ok(sources.every(voice => voice.source.connections.size === 0 && voice.gain.connections.size === 0));
    assert.equal(audio.noteOn('key', 48), false);
    await audio.enable();
    assert.equal(audio.active.size, 0, 'resume must not revive prior voices');
  }
  audio.context.changeState('closed');
  await assert.rejects(audio.enable(), /closed/);
  assert.equal(Context.instances.length, 1);
});

test('release fallback handles browsers without cancelAndHoldAtTime and invalid levels', async t => {
  const { audio } = await fixture(t);
  audio.setLevels(3, -2);
  await audio.enable();
  assert.equal(audio.master.gain.value, 1);
  assert.equal(audio.droneBus.gain.value, 0);
  audio.noteOn('key', 48);
  const voice = audio.voices.get('key');
  voice.gain.gain.cancelAndHoldAtTime = undefined;
  audio.context.advance(.01);
  audio.noteOff('key');
  assert.ok(voice.gain.gain.events.some(([type, value]) => type === 'set' && Math.abs(value - .4) < 1e-12));
  audio.setLevels(NaN, Infinity);
  assert.equal(audio.volume, 1);
  assert.equal(audio.droneVolume, 0);
  audio.context.advance(.2);
  assert.equal(audio.active.size, 0);
});

test('recorded sound assets match preserved manifest sizes and SHA-256', async () => {
  for (const sample of [...manifest.harmonium, manifest.tanpura]) {
    const bytes = await readFile(new URL(sample.file, assetRoot));
    assert.equal(bytes.length, sample.bytes, sample.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256, sample.file);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  }
});

test('bell-only enable fetches no recordings and later full enable reuses its context', async t => {
  const { audio, fetches } = await fixture(t);
  assert.equal(audio.bell(), false);
  await audio.enableBell();
  assert.equal(fetches(), 0);
  assert.equal(audio.context.state, 'running');
  assert.equal(audio.ready, false, 'bell readiness must not imply sample readiness');
  assert.equal(audio.noteOn('key', 48), false);
  assert.equal(audio.setAccompaniment('sa', 48), false);
  assert.equal(audio.bell(), true);
  assert.equal(audio.active.size, 3);
  audio.stop();
  audio.context.advance(.11);
  assert.equal(audio.active.size, 0);
  await audio.enable();
  assert.equal(Context.instances.length, 1);
  assert.equal(fetches(), manifest.harmonium.length + 2);
  assert.equal(audio.ready, true);
  assert.equal(audio.noteOn('key', 48), true);
});

function fakeLoadDeadline(t) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => { timer.cancelled = true; };
  t.after(() => { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; });
  return timers;
}
const settleAudio = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('a stalled shared fetch times out, aborts network work and permits a fresh retry', async t => {
  let stalled = true;
  const signals = [];
  const { audio } = await fixture(t, async (path, options) => {
    signals.push(options.signal);
    if (stalled) return new Promise(() => {});
    if (path.endsWith('manifest.json')) return { ok: true, json: async () => structuredClone(manifest) };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) };
  });
  const deadlines = fakeLoadDeadline(t);
  const first = audio.enable();
  const second = audio.enable();
  const firstRejected = assert.rejects(first, /too long.*Try again.*Silence/);
  const secondRejected = assert.rejects(second, /too long/);
  await settleAudio();
  assert.equal(deadlines.length, 1, 'concurrent callers share one deadline');
  assert.equal(deadlines[0].delay, 45_000);
  assert.equal(signals.length, 1);
  audio.stop();
  deadlines[0].callback();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(signals[0].aborted, true);
  assert.equal(audio.loading, null);
  assert.equal(audio.ready, false);
  assert.equal(deadlines[0].cancelled, true);
  stalled = false;
  await audio.enable();
  assert.equal(audio.ready, true);
  assert.equal(Context.instances.length, 1);
  assert.equal(deadlines[1].cancelled, true, 'successful retry clears its deadline');
  assert.equal(audio.active.size, 0);
});

test('a late decoder from a timed-out load cannot publish over a successful retry', async t => {
  const { audio } = await fixture(t);
  const deadlines = fakeLoadDeadline(t);
  await audio.enableBell();
  let finishOld;
  const oldDecode = new Promise(resolve => { finishOld = resolve; });
  audio.context.decodeAudioData = () => oldDecode;
  const first = audio.enable();
  const rejected = assert.rejects(first, /too long/);
  await settleAudio();
  deadlines[0].callback();
  await rejected;
  assert.equal(audio.samplesReady, false);
  const freshBuffer = { decoded: 'fresh attempt' };
  audio.context.decodeAudioData = async () => freshBuffer;
  await audio.enable();
  const freshManifest = audio.manifest;
  assert.equal(audio.manifest.harmonium[0].buffer, freshBuffer);
  finishOld({ decoded: 'stale attempt' });
  await settleAudio();
  assert.equal(audio.manifest, freshManifest);
  assert.ok([...audio.manifest.harmonium, audio.manifest.tanpura].every(sample => sample.buffer === freshBuffer));
  assert.equal(audio.ready, true);
  assert.equal(audio.active.size, 0);
});
