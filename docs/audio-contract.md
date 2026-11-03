# HARI sound contract

`dist/audio.mjs` exports `HariAudio`. One instance owns one Web Audio context and
one fully decoded set of the existing recorded samples. No sound begins merely
because loading finishes. No new assets or changed recordings are introduced.

## Controller API

- `await enableBell()` creates/resumes the same context directly in a user gesture,
  without fetching or decoding recordings. Returns `true` if running; rejects on
  unsupported, closed, interrupted or blocked audio. This is sufficient for the
  synthesized finishing bell in a silent practice. It does not make `ready` true.
  A later `enable()` reuses this context and loads the recordings. Neither call
  starts any sound by itself.
- `await enable()` must be called directly in a user gesture. It resumes audio
  before fetching, shares concurrent loads, returns `true` on success, and rejects
  on unsupported audio, failed loading/decoding, a closed context, or an interrupted
  or blocked resume. Failed loads can be retried. Never display sound as playing
  based only on the user's requested state.
- `ready` is a getter: samples decoded **and** context currently running. `context`
  is available for observing state. The engine clears voices on suspension or
  interruption; the controller should clear its own held-key and playing display
  state too. Resume requires an explicit new start; old notes are not restored.
- `noteOn(id, midi, cents=0)` returns whether it started a recorded harmonium voice.
  IDs are independent contacts; repeated IDs do not restart. At most 16 held voices
  are accepted. MIDI must be finite within 0–127, and cents finite within ±100.
- `noteOff(id)` releases just that contact. `voices` is a map of currently held
  contacts, excluding release tails. Keys and accompaniment are independent.
- `setAccompaniment(mode, rootMidi=48, cents=0)` accepts `sa`, `tanpura`, or `silent`.
  It returns `true` if applied, `false` when sound cannot start or pitch is invalid;
  an unknown mode throws. Sa is one continuous recorded harmonium tone at the
  absolute selected pitch. Tanpura follows pitch class, preserving its recorded
  register rather than transposing octaves. Repeating identical settings leaves
  the current source playing. Changes fade between sources over 400 ms. Silence
  fades only accompaniment over 350 ms; it does not silence keyboard contacts.
- `setLevels(volume, droneVolume)` sets overall level and accompaniment balance.
  Finite values are clamped to 0–1; nonfinite values preserve the prior setting.
  Works before enable. Defaults: overall `.48`, balance `.6`.
- `stop()` clears all held contacts and accompaniment immediately in logical state,
  and releases **all** sound, including old fades and bell oscillators, within
  100 ms of running audio time. During suspension/interruption it stops and
  disconnects immediately, without waiting for audio time to advance.
- `bell()` returns `true` when a short three-part synthesized completion bell starts,
  or `false` if the context is not running. Recordings need not be loaded. Repeated
  bells release previous bell voices. The bell is
  routed through the same overall volume; accompaniment balance does not affect it.

## Required async cancellation in the controller

`enable()` and `enableBell()` do not own session intent. A pending
promise can resolve after Stop, key-up, blur, page hiding, or a changed selection.
The controller must invalidate pending starts and check intent **after every
await**, before starting a voice. For example:

```js
let generation = 0;
async function start() {
  const mine = ++generation;
  try {
    await audio.enable();
    if (mine !== generation || document.hidden) return;
    if (!audio.setAccompaniment(settings.accompaniment, rootMidi, settings.cents)) {
      // Clear playing state and report that audio did not start.
    }
  } catch (error) {
    if (mine !== generation) return;
    // Clear playing state and show the actual error.
  }
}
function stopAll() {
  generation++;
  audio.stop();
  // Also clear controller contacts, timers and playing state as appropriate.
}
```

For keyboard contacts waiting on enable, also verify that the individual contact
is still held. Releasing one key must invalidate its own pending start without
canceling unrelated held contacts. Changing settings while loading must use either
a fresh generation or the latest settings when the verified start completes.

## Sound limits and evidence

The preserved prepared harmonium loops span C2 through C5 at selected sampled
notes. Other pitches use the nearest sample with its measured tuning correction;
fine cents are added afterward. The UI's C2–B4 root range is covered by interpolation.
Keyboard notes extending to B5 are transposed above the highest C5 recording and
may sound less natural. This is sample playback, without bellows dynamics.

Tanpura is the previously selected recorded preview. Its nearest pitch-class
transposition is at most six semitones before fine tuning. Varispeed changes pluck
speed and timbre as well as pitch; octave selection does not alter its register.
The manifest and credits retain its source and preview-quality qualification.

Keyboard gain is `.17`. Accompaniment gain is balance × `.4` (default `.24`),
followed by a compressor and overall master. The default accompaniment gain was
raised from `.096` to `.24` to make the single held tone less subordinate to keys;
this is a gain-based judgment, not verified phone loudness. Bass may reproduce
weakly on a small phone speaker. The compressor and moderate defaults are not a
proof that every polyphonic mix, output device, or volume setting cannot clip.

`node tests/audio.test.mjs` checks bell-only setup without sample fetching, later
full sample loading on the same context, graph construction, concurrent loading/retry,
voice independence, fine pitch, bounded held polyphony, accompaniment replacement,
stop/bell lifetimes, interruption recovery, a release fallback for browsers without
`cancelAndHoldAtTime`, and every recorded file's manifest byte count and SHA-256.
These tests use a strict fake Web Audio graph. They do not establish real-browser
autoplay behavior, mobile interruption behavior, seam quality, perceived loudness,
or auditory approval. A real-device listening pass remains separate evidence.
