# Hari

A small instrument for repeating Hari-Hari: one sustained harmonium tone,
tanpura, or silence, with a 10 or 15 minute timer and manual morning/evening
practice marks. A playable harmonium keyboard opens when wanted.

**[Open Hari](https://tsunekazu.github.io/Harimonium/)** in Chrome on your phone.

## Use

Open the hosted app in Android Chrome and tap **Begin**. Use **Lower pitch** or
**Higher pitch** to find a comfortable singing pitch; **Hear tone** lets you
listen first. Silence starts the timer without downloading sound recordings.

Keep the app visible during practice. It asks the browser to keep the screen
awake automatically. Morning and Evening are marks you make yourself; tap again
to undo. Finishing the timer does not mark either practice for you.

Home-screen installation is optional. Use **Install Hari** when offered, or
Chrome's menu → **Install and create shortcut** → **Install**. Wait until the
footer says **Available offline** before expecting to use the complete app
without a connection. [Chrome installation help](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en).

The browser stores settings, the timer, and practice marks locally. There is no
account, analytics, microphone use, or online sync. Clearing site data removes
the saved settings and marks. The web host receives ordinary web requests.

## Run locally

The complete static app is `dist/`; it has no production dependencies or build
step. Serve it with:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

Open `http://127.0.0.1:8765` on the same computer. Android access and installation
need the hosted HTTPS link; the computer's localhost address is not a phone URL.

For development checks, using Node 24:

```sh
npm ci --ignore-scripts
npm test
```

Linkedom is a development dependency only. The tests use fake audio, browser
services, and a DOM model; they are not evidence of phone playback or rendering.

## Hosting

Publish only the contents of `dist/` as a static HTTPS site. All paths are
relative, including the service-worker scope and manifest, so a GitHub Pages
project path works. Keep `.nojekyll` when using branch-based Pages hosting.

Before each changed release, update `VERSION` in `dist/sw.js`. A new version is
offered via **Update Hari**; the app defers reload if practice has begun. Avoid
reusing a cache version for changed files.

The public GitHub repository is separate from the parent research workspace;
personal notes and source conversations are not part of this app package.

## Sound and current limits

The single Sa and keyboard use eleven processed harmonium recordings. Tanpura
uses an acoustic recording's compressed preview, excerpted and looped. All
recordings are bundled, with source and prepared-file hashes in
`dist/audio/manifest.json`. Attribution, licenses, and processing details are in
[About Hari & the sounds](dist/credits.html).

The keyboard uses a major scale in equal temperament, including upper Sa.
Transposition can change the sound's character; this does not implement every
Indian scale or tuning system. Remembered melodies are not implemented.

The timer preserves elapsed time across reloads and interruptions, but sound
resumes only after a tap. It is not a locked-screen alarm. See
[validation](docs/validation.md) for checks and the remaining phone audition.
