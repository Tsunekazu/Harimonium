import { SWARAS, midiFor, noteName, localDate, sanitizeSettings, NoteHolds, PracticeTimer } from './core.mjs';
import { HariAudio } from './audio.mjs';
import { ScreenAwake } from './wake.mjs';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'hari-settings-v1';
const TIMER_KEY = 'hari-timer-v1';
const SHORTCUTS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k'];
const SOUND_NAMES = { sa: 'One steady Sa', tanpura: 'Tanpura', silent: 'Silence' };

function readStored(key) {
  try { return JSON.parse(localStorage.getItem(key)); }
  catch { $('storage-status').textContent = 'Saved settings could not be read. New marks may only last for this visit.'; return null; }
}
let settings = sanitizeSettings(readStored(SETTINGS_KEY) ?? readStored('hari-study-v1'));
const timer = new PracticeTimer(settings.minutes).restore(readStored(TIMER_KEY));
if (timer.state !== 'idle') settings.minutes = timer.minutes;
const audio = new HariAudio();
const holds = new NoteHolds();
const unsavedMarks = new Map();
let generation = 0;
let pending = null;
let toneOn = false;
let holdMode = false;
let keyboardReady = false;
let needsResume = timer.state === 'running';
let visibleDate = '';
let contextObserved = false;
let bellEligible = false;
let completionHandled = timer.state === 'complete';
let updateWorker = null;
let installPrompt = null;
let buttonKeyboardActivation = false;
let accessibleContact = 0;
let requestedUpdate = false;
let reloadReady = false;
const awake = new ScreenAwake(navigator, document, text => { $('wake-status').textContent = text; });

function mergeUnsavedMarks() {
  for (const [date, changes] of unsavedMarks) {
    settings.marks[date] = { morning: false, evening: false, ...settings.marks[date], ...changes };
  }
}
function refreshStoredMarks() {
  const stored = readStored(SETTINGS_KEY);
  if (stored) settings.marks = sanitizeSettings(stored).marks;
  mergeUnsavedMarks();
}
function persist() {
  const snapshot = timer.snapshot();
  handleCompletion();
  refreshStoredMarks();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    unsavedMarks.clear();
    localStorage.setItem(TIMER_KEY, JSON.stringify(snapshot));
    $('storage-status').textContent = 'Your practice marks are saved on this device.';
  } catch { $('storage-status').textContent = 'Storage is unavailable. These marks will only last for this visit.'; }
}
function rootMidi() { return midiFor(0, settings.root, settings.octave); }
function setStatus(text) { $('sound-status').textContent = text; }
function sounding() { return toneOn || audio.voices.size > 0; }
function updateAwake() { awake.setWanted(timer.state === 'running' || sounding()); }
function isCurrent(ticket) { return ticket !== null && ticket === generation && !document.hidden; }

const keyButtons = SWARAS.map((swara, index) => {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'key'; button.dataset.index = String(index); button.disabled = true;
  const name = document.createElement('span'); name.className = 'swara'; name.textContent = swara;
  const pitch = document.createElement('span'); pitch.className = 'pitch';
  const shortcut = document.createElement('span'); shortcut.className = 'shortcut'; shortcut.textContent = SHORTCUTS[index].toUpperCase();
  button.append(name, pitch, shortcut); $('keys').append(button); return button;
});

function renderSound() {
  const midi = rootMidi();
  $('pitch-value').textContent = noteName(midi);
  $('pitch-down').disabled = midi <= 36; $('pitch-up').disabled = midi >= 71;
  $('volume').value = Math.round(settings.volume * 100);
  $('volume-value').textContent = `${Math.round(settings.volume * 100)}%`;
  $('drone-volume').value = Math.round(settings.droneVolume * 100);
  $('drone-volume-value').textContent = `${Math.round(settings.droneVolume * 100)}%`;
  $('cents').value = settings.cents;
  $('cents-value').textContent = `${settings.cents > 0 ? '+' : ''}${settings.cents} cents`;
  document.querySelectorAll('.sound-choice').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sound === settings.sound)));
  $('preview').disabled = settings.sound === 'silent' && !toneOn;
  $('preview').textContent = toneOn ? 'Stop tone' : 'Hear tone';
  $('preview').setAttribute('aria-pressed', String(toneOn));
  $('session-return').hidden = !needsResume;
  $('session-return').textContent = settings.sound === 'silent' ? 'Enable finishing bell' : 'Resume sound';
  keyButtons.forEach((button, index) => {
    const pitch = noteName(midiFor(index, settings.root, settings.octave));
    button.querySelector('.pitch').textContent = pitch;
    button.setAttribute('aria-label', `${SWARAS[index]}, ${pitch}`);
    button.disabled = !keyboardReady;
  });
}
function renderKeys() {
  const active = holds.active;
  keyButtons.forEach((button, index) => {
    button.classList.toggle('active', active.has(index) && audio.voices.has(index));
    if (holdMode) button.setAttribute('aria-pressed', String(active.has(index) && audio.voices.has(index)));
    else button.removeAttribute('aria-pressed');
  });
}
function syncKeys() {
  const active = holds.active;
  for (const id of [...audio.voices.keys()]) if (!active.has(id)) audio.noteOff(id);
  for (const index of active) audio.noteOn(index, midiFor(index, settings.root, settings.octave), settings.cents);
  renderKeys(); updateAwake();
}
function clearKeys() {
  holds.clear();
  for (const id of [...audio.voices.keys()]) audio.noteOff(id);
  renderKeys(); updateAwake();
}
function invalidateStarts() { generation++; pending = null; }
function stopAllSound(message = '') {
  invalidateStarts(); holds.clear(); audio.stop(); toneOn = false; needsResume = false; bellEligible = false;
  renderKeys(); renderSound(); renderTimer(); updateAwake();
  if (message) setStatus(message);
}
function observeContext() {
  if (contextObserved || !audio.context) return;
  contextObserved = true;
  audio.context.addEventListener('statechange', () => {
    if (audio.context.state === 'running') return;
    const hadActivity = sounding() || timer.state === 'running';
    invalidateStarts(); holds.clear(); toneOn = false; keyboardReady = false;
    needsResume = hadActivity && timer.state === 'running'; bellEligible = false;
    $('enable-keys').hidden = false;
    renderKeys(); renderSound(); renderTimer(); updateAwake();
    if (hadActivity && !document.hidden) setStatus('Sound was interrupted. Tap Resume sound or Begin to continue.');
  });
}
async function activate(action) {
  const mine = ++generation; pending = action;
  setStatus(audio.ready ? '' : 'Preparing the sounds…'); renderTimer();
  try {
    await audio.enable(); observeContext();
    if (!isCurrent(mine)) return null;
    audio.setLevels(settings.volume, settings.droneVolume);
    keyboardReady = true; $('enable-keys').hidden = true;
    return mine;
  } catch (error) {
    if (mine === generation) {
      setStatus(error.message || 'Sound could not start. Tap Begin to try again.');
      needsResume = timer.state === 'running';
    }
    return null;
  } finally { if (mine === generation) { pending = null; renderSound(); renderTimer(); } }
}
function startSelectedSound() {
  const started = audio.setAccompaniment(settings.sound, rootMidi(), settings.cents);
  toneOn = started && settings.sound !== 'silent';
  if (!started) throw new Error('Sound is paused by the browser. Tap Begin to try again.');
  renderSound(); updateAwake();
}
function currentSoundDescription() {
  return settings.sound === 'silent'
    ? (bellEligible ? 'A quiet session. A soft bell will mark the time.' : 'A quiet session. Your timer is running.')
    : `${SOUND_NAMES[settings.sound]} is sounding. Repeat at your own pace.`;
}
async function beginPractice() {
  if (pending) return;
  if (timer.state === 'running') {
    timer.pause(); stopAllSound('Paused. Continue when you’re ready.');
    persist(); renderTimer(); return;
  }
  if (settings.sound === 'silent') {
    stopAllSound();
    const mine = generation;
    // The timer works even without Web Audio or downloaded recordings.
    const bellReady = audio.enableBell();
    timer.start(); completionHandled = false; bellEligible = false;
    $('timer-announcement').textContent = '';
    setStatus(currentSoundDescription()); persist(); renderTimer(); updateAwake();
    try {
      await bellReady; observeContext();
      if (isCurrent(mine) && timer.state === 'running') { bellEligible = true; setStatus(currentSoundDescription()); }
    } catch {
      if (isCurrent(mine) && timer.state === 'running') setStatus('Your quiet timer is running. The finishing bell is unavailable.');
    }
    return;
  }
  const ticket = await activate('practice');
  if (!isCurrent(ticket)) return;
  try {
    startSelectedSound(); timer.start(); completionHandled = false; bellEligible = true; needsResume = false;
    $('timer-announcement').textContent = '';
    setStatus(currentSoundDescription()); persist(); renderTimer(); updateAwake();
  } catch (error) { setStatus(error.message); }
}
$('timer-start').addEventListener('click', beginPractice);
$('timer-reset').addEventListener('click', () => {
  if (timer.state === 'running') return;
  timer.reset(settings.minutes); completionHandled = false; bellEligible = false; stopAllSound('Ready when you are.');
  $('timer-announcement').textContent = ''; persist(); renderTimer();
});
$('stop').addEventListener('click', () => stopAllSound(timer.state === 'running' ? 'Sound stopped. Your timer continues silently, without a finishing bell.' : 'Sound stopped.'));
$('preview').addEventListener('click', async () => {
  if (toneOn || pending) {
    invalidateStarts(); audio.setAccompaniment('silent', rootMidi(), settings.cents); toneOn = false;
    renderSound(); renderTimer(); updateAwake();
    setStatus(timer.state === 'running' ? 'The tone is off. Your timer is still running.' : 'The tone is off.'); return;
  }
  const ticket = await activate('preview');
  if (!isCurrent(ticket)) return;
  try {
    startSelectedSound();
    if (timer.state === 'running') {
      needsResume = false; bellEligible = true; renderSound(); setStatus(currentSoundDescription());
    } else setStatus('Find a comfortable pitch for your voice.');
  }
  catch (error) { setStatus(error.message); }
});
$('session-return').addEventListener('click', async () => {
  if (settings.sound === 'silent') {
    const mine = ++generation;
    try {
      await audio.enableBell(); observeContext();
      if (isCurrent(mine) && timer.state === 'running') {
        bellEligible = true; needsResume = false; renderSound(); setStatus(currentSoundDescription());
      }
    } catch {
      if (isCurrent(mine)) setStatus('Your quiet timer is running. The finishing bell is unavailable.');
    }
    return;
  }
  const ticket = await activate('resume');
  if (!isCurrent(ticket)) return;
  try {
    if (timer.state === 'running') {
      startSelectedSound(); bellEligible = true; needsResume = false; renderSound(); setStatus(currentSoundDescription());
    }
  } catch (error) { setStatus(error.message); }
});
$('enable-keys').addEventListener('click', async () => {
  const ticket = await activate('keyboard');
  if (isCurrent(ticket)) setStatus('The harmonium keys are ready.');
});

function tickTimer() {
  timer.tick();
  if (handleCompletion()) persist();
}
function handleCompletion() {
  if (timer.state === 'complete' && !completionHandled) {
    completionHandled = true;
    if (bellEligible && !document.hidden && Date.now() - timer.endAt <= 2000) audio.bell();
    bellEligible = false; needsResume = false;
    $('timer-announcement').textContent = 'Your practice time is complete. You can continue or mark your practice below.';
    setStatus('Your time is complete. Continue as you like.');
    renderSound(); updateAwake();
    return true;
  }
  return false;
}
function renderTimer() {
  const seconds = Math.ceil(timer.remaining / 1000);
  $('countdown').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('timer-state').textContent = { idle: 'A little time with the Name', running: 'Repeat at your own pace', paused: 'Paused', complete: 'Time complete' }[timer.state];
  $('practice-stage').dataset.state = timer.state;
  $('timer-start').disabled = pending !== null;
  $('timer-start').textContent = pending === 'practice' ? 'Preparing…' : timer.state === 'running' ? 'Pause' : timer.state === 'paused' ? 'Resume practice' : timer.state === 'complete' ? 'Begin again' : `Begin ${settings.minutes} minutes`;
  $('timer-reset').hidden = timer.state === 'running' || (timer.state === 'idle' && pending !== 'practice');
  document.querySelectorAll('.preset').forEach(button => {
    button.disabled = timer.state === 'running' || timer.state === 'paused' || pending === 'practice';
    button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) === settings.minutes));
  });
}
document.querySelectorAll('.preset').forEach(button => button.addEventListener('click', () => {
  if (timer.state === 'running' || timer.state === 'paused' || pending) return;
  settings.minutes = Number(button.dataset.minutes); timer.reset(settings.minutes); completionHandled = false; bellEligible = false;
  persist(); renderTimer();
}));
document.querySelectorAll('.sound-choice').forEach(button => button.addEventListener('click', async () => {
  const startingPractice = pending === 'practice';
  const shouldPlay = toneOn || timer.state === 'running' || pending === 'preview';
  invalidateStarts();
  settings.sound = button.dataset.sound;
  if (settings.sound === 'silent') {
    audio.setAccompaniment('silent', rootMidi(), settings.cents); toneOn = false;
    if (timer.state === 'running') setStatus(currentSoundDescription());
    else setStatus('Silence selected. Begin when you’re ready.');
    updateAwake();
  }
  persist(); renderSound(); renderTimer();
  if (startingPractice) { await beginPractice(); return; }
  if (shouldPlay && settings.sound !== 'silent') {
    const ticket = await activate('sound');
    if (!isCurrent(ticket)) return;
    try {
      startSelectedSound();
      if (timer.state === 'running') { bellEligible = true; needsResume = false; renderSound(); }
      setStatus(currentSoundDescription());
    } catch (error) { setStatus(error.message); }
  }
}));
function retune(midi = rootMidi()) {
  settings.root = midi % 12; settings.octave = Math.floor(midi / 12) - 1;
  clearKeys();
  if (toneOn && audio.ready) startSelectedSound();
  persist(); renderSound();
}
$('pitch-down').addEventListener('click', () => retune(Math.max(36, rootMidi() - 1)));
$('pitch-up').addEventListener('click', () => retune(Math.min(71, rootMidi() + 1)));
$('cents').addEventListener('input', () => { settings.cents = Number($('cents').value); retune(); });
for (const id of ['volume', 'drone-volume']) $(id).addEventListener('input', () => {
  settings.volume = Number($('volume').value) / 100; settings.droneVolume = Number($('drone-volume').value) / 100;
  audio.setLevels(settings.volume, settings.droneVolume); persist(); renderSound();
});

function keyDown(id, index) {
  if (!audio.ready) {
    keyboardReady = false; $('enable-keys').hidden = false;
    setStatus('Tap Enable keys to wake the instrument.'); renderSound(); return;
  }
  holds.down(id, index, holdMode); syncKeys();
}
function keyUp(id) { holds.up(id); syncKeys(); }
$('keys').addEventListener('pointerdown', event => {
  const button = event.target.closest('.key');
  if (!button || button.disabled || event.button !== 0) return;
  event.preventDefault(); button.setPointerCapture(event.pointerId);
  keyDown(`pointer-${event.pointerId}`, Number(button.dataset.index));
});
$('keys').addEventListener('pointermove', event => {
  const id = `pointer-${event.pointerId}`;
  if (holdMode || !holds.contacts.has(id)) return;
  const button = document.elementFromPoint(event.clientX, event.clientY)?.closest('.key');
  if (button && Number(button.dataset.index) !== holds.contacts.get(id)) keyDown(id, Number(button.dataset.index));
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) $('keys').addEventListener(eventName, event => keyUp(`pointer-${event.pointerId}`));
$('hold').addEventListener('click', () => {
  holdMode = !holdMode; clearKeys(); $('hold').setAttribute('aria-pressed', String(holdMode));
  $('hold-hint').textContent = holdMode ? 'Tap a key to hold it. Tap again to release.' : 'Hold a key to play. Several keys can sound together.';
});
$('keyboard-panel').addEventListener('toggle', () => { if (!$('keyboard-panel').open) clearKeys(); });
document.addEventListener('keydown', event => {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable || !$('keyboard-panel').open) return;
  const index = SHORTCUTS.indexOf(event.key.toLowerCase());
  if (index >= 0) { event.preventDefault(); keyDown(`key-${index}`, index); }
  else if ([' ', 'Enter'].includes(event.key) && event.target.matches('.key')) {
    event.preventDefault(); buttonKeyboardActivation = true;
    keyDown(`button-${event.key}`, Number(event.target.dataset.index));
  }
});
document.addEventListener('keyup', event => {
  const index = SHORTCUTS.indexOf(event.key.toLowerCase());
  if (index >= 0) keyUp(`key-${index}`);
  if ([' ', 'Enter'].includes(event.key)) {
    if (event.target.matches('.key')) event.preventDefault(); keyUp(`button-${event.key}`);
    setTimeout(() => { buttonKeyboardActivation = false; }, 0);
  }
});
$('keys').addEventListener('click', event => {
  const button = event.target.closest('.key');
  if (event.detail !== 0 || buttonKeyboardActivation || !button || button.disabled) return;
  const id = `accessible-${++accessibleContact}`;
  keyDown(id, Number(button.dataset.index));
  if (holdMode) keyUp(id); else setTimeout(() => keyUp(id), 700);
});

function renderMarks() {
  visibleDate = localDate(); $('today-date').dateTime = visibleDate;
  $('today-date').textContent = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  for (const period of ['morning', 'evening']) $(period).setAttribute('aria-pressed', String(settings.marks[visibleDate]?.[period] === true));
  $('recent-days').replaceChildren();
  for (let offset = 1; offset <= 7; offset++) {
    const date = new Date(); date.setDate(date.getDate() - offset);
    const record = settings.marks[localDate(date)] || {};
    const row = document.createElement('div'); row.className = 'history-row';
    for (const text of [date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), `Morning ${record.morning ? '✓' : '—'}`, `Evening ${record.evening ? '✓' : '—'}`]) {
      const span = document.createElement('span'); span.textContent = text; row.append(span);
    }
    $('recent-days').append(row);
  }
}
for (const period of ['morning', 'evening']) $(period).addEventListener('click', () => {
  refreshStoredMarks();
  const date = localDate(); const old = settings.marks[date] || { morning: false, evening: false };
  settings.marks[date] = { ...old, [period]: !old[period] };
  unsavedMarks.set(date, { ...unsavedMarks.get(date), [period]: !old[period] });
  persist(); renderMarks();
});
window.addEventListener('storage', event => {
  if (event.key !== SETTINGS_KEY) return;
  settings.marks = sanitizeSettings(readStored(SETTINGS_KEY)).marks; mergeUnsavedMarks(); renderMarks();
});
window.addEventListener('blur', () => {
  if (pending) { invalidateStarts(); renderTimer(); }
  clearKeys();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    tickTimer(); stopAllSound(); needsResume = timer.state === 'running'; bellEligible = false; persist();
  } else {
    tickTimer();
    if (timer.state === 'running') { needsResume = true; setStatus('Your timer kept running. Resume sound when you’re ready.'); }
    renderMarks();
  }
  renderTimer(); renderSound(); awake.refresh();
});
window.addEventListener('pagehide', () => { tickTimer(); stopAllSound(); persist(); });
setInterval(() => { tickTimer(); renderTimer(); if (visibleDate !== localDate()) renderMarks(); }, 250);

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt; installPrompt = null; $('install').hidden = true;
  try { await prompt.prompt(); await prompt.userChoice; } catch { /* Browser owns installation UI. */ }
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('install').hidden = true; });
function practiceBusy() { return timer.state === 'running' || timer.state === 'paused' || sounding() || pending; }
$('update').addEventListener('click', () => {
  if (timer.state === 'running' || timer.state === 'paused') { setStatus('Finish your practice, or pause and reset it, before updating.'); return; }
  if (sounding() || pending) { setStatus('Stop sound before updating.'); return; }
  if (reloadReady) { location.reload(); return; }
  if (!updateWorker || requestedUpdate) return;
  requestedUpdate = true; $('update').disabled = true; $('update').textContent = 'Applying update…';
  updateWorker.postMessage({ type: 'ACTIVATE_UPDATE' });
});
async function setupOffline() {
  if (!('serviceWorker' in navigator) || !globalThis.isSecureContext) { $('offline-status').textContent = 'Open the HTTPS app link for offline use.'; return; }
  $('offline-status').textContent = 'Saving for offline use…';
  // Cover register/ready as well as the worker reply: ready can remain pending.
  let timeout = setTimeout(() => { $('offline-status').textContent = 'Offline readiness has not been confirmed. Reopen while connected.'; }, 15000);
  const reportOffline = text => { clearTimeout(timeout); $('offline-status').textContent = text; };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!requestedUpdate) return;
    if (!practiceBusy()) { location.reload(); return; }
    // A session may have begun since Update was tapped. Keep it undisturbed.
    requestedUpdate = false; reloadReady = true; updateWorker = null;
    $('update').disabled = false; $('update').hidden = false; $('update').textContent = 'Reload update';
    setStatus('The update is saved. Reload after your practice.');
  });
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    const offerUpdate = () => {
      if (registration.waiting && navigator.serviceWorker.controller) { updateWorker = registration.waiting; $('update').hidden = false; }
    };
    offerUpdate();
    const watchInstall = worker => {
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') offerUpdate();
        if (worker.state === 'redundant' && !registration.active) reportOffline('Offline save did not finish. Reopen while connected.');
      });
    };
    watchInstall(registration.installing);
    registration.addEventListener('updatefound', () => watchInstall(registration.installing));
    const ready = await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    clearTimeout(timeout);
    timeout = setTimeout(() => { $('offline-status').textContent = 'Offline readiness has not been confirmed.'; channel.port1.close(); }, 20000);
    channel.port1.onmessage = event => {
      channel.port1.close();
      reportOffline(event.data?.ready ? 'Available offline' : 'Offline save did not finish.');
    };
    ready.active?.postMessage({ type: 'OFFLINE_STATUS' }, [channel.port2]);
  } catch { reportOffline('Offline save did not finish. Reopen while connected.'); }
}
audio.setLevels(settings.volume, settings.droneVolume);
renderSound(); renderTimer(); renderMarks(); renderKeys(); updateAwake();
setStatus(needsResume ? 'Your timer is still running. Tap Resume sound to continue.' : 'One quiet tone, if you want it.');
setupOffline();
