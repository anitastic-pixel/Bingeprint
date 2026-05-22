// G13-deep + new-lens shipping: lens runner that produces ranked
// candidate lists for each lens definition in lens-registry.js.
// Pure module, no chrome.* APIs.
//
// DESIGN NOTE: new lenses (In the Air, From People You Trust, Take
// a Chance, Canon, Try Again) source from `allShowsScored` (which
// already has per-show calibrated finalScore from G01/G02), filter
// by lens-specific predicates, sort by score, and optionally
// diversify. No rescoring. This honors north-star Q7 (one canonical
// score per show) — lenses are SELECTION, not RESCORING.
//
// The existing peak/comfort lenses still flow through
// rankRecommendations because they score against vectorPeak /
// vectorComfort respectively (which differs from vectorAll-based
// allShowsScored). Eventually those collapse into this same
// pattern but it's a bigger refactor; deferred.

import { diversifyRanked } from './diversify-recs.js';
import { attachCfDeltaTo, cfRankingScore } from './cf-context.js';

const PER_LENS_TOP_N = 60;

// Filter predicate per lens. Each returns true if the show qualifies
// for that lens. Pure functions of (entry, state).
//
// state shape:
//   allShowsScored: { [crSeriesId]: scoredEntry }
//   watchShapes: { series: { [crSeriesId]: { label, ... } } }
//   studioCreatorIndex: { studios: {...}, creators: {...} }
//   creatorMaxes: derived from studioCreatorIndex
//   archetypeBlend: [{ id, score, ... }] — user's archetype scores
const LENS_PREDICATES = {
  // In the Air: currently-airing shows that match the user's taste.
  // Filter on AniList status; the underlying calibrated finalScore
  // already encodes taste-fit, so a high-finalScore RELEASING show
  // IS the airing thing in the user's wheelhouse. Floor lowered from
  // 0.55 to 0.45 — empirical: the airing pool is small in any given
  // season (~10-30 shows in the user's allShowsScored) and the
  // stretch-band cutoff was making the lens dead-end with <10 picks
  // for users without major airing overlap.
  // Watched-exclusion added 2026-05-15 night: discovery lenses must
  // not surface shows the user already engaged with (parity with the
  // other discovery predicates). Franchise-sibling expansion in
  // buildLensState catches "watched S1, S2 is now airing" cases.
  'in-the-air': (entry, state) => {
    if (state.userWatchedAniListIds?.has(entry.aniListId)) return false;
    if (entry.status !== 'RELEASING') return false;
    return (entry.finalScore || 0) >= 0.45;
  },

  // From People You Trust: shows by studios/creators in the user's
  // top affinity tier. Diversify is OFF (concentration is the point).
  // Annotates the entry with _trustedMatches so the side panel's
  // lens-why line can show the actual trusted names + an honest
  // "+N more" count instead of slicing animationStudios blindly.
  'from-people-you-trust': (entry, state) => {
    if (state.userWatchedAniListIds?.has(entry.aniListId)) return false;
    const trustedStudios = state.trustedStudioIds;
    const trustedCreators = state.trustedCreatorIds;
    if (!trustedStudios?.size && !trustedCreators?.size) return false;
    const studioMatches = (entry.animationStudios || [])
      .filter(s => s?.id != null && trustedStudios?.has(s.id))
      .map(s => s.name)
      .filter(Boolean);
    const creatorMatches = (entry.keyStaff || [])
      .filter(s => s?.id != null && trustedCreators?.has(s.id))
      .map(s => s.name)
      .filter(Boolean);
    if (!studioMatches.length && !creatorMatches.length) return false;
    entry._trustedMatches = { studios: studioMatches, creators: creatorMatches };
    return true;
  },

  // Take a Chance: STRETCH-band shows in archetypes OUTSIDE the user's
  // top 3 lanes. The friend's "trust me, branch out" pile.
  'take-a-chance': (entry, state) => {
    if (state.userWatchedAniListIds?.has(entry.aniListId)) return false;
    const score = entry.finalScore || 0;
    if (score < 0.50 || score > 0.78) return false; // STRETCH-ish band
    if (!entry.primaryArchetype) return false;
    if (state.userTopArchetypes?.has(entry.primaryArchetype)) return false;
    return true;
  },

  // Canon You've Missed: high-quality unwatched shows. AniList
  // averageScore >= 78 (community-loved; loosened from 80 to widen
  // the pool), user hasn't watched, calibrated taste-fit at least
  // 0.45 (loosened from 0.55 — we still want shows aligned with the
  // user's taste, but the prior cutoff was producing 15-20 picks for
  // most users, which felt thin. Lower threshold + average-score
  // filter together still keep the lens honest about quality).
  'canon': (entry, state) => {
    if (state.userWatchedAniListIds?.has(entry.aniListId)) return false;
    if ((entry.averageScore || 0) < 78) return false;
    if ((entry.finalScore || 0) < 0.45) return false;
    return true;
  },

  // Try Again: shows the user dropped where current calibrated taste-fit
  // is high. Approximation of "taste evolved toward this." MVP scope:
  // surfaces dropped shows with finalScore >= 0.65 today. A deeper
  // version would compare current vector to a snapshot at drop-time
  // (requires historical taste-vector storage which doesn't exist).
  'try-again': (entry, state) => {
    const crSeriesId = entry._crSeriesId;
    const shape = crSeriesId ? state.watchShapes?.series?.[crSeriesId] : null;
    if (!shape) return false;
    const isDrop = shape.label === 'dropped-early' || shape.label === 'dropped-mid';
    if (!isDrop) return false;
    return (entry.finalScore || 0) >= 0.65;
  },

  // Rewatched: shows the user completed and came back to. The act of
  // rewatching is itself the signal — no finalScore floor (the user
  // explicitly wants to see his rewatch canon regardless of where the
  // engine ranks each show today). Sort still uses finalScore so the
  // "strongest" rewatches surface first.
  'rewatched': (entry, state) => {
    const crSeriesId = entry._crSeriesId;
    const shape = crSeriesId ? state.watchShapes?.series?.[crSeriesId] : null;
    if (!shape) return false;
    return shape.isRewatched === true;
  },
};

// Build derived state once per recompute — used by predicates so each
// lens doesn't rebuild the same lookup tables.
function buildLensState({ allShowsScored, watchShapes, studioCreatorIndex, archetypeBlend, aniListCache }) {
  // Set of aniListIds the user has watched (any label except 'unknown').
  // Seed from the user's CR history → AL ID mapping.
  const userWatchedAniListIds = new Set();
  if (watchShapes?.series) {
    for (const [crSeriesId, shape] of Object.entries(watchShapes.series)) {
      const entry = allShowsScored[crSeriesId];
      if (entry?.aniListId != null && shape?.label && shape.label !== 'unknown') {
        userWatchedAniListIds.add(entry.aniListId);
      }
    }
  }
  // Franchise-sibling expansion: the AL ID a CR series maps to is only
  // ONE node in the franchise (e.g. Mushoku Tensei CR ID resolves to
  // S1 Cour 1, ID 108465). When AniList recommends Mushoku S2 (ID
  // 146065) from a watched neighbor, the per-AL-ID watched-check
  // misses it and the show surfaces as a "new rec" even though the user
  // has watched the franchise. Walk relations[] on each watched
  // aniListCache entry and add PREQUEL/PARENT/SEQUEL/SIDE_STORY AL
  // IDs to the watched set. Reads from aniListCache because
  // allShowsScored entries only carry the franchise rollup (member
  // titles + counts), not the raw relations[] array projection.
  if (aniListCache) {
    for (const entry of Object.values(aniListCache)) {
      if (!entry?.aniListId || !userWatchedAniListIds.has(entry.aniListId)) continue;
      for (const rel of (entry.relations || [])) {
        const sibId = rel?.node?.aniListId;
        if (!sibId) continue;
        const t = rel.type;
        if (t === 'PREQUEL' || t === 'PARENT' || t === 'SEQUEL' || t === 'SIDE_STORY') {
          userWatchedAniListIds.add(sibId);
        }
      }
    }
  }
  // Top trusted studios + creators by totalWeight. Read the
  // pre-computed top-N from the index (sorted at write time — see
  // studio-creator-index.js). Slice to the cardinalities this
  // pipeline actually uses (10 studios, 30 creators).
  const indexTopStudios = studioCreatorIndex?.topStudios || [];
  const indexTopCreators = studioCreatorIndex?.topCreators || [];
  const trustedStudioIds = new Set(indexTopStudios.slice(0, 10));
  const trustedCreatorIds = new Set(indexTopCreators.slice(0, 30));
  // User's top 3 archetypes by score (excludes the lanes "Take a Chance"
  // should AVOID; lens predicate inverts the membership check).
  // archetypeBlend is sorted desc by score by scoreArchetypes — see
  // archetypes.js's sortedness contract. No re-sort needed.
  const userTopArchetypes = new Set(
    (archetypeBlend || []).slice(0, 3).map(a => a.id)
  );
  return {
    allShowsScored,
    watchShapes,
    studioCreatorIndex,
    userWatchedAniListIds,
    trustedStudioIds,
    trustedCreatorIds,
    userTopArchetypes,
  };
}

// Run a single lens. Returns { ranked: [...top N projected entries],
// computedAt }. Returns null when the lens predicate is missing.
//
// state.cfApply (optional): closure (aniListId, tags) → { delta, cosine,
// provenance } built by background.js's buildCFApply. When present, each
// matched entry gets cfDelta/cfCosine/cfProvenance attached and the sort
// switches from finalScore to (finalScore + cfDelta). The displayed
// finalScore on each card is unchanged — only the rank order shifts.
// Mirrors the same seam in rank-recommendations.js so all lenses honor
// CF identically without duplicating math.
export function runLens(lens, state) {
  const predicate = LENS_PREDICATES[lens.id];
  if (!predicate) return null;
  const cfApply = state.cfApply || null;
  const matched = [];
  for (const [crSeriesId, e] of Object.entries(state.allShowsScored || {})) {
    if (!e) continue;
    // Stash the crSeriesId on the entry so predicates can use it (Try Again
    // needs to look up watchShapes by crSeriesId).
    const annotated = e._crSeriesId === crSeriesId ? e : { ...e, _crSeriesId: crSeriesId };
    if (predicate(annotated, state)) matched.push(annotated);
  }
  // CF re-rank seam: prefer pre-computed cfDelta on each entry (attached
  // by computeAllShowsScored — Candidate 2 of architecture review
  // 2026-05-15). Falls back to running cfApply per entry for any
  // entry that didn't carry pre-computed fields (first post-deploy
  // render before computeAllShowsScored re-fires; standalone callers).
  // Skipped when neither is available — defaults to pure-finalScore.
  const hasAnyCFData = matched.some(m => m.cfDelta !== undefined) || !!cfApply;
  if (hasAnyCFData) {
    for (const m of matched) {
      // Migration fallback: entry lacks pre-computed CF, run cfApply.
      // attachCfDeltaTo is a no-op when cfApply is null or returns
      // no info — same null-handling shape as the off-pool precompute
      // in background.js and the rec-pool fallback in
      // rank-recommendations.js.
      if (m.cfDelta === undefined) {
        attachCfDeltaTo(m, m.aniListId, m.tags || [], cfApply);
      }
    }
    matched.sort((a, b) => cfRankingScore(b) - cfRankingScore(a));
  } else {
    matched.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
  }
  let ranked = matched.slice(0, PER_LENS_TOP_N);
  if (lens.diversify !== false) {
    // Per-lens diversifyDepth override. take-a-chance benefits from
    // wider variety because its candidate pool (STRETCH-band picks
    // outside the user's top archetypes) is more homogeneous than
    // peak/comfort; default 6 was tuned when only those two lenses
    // existed.
    const depth = Number.isFinite(lens.diversifyDepth) ? lens.diversifyDepth : undefined;
    ranked = diversifyRanked(ranked, depth != null ? { depth } : undefined);
  }
  return { ranked, computedAt: Date.now() };
}

// Run all lenses with a given allShowsScored + auxiliary state. Returns
// an object keyed by lens ID with { ranked, computedAt }. Existing
// peak/comfort lenses skipped — they're handled by the legacy
// dual-mode rec pipeline because they score against different vectors.
//
// inputs.cfApply (optional) is threaded into state so every lens picks
// up CF re-ranking identically — matches rank-recommendations.js so a
// single buildCFApply() invocation feeds every recommendation surface.
export function runAllNewLenses(lenses, inputs) {
  const state = buildLensState(inputs);
  state.cfApply = inputs.cfApply || null;
  const out = {};
  const SKIP_LEGACY = new Set(['peak', 'comfort']);
  for (const lens of lenses) {
    if (SKIP_LEGACY.has(lens.id)) continue;
    const result = runLens(lens, state);
    if (result) out[lens.id] = result;
  }
  return out;
}
