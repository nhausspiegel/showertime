// auth.js
// Spotify OAuth via Authorization Code + PKCE. Fully client-side —
// no server, no client secret. Fill in CLIENT_ID in config.js.

import { CLIENT_ID, REDIRECT_URI } from './config.js';

const SCOPES = [
  'user-top-read',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
].join(' ');

const STORAGE_KEY = 'spotify_timer_auth';
const VERIFIER_KEY = 'spotify_timer_pkce_verifier';

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  return crypto.subtle.digest('SHA-256', data);
}

function randomString(len = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function loadAuth() {
  // Corrupt/partial JSON here would otherwise throw at module load and brick
  // the app permanently — the user can't recover without manually clearing
  // storage in devtools. Treat unreadable auth as "not connected" instead.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('Discarding unreadable auth from localStorage', e);
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function saveAuth(auth) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

export function isConnected() {
  return !!loadAuth();
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Kicks off the redirect to Spotify's authorization page. */
export async function connect() {
  const verifier = randomString(64);
  localStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = base64url(await sha256(verifier));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

/** Call once on page load. If the URL has a ?code=, completes the login. */
export async function handleRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return false;

  const verifier = localStorage.getItem(VERIFIER_KEY);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + (await res.text()));
  const json = await res.json();

  saveAuth({
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  });

  // the verifier is single-use — it's spent now, so don't leave it in storage
  localStorage.removeItem(VERIFIER_KEY);

  // clean the ?code= out of the address bar
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, '', url.pathname);
  return true;
}

async function refresh() {
  const auth = loadAuth();
  if (!auth?.refreshToken) throw new Error('Not connected');

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('Token refresh failed: ' + (await res.text()));
  const json = await res.json();

  saveAuth({
    accessToken: json.access_token,
    // Spotify doesn't always return a new refresh_token — keep the old one if absent
    refreshToken: json.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  });
}

// Single-flight guard for refresh(). Without it, two concurrent callers with
// an expired token both POST the *same* refresh_token; Spotify's PKCE flow
// rotates refresh tokens, so the second response is either an error or a
// token the first caller has already superseded — and refresh()'s
// `json.refresh_token || auth.refreshToken` fallback can then write a dead
// token back to storage, logging the user out at the next expiry.
// Reachable in normal use: hit Pause while the 5s now-playing poll is in
// flight. All callers await the one in-flight refresh instead.
let refreshInFlight = null;

function refreshOnce() {
  if (!refreshInFlight) {
    refreshInFlight = refresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Returns a valid access token, refreshing first if it's expired/near-expiry. */
export async function getAccessToken() {
  let auth = loadAuth();
  if (!auth) throw new Error('Not connected');
  if (Date.now() > auth.expiresAt - 30_000) {
    await refreshOnce();
    auth = loadAuth();
  }
  return auth.accessToken;
}
