// Per-show scoring + watch-history calibration. Pure, no chrome.* APIs.
//
// Score formula:
//   score(show) = dot(showTags, userTaste) / L2(showTags)
//
//   showTags = {tagName: rank/100} ∪ {genre: 1.0}
//   userTaste = tasteVector.raw
//
// We normalize by the show's L2 only, NOT the user's. True cosine would
// squash everything to 0.01-0.10 range and obscure which shows pop —
// this way scores read naturally in tag-mass units of user taste, while
// the show-side normalization keeps a 30-tag show from beating an 8-tag
// show by sheer count.
//
// Caveat for the calibration mode: the user's taste vector was BUILT
// from these same shows, so scoring history-against-self isn't a clean
// holdout — it's a "does the engine recover the shape it ingested?"
// sanity check, not a generalization test. A leave-one-out variant
// would be cleaner; not worth the cost yet.
//
// Spoiler tags INCLUDED by default. Earlier versions skipped them
// (privacy-by-default for "feels like" UI), but skipping silently
// drops ~20% of the per-show tag mass — JJK's Tragedy(92), Gore(82),
// Battle Royale(68), Body Swapping(65) and MHA's Tragedy(82), Gore(56),
// Yandere(62) all carry real taste-shape signal that disappeared from
// scoring. The display layer (content.js) has its own spoiler filter
// for the "Feels like" chips so the UI surface stays spoiler-safe;
// the *scoring* surface should see everything.
//
// ── Score caching seam ──────────────────────────────────────────────
//
// `scoreShow(show, userVector)` is the high-level facade. Internally
// it splits into:
//
//   prepareShow(show, tagImplications)
//     — Show-side prep: tag filtering, genre injection, implied-tag
//       expansion, archetype-fit cosine. Independent of user weights.
//       Pull this out once per show; reuse across multiple user
//       vectors (all/peak/comfort) for free.
//
//   scorePreparedShow(prepared, userVector)
//     — User-side scoring: dot product against userVector.raw, matched
//       list, per-archetype breakdown, topAntiTags. Cheap.
//
// Why split: persistDualModeRecommendations and computeAllShowsScored
// each call scoreShow multiple times against different vectors that
// share the SAME tagImplications (built once in buildTasteVectorPrep,
// reused across modes). Without the split, every call re-walks the
// show's tag list, rebuilds realTagRanks, redoes the implied-tag
// expansion, and recomputes showArchetypeFit — work that doesn't
// depend on which user vector is being matched. The split lets
// callers extract once + score against N vectors at ~1/3 the cost.

import { archetypeNorm, archetypeWeightsForTag, ARCHETYPES } from './archetypes.js';

// Build a per-id gate lookup once at module load so each per-show pass
// doesn't re-walk ARCHETYPES. Returns a function from realTagRanks →
// boolean for archetypes that defined a gate; archetypes without one
// always pass.
const ARCH_GATES = new Map();
for (const a of ARCHETYPES) if (typeof a.gate === 'function') ARCH_GATES.set(a.id, a.gate);

// Show-side preparation. Pure function of (show, tagImplications) —
// cacheable across multiple user-vector scoring calls within a
// single recompute (all three taste vectors share tagImplications
// from buildTasteVectorPrep).
//
// Returns the show's effective tag-rank vector (with implications
// expanded), plus its archetype-fit (which doesn't depend on user
// weights at all).
export function prepareShow(anilistEntry, tagImplications, options = {}) {
  const skipSpoilers = options.skipSpoilers ?? false;
  const tags = anilistEntry?.tags || [];
  const genres = anilistEntry?.genres || [];
  const tagImpls = tagImplications || {};

  // Genre-only fallback for rank-null tags (Q4 in 2026-05-02 grilling).
  // AniList's tag system has community-contributed `rank` values; some
  // shows have tags listed but with rank=null (community labelled but
  // didn't rate). Previously we dropped these entirely — losing real
  // signal for shows where common tags ("Ecchi", "Harem", "Bdsm") are
  // present but unranked. Now: if the tag is ALSO in the show's genres
  // array, skip it on the tag side (genre handles it at rank=100). If
  // the tag is NOT in genres, default to rank=50 (mid-strength weight)
  // so the signal survives without claiming high relevance.
  const NULL_RANK_DEFAULT = 50;
  const genreSet = new Set();
  for (const g of genres) if (g) genreSet.add(g);

  const realTagRanks = {};
  const spoilerByTag = {};
  // Tier S #2 (2026-05-12): preserve AniList category per tag so vibe
  // patterns can exclude cross-category contamination (e.g., 'anti-hero'
  // substring should not fire 'edgy' on Anti-Hero in Cast-Main Cast).
  // Genres get the synthetic category 'Genre'. Implied tags inherit
  // the category of the source tag they came from.
  const tagCategories = {};
  for (const tag of tags) {
    if (!tag?.name) continue;
    if (skipSpoilers && tag.isMediaSpoiler) continue;
    let rank = tag.rank;
    if (typeof rank !== 'number' || rank <= 0) {
      // Genre-side captures it at rank=100; skip the tag-side entry
      // to avoid double-counting.
      if (genreSet.has(tag.name)) continue;
      // Genuinely tag-only-with-no-rank — assign mid-strength default.
      rank = NULL_RANK_DEFAULT;
    }
    realTagRanks[tag.name] = rank;
    spoilerByTag[tag.name] = !!tag.isMediaSpoiler;
    if (tag.category) tagCategories[tag.name] = tag.category;
  }
  for (const g of genres) {
    if (g) {
      realTagRanks[g] = 100;
      tagCategories[g] = 'Genre';
    }
  }

  // Implied tags: when the show has tag T1 at high rank and the
  // co-occurrence map says T1 implies T2, project T2 onto the show
  // at fractional rank. Half-strength damping; RANK_GATE keeps weak
  // tags from spawning implications.
  const IMPLIED_DAMPING = 0.5;
  const RANK_GATE = 50;
  const effectiveTagRanks = { ...realTagRanks };
  const impliedFrom = {};
  for (const [t1, t1Rank] of Object.entries(realTagRanks)) {
    if (t1Rank < RANK_GATE) continue;
    const impls = tagImpls[t1] || [];
    for (const impl of impls) {
      if (realTagRanks[impl.tag] != null) continue;
      const impliedRank = t1Rank * impl.strength * IMPLIED_DAMPING;
      if (impliedRank > (effectiveTagRanks[impl.tag] || 0)) {
        effectiveTagRanks[impl.tag] = impliedRank;
        impliedFrom[impl.tag] = { fromTag: t1, strength: impl.strength };
        // Implied tag inherits source's category. Tier S #2 (2026-05-12).
        if (!tagCategories[impl.tag] && tagCategories[t1]) {
          tagCategories[impl.tag] = tagCategories[t1];
        }
      }
    }
  }

  // showL2 used by the scoring step — precompute now since it's
  // independent of user weights.
  let showL2sq = 0;
  for (const [, rank] of Object.entries(effectiveTagRanks)) {
    const r = rank / 100;
    if (r <= 0) continue;
    showL2sq += r * r;
  }
  const showL2 = Math.sqrt(showL2sq) || 1;

  // Show-archetype fit: cosine between archetype bundles and the
  // show's REAL tag ranks (no implied tags — implied is a user-cache
  // artifact, would corrupt the identity signal). Independent of
  // user vector entirely; cache once per show.
  let realL2sq = 0;
  const archDots = new Map();
  for (const [name, rank] of Object.entries(realTagRanks)) {
    const r = rank / 100;
    if (r <= 0) continue;
    realL2sq += r * r;
    const archEntries = archetypeWeightsForTag(name);
    if (!archEntries) continue;
    for (const { archId, weight } of archEntries) {
      archDots.set(archId, (archDots.get(archId) || 0) + weight * r);
    }
  }
  const realL2 = Math.sqrt(realL2sq) || 1;
  const showArchetypeFit = {};
  for (const [archId, dotVal] of archDots) {
    const archNorm = archetypeNorm(archId);
    if (dotVal > 0 && archNorm > 0) {
      // Apply the per-archetype gate before contributing to fit. A show
      // that lacks the archetype's defining tags (Mecha for the mecha
      // bundle, the Magic+School pair for magic-academy, etc.) gets
      // zeroed out regardless of how high the supporting tags rank.
      // See archetypes.js GATE comment for the why.
      const gate = ARCH_GATES.get(archId);
      if (gate && !gate(realTagRanks)) continue;
      showArchetypeFit[archId] = +(dotVal / (archNorm * realL2)).toFixed(4);
    }
  }

  return {
    realTagRanks,
    effectiveTagRanks,
    impliedFrom,
    spoilerByTag,
    tagCategories,
    showL2,
    showArchetypeFit,
  };
}

// User-side scoring against a prepared show. Cheap; just a dot
// product + matched-list build + archetype attribution.
export function scorePreparedShow(prepared, tasteVector) {
  const userRaw = tasteVector?.raw || {};
  const { effectiveTagRanks, realTagRanks, impliedFrom, spoilerByTag, tagCategories, showL2, showArchetypeFit } = prepared;
  const cats = tagCategories || {};

  let dot = 0;
  const matched = [];
  for (const [tagName, rank] of Object.entries(effectiveTagRanks)) {
    const r = rank / 100;
    if (r <= 0) continue;
    const u = userRaw[tagName] || 0;
    if (u !== 0) {
      dot += u * r;
      matched.push({
        tag: tagName,
        userWeight: +u.toFixed(2),
        rank: Math.round(rank),
        implied: impliedFrom[tagName] || null,
        isMediaSpoiler: !!spoilerByTag[tagName],
        category: cats[tagName] || null,
      });
    }
  }

  const score = dot / showL2;

  // Per-archetype contribution from the user-weighted matches.
  const archetypeBreakdown = {};
  for (const m of matched) {
    if (m.userWeight <= 0) continue;
    const archEntries = archetypeWeightsForTag(m.tag);
    if (!archEntries) continue;
    const tagShare = m.userWeight * (m.rank / 100);
    for (const { archId } of archEntries) {
      archetypeBreakdown[archId] = (archetypeBreakdown[archId] || 0) + tagShare;
    }
  }
  // Apply per-archetype gates against the show's real tag ranks. Same
  // discipline as showArchetypeFit above — a show without the
  // archetype's defining tags never accrues per-show breakdown weight,
  // even if the user happens to like supporting tags. Confirmed wins:
  // Mob Psycho (school + super power) no longer attributes to magic-
  // academy; AoT (action + military) no longer attributes to mecha.
  if (realTagRanks) {
    for (const k of Object.keys(archetypeBreakdown)) {
      const gate = ARCH_GATES.get(k);
      if (gate && !gate(realTagRanks)) delete archetypeBreakdown[k];
    }
  }
  for (const k of Object.keys(archetypeBreakdown)) {
    archetypeBreakdown[k] = +(archetypeBreakdown[k] / showL2).toFixed(3);
  }

  const topAntiTags = matched
    .filter(m => m.userWeight < 0)
    .sort((a, b) => (a.userWeight * a.rank) - (b.userWeight * b.rank))
    .slice(0, 8);

  return {
    score: +score.toFixed(3),
    matched: matched
      .sort((a, b) => b.userWeight * b.rank - a.userWeight * a.rank)
      .slice(0, 20),
    topAntiTags,
    archetypeBreakdown,
    showArchetypeFit,
  };
}

// High-level facade — preserves the old API so existing callers stay
// unchanged. New callers that want to amortize prep across multiple
// user vectors should call prepareShow + scorePreparedShow directly.
export function scoreShow(anilistEntry, tasteVector, options = {}) {
  const tagImplications = tasteVector?.tagImplications || {};
  const prepared = prepareShow(anilistEntry, tagImplications, options);
  return scorePreparedShow(prepared, tasteVector);
}

// Calibration: score every series in the user's history that has an
// AniList entry, bucket by watch-shape label, report bucket medians.
// If completed-median > dropped-median by a comfortable margin, the
// engine is discriminating; if they're indistinguishable, the taste
// vector isn't carrying real preference signal.
//
// Filters out unscorable entries (no tags AND no genres — usually a
// failed AniList match) before bucketing, so medians reflect real
// signal rather than match-coverage. Reports skipped count separately.
export function scoreWatchHistory(watchShapes, aniListCache, tasteVector, options = {}) {
  const series = watchShapes?.series || {};
  const ranked = [];
  let skippedNoCache = 0;
  let skippedNoData = 0;
  for (const [seriesId, shape] of Object.entries(series)) {
    const al = aniListCache?.[seriesId];
    if (!al) { skippedNoCache++; continue; }
    const hasData = (Array.isArray(al.tags) && al.tags.length > 0)
      || (Array.isArray(al.genres) && al.genres.length > 0);
    if (!hasData) { skippedNoData++; continue; }
    const { score, matched, archetypeBreakdown } = scoreShow(al, tasteVector, options);
    ranked.push({
      seriesId,
      title: al.title?.english || al.title?.romaji || al.title?.native || null,
      label: shape.label,
      completionRatio: shape.completionRatio ?? null,
      score,
      matched,
      archetypeBreakdown,
    });
  }
  ranked.sort((a, b) => b.score - a.score);

  const buckets = {};
  for (const r of ranked) (buckets[r.label] ||= []).push(r.score);
  const bucketStats = {};
  for (const [label, scores] of Object.entries(buckets)) {
    scores.sort((a, b) => a - b);
    const at = (q) => scores[Math.min(scores.length - 1, Math.floor(scores.length * q))];
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    bucketStats[label] = {
      n: scores.length,
      mean: +mean.toFixed(2),
      median: +at(0.5).toFixed(2),
      p25: +at(0.25).toFixed(2),
      p75: +at(0.75).toFixed(2),
    };
  }

  return { ranked, bucketStats, skipped: { noCache: skippedNoCache, noData: skippedNoData } };
}
