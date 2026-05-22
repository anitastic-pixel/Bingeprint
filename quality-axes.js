// Per-show quality axes — derived from what's already in aniListCache,
// no external scraping in v1. Three axes:
//
//   craftPrior       — weighted blend of the director's and primary
//                      studio's track record across other shows in the
//                      corpus. Answers "is this team known for polish?"
//   consensusQuality — normalized averageScore. Plain AniList-average
//                      for now; leaving room to genre-adjust later.
//   adaptationRisk   — 0 (safe) → 1 (high risk). Flags LN/manga/WN
//                      adaptations with short ep counts where rushed-
//                      pacing is historically common.
//
// All three are in [0, 1] when defined, null when we don't have
// enough data to call it. Consumers (card pitch, rec rerank) should
// treat null as 'unknown, don't mention' rather than as a zero.
//
// §21 calls for six axes (animation / direction / writing / OST /
// coherence / originality). The missing three (animation quality via
// Sakugabooru, direction/writing craft via ANN reviews, per-episode
// coherence via MAL) need scraping pipelines. We ship the three that
// don't. Later passes can add scraped data to this same shape without
// changing the consumer contract.

const KEY_DIRECTOR_ROLES = ['Director', 'Chief Director', 'Series Director'];

// Sources that carry adaptation-rush risk. ORIGINAL and NOVEL (prose)
// are treated separately — originals have no adaptation to fail, and
// full-prose novels often come with long ep counts.
const RUSH_PRONE_SOURCES = new Set([
  'MANGA', 'LIGHT_NOVEL', 'WEB_NOVEL', 'VISUAL_NOVEL',
]);

function median(sortedArr) {
  if (!sortedArr.length) return null;
  const mid = Math.floor(sortedArr.length / 2);
  return sortedArr.length % 2 === 1
    ? sortedArr[mid]
    : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
}

// Linear-interpolated percentile. Used for director/studio craft
// priors at p=0.75 — median was tanking on studios like OLM (massive
// children's catalog drags Apothecary Diaries down to 0.61). The
// question "when this team does their best, how high does it go?" is
// better answered by the 75th-percentile of their output than the
// middle — captures the upper-middle of what they can deliver without
// overclaiming the single-show max.
function percentileAt(sortedArr, p) {
  if (!sortedArr.length) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = p * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac;
}

// Walk every entry in the cache once to build director-id → median-
// averageScore and studio-id → median-averageScore maps. Per-show
// craftPrior lookups then run in O(1). Entries with null/zero scores
// are skipped so unscored shows don't poison the priors.
export function buildQualityIndex(aniListCache) {
  const directorScores = new Map();
  const studioScores = new Map();
  const genreScores = new Map();
  // Dedup by AniList ID — CR sometimes has multiple series pages
  // (and therefore multiple aniListCache entries) resolving to the
  // same AniList Media, which would otherwise double-count the show
  // against its own director/studio and inflate the sample-count
  // gates. First occurrence wins; subsequent duplicates skipped.
  const seenAniListIds = new Set();
  for (const entry of Object.values(aniListCache || {})) {
    const score = entry?.averageScore;
    if (typeof score !== 'number' || score <= 0) continue;
    const aniId = entry?.aniListId;
    if (aniId != null) {
      if (seenAniListIds.has(aniId)) continue;
      seenAniListIds.add(aniId);
    }
    for (const s of entry.staff || []) {
      if (!s?.id) continue;
      const role = s.role || '';
      if (!KEY_DIRECTOR_ROLES.some(r => role.includes(r))) continue;
      const arr = directorScores.get(s.id) || [];
      arr.push(score);
      directorScores.set(s.id, arr);
    }
    const primaryStudio = (entry.studios || []).find(s => s?.isAnimationStudio !== false);
    if (primaryStudio?.id) {
      const arr = studioScores.get(primaryStudio.id) || [];
      arr.push(score);
      studioScores.set(primaryStudio.id, arr);
    }
    for (const g of entry.genres || []) {
      if (!g) continue;
      const arr = genreScores.get(g) || [];
      arr.push(score);
      genreScores.set(g, arr);
    }
  }
  // Director + studio use 75th-percentile as their aggregate — see
  // percentileAt comment for why. Genre stays on median: it's a
  // baseline ("what's typical for this genre"), not a pedigree.
  const toPercentile = (m, p) => {
    const out = new Map();
    for (const [k, v] of m.entries()) {
      const sorted = v.slice().sort((a, b) => a - b);
      out.set(k, { score: percentileAt(sorted, p), count: v.length });
    }
    return out;
  };
  const toMedian = (m) => {
    const out = new Map();
    for (const [k, v] of m.entries()) {
      out.set(k, { score: median(v.slice().sort((a, b) => a - b)), count: v.length });
    }
    return out;
  };
  return {
    director: toPercentile(directorScores, 0.75),
    studio: toPercentile(studioScores, 0.75),
    genre: toMedian(genreScores),
  };
}

function craftPriorFor(media, index) {
  let directorStat = null;
  for (const s of media?.staff || []) {
    if (!s?.id) continue;
    const role = s.role || '';
    if (!KEY_DIRECTOR_ROLES.some(r => role.includes(r))) continue;
    const stat = index.director.get(s.id);
    if (stat?.score != null) {
      directorStat = stat;
      break; // first director wins — multi-director shows are rare and usually listed in priority order
    }
  }
  const primaryStudio = (media?.studios || []).find(s => s?.isAnimationStudio !== false);
  const studioStat = primaryStudio?.id ? index.studio.get(primaryStudio.id) : null;

  // Gate on minimum sample counts — a director with a single show
  // gives a trivial prior (themselves) that says nothing; a studio
  // with two shows is only marginally more meaningful. Want at least
  // 2 shows for director, 3 for studio.
  const haveDir = directorStat && directorStat.count >= 2;
  const haveStu = studioStat && studioStat.count >= 3;
  if (haveDir && haveStu) {
    // Director gets 60% — directors carry more craft signal than
    // studios, which host many teams across many shows.
    return (directorStat.score * 0.6 + studioStat.score * 0.4) / 100;
  }
  if (haveDir) return directorStat.score / 100;
  if (haveStu) return studioStat.score / 100;
  return null;
}

function adaptationRiskFor(media) {
  const source = media?.source;
  const eps = media?.episodes;
  if (source === 'ORIGINAL') return 0;
  if (source === 'NOVEL') return 0.1; // full-prose novels are rarely rushed
  if (RUSH_PRONE_SOURCES.has(source)) {
    if (typeof eps !== 'number' || eps <= 0) return 0.5; // unknown → moderate
    if (eps >= 24) return 0.2;
    if (eps >= 13) return 0.5;
    return 0.8; // ≤12 eps on a manga/LN adaptation is the classic rush shape
  }
  return source ? 0.3 : null;
}

// G07: franchise-aware adaptationRisk override.
//
// adaptationRiskFor (above) operates on per-season episode count. That's
// correct for one-shot shows: a 12-ep manga/LN adaptation IS the
// classic rush shape. But it's wrong for franchise *seasons*: Mob
// Psycho 100 III at 12 eps looks rushed in isolation, yet the
// franchise has 36+ eps across 3 seasons to adapt the manga — not
// actually a rush. the user flagged this on 2026-04-24 (CLAUDE.md
// incident note); the heuristic was right per-season, wrong on
// franchise context.
//
// Override: when the franchise total TV eps is >=24 (the threshold
// used in adaptationRiskFor's "established-franchise" case), the
// per-season high-risk score is replaced with 0.2 — same value the
// non-franchise 24+ ep adaptation gets.
//
// Marks _franchiseAware=true so the chip code can distinguish
// "engine reconsidered" from "show genuinely safe" if it ever
// matters for the UI.
export function adjustQualityAxesForFranchise(qualityAxes, franchise) {
  if (!qualityAxes || !franchise) return qualityAxes;
  if (typeof qualityAxes.adaptationRisk !== 'number') return qualityAxes;
  if (qualityAxes.adaptationRisk < 0.7) return qualityAxes; // not flagged
  const totalEps = franchise.totalTvEps;
  if (typeof totalEps !== 'number' || totalEps < 24) return qualityAxes;
  return { ...qualityAxes, adaptationRisk: 0.2, _franchiseAware: true };
}

function consensusQualityFor(media) {
  const score = media?.averageScore;
  if (typeof score !== 'number' || score <= 0) return null;
  return score / 100;
}

export function computeShowQuality(media, index) {
  return {
    craftPrior: craftPriorFor(media, index),
    consensusQuality: consensusQualityFor(media),
    adaptationRisk: adaptationRiskFor(media),
  };
}

// Write qualityAxes onto every eligible cache entry in place. Caller
// persists the mutated cache. Returns stats for the diagnostic log.
export function annotateCacheWithQuality(aniListCache) {
  const index = buildQualityIndex(aniListCache);
  let scored = 0;
  let withCraft = 0;
  let withAdaptation = 0;
  let highRisk = 0;
  for (const entry of Object.values(aniListCache || {})) {
    if (!entry) continue;
    const axes = computeShowQuality(entry, index);
    entry.qualityAxes = axes;
    if (axes.consensusQuality != null) scored++;
    if (axes.craftPrior != null) withCraft++;
    if (axes.adaptationRisk != null) {
      withAdaptation++;
      if (axes.adaptationRisk >= 0.7) highRisk++;
    }
  }
  return {
    total: Object.keys(aniListCache || {}).length,
    scored,
    withCraft,
    withAdaptation,
    highRisk,
    directorsIndexed: index.director.size,
    studiosIndexed: index.studio.size,
  };
}
