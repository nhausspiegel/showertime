// matcher.js
// Builds a "which durations are achievable" index from a pool of tracks,
// using subset-sum with no repeats (0/1 knapsack style), and looks up
// the best combination for a target duration.
//
// The pool is the union of the user's short-, medium-, and long-term top
// tracks, deduped and shuffled into one flat set — every top track is equally
// eligible. An earlier version layered short-term first and only reached for
// medium/long to cover durations short-term couldn't hit. But a ~50-track
// layer can hit almost any target exactly, so medium/long were essentially
// never drawn: consecutive timers all pulled from the same ~50 recent songs.
//
// The shuffle matters because subsetSum claims each sum for the *first* track
// that can reach it. Fed in `/me/top/tracks` order (most-played first) the
// user's #1 track ends up the sole owner of its own duration slot, so every
// reconstruction routing through that slot drags it in — the same song then
// shows up in timer after timer, at every length. Shuffling breaks that.

/**
 * @param {Array<{id: string, durationSec: number}>} tracks
 * @param {number} maxSeconds
 * @returns {{ tracks: Array, reachable: Uint8Array, parent: Int32Array, usedTrack: Int32Array }}
 */
function subsetSum(tracks, maxSeconds) {
  const reachable = new Uint8Array(maxSeconds + 1);
  const parent = new Int32Array(maxSeconds + 1).fill(-1);
  const usedTrack = new Int32Array(maxSeconds + 1).fill(-1);
  reachable[0] = 1;

  for (let i = 0; i < tracks.length; i++) {
    const d = tracks[i].durationSec;
    if (d <= 0 || d > maxSeconds) continue;
    // iterate downward so each track is only used once (0/1 knapsack)
    for (let s = maxSeconds; s >= d; s--) {
      if (reachable[s - d] && !reachable[s]) {
        reachable[s] = 1;
        parent[s] = s - d;
        usedTrack[s] = i;
      }
    }
  }

  return { tracks, reachable, parent, usedTrack };
}

function reconstruct(layer, sum) {
  const result = [];
  let s = sum;
  while (s > 0) {
    const idx = layer.usedTrack[s];
    result.push(layer.tracks[idx]);
    s = layer.parent[s];
  }
  return result;
}

function dedupeById(...trackLists) {
  const seen = new Map();
  for (const list of trackLists) {
    for (const t of list) {
      if (!seen.has(t.id)) seen.set(t.id, t);
    }
  }
  return [...seen.values()];
}

/**
 * @param {Array} shortTracks
 * @param {Array} mediumTracks
 * @param {Array} longTracks
 * @param {number} maxSeconds - cap for the index. The duration field tops out
 *   at 99:59, so 6000 covers every reachable target; every extra slot is DP
 *   work done on every rebuild for a duration the UI can't ask for.
 */
export function buildIndex(shortTracks, mediumTracks, longTracks, maxSeconds = 6000) {
  // One merged, shuffled pool of every top track. Shuffle *after* dedupeById:
  // dedupe is first-occurrence-wins, and shuffling the deduped result only
  // affects which track wins a duration slot in subsetSum — keeping that fair.
  const pool = shuffle(dedupeById(shortTracks, mediumTracks, longTracks));
  return { layers: [subsetSum(pool, maxSeconds)], maxSeconds };
}

/**
 * Finds the best combo for a target duration (in seconds).
 * Tries an exact match first (layer 1, then 2, then 3). If nothing hits
 * exactly, walks downward to the nearest achievable duration <= target.
 *
 * @returns {{ exact: boolean, seconds: number, tracks: Array }|null}
 */
export function findCombo(index, targetSeconds) {
  const cap = Math.min(targetSeconds, index.maxSeconds);

  for (let s = cap; s >= 0; s--) {
    for (const layer of index.layers) {
      if (layer.reachable[s]) {
        return {
          exact: s === targetSeconds,
          seconds: s,
          tracks: reconstruct(layer, s),
        };
      }
    }
  }
  return null; // pool has nothing short enough (e.g. shortest song > target)
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
