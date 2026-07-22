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

### The live queue is one array with a moving cursor — the total is fixed

`session.tracks` holds the whole queue in order; `session.currentIdx` is the
playing track, everything before it is history (`session.outcomes[id]` records
`played` vs `skippedAfterSec`). Skip, drag-reorder, and drift-recalc only ever
rewrite the slice *after* `currentIdx`; history never moves. `renderQueue`
prints the bottom total from `session.totalSeconds` — the timer length, fixed at
Start. **Never make it a live `reduce` over durations**: that's the number that
"jumped on skip" and the bug we fixed. A skipped row shows its real played time
(`skipped M:SS`) so the visible rows still reconcile to that fixed total.

### Hover fills must be gated to hover devices, or they stick on touch

`button:hover` and `button:active` must not share a fill rule. On touch, `:hover`
sticks after a tap until you tap elsewhere, so the last-tapped button stays
highlighted (reported bug). Hover fills live under
`@media (hover: hover) and (pointer: fine)`; `:active` is the touch press state.

### Album-art self-heal is the one sanctioned extra fetch on load

`buildPoolAndIndex()` treats a cache lacking the `art` field as needing a
refresh (`cacheHasArt`), so pre-art caches refetch **once** and then carry art.
Every later reload is fresh again → still zero top-tracks requests. Don't broaden
this into refetching art-ful caches, and don't bump the cache key to force it.

### `[hidden]` needs `!important` here — do not "clean it up"

`style.css` has `[hidden] { display: none !important }`. It is load-bearing.
The author rule `section { display: flex }` beats the UA stylesheet's
`[hidden] { display: none }` because **author origin outranks UA origin
regardless of specificity**. Without the `!important`, all three screens render
at once, stacked side by side. This has already been shipped as a bug once.

### Duration entry: validate the committed value, never the keystroke

The duration field is a single digit-shift ("calculator style") input — each
digit pushes in from the right. Reaching a valid time therefore **requires
passing through invalid ones**: typing `0800` walks `25:00 → 50:00 → 00:08 →
00:80 → 08:00`.

A guard that rejected the keystroke whenever the seconds-tens digit exceeded 5
shipped once. It made **3840 of the 6000 valid times unreachable** — every time
whose third digit is 6-9, including `08:00`. Validate `durationSeconds()` and
flag the field (`.invalid`); never block input.

### Subset-sum claims sums for the *first* track that can reach them

`subsetSum()` sets `reachable[s]` only `if (!reachable[s])`, so pool order
decides which track owns each sum. Fed in `/me/top/tracks` order (most-played
first), the user's #1 track became the sole owner of its own duration slot, and
every reconstruction routing through that slot dragged it in — **one song
appeared in 5 of 5 queues across five different timer lengths, with only 12
distinct tracks across all of them.** `buildIndex()` shuffles the pool to break
this — **after `dedupeById`, never before** (dedupe is first-occurrence-wins).

### The pool is one merged set of all three top-track ranges

`buildIndex()` unions short/medium/long into a single shuffled pool. It used to
*layer* them (short-term first, medium/long only as fallback), but a ~50-track
layer hits almost any target exactly, so medium/long were essentially never
drawn — every timer pulled from the same ~50 recent songs. Do not reintroduce
layering to "prefer recent" tracks; it silently narrows the pool to short-term.
Spotify offers no time-range beyond these three; a genuinely bigger pool needs a
new *source* (`/me/tracks` Liked Songs), which requires the `user-library-read`
scope and a re-auth on every device.

### Queue self-heals on skip via drift detection, not a "skip" handler

The music is solved to end exactly when the timer does. Skipping, seeking, or
replaying breaks that sum. `maybeRecalcQueue()` runs inside the existing
now-playing poll: it compares remaining music (current track's remainder + the
durations queued after it) against remaining timer, and when they drift past
`DRIFT_THRESHOLD_SEC` it re-solves the tail via `pickCombo()` and re-queues it
behind the current song (`playTracks(..., { positionMs })` resumes the current
track in place). One check covers skip forward/back, seek, and in-app pauses —
there is deliberately no per-event handler.

Guards that must stay, each already cost a reasoning pass:
- **It only fires on real drift, debounced by `RECALC_COOLDOWN_MS`, and skips
  the PUT entirely when the re-solved tail is unchanged.** So the poll stays
  zero-request in steady state — a re-queue is only issued in response to a
  user action. Do not let it re-queue on every poll.
- **If the playing track isn't in `session.tracks` (`idx < 0`), do nothing.**
  The user has wandered to other playback; re-queuing would hijack them.
- **`setShuffleOff()` before `playTracks()` is load-bearing here too** — drift
  math assumes the queue plays in order.

### Player-state polls lag — treat them as confirmation, not truth

`/me/player/currently-playing` is eventually consistent: it reflects what the
device last reported, so for the first few seconds after `playTracks()` it
still names the track that was playing *before* Start. Rendering it blindly
flashed the previous track for up to ~20s (≈4 poll cycles).

`refreshNowPlaying()` now renders `session.tracks[0]` optimistically at Start
and, via a `queueConfirmed` flag, ignores any poll naming a track outside
`session.tracks` until the first one that matches. After confirmation it
accepts everything, so a genuine mid-session change still shows. This adds
**zero** requests — we already know what we queued.

`playTracks()` is preceded by `setShuffleOff()` so the device can't reorder the
uris, which is what makes `session.tracks[0]` reliably the track that starts.

### Countdown: never sample a clock on a fixed interval

`setInterval(…, 1000)` guarantees *at least* 1000ms, so ticks land a few ms
late and the sampled fraction of a second creeps downward. With `Math.round`,
crossing the .5 boundary between two ticks drops the displayed integer by 2 —
a visibly skipped second (`0:58 → 0:56`), reproducibly **6 times per 25-minute
timer**.

`scheduleTick()` instead schedules each tick onto the next second boundary,
recomputed from the wall clock every time, so it self-corrects and drift cannot
accumulate. Keep `Math.ceil` in `updateCountdown()`: it holds the starting
value for a full second and reaches 0:00 exactly at `endAt`.

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
