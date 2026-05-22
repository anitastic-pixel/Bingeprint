// Per-user studio + creator (key staff) affinity indexes. Pure, no chrome.* APIs.
//
// For each studioId / staffId touched by the user's history we accumulate
// the per-series weight from the series-sentiment seam, so a finished,
// rewatched, well-regarded show outweighs a one-episode sample by
// orders of magnitude — and a 👍-rated, watchlist-favorited show
// outweighs an unopinionated completion at equal behavioral evidence.
//
// Output is meant to power "Studio: Wit · 12 of your favorites (incl.
// Vinland Saga, Ranking of Kings)" rows on the show-page card. So per
// entity we keep:
//   - totalWeight  — how much this entity speaks for the user overall
//   - count        — distinct series in history (a 5-show studio is a
//                    stronger signal than a 1-show studio of equal weight)
//   - lovedCount   — series above a "love" cutoff (peak quality + completed-
//                    or-rewatched). Drives the "12 of your favorites" copy.
//   - topSeries    — top 3 contributing series, for the inline "incl. X, Y"
//
// Staff entries are bucketed by canonical role token (director / writer /
// composition / character-design / music / original-creator) so a director
// with strong overall affinity isn't credited as "your favorite character
// designer" too. A single person can appear in multiple buckets if they
// wear multiple hats.
//
// Previously this module had a private duplicated copy of the per-series
// weight math. After migrating to series-sentiment.js, both this module
// and taste-vector.js read from the same seam — drift between the two
// indexes is no longer possible.

import { seriesSentiment } from './series-sentiment.js';

// Studio-lineage canonicalization. When AL splits a studio's catalog
// across multiple IDs (Bones rebranding part of its theatrical work as
// "Bones Film" / id 7585 in 2024 while keeping the original Bones / id 4
// alive on the TV side; Pierrot rebrand into Pierrot Films / Pierrot+;
// etc.), the per-ID studio index leaves the user with two unrelated-looking
// studio rows for what readers think of as one studio. The franchise
// dedupe (franchise.js studioNameKey) collapses the names within a
// single show's run list, but the per-user STUDIO INDEX still keys
// every credit by AL's raw studio ID — so a Bones-Film-credited new
// show can't pull affinity weight from a Bones-credited prior show.
//
// Fix: a canonical lineage map keyed by alias studio ID → canonical
// studio ID. Both index-build and lookup substitute alias → canonical,
// so all weight flows into the canonical entity and any show in the
// lineage finds the pooled affinity.
//
// Display naming is unchanged — each show's animationStudios still
// carry the as-credited name, so the card row reads "Made by bones
// film" for Marriagetoxin and "Made by bones" for early MHA, only
// the cross-credit attribution uses canonical pooling.
//
// Adding new lineages: confirm via the AniList studio page that the
// alias studio is genuinely a sibling/rebrand (same parent leadership,
// often one founded as a spin-off of the other) and not a legitimately
// independent studio that happens to share branding (e.g. "Production
// I.G America" is genuinely separate from "Production I.G" — do NOT
// alias). Conservative additions only.
const STUDIO_LINEAGE_ALIASES = new Map([
  // Bones (4) ← Bones Film (7585). Bones Film is a 2024 spin-off
  // sister studio handling theatrical work; same parent leadership.
  // MHA seasons span both names; Marriagetoxin (2026) credits Bones
  // Film. Pooling lets the user's MHA-via-Bones affinity flow to any
  // future Bones-Film-credited title.
  [7585, 4],
  // Pierrot (1) ← Pierrot Films (10) / Pierrot+ (132) — same parent;
  // Pierrot+ handles short-form/digital, Pierrot Films handles
  // theatrical. Naruto/Bleach affinity should pool.
  [10, 1],
  [132, 1],
]);

function canonicalStudioId(id) {
  if (id == null) return id;
  return STUDIO_LINEAGE_ALIASES.get(id) ?? id;
}

// "Loved" = a show the user pushed past sampling AND that is generally
// well-regarded OR that they rewatched. Used for the "X of your favorites"
// count, so the bar should be meaningful — not "every completed show."
function isLoved(shape, averageScore) {
  const completed = shape.label === 'completed' || shape.label === 'in-progress';
  if (!completed) return false;
  const rewatched = Array.isArray(shape.rewatchedEpisodes) && shape.rewatchedEpisodes.length > 0;
  const peak = typeof averageScore === 'number' && averageScore >= 78;
  return rewatched || peak;
}

// Map AniList's free-text staff role into a coarse bucket. Multi-bucket
// matches are allowed — a "Director, Series Composition" credit lands
// in both 'director' and 'composition'. Returns null if no bucket fits.
const ROLE_BUCKET_PATTERNS = {
  'director':         /\bdirector\b/i,
  'composition':      /\bseries composition\b/i,
  'character-design': /\bcharacter design\b/i,
  'music':            /\bmusic\b/i,
  'original-creator': /\b(original creator|original story|original work)\b/i,
};

// Secondary credits never headline an affinity row — see the matching
// SECONDARY_ROLE_PATTERNS comment in content-card.js for the why
// (Marriagetoxin's Yurika Sako Sub-Designer was promoted over the
// actual lead Designer pre-fix). Keep this list in sync with the
// content-card.js mirror.
const SECONDARY_ROLE_PATTERNS = [
  /\bsub[ -]/i,
  /\bassistant\b/i,
  /\b2nd\b/i,
  /\bsecondary\b/i,
  /\bsupport(ing)?\b/i,
  /\bin-?between\b/i,
];
function isSecondaryRole(role) {
  if (!role) return false;
  return SECONDARY_ROLE_PATTERNS.some(p => p.test(role));
}

function bucketsForRole(role) {
  if (!role) return [];
  if (isSecondaryRole(role)) return [];
  const out = [];
  for (const [bucket, pat] of Object.entries(ROLE_BUCKET_PATTERNS)) {
    if (pat.test(role)) out.push(bucket);
  }
  return out;
}

function dedupeSeriesByTitle(list) {
  const seen = new Map(); // normalized title → entry (highest weight wins)
  for (const item of list) {
    const key = String(item.title || item.crSeriesId).toLowerCase().trim();
    const existing = seen.get(key);
    if (!existing || item.weight > existing.weight) seen.set(key, item);
  }
  return [...seen.values()];
}

// Filter a show's studios list down to the "real" animation studios
// for attribution purposes. AniList includes outsourcing studios
// alongside the primary (One Piece lists Toei main + Magic Bus / TAP /
// Mushi as outsourcers). When at least one studio has `isMain: true`,
// prefer mains exclusively; else fall back to all animation studios
// (covers pre-schema-v5 cache entries that don't carry isMain).
//
// Lived in two byte-identical copies in all-shows-scoring.js and
// rank-recommendations.js before the 2026-05-19 architecture review
// — consolidated here as the single source. Both files import from
// studio-creator-index.js for other studio helpers already.
export function preferMainAnimationStudios(studios) {
  const all = (studios || []).filter(s => s?.isAnimationStudio);
  const mains = all.filter(s => s?.isMain === true);
  return mains.length ? mains : all;
}

export function computeStudioCreatorIndex(watchShapes, aniListCache, extras = {}) {
  const studios = {}; // { id: { id, name, totalWeight, count, lovedCount, topSeries[] } }
  const creators = {}; // { id: { id, name, image, byRole: { bucket: { weight, count, topSeries[] } } } }

  const userRatings = extras.userRatings || null;
  const userReactions = extras.userReactions || null;
  const watchlistBySeries = extras.watchlistBySeries || null;
  const externalScores = extras.externalScores || null;

  const seriesShapes = watchShapes?.series || {};
  for (const [crSeriesId, shape] of Object.entries(seriesShapes)) {
    const al = aniListCache?.[crSeriesId];
    if (!al) continue;
    // Look up explicit-feedback signals for this series. Same pattern
    // as taste-vector.js so both indexes see the same sentiment.
    const userRating = (userRatings && al.aniListId != null)
      ? userRatings[al.aniListId] : null;
    const reactionsForThisSeries = (userReactions && al.aniListId != null)
      ? userReactions[al.aniListId] : null;
    const watchlistEntry = watchlistBySeries
      ? watchlistBySeries[crSeriesId] : null;
    const externalForThisSeries = (externalScores && al.aniListId != null)
      ? externalScores[al.aniListId] : null;
    const { signal, confidence } = seriesSentiment(shape, al, {
      userRating,
      userReactions: reactionsForThisSeries,
      watchlistEntry,
      externalScores: externalForThisSeries,
    });
    // Studio/creator affinity is "credit to teams whose work you've
    // enjoyed." Two filters:
    //   - confidence ≥ 0.20: drop shows we genuinely don't have data on
    //     (matches the taste-vector caller gate)
    //   - signal > 0: only positive signals contribute. A studio
    //     shouldn't accumulate negative affinity from a show the user
    //     dropped — drops are weak signals about the studio (could be
    //     the source material, the script, a single bad arc) and the
    //     "Studios you've enjoyed" framing breaks under negative
    //     contributions.
    if (confidence < 0.20) continue;
    if (signal <= 0) continue;
    const sw = signal;
    const loved = isLoved(shape, al.averageScore);
    const seriesTitle = al.title?.english || al.title?.romaji || al.title?.native || null;
    const seriesEntry = { crSeriesId, title: seriesTitle, weight: +sw.toFixed(3), loved };

    // Animation studios only — producers (Aniplex, Kadokawa, etc.) tell
    // us nothing about whether the user will like the *look* of a show.
    for (const studio of (al.studios || [])) {
      if (studio.id == null || !studio.isAnimationStudio) continue;
      // Canonicalize via lineage map so siblings (Bones / Bones Film)
      // pool weight under the parent ID. The display name on each
      // contributing series stays as-credited (preserved on
      // contributingSeries below), so the card row text remains
      // accurate per-era; only the affinity bookkeeping is pooled.
      const canonId = canonicalStudioId(studio.id);
      let s = studios[canonId];
      if (!s) {
        s = studios[canonId] = {
          id: canonId,
          name: studio.name,
          totalWeight: 0,
          count: 0,
          lovedCount: 0,
          contributingSeries: [],
        };
      }
      s.totalWeight += sw;
      s.count += 1;
      if (loved) s.lovedCount += 1;
      s.contributingSeries.push(seriesEntry);
    }

    for (const staff of (al.staff || [])) {
      if (staff.id == null) continue;
      const buckets = bucketsForRole(staff.role);
      if (buckets.length === 0) continue;
      let c = creators[staff.id];
      if (!c) {
        c = creators[staff.id] = {
          id: staff.id,
          name: staff.name,
          image: staff.image || null,
          byRole: {},
        };
      }
      for (const bucket of buckets) {
        let b = c.byRole[bucket];
        if (!b) b = c.byRole[bucket] = { weight: 0, count: 0, lovedCount: 0, contributingSeries: [] };
        b.weight += sw;
        b.count += 1;
        if (loved) b.lovedCount += 1;
        b.contributingSeries.push(seriesEntry);
      }
    }
  }

  // Trim + round for storage. Dedupe contributing series by normalized
  // title before slicing — CR registers multi-cour shows under separate
  // series IDs ("Attack on Titan Final Season Part 2" can show up twice
  // for the same studio), and the "incl. X, Y" copy reads as a bug
  // when those duplicates surface side-by-side.
  for (const s of Object.values(studios)) {
    s.totalWeight = +s.totalWeight.toFixed(3);
    s.contributingSeries = dedupeSeriesByTitle(s.contributingSeries)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);
  }
  for (const c of Object.values(creators)) {
    for (const b of Object.values(c.byRole)) {
      b.weight = +b.weight.toFixed(3);
      b.contributingSeries = dedupeSeriesByTitle(b.contributingSeries)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5);
    }
  }

  // Pre-sorted top-N projections — part of the index's contract,
  // not a consumer responsibility. Reasoning logged in BRAINSTORM
  // 2026-05-19 "top-N projections belong to the producer":
  // consumers (lens-pipeline, snapshot, popup) were each re-sorting
  // the same dicts to pick top-10 studios / top-30 creators on every
  // read. Now stamped once at write-time; consumers `.slice(0, n)`
  // for free without re-sorting. Top-30 is the max-cardinality
  // observed across consumers — smaller slices are trivial.
  // Output: number[] of aniListIds, ordered by totalWeight desc.
  const topStudios = Object.entries(studios)
    .sort((a, b) => (b[1].totalWeight || 0) - (a[1].totalWeight || 0))
    .slice(0, 30)
    .map(([id]) => Number(id))
    .filter(Number.isFinite);
  const topCreators = Object.entries(creators)
    .sort((a, b) => (b[1].totalWeight || 0) - (a[1].totalWeight || 0))
    .slice(0, 30)
    .map(([id]) => Number(id))
    .filter(Number.isFinite);
  return { studios, creators, topStudios, topCreators };
}

// Helpers for consumers (content.js, sidepanel.js) — given a rec's
// animationStudios / keyStaff arrays + the index, return a one-line
// affinity blurb we can drop into the card. Returns null when the user
// has no real history with this entity (so the card can hide the row).

export function studioAffinityFor(animationStudios, studiosIndex) {
  if (!Array.isArray(animationStudios) || !studiosIndex) return null;
  // Pick the studio with the strongest user affinity, fall back to the
  // first listed studio if none match. Looks up via canonical lineage
  // ID so a Bones-Film show finds Bones-credited prior watches.
  let best = null;
  for (const s of animationStudios) {
    const idx = studiosIndex[canonicalStudioId(s.id)];
    if (!idx) continue;
    if (!best || idx.totalWeight > best.idx.totalWeight) best = { studio: s, idx };
  }
  if (best) {
    return {
      name: best.studio.name,
      familiar: true,
      count: best.idx.count,
      lovedCount: best.idx.lovedCount,
      topSeries: best.idx.contributingSeries.slice(0, 3).map(s => s.title).filter(Boolean),
    };
  }
  // No history with any of this show's studios.
  const fallback = animationStudios[0];
  if (!fallback) return null;
  return { name: fallback.name, familiar: false, count: 0, lovedCount: 0, topSeries: [] };
}

// ── Creator-affinity SCORING ────────────────────────────────────────
// Distinct from `studioAffinityFor` / `creatorAffinityFor` above —
// those return UI-shaped affinity records ("you've watched 12 Wit
// shows incl. ..."). This pair returns a normalized 0..1 SCORE that
// participates in the score blend alongside tasteN / recN / qualN.
//
// Per-role weights reflect how much each credit shapes a show's feel:
//   studio          — strongest (the "team" signal aligning with
//                     "I'd watch anything by Mappa")
//   director        — strong; auteur signal
//   composition     — moderate; the writer holds the show-bible
//   original-creator — moderate; loyal-reader signal but mediated
//                     by adaptation quality
//   music           — light; rare to drive a watch decision
//   character-design — lightest; aesthetic compatibility
const CREATOR_ROLE_WEIGHTS = {
  'studio':           1.0,
  'director':         0.8,
  'composition':      0.7,
  'original-creator': 0.5,
  'music':            0.3,
  'character-design': 0.2,
};

// Cold-start gate. A team-credit with thin evidence (fewer than 3 user
// shows AND less than 1.0 accumulated weight) defaults to 0.5 (neutral)
// rather than 0 (penalty). Unknown ≠ bad; the user just hasn't
// accumulated enough watch evidence to have an opinion.
const COLD_START_COUNT = 3;
const COLD_START_WEIGHT = 1.0;
const COLD_START_NEUTRAL = 0.5;

// Derive the user's max totalWeight per role across the index. Called
// once per index, cached by the caller across per-show scoring calls.
// Used to normalize each show's per-role contribution to 0..1 against
// the user's most-trusted team in that role.
export function deriveCreatorMaxes(index) {
  const maxes = { studio: 0, director: 0, composition: 0, 'original-creator': 0, music: 0, 'character-design': 0 };
  for (const s of Object.values(index?.studios || {})) {
    if (s.totalWeight > maxes.studio) maxes.studio = s.totalWeight;
  }
  for (const c of Object.values(index?.creators || {})) {
    for (const [bucket, b] of Object.entries(c.byRole || {})) {
      if (maxes[bucket] != null && b.weight > maxes[bucket]) maxes[bucket] = b.weight;
    }
  }
  return maxes;
}

// Score a show's creator-affinity. Returns { score: 0..1, _components }.
// _components surfaces per-role contributions for diagnostic UI; not
// part of the public interface.
//
// Math: per role, normalize the team's index weight against the user's
// max for that role (0..1). Cold-start teams get 0.5 (neutral). Sum
// the weighted contributions and divide by the sum of role weights
// that participated, so a show with only a known studio (no staff
// data) scores correctly against a show with full staff credits.
export function creatorAffinityScore(animationStudios, keyStaff, index, maxes) {
  if (!index || !maxes) return { score: 0.5, _components: {} };
  const components = {};
  let weightedSum = 0;
  let weightTotal = 0;

  // Studio contribution. Use the strongest-affinity studio when a
  // show has multiple animation studios (one is usually primary).
  if (Array.isArray(animationStudios) && animationStudios.length > 0) {
    let bestStudio = null;
    for (const s of animationStudios) {
      const idx = index.studios?.[s?.id];
      if (!idx) continue;
      if (!bestStudio || idx.totalWeight > bestStudio.totalWeight) bestStudio = idx;
    }
    let contribution;
    if (!bestStudio) {
      contribution = COLD_START_NEUTRAL;
    } else if (bestStudio.count < COLD_START_COUNT && bestStudio.totalWeight < COLD_START_WEIGHT) {
      contribution = COLD_START_NEUTRAL;
    } else {
      contribution = maxes.studio > 0 ? Math.min(1, bestStudio.totalWeight / maxes.studio) : 0.5;
    }
    const w = CREATOR_ROLE_WEIGHTS.studio;
    weightedSum += contribution * w;
    weightTotal += w;
    components.studio = { contribution: +contribution.toFixed(3), weight: w };
  }

  // Per-staff contributions, bucketed by role. A single staff member
  // can sit in multiple buckets (Director + Composition); we credit
  // their primary bucket only to avoid double-counting.
  const seenBuckets = new Set();
  for (const staff of (keyStaff || [])) {
    const buckets = bucketsForRole(staff?.role);
    const bucket = buckets[0];
    if (!bucket || seenBuckets.has(bucket)) continue;
    seenBuckets.add(bucket);
    const w = CREATOR_ROLE_WEIGHTS[bucket];
    if (!w) continue;
    const idx = index.creators?.[staff.id]?.byRole?.[bucket];
    let contribution;
    if (!idx) {
      contribution = COLD_START_NEUTRAL;
    } else if (idx.count < COLD_START_COUNT && idx.weight < COLD_START_WEIGHT) {
      contribution = COLD_START_NEUTRAL;
    } else {
      const max = maxes[bucket] || 0;
      contribution = max > 0 ? Math.min(1, idx.weight / max) : 0.5;
    }
    weightedSum += contribution * w;
    weightTotal += w;
    components[bucket] = { contribution: +contribution.toFixed(3), weight: w };
  }

  if (weightTotal === 0) return { score: 0.5, _components: components };
  return {
    score: +(weightedSum / weightTotal).toFixed(3),
    _components: components,
  };
}

export function creatorAffinityFor(keyStaff, creatorsIndex) {
  if (!Array.isArray(keyStaff) || !creatorsIndex) return [];
  const out = [];
  for (const staff of keyStaff) {
    const idx = creatorsIndex[staff.id];
    const buckets = bucketsForRole(staff.role);
    const primaryBucket = buckets[0] || null;
    const ix = idx && primaryBucket ? idx.byRole[primaryBucket] : null;
    out.push({
      id: staff.id,
      name: staff.name,
      role: staff.role,
      bucket: primaryBucket,
      familiar: !!ix,
      count: ix?.count ?? 0,
      lovedCount: ix?.lovedCount ?? 0,
      topSeries: (ix?.contributingSeries || []).slice(0, 3).map(s => s.title).filter(Boolean),
    });
  }
  return out;
}
