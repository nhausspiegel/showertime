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
  loadSpinner: document.getElementById('load-spinner'),
  nowPlaying: document.getElementById('now-playing'),
  nowPlayingArtist: document.getElementById('now-playing-artist'),
  albumArt: document.getElementById('album-art'),
  trackTime: document.getElementById('track-time'),
  queueToggle: document.getElementById('queue-toggle'),
  queuePanel: document.getElementById('queue-panel'),
  queueList: document.getElementById('queue-list'),
  queueTotal: document.getElementById('queue-total'),
  countdown: document.getElementById('countdown'),
  elapsed: document.getElementById('elapsed'),
  totalTime: document.getElementById('total-time'),
  progressBar: document.getElementById('progress-bar'),
  skipBtn: document.getElementById('skip-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  pauseBtn: document.getElementById('pause-btn'),
  adjustNotice: document.getElementById('adjust-notice'),
};

// The live queue is one ordered array: tracks[0..currentIdx-1] have passed
// (see `outcomes`), tracks[currentIdx] is playing, the rest are upcoming.
// Recalc and skip only ever rewrite the upcoming slice, so history stays put.
let pool = null; // { short, medium, long } — raw lists, kept so indexes rebuild without refetching
let fullIndex = null; // subset-sum index over the whole pool
let availableIndex = null; // ...over only the tracks that haven't played this session
let deviceId = null;
let session = null; // see makeSession()
let track = null; // { id, durationSec, progressSec, at } — last poll of the current track
let queueConfirmed = false; // has a poll yet reported one of our own tracks playing?
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

/** Short vibration on a control press. No-op on browsers without the Vibration
 *  API (notably iOS Safari), so it's always safe to call. */
function haptic(ms = 10) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { navigator.vibrate(ms); } catch (e) { /* ignore */ }
  }
}

/** Spinner-in-place on a button while an async action runs. */
function setBusy(el, on) {
  el.classList.toggle('busy', on);
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
  els.loadSpinner.hidden = false;

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
  } finally {
    els.loadSpinner.hidden = true;
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

// A cache is only usable if it carries album art — older caches predate the
// `art` field, and without it the live view can't show art until the first
// poll. Treat an art-less cache as needing a (one-time) refresh.
function cacheHasArt(cached) {
  return !!(cached && cached.short && cached.short[0] && 'art' in cached.short[0]);
}

/**
 * Builds the pool + matcher index, preferring a fresh-enough cache over the
 * network so reloading is idempotent and can't retrigger Spotify's rate
 * limit. Falls back to a stale cache (rather than erroring) if a refresh
 * attempt fails, e.g. mid rate-limit.
 */
async function buildPoolAndIndex() {
  const cached = loadLibraryCache();
  const fresh = cached && cacheHasArt(cached) && (Date.now() - cached.cachedAt < LIBRARY_CACHE_TTL_MS);

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

function claim(ids) {
  for (const id of ids) usedTrackIds.add(id);
  saveUsedTrackIds();
}

function release(ids) {
  for (const id of ids) usedTrackIds.delete(id);
  saveUsedTrackIds();
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

/** Preload album art so the live view shows it instantly, not after a poll. */
function preloadArt(tracks) {
  if (typeof Image === 'undefined') return;
  for (const t of tracks) {
    if (t.art) { const img = new Image(); img.src = t.art; }
  }
}

// --- Session -------------------------------------------------------------

function makeSession(ordered, totalSeconds) {
  return {
    tracks: ordered,        // [...history, current, ...upcoming]
    currentIdx: 0,          // index of the track playing now
    outcomes: {},           // id -> { played:true } | { skippedAfterSec:n } for passed tracks
    currentProgressSec: 0,  // last observed progress of the current track
    totalSeconds,           // the timer length — the fixed queue total, never recomputed
    endAt: Date.now() + totalSeconds * 1000,
    paused: false,
    pausedAt: null,
    lastRecalcAt: Date.now(), // suppress drift recalc while playback stabilizes
  };
}

function upcomingTracks() {
  return session ? session.tracks.slice(session.currentIdx + 1) : [];
}

/** Cancelling early shouldn't burn tracks that never actually played — only
 *  the current track and history are kept claimed. */
function releaseUnplayedTracks() {
  if (!session) return;
  const from = queueConfirmed ? session.currentIdx + 1 : 0;
  release(session.tracks.slice(from).map((t) => t.id));
  rebuildIndexesSoon();
}

/** Marks tracks passed over (naturally finished or skipped) with an outcome,
 *  then advances the current pointer and re-renders the queue. */
function advanceCurrentTo(newIdx) {
  for (let j = session.currentIdx; j < newIdx; j++) {
    const t = session.tracks[j];
    if (session.outcomes[t.id]) continue;
    if (j === session.currentIdx) {
      // The one we were actually watching: played out if its last seen progress
      // reached (near) the end, otherwise skipped partway.
      const played = session.currentProgressSec;
      session.outcomes[t.id] = played >= t.durationSec - 8
        ? { played: true }
        : { skippedAfterSec: Math.max(0, played) };
    } else {
      session.outcomes[t.id] = { skippedAfterSec: 0 }; // jumped clean over — never heard
    }
  }
  session.currentIdx = newIdx;
  renderQueue();
}

// The music was solved to end exactly when the timer does. Skipping a track
// (or seeking, or replaying) breaks that: the queued songs no longer sum to
// the time left. These bounds re-solve the upcoming tracks when they've
// drifted apart.
const DRIFT_THRESHOLD_SEC = 10; // below this is normal poll jitter and rounding — leave it
const RECALC_COOLDOWN_MS = 8000; // let a re-queue reach the device before checking again

/**
 * Re-solves the upcoming tracks to fill `targetSec` and re-queues them behind
 * the current song. Returns the new upcoming array, or null if nothing changed.
 * `force` re-issues playback even when the tail is unchanged — needed for skip,
 * where the head itself moved and the device must actually jump to it.
 */
async function requeueUpcoming(targetSec, positionMs, { force = false } = {}) {
  const idx = session.currentIdx;
  const current = session.tracks[idx];
  const oldUpcoming = session.tracks.slice(idx + 1);

  const picked = targetSec > 0 ? pickCombo(targetSec) : null;
  const excluded = new Set(session.tracks.slice(0, idx + 1).map((t) => t.id));
  const newUpcoming = (picked ? shuffle(picked.combo.tracks) : []).filter((t) => !excluded.has(t.id));

  const same = oldUpcoming.length === newUpcoming.length &&
    oldUpcoming.every((t, i) => t.id === newUpcoming[i].id);
  if (same && !force) return null;

  const keepIds = new Set(newUpcoming.map((t) => t.id));
  // Dropped, never-played tracks are freed for a later timer; claim the new set.
  release(oldUpcoming.filter((t) => !keepIds.has(t.id) && !session.outcomes[t.id]).map((t) => t.id));
  claim(newUpcoming.map((t) => t.id));

  session.tracks = session.tracks.slice(0, idx + 1).concat(newUpcoming);
  session.lastRecalcAt = Date.now();

  await spotify.playTracks([current.uri, ...newUpcoming.map((t) => t.uri)], deviceId, { positionMs });
  renderQueue();
  rebuildIndexesSoon();
  return newUpcoming;
}

/**
 * Keeps the music ending with the timer. Called from the now-playing poll with
 * the track Spotify says is playing. If the remaining music has drifted from
 * the remaining time by more than the threshold, re-solves the upcoming tracks.
 */
async function maybeRecalcQueue(item, progressMs) {
  if (!session || session.paused) return;
  if (drag) return; // don't rebuild the queue out from under an in-progress drag
  if (Date.now() - (session.lastRecalcAt || 0) < RECALC_COOLDOWN_MS) return;

  const idx = session.currentIdx;
  const current = session.tracks[idx];
  if (!current || current.id !== item.id) return; // not cleanly on the current track — leave it

  const currentRemainSec = Math.max(0, current.durationSec - Math.round(progressMs / 1000));
  const tailSec = session.tracks.slice(idx + 1).reduce((n, t) => n + t.durationSec, 0);
  const remainingMusic = currentRemainSec + tailSec;
  const remainingTimer = Math.max(0, (session.endAt - Date.now()) / 1000);
  if (Math.abs(remainingMusic - remainingTimer) <= DRIFT_THRESHOLD_SEC) return;

  try {
    const changed = await requeueUpcoming(Math.round(remainingTimer - currentRemainSec), Math.max(0, progressMs));
    if (changed === null) session.lastRecalcAt = Date.now(); // same solve — bank cooldown, no blip
  } catch (e) {
    console.error(e); // leave the display alone if the re-queue didn't take
  }
}

els.connectBtn.addEventListener('click', () => { haptic(); auth.connect(); });

function setQueueOpen(open) {
  els.queuePanel.classList.toggle('open', open);
  els.queueTotal.hidden = !open;
  els.queueToggle.setAttribute('aria-expanded', String(open));
  els.queueToggle.textContent = open ? 'Hide queue' : 'Queue';
}

els.queueToggle.addEventListener('click', () => {
  haptic();
  setQueueOpen(!els.queuePanel.classList.contains('open'));
});

els.startBtn.addEventListener('click', async () => {
  primeAudio();
  haptic();
  const { valid, totalSeconds: targetSeconds } = durationSeconds();
  if (!valid) return;

  const picked = pickCombo(targetSeconds);
  if (!picked) {
    els.statusText.textContent = 'Even your shortest song is longer than that — try a bigger timer.';
    return;
  }
  const { combo, reused } = picked;

  startBusy = true;
  setBusy(els.startBtn, true);
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
    setBusy(els.startBtn, false);
    syncStartEnabled();
    return;
  }
  deviceId = active.id;

  const ordered = shuffle(combo.tracks);
  preloadArt(ordered); // download art in parallel with the play request

  try {
    await spotify.setRepeatOff(deviceId).catch(() => {});
    await spotify.setShuffleOff(deviceId).catch(() => {});
    await spotify.playTracks(ordered.map((t) => t.uri), deviceId);
  } catch (e) {
    console.error(e);
    els.statusText.textContent = 'Could not start playback — try again.';
    startBusy = false;
    setBusy(els.startBtn, false);
    syncStartEnabled();
    return;
  }

  session = makeSession(ordered, combo.seconds);
  queueConfirmed = false;
  claim(ordered.map((t) => t.id));

  renderAdjustNotice(combo, targetSeconds, reused);

  els.pauseBtn.classList.remove('is-paused');
  els.pauseBtn.setAttribute('aria-label', 'Pause');
  els.totalTime.textContent = fmt(session.totalSeconds);
  startBusy = false;
  setBusy(els.startBtn, false);
  syncStartEnabled();

  // Show the first queued track immediately. The player-state poll is
  // eventually consistent and reports the *previous* track for the first few
  // seconds after Start, so trusting it here would flash stale data. We know
  // what we queued — render it, and let refreshNowPlaying() confirm.
  renderQueue();
  renderNowPlaying(ordered[0], 0);
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
  els.elapsed.textContent = fmt(session.totalSeconds - remaining);
  const pct = 100 * (1 - remaining / session.totalSeconds);
  els.progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (remaining <= 0) finishSession();
}

/** Resets the track clock and the now-playing row to empty. */
function clearNowPlaying() {
  track = null;
  els.nowPlaying.textContent = '';
  els.nowPlayingArtist.textContent = '';
  els.trackTime.textContent = '';
  els.albumArt.hidden = true;
}

/** Normalizes a currently-playing API item to the shape pool tracks use. */
function trackFromApiItem(item) {
  return {
    id: item.id,
    name: item.name,
    artist: item.artists?.[0]?.name || '',
    durationSec: Math.round(item.duration_ms / 1000),
    art: item.album?.images?.[item.album.images.length - 1]?.url || '',
  };
}

/** Renders one track into the now-playing row. Shared by the optimistic
 *  render at Start and the confirmed render from the poll. */
function renderNowPlaying(t, progressSec) {
  els.nowPlaying.textContent = t.name;
  els.nowPlayingArtist.textContent = t.artist;
  els.albumArt.hidden = !t.art;
  if (t.art) els.albumArt.src = t.art;
  track = { id: t.id, durationSec: t.durationSec, progressSec, at: Date.now() };
  updateTrackTime();
}

async function refreshNowPlaying() {
  if (skipActive) return; // a skip is coalescing; the device lags the model, so its report is stale
  try {
    const playing = await spotify.getCurrentlyPlaying();
    const item = playing?.item;

    if (!item) {
      // Before the queue is confirmed, an empty player is just the gap between
      // our play request and Spotify reporting it — keep the optimistic row.
      // After confirmation it means playback actually stopped.
      if (queueConfirmed) clearNowPlaying();
      return;
    }

    const reportedIdx = session ? session.tracks.findIndex((t) => t.id === item.id) : -1;
    const isOurs = reportedIdx >= 0;

    // Until our own queue shows up, ignore whatever Spotify reports: its
    // player state lags, so the first polls after Start still name the
    // previously playing track. The optimistic render already shows ours.
    if (!isOurs && !queueConfirmed) return;

    const progressSec = Math.round((playing.progress_ms || 0) / 1000);

    if (isOurs) {
      queueConfirmed = true;
      if (reportedIdx > session.currentIdx) {
        advanceCurrentTo(reportedIdx);
      } else if (reportedIdx < session.currentIdx) {
        // The device is still catching up to an optimistic skip — ignore this
        // stale report rather than snapping the model (and the row) backward.
        return;
      }
      session.currentProgressSec = progressSec;
    }

    renderNowPlaying(trackFromApiItem(item), progressSec);

    if (isOurs) await maybeRecalcQueue(item, playing.progress_ms || 0);
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
  els.trackTime.textContent = `${fmt(currentInterpProgressSec())} / ${fmt(track.durationSec)}`;
}

/** Current track progress in seconds, interpolated between polls. */
function currentInterpProgressSec() {
  if (!track) return 0;
  const elapsed = (Date.now() - track.at) / 1000;
  return Math.min(track.durationSec, track.progressSec + elapsed);
}

const GRIP_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 5.5h11M2.5 10.5h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 12h10l1-12"/></svg>';

function renderQueue() {
  els.queueList.replaceChildren();
  if (!session) return;

  session.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.dataset.trackId = t.id;
    const isCurrent = i === session.currentIdx;
    const isPast = i < session.currentIdx;
    const isUpcoming = i > session.currentIdx;
    if (isCurrent) li.classList.add('current');
    if (isPast) li.classList.add('played');
    if (isUpcoming) li.classList.add('upcoming');

    // Row content sits above a red swipe-to-delete layer; only upcoming rows
    // get the swipe layer, a real drag grip, and a delete affordance.
    const content = document.createElement('div');
    content.className = 'row-content';

    const grip = document.createElement('span');
    grip.className = 'grip';
    if (isUpcoming) grip.innerHTML = GRIP_SVG;

    const title = document.createElement('span');
    title.className = 'queue-title';
    title.textContent = t.name;
    const artist = document.createElement('span');
    artist.className = 'queue-artist';
    artist.textContent = ` — ${t.artist}`;
    title.append(artist);

    const dur = document.createElement('span');
    dur.className = 'queue-duration';
    const outcome = session.outcomes[t.id];
    if (isPast && outcome && outcome.skippedAfterSec != null) {
      // A skipped track shows the time it actually played, so the visible rows
      // still reconcile to the fixed total even after an early skip.
      dur.textContent = outcome.skippedAfterSec > 0 ? `skipped ${fmt(outcome.skippedAfterSec)}` : 'skipped';
      li.classList.add('skipped');
    } else {
      dur.textContent = fmt(t.durationSec);
    }

    content.append(grip, title, dur);

    if (isUpcoming) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'queue-delete';
      del.dataset.trackId = t.id;
      del.setAttribute('aria-label', `Remove ${t.name} from queue`);
      del.innerHTML = X_SVG;
      content.append(del);

      const bg = document.createElement('div');
      bg.className = 'swipe-bg';
      bg.innerHTML = TRASH_SVG;
      li.append(bg);
    }

    li.append(content);
    els.queueList.append(li);
  });

  els.queueTotal.replaceChildren();
  const label = document.createElement('span');
  label.textContent = `${session.tracks.length} tracks`;
  const total = document.createElement('span');
  total.textContent = fmt(session.totalSeconds); // fixed timer length — never recomputed
  els.queueTotal.append(label, total);
}

function finishSession() {
  stopLiveUpdates();
  session = null;
  track = null;
  playChime();
  haptic([12, 60, 12]);
  showScreen('home');
}

// --- Skip ----------------------------------------------------------------

// Skip advances the model instantly on every tap, so rapid taps are never
// swallowed by an in-flight request (the old bug: the button was disabled
// mid-re-queue, dropping taps ~1 in 10). The device re-queue is coalesced —
// it fires once, shortly after the taps settle, and jumps straight to the
// final track.
const SKIP_COALESCE_MS = 300;
let skipActive = false; // a skip is coalescing — the device lags the model, so ignore polls
let skipToken = 0;      // guards against an older coalesced re-queue resolving late
let skipTimer = null;

els.skipBtn.addEventListener('click', skipCurrent);

function skipCurrent() {
  if (!session || session.paused) return;
  const idx = session.currentIdx;
  const current = session.tracks[idx];
  if (!current) return;
  haptic(12);

  // Record the skip so the queue shows "skipped M:SS" for it.
  session.outcomes[current.id] = { skippedAfterSec: Math.min(current.durationSec, Math.round(currentInterpProgressSec())) };
  session.currentProgressSec = 0;
  track = null;

  let nextCurrent = session.tracks[idx + 1];
  if (!nextCurrent) {
    // Skipped past the last queued track — solve a fresh set to advance into.
    const remainingTimer = Math.max(0, (session.endAt - Date.now()) / 1000);
    const picked = remainingTimer > 1 ? pickCombo(Math.round(remainingTimer)) : null;
    const existing = new Set(session.tracks.map((t) => t.id));
    const fresh = picked ? shuffle(picked.combo.tracks).filter((t) => !existing.has(t.id)) : [];
    if (fresh.length === 0) { renderQueue(); return; } // nothing left to play — let the timer run out
    claim(fresh.map((t) => t.id));
    session.tracks = session.tracks.slice(0, idx + 1).concat(fresh);
    nextCurrent = fresh[0];
  }

  session.currentIdx = idx + 1;
  renderQueue();
  renderNowPlaying(nextCurrent, 0);
  scheduleSkipRequeue();
}

function scheduleSkipRequeue() {
  skipActive = true;
  const myToken = ++skipToken;
  clearTimeout(skipTimer);
  skipTimer = setTimeout(async () => {
    if (myToken !== skipToken || !session || session.paused) return;
    const current = session.tracks[session.currentIdx];
    if (!current) { skipActive = false; return; }
    const remainingTimer = Math.max(0, (session.endAt - Date.now()) / 1000);
    session.lastRecalcAt = Date.now();
    try {
      await requeueUpcoming(Math.round(remainingTimer - current.durationSec), 0, { force: true });
    } catch (e) {
      console.error(e);
    } finally {
      if (myToken === skipToken) skipActive = false; // only the newest re-queue clears the guard
    }
  }, SKIP_COALESCE_MS);
}

/** Runs an async action with a spinner on `btn`, restoring it after. */
async function setBusyDuring(btn, fn) {
  setBusy(btn, true);
  try { return await fn(); }
  finally { setBusy(btn, false); }
}

// --- Delete a track from the queue --------------------------------------

/**
 * Removes an upcoming track and re-solves only the tracks after it, so the
 * music still ends with the timer. The tracks between the current one and the
 * deleted one are left as-is (per "recalculate the songs after the deleted
 * one"). The deleted track stays claimed so it won't reappear this session.
 */
async function deleteTrack(trackId) {
  if (!session) return;
  const p = session.tracks.findIndex((t) => t.id === trackId);
  if (p <= session.currentIdx) return; // only upcoming tracks are deletable

  const current = session.tracks[session.currentIdx];
  const kept = session.tracks.slice(0, p); // history + current + upcoming before the deleted track
  const deleted = session.tracks[p];
  const oldAfter = session.tracks.slice(p + 1);

  const currentRemain = Math.max(0, current.durationSec - Math.round(currentInterpProgressSec()));
  const keptUpcomingSec = kept.slice(session.currentIdx + 1).reduce((n, t) => n + t.durationSec, 0);
  const remainingTimer = Math.max(0, (session.endAt - Date.now()) / 1000);
  const target = Math.round(remainingTimer - currentRemain - keptUpcomingSec);

  const picked = target > 0 ? pickCombo(target) : null;
  const excluded = new Set([...kept.map((t) => t.id), deleted.id]);
  const newAfter = (picked ? shuffle(picked.combo.tracks) : []).filter((t) => !excluded.has(t.id));

  const keepIds = new Set(newAfter.map((t) => t.id));
  release(oldAfter.filter((t) => !keepIds.has(t.id) && !session.outcomes[t.id]).map((t) => t.id));
  claim(newAfter.map((t) => t.id));

  session.tracks = kept.concat(newAfter);
  session.lastRecalcAt = Date.now();
  renderQueue();

  try {
    const upcoming = session.tracks.slice(session.currentIdx + 1);
    await spotify.playTracks([current.uri, ...upcoming.map((t) => t.uri)], deviceId, {
      positionMs: Math.round(currentInterpProgressSec() * 1000),
    });
  } catch (e) {
    console.error(e);
  }
  rebuildIndexesSoon();
}

// The hover-reveal × on desktop.
els.queueList.addEventListener('click', (e) => {
  const del = e.target.closest('.queue-delete');
  if (!del) return;
  haptic(10);
  deleteTrack(del.dataset.trackId);
});

// --- Reorder (drag) and delete (swipe) upcoming tracks ------------------

let drag = null;

// One pointerdown entry point: the grip starts a reorder drag; a touch on the
// row body starts a swipe-to-delete. The × button is a plain click (above).
els.queueList.addEventListener('pointerdown', (e) => {
  if (!session || e.target.closest('.queue-delete')) return;
  const li = e.target.closest('li');
  if (!li || !li.classList.contains('upcoming')) return;
  if (e.target.closest('.grip')) startDrag(e, li);
  else if (e.pointerType !== 'mouse') startSwipe(e, li);
});

function startDrag(e, li) {
  const rows = [...els.queueList.querySelectorAll('li.upcoming')];
  const fromPos = rows.indexOf(li);
  if (fromPos < 0) return;

  e.preventDefault();
  const rowH = li.getBoundingClientRect().height;
  drag = { li, rows, fromPos, toPos: fromPos, startY: e.clientY, rowH, pointerId: e.pointerId };
  li.setPointerCapture(e.pointerId);
  li.classList.add('dragging');
  haptic(8);
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(e) {
  if (!drag) return;
  const dy = e.clientY - drag.startY;
  drag.li.style.transform = `translateY(${dy}px) scale(1.015)`;

  const toPos = Math.max(0, Math.min(drag.rows.length - 1, drag.fromPos + Math.round(dy / drag.rowH)));
  if (toPos === drag.toPos) return;
  drag.toPos = toPos;
  haptic(4);
  // Slide the other upcoming rows to open a gap at the target slot.
  drag.rows.forEach((row, i) => {
    if (row === drag.li) return;
    let shift = 0;
    if (drag.fromPos < toPos && i > drag.fromPos && i <= toPos) shift = -drag.rowH;
    else if (drag.fromPos > toPos && i >= toPos && i < drag.fromPos) shift = drag.rowH;
    row.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

async function onDragEnd() {
  if (!drag) return;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  const { li, fromPos, toPos, rows } = drag;
  li.classList.remove('dragging');
  for (const r of rows) r.style.transform = '';
  drag = null;

  if (fromPos === toPos || !session) return;

  // Reorder the upcoming slice; history + current are untouched.
  const start = session.currentIdx + 1;
  const upcoming = session.tracks.slice(start);
  const [moved] = upcoming.splice(fromPos, 1);
  upcoming.splice(toPos, 0, moved);
  session.tracks = session.tracks.slice(0, start).concat(upcoming);
  session.lastRecalcAt = Date.now(); // durations are unchanged, so no refit — just keep drift off our backs
  renderQueue();

  const current = session.tracks[session.currentIdx];
  try {
    await spotify.playTracks([current.uri, ...upcoming.map((t) => t.uri)], deviceId, {
      positionMs: Math.round(currentInterpProgressSec() * 1000),
    });
  } catch (e) {
    console.error(e);
  }
}

// Swipe an upcoming row left past a threshold to delete it. The row-content
// has `touch-action: pan-y`, so vertical drags scroll the panel natively and
// only horizontal drags reach us (a vertical scroll fires pointercancel).
const SWIPE_DELETE_PX = 80;
let swipe = null;

function startSwipe(e, li) {
  swipe = { li, content: li.querySelector('.row-content'), id: li.dataset.trackId, startX: e.clientX };
  window.addEventListener('pointermove', onSwipeMove);
  window.addEventListener('pointerup', onSwipeEnd);
  window.addEventListener('pointercancel', onSwipeReset);
}

function onSwipeMove(e) {
  if (!swipe) return;
  const dx = Math.min(0, e.clientX - swipe.startX); // left only
  swipe.content.style.transition = 'none';
  swipe.content.style.transform = `translateX(${dx}px)`;
  swipe.li.classList.toggle('will-delete', dx <= -SWIPE_DELETE_PX);
}

function onSwipeEnd(e) {
  if (!swipe) return;
  const commit = (e.clientX - swipe.startX) <= -SWIPE_DELETE_PX;
  const { li, content, id } = swipe;
  detachSwipe();
  content.style.transition = '';
  if (commit) {
    haptic(12);
    deleteTrack(id); // re-renders the queue, dropping this row
  } else {
    content.style.transform = ''; // spring back
    li.classList.remove('will-delete');
  }
}

function onSwipeReset() {
  if (!swipe) return;
  const { content, li } = swipe;
  detachSwipe();
  content.style.transition = '';
  content.style.transform = '';
  li.classList.remove('will-delete');
}

function detachSwipe() {
  window.removeEventListener('pointermove', onSwipeMove);
  window.removeEventListener('pointerup', onSwipeEnd);
  window.removeEventListener('pointercancel', onSwipeReset);
  swipe = null;
}

els.cancelBtn.addEventListener('click', async () => {
  haptic(12);
  stopLiveUpdates();
  releaseUnplayedTracks();
  try { await spotify.pausePlayback(deviceId); } catch (e) { /* ignore */ }
  session = null;
  track = null;
  showScreen('home');
});

els.pauseBtn.addEventListener('click', async () => {
  if (!session) return;
  haptic();
  session.paused = !session.paused;
  els.pauseBtn.classList.toggle('is-paused', session.paused);
  els.pauseBtn.setAttribute('aria-label', session.paused ? 'Resume' : 'Pause');

  if (session.paused) {
    clearTimeout(tickHandle);
    session.pausedAt = Date.now();
    // freeze the per-track clock by banking the elapsed time so far
    if (track) {
      track.progressSec = currentInterpProgressSec();
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
    await setBusyDuring(els.pauseBtn, () =>
      session.paused ? spotify.pausePlayback(deviceId) : spotify.resumePlayback(deviceId));
  } catch (e) {
    console.error(e);
  }
});

init();
