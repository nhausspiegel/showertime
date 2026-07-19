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
  countdown: document.getElementById('countdown'),
  progressBar: document.getElementById('progress-bar'),
  cancelBtn: document.getElementById('cancel-btn'),
  pauseBtn: document.getElementById('pause-btn'),
  adjustNotice: document.getElementById('adjust-notice'),
};

let index = null;
let deviceId = null;
let session = null; // { tracks, totalSeconds, endAt, paused, pausedAt }
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
  showScreen('live');
  startLiveUpdates();
});

function startLiveUpdates() {
  stopLiveUpdates();
  tickHandle = setInterval(() => {
    if (!session || session.paused) return;
    updateCountdown();
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
    els.nowPlaying.textContent = item ? `${item.name} — ${item.artists?.[0]?.name || ''}` : '';
  } catch (e) {
    // non-fatal — live view keeps running off the local countdown
  }
}

function finishSession() {
  stopLiveUpdates();
  session = null;
  playChime();
  showScreen('home');
}

els.cancelBtn.addEventListener('click', async () => {
  stopLiveUpdates();
  try { await spotify.pausePlayback(deviceId); } catch (e) { /* ignore */ }
  session = null;
  showScreen('home');
});

els.pauseBtn.addEventListener('click', async () => {
  if (!session) return;
  session.paused = !session.paused;
  els.pauseBtn.textContent = session.paused ? 'Resume' : 'Pause';

  if (session.paused) {
    session.pausedAt = Date.now();
  } else if (session.pausedAt) {
    session.endAt += Date.now() - session.pausedAt;
    session.pausedAt = null;
    updateCountdown();
  }

  try {
    if (session.paused) await spotify.pausePlayback(deviceId);
    else await spotify.resumePlayback(deviceId);
  } catch (e) {
    console.error(e);
  }
});

init();
