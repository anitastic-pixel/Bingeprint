import { mapToPercentile, edgeAnchoredCalibration } from './score-normalizer.js';

// Two scoring surfaces — the all-shows pool (background.js
// computeAllShowsScored) and the rec pool (rank-recommendations.js
// rankRecommendations) — produce a finalScore in [0, 1] using the
// same algebraic shape: weighted sum of normalized [0, 1] axes plus
// an asymmetric additive lift for creator-affinity, clamped to [0, 1]
// and rounded to 3 decimals.
//
// They differ in which axes are present (off-pool has crCF, rec-pool
// has recN) and the weight constants — those stay with the callers
// who tune them. Concentrating the math here means changing the lift
// curve, clamp range, or precision is a one-file edit instead of
// coordinated surgery across two diverging copies.

// Creator-affinity is the only axis treated as an additive lift
// rather than a weighted blend contribution. Reason (background.js
// §"Score blend for off-pool"): treating it as a 4th blend axis
// systematically lowered scores on shows by good-but-not-#1 teams
// (Frieren by MADHOUSE dropped 8.9 → 8.1 because MADHOUSE normalized
// below the user's max studio). The lift is asymmetric — unknown
// teams (creatorN = 0.5) and below get 0, max trusted teams
// (creatorN = 1.0) get +0.05. Max contribution = (1 - 0.5) * 0.10.
export const CREATOR_LIFT_NEUTRAL = 0.5;
export const CREATOR_LIFT_SCALE = 0.10;

export function creatorLift(creatorN) {
  return Math.max(0, creatorN - CREATOR_LIFT_NEUTRAL) * CREATOR_LIFT_SCALE;
}

// axes: array of { value, weight }. value ∈ [0, 1]. The caller owns
// the weight schema (which axes are present, what they sum to).
// creatorN: optional [0, 1]. Applied via creatorLift().
//
// Returns the raw blended finalScore. The post-loop edge-anchored
// calibration pass (calibrateFinalScore, below) replaces this with
// the calibrated value in both callers — this function only owns
// the raw blend.
export function blendFinalScore(axes, creatorN = null) {
  let sum = 0;
  for (const { value, weight } of axes) sum += value * weight;
  if (creatorN != null) sum += creatorLift(creatorN);
  return +Math.max(0, Math.min(1, sum)).toFixed(3);
}

// Post-blend calibration. Both scoring surfaces run the same pipeline
// after the raw blend: map raw → percentile against the user's full
// scored distribution, edge-anchor (top 5% pushed ≥0.9, bottom 5%
// pushed ≤0.35), round to 3 decimals. The percentile is also stored
// alongside the calibrated score so the card can show the framing.
//
// When mapper is null (cold-start, before the per-user distribution
// is built), returns { calibrated: rawFinal, percentile: null } —
// callers persist the raw value unchanged. Matches the existing
// fallback shape in rank-recommendations.js.
export function calibrateFinalScore(rawFinal, mapper) {
  if (!mapper) return { calibrated: rawFinal, percentile: null };
  const percentile = mapToPercentile(rawFinal, mapper);
  return {
    calibrated: +edgeAnchoredCalibration(percentile).toFixed(3),
    percentile: +percentile.toFixed(3),
  };
}
