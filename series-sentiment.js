// Series sentiment — the seam where "how does this user feel about this
// series?" gets answered. Pure, no chrome.* APIs.
//
// Interface evolution:
//
//   Step A (shipped): single-number weight, byte-identical relocation
//     of taste-vector.js's old `seriesWeightFor × qualityWeightFor`.
//
//   Step B Phase 2a (shipped): interface promoted to
//     `{ signal, confidence, _components }`. signal carries the
//     sign-bearing weight (preserves the existing scale). confidence
//     was 1.0 when signal != 0 (no caller-visible variance). User
//     ratings folded in as an additive contribution on signal.
//
//   Step B Phase 2b (this file's current state): confidence now varies
//     by data richness — labels with thin evidence (sampled, unknown)
//     drop low enough to be filtered by callers' coverage gates;
//     completed-and-rewatched lands near 1.0. Watchlist intent
//     (isFavorite / onWatchlist) and reactions (per-tag polarity sums
//     from the reaction palette) fold in as additional signal
//     contributions alongside ratings. CR star ratings remain
//     deferred — they're probed but not persisted to a usable form yet.
//
// Deletion test: removing this module forces the math to re-spread
// across taste-vector.js, studio-creator-index.js, and the would-be
// reaction-overlay rebuild path. That's the concentration the seam
// earns its keep on.
//
// Caller usage:
//   const { signal, confidence } = seriesSentiment(shape, al, {
//     userRating, userReactions, watchlistEntry,
//   });
//   if (confidence < 0.20) continue;  // coverage gate
//   const weight = signal;            // sign-bearing

import { REACTION_TAGS_BY_KEY } from './reactions.js';
import { iterExternalSources } from './external-source-helpers.js';

// Signed label factors: positive = "this tag shape is me," negative =
// "this tag shape is not me." Drops contribute negative weight that
// subtracts tag mass; sampled/paused are quiet neutral-leaning-negative
// nudges; completed/in-progress are the only confidently-positive
// labels.
//
// Negative weights are deliberately smaller than positive. Dropping an
// action-harem show isn't clean evidence that action *or* harem is the
// dealbreaker — could be either or neither — so the penalty per tag is
// damped. We let the aggregate sway the vector when a *pattern* of
// drops hits the same tag repeatedly.
const LABEL_FACTORS = {
  'completed':     +1.0,
  'in-progress':   +1.0,
  'paused':         0,     // truly ambiguous — neither signal
  'dropped-early': -0.35,
  'dropped-mid':   -0.20,  // closer to completing = weaker negative
  'sampled':       -0.10,
  'unknown':        0,
};

// Recency decay applied to series weight by monthsSinceLastPlay. Shows
// watched recently shape the vector more than ones from years ago, so
// taste drift is visible without erasing old loves entirely. Half-life
// of 36 months: a show last touched 3 years ago contributes half what
// the same show last week would.
const RECENCY_HALF_LIFE_MONTHS = 36;
function recencyFactorFor(monthsSinceLastPlay) {
  if (monthsSinceLastPlay == null || monthsSinceLastPlay < 0) return 1;
  return Math.pow(0.5, monthsSinceLastPlay / RECENCY_HALF_LIFE_MONTHS);
}

// Survey-origin shapes (synthetic from Quick Taste Check) get a flat
// dampening so a tap-loved tile doesn't out-weight a real CR completed
// watch. Stated preference is honest signal but not as authoritative
// as behavior.
const SURVEY_ORIGIN_DAMPENING = 0.6;

// Behavioral component — reflects watch-shape only. Pre-quality.
// Returns a single number that may be negative (drops/samples).
function behavioralSentiment(shape) {
  const labelFactor = LABEL_FACTORS[shape.label] ?? 0;
  if (labelFactor === 0) return 0;
  // When completionRatio is unknown, fall back to the label's own floor
  // so a tagged show doesn't drop out of the vector entirely.
  const ratio = typeof shape.completionRatio === 'number' ? shape.completionRatio : null;
  const completionFactor = ratio != null && ratio > 0
    ? Math.sqrt(ratio)
    : (shape.label === 'completed' || shape.label === 'in-progress' ? 0.6 : 0.3);
  const rewatchCount = Array.isArray(shape.rewatchedEpisodes) ? shape.rewatchedEpisodes.length : 0;
  // Rewatch bonus only fires for positive labels — rewatching a dropped
  // show is nonsensical, and a negative × 1.2 would amplify the drop.
  const rewatchBonus = labelFactor > 0
    ? Math.min(2, 1 + 0.05 * rewatchCount)
    : 1;
  const recency = recencyFactorFor(shape.monthsSinceLastPlay);
  const surveyDamp = shape._surveyOrigin ? SURVEY_ORIGIN_DAMPENING : 1;
  return labelFactor * completionFactor * rewatchBonus * recency * surveyDamp;
}

// Quality modifier — AniList averageScore gates how loud the show
// speaks into the vector. Without it, dozens of comfort-food
// completions drown out a smaller cluster of peak shows.
//   avgScore 80 → 1.0   (well-regarded baseline)
//   avgScore 90 → 1.33  (peak)
//   avgScore 70 → 0.67
//   avgScore 60 → 0.33
//   avgScore ≤50 → 0.2  (floor; comfort food still nudges, doesn't vanish)
//   null/0      → 1.0   (unscored — don't penalize)
export function qualityModifier(averageScore) {
  if (averageScore == null || averageScore <= 0) return 1.0;
  return Math.max(0.2, Math.min(1.5, (averageScore - 50) / 30));
}

// User-rating contribution. The card's 👎/😐/👍 buttons persist a
// per-aniListId rating ('+1' / '0' / '-1' / null). Magnitude kept
// deliberately small (0.15) — a single click shouldn't dramatically
// rerank the user's whole catalog. The per-show direct boost in
// computeAllShowsScored handles the visible "this show I rated"
// lift; this contribution shapes the tag vector subtly so SIMILAR
// shows nudge over time.
const RATING_CONTRIBUTION = {
  '+1': +0.15,
  '0':  0,
  '-1': -0.15,
};

function ratingContribution(userRating) {
  if (userRating == null) return 0;
  return RATING_CONTRIBUTION[String(userRating)] ?? 0;
}

// Watchlist-intent contribution. The user adding a show to their CR
// watchlist is positive intent — they think they'll want this. ★
// Favorite is a stronger commitment than a regular save. Magnitudes
// match the rating tier so a "saved" show contributes about the same
// as a 👍, and "favorited" sits between rating and the heaviest
// behavioral signal.
const WATCHLIST_FAVORITE_CONTRIBUTION = +0.20;
const WATCHLIST_SAVED_CONTRIBUTION = +0.10;

function watchlistContribution(watchlistEntry) {
  if (!watchlistEntry) return 0;
  if (watchlistEntry.isFavorite === true) return WATCHLIST_FAVORITE_CONTRIBUTION;
  if (watchlistEntry.onWatchlist === true || watchlistEntry.seriesId) {
    return WATCHLIST_SAVED_CONTRIBUTION;
  }
  return 0;
}

// Reaction-polarity contribution. The reaction-tag palette stores
// per-series picks like "the music carried it" / "pacing dragged."
// Each tag has a signed `weight` (~ -0.5 to +0.5). Sum across the
// user's picks for this series, then scale down so a heavy reactor
// (5+ tags) doesn't out-shout completed-show behavioral signal.
//
// Scaling by 0.5 means: a 3-tag positive set (3 × ~0.5 × 0.5 = 0.75)
// contributes about the same as a 👍 + watchlist-saved; a single
// negative tag (1 × ~-0.4 × 0.5 = -0.2) contributes less than a 👎.
// That matches the friend voice: a single "the pacing dragged" is
// honest feedback but not a dealbreaker.
const REACTION_AGGREGATE_SCALE = 0.5;

function reactionContribution(userReactionsForSeries) {
  if (!userReactionsForSeries) return 0;
  const tags = Array.isArray(userReactionsForSeries.tags)
    ? userReactionsForSeries.tags
    : (Array.isArray(userReactionsForSeries) ? userReactionsForSeries : null);
  if (!tags || tags.length === 0) return 0;
  let sum = 0;
  for (const tagKey of tags) {
    const def = REACTION_TAGS_BY_KEY[tagKey];
    if (def && typeof def.weight === 'number') sum += def.weight;
  }
  return sum * REACTION_AGGREGATE_SCALE;
}

// External-score contribution — folds AniList / MAL imported scores
// into Sentiment per CONTEXT.md "External score" contract (locked in
// the architecture grilling 2026-05-04).
//
// Mapping:
//   - Score (1-10) → signal via fixed pivot at 7:
//       signal = clamp((score - 7) / 3, -1, +1)
//     Pivot at 7 reflects AL/MAL population median; a "7" is the
//     ambient average, not a positive endorsement.
//   - Score + status both present → score signal × status-modulated
//     confidence (completed: 0.60, dropped: 0.55, watching/paused:
//     0.40, planning: skip).
//   - Status only, no score → status-derived contribution
//     (completed: {+0.20, 0.40}, dropped: {-0.40, 0.50}, others: skip).
//   - Score only, no status → score signal × base 0.5.
//
// Both sources contribute additively into the signal sum (matching
// the existing rating/watchlist/reaction pattern in seriesSentiment).
// Confidence values < 0.90 (CR rating button) ensure any explicit CR
// action naturally dominates an imported score without a special-case
// priority rule.

const EXTERNAL_BASE_CONFIDENCE = 0.5;
const EXTERNAL_STATUS_CONFIDENCE = {
  completed: 0.60,
  dropped:   0.55,
  watching:  0.40,
  paused:    0.40,
  // 'planning' deliberately omitted — intent without engagement is
  // a survey-tap-shaped signal, not an external-score-shaped one;
  // skip rather than fold a noisy contribution.
};
const EXTERNAL_STATUS_ONLY_CONTRIBUTION = {
  completed: { signal: +0.20, confidence: 0.40 },
  dropped:   { signal: -0.40, confidence: 0.50 },
  // watching / paused / planning skipped — not enough signal to fold
  // when there's no score to anchor on.
};

function externalScoreToSignal(score) {
  return Math.max(-1, Math.min(+1, (score - 7) / 3));
}

// Per-source (one of 'anilist' | 'mal') signed contribution to the
// signal sum. Returns 0 when the source has no usable signal.
function externalSourceContribution(sourceEntry) {
  if (!sourceEntry) return 0;
  const { score, status } = sourceEntry;
  const hasScore = typeof score === 'number' && score >= 1 && score <= 10;
  const hasStatus = typeof status === 'string' && status.length > 0;

  if (hasScore && hasStatus) {
    const conf = EXTERNAL_STATUS_CONFIDENCE[status];
    if (conf == null) return 0;
    return externalScoreToSignal(score) * conf;
  }
  if (hasScore) {
    return externalScoreToSignal(score) * EXTERNAL_BASE_CONFIDENCE;
  }
  if (hasStatus) {
    const sc = EXTERNAL_STATUS_ONLY_CONTRIBUTION[status];
    if (sc == null) return 0;
    return sc.signal * sc.confidence;
  }
  return 0;
}

// Sums all linked external sources' contributions for a single Series.
// Shape: { anilist?: {…}, mal?: {…}, freeform?: {…} } — iterates the
// canonical source list from external-source-helpers. Critical fix
// 2026-05-19: pre-helper, this hardcoded anilist + mal, so freeform-
// imported scores never contributed to the sentiment signal that
// drives the studio/creator index and the deriveConfidence boost.
function externalScoreContribution(externalScoresEntry) {
  if (!externalScoresEntry) return 0;
  let sum = 0;
  for (const { entry } of iterExternalSources(externalScoresEntry)) {
    sum += externalSourceContribution(entry);
  }
  return sum;
}

// Has any meaningful (non-zero contribution) external signal. Used by
// deriveConfidence to bump confidence when external scores are present
// — same pattern as the rating/reaction/watchlist explicit-feedback
// boost.
function hasExternalSignal(externalScoresEntry) {
  if (!externalScoresEntry) return false;
  for (const { entry } of iterExternalSources(externalScoresEntry)) {
    if (externalSourceContribution(entry) !== 0) return true;
  }
  return false;
}

// Confidence by label — how trustworthy is the inferred sentiment
// for each watch-shape? Long completed shows speak loudly; one-ep
// samples speak softly. Below the 0.20 caller gate is "skip this
// signal entirely" — only 'unknown' lands there because we genuinely
// don't know if the user watched anything.
const CONFIDENCE_BY_LABEL = {
  'completed':     0.95,
  'in-progress':   0.85,
  'paused':        0.65,
  'dropped-mid':   0.70,  // 4+ eps watched is meaningful negative evidence
  'dropped-early': 0.55,  // 1-3 eps watched is weaker
  'sampled':       0.35,
  'unknown':       0.10,  // below the gate; gets filtered out
};

// Explicit-feedback boost on confidence. When the user has rated,
// reacted to, or watchlisted a show, the sentiment signal is more
// trustworthy than behavior alone — they've explicitly opined. Caps
// confidence at 1.0.
const EXPLICIT_FEEDBACK_BOOST = 0.05;

function deriveConfidence(shape, extras) {
  const base = CONFIDENCE_BY_LABEL[shape?.label] ?? 0;
  if (base === 0) return 0;
  const hasExplicit =
    (extras.userRating != null && extras.userRating !== '0') ||
    (extras.userReactions && (extras.userReactions.tags?.length || 0) > 0) ||
    (extras.watchlistEntry != null) ||
    hasExternalSignal(extras.externalScores);
  const boost = hasExplicit ? EXPLICIT_FEEDBACK_BOOST : 0;
  return Math.max(0, Math.min(1, base + boost));
}

// THE SEAM. Single entry point: "what's the user's stance on this
// series, weighted for engine consumption?"
//
// Returns:
//   {
//     signal:     sign-bearing per-series weight; preserves Step A scale
//                 so downstream thresholds stay calibrated.
//     confidence: data-richness, [0, 1]. Tiered by watch-shape label
//                 with a small boost for explicit feedback. Below 0.20
//                 means "skip this signal" — caller gates inclusion.
//     _components: diagnostic surface — internal contributions per
//                 input. Not part of the public interface.
//   }
//
// extras (optional): { userRating, userReactions, watchlistEntry, externalScores }.
//   userRating       — '+1' / '0' / '-1' / null
//   userReactions    — { tags: string[] } | string[] | null
//   watchlistEntry   — { isFavorite, onWatchlist } | null (a CR
//                      watchlist record for this series)
//   externalScores   — { anilist?: {score, status}, mal?: {score, status} } | null
//                      (per-Series entry from imported AL/MAL lists)
export function seriesSentiment(shape, aniListEntry, extras = {}) {
  const behavioral = behavioralSentiment(shape);
  // Pre-multiply behavioral × quality (the Step A weight). This is
  // the dominant term and the one downstream calibration assumes.
  const quality = qualityModifier(aniListEntry?.averageScore);
  const behaviorQuality = behavioral * quality;

  const ratingTerm = ratingContribution(extras.userRating);
  const watchlistTerm = watchlistContribution(extras.watchlistEntry);
  const reactionTerm = reactionContribution(extras.userReactions);
  const externalTerm = externalScoreContribution(extras.externalScores);

  const explicitTerms = ratingTerm + watchlistTerm + reactionTerm + externalTerm;

  // Rating/reaction/watchlist/external-only series (no behavioral
  // signal but user explicitly opined or imported a score) —
  // deliberately not folded in here. The taste-vector consumes
  // sentiment per-watched-series; series the user has only opined on
  // but never watched aren't in `watchShapes` and don't reach this
  // function. If that changes (e.g. AL list-imported planning entries
  // get an inferred shape), revisit this guard.
  if (behaviorQuality === 0 && explicitTerms === 0) {
    return {
      signal: 0,
      confidence: 0,
      _components: { behavioral, quality, ratingTerm, watchlistTerm, reactionTerm, externalTerm },
    };
  }

  const signal = behaviorQuality + explicitTerms;
  const confidence = deriveConfidence(shape, extras);

  return {
    signal,
    confidence,
    _components: {
      behavioral, quality, behaviorQuality,
      ratingTerm, watchlistTerm, reactionTerm, externalTerm,
    },
  };
}

