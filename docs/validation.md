# Validation — 4 November 2026

## Implemented artifact

`dist/` contains the first practice-focused app: one held Sa, optional tanpura or
silence, 10/15 minute countdown, manual daily marks, local timer recovery,
screen-awake requests, and an optional eight-note harmonium keyboard with
simultaneous-note and latch handling. Relative asset paths support project-path
hosting. Prepared audio totals about 4.8 MB.

## Automated evidence

All five test files pass, with 75 focused checks in the final review run
(audio 12, controller 23, core 19, offline 13, wake lock 8):

- Core: pitch/sample selection, multiple-contact note ownership and latch
  release, validated settings, local calendar dates, timer transitions and
  persisted recovery.
- Audio: sample loading, all twelve recording hashes, independent voices and
  accompaniment, interruption cleanup, crossfades, level controls, and a
  recording-free finishing bell.
- Controller: actual application code with a DOM model and fake audio/wake
  services. Covers cancelled pending starts, live completion once, expired
  restore without a late bell, silent operation without recordings, local
  marks/storage denial, sound selection/cancellation, unresolved offline setup,
  and update arrival during a session.
- Wake lock: request/release, late results, hidden/visible changes, unavailable
  support and denial, and a stale release/status race.
- Offline: service worker with fake Cache/Fetch APIs. Covers all local assets,
  subpath navigation, failed install without replacing the old cache, scoped
  cleanup, and complete-cache readiness reporting.

All JavaScript syntax and local HTML/manifest/recording references are checked.
These are logic and packaging checks, not an Android test.

## Remaining evidence

The browser access host is unavailable in this session. No rendered browser
layout inspection, real Web Audio audition, multi-touch test, physical wake-lock
test, installed offline relaunch, or full-duration Android practice is claimed.

The earlier 26-second offline sound study had zero clipped samples; it was not
produced by the browser engine. The actual sound still needs to be heard on the
user's device. Looped notes omit natural attack/release, and large transpositions
can sound less natural. Tanpura varispeed changes both pitch and pluck timing.

For the first phone trial, open the HTTPS link and listen to one steady Sa at a
comfortable pitch. A later full session can verify the finishing bell and
screen staying awake. Offline use needs one complete online cache first.

## Final review pass — release 2026-11-04-2

The practice-first layout and the sound recordings/mix are preserved. Review
reproduced and fixed these concrete edge cases:

- Enabling keyboard keys after restoring a timer no longer hides the separate
  sound-resume action. Resuming via Hear tone restores the finishing bell too.
- Manual marks remain reversible when reads succeed but storage writes fail.
  Pending changes merge with another tab's marks and clear after a successful
  save, instead of being replaced by stale storage.
- Returning while a late hidden wake-lock request is releasing no longer loses
  the next visible request. A denial does not cause repeated requests.
- Missing cached app/audio files can repair themselves online. Repair accepts
  only known assets and the same server release, has bounded network waits,
  and keeps online response delivery independent of background cache writes.
- A stalled sound fetch or decoder has a shared 45-second loading deadline;
  retries can proceed, and late decoder results cannot replace a later success.

Small interaction corrections: Stop sound suppresses a later finishing bell;
Reset is available after pausing; update guidance identifies a still-sounding
tone; footer help links have larger touch targets. Regression tests exercise
the failures and recovery paths. They remain simulated browser services and do
not replace physical Android checks.

## Publication state

Published with explicit user approval at
[tsunekazu.github.io/Harimonium](https://tsunekazu.github.io/Harimonium/).
The public source repository is
[Tsunekazu/Harimonium](https://github.com/Tsunekazu/Harimonium).

The first release was verified at deployment commit
`30de02b6ab43b5be5458d29e507343f7a98cd44b`, derived from app source commit
`bbf879d`. HTTPS is enforced. All 26 public app/asset URLs returned HTTP 200;
their bytes matched the local build, including all twelve audio recordings.
JavaScript modules were served with the correct MIME type.

The browser access host remains unavailable. Live HTTP verification confirms
publication and asset integrity, not browser execution or Android installation.

The reviewed release `2026-11-04-2` is now deployed at the same address. GitHub
reported deployment commit `0499fd426e18eab5621d0b28d64d735bbbb3bb59` built,
from app source commit `7262488`. All 26 live app/asset URLs were verified against
the reviewed local files. All twelve recording hashes are identical to the
first published release. The existing app offers this version through its
normal Update Hari action; it does not force an active practice to reload.
