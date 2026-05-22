// Pure compute body of the off-pool scoring pass. Given already-
// loaded inputs (aniListCache, watchShapes, etc.) + a tasteVector +
// optional previous-run franchise cache + optional cfApply closure,
// returns the bundle the worker persists. No chrome.* calls —
// callable from any context that can hand it inputs.
//
// The IO orchestrator lives in background.js as computeAllShowsScored.
//
// Two scoring-only helpers (preferMainAnimationStudios,
// computeConfidence) live in this file because they have no other
// callers in background.js. preferMainAnimationStudios still exists
// as a copy in rank-recommendations.js — that's a separate dedup
// opportunity (the two copies are byte-identical; could be unified
// via a re-export from here).

import { prepareShow, scorePreparedShow } from './per-show-score.js';
import { composeFeedback, reactionOverlayAdapter } from './feedback-overlay.js';
import { computeReactionOverlay } from './reactions.js';
import { buildPercentileMapper, mapToPercentile } from './score-normalizer.js';
import { blendFinalScore, calibrateFinalScore } from './score-blender.js';
import { attachCfDeltaTo } from './cf-context.js';
import { creatorAffinityScore, deriveCreatorMaxes, preferMainAnimationStudios } from './studio-creator-index.js';
import { buildFranchise } from './franchise.js';
import { adjustQualityAxesForFranchise } from './quality-axes.js';
import { mergeCrTagsIntoEntry } from './taste-pipeline.js';
import { crSiteUrlFor } from './anilist.js';

// AniList lists outsourcing studios alongside the primary studio
// (One Piece: Toei main + Magic Bus + TAP + Mushi as outsourcing).
// Confidence in a show's score, 0..1. Higher = more signal sources
// agreeing, lower = thinner data. Surfaces on the card so the user
// can read "engine is sure about this 8.2" vs "engine guessed an 8.2
// from sparse data — could really be 7.5–8.9." Inputs:
//   entry — AL projected entry (tag count, _matchConfidence)
//   userShape — non-null when user has watch history for this show
//   hasReactionOverlay — true when reactions touched any of this
//     show's tags (reaction signal locked in)
//   crCFAvailable — CR ranks this show on user's personal recs
//   crAvgAvailable — CR community rating exists for this show
function computeConfidence({ entry, userShape, hasReactionOverlay, crCFAvailable, crAvgAvailable }) {
  let conf = 0.40; // baseline — every entry has some match data
  const tagCount = (entry?.tags?.length || 0) + (entry?.genres?.length || 0);
  if (tagCount >= 12) conf += 0.20;
  else if (tagCount >= 8) conf += 0.13;
  else if (tagCount >= 4) conf += 0.06;
  if (entry?._matchConfidence === 'verified') conf += 0.15;
  else if (entry?._matchConfidence === 'unverified-best-guess') conf += 0.05;
  if (userShape) conf += 0.10;
  if (crCFAvailable) conf += 0.05;
  if (crAvgAvailable) conf += 0.03;
  if (hasReactionOverlay) conf += 0.05;
  return Math.max(0, Math.min(1, +conf.toFixed(3)));
}

// Returns null when there's nothing scoring-ready (cold-start, post-
// clear, no tag/genre data on any cache entry). Wrapper treats null
// as "skip persistence."
export function scoreAllShowsImpl({ inputs, tasteVector, previousByAniListId, cfApply }) {
  const {
    aniListCache,
    bridgeCache,
    watchShapes,
    crWatchlist,
    crPersonalRecs,
    crSeriesMeta,
    userReactions,
    userRatings,
    studioCreatorIndex,
  } = inputs;
  // Pre-derive user max-totals per role across the index. One pass
  // here vs O(N) per-show inside the scoring loop.
  const creatorMaxes = studioCreatorIndex
    ? deriveCreatorMaxes(studioCreatorIndex)
    : null;
  const entries = Object.entries(aniListCache).filter(([, e]) =>
    e && ((e.tags?.length || 0) > 0 || (e.genres?.length || 0) > 0));
  if (!entries.length) return null;
  const watchShapeBySeries = watchShapes?.series || {};
  // Watchlist lookup map keyed by seriesId for O(1) checks. Items
  // store isFavorite + onWatchlist bits so the boost can scale with
  // commitment level (favorite > saved).
  const watchlistBySeries = {};
  for (const it of (crWatchlist?.items || [])) {
    if (it.seriesId) watchlistBySeries[it.seriesId] = it;
  }
  // CR personalized-rec rank map. rank=1 → top of CR's list for this
  // user, rank=100+ → towards the bottom (or absent — see crCFScoreFor
  // below for how missing ranks resolve).
  const crCFRankBySeries = crPersonalRecs?.rankBySeries || {};
  const crCFTotal = (crPersonalRecs?.items?.length) || 0;
  const haveCrCF = crCFTotal > 0;

  // Build a reverse index keyed by AniList ID so buildFranchise can
  // walk relations across the cache. aniListCache is keyed by CR
  // series ID, but franchise relations use AniList IDs — without
  // this index the walk can't reach sibling seasons.
  //
  // Bridge cache is folded in too: rec-path enrichment fetches missing
  // intermediate seasons (Dr. Stone S1, Stone Wars, etc. that aren't
  // in user's history) and persists them under aniListBridgeCache. If
  // we built mediaById from aniListCache alone, allShowsScored entries
  // for franchises like Dr. Stone (where only S3 is watched) would
  // under-reach to 2 TV seasons even after the bridge enrichment had
  // already pulled S1+S2+S4 — and the next computeAllShowsScored
  // pass would clobber the on-visit franchise fix. Merging here is
  // the single source of truth.
  const mediaById = {};
  for (const entry of Object.values(aniListCache)) {
    if (entry?.aniListId != null) mediaById[entry.aniListId] = entry;
  }
  for (const [id, m] of Object.entries(bridgeCache)) {
    if (!mediaById[id]) mediaById[id] = m;
  }

  // Pass 1a: augment entries with CR tags (AL ∪ CR namespace).
  const augmentedEntries = entries.map(([crSeriesId, e]) =>
    [crSeriesId, mergeCrTagsIntoEntry(e, crSeriesMeta[crSeriesId])]);

  // Pass 1b: score WITHOUT the reaction overlay first to derive each
  // reacted show's topTags. computeReactionOverlay needs to know which
  // tags each rated show matched on, so it can push/pull mass on the
  // right tag dimensions. Two-pass dance: score → derive overlay →
  // re-score with overlay-augmented vector. Cheap (~300 entries × 2
  // dot products = sub-100ms).
  // Score-cache adoption: prepare every show's tag-rank vector ONCE
  // and reuse the prep across all three scoring passes (base / overlay-
  // adjusted / main-loop). applyToTasteVector preserves tagImplications
  // (only `raw` is replaced), so the show's effectiveTagRanks are
  // identical regardless of which user vector we score against.
  // Cuts cache-iteration cost from ~3× full scoreShow per entry to
  // 1× prep + 2× cheap dot-product (~150ms → ~60ms on the user's data).
  const sharedTagImpls = tasteVector?.tagImplications || {};
  const preparedByIndex = augmentedEntries.map(([, e]) => prepareShow(e, sharedTagImpls));

  // Pass 1: score against the base taste vector to derive
  // baseTopTagsByAniListId for the reaction-overlay derivation.
  const baseTopTagsByAniListId = {};
  const baseRawScores = [];
  for (let i = 0; i < augmentedEntries.length; i++) {
    const [, e] = augmentedEntries[i];
    const result = scorePreparedShow(preparedByIndex[i], tasteVector);
    baseRawScores.push(result.score);
    if (e.aniListId != null) {
      baseTopTagsByAniListId[e.aniListId] = { topTags: result.matched };
    }
  }
  const reactionOverlay = computeReactionOverlay(userReactions, baseTopTagsByAniListId);
  const overlayHasSignal = Object.keys(reactionOverlay).length > 0;
  // Apply the overlay through the shared feedback-overlay seam so
  // off-pool scoring and rec-pool ranking see the exact same
  // reaction-derived tag deltas. Falls through to the base vector
  // when no reactions exist (composeFeedback returns the input
  // unchanged for empty adapter overlays).
  const offPoolFeedback = composeFeedback([reactionOverlayAdapter(reactionOverlay)]);
  const effectiveTaste = offPoolFeedback.applyToTasteVector(tasteVector);
  if (overlayHasSignal) {
    console.log(`[crsmart] all-shows-scored: ${Object.keys(reactionOverlay).length} reaction-derived tag deltas applied to off-pool scoring`);
  }

  // Pass 2: score against the overlay-adjusted vector. Captures the
  // full result so the main loop below doesn't need a third scoreShow
  // call against the same vector — previously Pass 2 + main both
  // computed scoreShow(entry, effectiveTaste) and discarded fields,
  // which was ~30ms of redundant work per recompute.
  const effectiveResultByIndex = preparedByIndex.map(p =>
    scorePreparedShow(p, effectiveTaste));
  const rawScores = effectiveResultByIndex.map(r => r.score);
  const primaryArchetypeByEntry = effectiveResultByIndex.map(r => {
    const fits = Object.entries(r.showArchetypeFit || {})
      .sort((a, b) => b[1] - a[1]);
    const top = fits[0];
    return top && top[1] >= 0.15 ? top[0] : null;
  });

  // Build per-archetype min/max tables. Each show's lane-relative
  // percentile is normalized only against other shows whose primary
  // archetype matches. Shifts MHA from "60th percentile across your
  // entire library" to "85th percentile among Mainstream Shounen" —
  // same raw score, different framing. Surface the higher of the
  // two so users get the most generous honest read.
  const laneScores = {}; // archId → number[]
  for (let i = 0; i < primaryArchetypeByEntry.length; i++) {
    const arch = primaryArchetypeByEntry[i];
    if (!arch) continue;
    if (!laneScores[arch]) laneScores[arch] = [];
    laneScores[arch].push(rawScores[i]);
  }
  const laneStats = {};
  for (const [arch, scores] of Object.entries(laneScores)) {
    if (scores.length < 3) continue; // too few peers — skip
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    laneStats[arch] = { min, max, range: Math.max(0.001, max - min), count: scores.length };
  }
  // Cache-wide percentile mapper for tasteScore. Replaces the previous
  // min-max (tasteScore - minS) / range. Outlier-resistant; same value
  // across surfaces (rec-pool side panel and off-pool on-page card).
  // Persisted alongside allShowsScored so rank-recommendations can use
  // the same mapper for cross-surface consistency.
  const tastePercentileMapper = buildPercentileMapper(rawScores);

  // Score blend for off-pool. Sum to 1.0. Three axes: taste, crCF,
  // qual. Creator-affinity is applied as an additive LIFT on
  // finalScore (see below) — not stacked into the blend. The lift
  // pattern matches the rating boost: asymmetric, only-up, capped.
  // Earlier I tried treating creator as a 4th blend axis at 0.15
  // weight, but that systematically lowered scores on shows by
  // good-but-not-#1 teams (Frieren by MADHOUSE dropped 8.9 → 8.1
  // because MADHOUSE normalized below the user's max studio). The
  // additive-lift design lifts trusted teams without penalizing
  // unfamiliar ones — closer to friend voice.
  const W_TASTE = haveCrCF ? 0.50 : 0.55;
  const W_QUAL  = haveCrCF ? 0.35 : 0.45;
  const W_CRCF  = haveCrCF ? 0.15 : 0;

  // Map a CR rank (1..N) to a [0,1] score. Top of list = 1.0, bottom =
  // ~0.0. Linear decay across the returned list (typically 100 items).
  // Shows NOT in CR's list resolve to 0.5 (neutral, not penalized) so
  // niche/non-mainstream shows aren't punished for CR not picking them.
  const crCFScoreFor = (seriesId) => {
    if (!haveCrCF) return 0;
    const rank = crCFRankBySeries[seriesId];
    if (rank == null) return 0.5;
    return Math.max(0, 1 - (rank - 1) / Math.max(1, crCFTotal - 1));
  };

  // Behavioral taste boosts. Each one captures an explicit user signal
  // the tag-vector pipeline doesn't see directly:
  //   VERIFIED_FAVORITE_BONUS — the "friend recommender" signal. When a
  //     user has watched ≥90% of a show AND rewatched it, that's a
  //     verified personal favorite, not just a tag-fit prediction. A
  //     friend who knows your taste wouldn't say "JJK > MHA because
  //     tag-vector cosine 0.06 better" — they'd say "you watched all
  //     178 MHA eps + keep rewatching, that's YOUR show, full stop."
  //     Apply +0.20 on top of the rewatch boost when the trifecta
  //     hits. Pulls confirmed favorites near the top of their tier
  //     even when their tag profile is broad-genre rather than
  //     distinctive (MHA's "Action+Adventure" vs JJK's "Drama+Magic").
  //   REWATCH boost — depth-scaled. Base 0.10 + 0.005 × rewatchedCount,
  //     capped at 0.30. A user who's rewatched 19 MHA episodes (deep
  //     re-engagement) gets +0.195; a user with 5 rewatched JJK eps
  //     (light re-engagement) gets +0.125.
  //   CROSS_AUDIO_REWATCH_BONUS — extra +0.05 when the rewatch was in a
  //     DIFFERENT audio track (sub→dub or dub→sub). Reinvesting attention
  //     in a different language is a stronger commitment than replaying
  //     the same audio; it's the difference between "comfort replay"
  //     and "new appreciation pass."
  //   FAVORITE_TASTE_BOOST — explicit ★ on the CR watchlist; even
  //     stronger than rewatched because it requires a deliberate UI
  //     action separate from "play episode again."
  //   WATCHLIST_TASTE_BOOST — saved-but-not-watched intent. Smaller
  //     than rewatched because it's "I want to watch" not "I watched
  //     and loved", but still a positive signal worth surfacing.
  // Boosts stack additively, capped at 1.0 by Math.min below. A show
  // that's a verified favorite cross-audio AND ★ favorited AND deeply
  // rewatched hits the cap quickly — that's the right shape (your top
  // 5 all-time should saturate near 10/10).
  const VERIFIED_FAVORITE_BONUS = 0.20;
  const VERIFIED_FAVORITE_COMPLETION_THRESHOLD = 0.90;
  const REWATCH_BASE_BOOST = 0.10;
  const REWATCH_PER_EP = 0.005;
  const REWATCH_BOOST_CAP = 0.30;
  const CROSS_AUDIO_REWATCH_BONUS = 0.05;
  const FAVORITE_TASTE_BOOST = 0.20;
  const WATCHLIST_TASTE_BOOST = 0.10;
  // Direct per-show rating boost. Distinct from the rating's effect on
  // the user's taste vector (which shifts mass toward the show's tags
  // and thus boosts SIMILAR shows). This boost lifts the rated show
  // ITSELF so the user sees an immediate score change after clicking
  // 👍 — closes the "I rated it but the score didn't move" UX gap.
  // G05: rating overrides act as floor/ceiling on the CALIBRATED
  // finalScore (post-calibration pass), per PRD-SCORING-PHILOSOPHY
  // §Override mechanics. Replaces the previous delta-in-raw-blend
  // approach (RATING_LIKE_BOOST / RATING_DISLIKE_PENALTY) — stated
  // overrides inferred via clamp, not bias. The user told you yes
  // → score lands in WORTH A SHOT minimum regardless of engine read.
  // The user told you no → score lands in confident SKIP.
  //
  // Tunables (philosophy doc):
  //   RATING_PLUS_FLOOR    = 0.75 (display 7.5, WORTH A SHOT minimum)
  //   RATING_MINUS_CEILING = 0.30 (display 3.0, deep SKIP)
  const RATING_PLUS_FLOOR = 0.75;
  const RATING_MINUS_CEILING = 0.30;

  const allShowsScored = {};
  // Inner instrumentation — allShowsScored is the dominant cost (per
  // outer timing data) but we don't yet know which sub-step of the
  // per-entry loop dominates. Bucket the per-entry costs to find
  // out. franchiseTime tracks buildFranchise calls (skipped on
  // rating signal); creatorTime tracks creatorAffinityScore;
  // confidenceTime tracks computeConfidence; loopOverhead is
  // everything else inside the loop body.
  const innerTimings = { franchise: 0, creator: 0, confidence: 0, score: 0, persist: 0 };
  const innerT0 = performance.now();
  for (let i = 0; i < entries.length; i++) {
    const [crSeriesId, entry] = entries[i];
    // Use the augmented entry (AL + CR tags merged) for scoring, so
    // matched/archetypeBreakdown reflect the union. The original entry
    // (without CR augmentation) still drives display fields below
    // (title, coverImage, etc.) since those weren't touched by the
    // merge.
    const augmentedEntry = augmentedEntries[i][1];
    // Reuse the result we already computed in Pass 2 — same entry, same
    // vector, deterministic function. Saves a third scoreShow call per
    // entry (~30ms cache-wide).
    const { score: tasteScore, matched, topAntiTags, archetypeBreakdown, showArchetypeFit } = effectiveResultByIndex[i];
    const tasteNRaw = mapToPercentile(tasteScore, tastePercentileMapper);
    // Lane-relative percentile: normalize against same-archetype peers
    // only. Surfaced as a separate sub-score so the math row can show
    // both reads ("60th percentile cache-wide · 85th in lane") and the
    // card's pitch can use whichever frames the show more honestly.
    const primaryArch = primaryArchetypeByEntry[i];
    const lane = primaryArch ? laneStats[primaryArch] : null;
    const tasteNInLane = lane
      ? +((tasteScore - lane.min) / lane.range).toFixed(3)
      : null;
    const userShape = watchShapeBySeries[crSeriesId] || null;
    const wlEntry = watchlistBySeries[crSeriesId] || null;
    const isRewatched = userShape?.isRewatched === true;
    const crossAudioRewatch = userShape?.crossAudioRewatch === true;
    const rewatchedCount = userShape?.rewatchedEpisodes?.length || 0;
    const isFavorite = wlEntry?.isFavorite === true;
    const onWatchlist = !!wlEntry;
    let boostApplied = 0;
    let rewatchBoost = 0;
    let verifiedFavorite = false;
    if (isRewatched) {
      // Depth-scaled rewatch boost: each rewatched episode adds a
      // small amount on top of the base, so a 19-ep MHA rewatch
      // (deep re-engagement) outranks a 5-ep JJK rewatch even when
      // both are "isRewatched: true". Cross-audio bonus stacks on
      // top because that's a fundamentally different signal class
      // (re-experiencing in a different language vs replaying the
      // same audio). Total cap ≈ 0.35 even with all bonuses; the
      // outer Math.min(1, ...) covers stacking with favorite/
      // watchlist boosts beyond that.
      rewatchBoost = Math.min(REWATCH_BOOST_CAP,
        REWATCH_BASE_BOOST + REWATCH_PER_EP * rewatchedCount)
        + (crossAudioRewatch ? CROSS_AUDIO_REWATCH_BONUS : 0);
      boostApplied += rewatchBoost;
      // Verified favorite: ≥90% completed AND rewatched. This is the
      // "friend mental model" — when a user has watched essentially
      // everything AND keeps coming back, the engine should treat
      // that as a confirmed top-tier pick rather than re-litigating
      // tag-fit prediction. Pulls MHA-shape broad-genre favorites up
      // even when JJK-shape distinctive-tag matches score higher in
      // raw cosine.
      const completion = userShape?.completionRatio;
      if (typeof completion === 'number' && completion >= VERIFIED_FAVORITE_COMPLETION_THRESHOLD) {
        verifiedFavorite = true;
        boostApplied += VERIFIED_FAVORITE_BONUS;
      }
    }
    if (isFavorite) boostApplied += FAVORITE_TASTE_BOOST;
    else if (onWatchlist) boostApplied += WATCHLIST_TASTE_BOOST;
    const tasteN = boostApplied !== 0
      ? Math.max(0, Math.min(1, tasteNRaw + boostApplied))
      : tasteNRaw;
    const qualN = typeof entry.averageScore === 'number' && entry.averageScore > 0
      ? entry.averageScore / 100 : 0.5;
    const crCF = crCFScoreFor(crSeriesId);
    const crCFRank = crCFRankBySeries[crSeriesId] || null;

    // Creator-affinity score: how much the user trusts the team
    // behind THIS show. Independent of tag-shape match. Returns 0.5
    // (neutral) when the user has no history with the show's team
    // OR when the index isn't ready yet. Prevents unknown teams
    // from dragging the score (unknown ≠ bad).
    const _creatorT0 = performance.now();
    const creatorAffinity = (studioCreatorIndex && creatorMaxes)
      ? creatorAffinityScore(
          preferMainAnimationStudios(entry.studios),
          (entry.staff || []).filter(s => s.id != null).slice(0, 6),
          studioCreatorIndex, creatorMaxes)
      : { score: 0.5, _components: {} };
    innerTimings.creator += performance.now() - _creatorT0;
    const creatorN = creatorAffinity.score;

    // Creator-affinity lift: only fires when creatorN is above neutral
    // (0.5 = cold-start / unknown). Max lift +0.05 for shows by the
    // user's most-trusted team. Asymmetric — unknown teams don't drag
    // the score (creatorN < 0.5 floors at 0). Lift formula + clamp
    // live in score-blender.js, shared with rank-recommendations.js
    // so the rec-pool and off-pool blends can't drift.
    //
    // Note (G05): rating signals no longer bias the raw blend here.
    // Ratings now apply as override floors/ceilings on the calibrated
    // finalScore in a post-pass below, per philosophy §Override
    // mechanics. Stated > inferred via clamp, not bias. Removing the
    // delta also keeps unrated shows' calibration percentiles honest —
    // their position in the catalog isn't influenced by what other
    // shows the user happened to rate.
    const finalScore = blendFinalScore([
      { value: tasteN, weight: W_TASTE },
      { value: qualN,  weight: W_QUAL  },
      { value: crCF,   weight: W_CRCF  },
    ], creatorN);

    // CR community average → audienceDelta. Positive = CR audience
    // (Western, simulcast-heavy) rates higher than AL community
    // (broader, more critical). Negative = AL critics liked it more
    // than CR fans. Card renders an "AUDIENCES DISAGREE" chip when
    // |delta| ≥ 15. Threshold is on a 100-pt scale.
    const crSeriesEntry = crSeriesMeta[crSeriesId];
    const crAvg = crSeriesEntry?.crAverageScore ?? null;
    const audienceDelta = (typeof crAvg === 'number' && entry.averageScore)
      ? +(crAvg - entry.averageScore).toFixed(1)
      : null;

    // Confidence — surfaces sparse-data picks. Inputs: tag richness,
    // AL match status, user-watch evidence, CR CF availability,
    // CR community rating, reaction overlay touching this show's tags.
    const showAniListId = entry.aniListId;
    const reactionTouchedThisShow = overlayHasSignal && showAniListId != null
      && Object.keys(reactionOverlay).some(tag =>
        (entry.tags || []).some(t => t?.name === tag) ||
        (entry.genres || []).includes(tag));
    const _confT0 = performance.now();
    const confidence = computeConfidence({
      entry,
      userShape,
      hasReactionOverlay: reactionTouchedThisShow,
      crCFAvailable: crCFRank != null,
      crAvgAvailable: typeof crAvg === 'number',
    });
    innerTimings.confidence += performance.now() - _confT0;

    // Build franchise upfront so qualityAxes can be franchise-aware
    // (G07): the per-season adaptationRisk is misleading for franchise
    // seasons (Mob Psycho 100 III at 12 eps looks rushed in isolation,
    // but franchise has 36+ eps to adapt — not actually a rush).
    const franchiseT0 = performance.now();
    const cachedFranchise = previousByAniListId && entry.aniListId != null
      && previousByAniListId[entry.aniListId];
    const builtFranchise = cachedFranchise
      ? previousByAniListId[entry.aniListId].franchise
      : buildFranchise(entry, mediaById);
    innerTimings.franchise += performance.now() - franchiseT0;
    const franchiseAwareQualityAxes = adjustQualityAxesForFranchise(
      entry.qualityAxes || null, builtFranchise);

    allShowsScored[crSeriesId] = {
      aniListId: entry.aniListId ?? null,
      title: entry.title || null,
      coverImage: entry.coverImage || null,
      siteUrl: entry.siteUrl || null,
      // Crunchyroll URL for click-through. Resolves from
      // entry.externalLinks (when present) or reconstructs from
      // crSeriesId. Cached entries without externalLinks fall
      // through to the reconstructed form — still works because
      // CR redirects slug-less URLs to the canonical page.
      crSiteUrl: crSiteUrlFor(entry, crSeriesId),
      tasteScore,
      recScore: 0, // no rec-pool signal for off-pool
      averageScore: entry.averageScore || 0,
      popularity: entry.popularity || 0,
      format: entry.format || null,
      seasonYear: entry.seasonYear || null,
      // startDate carries the year (and month/day) for shows AL flags
      // as non-seasonal — ONAs especially leave seasonYear null but
      // populate startDate.year. The card's commitmentLine falls back
      // to startDate.year when seasonYear is missing.
      startDate: entry.startDate || null,
      episodes: entry.episodes || null,
      status: entry.status || null,
      description: entry.description || null,
      source: entry.source || null,
      genres: entry.genres || [],
      // 20 entries (was 5) so the card's broad-genre filter has enough
      // non-genre tags + spoiler tags to fill the signed positive row.
      // matched is already capped at 20 by scoreShow.
      topTags: matched.slice(0, 20),
      topAntiTags,
      archetypeBreakdown,
      showArchetypeFit,
      sources: [],
      // Prefer main studios when AniList flags any (Toei is main on
      // One Piece even though Magic Bus / TAP / Mushi etc. also appear
      // as animation studios for outsourcing). Falls back to all
      // animation studios when no main is set (older AL entries).
      animationStudios: preferMainAnimationStudios(entry.studios),
      keyStaff: (entry.staff || []).filter(s => s.id != null).slice(0, 6),
      // Build franchise rollup using the reverse-indexed mediaById.
      // Returns null for shows with no relations in the cache
      // (genuinely single-season or relations-unwatched) — commitment
      // line falls back to single-season shape, which is correct.
      // On rating signal, reuse previous franchise data (rating-
      // invariant — derived from AniList relations only). Saves the
      // dominant per-entry cost (~1-2ms × 600 entries = ~1s).
      franchise: builtFranchise,
      qualityAxes: franchiseAwareQualityAxes,
      // finalScore initially holds the raw blended value. The post-
      // loop calibration pass below replaces it with the edge-anchored
      // hybrid calibrated value (see G01/G02 in PRD-GAP-AUDIT) and
      // moves the raw value to rawFinalScore. Two-pass needed because
      // calibration anchors against the full distribution, which we
      // can only build after every entry's raw score is known.
      finalScore,
      rawFinalScore: finalScore,
      subScores: {
        taste: +tasteN.toFixed(3),
        rec: 0,
        qual: +qualN.toFixed(3),
        crCF: haveCrCF ? +crCF.toFixed(3) : null,
        creator: +creatorN.toFixed(3),
      },
      // Non-null when crPersonalRecs is loaded; null pre-sync. Carries
      // both the score (already in subScores.crCF) and the raw rank so
      // the card can render "CR also picks this — ranked #N for you."
      crCFRank,
      // Surfaces the user's watch behavior for this show on the card.
      // Drives the "rewatched" / "★ favorite" / "on watchlist" chips
      // (only renders when the corresponding flag is true) and feeds
      // the boost-explanation tooltip on the math row.
      userWatchShape: userShape ? {
        isRewatched,
        crossAudioRewatch,
        rewatchedCount,
        verifiedFavorite,
        label: userShape.label || null,
        completionRatio: userShape.completionRatio ?? null,
        epsWatched: userShape.epsWatched ?? null,
        boostApplied: rewatchBoost + (verifiedFavorite ? VERIFIED_FAVORITE_BONUS : 0),
      } : null,
      userWatchlist: wlEntry ? {
        onWatchlist: true,
        isFavorite,
        addedAt: wlEntry.addedAt || null,
        boostApplied: isFavorite ? FAVORITE_TASTE_BOOST : WATCHLIST_TASTE_BOOST,
      } : null,
      // Score confidence in [0,1]. Card renders as a chip / opacity
      // treatment so user can read "engine is sure" vs "thin data".
      confidence,
      // Lane-relative percentile + the archetype it normalizes against.
      // Null when the show doesn't have a clear primary archetype or
      // its lane has fewer than 3 peers in the cache (too few to
      // normalize meaningfully). Card surfaces this alongside the
      // cache-wide tasteN so MHA reads "60th overall · 85th among
      // Mainstream Shounen" instead of just the demoted-feeling 60th.
      tasteNInLane,
      primaryArchetype: primaryArch,
      // CR community average + audience delta vs AL. Card renders an
      // "AUDIENCES DISAGREE" chip when |audienceDelta| ≥ 15.
      crAverageScore: crAvg,
      audienceDelta,
      // Flag so the card can render a subtle off-pool marker —
      // users should know this is a taste+quality-only score, no
      // community-rec-aggregation signal.
      offPool: true,
    };
  }

  // ── G01/G02: edge-anchored hybrid calibration of finalScore ──
  //
  // Until this pass runs, each entry's `finalScore` is the raw blended
  // value from the loop above (in [0, 1]). The action-threshold bands
  // from north-star Q5 (TRUST ME at display ≥9.0, SKIP at display ≤3.5,
  // etc.) require the user's top/bottom shows to actually populate
  // those bands — pure raw scores cluster mid-range and leave SKIP/
  // TRUST_ME underpopulated.
  //
  // Solution per PRD-SCORING-PHILOSOPHY §Calibration: anchor the
  // user's top 5% to ≥0.9 and bottom 5% to ≤0.35; middle 90% gets
  // linear percentile remap. Monotonic (sort order preserved); stretches
  // the distribution at the edges so band labels populate.
  //
  // Mapper is built across all valid finalScores (the user's full
  // scored catalog). Persisted alongside the existing tasteScore
  // mapper so the rec-pool path can apply the same calibration —
  // cross-surface consistency.
  const allRawFinals = Object.values(allShowsScored)
    .map(e => e.rawFinalScore)
    .filter(v => typeof v === 'number' && Number.isFinite(v));
  const finalScoreMapper = buildPercentileMapper(allRawFinals);
  for (const entry of Object.values(allShowsScored)) {
    if (typeof entry.rawFinalScore !== 'number') continue;
    const { calibrated, percentile } = calibrateFinalScore(
      entry.rawFinalScore, finalScoreMapper);
    entry.finalScore = calibrated;
    entry.finalScorePercentile = percentile;
  }

  // ── G05: rating override pass ──
  //
  // Stated overrides inferred (PRD-NORTH-STAR Q9c, philosophy
  // §Override mechanics). +1 rating clamps the calibrated finalScore
  // to a WORTH A SHOT minimum; -1 clamps to a deep-SKIP ceiling. The
  // friend trusts what you told them — the score must reflect it,
  // not just the side-panel hide-from-list filter we had before.
  //
  // Side-channel: store finalScoreOverride so downstream surfaces
  // (card UI, audit trail) can render "you rated this +1, that's
  // why it's WORTH A SHOT" instead of inventing a misleading WHY.
  if (userRatings && Object.keys(userRatings).length) {
    let overrideCount = 0;
    for (const entry of Object.values(allShowsScored)) {
      if (entry.aniListId == null) continue;
      const r = userRatings[entry.aniListId];
      if (r === '+1' && entry.finalScore < RATING_PLUS_FLOOR) {
        entry.finalScore = RATING_PLUS_FLOOR;
        entry.finalScoreOverride = '+1';
        overrideCount++;
      } else if (r === '-1' && entry.finalScore > RATING_MINUS_CEILING) {
        entry.finalScore = RATING_MINUS_CEILING;
        entry.finalScoreOverride = '-1';
        overrideCount++;
      }
    }
    if (overrideCount > 0) {
      console.log(`[crsmart] rating overrides applied to ${overrideCount} show(s)`);
    }
  }

  // ── CF re-ranker — attach per-entry fields after finalScore stabilizes ──
  //
  // Candidate 2 of architecture review (2026-05-15): allShowsScored is
  // the single writer of every scored entry; attaching cfDelta /
  // cfCosine / cfProvenance here means every downstream consumer
  // (lens-pipeline, sidepanel, popup, etc.) reads pre-computed CF
  // metadata off each entry. Previously each consumer that wanted
  // CF awareness had to thread cfApply through and recompute per
  // entry — sprawl + redundant cosines.
  //
  // North-star intact: finalScore is unchanged (already finalized by
  // calibration + G05 above). CF lives in sibling fields. Skipped
  // entirely when cfApply is null (CF off, init failed, no user vec).
  if (cfApply) {
    let cfAttachCount = 0;
    let cfNonZero = 0;
    for (const [crSeriesId, entry] of Object.entries(allShowsScored)) {
      const sourceTags = aniListCache[crSeriesId]?.tags || [];
      if (!attachCfDeltaTo(entry, entry.aniListId, sourceTags, cfApply)) continue;
      cfAttachCount++;
      if (entry.cfDelta) cfNonZero++;
    }
    console.log(`[crsmart] CF attached to ${cfAttachCount} entries (${cfNonZero} non-zero deltas)`);
  }

  // Data-quality validator — runs at the end of the scoring pass so
  // any entry with structural problems gets flagged before persistence.
  // Three categories of failure today (each one was caught in the
  // 2026-05-12 25-show walk):
  //   - emptyStudios: scored entry with no animationStudios. Card's
  //     "Made by" row falls back to nothing visible. SHOSHIMIN, Kimi
  //     wa Kanata triggered this.
  //   - formatEpsConflict: format=MOVIE but totalTvEps>0 (or vice
  //     versa). Drives "MOVIE · 8 eps" misformats. PSYCHO-PASS 3
  //     triggered this.
  //   - missingYear: no franchise.yearRange[0]. Card can't render a
  //     year pill.
  // Failures are summarized into a small { counts, sampleIds } object
  // for the asserts; full per-entry detail isn't persisted (would
  // bloat storage on a 600+ entry corpus).
  const dataQualityIssues = (() => {
    const counts = { emptyStudios: 0, formatEpsConflict: 0, missingYear: 0 };
    const sampleIds = { emptyStudios: [], formatEpsConflict: [], missingYear: [] };
    const SAMPLE_LIMIT = 10;
    for (const [id, e] of Object.entries(allShowsScored)) {
      if (!Array.isArray(e.animationStudios) || e.animationStudios.length === 0) {
        counts.emptyStudios++;
        if (sampleIds.emptyStudios.length < SAMPLE_LIMIT) sampleIds.emptyStudios.push(id);
      }
      const eps = e.franchise?.totalTvEps ?? 0;
      if (e.format === 'MOVIE' && eps > 0) {
        counts.formatEpsConflict++;
        if (sampleIds.formatEpsConflict.length < SAMPLE_LIMIT) sampleIds.formatEpsConflict.push(id);
      }
      const yr = e.franchise?.yearRange?.[0];
      if (yr == null) {
        counts.missingYear++;
        if (sampleIds.missingYear.length < SAMPLE_LIMIT) sampleIds.missingYear.push(id);
      }
    }
    const total = counts.emptyStudios + counts.formatEpsConflict + counts.missingYear;
    const entryCount = Object.keys(allShowsScored).length || 1;
    return {
      counts,
      sampleIds,
      total,
      entryCount,
      totalRatio: +(total / entryCount).toFixed(4),
      computedAt: Date.now(),
    };
  })();
  if (dataQualityIssues.total > 0) {
    console.log(`[crsmart] data-quality: ${dataQualityIssues.total} issues across ${dataQualityIssues.entryCount} entries — emptyStudios=${dataQualityIssues.counts.emptyStudios}, formatEpsConflict=${dataQualityIssues.counts.formatEpsConflict}, missingYear=${dataQualityIssues.counts.missingYear}`);
  }

  return {
    allShowsScored,
    tastePercentileMapper,
    finalScoreMapper,
    dataQualityIssues,
    reactionOverlayTagCount: overlayHasSignal ? Object.keys(reactionOverlay).length : 0,
    overlayHasSignal,
    entryCount: Object.keys(allShowsScored).length,
    innerTimings,
    innerT0,
  };
}
