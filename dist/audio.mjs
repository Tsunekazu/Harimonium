import { closestSample, playbackRate } from './core.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const validPitch = (midi, cents) => Number.isFinite(midi) && midi >= 0 && midi <= 127 && Number.isFinite(cents) && Math.abs(cents) <= 100;

export class HariAudio {
  context = null;
  loading = null;
  samplesReady = false;
  voices = new Map();
  active = new Set();
  accompaniment = null;
  volume = .48;
  droneVolume = .6;

  get ready() { return this.samplesReady && this.context?.state === 'running'; }

  async enableBell() {
    if (!this.context) {
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContext) throw new Error('This browser does not support Web Audio.');
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -12;
      this.compressor.knee.value = 10;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = .003;
      this.compressor.release.value = .2;
      this.compressor.connect(this.master).connect(this.context.destination);
      this.melodyBus = this.context.createGain();
      this.melodyBus.gain.value = .17;
      this.melodyBus.connect(this.compressor);
      this.droneBus = this.context.createGain();
      this.droneBus.gain.value = this.droneVolume * .4;
      this.droneBus.connect(this.compressor);
      // Suspended/interrupted audio must never return as a forgotten held note.
      this.context.addEventListener('statechange', () => {
        if (this.context.state !== 'running') this.stop();
      });
    }
    if (this.context.state === 'closed') throw new Error('Audio has closed. Reload to enable it again.');
    if (this.context.state !== 'running') this.stop();
    // This call must happen inside the user's gesture, before any fetch/await.
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('Audio is paused by the browser. Tap again to enable sound.');
    return true;
  }

  async enable() {
    await this.enableBell();
    if (!this.loading) this.startLoading();
    await this.loading;
    if (!this.ready) throw new Error('Audio was interrupted. Tap again to enable sound.');
    return true;
  }

  startLoading() {
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('The sounds took too long to load. Try again, or choose Silence to practise without them.'));
        controller.abort();
      }, 45_000);
    });
    // Only the winning complete load can publish. A timed-out decoder cannot
    // be cancelled by Web Audio, but its late result stays private to that load.
    const attempt = Promise.race([this.load(controller.signal), deadline]).then(manifest => {
      this.manifest = manifest;
      this.samplesReady = true;
    }).catch(error => {
      controller.abort();
      if (this.loading === attempt) this.loading = null;
      throw error;
    }).finally(() => clearTimeout(timeout));
    this.loading = attempt;
  }

  async load(signal) {
    const response = await fetch('./audio/manifest.json', { signal });
    if (!response.ok) throw new Error('The sound files could not be loaded. Reload while online.');
    const manifest = await response.json();
    if (!Array.isArray(manifest.harmonium) || !manifest.harmonium.length || !manifest.tanpura) {
      throw new Error('The sound manifest is incomplete. Reload while online.');
    }
    if (signal.aborted) throw new Error('Sound loading was cancelled.');
    const entries = [...manifest.harmonium, manifest.tanpura];
    await Promise.all(entries.map(async entry => {
      const file = await fetch(`./${entry.file}`, { signal });
      if (!file.ok) throw new Error('A sound file is missing. Reload while online.');
      const bytes = await file.arrayBuffer();
      if (signal.aborted) throw new Error('Sound loading was cancelled.');
      entry.buffer = await this.context.decodeAudioData(bytes);
    }));
    if (signal.aborted) throw new Error('Sound loading was cancelled.');
    return manifest;
  }

  track(source, gain, envelope) {
    const voice = { source, gain, envelope, releaseEnd: null, ended: false };
    this.active.add(voice);
    source.onended = () => this.dispose(voice);
    return voice;
  }

  dispose(voice) {
    if (voice.ended) return;
    voice.ended = true;
    voice.source.disconnect();
    voice.gain.disconnect();
    this.active.delete(voice);
  }

  source(buffer, rate, bus, attack = .025) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = rate;
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + attack);
    source.connect(gain).connect(bus);
    const voice = this.track(source, gain, time => clamp((time - now) / attack, 0, 1));
    try { source.start(); } catch (error) { this.dispose(voice); throw error; }
    return voice;
  }

  release(voice, seconds = .13) {
    if (!voice || voice.ended) return;
    const now = this.context.currentTime;
    if (this.context.state !== 'running') {
      voice.source.stop();
      this.dispose(voice);
      return;
    }
    if (voice.releaseEnd !== null && voice.releaseEnd <= now + seconds) return;
    const level = voice.envelope(now);
    const param = voice.gain.gain;
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
    else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(level, now);
    }
    param.linearRampToValueAtTime(0, now + seconds);
    voice.envelope = time => level * clamp(1 - (time - now) / seconds, 0, 1);
    voice.releaseEnd = now + seconds;
    voice.source.stop(now + seconds + .02);
  }

  noteOn(id, midi, cents = 0) {
    if (!this.ready || this.voices.has(id) || this.voices.size >= 16 || !validPitch(midi, cents)) return false;
    const sample = closestSample(this.manifest.harmonium, midi + cents / 100);
    const rate = playbackRate(sample, midi) * 2 ** (cents / 1200);
    this.voices.set(id, this.source(sample.buffer, rate, this.melodyBus));
    return true;
  }

  noteOff(id) {
    this.release(this.voices.get(id));
    this.voices.delete(id);
  }

  setAccompaniment(mode, rootMidi = 48, cents = 0) {
    if (!['sa', 'tanpura', 'silent'].includes(mode)) throw new RangeError('Unknown accompaniment mode.');
    if (mode === 'silent') {
      this.release(this.accompaniment, .35);
      this.accompaniment = null;
      return true;
    }
    if (!this.ready || !validPitch(rootMidi, cents)) return false;
    const current = this.accompaniment;
    if (current?.mode === mode && current.rootMidi === rootMidi && current.cents === cents) return true;
    let sample, rate;
    if (mode === 'sa') {
      sample = closestSample(this.manifest.harmonium, rootMidi + cents / 100);
      rate = playbackRate(sample, rootMidi) * 2 ** (cents / 1200);
    } else {
      sample = this.manifest.tanpura;
      // A recorded texture: nearest pitch-class shift, not octave resampling.
      // Varispeed changes pluck speed along with pitch.
      const difference = ((rootMidi - sample.sourcePitchClass) % 12 + 12) % 12;
      const semitones = difference > 6 ? difference - 12 : difference;
      rate = 2 ** ((semitones + cents / 100) / 12);
    }
    const next = this.source(sample.buffer, rate, this.droneBus, .4);
    Object.assign(next, { mode, rootMidi, cents });
    this.release(current, .4);
    this.accompaniment = next;
    return true;
  }

  setLevels(volume, droneVolume) {
    if (Number.isFinite(volume)) this.volume = clamp(volume, 0, 1);
    if (Number.isFinite(droneVolume)) this.droneVolume = clamp(droneVolume, 0, 1);
    if (!this.context || this.context.state === 'closed') return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(this.volume, now, .03);
    this.droneBus.gain.setTargetAtTime(this.droneVolume * .4, now, .05);
  }

  stop() {
    // Include release tails and bell oscillators, not just currently held keys.
    for (const voice of this.active) this.release(voice, .08);
    this.voices.clear();
    this.accompaniment = null;
  }

  bell() {
    if (this.context?.state !== 'running') return false;
    const now = this.context.currentTime;
    // Repeated completion callbacks cannot pile up bell oscillators.
    for (const voice of this.active) if (voice.bell) this.release(voice, .08);
    for (const [frequency, level, length] of [[660, .07, 2.5], [1322, .025, 1.6], [1778, .01, .8]]) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(level, now + .012);
      gain.gain.exponentialRampToValueAtTime(.00001, now + length);
      oscillator.connect(gain).connect(this.compressor);
      const voice = this.track(oscillator, gain, time => time < now + .012
        ? level * clamp((time - now) / .012, 0, 1)
        : level * (.00001 / level) ** clamp((time - now - .012) / (length - .012), 0, 1));
      voice.bell = true;
      try {
        oscillator.start(now);
        oscillator.stop(now + length + .05);
      } catch (error) { this.dispose(voice); throw error; }
    }
    return true;
  }
}
