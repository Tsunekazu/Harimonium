export const SWARAS = ['Sa', 'Re', 'Ga', 'Ma', 'Pa', 'Dha', 'Ni', 'Sa′'];
export const STEPS = [0, 2, 4, 5, 7, 9, 11, 12];
export const PITCHES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const DEFAULTS = { root: 0, octave: 3, cents: 0, sound: 'sa', volume: 0.48, droneVolume: 0.6, minutes: 10, marks: {} };

export function midiFor(index, root, octave) {
  return (octave + 1) * 12 + root + STEPS[index];
}
export function noteName(midi) {
  return `${PITCHES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
export function closestSample(samples, midi) {
  return samples.reduce((best, sample) => Math.abs(sample.midi - midi) < Math.abs(best.midi - midi) ? sample : best);
}
export function playbackRate(sample, midi, cents = 0) {
  return 2 ** ((100 * (midi - sample.midi) + cents - (sample.tuningCents ?? 0)) / 1200);
}
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const preset = value => [10, 15].includes(value) ? value : DEFAULTS.minutes;
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export function sanitizeSettings(input) {
  const result = { ...DEFAULTS, marks: {} };
  if (!isRecord(input)) return result;
  if (Number.isInteger(input.root) && input.root >= 0 && input.root <= 11) result.root = input.root;
  if ([2, 3, 4].includes(input.octave)) result.octave = input.octave;
  if (['sa', 'tanpura', 'silent'].includes(input.sound)) result.sound = input.sound;
  if (isFiniteNumber(input.cents)) result.cents = Math.max(-50, Math.min(50, input.cents));
  for (const name of ['volume', 'droneVolume']) {
    if (typeof input[name] === 'number' && Number.isFinite(input[name])) result[name] = Math.max(0, Math.min(1, input[name]));
  }
  if ([10, 15].includes(input.minutes)) result.minutes = input.minutes;
  if (isRecord(input.marks)) {
    for (const [date, marks] of Object.entries(input.marks)) {
      if (isCalendarDate(date) && isRecord(marks)) {
        result.marks[date] = { morning: marks.morning === true, evening: marks.evening === true };
      }
    }
  }
  return result;
}

// Track each finger/key independently. Releasing one contact must not cut off
// another contact on the same note. Hold mode has a separate set of latches.
export class NoteHolds {
  contacts = new Map();
  latched = new Set();
  latchContacts = new Map();
  down(id, index, hold = false) {
    if (id == null || !Number.isInteger(index) || index < 0 || index >= SWARAS.length) return;
    if (hold) {
      this.contacts.delete(id);
      if (this.latchContacts.get(id) === index) return;
      this.latchContacts.set(id, index);
      if (this.latched.has(index)) this.latched.delete(index);
      else this.latched.add(index);
    } else {
      this.latchContacts.delete(id);
      this.contacts.set(id, index);
    }
  }
  up(id) { this.contacts.delete(id); this.latchContacts.delete(id); }
  get active() { return new Set([...this.contacts.values(), ...this.latched]); }
  clear() { this.contacts.clear(); this.latched.clear(); this.latchContacts.clear(); }
}

export class PracticeTimer {
  constructor(minutes = 10, now = Date.now) {
    this.now = now;
    this.minutes = preset(minutes);
    this.reset();
  }
  reset(minutes = this.minutes) {
    this.minutes = preset(minutes);
    this.remaining = this.minutes * 60000;
    this.endAt = null;
    this.state = 'idle';
  }
  start() {
    if (this.state === 'running') return;
    if (this.state === 'complete') this.reset();
    this.endAt = this.now() + this.remaining;
    this.state = 'running';
  }
  tick() {
    if (this.state === 'running') {
      this.remaining = Math.max(0, Math.min(this.remaining, this.endAt - this.now()));
      if (this.remaining === 0) this.state = 'complete';
    }
    return this.remaining;
  }
  pause() {
    this.tick();
    if (this.state === 'running') {
      this.state = 'paused';
      this.endAt = null;
    }
  }
  snapshot() {
    this.tick();
    return { version: 1, minutes: this.minutes, state: this.state, remaining: this.remaining, endAt: this.endAt };
  }
  restore(snapshot) {
    // A corrupt record never starts a timer, and never creates a practice mark.
    this.reset();
    if (!isRecord(snapshot) || snapshot.version !== 1 || ![10, 15].includes(snapshot.minutes)) return this;
    const { minutes, state, remaining, endAt } = snapshot;
    const duration = minutes * 60000;
    if (!isFiniteNumber(remaining) || remaining < 0 || remaining > duration) return this;
    if (state === 'idle') {
      if (remaining !== duration || endAt !== null) return this;
    } else if (state === 'paused') {
      if (remaining === 0 || endAt !== null) return this;
    } else if (state === 'complete') {
      if (remaining !== 0 || !(endAt === null || isFiniteNumber(endAt))) return this;
    } else if (state === 'running') {
      if (remaining === 0 || !isFiniteNumber(endAt)) return this;
      if (endAt - this.now() > remaining) return this;
    } else return this;
    this.minutes = minutes;
    this.state = state;
    this.remaining = remaining;
    this.endAt = endAt;
    this.tick();
    return this;
  }
  static restore(snapshot, now = Date.now) {
    return new PracticeTimer(DEFAULTS.minutes, now).restore(snapshot);
  }
  get display() {
    const seconds = Math.ceil(this.tick() / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
}
