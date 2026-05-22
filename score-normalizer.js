// Cross-surface score normalization. Pure, no chrome.* APIs.
//
// Problem this solves: previously, `tasteN` was min-max normalized
// independently within each pool (rec-pool ~60 candidates vs off-pool
// ~600 cache entries). Same show, different surfaces, different
// `tasteN` — the user saw inconsistent confidence on the same series
// in the side panel vs on-page card.
//
// Fix: cache-wide percentile mapping. Build a single sorted-scores
// distribution from the full cache once per recompute, then both
// surfaces look up each show's percentile against that distribution.
// `tasteN = 0.7` means "you'd like this more than 70% of your
// scoreable catalog" — same answer regardless of which surface asks.
//
// Why percentile and not cache-wide min-max:
//   Outliers pin the max; mid-tier shows squash toward 0. Percentile
//   is outlier-resistant and reads naturally as a confidence statement.
//   It also maps cleanly onto the existing tier labels (TRUST ME =
//   top decile, etc.) without re-tuning thresholds.
//
// Scope: tasteN only. creatorN is already absolute (cosine of internal
// max), qualN is already absolute (averageScore/100), and recN is
// intentionally in-pool ("ranked higher than its peers in this 60-show
// candidate set" is a within-cohort fact).

// Build a percentile mapper from a list of raw scores. Caller does
// this once per recompute, persists the mapper, and feeds it to
// downstream rankers for cross-surface lookup.
export function buildPercentileMapper(scores) {
  const valid = (scores || []).filter(s => typeof s === 'number' && Number.isFinite(s));
  const sorted = valid.slice().sort((a, b) => a - b);
  return { sorted, count: sorted.length };
}

// Map a raw score to its cache-wide percentile [0, 1]. Returns 0.5
// (neutral) when the mapper is empty or absent — preserves caller
// behavior under cold-start / pre-recompute conditions.
export function mapToPercentile(score, mapper) {
  if (!mapper || !mapper.sorted || mapper.count === 0) return 0.5;
  if (!Number.isFinite(score)) return 0.5;
  const sorted = mapper.sorted;
  // Binary search: find the first index where sorted[index] >= score.
  // The result is the count of scores strictly below `score`, divided
  // by total count = the percentile rank of `score` in the distribution.
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < score) lo = mid + 1;
    else hi = mid;
  }
  return lo / mapper.count;
}

// Edge-anchored hybrid calibration. Maps a percentile [0, 1] to a
// calibrated finalScore [0, 1] such that the user's top 5% of scored
// shows reaches >=0.9 (display >=9.0, TRUST ME band per north-star Q5)
// and bottom 5% reaches <=0.35 (display <=3.5, SKIP band). Middle 90%
// gets linear percentile-to-band mapping in [0.35, 0.90].
//
// Why edge-anchoring vs pure percentile remap: pure percentile would
// also work but produces values that depend purely on the catalog's
// percentile shape — the displayed score for "your 50th-percentile
// show" would be exactly 0.5 (display 5.0) regardless of how strong
// the engine's signal is. Edge-anchoring preserves the percentile
// monotonicity inside the middle 90% but guarantees the band labels
// (TRUST ME / SKIP) populate consistently — the friend always has
// "drop everything" picks and "skip" picks in their pocket, even
// when the raw signal distribution is flat.
//
// Why bottomFloor: the literal 0.0 display ("0/10") on the worst show
// reads as "engine broken" rather than "engine confidently saying no."
// SKIP is honest at display 1.0 — same band, friendlier visual. Floor
// is a tunable per the philosophy doc's Tunables reference; default
// 0.10 keeps the bottom shows visually meaningful while preserving
// the SKIP band semantics.
//
// Inputs:
//   percentile: [0, 1] from mapToPercentile
//   opts.topCutoff: percentile threshold for "top X%" (default 0.95)
//   opts.bottomCutoff: percentile threshold for "bottom X%" (default 0.05)
//   opts.topFloor: calibrated value at topCutoff (default 0.90)
//   opts.bottomCeiling: calibrated value at bottomCutoff (default 0.35)
//   opts.bottomFloor: calibrated value at percentile 0 (default 0.10).
//     The bottom region maps [0, BOTTOM_CUTOFF] to
//     [bottomFloor, BOTTOM_CEILING] linearly.
//
// Returns: calibrated finalScore in [0, 1]. Monotonic with input
// percentile. Caller multiplies by 10 for display.
export function edgeAnchoredCalibration(percentile, opts = {}) {
  const TOP_CUTOFF = opts.topCutoff ?? 0.95;
  const BOTTOM_CUTOFF = opts.bottomCutoff ?? 0.05;
  const TOP_FLOOR = opts.topFloor ?? 0.90;
  const BOTTOM_CEILING = opts.bottomCeiling ?? 0.35;
  const BOTTOM_FLOOR = opts.bottomFloor ?? 0.10;

  if (!Number.isFinite(percentile)) return 0.5;
  const p = Math.max(0, Math.min(1, percentile));

  if (p >= TOP_CUTOFF) {
    // Top region: percentile [TOP_CUTOFF, 1.0] maps to [TOP_FLOOR, 1.0]
    return TOP_FLOOR + (p - TOP_CUTOFF) * (1.0 - TOP_FLOOR) / (1.0 - TOP_CUTOFF);
  }
  if (p <= BOTTOM_CUTOFF) {
    // Bottom region: percentile [0, BOTTOM_CUTOFF] maps to
    // [BOTTOM_FLOOR, BOTTOM_CEILING] — bottom-most show gets a soft
    // floor (display 1.0 by default) instead of literal 0.
    return BOTTOM_FLOOR
      + p * (BOTTOM_CEILING - BOTTOM_FLOOR) / BOTTOM_CUTOFF;
  }
  // Middle 90%: linear remap from [BOTTOM_CUTOFF, TOP_CUTOFF] to
  // [BOTTOM_CEILING, TOP_FLOOR].
  return BOTTOM_CEILING
    + (p - BOTTOM_CUTOFF) * (TOP_FLOOR - BOTTOM_CEILING) / (TOP_CUTOFF - BOTTOM_CUTOFF);
}
