import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PracticeTimer, NoteHolds, localDate, sanitizeSettings, midiFor, noteName, closestSample, playbackRate } from '../dist/core.mjs';

test('a delayed timer callback finishes at its wallclock deadline', () => {
  let now = 1000;
  const timer = new PracticeTimer(10, () => now);
  timer.start();
  now += 247_300;
  assert.equal(timer.display, '05:53');
  now += 360_000;
  assert.equal(timer.display, '00:00');
  assert.equal(timer.state, 'complete');
  assert.equal(timer.endAt, 601_000); // Original deadline permits stale-bell suppression.
});

test('pause and resume exclude paused time and preserve the selected preset', () => {
  let now = 0;
  const timer = new PracticeTimer(15, () => now);
  timer.start();
  now = 125_000;
  timer.pause();
  assert.equal(timer.state, 'paused');
  assert.equal(timer.endAt, null);
  now += 300_000;
  assert.equal(timer.display, '12:55');
  timer.start();
  assert.equal(timer.endAt, 1_200_000);
  now = 1_200_000;
  assert.equal(timer.display, '00:00');
  assert.equal(timer.state, 'complete');
});

test('reset cancels an old deadline and repeated Start never postpones a running timer', () => {
  let now = 0;
  const timer = new PracticeTimer(10, () => now);
  timer.start();
  now = 30_000;
  timer.start();
  assert.equal(timer.endAt, 600_000);
  timer.reset(15);
  now = 1_000_000;
  assert.equal(timer.display, '15:00');
  assert.equal(timer.state, 'idle');
  timer.start();
  assert.equal(timer.endAt, now + 900_000);
});

test('completion is stable, pause after expiry does not resurrect it, and Start begins a fresh preset', () => {
  let now = 0;
  const timer = new PracticeTimer(10, () => now);
  timer.start();
  now = 600_000;
  timer.pause();
  assert.equal(timer.state, 'complete');
  now = 700_000;
  assert.equal(timer.tick(), 0);
  timer.start();
  assert.equal(timer.state, 'running');
  assert.equal(timer.remaining, 600_000);
  assert.equal(timer.endAt, 1_300_000);
});

test('snapshot samples the current clock and roundtrips active state through JSON', () => {
  let now = 10_000;
  const timer = new PracticeTimer(15, () => now);
  timer.start();
  now = 40_000;
  const snapshot = JSON.parse(JSON.stringify(timer.snapshot()));
  assert.deepEqual(snapshot, { version: 1, minutes: 15, state: 'running', remaining: 870_000, endAt: 910_000 });
  now = 310_000;
  const restored = PracticeTimer.restore(snapshot, () => now);
  assert.equal(restored.state, 'running');
  assert.equal(restored.display, '10:00');
  assert.equal(restored.endAt, 910_000);
});

test('paused state restores without counting offline time, then resumes from the new clock', () => {
  let now = 0;
  const timer = new PracticeTimer(10, () => now);
  timer.start();
  now = 120_000;
  timer.pause();
  const snapshot = timer.snapshot();
  now = 99_000_000;
  const restored = PracticeTimer.restore(snapshot, () => now);
  assert.equal(restored.display, '08:00');
  assert.equal(restored.state, 'paused');
  restored.start();
  assert.equal(restored.endAt, now + 480_000);
});

test('an expired active snapshot restores directly complete with its original deadline', () => {
  let now = 0;
  const timer = new PracticeTimer(10, () => now);
  timer.start();
  const snapshot = timer.snapshot();
  now = 86_400_000;
  const restored = PracticeTimer.restore(snapshot, () => now);
  assert.equal(restored.state, 'complete');
  assert.equal(restored.display, '00:00');
  assert.equal(restored.endAt, 600_000);
  assert.equal(restored.snapshot().state, 'complete');
  assert.equal('marks' in restored.snapshot(), false);
});

test('idle and completed snapshots roundtrip without starting or marking practice', () => {
  const idle = new PracticeTimer(15, () => 1000);
  assert.equal(PracticeTimer.restore(idle.snapshot(), () => 8000).state, 'idle');
  const completed = PracticeTimer.restore({ version: 1, minutes: 15, state: 'complete', remaining: 0, endAt: null });
  assert.equal(completed.state, 'complete');
  assert.equal(completed.endAt, null);
  assert.equal(completed.minutes, 15);
});

test('corrupt, impossible, and incompatible timer snapshots restore clean idle', () => {
  const base = { version: 1, minutes: 10, state: 'running', remaining: 600_000, endAt: 600_000 };
  for (const bad of [null, [], 'running', {}, { ...base, version: 2 }, { ...base, minutes: 1 },
    { ...base, state: 'alarm' }, { ...base, remaining: NaN }, { ...base, remaining: -1 },
    { ...base, remaining: 600_001 }, { ...base, remaining: 0 }, { ...base, endAt: Infinity },
    { ...base, endAt: '600000' }, { ...base, endAt: 600_001 },
    { ...base, state: 'paused' }, { ...base, state: 'idle', endAt: null, remaining: 5 },
    { ...base, state: 'complete', remaining: 1 }]) {
    const timer = new PracticeTimer(10, () => 0);
    timer.start();
    assert.equal(timer.restore(bad), timer);
    assert.deepEqual(timer.snapshot(), { version: 1, minutes: 10, state: 'idle', remaining: 600_000, endAt: null });
  }
});

test('unsupported preset inputs cannot create arbitrarily long or invalid timers', () => {
  for (const value of [0, -10, 11, Infinity, '15', null]) {
    const timer = new PracticeTimer(value, () => 0);
    assert.equal(timer.display, '10:00');
    timer.reset(value);
    assert.equal(timer.remaining, 600_000);
  }
});

test('a backwards wallclock adjustment cannot increase displayed remaining time', () => {
  let now = 0;
  const timer = new PracticeTimer(10, () => now);
  timer.start();
  now = 60_000;
  assert.equal(timer.tick(), 540_000);
  now = 30_000;
  assert.equal(timer.tick(), 540_000);
});

test('multiple fingers and keyboard contacts own notes independently', () => {
  const notes = new NoteHolds();
  notes.down('finger-1', 0);
  notes.down('finger-2', 0);
  notes.down('keyboard-g', 4);
  notes.up('finger-1');
  assert.deepEqual([...notes.active].sort(), [0, 4]);
  notes.up('finger-2');
  assert.deepEqual([...notes.active], [4]);
  notes.clear();
  assert.equal(notes.active.size, 0);
});

test('sliding transfers ownership; sustain and physical contact remain independent', () => {
  const notes = new NoteHolds();
  notes.down('finger-1', 0);
  notes.down('finger-1', 1);
  assert.deepEqual([...notes.active], [1]);
  notes.down('finger-2', 1, true);
  notes.down('finger-2', 1, true); // Repeated down on one contact cannot toggle twice.
  notes.up('finger-1');
  notes.up('finger-2');
  assert.deepEqual([...notes.active], [1]);
  notes.down('finger-3', 1);
  notes.down('finger-2', 1, true); // Unlatch while another contact still owns the note.
  assert.deepEqual([...notes.active], [1]);
  notes.up('finger-3');
  assert.equal(notes.active.size, 0);
  notes.down('finger-4', 4, true);
  notes.clear();
  assert.equal(notes.active.size, 0);
});

test('bad note indices cannot enter active notes, and active is a defensive copy', () => {
  const notes = new NoteHolds();
  for (const index of [-1, 8, NaN, '0', 1.5]) notes.down('bad', index, true);
  notes.down(null, 0);
  assert.equal(notes.active.size, 0);
  notes.down('finger', 0);
  notes.active.clear();
  assert.deepEqual([...notes.active], [0]);
});

test('practice marks use local dates on both sides of local midnight and New Year', () => {
  assert.equal(localDate(new Date(2026, 10, 3, 0, 2)), '2026-11-03');
  assert.equal(localDate(new Date(2026, 10, 2, 23, 59)), '2026-11-02');
  assert.equal(localDate(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.equal(localDate(new Date(2027, 0, 1, 0, 0)), '2027-01-01');
});

test('damaged settings cannot inject invalid pitch, mode, or practice marks', () => {
  const value = sanitizeSettings({ root: 99, octave: -8, cents: Infinity, sound: 'melody', volume: Infinity, droneVolume: -9, minutes: 13,
    marks: { bad: {}, '2026-11-03': { morning: 'true', evening: true }, '2026-02-30': { morning: true }, '2026-11-04': [] } });
  assert.equal(value.root, 0);
  assert.equal(value.octave, 3);
  assert.equal(value.cents, 0);
  assert.equal(value.sound, 'sa');
  assert.equal(value.minutes, 10);
  assert.equal(value.droneVolume, 0);
  assert.deepEqual(value.marks, { '2026-11-03': { morning: false, evening: true } });
  assert.deepEqual(sanitizeSettings(null).marks, {});
  assert.deepEqual(sanitizeSettings([]), DEFAULTS);
});

test('settings preserve valid tuning and manual marks while dropping unrelated data', () => {
  const value = sanitizeSettings({ root: 11, octave: 2, cents: 70, sound: 'silent', volume: 2, droneVolume: 0.3, minutes: 15,
    marks: { '2024-02-29': { morning: true, evening: false }, '2025-02-29': { morning: true } }, token: 'discard' });
  assert.deepEqual(value, { root: 11, octave: 2, cents: 50, sound: 'silent', volume: 1, droneVolume: 0.3, minutes: 15,
    marks: { '2024-02-29': { morning: true, evening: false } } });
  assert.equal(sanitizeSettings({ cents: -60, sound: 'tanpura', octave: 4 }).cents, -50);
  const first = sanitizeSettings(null);
  first.marks['2026-11-03'] = { morning: true, evening: true };
  assert.deepEqual(sanitizeSettings(null).marks, {});
});

test('all swaras transpose with Sa and upper Sa resolves at the octave', () => {
  assert.equal(noteName(midiFor(0, 0, 3)), 'C3');
  assert.equal(noteName(midiFor(4, 0, 3)), 'G3');
  assert.equal(noteName(midiFor(7, 2, 3)), 'D4');
  for (let root = 0; root < 12; root++) {
    for (const octave of [2, 3, 4]) assert.equal(midiFor(7, root, octave) - midiFor(0, root, octave), 12);
  }
});

test('sampler compensates recording tuning and applies fine tuning independently of semitones', () => {
  const samples = [{ midi: 48, tuningCents: 10 }, { midi: 52, tuningCents: 0 }];
  assert.equal(closestSample(samples, 49), samples[0]);
  assert.equal(closestSample(samples, 51), samples[1]);
  assert.ok(playbackRate(samples[0], 48) < 1);
  assert.equal(playbackRate(samples[1], 64), 2);
  assert.equal(playbackRate(samples[0], 48, 10), 1);
  assert.equal(playbackRate({ midi: 48 }, 48), 1);
  assert.ok(Math.abs(playbackRate(samples[1], 52, 50) - 2 ** (50 / 1200)) < 1e-12);
});
