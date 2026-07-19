# AGENTS.md

Shower timer that plays a Spotify queue whose track durations sum exactly to
the timer length. Vanilla ES modules, no build step, no dependencies, no tests.
Served as static files; deployed to GitHub Pages by `.github/workflows/deploy.yml`.

## Layout

| File | Holds |
| --- | --- |
| `app.js` | All UI logic: screen gating, duration entry, session lifecycle, polling, queue rendering, chime |
| `auth.js` | Spotify OAuth (Authorization Code + PKCE), token storage/refresh |
| `spotify.js` | Web API wrapper. Every request goes through `api()` |
| `matcher.js` | Subset-sum over track durations — picks the combo that sums to the target |
| `config.js` | `CLIENT_ID`, `REDIRECT_URI` |
| `version.js` | Overwritten by CI at deploy time. Do not hand-edit |

## Hard-won constraints

These are recorded because each one already cost real debugging time. Read
before touching the relevant area.

### Spotify rate limits are brutal and the penalty is not seconds

The window is a rolling 30s, but repeated bursts escalate. Reload-testing this
app once produced a `Retry-After` of **82994 seconds (~23 hours)** — a full-day
lockout on `/me/top/tracks`, unrecoverable by waiting a few minutes.

Consequences for any change you make:

- **Never add a request to page load** without checking it against the library
  cache first. `buildPoolAndIndex()` in `app.js` serves from a 6h localStorage
  cache specifically so reloads cost zero requests. Preserve that property.
- **Keep top-tracks fetches sequential**, not `Promise.all`. They were parallel
  once; that burst is what triggered the lockout.
- `/me/top/tracks` returns **at most 50 items** regardless of `limit`/`offset`.
  Do not add pagination — an earlier pagination loop issued dozens of requests
  for no extra data.
- `api()` in `spotify.js` handles 429 with `Retry-After` backoff, capped at 30s
  and 2 retries, and tags errors with `.status`. Route new calls through it.

### Spotify Dev Mode ceiling — there is no upgrade path

This app is in Development Mode. As of Spotify's Feb 2026 changes: max **5
users**, app owner must have Premium, and every user must be added by hand in
the dashboard under **User Management** (being the app owner does *not*
self-grant). Extended Quota Mode now requires ≥250k MAU via partner
application, so it is not reachable for a personal project. Don't suggest it.

### `[hidden]` needs `!important` here — do not "clean it up"

`style.css` has `[hidden] { display: none !important }`. It is load-bearing.
The author rule `section { display: flex }` beats the UA stylesheet's
`[hidden] { display: none }` because **author origin outranks UA origin
regardless of specificity**. Without the `!important`, all three screens render
at once, stacked side by side. This has already been shipped as a bug once.

### Deploy verification: check the corner tag, and distrust your cache

The live page renders the deployed short SHA bottom-right (`version.js`,
stamped by CI). Confirm a deploy by comparing that to `git rev-parse --short HEAD`.

`version.js` is served with `max-age=600`, so a stale corner tag usually means
**your browser cache**, not a failed deploy. Verify server-side before
investigating the workflow:

```
curl -s https://nhausspiegel.github.io/showertime/version.js
```

## Conventions

- ES modules, no bundler. Anything you import must be a real relative path
  reachable from `index.html`.
- `els` at the top of `app.js` caches every element by id, and asserts at load
  that none are null — so renaming an id in `index.html` fails immediately with
  the offending key named, rather than a null deref later.
- Add a screen by adding a `<section>` to `index.html` and one entry to
  `SCREENS` in `app.js`. `showScreen()` needs no edit and throws on unknown names.
- User-facing errors go to `els.statusText`; keep them plain and actionable
  ("wait a moment, then reload"), not apologetic.
- Timer state is derived from wall-clock `session.endAt`, never a decremented
  counter — background tabs throttle `setInterval` and a counter drifts.

## Verifying a change

There is no test suite. Minimum bar before pushing:

1. `node --check app.js && node --check auth.js && node --check spotify.js`
2. Serve locally and exercise the real flow — `python3 -m http.server 5500`,
   then open `http://127.0.0.1:5500/` (Spotify requires `127.0.0.1`, not
   `localhost`, and that exact URL must be a registered Redirect URI).
3. If the change touches loading, watch the Network tab and confirm the request
   count. A reload inside the cache window should issue **zero** top-tracks calls.
