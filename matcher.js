// matcher.js
// Builds a "which durations are achievable" index from a pool of tracks,
// using subset-sum with no repeats (0/1 knapsack style), and looks up
// the best combination for a target duration.
//
// Layering: short-term tracks get first claim on the index. Medium-term
// tracks only get pulled in to cover durations short-term can't reach.
// Long-term tracks are the last resort. This is done by building three
// cumulative pools (short / short+medium / short+medium+long, deduped by
// track id) and running subset-sum on each independently.

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
 * @param {number} maxSeconds - cap for the index (e.g. 4 hours)
 */
export function buildIndex(shortTracks, mediumTracks, longTracks, maxSeconds = 4 * 3600) {
  const layer1Pool = dedupeById(shortTracks);
  const layer2Pool = dedupeById(shortTracks, mediumTracks);
  const layer3Pool = dedupeById(shortTracks, mediumTracks, longTracks);

  return {
    layers: [
      subsetSum(layer1Pool, maxSeconds),
      subsetSum(layer2Pool, maxSeconds),
      subsetSum(layer3Pool, maxSeconds),
    ],
    maxSeconds,
  };
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
