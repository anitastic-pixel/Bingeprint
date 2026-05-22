// Three surfaces in the recommendation pipeline integrate the CF
// re-ranker (ADR-0003) by calling a `cfApply(aniListId, tags) →
// { delta, cosine, provenance }` closure and attaching the result
// to each scored entry:
//
//   - background.js  computeAllShowsScored: precomputes for the
//                    cache during recompute so downstream consumers
//                    read fields, not recompute.
//   - rank-recommendations.js  rankRecommendations: rec-pool path,
//                    folds the per-entry cfDelta into a stored
//                    rankingScore for sort.
//   - lens-pipeline.js  runLens: prefers pre-attached CF, falls back
//                    to cfApply for entries that didn't carry it
//                    (first post-deploy render; standalone callers).
//
// The attach + null-handling + sort-key shape is identical across
// all three. Concentrate it here so changes (new CF field, tighter
// rounding, sort tiebreaker, bound clamping) are a one-file edit
// instead of three coordinated patches.

// Attach cfDelta/cfCosine/cfProvenance fields to `entry` from a
// cfApply closure. No-op when cfApply is null, aniListId is missing,
// or the closure returns no info (e.g. unmapped item). Returns true
// iff fields were attached.
//
// Field shape: cfDelta is a finite number rounded to 3 decimals
// (0 when info.delta is null). cfCosine is the unrounded cosine
// rounded to 3 decimals (null when info.cosine is null).
// cfProvenance is the closure's provenance string or null.
export function attachCfDeltaTo(entry, aniListId, sourceTags, cfApply) {
  if (!cfApply || aniListId == null) return false;
  const info = cfApply(aniListId, sourceTags || []);
  if (!info) return false;
  entry.cfDelta = info.delta == null ? 0 : +info.delta.toFixed(3);
  entry.cfCosine = info.cosine == null ? null : +info.cosine.toFixed(3);
  entry.cfProvenance = info.provenance || null;
  return true;
}

// Sort key for CF-aware surfaces: finalScore + cfDelta. When CF is
// off (or this entry never got a delta attached) the key collapses
// to finalScore — identical to pre-CF behavior. Use as
// `arr.sort((a, b) => cfRankingScore(b) - cfRankingScore(a))`.
export function cfRankingScore(entry) {
  return (entry.finalScore || 0) + (entry.cfDelta || 0);
}
