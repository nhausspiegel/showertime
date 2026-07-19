// spotify.js
// Thin wrapper around the handful of Spotify Web API calls this app needs.

import { getAccessToken } from './auth.js';

const BASE = 'https://api.spotify.com/v1';

const MAX_RETRY_WAIT_SEC = 30;
const MAX_429_RETRIES = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options = {}, retriesLeft = MAX_429_RETRIES) {
  const token = await getAccessToken();
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null; // no content, e.g. pause/play/seek

  if (res.status === 429) {
    if (retriesLeft <= 0) {
      const err = new Error(`Spotify API 429 on ${path}: rate limited, retries exhausted`);
      err.status = 429;
      throw err;
    }
    const retryAfterSec = Math.min(
      MAX_RETRY_WAIT_SEC,
      parseInt(res.headers.get('Retry-After') || '1', 10) || 1
    );
    await sleep(retryAfterSec * 1000);
    return api(path, options, retriesLeft - 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Spotify API ${res.status} on ${path}: ${text}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Fetches the user's top tracks for one time range. `/me/top/tracks` never
 * returns more than 50 items regardless of how large the user's history is,
 * so a single request covers the full list — no pagination needed.
 */
export async function fetchTopTracks(timeRange, { limit = 50 } = {}) {
  const page = await api(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`);
  const items = page?.items || [];
  return items.map((t) => ({
    id: t.id,
    uri: t.uri,
    name: t.name,
    artist: t.artists?.[0]?.name || '',
    durationSec: Math.round(t.duration_ms / 1000),
  }));
}

export async function getDevices() {
  const json = await api('/me/player/devices');
  return json?.devices || [];
}

export async function playTracks(uris, deviceId) {
  const qs = deviceId ? `?device_id=${deviceId}` : '';
  await api(`/me/player/play${qs}`, {
    method: 'PUT',
    body: JSON.stringify({ uris }),
  });
}

export async function pausePlayback(deviceId) {
  const qs = deviceId ? `?device_id=${deviceId}` : '';
  await api(`/me/player/pause${qs}`, { method: 'PUT' });
}

export async function resumePlayback(deviceId) {
  const qs = deviceId ? `?device_id=${deviceId}` : '';
  await api(`/me/player/play${qs}`, { method: 'PUT' });
}

export async function setRepeatOff(deviceId) {
  const qs = deviceId ? `?device_id=${deviceId}` : '';
  await api(`/me/player/repeat?state=off${deviceId ? '&device_id=' + deviceId : ''}`, {
    method: 'PUT',
  });
}

export async function getCurrentlyPlaying() {
  return api('/me/player/currently-playing');
}
