// Tag-burnout detection. Computes a per-tag map of "user used to like
// this, recent watches show decline" — surfaced as friend-voice
// burnout chips on the in-page card (e.g. "Shōnen formula fatigue",
// "Tournament-arc grind"). The chip set is intentionally distinct
// from topAntiTags: anti-tags fire on tags with persistently negative
// userWeight ("you don't like this"), burnout fires on tags where
// you DID like it but recent watches have declined.
//
// Inputs (all from chrome.storage.local snapshots):
//   - allShowsScored:  { [crSeriesId]: scoredEntry }
//   - ratings:         { [aniListId]: '+1' | '0' | '-1' }
//   - reactions:       { [aniListId]: [reactionKey, ...] }
//   - watchShapes:     { series: { [crSeriesId]: { lastPlayedAt, ... } } }
//
// Output: sparse map of FIRED tags only.
//   { [canonicalTagName]: {
//       olderAvg, recentAvg, delta, sampleSize, splitDate,
//   } }
//
// Run in the worker as part of persistTasteVector. The output goes
// to chrome.storage.local.tagBurnoutIndex; content.js picks it up
// via STATE.tagBurnoutIndex.
//
// Pure module. No DOM, no chrome.* — caller passes in the inputs.
// Imported by background.js (ES module). content.js doesn't import
// this — it reads the persisted index from storage and dispatches
// rendering through phrase-engine.

// ── Tunable thresholds (Q5 design grilling) ──────────────────────
export const SAMPLE_PER_HALF_MIN = 4;       // ≥4 watches per half = ≥8 total in tag
export const OLDER_AVG_FLOOR = 0.2;         // "you used to like it" floor
export const DELTA_MIN = 0.4;               // significant drop in absolute terms

// ── Polarity computation (Q7: stacking) ──────────────────────────

// Reaction polarity sets — see Q7. Most reactions stay 0; only
// these explicitly polarity-bearing ones contribute.
export const POSITIVE_REACTIONS = new Set([
  'hit-hard', 'couldnt-stop', 'pure-joy', 'gorgeous',
  'surprised-me', 'rewatch',
]);
export const NEGATIVE_REACTIONS = new Set([
  'dropped', 'forgettable', 'predictable', 'no-payoff', 'didnt-land',
  'too-slow', 'dragged', 'flat-cast', 'unlikeable',
]);
const REACTION_DELTA = 0.3;

// Watch-base polarity from the userWatchShape sub-object of a
// scored entry. Returns null when there's no signal at all
// (entry has no watch shape or watchlist-only).
export function watchBasePolarity(userWatchShape) {
  if (!userWatchShape) return null;
  if (userWatchShape.isRewatched) return 0.7;          // strong positive
  const cr = userWatchShape.completionRatio;
  if (cr == null) return null;                          // no signal
  if (cr >= 0.85) return 0.4;                           // completed
  if (cr >= 0.4) return 0.0;                            // mid
  return -0.4;                                          // early drop
}

export function ratingModifier(ratings, aniListId) {
  if (!aniListId) return 0;
  const r = ratings?.[String(aniListId)];
  if (r === '+1' || r === 1) return 0.5;
  if (r === '-1' || r === -1) return -0.5;
  return 0;
}

export function reactionsModifier(reactions, aniListId) {
  if (!aniListId) return 0;
  const list = reactions?.[String(aniListId)];
  if (!Array.isArray(list) || list.length === 0) return 0;
  let delta = 0;
  for (const r of list) {
    if (POSITIVE_REACTIONS.has(r)) delta += REACTION_DELTA;
    else if (NEGATIVE_REACTIONS.has(r)) delta -= REACTION_DELTA;
  }
  return delta;
}

// Final polarity for a single show. Returns null if no usable
// signal (e.g. watchlist-only, never started).
export function polarityForShow(scoredEntry, ratings, reactions) {
  const base = watchBasePolarity(scoredEntry?.userWatchShape);
  if (base == null) return null;
  const aniListId = scoredEntry?.aniListId;
  const rating = ratingModifier(ratings, aniListId);
  const reaction = reactionsModifier(reactions, aniListId);
  const sum = base + rating + reaction;
  return Math.max(-1, Math.min(1, sum));
}

// ── Per-tag burnout computation ──────────────────────────────────

// Walks every scored entry, derives polarity + lastPlayedAt + tags,
// then groups by tag. Within each tag: sort by date, median-split,
// compare halves, fire if Q5 conditions hold.
export function computeTagBurnoutIndex({
  allShowsScored,
  ratings,
  reactions,
  watchShapes,
} = {}) {
  if (!allShowsScored) return {};
  const watchSeries = watchShapes?.series || {};

  // Tag → array of { polarity, ts (ms since epoch) }.
  const byTag = new Map();

  for (const [crSeriesId, entry] of Object.entries(allShowsScored)) {
    if (!entry) continue;
    const polarity = polarityForShow(entry, ratings, reactions);
    if (polarity == null) continue;

    // lastPlayedAt is on watchShapes.series, not on the scored
    // entry itself. Skip shows we don't have a play timestamp for —
    // can't trend-analyze them anyway.
    const watchEntry = watchSeries[crSeriesId];
    const lastPlayed = watchEntry?.lastPlayedAt;
    if (!lastPlayed) continue;
    const ts = Date.parse(lastPlayed);
    if (!Number.isFinite(ts)) continue;

    const tags = entry.topTags || [];
    for (const t of tags) {
      const name = t?.tag;
      if (!name) continue;
      if (!byTag.has(name)) byTag.set(name, []);
      byTag.get(name).push({ polarity, ts });
    }
  }

  // For each tag, run the median-split + threshold check.
  const out = {};
  for (const [tagName, samples] of byTag) {
    if (samples.length < SAMPLE_PER_HALF_MIN * 2) continue;
    // Sort by timestamp ascending — older entries first.
    samples.sort((a, b) => a.ts - b.ts);
    const mid = Math.floor(samples.length / 2);
    const olderHalf = samples.slice(0, mid);
    const recentHalf = samples.slice(mid);
    if (olderHalf.length < SAMPLE_PER_HALF_MIN) continue;
    if (recentHalf.length < SAMPLE_PER_HALF_MIN) continue;

    const olderAvg = avg(olderHalf.map(s => s.polarity));
    const recentAvg = avg(recentHalf.map(s => s.polarity));
    const delta = olderAvg - recentAvg;

    // Q5 conditions — all three must hold.
    const fired =
      olderAvg >= OLDER_AVG_FLOOR &&
      delta >= DELTA_MIN;
    if (!fired) continue;

    out[tagName] = {
      olderAvg: round3(olderAvg),
      recentAvg: round3(recentAvg),
      delta: round3(delta),
      sampleSize: samples.length,
      splitDate: new Date(samples[mid - 1].ts).toISOString(),
    };
  }
  return out;
}

function avg(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
