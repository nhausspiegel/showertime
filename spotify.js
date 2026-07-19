// spotify.js
// Thin wrapper around the handful of Spotify Web API calls this app needs.

import { getAccessToken } from './auth.js';

const BASE = 'https://api.spotify.com/v1';

async function api(path, options = {}) {
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
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spotify API ${res.status} on ${path}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Fetches the user's top tracks for one time range, paginating until the
 * response comes back empty (rather than assuming a fixed page cap).
 */
export async function fetchTopTracks(timeRange, { pageSize = 50, hardCap = 1000 } = {}) {
  const out = [];
  let offset = 0;
  while (out.length < hardCap) {
    const page = await api(
      `/me/top/tracks?time_range=${timeRange}&limit=${pageSize}&offset=${offset}`
    );
    const items = page?.items || [];
    if (items.length === 0) break;
    for (const t of items) {
      out.push({ id: t.id, uri: t.uri, name: t.name, artist: t.artists?.[0]?.name || '', durationSec: Math.round(t.duration_ms / 1000) });
    }
    if (items.length < pageSize) break; // short page = last page
    offset += pageSize;
  }
  return out;
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
