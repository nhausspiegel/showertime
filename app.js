import * as auth from './auth.js';
import * as spotify from './spotify.js';
import { buildIndex, findCombo, shuffle } from './matcher.js';
import { VERSION, DEPLOYED_AT } from './version.js';

const els = {
  connectScreen: document.getElementById('connect-screen'),
  homeScreen: document.getElementById('home-screen'),
  liveScreen: document.getElementById('live-screen'),
  connectBtn: document.getElementById('connect-btn'),
  durationInput: document.getElementById('duration'),
  startBtn: document.getElementById('start-btn'),
  statusText: document.getElementById('status-text'),
  nowPlaying: document.getElementById('now-playing'),
  albumArt: document.getElementById('album-art'),
  trackTime: document.getElementById('track-time'),
  queueToggle: document.getElementById('queue-toggle'),
  queuePanel: document.getElementById('queue-panel'),
  queueList: document.getElementById('queue-list'),
  queueTotal: document.getElementById('queue-total'),
  countdown: document.getElementById('countdown'),
  progressBar: document.getElementById('progress-bar'),
  cancelBtn: document.getElementById('cancel-btn'),
  pauseBtn: document.getElementById('pause-btn'),
  adjustNotice: document.getElementById('adjust-notice'),
};

let pool = null; // { short, medium, long } — raw lists, kept so indexes rebuild without refetching
let fullIndex = null; // subset-sum index over the whole pool
let availableIndex = null; // ...over only the tracks that haven't played this session
let deviceId = null;
let session = null; // { tracks, totalSeconds, endAt, paused, pausedAt }
let track = null; // { id, durationSec, progressSec, at } — last poll of the current track
let playedIds = new Set(); // ids from the current session Spotify actually reached
let pollHandle = null;
let tickHandle = null;
let audioCtx = null;
let libraryReady = false;
let startBusy = false;

function primeAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playChime() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [ [880, 0], [660, 0.15] ].forEach(([freq, delay]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + delay);
    gain.gain.setValueAtTime(0, now + delay);
    gain.gain.linearRampToValueAtTime(0.3, now + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.6);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + delay);
    osc.stop(now + delay + 0.6);
  });
}

// Every id referenced above must exist in index.html. Without this check a
// renamed/removed id yields a null that only explodes later, somewhere
// unrelated — this fails at load with the offending key named instead.
const missingEls = Object.entries(els).filter(([, el]) => !el).map(([k]) => k);
if (missingEls.length) {
  throw new Error(`index.html is missing element(s) for: ${missingEls.join(', ')}`);
}

// Add a screen by adding its <section> id here — showScreen() needs no edit.
const SCREENS = {
  connect: els.connectScreen,
  home: els.homeScreen,
  live: els.liveScreen,
};

function showScreen(name) {
  if (!SCREENS[name]) throw new Error(`Unknown screen: ${name}`);
  for (const [key, el] of Object.entries(SCREENS)) {
    el.hidden = key !== name;
  }
}

// Floor, not round: callers own the rounding decision, and every caller here
// is displaying either an already-rounded integer or an elapsed counter (which
// should read 0:00 for its whole first second, not flip at the half-second).
function fmt(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Digit-shift duration entry: typing "1234" walks the display through
// 00:01 -> 00:12 -> 01:23 -> 12:34, calculator-style — each new digit pushes
// in from the right, backspace shifts a zero back in from the left. Typing
// stops once 4 digits have been entered (must backspace to edit further).
let durationDigits = '2500'; // MMSS, matches the input's initial "25:00"
let durationTypedCount = 0; // digits typed since the last backspace/clear — caps at 4

/** The committed value, and whether it's a real time. Max is 99:59 = 5999s. */
function durationSeconds() {
  const minutes = parseInt(durationDigits.slice(0, 2), 10);
  const seconds = parseInt(durationDigits.slice(2, 4), 10);
  const totalSeconds = minutes * 60 + seconds;
  return { valid: seconds < 60 && totalSeconds > 0, totalSeconds };
}

// The one choke point every entry path funnels through — typing, backspace,
// paste, and the initial render — so the validity flag can't drift out of
// sync with what's on screen.
function renderDuration() {
  els.durationInput.value = `${durationDigits.slice(0, 2)}:${durationDigits.slice(2, 4)}`;
  const { valid } = durationSeconds();
  els.durationInput.classList.toggle('invalid', !valid);
  els.durationInput.setAttribute('aria-invalid', String(!valid));
  syncStartEnabled();
}

function commitDurationDigits(next) {
  durationDigits = next;
  renderDuration();
}

function typeDurationDigit(d) {
  // Deliberately no per-keystroke validity check. Digit-shift entry has to
  // walk through invalid intermediate states to reach valid ones — typing
  // "0800" goes 25:00 -> 50:00 -> 00:08 -> 00:80 -> 08:00, and rejecting the
  // 00:80 step makes 08:00 (and every time whose third digit is 6-9)
  // unreachable. Invalid *committed* values are flagged in renderDuration()
  // and block Start; they never block input.
  if (durationTypedCount >= 4) return;
  commitDurationDigits((durationDigits + d).slice(-4));
  durationTypedCount++;
}

function backspaceDurationDigit() {
  commitDurationDigits(('0' + durationDigits).slice(0, 4));
  durationTypedCount = Math.max(0, durationTypedCount - 1);
}

function pinCaretToEnd() {
  const len = els.durationInput.value.length;
  els.durationInput.setSelectionRange(len, len);
}

els.durationInput.addEventListener('keydown', (e) => {
  if (e.key >= '0' && e.key <= '9') {
    e.preventDefault();
    typeDurationDigit(e.key);
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    backspaceDurationDigit();
  } else if (e.key !== 'Tab') {
    e.preventDefault();
  }
});

els.durationInput.addEventListener('paste', (e) => {
  e.preventDefault();
  const pasted = (e.clipboardData || window.clipboardData).getData('text');
  for (const ch of pasted.replace(/\D/g, '')) {
    typeDurationDigit(ch);
  }
});

els.durationInput.addEventListener('focus', pinCaretToEnd);
els.durationInput.addEventListener('mousedown', (e) => {
  e.preventDefault();
  els.durationInput.focus();
  pinCaretToEnd();
});

// Three independent reasons Start can be unavailable. Each owns a flag and
// they're combined in one place — writing `disabled` from the call sites
// instead lets whichever ran last win, and the button sticks.
function syncStartEnabled() {
  els.startBtn.disabled = !libraryReady || startBusy || !durationSeconds().valid;
}

renderDuration();

function renderVersionTag() {
  const el = document.getElementById('version-tag');
  if (!el) return;
  el.textContent = DEPLOYED_AT ? `${VERSION} · ${DEPLOYED_AT}` : VERSION;
  el.title = DEPLOYED_AT ? `Deployed ${DEPLOYED_AT}` : 'Local build (not deployed via CI)';
}

async function init() {
  renderVersionTag();
  await auth.handleRedirect().catch((e) => console.error(e));

  if (!auth.isConnected()) {
    showScreen('connect');
    return;
  }

  showScreen('home');
  libraryReady = false;
  syncStartEnabled();
  els.statusText.textContent = 'Loading your library…';

  try {
    const result = await buildPoolAndIndex();
    els.statusText.textContent = result.stale
      ? 'Using your cached library — could not refresh from Spotify just now.'
      : '';
    libraryReady = true;
    syncStartEnabled();
  } catch (e) {
    console.error(e);
    els.statusText.textContent = e.status === 429
      ? 'Spotify is rate-limiting requests — wait a moment, then reload.'
      : 'Could not load your library — try reloading.';
  }
}

const LIBRARY_CACHE_KEY = 'spotify_timer_library_cache';
// Top-tracks lists don't meaningfully shift faster than this — safe to trust
// the cache and skip the network entirely on reload within the window.
const LIBRARY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function loadLibraryCache() {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveLibraryCache(short, medium, long) {
  try {
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify({ short, medium, long, cachedAt: Date.now() }));
  } catch (e) {
    // storage full or unavailable (e.g. private browsing) — non-fatal, just skip caching
  }
}

/**
 * Builds the pool + matcher index, preferring a fresh-enough cache over the
 * network so reloading is idempotent and can't retrigger Spotify's rate
 * limit. Falls back to a stale cache (rather than erroring) if a refresh
 * attempt fails, e.g. mid rate-limit.
 */
async function buildPoolAndIndex() {
  const cached = loadLibraryCache();
  const fresh = cached && (Date.now() - cached.cachedAt < LIBRARY_CACHE_TTL_MS);

  if (fresh) {
    setPool(cached.short, cached.medium, cached.long);
    return { stale: false };
  }

  try {
    // Sequential, not Promise.all — keeps at most one top-tracks request in
    // flight so we don't trip Spotify's rate limit on load.
    const short = await spotify.fetchTopTracks('short_term');
    const medium = await spotify.fetchTopTracks('medium_term');
    const long = await spotify.fetchTopTracks('long_term');
    saveLibraryCache(short, medium, long);
    setPool(short, medium, long);
    return { stale: false };
  } catch (e) {
    if (cached) {
      setPool(cached.short, cached.medium, cached.long);
      return { stale: true };
    }
    throw e;
  }
}

// --- No-repeat memory ----------------------------------------------------
// Tracks already queued this session, so a second timer never replays them.
// sessionStorage rather than localStorage: "session" means this tab, so the
// memory survives reloads and closing the tab is what starts you over.

const USED_TRACKS_KEY = 'spotify_timer_used_tracks';
// How far short of the requested time we'll accept in order to avoid repeats.
// Past this, an exact timer is worth more than a fully fresh queue.
const REPEAT_SLACK_SEC = 30;

let usedTrackIds = loadUsedTrackIds();

function loadUsedTrackIds() {
  try {
    const raw = sessionStorage.getItem(USED_TRACKS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    return new Set();
  }
}

function saveUsedTrackIds() {
  try {
    sessionStorage.setItem(USED_TRACKS_KEY, JSON.stringify([...usedTrackIds]));
  } catch (e) {
    // storage unavailable (private browsing) — non-fatal, the memory just
    // won't survive a reload
  }
}

function setPool(short, medium, long) {
  pool = { short, medium, long };
  rebuildIndexes();
}

function rebuildIndexes() {
  if (!pool) return;
  const unused = (list) => list.filter((t) => !usedTrackIds.has(t.id));
  fullIndex = buildIndex(pool.short, pool.medium, pool.long);
  availableIndex = buildIndex(unused(pool.short), unused(pool.medium), unused(pool.long));
}

// Defer so the DP work lands after the browser has painted the screen
// transition that triggered it, rather than stalling it.
function rebuildIndexesSoon() {
  setTimeout(rebuildIndexes, 0);
}

/**
 * Picks the tracks for a target duration, preferring ones that haven't played
 * yet this session.
 *
 * Strict no-repeat would eventually make some durations unreachable, so it
 * yields once the fresh-only match drifts more than REPEAT_SLACK_SEC off
 * target — but only when repeating actually buys accuracy.
 *
 * @returns {{ combo: object, reused: boolean }|null}
 */
function pickCombo(targetSeconds) {
  const fresh = findCombo(availableIndex, targetSeconds);
  const freshOk = !!fresh && fresh.tracks.length > 0;
  if (freshOk && targetSeconds - fresh.seconds <= REPEAT_SLACK_SEC) {
    return { combo: fresh, reused: false };
  }

  const full = findCombo(fullIndex, targetSeconds);
  const fullOk = !!full && full.tracks.length > 0;
  if (!fullOk) return freshOk ? { combo: fresh, reused: false } : null;
  if (freshOk && fresh.seconds >= full.seconds) return { combo: fresh, reused: false };

  // Report reuse from the actual picks, not from the fact that we consulted
  // the full pool — the wider index often lands on fresh tracks anyway.
  return { combo: full, reused: full.tracks.some((t) => usedTrackIds.has(t.id)) };
}

/** Cancelling early shouldn't burn tracks that never actually played. */
function releaseUnplayedTracks() {
  if (!session) return;
  for (const t of session.tracks) {
    if (!playedIds.has(t.id)) usedTrackIds.delete(t.id);
  }
  saveUsedTrackIds();
  rebuildIndexesSoon();
}

els.connectBtn.addEventListener('click', () => auth.connect());

function setQueueOpen(open) {
  els.queuePanel.hidden = !open;
  els.queueTotal.hidden = !open;
  els.queueToggle.setAttribute('aria-expanded', String(open));
  els.queueToggle.textContent = open ? 'Hide queue' : 'Queue';
}

els.queueToggle.addEventListener('click', () => setQueueOpen(els.queuePanel.hidden));

els.startBtn.addEventListener('click', async () => {
  primeAudio();
  const { valid, totalSeconds: targetSeconds } = durationSeconds();
  if (!valid) return;

  const picked = pickCombo(targetSeconds);
  if (!picked) {
    els.statusText.textContent = 'Even your shortest song is longer than that — try a bigger timer.';
    return;
  }
  const { combo, reused } = picked;

  startBusy = true;
  syncStartEnabled();
  els.statusText.textContent = '';

  let active;
  try {
    const devices = await spotify.getDevices();
    active = devices.find((d) => d.is_active) || devices[0];
  } catch (e) {
    console.error(e);
  }
  if (!active) {
    els.statusText.textContent = 'Open Spotify on your phone, then hit Start again.';
    startBusy = false;
    syncStartEnabled();
    return;
  }
  deviceId = active.id;

  const ordered = shuffle(combo.tracks);

  try {
    await spotify.setRepeatOff(deviceId).catch(() => {});
    await spotify.playTracks(ordered.map((t) => t.uri), deviceId);
  } catch (e) {
    console.error(e);
    els.statusText.textContent = 'Could not start playback — try again.';
    startBusy = false;
    syncStartEnabled();
    return;
  }

  session = {
    tracks: ordered,
    totalSeconds: combo.seconds,
    endAt: Date.now() + combo.seconds * 1000,
    paused: false,
    pausedAt: null,
  };
  playedIds = new Set();

  for (const t of ordered) usedTrackIds.add(t.id);
  saveUsedTrackIds();

  renderAdjustNotice(combo, targetSeconds, reused);

  els.pauseBtn.textContent = 'Pause';
  startBusy = false;
  syncStartEnabled();

  clearNowPlaying();
  renderQueue();
  setQueueOpen(false);

  showScreen('live');
  startLiveUpdates();

  // Next timer's pool has to exclude what we just queued.
  rebuildIndexesSoon();
});

function renderAdjustNotice(combo, targetSeconds, reused) {
  const parts = [];
  if (!combo.exact) {
    parts.push(`Closest match: ${fmt(combo.seconds)} (asked for ${fmt(targetSeconds)})`);
  }
  if (reused) parts.push('Reused songs — running low on new ones.');
  els.adjustNotice.textContent = parts.join(' · ');
  els.adjustNotice.hidden = parts.length === 0;
}

// Fire just past the boundary rather than exactly on it, so a clock read a
// hair early can't display the second we're leaving.
const TICK_EPSILON_MS = 15;

/**
 * Schedules the next countdown tick to land on the next second boundary,
 * recomputed from the wall clock every time.
 *
 * A fixed setInterval(1000) cannot do this: it guarantees *at least* 1000ms,
 * so each tick lands a few ms late and the sampled fraction of a second creeps
 * downward. Whenever it crosses a rounding boundary between two ticks the
 * displayed integer drops by 2 and a number is skipped (0:58 -> 0:56). Driving
 * off the boundary makes every tick self-correcting, so drift can't accumulate.
 */
function scheduleTick() {
  clearTimeout(tickHandle);
  if (!session || session.paused) return;
  const remainingMs = session.endAt - Date.now();
  if (remainingMs <= 0) {
    updateCountdown();
    return;
  }
  const delay = (remainingMs % 1000) || 1000; // when the displayed value next changes
  tickHandle = setTimeout(() => {
    updateCountdown();
    updateTrackTime();
    scheduleTick();
  }, delay + TICK_EPSILON_MS);
}

function startLiveUpdates() {
  stopLiveUpdates();
  pollHandle = setInterval(refreshNowPlaying, 5000);
  document.addEventListener('visibilitychange', onVisibilityChange);
  refreshNowPlaying();
  updateCountdown();
  scheduleTick();
}

function stopLiveUpdates() {
  clearTimeout(tickHandle);
  clearInterval(pollHandle);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

function onVisibilityChange() {
  // Snap the display to the correct value immediately on return and re-anchor
  // the tick — background tabs throttle timers, so the pending one is likely
  // both late and no longer aligned to a second boundary.
  if (document.visibilityState === 'visible' && session && !session.paused) {
    updateCountdown();
    updateTrackTime();
    scheduleTick();
  }
}

function updateCountdown() {
  if (!session) return;
  // Ceil, so the timer reads its starting value for a full second and hits
  // 0:00 exactly at endAt rather than half a second early.
  const remaining = Math.max(0, Math.ceil((session.endAt - Date.now()) / 1000));
  els.countdown.textContent = fmt(remaining);
  const pct = 100 * (1 - remaining / session.totalSeconds);
  els.progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (remaining <= 0) finishSession();
}

/** Resets the track clock and the now-playing row to empty. */
function clearNowPlaying() {
  track = null;
  els.nowPlaying.textContent = '';
  els.trackTime.textContent = '';
  els.albumArt.hidden = true;
}

async function refreshNowPlaying() {
  try {
    const playing = await spotify.getCurrentlyPlaying();
    const item = playing?.item;
    if (!item) {
      clearNowPlaying();
      return;
    }

    els.nowPlaying.textContent = `${item.name} — ${item.artists?.[0]?.name || ''}`;

    // Spotify sorts album images widest-first; the last one is the smallest
    // that still covers our 56px slot at 2x.
    const art = item.album?.images?.[item.album.images.length - 1]?.url;
    els.albumArt.hidden = !art;
    if (art) els.albumArt.src = art;

    // Only count tracks from our own queue: once it runs out Spotify autoplays
    // something unrelated, and this endpoint reports that just the same.
    if (session?.tracks.some((t) => t.id === item.id)) playedIds.add(item.id);

    track = {
      id: item.id,
      durationSec: Math.round(item.duration_ms / 1000),
      progressSec: Math.round((playing.progress_ms || 0) / 1000),
      at: Date.now(),
    };
    updateTrackTime();
    markCurrentInQueue();
  } catch (e) {
    // non-fatal — live view keeps running off the local countdown
  }
}

/**
 * Interpolates between the 5s polls so the per-track clock ticks every second
 * instead of jumping.
 */
function updateTrackTime() {
  if (!track) return;
  const elapsed = (Date.now() - track.at) / 1000;
  const progress = Math.min(track.durationSec, track.progressSec + elapsed);
  els.trackTime.textContent = `${fmt(progress)} / ${fmt(track.durationSec)}`;
}

function renderQueue() {
  els.queueList.replaceChildren();
  if (!session) return;

  for (const t of session.tracks) {
    const li = document.createElement('li');
    li.dataset.trackId = t.id;

    const title = document.createElement('span');
    title.className = 'queue-title';
    title.textContent = t.name;
    const artist = document.createElement('span');
    artist.className = 'queue-artist';
    artist.textContent = ` — ${t.artist}`;
    title.append(artist);

    const dur = document.createElement('span');
    dur.className = 'queue-duration';
    dur.textContent = fmt(t.durationSec);

    li.append(title, dur);
    els.queueList.append(li);
  }

  const sum = session.tracks.reduce((n, t) => n + t.durationSec, 0);
  els.queueTotal.replaceChildren();
  const label = document.createElement('span');
  label.textContent = `${session.tracks.length} tracks`;
  const total = document.createElement('span');
  total.textContent = fmt(sum);
  els.queueTotal.append(label, total);
}

/** Dims tracks already played and highlights the one currently sounding. */
function markCurrentInQueue() {
  let seenCurrent = false;
  for (const li of els.queueList.children) {
    const isCurrent = !!track && li.dataset.trackId === track.id;
    if (isCurrent) seenCurrent = true;
    li.classList.toggle('current', isCurrent);
    li.classList.toggle('played', !isCurrent && !seenCurrent);
  }
}

function finishSession() {
  stopLiveUpdates();
  session = null;
  track = null;
  playChime();
  showScreen('home');
}

els.cancelBtn.addEventListener('click', async () => {
  stopLiveUpdates();
  releaseUnplayedTracks();
  try { await spotify.pausePlayback(deviceId); } catch (e) { /* ignore */ }
  session = null;
  track = null;
  showScreen('home');
});

els.pauseBtn.addEventListener('click', async () => {
  if (!session) return;
  session.paused = !session.paused;
  els.pauseBtn.textContent = session.paused ? 'Resume' : 'Pause';

  if (session.paused) {
    clearTimeout(tickHandle);
    session.pausedAt = Date.now();
    // freeze the per-track clock by banking the elapsed time so far
    if (track) {
      track.progressSec = Math.min(track.durationSec, track.progressSec + (Date.now() - track.at) / 1000);
      track.at = Date.now();
    }
  } else {
    if (session.pausedAt) {
      session.endAt += Date.now() - session.pausedAt;
      session.pausedAt = null;
    }
    if (track) track.at = Date.now();
    updateCountdown();
    updateTrackTime();
    scheduleTick();
  }

  try {
    if (session.paused) await spotify.pausePlayback(deviceId);
    else await spotify.resumePlayback(deviceId);
  } catch (e) {
    console.error(e);
  }
});

init();
