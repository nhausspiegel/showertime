// config.js
// Fill these in after creating a Spotify app at https://developer.spotify.com/dashboard
// See SETUP.md for the full walkthrough.

export const CLIENT_ID = 'YOUR_SPOTIFY_CLIENT_ID';

// Must exactly match a Redirect URI registered in your Spotify app settings.
// For local testing: 'http://127.0.0.1:5500/' (or wherever you're serving this from)
// Once deployed:      'https://<your-username>.github.io/<repo-name>/'
export const REDIRECT_URI = window.location.origin + window.location.pathname;
