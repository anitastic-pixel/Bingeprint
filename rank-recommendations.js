// Phase B2: blend taste-vector match × community rec score × overall
// quality into a final recommendation ranking. Pure, no chrome.* APIs.
//
// Inputs:
//   candidates    — B1 output array; each item carries { aniListId, title,
//                   score (B1 rec-score), sources }.
//   mediaById     — { aniListId: projectedMedia } from bulkFetchByIds.
//   tasteVector   — for scoreShow().
//
// For each candidate we compute three normalized sub-scores in [0,1]:
//
//   tasteN   = scoreShow(media, tasteVector).score, normalized across set
//   recN     = candidate.score (from B1), normalized across set
//   qualN    = (averageScore || 0) / 100
//
// Final = 0.55*tasteN + 0.30*recN + 0.15*qualN.
//
// Why these weights: B1 rec-score already encodes "your watch history
// thinks this is relevant" but it's popularity-biased, so taste-shape
// match gets the largest slice. averageScore is a weak quality signal
// (community-wide, not personal) — useful as a tie-breaker against
// universally-disliked oddities, not as a primary axis.
//
// Min-max normalization across the candidate pool only — we're ranking
// *within* this pool, so absolute scale doesn't matter.

import { scoreShow } from './per-show-score.js';
import { buildFranchise } from './franchise.js';
import { adjustQualityAxesForFranchise } from './quality-axes.js';
import { findCrLink, normalizeCrUrl } from './anilist.js';
import {
  composeFeedback,
  reactionOverlayAdapter,
  dealbreakerFilterAdapter,
} from './feedback-overlay.js';
import { creatorAffinityScore, deriveCreatorMaxes, preferMainAnimationStudios } from './studio-creator-index.js';
import { mapToPercentile } from './score-normalizer.js';
import { blendFinalScore, calibrateFinalScore } from './score-blender.js';
import { attachCfDeltaTo } from './cf-context.js';

// Score blend — taste/rec/qual. Creator-affinity is applied as an
// additive lift on finalScore (see below) — same asymmetric pattern
// as the rating boost. Lifts shows by trusted teams without
// penalizing shows by unfamiliar teams.
const W_TASTE = 0.55;
const W_REC = 0.30;
const W_QUAL = 0.15;

// Roles whose creator affinity actually predicts whether you'll vibe with
// a show. AniList's per-edge `role` is a free-text string ("Director",
// "Director, Episode Director (#1)", "Original Creator", "Series
// Composition", etc.), so we substring-match the canonical role tokens.
const KEY_STAFF_ROLE_PATTERN =
  /\b(director|original creator|original story|series composition|character design|music|original work)\b/i;

function normalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(v => (v - min) / (max - min));
}

export function rankRecommendations(candidates, mediaById, tasteVector, options = {}) {
  // Studio/creator affinity index for the creator-axis sub-score.
  // When omitted (legacy callers, or no index built yet), creatorN
  // defaults to 0.5 per show — neutral, doesn't drag the score.
  const studioCreatorIndex = options.studioCreatorIndex || null;
  const creatorMaxes = studioCreatorIndex
    ? deriveCreatorMaxes(studioCreatorIndex)
    : null;
  // Feedback channels — reactions + dealbreakers + any future
  // additions — compose into a single surface that knows how to
  // adjust the taste vector and filter media. rank-recommendations
  // no longer needs to know what feedback channels exist; the seam
  // is feedback-overlay.js.
  //
  // No clamp on the taste-vector adjustment: the base vector now
  // carries negative weights (drops-as-anti-signal), so a clamp to
  // 0 would null out the anti-tags we *want* to see flowing through
  // scoreShow. A heavy negative reaction should be allowed to flip
  // a weakly-positive tag negative — that's the whole point.
  const feedback = options.feedback || composeFeedback([
    reactionOverlayAdapter(options.overlay),
    dealbreakerFilterAdapter(options.dealbreakerTags),
  ]);
  const effectiveTaste = feedback.applyToTasteVector(tasteVector);
  const enriched = [];
  let skippedNoMedia = 0;
  let skippedNoTags = 0;
  let skippedDealbreaker = 0;
  let skippedNotOnCr = 0;

  for (const cand of candidates) {
    const media = mediaById[cand.aniListId];
    if (!media) { skippedNoMedia++; continue; }
    const hasData = (media.tags?.length || 0) > 0 || (media.genres?.length || 0) > 0;
    if (!hasData) { skippedNoTags++; continue; }
    if (!feedback.acceptsMedia(media)) { skippedDealbreaker++; continue; }
    // Hard-filter shows not on Crunchyroll. The side panel is a CR-
    // surface tool — surfacing HIDIVE / Netflix / etc. shows is
    // friend-failure (the user clicks expecting to watch and can't).
    // findCrLink walks media.externalLinks for a Crunchyroll site
    // entry. The on-page card surface allows non-CR shows separately
    // (per north-star Q14 — every series page renders something);
    // this filter is rec-list-specific.
    const crLinkRaw = findCrLink(media);
    if (!crLinkRaw) { skippedNotOnCr++; continue; }
    const crSiteUrl = normalizeCrUrl(crLinkRaw);
    const { score: tasteScore, matched, archetypeBreakdown, showArchetypeFit } = scoreShow(media, effectiveTaste);
    // Build franchise once — referenced by both `franchise` and the
    // G07 franchise-aware qualityAxes override below.
    const candFranchise = buildFranchise(media, mediaById);
    enriched.push({
      aniListId: cand.aniListId,
      title: media.title || cand.title,
      coverImage: media.coverImage || null,
      siteUrl: media.siteUrl || null,
      // Crunchyroll URL for the rec card click-through. Locale-stripped
      // canonical form. Side panel renderCard prefers this over
      // siteUrl (AniList) so clicks land on CR, not on AniList.
      crSiteUrl,
      tasteScore,
      recScore: cand.score,
      averageScore: media.averageScore || 0,
      popularity: media.popularity || 0,
      format: media.format,
      seasonYear: media.seasonYear,
      // startDate carries the year for shows AL leaves seasonYear null
      // on (ONAs in particular). The card's commitmentLine falls back
      // to startDate.year when seasonYear is missing.
      startDate: media.startDate || null,
      episodes: media.episodes,
      status: media.status || null,
      description: media.description || null,
      source: media.source || null,
      genres: media.genres || [],
      topTags: matched.slice(0, 5),
      archetypeBreakdown,
      showArchetypeFit,
      sources: cand.sources,
      // Surface the show's studios/staff so the show-page card can render
      // a "Studio: Wit · 12 of your favorites" row without re-fetching.
      // animationStudios filters out producers (license/funding companies)
      // so we don't credit "Aniplex" with the look of a Wit show, AND
      // prefers main studios (Toei over Magic Bus on One Piece) when
      // AniList flags any.
      animationStudios: preferMainAnimationStudios(media.studios),
      keyStaff: (media.staff || [])
        .filter(s => s.id != null && KEY_STAFF_ROLE_PATTERN.test(s.role || ''))
        .slice(0, 6),
      // Franchise-level rollup — collapses "Season 7" into the parent
      // series + detects studio changes across seasons so the card can
      // render "Wit (S1–S3) / MAPPA (S4)" instead of just current-entry
      // meta. Returns null if media has no relations (single-season,
      // nothing to roll up).
      franchise: candFranchise,
      // Phase 4: per-show quality axes (craftPrior, consensusQuality,
      // adaptationRisk). Attached to the media object by the worker
      // before this rank call. Individual fields may be null when we
      // don't have enough corpus data — consumers treat null as
      // 'unknown, don't mention.' G07: franchise-aware adaptation-
      // risk override (12-eps-per-season Mob Psycho is not rushed
      // when franchise total is 36+ eps).
      qualityAxes: adjustQualityAxesForFranchise(
        media.qualityAxes || null, candFranchise),
      // Provenance flag set by fetchTopShowsByTag — survives through
      // ranking so the survey tap-effect diagnostic can credit a seed
      // CTA hit even when the seeded tag sits below the centrality
      // threshold on the show's own AniList rank order.
      _seededFromTag: media._seededFromTag || null,
    });
  }

  if (enriched.length === 0) {
    return {
      ranked: [],
      skipped: { noMedia: skippedNoMedia, noTags: skippedNoTags, dealbreaker: skippedDealbreaker, notOnCr: skippedNotOnCr },
    };
  }

  // tasteN: prefer cache-wide percentile when the mapper is provided.
  // Falls back to in-pool min-max for legacy callers / cold-start
  // (mapper not yet built). The percentile mapping makes the same
  // show's tasteN identical between the side-panel rec list and the
  // on-page card — closes the cross-surface inconsistency that
  // previously had a show reading 0.5 in one surface and 0.7 in
  // the other.
  const tasteMapper = options.tasteScorePercentileMapper || null;
  const tasteN = tasteMapper
    ? enriched.map(e => mapToPercentile(e.tasteScore, tasteMapper))
    : normalize(enriched.map(e => e.tasteScore));
  const recN = normalize(enriched.map(e => e.recScore));
  const qualN = enriched.map(e => e.averageScore / 100);
  // Creator-affinity per rec. 0.5 (neutral) when no index OR no
  // history with this show's team — unknown ≠ bad.
  const creatorN = enriched.map(e => {
    if (!studioCreatorIndex || !creatorMaxes) return 0.5;
    return creatorAffinityScore(
      e.animationStudios, e.keyStaff,
      studioCreatorIndex, creatorMaxes,
    ).score;
  });

  // G01/G02: when finalScorePercentileMapper is provided, calibrate
  // each rec's finalScore against the SAME population the off-pool
  // path uses (the user's full scored catalog). Without this, the
  // rec pool's tiny ~120-show distribution would produce its own
  // self-contained calibration that disagrees with the on-page card.
  // Falls back to raw-clamped finalScore when no mapper (legacy
  // callers, cold-start before computeAllShowsScored has run).
  const finalMapper = options.finalScorePercentileMapper || null;
  // G05: rating override floor/ceiling constants. Mirror values in
  // background.js — rec-pool entries that the user has rated get the
  // same clamp. In practice rated shows rarely surface here (rec lists
  // typically exclude watched), but the safety net keeps the mechanic
  // honest if a rated show does appear.
  const userRatings = options.userRatings || null;
  const RATING_PLUS_FLOOR = 0.75;
  const RATING_MINUS_CEILING = 0.30;
  // CF re-ranker (ADR-0003 bounded exception). cfApply is a closure
  // provided by background.js when cfEnabled is true — takes
  // (aniListId, tags) → { delta, cosine, provenance }. The delta is
  // bounded ±K_MAX·influence and nudges the *internal ranking score
  // only*. The displayed finalScore on each card is untouched — that's
  // the design's compliance hinge with north-star "same show, same
  // number, every surface."  When cfApply is null, this is a no-op
  // and the sort key collapses back to finalScore.
  const cfApply = options.cfApply || null;
  for (let i = 0; i < enriched.length; i++) {
    // Creator lift: same shape as off-pool. Max +0.05 for shows by the
    // user's most-trusted team; 0 for cold-start / unknown teams. The
    // lift formula and clamp live in score-blender.js — shared with
    // the off-pool blend in background.js so the two surfaces can't
    // drift.
    const rawFinal = blendFinalScore([
      { value: tasteN[i], weight: W_TASTE },
      { value: recN[i],   weight: W_REC   },
      { value: qualN[i],  weight: W_QUAL  },
    ], creatorN[i]);
    enriched[i].rawFinalScore = rawFinal;
    const { calibrated: calibratedConst, percentile } = calibrateFinalScore(rawFinal, finalMapper);
    let calibrated = calibratedConst;
    if (percentile != null) enriched[i].finalScorePercentile = percentile;
    // G05: stated rating override clamps calibrated value.
    if (userRatings && enriched[i].aniListId != null) {
      const r = userRatings[enriched[i].aniListId];
      if (r === '+1' && calibrated < RATING_PLUS_FLOOR) {
        calibrated = RATING_PLUS_FLOOR;
        enriched[i].finalScoreOverride = '+1';
      } else if (r === '-1' && calibrated > RATING_MINUS_CEILING) {
        calibrated = RATING_MINUS_CEILING;
        enriched[i].finalScoreOverride = '-1';
      }
    }
    enriched[i].finalScore = calibrated;
    enriched[i].subScores = {
      taste: +tasteN[i].toFixed(3),
      rec: +recN[i].toFixed(3),
      qual: +qualN[i].toFixed(3),
      creator: +creatorN[i].toFixed(3),
    };
    // CF re-ranker delta — bounded ±K_MAX·influence·cosine·multiplier
    // (see cf-engine.js + design doc §3.9). The internal rankingScore
    // is what we sort by; finalScore stays as the engine's untouched
    // calibrated output for display. When cfApply is null or returns
    // no info, attachCfDeltaTo is a no-op, cfDelta stays undefined,
    // and rankingScore collapses back to calibrated. The attach +
    // null-handling shape is shared via cf-context.js with the off-
    // pool precompute in background.js and the lens sort in
    // lens-pipeline.js, so the three CF integration sites can't drift.
    const tags = mediaById[enriched[i].aniListId]?.tags || [];
    attachCfDeltaTo(enriched[i], enriched[i].aniListId, tags, cfApply);
    enriched[i].rankingScore = +(calibrated + (enriched[i].cfDelta || 0)).toFixed(3);
  }

  // Sort by rankingScore (= finalScore + cfDelta). When CF is off the
  // delta is 0 and this is identical to the prior finalScore-sort. CF
  // delta is bounded so a strong CF signal can reorder within ~5
  // ranks but can't put a 4.0 above a 9.0 — engine remains primary.
  enriched.sort((a, b) => b.rankingScore - a.rankingScore);

  return {
    ranked: enriched,
    skipped: { noMedia: skippedNoMedia, noTags: skippedNoTags, dealbreaker: skippedDealbreaker, notOnCr: skippedNotOnCr },
  };
}
