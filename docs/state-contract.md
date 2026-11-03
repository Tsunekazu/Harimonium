# HARI browser-local state contract

`dist/core.mjs` contains pure state and pitch helpers. It has no audio, storage,
network, practice-marking, or notification side effects. The controller chooses
when to persist settings and the timer snapshot, and catches storage errors.

## Settings

`sanitizeSettings(input)` returns a new object containing only:

| Key | Accepted input | Default |
| --- | --- | --- |
| `root` | Integer 0–11, semitones from C | 0 |
| `octave` | 2, 3, 4 | 3 |
| `cents` | Finite number, clamped to −50…50 | 0 |
| `sound` | `sa`, `tanpura`, `silent` | `sa` |
| `volume` | Finite number, clamped to 0…1 | 0.48 |
| `droneVolume` | Finite number, clamped to 0…1 | 0.6 |
| `minutes` | 10 or 15 | 10 |
| `marks` | Real Gregorian `YYYY-MM-DD` keys with `{ morning, evening }` objects | `{}` |

Only literal `true` creates a true mark. Arrays, impossible dates, unrecognized
properties, numeric strings, and invalid enum values are discarded. Marks use
`localDate()` at the moment of the user's explicit action. No timer action
creates, clears, or migrates a mark. Existing manual marks survive settings
sanitization. These are personal browser-local settings; there is no account.

## Timer

`new PracticeTimer(minutes = 10, now = Date.now)` accepts an injected clock in
milliseconds for tests. Unsupported presets fall back to 10 minutes.

- `state`: `idle`, `running`, `paused`, or `complete`.
- `remaining`: milliseconds left as last sampled, always nonnegative.
- `endAt`: wallclock deadline while running; null while idle or paused. A
  completed running timer retains its original deadline.
- `start()`: starts idle/paused, ignores duplicate Start while running, and
  starts a fresh full preset after completion.
- `pause()`: samples the clock first, then pauses only a still-running timer.
- `reset(minutes = this.minutes)`: discards the old deadline and returns idle.
- `tick()`: samples the wallclock, returns remaining milliseconds, and changes
  running to complete at/past its deadline.
- `display`: samples via `tick()` and returns a rounded-up `MM:SS` string.
- `snapshot()`: samples via `tick()` and returns a JSON-serializable object.
- `restore(snapshot)`: replaces this instance's state and returns this instance.
- `PracticeTimer.restore(snapshot, now = Date.now)`: returns a restored instance.

Snapshot version 1:

```json
{"version":1,"minutes":10,"state":"running","remaining":540000,"endAt":1793700600000}
```

On restore, a running timer derives remaining time from its absolute deadline.
A deadline already passed restores immediately as complete. Paused timers keep
their exact saved remaining time regardless of offline duration. Idle and
complete states roundtrip. Malformed/inconsistent snapshots become clean idle
using the receiver's existing preset (10 minutes for static restore). A future
deadline farther away than its saved remaining time is rejected, preventing
corrupt data or a backward clock jump from extending the saved session.

This is a wallclock timer, not a background alarm. Browser suspension, a closed
tab, silent device, and system clock changes can prevent an on-time sound.
Delayed ticks still show elapsed time correctly. Runtime clock rollback cannot
increase displayed remaining time, but clock changes cannot preserve an exact
real-time guarantee.

The controller must never ring on restore. For a live completion sound, capture
the prior state, call `tick()`, and ring only on `running` → `complete` while
visible, with a recent original `endAt` (for example no more than 15 seconds
late). Persistence or display reads may also complete the timer, so a missed
sound is preferable to replaying a stale completion. Do not automatically mark
Morning or Evening when time expires.

## Notes and pitch

`NoteHolds.down(contactId, swaraIndex, hold = false)` tracks each pointer/key
independently. `up(contactId)` releases only that contact. Sliding the same
contact to another index transfers ownership. Hold mode toggles an independent
latch; repeated down on the same un-released contact does not toggle twice.
Physical ownership keeps a note active even when its latch is removed.
`active` is a copied Set of unique note indices. `clear()` releases all contacts
and latches, including key-repeat bookkeeping. Invalid indices are ignored.

`midiFor(index, root, octave)` gives equal-tempered MIDI pitch for the exported
swara steps. `playbackRate(sample, midi, cents = 0)` compensates
`sample.tuningCents` (zero if absent), then applies selected fine tuning.
`closestSample(samples, midi)` expects a nonempty sample array and resolves
distance ties in original array order. `noteName(midi)` names the MIDI pitch.

Run focused checks with `node --test tests/core.test.mjs` from `hari-app`.
