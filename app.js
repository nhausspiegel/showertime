import * as auth from './auth.js';
import * as spotify from './spotify.js';
import { buildIndex, findCombo, shuffle } from './matcher.js';

const els = {
  connectScreen: document.getElementById('connect-screen'),
  homeScreen: document.getElementById('home-screen'),
  liveScreen: document.getElementById('live-screen'),
  connectBtn: document.getElementById('connect-btn'),
  minutesInput: document.getElementById('minutes'),
  secondsInput: document.getElementById('seconds'),
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

let index = null;
let deviceId = null;
let session = null; // { tracks, totalSeconds, endAt, paused, pausedAt }
let track = null; // { id, durationSec, progressSec, at } — last poll of the current track
let pollHandle = null;
let tickHandle = null;
let audioCtx = null;

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

function showScreen(name) {
  els.connectScreen.hidden = name !== 'connect';
  els.homeScreen.hidden = name !== 'home';
  els.liveScreen.hidden = name !== 'live';
}

function fmt(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

async function init() {
  await auth.handleRedirect().catch((e) => console.error(e));

  if (!auth.isConnected()) {
    showScreen('connect');
    return;
  }

  showScreen('home');
  els.startBtn.disabled = true;
  els.statusText.textContent = 'Loading your library…';

  try {
    await buildPoolAndIndex();
    els.statusText.textContent = '';
    els.startBtn.disabled = false;
  } catch (e) {
    console.error(e);
    els.statusText.textContent = 'Could not load your library — try reloading.';
  }
}

async function buildPoolAndIndex() {
  const [short, medium, long] = await Promise.all([
    spotify.fetchTopTracks('short_term'),
    spotify.fetchTopTracks('medium_term'),
    spotify.fetchTopTracks('long_term'),
  ]);
  index = buildIndex(short, medium, long);
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
  const minutes = parseInt(els.minutesInput.value || '0', 10);
  const seconds = parseInt(els.secondsInput.value || '0', 10);
  const targetSeconds = minutes * 60 + seconds;
  if (targetSeconds <= 0) return;

  const combo = findCombo(index, targetSeconds);
  if (!combo || combo.tracks.length === 0) {
    els.statusText.textContent = 'Even your shortest song is longer than that — try a bigger timer.';
    return;
  }

  els.startBtn.disabled = true;
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
    els.startBtn.disabled = false;
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
    els.startBtn.disabled = false;
    return;
  }

  session = {
    tracks: ordered,
    totalSeconds: combo.seconds,
    endAt: Date.now() + combo.seconds * 1000,
    paused: false,
    pausedAt: null,
  };

  els.adjustNotice.hidden = combo.exact;
  if (!combo.exact) {
    els.adjustNotice.textContent = `Closest match: ${fmt(combo.seconds)} (asked for ${fmt(targetSeconds)})`;
  }

  els.pauseBtn.textContent = 'Pause';
  els.startBtn.disabled = false;

  track = null;
  els.nowPlaying.textContent = '';
  els.trackTime.textContent = '';
  els.albumArt.hidden = true;
  renderQueue();
  setQueueOpen(false);

  showScreen('live');
  startLiveUpdates();
});

function startLiveUpdates() {
  stopLiveUpdates();
  tickHandle = setInterval(() => {
    if (!session || session.paused) return;
    updateCountdown();
    updateTrackTime();
  }, 1000);

  pollHandle = setInterval(refreshNowPlaying, 5000);
  document.addEventListener('visibilitychange', onVisibilityChange);
  refreshNowPlaying();
  updateCountdown();
}

function stopLiveUpdates() {
  clearInterval(tickHandle);
  clearInterval(pollHandle);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

function onVisibilityChange() {
  // snap the display to the correct value immediately on return, rather than
  // waiting up to 1s for the next tick — matters after the tab/screen was
  // backgrounded and timers were throttled
  if (document.visibilityState === 'visible' && session && !session.paused) {
    updateCountdown();
  }
}

function updateCountdown() {
  if (!session) return;
  const remaining = Math.max(0, Math.round((session.endAt - Date.now()) / 1000));
  els.countdown.textContent = fmt(remaining);
  const pct = 100 * (1 - remaining / session.totalSeconds);
  els.progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (remaining <= 0) finishSession();
}

async function refreshNowPlaying() {
  try {
    const playing = await spotify.getCurrentlyPlaying();
    const item = playing?.item;
    if (!item) {
      track = null;
      els.nowPlaying.textContent = '';
      els.trackTime.textContent = '';
      els.albumArt.hidden = true;
      return;
    }

    els.nowPlaying.textContent = `${item.name} — ${item.artists?.[0]?.name || ''}`;

    // Spotify sorts album images widest-first; the last one is the smallest
    // that still covers our 56px slot at 2x.
    const art = item.album?.images?.[item.album.images.length - 1]?.url;
    els.albumArt.hidden = !art;
    if (art) els.albumArt.src = art;

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
    session.pausedAt = Date.now();
    // freeze the per-track clock by banking the elapsed time so far
    if (track) {
      track.progressSec = Math.min(track.durationSec, track.progressSec + (Date.now() - track.at) / 1000);
      track.at = Date.now();
    }
  } else if (session.pausedAt) {
    session.endAt += Date.now() - session.pausedAt;
    session.pausedAt = null;
    if (track) track.at = Date.now();
    updateCountdown();
    updateTrackTime();
  }

  try {
    if (session.paused) await spotify.pausePlayback(deviceId);
    else await spotify.resumePlayback(deviceId);
  } catch (e) {
    console.error(e);
  }
});

init();
