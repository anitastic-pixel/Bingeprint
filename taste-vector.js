// Taste-vector aggregation — pure, no chrome.* APIs. Caller persists.
//
// Turns watch-shapes + AniList metadata into a single tag-weighted vector
// that represents "what kinds of shows does this user actually enjoy?"

import { ARCHETYPES, archetypeNorm } from './archetypes.js';
import { seriesSentiment } from './series-sentiment.js';

// Survey-tag-tap weight. Same magnitude as the show-survey dampening
// (_surveyOrigin in seriesWeightFor uses 0.6). Tag-taps are a deliberate
// preference statement (more focused than show-taps) but also more
// abstract (user might love "Magic" the concept but bounce off
// Frieren-flavored magic specifically). Net: same magnitude. Calibrate
// empirically once tap-data accumulates.
export const SURVEY_TAG_WEIGHT = 0.6;
//
// Weighting intentionally punishes tags that only come in via low-effort
// watches. A 5-of-1000 hype-sample of One Piece contributes ~5% of the
// Shounen signal a completed 12-ep Frieren cour does. Without this, any
// long-running series a user even glanced at dominates taste.
//
// Formula per series:
//   seriesWeight = labelFactor × completionFactor × rewatchBonus × qualityWeight
//
//   labelFactor   — how much this engagement shape should count at all
//                   (completed/in-progress = 1.0, paused = 0.3,
//                    dropped = 0.1, sampled = 0.05, unknown = 0)
//   completionFactor = sqrt(completionRatio)  when we have a ratio.
//                   sqrt so small samples count *something* (dropping a
//                   show at ep 3 is mild anti-signal, not zero) but a
//                   finished show dominates by ~5-10x, not 2x.
//   rewatchBonus  — going back to a show is strong preference signal.
//                   1.0 baseline, +0.05 per rewatched episode, capped 2x.
//   qualityWeight — AniList averageScore gates how loud this show speaks
//                   into the vector. Without it, dozens of comfort-food
//                   completions drown out a smaller cluster of peak shows
//                   the user actually loves. Tuned so peak (avgScore≥85)
//                   counts ~1.5x, mid (70-79) counts 1.0x, weak (<60) is
//                   a quiet 0.2x — but never zero, because we still want
//                   the comfort signal *for users in comfort mode*.
//                   Missing/null averageScore → 1.0 (don't penalize
//                   shows AniList just hasn't scored yet).
//
// Per-tag contribution: seriesWeight × (tag.rank / 100). AniList's rank
// is 0-100 user-voted "how much does this tag describe this show" — it's
// already the right denominator. Genres (no rank) count as rank=100.
//
// Spoiler tags are excluded by default (isMediaSpoiler: true).

// Per-series weight math relocated to series-sentiment.js — that's the
// seam where "how does the user feel about this series?" lives. We
// import seriesSentiment(shape, al) below and use it where this module
// used to inline `seriesWeightFor(shape) × qualityWeightFor(...)`.

// Build an aniListId-based franchise component map via union-find over
// PREQUEL/SEQUEL/PARENT/SIDE_STORY relations. Two CR series IDs map to
// the same franchise key iff they're connected through a chain of those
// relation types. Lets the taste-vector pass treat all watched seasons
// of a franchise as a single contribution rather than N independent
// ones — without this, a user who watched 9 MHA seasons appears 9× more
// shounen-shaped than a user who watched MHA once. Compresses binge
// depth, preserves taste breadth.
//
// Returns { [crSeriesId]: franchiseKey } where franchiseKey is the
// representative seriesId for the connected component.
const FRANCHISE_RELATION_TYPES = new Set([
  'PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY',
]);
function buildFranchiseGroupMap(aniListCache) {
  if (!aniListCache) return {};
  const aniListIdToCrId = {};
  for (const [crId, entry] of Object.entries(aniListCache)) {
    if (entry?.aniListId != null) aniListIdToCrId[entry.aniListId] = crId;
  }
  const parent = {};
  for (const crId of Object.keys(aniListCache)) parent[crId] = crId;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const [crId, entry] of Object.entries(aniListCache)) {
    if (!entry?.relations) continue;
    for (const edge of entry.relations) {
      if (!FRANCHISE_RELATION_TYPES.has(edge.type)) continue;
      const targetAniListId = edge.node?.aniListId;
      if (targetAniListId == null) continue;
      const targetCrId = aniListIdToCrId[targetAniListId];
      if (!targetCrId) continue;
      const ra = find(crId), rb = find(targetCrId);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const out = {};
  for (const crId of Object.keys(aniListCache)) out[crId] = find(crId);
  return out;
}

// Mode filter for dual-vector taste modeling (Stage 1d-c follow-up B).
// Returns true if the show's avgScore qualifies for the requested mode.
//   'all'     — no filter (legacy single-vector behavior)
//   'peak'    — avgScore >= peakThreshold (default 75)
//   'comfort' — avgScore < peakThreshold
// Shows with null/0 avgScore are included in BOTH modes — losing them
// because AniList hasn't scored them would silently shrink the vector.
function passesMode(averageScore, mode, peakThreshold) {
  if (mode === 'all') return true;
  if (averageScore == null || averageScore <= 0) return true;
  return mode === 'peak' ? averageScore >= peakThreshold : averageScore < peakThreshold;
}

// Category-aware tag weighting. AniList tags carry a category string
// like "Theme - Action", "Cast - Main Cast", "Demographic", "Setting -
// Universe". Theme and Setting tags name *what the show is about*
// (Time Loop, Magic Academy, Cyberpunk) — high-signal for taste
// matching. Demographic (Shounen, Seinen) and Cast-traits (Primarily
// Teen Cast, Female Protagonist) name *who the show is for* / *who's
// in it* — much coarser, present on hundreds of shows in any anime
// catalog, prone to dilution even after IDF.
//
// Damping coarse categories sharpens signal-vs-noise without zeroing
// the contribution: a user who watches mostly shounen still has
// Shounen as a positive vector tag, just with less per-tag mass than
// distinctive theme tags. Conservative multipliers chosen so MHA-shape
// favorites (heavy demographic/cast tags) don't dramatically drop —
// the rewatch boost in computeAllShowsScored covers the rest.
//
// Default 1.0 for any category not in the map (Theme, Setting,
// Technical, Genre, null).
const CATEGORY_WEIGHTS = {
  'Demographic':       0.5,
  'Cast-Main Cast':    0.7,
  'Cast-Traits':       0.85,
  'Sexual Content':    0.5,  // Often noisy / not taste-signal
};

function categoryWeightFor(category) {
  if (!category) return 1.0;
  // AniList categories use " - " as separator; normalize to "Cast-Main Cast"
  // shape so the lookup map stays readable.
  const key = String(category).replace(/\s*-\s*/g, '-').trim();
  return CATEGORY_WEIGHTS[key] ?? 1.0;
}

// Inverse-document-frequency over the user's aniListCache. A tag that
// shows up on 80% of series in the cache is non-distinctive; one that
// shows up on 5% is strong identity signal. idf = log((N+1)/(df+1)) +
// 1; the +1s keep rare tags from blowing up on small caches and the
// trailing +1 keeps common tags at weight ~1 instead of ~0.
//
// Without IDF, "Male Protagonist" and "Action" and "School" dominated
// the vector on any the user-sized shounen-heavy history — they were the
// loudest tags and they're present on half the catalog, so they drown
// out distinctive signals like "Magic Academy" or "Time Loop".
// Cheap per-show primary-archetype detection. Mirrors per-show-score.js's
// showArchetypeFit cosine-sim but inlined here so taste-vector building
// can bucket shows by archetype without a circular import. Returns the
// archetype id with the highest fit ≥ 0.15, or null when no archetype
// matches strongly enough to be the show's identity.
function primaryArchetypeOf(media, options = {}) {
  if (!media) return null;
  const skipSpoilers = options.skipSpoilers ?? false;
  const tagRanks = {};
  let l2sq = 0;
  for (const t of media.tags || []) {
    if (!t?.name) continue;
    if (skipSpoilers && t.isMediaSpoiler) continue;
    const r = typeof t.rank === 'number' ? t.rank / 100 : 0.5;
    if (r > 0) { tagRanks[t.name] = r; l2sq += r * r; }
  }
  for (const g of media.genres || []) {
    if (g) { tagRanks[g] = 1; l2sq += 1; }
  }
  if (l2sq === 0) return null;
  const showL2 = Math.sqrt(l2sq);
  let bestArch = null;
  let bestFit = 0;
  for (const arch of ARCHETYPES) {
    let fitDot = 0;
    for (const [tag, archWeight] of Object.entries(arch.tags)) {
      const r = tagRanks[tag];
      if (r > 0) fitDot += archWeight * r;
    }
    if (fitDot <= 0) continue;
    // Use the precomputed bundle norm — same constant on every call.
    const archL2 = archetypeNorm(arch.id);
    if (archL2 <= 0) continue;
    const fit = fitDot / (archL2 * showL2);
    if (fit > bestFit) { bestFit = fit; bestArch = arch.id; }
  }
  return bestFit >= 0.15 ? bestArch : null;
}

// Drop-attribution discriminative map. For each archetype, computes
// per-tag P(T | dropped) / P(T | completed). Tags that disproportionately
// appear in DROPPED shows of an archetype are the real anti-tags. Tags
// that appear evenly in both buckets are background co-occurrence and
// shouldn't get the full negative weight when a show is dropped.
//
// Without this, dropping a single Harem-Action show subtracts mass from
// BOTH 'Harem' and 'Action' tags equally — even though the dealbreaker
// was almost certainly Harem, not Action. The vector then drifts away
// from Action even for users who otherwise love Action shows.
//
// Returns: { [archId]: { [tagName]: discriminativeRatio } }
//   ratio ≥ 1.5 → real anti-tag (T appears 1.5x more in drops than
//                 completes within this archetype) → full penalty
//   ratio ~ 1.0 → neutral (T appears equally) → half penalty
//   ratio < 1.0 → tag is actually less common in drops, likely
//                 incidental → near-skip
function buildDropDiscriminativeMap(watchShapes, aniListCache, options = {}) {
  // Accept a pre-computed { [seriesId]: primaryArchetypeId } map so
  // callers building multiple vectors (peak/comfort/all) over the
  // same cache don't rebuild the cosine fit per-series N times.
  const primaryArchByCrId = options.primaryArchByCrId || null;
  const skipSpoilers = options.skipSpoilers ?? false;
  const archStats = {};
  for (const [seriesId, shape] of Object.entries(watchShapes?.series || {})) {
    const isCompleted = shape.label === 'completed' || shape.label === 'in-progress';
    const isDropped = shape.label === 'dropped-early' || shape.label === 'dropped-mid';
    if (!isCompleted && !isDropped) continue;
    const al = aniListCache?.[seriesId];
    if (!al) continue;
    const archId = primaryArchByCrId
      ? primaryArchByCrId[seriesId]
      : primaryArchetypeOf(al, { skipSpoilers });
    if (!archId) continue;
    if (!archStats[archId]) {
      archStats[archId] = {
        completed: {}, dropped: {}, totalCompleted: 0, totalDropped: 0,
      };
    }
    const stats = archStats[archId];
    const bucket = isCompleted ? 'completed' : 'dropped';
    if (isCompleted) stats.totalCompleted++;
    else stats.totalDropped++;
    const seen = new Set();
    for (const t of al.tags || []) {
      if (!t?.name || seen.has(t.name)) continue;
      seen.add(t.name);
      stats[bucket][t.name] = (stats[bucket][t.name] || 0) + 1;
    }
    for (const g of al.genres || []) {
      if (!g || seen.has(g)) continue;
      seen.add(g);
      stats[bucket][g] = (stats[bucket][g] || 0) + 1;
    }
  }
  const out = {};
  for (const [archId, stats] of Object.entries(archStats)) {
    if (stats.totalDropped < 2) continue; // not enough drops to derive signal
    out[archId] = {};
    const tagSet = new Set([
      ...Object.keys(stats.completed),
      ...Object.keys(stats.dropped),
    ]);
    for (const tag of tagSet) {
      const pComp = (stats.completed[tag] || 0) / Math.max(1, stats.totalCompleted);
      const pDrop = (stats.dropped[tag] || 0) / Math.max(1, stats.totalDropped);
      const ratio = pDrop / Math.max(0.01, pComp);
      out[archId][tag] = +ratio.toFixed(3);
    }
  }
  return out;
}

// Map a discriminative ratio to a multiplier on a dropped show's
// negative contribution. Real anti-tags keep their full penalty;
// neutral / under-represented tags get damped or near-skipped.
function dropAttenuationFor(discRatio) {
  if (discRatio == null) return 1;        // no archetype info → legacy behavior
  if (discRatio >= 1.5) return 1.0;       // real anti-tag — full penalty
  if (discRatio >= 1.0) return 0.5;       // neutral — half penalty
  return 0.1;                              // pro-tag-in-drops — near-skip
}

// G12: per-archetype overall completion rates. Derived from the same
// watchShapes pass that buildDropDiscriminativeMap uses. Returns
// { [archId]: completionRate } where rate = completed / (completed+dropped).
// Skipped for archetypes with < 5 total shows (not enough signal to
// trust). Used to scale drops by how SURPRISING they are in context:
// a drop in a normally-90%-completed archetype is louder than a drop
// in a normally-20%-completed archetype. See dropContextMultiplierFor.
//
// Reuses the same archStats counts that buildDropDiscriminativeMap
// computes — but exposed as a separate helper so the math is
// inspectable / testable independently. Negligible cost given the
// archStats hash is already populated.
export function buildArchCompletionRates(watchShapes, aniListCache, options = {}) {
  const primaryArchByCrId = options.primaryArchByCrId || null;
  const skipSpoilers = options.skipSpoilers ?? false;
  const counts = {};
  for (const [seriesId, shape] of Object.entries(watchShapes?.series || {})) {
    const isCompleted = shape.label === 'completed' || shape.label === 'in-progress';
    const isDropped = shape.label === 'dropped-early' || shape.label === 'dropped-mid';
    if (!isCompleted && !isDropped) continue;
    const al = aniListCache?.[seriesId];
    if (!al) continue;
    const archId = primaryArchByCrId
      ? primaryArchByCrId[seriesId]
      : primaryArchetypeOf(al, { skipSpoilers });
    if (!archId) continue;
    if (!counts[archId]) counts[archId] = { completed: 0, dropped: 0 };
    if (isCompleted) counts[archId].completed++;
    else counts[archId].dropped++;
  }
  const rates = {};
  for (const [archId, c] of Object.entries(counts)) {
    const total = c.completed + c.dropped;
    if (total < 5) continue;
    rates[archId] = +(c.completed / total).toFixed(3);
  }
  return rates;
}

// G12: drop context multiplier. Applied to a dropped show's negative
// tag-mass contributions on top of the existing per-tag dropAttenuation.
// Captures: a drop in an archetype where the user typically COMPLETES
// (rate ~0.9) is more meaningful than a drop where they typically DROP
// (rate ~0.2). Returns multiplier in [0.5, 1.5]:
//   completion_rate = 0.95 → 1.45 (loud — surprising drop)
//   completion_rate = 0.50 → 1.00 (neutral)
//   completion_rate = 0.20 → 0.70 (quiet — expected drop)
//   no data         → 1.00 (legacy behavior)
function dropContextMultiplierFor(completionRate) {
  if (completionRate == null) return 1;
  return Math.max(0.5, Math.min(1.5, 0.5 + completionRate));
}

// Tag co-occurrence implications, derived from the user's own cache.
// AniList's community tagging is honest but incomplete — MHA Season 7
// has Superhero(100), Super Power(95), Anti-Hero(53), Tragedy(82-spoiler)
// etc., but NO `Drama` tag despite obvious dramatic content. JJK has
// Drama(100) so it scores higher on the user's Drama-loving vector even
// though MHA is functionally just as dramatic for its viewers.
//
// Fix: derive tag implications from co-occurrence in the user's library.
// If 70% of cache shows tagged "Superhero" are ALSO tagged "Drama" at
// rank ≥50, then a Superhero show implies Drama at strength 0.7. Apply
// during scoring as supplemental fractional-rank tags — only fires
// when the show DOESN'T have the implied tag directly (no double-
// counting), at half strength so real tags still dominate.
//
// Self-tuning: the map reflects associations specific to this user's
// library shape, not generic anime taxonomy. Updates with every
// taste-vector recompute. No hand-curated map to maintain.
//
// Thresholds:
//   minSupport — tag T1 must appear in ≥5 cache shows before we trust
//     its implications (cuts noise from rare tags)
//   minStrength — implication only stored if P(T2|T1) ≥ 0.5 (majority
//     co-occurrence; weaker correlations would just add noise)
//   RANK_THRESHOLD = 50 — tags need rank ≥50 to count as "present" on a
//     show; below that the tag is background flavor not show identity
function buildTagImplicationMap(aniListCache, options = {}) {
  const skipSpoilers = options.skipSpoilers ?? false;
  const minSupport = options.minSupport ?? 5;
  const minStrength = options.minStrength ?? 0.5;
  const maxImplicationsPerTag = options.maxImplicationsPerTag ?? 8;
  const RANK_THRESHOLD = 50;

  // Pass 1: which shows carry which high-rank tags?
  const tagShowSets = {};
  const showHighRankTags = {};
  for (const [seriesId, m] of Object.entries(aniListCache || {})) {
    if (!m) continue;
    const tagged = new Set();
    for (const t of m.tags || []) {
      if (!t?.name) continue;
      if (skipSpoilers && t.isMediaSpoiler) continue;
      if ((t.rank || 0) < RANK_THRESHOLD) continue;
      tagged.add(t.name);
    }
    for (const g of m.genres || []) {
      if (g) tagged.add(g);
    }
    if (!tagged.size) continue;
    showHighRankTags[seriesId] = tagged;
    for (const tag of tagged) {
      if (!tagShowSets[tag]) tagShowSets[tag] = new Set();
      tagShowSets[tag].add(seriesId);
    }
  }

  // Pass 2: for each tag with enough support, count co-occurring tags
  const implications = {};
  for (const [t1, set1] of Object.entries(tagShowSets)) {
    if (set1.size < minSupport) continue;
    const counts = {};
    for (const seriesId of set1) {
      const tags = showHighRankTags[seriesId];
      if (!tags) continue;
      for (const t2 of tags) {
        if (t2 === t1) continue;
        counts[t2] = (counts[t2] || 0) + 1;
      }
    }
    const impls = [];
    for (const [t2, count] of Object.entries(counts)) {
      const strength = count / set1.size;
      if (strength >= minStrength) {
        impls.push({ tag: t2, strength: +strength.toFixed(3), support: set1.size });
      }
    }
    if (impls.length) {
      impls.sort((a, b) => b.strength - a.strength);
      implications[t1] = impls.slice(0, maxImplicationsPerTag);
    }
  }
  return implications;
}

function computeIdfMap(aniListCache, skipSpoilers = true) {
  const df = {};
  let N = 0;
  for (const entry of Object.values(aniListCache || {})) {
    if (!entry) continue;
    N++;
    const seen = new Set();
    for (const tag of entry.tags || []) {
      if (!tag?.name) continue;
      if (skipSpoilers && tag.isMediaSpoiler) continue;
      if (seen.has(tag.name)) continue;
      seen.add(tag.name);
      df[tag.name] = (df[tag.name] || 0) + 1;
    }
    for (const genre of entry.genres || []) {
      if (!genre || seen.has(genre)) continue;
      seen.add(genre);
      df[genre] = (df[genre] || 0) + 1;
    }
  }
  // G06: IDF clamp to match philosophy spec [0.5, 5.0]. Without
  // clamping, tags appearing in 1-2 shows out of ~600 produce IDF
  // values up to ~6.7 — genuine "rare tag" emphasis but volatile
  // (a single rare-tag show can dominate a user's vector). Clamp
  // bounds the runaway without changing behavior for common tags
  // (the clamp range covers all naturally-occurring values for
  // n in [2, N-1]). Smoothing (the +1 terms) is retained for
  // edge-case stability when freq=0 — clamp + smoothing together
  // are belt-and-suspenders.
  const idf = {};
  for (const [tag, freq] of Object.entries(df)) {
    const raw = Math.log((N + 1) / (freq + 1)) + 1;
    idf[tag] = Math.max(0.5, Math.min(5.0, raw));
  }
  return { idf, N };
}

// Mode-independent prep that all three vector modes (all/peak/comfort)
// share. Hoisting these out of computeTasteVector and passing them
// in via options.prep cuts the per-persist taste recompute work by
// ~2/3, since the inputs (cache, watchShapes) and outputs (idf,
// implications, franchise groups, drop-discriminative map, per-series
// primary archetype) don't depend on which mode-filter the
// per-series pass applies. Builds primaryArchByCrId first so
// buildDropDiscriminativeMap can reuse it instead of running the
// cosine-fit again.
// Pipeline-runner stage definition. Builds the mode-independent prep
// (idf, tag implications, franchise groups, drop-discriminative map,
// primary-archetype-by-cr-id) once per (watchShapes, aniListCache)
// version and persists it. Rating clicks don't touch any of these
// inputs, so the prep can be reused across recomputes — saves ~150ms
// of redundant rebuilding per rating-driven recompute. Cache invalidates
// only when watchShapes or aniListCache changes (history sync, AniList
// enrichment).
export const vectorPrepStage = {
  name: 'vectorPrep',
  inputs: ['watchShapes', 'aniListCache'],
  outputs: ['vectorPrep'],
  schema: 1,
  async run({ watchShapes, aniListCache }) {
    if (!watchShapes || !aniListCache) return { vectorPrep: null };
    const prep = buildTasteVectorPrep(watchShapes, aniListCache);
    return { vectorPrep: { ...prep, computedAt: Date.now() } };
  },
};

export function buildTasteVectorPrep(watchShapes, aniListCache, options = {}) {
  const skipSpoilers = options.skipSpoilers ?? false;
  const { idf } = computeIdfMap(aniListCache, skipSpoilers);
  const tagImplications = buildTagImplicationMap(aniListCache, { skipSpoilers });
  const franchiseGroups = buildFranchiseGroupMap(aniListCache);
  // Memoize primaryArchetypeOf per cache entry — used by both the
  // drop-discriminative map and the contribution loop, so caching it
  // here avoids the redundant cosine-fit pass that the previous
  // structure ran (once inside the drop map, once again in Pass 1).
  const primaryArchByCrId = {};
  for (const [crId, al] of Object.entries(aniListCache || {})) {
    if (al) primaryArchByCrId[crId] = primaryArchetypeOf(al, { skipSpoilers });
  }
  const dropDiscriminativeMap = buildDropDiscriminativeMap(
    watchShapes, aniListCache, { primaryArchByCrId, skipSpoilers }
  );
  // G12: per-archetype completion rates for drop-context multiplier.
  // Derived from the same watchShapes pass — sidecar to dropDiscriminativeMap.
  const archCompletionRates = buildArchCompletionRates(
    watchShapes, aniListCache, { primaryArchByCrId, skipSpoilers }
  );
  return {
    idf,
    tagImplications,
    franchiseGroups,
    dropDiscriminativeMap,
    archCompletionRates,
    primaryArchByCrId,
  };
}

export function computeTasteVector(watchShapes, aniListCache, options = {}) {
  // Spoiler tags now contribute to vector building by default. For the
  // SHOWS THE USER HAS WATCHED, "spoilers" aren't spoilers — the user
  // has experienced the tragedy, gore, character deaths, twists, etc.
  // Skipping them was throwing away ~20% of each show's tag mass that
  // genuinely informs taste. The display layer (popup taste readouts,
  // card "Feels like" chips) filters spoilers separately for UI surface.
  const skipSpoilers = options.skipSpoilers ?? false;
  const mode = options.mode ?? 'all';
  const peakThreshold = options.peakThreshold ?? 75;
  // Reuse caller-provided prep when available so multi-mode callers
  // (persistTasteVector running all/peak/comfort) don't recompute
  // mode-independent helpers three times. Falls back to building it
  // ourselves if the caller didn't pass one — keeps single-mode
  // callers working without orchestration changes.
  const prep = options.prep || buildTasteVectorPrep(watchShapes, aniListCache, { skipSpoilers });
  const { idf, tagImplications, franchiseGroups, dropDiscriminativeMap, archCompletionRates, primaryArchByCrId } = prep;
  const raw = {};
  const positiveRaw = {}; // absolute magnitude of + contributions, for distinctiveness triage
  const negativeRaw = {}; // absolute magnitude of − contributions
  const contributions = {};
  const perSeriesWeights = {};
  let contributingSeries = 0;
  let totalSeriesWithShape = 0;

  const seriesShapes = watchShapes?.series || {};

  // Pass 1: compute per-series weights (with quality + recency built in
  // via seriesWeightFor) and group by franchise. Counts positive-sign
  // contributing seasons per franchise so the loyalty multiplier below
  // can reward sustained engagement.
  const perSeriesPrep = []; // [{ seriesId, sw, al, fkey }]
  const franchisePositiveCount = {};
  // Explicit-feedback inputs threaded through to series-sentiment.
  // userRatings + userReactions are keyed by aniListId; watchlistBySeries
  // is keyed by crSeriesId (matches the watchlist-record's native shape).
  // externalScores is keyed by aniListId — { [aniListId]: { anilist?,
  // mal? } } populated by external-list-importer.js when the user
  // links their AL/MAL account.
  const userRatings = options.userRatings || null;
  const userReactions = options.userReactions || null;
  const watchlistBySeries = options.watchlistBySeries || null;
  const externalScores = options.externalScores || null;

  for (const [seriesId, shape] of Object.entries(seriesShapes)) {
    totalSeriesWithShape++;
    const al = aniListCache?.[seriesId];
    if (!passesMode(al?.averageScore, mode, peakThreshold)) continue;
    // sw is the per-series weight as it lands in the vector — sign-
    // bearing, can be negative for drops/samples. Sourced from the
    // series-sentiment seam (`{ signal, confidence }` post-Phase 2b).
    const userRating = (userRatings && al?.aniListId != null)
      ? userRatings[al.aniListId] : null;
    const reactionsForThisSeries = (userReactions && al?.aniListId != null)
      ? userReactions[al.aniListId] : null;
    const watchlistEntry = watchlistBySeries
      ? watchlistBySeries[seriesId] : null;
    const externalForThisSeries = (externalScores && al?.aniListId != null)
      ? externalScores[al.aniListId] : null;
    const { signal, confidence } = seriesSentiment(shape, al, {
      userRating,
      userReactions: reactionsForThisSeries,
      watchlistEntry,
      externalScores: externalForThisSeries,
    });
    // Coverage gate — Phase 2a: confidence is 1.0 whenever signal != 0,
    // so this gate trivially passes for every signal-bearing series
    // (preserving Step A inclusion). Phase 2b will vary confidence by
    // data richness, at which point this gate starts dropping
    // low-evidence series.
    if (confidence < 0.20) continue;
    const sw = signal;
    if (sw === 0) continue;
    if (sw > 0) perSeriesWeights[seriesId] = sw;

    const fkey = franchiseGroups[seriesId] || seriesId;
    if (sw > 0) {
      franchisePositiveCount[fkey] = (franchisePositiveCount[fkey] || 0) + 1;
    }
    // Pull from the prep's memoized primaryArchByCrId map so we don't
    // recompute the cosine-fit per-series for each of the three
    // vector modes. Only used for negative-sw series (drops) — the
    // map is built unconditionally so all series have it ready.
    const primaryArch = sw < 0 ? (primaryArchByCrId[seriesId] || null) : null;
    perSeriesPrep.push({ seriesId, sw, al, fkey, primaryArch });
  }

  // Franchise loyalty multiplier — *amplifies* per-season weight by a
  // log-scaled bonus when the user has watched multiple seasons of the
  // same franchise. Reads as "you've returned to this universe N times,
  // that's a real preference signal beyond the per-season completion."
  // Earlier iteration of this code compressed binge depth instead
  // (sqrt division), but completing 9 seasons of MHA + OVAs + movies +
  // multiple rewatches IS substantively different from 9 unrelated
  // shows — penalizing depth missed the user's actual taste shape. We
  // count only positive-sign contributions so a "dropped 8/9 seasons"
  // franchise gets no bonus (sloggers ≠ loyalists).
  //
  // Curve: 1 + ln(N) × 0.20, capped at 1.5.
  //   N=1 → 1.00 (single season, baseline — no bonus)
  //   N=2 → 1.14
  //   N=3 → 1.22
  //   N=5 → 1.32
  //   N=9 → 1.44
  //   N=20 → cap 1.50
  // Modest — keeps niche favorites competitive against franchise
  // commitment but acknowledges that "I keep coming back" matters.
  const franchiseLoyalty = {};
  for (const [fkey, n] of Object.entries(franchisePositiveCount)) {
    franchiseLoyalty[fkey] = Math.min(1.5, 1 + Math.log(Math.max(1, n)) * 0.20);
  }

  // Pass 2: apply contributions with the franchise loyalty multiplier
  // AND the drop-attribution attenuation. For dropped series, look up
  // each tag's archetype-specific discriminative ratio and damp the
  // negative contribution accordingly — non-discriminative tags barely
  // get penalized, discriminative anti-tags keep their full penalty.
  for (const { seriesId, sw, al, fkey, primaryArch } of perSeriesPrep) {
    if (!al) continue; // no tags to aggregate; series weight is still recorded for future use
    contributingSeries++;
    const loyalty = franchiseLoyalty[fkey] ?? 1;
    const effSw = sw * loyalty;
    const isDrop = sw < 0;
    const archDiscMap = isDrop && primaryArch ? dropDiscriminativeMap[primaryArch] : null;
    // G12: drop-context multiplier. Drops in archetypes the user
    // typically COMPLETES are louder; drops where they typically DROP
    // are quieter. Applied alongside the per-tag dropAttenuation.
    // No-op (1.0) for non-drops or when no archetype context exists.
    const archCompRate = (isDrop && primaryArch && archCompletionRates)
      ? archCompletionRates[primaryArch]
      : null;
    const dropContext = isDrop ? dropContextMultiplierFor(archCompRate) : 1;

    for (const tag of al.tags || []) {
      if (!tag?.name) continue;
      if (skipSpoilers && tag.isMediaSpoiler) continue;
      const tagStrength = typeof tag.rank === 'number' ? tag.rank / 100 : 0.5;
      if (tagStrength <= 0) continue;
      const idfW = idf[tag.name] ?? 1;
      const catW = categoryWeightFor(tag.category);
      const dropAtten = archDiscMap ? dropAttenuationFor(archDiscMap[tag.name]) : 1;
      const c = effSw * tagStrength * idfW * catW * dropAtten * dropContext;
      raw[tag.name] = (raw[tag.name] || 0) + c;
      if (c > 0) positiveRaw[tag.name] = (positiveRaw[tag.name] || 0) + c;
      else negativeRaw[tag.name] = (negativeRaw[tag.name] || 0) + (-c);
      (contributions[tag.name] ||= []).push({
        seriesId,
        seriesTitle: al.title ?? null,
        weight: c,
        category: tag.category ?? null,
      });
    }
    for (const genre of al.genres || []) {
      if (!genre) continue;
      const idfW = idf[genre] ?? 1;
      const dropAtten = archDiscMap ? dropAttenuationFor(archDiscMap[genre]) : 1;
      const c = effSw * idfW * dropAtten * dropContext;
      raw[genre] = (raw[genre] || 0) + c;
      if (c > 0) positiveRaw[genre] = (positiveRaw[genre] || 0) + c;
      else negativeRaw[genre] = (negativeRaw[genre] || 0) + (-c);
      (contributions[genre] ||= []).push({
        seriesId,
        seriesTitle: al.title ?? null,
        weight: c,
        category: 'Genre',
      });
    }
  }

  // Survey-tag taps used to land here as a flat ±0.6 additive. That
  // path was silently drowned by aggregate behavioral signal — a user
  // who'd dropped 10 ecchi shows had vector["Ecchi"] ≈ -12, against
  // which +0.6 was invisible. Replaced by the floor/ceiling override
  // in stated-preference.js, applied AFTER this function returns. See
  // applyStatedPreferenceOverride for the new shape.

  // Keep raw (unnormalized) — downstream cosine-sim normalizes its own way.
  // Top: highest positive net weight. Bottom: most negative net weight
  // (the user's explicit anti-tags) — surfaced separately so popups /
  // explanations can say "you avoid X" without us inferring that from
  // low weight alone.
  const top = Object.entries(raw)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([tag, weight]) => ({ tag, weight: +weight.toFixed(3) }));
  const bottom = Object.entries(raw)
    .filter(([, w]) => w < 0)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 20)
    .map(([tag, weight]) => ({ tag, weight: +weight.toFixed(3) }));

  // Trim contribution lists so the persisted blob isn't 500KB.
  // Sort by absolute weight so both strongest positive and strongest
  // negative contributors survive the trim.
  for (const tag of Object.keys(contributions)) {
    contributions[tag] = contributions[tag]
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 5)
      .map(c => ({ ...c, weight: +c.weight.toFixed(3) }));
  }

  return {
    raw,
    top,
    bottom,
    contributions,
    perSeriesWeights,
    tagImplications,
    mode,
    summary: {
      totalSeriesWithShape,
      contributingSeries,
      uniqueTags: Object.keys(raw).length,
      tagsNetPositive: Object.values(raw).filter(v => v > 0).length,
      tagsNetNegative: Object.values(raw).filter(v => v < 0).length,
      // Franchise telemetry — count of distinct franchise groups vs
      // contributing series. distinctFranchises ≤ contributingSeries;
      // gap measures binge-vs-breadth (a user with 9 MHA seasons across
      // 1 franchise and 50 single-season shows has 51 contributingSeries
      // but 51 distinctFranchises minus 1 binge = ratio of 1.18 vs a
      // user with 60 single-cour shows hitting 1.0). Gives the popup /
      // diag surfaces something to render without a separate pass.
      distinctFranchises: Object.keys(franchisePositiveCount).length,
    },
  };
}
