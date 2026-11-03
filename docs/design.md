# Hari interface

Hari is a small daily instrument for repeating Hari-Hari with a sustained Sa,
tanpura, or silence. The practice action starts both the selected sound and a
10 or 15 minute timer. Morning and evening marks remain explicit actions.

## Design plan

- Case: deep plum `#302632`; recessed surfaces: `#241c26`.
- Text: pale `#faf5ec`; harmonium keys: `#e8e3d5`.
- Brass controls: `#c6ad77`; secondary text: `#c5b9c7`.
- Georgia gives Hari and swara names a quiet, familiar voice. System UI type
  makes controls readable without downloading fonts.
- One centered instrument, with Hari as the focal point. Time is immediately
  below it, smaller. Sound choices, pitch, and volume form a compact control
  area; morning/evening marks are below the practice controls. Keyboard and
  fine tuning open only when requested.

```text
                Stop sound
                  Hari
                10:00
              10 min  15 min
          [ Begin 10 minutes ] Reset
        One tone | Tanpura | Silence
          Lower pitch  C3  Higher pitch
               Hear tone
            Volume —————
          Today         date
        [Morning] [Evening]
        Recent days / More sound controls
        Play harmonium
```

The brief's plum and brass palette is intentionally retained. The visual
hierarchy changes from a keyboard-led study to a single daily action. There are
no marketing panels, decorative labels, targets, streaks, or generated teachings.
Stop sound stays in a sticky top strip while scrolling. All core actions have
44px minimum touch targets. Narrow layouts retain the same order.

## Controller contract

`dist/app.mjs` owns runtime state, sound, marks, storage, and installation.
The HTML supplies all controller IDs, `.preset[data-minutes]` and
`.sound-choice[data-sound]` buttons, and `aria-pressed` initial states.
`[hidden]` always removes an element from display. The timer output is silent to
screen readers during ticks; `timer-announcement` supplies event announcements.
The controller can populate `keys` and `recent-days`, and toggle the hidden
session-return, install, and update buttons.

## Verification boundary

HTML contracts and source structure can be checked locally. A real phone
visual check, keyboard/screen reader check, and audio audition are still needed;
source review alone cannot establish how the instrument looks or sounds there.
