# Setup

## 1. Create a Spotify app
Go to https://developer.spotify.com/dashboard, log in, and create an app.
- You'll get a **Client ID** — copy it.
- In the app's settings, add a **Redirect URI**. It must exactly match
  wherever you end up hosting this (see below), including trailing slash.

## 2. Fill in config.js
Open `config.js` and paste your Client ID:
```js
export const CLIENT_ID = 'paste-it-here';
```
Leave `REDIRECT_URI` as-is — it's computed automatically from whatever
URL the page is actually loaded from. Just make sure that URL is
registered as a Redirect URI in the Spotify dashboard (step 1).

## 3. Test locally
Spotify requires HTTPS redirect URIs, with one exception: `127.0.0.1`
(not `localhost`) is allowed for local testing. Serve the folder with
something like:
```
python3 -m http.server 5500
```
then open `http://127.0.0.1:5500/`, and register that exact URL as a
Redirect URI.

## 4. Deploy for free
Push this folder to a GitHub repo, then enable **GitHub Pages** in the
repo settings (Settings → Pages → deploy from the main branch). You'll
get a URL like `https://<you>.github.io/<repo>/` — register that as a
Redirect URI too, and use it going forward.

## 5. Add to your iPhone
Open the deployed URL in Safari, tap Share → **Add to Home Screen**.

## One thing worth knowing
Spotify has its own "Autoplay" feature that can start playing similar
songs after a queue finishes. If it's on, playback might continue a
little past your timer's target duration. Turning off Autoplay once in
the Spotify app's settings avoids this entirely — no need to build
around it.

## Account requirements
You'll need Spotify Premium — both for remote playback control and
because Spotify now requires the developer of an app (that's you) to
have Premium even in Development Mode.
