// Validation snapshot generator. Pure module — takes engine state from
// chrome.storage and returns a snapshot JSON object suitable for diffing
// against a committed baseline.
//
// Why pure: the caller (popup or worker) handles IO. This module just
// transforms data. Easier to reason about, easier to test.
//
// Snapshot shape commits to validation/README.md §What's here. Score
// values are rounded to 1 decimal (0.1 precision) to reduce diff noise
// between runs that don't change behavior.

// Bumped 1 → 2 for the G13-prep validation expansion: snapshots
// now include coverage stats, recompute health, error log,
// per-lens slices, and rate-limit telemetry. Diffs against v1
// baselines will show the new fields as additions only — old
// fields unchanged.
const SCHEMA_VERSION = 2;
const TOP_N = 30;
const BOTTOM_N = 30;
const PER_ARCHETYPE_N = 5;
const PER_LENS_N = 10;
const RECENT_ERRORS_N = 20;

// Maps the engine's calibrated finalScore to a band label. Mirrors
// content.js:tierFor (5-band system per north-star Q5, post-G01/G02).
// Snapshots from before G01/G02 will see EVERY show shift band —
// that's the expected outcome of the calibration change. Diffs after
// G01/G02 will be against a refreshed baseline.
function bandForFinalScore(finalScore) {
  if (typeof finalScore !== 'number' || !Number.isFinite(finalScore)) return 'UNKNOWN';
  if (finalScore >= 0.90) return 'TRUST ME';
  if (finalScore >= 0.75) return 'WORTH A SHOT';
  if (finalScore >= 0.55) return 'STRETCH';
  if (finalScore >= 0.35) return 'PROBABLY NOT';
  return 'SKIP';
}

// 5-band mapping per philosophy. Captures what the engine WOULD say
// with action-threshold semantics from north-star Q5. Currently
// disconnected from display — used in snapshot for forward-compat.
function philosophyBandForFinalScore(finalScore) {
  if (typeof finalScore !== 'number' || !Number.isFinite(finalScore)) return 'UNKNOWN';
  const display = finalScore * 10;
  if (display >= 9.0) return 'TRUST ME';
  if (display >= 7.5) return 'WORTH A SHOT';
  if (display >= 5.5) return 'STRETCH';
  if (display >= 3.5) return 'PROBABLY NOT';
  return 'SKIP';
}

function projectShow(crSeriesId, entry) {
  const score = +(entry.finalScore || 0).toFixed(3);
  const display = +(score * 10).toFixed(1);
  return {
    crSeriesId,
    aniListId: entry.aniListId ?? null,
    title: entry.title?.english || entry.title?.romaji || entry.title?.native || '(untitled)',
    score: display, // 0-10 scale, 1 decimal
    rawScore: score, // 0-1 scale, 3 decimals — for stable comparison
    tier: bandForFinalScore(score),
    philosophyBand: philosophyBandForFinalScore(score),
    format: entry.format ?? null,
    year: entry.seasonYear ?? null,
    primaryArchetype: entry.primaryArchetype ?? null,
    // Genres are kept on the projected show so case evaluators can
    // match against population-level assertions (e.g., "any Sports
    // genre show should hit PROBABLY NOT or below").
    genres: Array.isArray(entry.genres) ? entry.genres.slice() : [],
    confidence: entry.confidence != null ? +entry.confidence.toFixed(2) : null,
  };
}

// Sort a list of [crSeriesId, entry] pairs by finalScore descending.
function sortedByScoreDesc(entries) {
  return entries
    .filter(([_, e]) => typeof e?.finalScore === 'number' && Number.isFinite(e.finalScore))
    .sort((a, b) => (b[1].finalScore || 0) - (a[1].finalScore || 0));
}

// Build the per-archetype top-N section. Groups shows by their
// primaryArchetype, sorts each group by score, takes top N.
function buildByArchetype(allEntries) {
  const groups = {};
  for (const [crSeriesId, entry] of allEntries) {
    const arch = entry.primaryArchetype;
    if (!arch) continue;
    if (!groups[arch]) groups[arch] = [];
    groups[arch].push([crSeriesId, entry]);
  }
  const out = {};
  for (const arch of Object.keys(groups).sort()) {
    const sorted = sortedByScoreDesc(groups[arch]);
    out[arch] = sorted.slice(0, PER_ARCHETYPE_N).map(([id, e]) => projectShow(id, e));
  }
  return out;
}

// Evaluate a single curated case against the snapshot's projected
// shows. Returns { pass, actual_band, actual_score, matched_shows[] }.
function evaluateCase(caseObj, projectedShows) {
  const result = {
    id: caseObj.id,
    rationale: caseObj.rationale,
    pass: false,
    detail: null,
  };

  // "any: true" means the case asserts something about the population,
  // not a specific show.
  if (caseObj.match?.any === true && caseObj.assertion === 'at_least_n_in_band') {
    const count = projectedShows.filter(s =>
      // Match against current engine band OR philosophy band — pass if either holds
      s.tier === caseObj.band || s.philosophyBand === caseObj.band
    ).length;
    result.pass = count >= caseObj.minimum_count;
    result.detail = { found_in_band: count, required: caseObj.minimum_count };
    return result;
  }

  // Match by title_includes
  let matches = projectedShows;
  if (caseObj.match?.title_includes) {
    const needle = caseObj.match.title_includes.toLowerCase();
    matches = matches.filter(s => (s.title || '').toLowerCase().includes(needle));
  }
  if (caseObj.match?.crSeriesId) {
    matches = matches.filter(s => s.crSeriesId === caseObj.match.crSeriesId);
  }
  if (caseObj.match?.aniListId) {
    matches = matches.filter(s => s.aniListId === caseObj.match.aniListId);
  }
  if (caseObj.match?.primary_genre_includes) {
    // Population-level: filter to shows whose genres list includes the
    // target genre, then assert that ALL of them satisfy the band/score
    // expectation. If any matching show fails, the case fails.
    const genre = caseObj.match.primary_genre_includes;
    const genreShows = projectedShows.filter(s =>
      Array.isArray(s.genres) && s.genres.includes(genre)
    );
    if (genreShows.length === 0) {
      result.pass = null;
      result.detail = { reason: `no_shows_with_genre_${genre}` };
      return result;
    }
    const violators = genreShows.filter(s => {
      if (caseObj.expected_band_at_or_below) {
        const order = ['TRUST ME', 'WORTH A SHOT', 'STRETCH', 'PROBABLY NOT', 'SKIP'];
        const expectedIdx = order.indexOf(caseObj.expected_band_at_or_below);
        const actualIdx = order.indexOf(s.philosophyBand);
        if (actualIdx < expectedIdx) return true;
      }
      if (caseObj.expected_max_score != null && s.score > caseObj.expected_max_score) return true;
      return false;
    });
    result.pass = violators.length === 0;
    result.detail = {
      genre,
      total_in_genre: genreShows.length,
      violators: violators.slice(0, 5).map(s => ({ title: s.title, score: s.score, band: s.philosophyBand })),
    };
    return result;
  }

  if (matches.length === 0) {
    result.pass = false;
    result.detail = { reason: 'no_matching_show_in_snapshot' };
    return result;
  }

  // Evaluate against expected_band, expected_min_score, expected_max_score
  const show = matches[0]; // first match
  result.detail = { matched: { title: show.title, score: show.score, tier: show.tier, philosophyBand: show.philosophyBand } };
  let pass = true;
  if (caseObj.expected_band) {
    pass = pass && (show.tier === caseObj.expected_band || show.philosophyBand === caseObj.expected_band);
  }
  if (caseObj.expected_min_score != null) {
    pass = pass && show.score >= caseObj.expected_min_score;
  }
  if (caseObj.expected_max_score != null) {
    pass = pass && show.score <= caseObj.expected_max_score;
  }
  if (caseObj.expected_band_at_or_below) {
    const order = ['TRUST ME', 'WORTH A SHOT', 'STRETCH', 'PROBABLY NOT', 'SKIP'];
    const expectedIdx = order.indexOf(caseObj.expected_band_at_or_below);
    const actualIdx = order.indexOf(show.philosophyBand);
    pass = pass && (actualIdx >= expectedIdx); // larger index = lower band
  }
  result.pass = pass;
  return result;
}

// Main entry. Builds a snapshot from engine state.
// Coverage stats: how many entries have each enrichment field populated.
// Surfaces "we silently lost N% of qualityAxes data" regressions in diffs.
function computeCoverage(allEntries) {
  let withQuality = 0;
  let withCraftPrior = 0;
  let withConsensusQuality = 0;
  let withFranchise = 0;
  let withTopTags = 0;
  let withTopAntiTags = 0;
  let withConfidence = 0;
  let withPrimaryArchetype = 0;
  let withRatingOverride = 0;
  let withTasteScore = 0;
  let withCrCfRank = 0;
  let franchiseAwareCount = 0;
  for (const [, e] of allEntries) {
    if (!e) continue;
    if (e.qualityAxes) withQuality++;
    if (typeof e.qualityAxes?.craftPrior === 'number') withCraftPrior++;
    if (typeof e.qualityAxes?.consensusQuality === 'number') withConsensusQuality++;
    if (e.qualityAxes?._franchiseAware === true) franchiseAwareCount++;
    if (e.franchise) withFranchise++;
    if (Array.isArray(e.topTags) && e.topTags.length > 0) withTopTags++;
    if (Array.isArray(e.topAntiTags) && e.topAntiTags.length > 0) withTopAntiTags++;
    if (typeof e.confidence === 'number') withConfidence++;
    if (e.primaryArchetype) withPrimaryArchetype++;
    if (e.finalScoreOverride) withRatingOverride++;
    if (typeof e.tasteScore === 'number') withTasteScore++;
    if (typeof e.crCFRank === 'number') withCrCfRank++;
  }
  return {
    withQuality, withCraftPrior, withConsensusQuality,
    withFranchise, withTopTags, withTopAntiTags, withConfidence,
    withPrimaryArchetype, withRatingOverride, withTasteScore, withCrCfRank,
    franchiseAwareCount,
  };
}

// Per-band populations across the full scored catalog. Visible in the
// snapshot so "the SKIP band collapsed" or "TRUST_ME band exploded"
// regressions show up immediately.
function computeBandPopulations(allProjected) {
  const counts = { 'TRUST ME': 0, 'WORTH A SHOT': 0, 'STRETCH': 0, 'PROBABLY NOT': 0, 'SKIP': 0, 'UNKNOWN': 0 };
  for (const s of allProjected) {
    const b = s.philosophyBand || s.tier || 'UNKNOWN';
    counts[b] = (counts[b] || 0) + 1;
  }
  return counts;
}

// Project the rec-pool ranked output (recommendationsScored.peak.ranked,
// .comfort.ranked, future lenses) into per-lens top/bottom slices. Used
// to verify lens-specific behavior — e.g., "From People You Trust"
// should show concentration on a few studios; "In the Air" should only
// have RELEASING shows. Empty when recommendationsScored is absent.
function projectLensSlices(recommendationsScored) {
  if (!recommendationsScored) return null;
  const out = {};
  for (const [lensId, lensData] of Object.entries(recommendationsScored)) {
    const ranked = lensData?.ranked;
    if (!Array.isArray(ranked)) continue;
    const top = ranked.slice(0, PER_LENS_N).map(r => ({
      rank: ranked.indexOf(r) + 1,
      title: r.title?.english || r.title?.romaji || r.title || '(untitled)',
      aniListId: r.aniListId ?? null,
      score: typeof r.finalScore === 'number' ? +(r.finalScore * 10).toFixed(1) : null,
      rawFinalScore: typeof r.rawFinalScore === 'number' ? +r.rawFinalScore.toFixed(3) : null,
      diversificationPenalty: r._diversificationPenalty ?? null,
      finalScoreOverride: r.finalScoreOverride ?? null,
    }));
    out[lensId] = {
      total: ranked.length,
      top: top,
      computedAt: lensData.computedAt ?? null,
    };
  }
  return out;
}

//
// Inputs:
//   allShowsScored: { crSeriesId: scoredEntry, ... }
//   tasteVectorAll: { tagWeights: {...}, ... } (optional, for metadata)
//   cases: { schema, cases: [...] } (optional; if absent, no case eval)
//   userId: 'andrew' (or similar)
//   recommendationsScored: { peak: {...}, comfort: {...}, ... } (optional;
//     surfaces per-lens slices)
//   engineErrors: array of recent errors (optional; circular buffer)
//   engineHealth: object with last recompute timing/state (optional)
//   anilistRateLimit: object with rate-limit telemetry (optional)
//   tasteShapeRadar: { axes, shapeName, proseSummary } (optional, for radar diff)
//
// Output: snapshot object (JSON-serializable).
export function buildSnapshot(input) {
  const {
    allShowsScored,
    tasteVectorAll,
    cases,
    userId = 'andrew',
    recommendationsScored,
    engineErrors,
    engineHealth,
    anilistRateLimit,
    tasteShapeRadar,
  } = input || {};

  if (!allShowsScored || typeof allShowsScored !== 'object') {
    throw new Error('buildSnapshot: allShowsScored is required');
  }

  const allEntries = Object.entries(allShowsScored);
  const sortedDesc = sortedByScoreDesc(allEntries);
  const sortedAsc = sortedDesc.slice().reverse();

  const topPicks = sortedDesc.slice(0, TOP_N).map(([id, e]) => projectShow(id, e));
  const bottomPicks = sortedAsc.slice(0, BOTTOM_N).map(([id, e]) => projectShow(id, e));
  const byArchetype = buildByArchetype(allEntries);

  // Project ALL shows for case evaluation (needed for population-level
  // assertions like "at least 3 shows in TRUST ME band").
  const allProjected = sortedDesc.map(([id, e]) => projectShow(id, e));

  let caseResults = null;
  if (cases?.cases?.length) {
    const userCases = cases.cases.filter(c => !c.user || c.user === userId);
    caseResults = userCases.map(c => evaluateCase(c, allProjected));
  }

  const validEntryCount = sortedDesc.length;
  const coverage = computeCoverage(allEntries);
  const bandPopulations = computeBandPopulations(allProjected);
  const lensSlices = projectLensSlices(recommendationsScored);

  // Trim error log to recent N — older errors carry less debugging value
  // and bloat the snapshot.
  const recentErrors = Array.isArray(engineErrors)
    ? engineErrors.slice(-RECENT_ERRORS_N).map(e => ({
        at: e.at || null,
        source: e.source || null,
        message: typeof e.message === 'string' ? e.message.slice(0, 240) : null,
        kind: e.kind || null,
      }))
    : null;

  // Project radar (compact form — full data is in tasteShapeRadar storage).
  // Snapshot includes shape name, top 3 axes, prose so a diff can catch
  // "shape name changed unexpectedly" without dumping the whole radar.
  const radarSummary = tasteShapeRadar ? {
    shapeName: tasteShapeRadar.shapeName || null,
    proseSummary: tasteShapeRadar.proseSummary || null,
    top3: Array.isArray(tasteShapeRadar.axes)
      ? tasteShapeRadar.axes
          .slice()
          .sort((a, b) => (b.value || 0) - (a.value || 0))
          .slice(0, 3)
          .map(a => ({ name: a.name, value: +(a.value || 0).toFixed(2) }))
      : [],
  } : null;

  return {
    schema: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    user: userId,
    engine: {
      scoredEntryCount: allEntries.length,
      validScoredEntryCount: validEntryCount,
      tasteVectorTagCount: tasteVectorAll?.summary?.uniqueTags
        ?? (tasteVectorAll?.raw ? Object.keys(tasteVectorAll.raw).length : null),
      currentTierMapping: '5-band (TRUST ME / WORTH A SHOT / STRETCH / PROBABLY NOT / SKIP)',
      philosophyBandMapping: 'matches displayed tier (post-G01/G02 calibration)',
    },
    coverage,
    bandPopulations,
    health: engineHealth || null,
    rateLimits: anilistRateLimit || null,
    recentErrors,
    radar: radarSummary,
    lenses: lensSlices,
    topPicks,
    bottomPicks,
    byArchetype,
    cases: caseResults,
  };
}
