import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenAwake } from '../dist/wake.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function sentinel() {
  const lock = new EventTarget();
  lock.releases = 0;
  lock.release = async () => { lock.releases++; lock.dispatchEvent(new Event('release')); };
  return lock;
}

test('wake lock is requested only while wanted and visible, then released on stop', async () => {
  const document = { hidden: false };
  const lock = sentinel(); const requests = []; const reports = [];
  const awake = new ScreenAwake({ wakeLock: { request: async kind => { requests.push(kind); return lock; } } }, document, text => reports.push(text));
  awake.setWanted(false); await settle(); assert.equal(requests.length, 0);
  awake.setWanted(true); await settle(); assert.deepEqual(requests, ['screen']);
  assert.equal(awake.lock, lock);
  awake.setWanted(false); await settle(); assert.equal(lock.releases, 1);
  assert.equal(awake.lock, null);
});

test('a stale request resolved after hiding is immediately released', async () => {
  const gate = deferred(); const document = { hidden: false }; const lock = sentinel();
  const awake = new ScreenAwake({ wakeLock: { request: () => gate.promise } }, document, () => {});
  awake.setWanted(true);
  document.hidden = true; await awake.refresh();
  gate.resolve(lock); await settle();
  assert.equal(awake.lock, null);
  assert.equal(lock.releases, 1);
  assert.equal(awake.pending, false);
});

test('a request rejected by the device leaves the helper retryable', async () => {
  let requests = 0; const lock = sentinel(); const reports = [];
  const awake = new ScreenAwake({ wakeLock: { request: async () => { if (++requests === 1) throw Error('denied'); return lock; } } }, { hidden: false }, text => reports.push(text));
  awake.setWanted(true); await settle();
  assert.equal(awake.pending, false);
  assert.match(reports.at(-1), /declined/);
  await awake.refresh();
  assert.equal(awake.lock, lock);
});

test('returning visible reacquires after the previous lock was released', async () => {
  const document = { hidden: false }; const locks = [sentinel(), sentinel()]; let calls = 0;
  const awake = new ScreenAwake({ wakeLock: { request: async () => locks[calls++] } }, document, () => {});
  awake.setWanted(true); await settle();
  document.hidden = true; await awake.refresh();
  document.hidden = false; await awake.refresh();
  assert.equal(calls, 2);
  assert.equal(awake.lock, locks[1]);
});

test('screen-awake API absence is a reported fallback rather than an exception', async () => {
  const reports = [];
  const awake = new ScreenAwake({}, { hidden: false }, text => reports.push(text));
  awake.setWanted(true); await settle();
  assert.equal(awake.lock, null);
  assert.match(reports.at(-1), /cannot keep the screen awake/);
});

test('a delayed previous release cannot overwrite the newly acquired lock status', async () => {
  const delayedRelease = deferred(); const first = sentinel(); const second = sentinel();
  first.release = () => delayedRelease.promise;
  const reports = []; let requests = 0;
  const awake = new ScreenAwake({ wakeLock: { request: async () => ++requests === 1 ? first : second } }, { hidden: false }, text => reports.push(text));
  awake.setWanted(true); await settle();
  awake.setWanted(false); await settle();
  awake.setWanted(true); await settle();
  assert.equal(awake.lock, second);
  assert.equal(reports.at(-1), 'Screen awake');
  delayedRelease.resolve(); await settle();
  assert.equal(reports.at(-1), 'Screen awake');
});
