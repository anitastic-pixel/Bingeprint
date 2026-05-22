// Taste-recompute pipeline — pure orchestration helpers extracted
// from background.js's persistTasteVector. No chrome.* APIs in this
// module; the worker reads inputs from storage, calls these helpers,
// writes outputs back. Keeps the "what runs in what order" knowledge
// concentrated here instead of inlined into a 296-line god-function.
//
// What lives here:
//   1. mergeCrTagsIntoEntry — merges Crunchyroll's tag-like fields
//      (tenant categories + keywords) into an AL projected entry's
//      tags/genres so they become first-class members of the user's
//      shape. AL's tags win on conflict; net new CR tags get rank 70.
//   2. augmentCacheWithCrTags — applies #1 across the entire cache.
//   3. synthesizeSurveyContributions — folds Quick Taste Check
//      surveyShapes (show taps) and surveyTagShapes (tag taps) into
//      the watchShapes/cache the taste vector consumes. Returns a
//      diagnostic blob the worker persists as surveyApplyState.
//   4. synthesizeExternalShapes — folds AniList / MAL imported list
//      entries into watchShapes/cache when the user has rated/marked
//      a show externally but never started it on Crunchyroll.
//      Synthesizes a "watched-shape-shaped" record from the external
//      list-status (completed → completed shape, dropped → dropped-mid)
//      so the taste-vector loop iterates over them and folds in the
//      external score via the existing externalScores Sentiment channel.
//   5. computeAllTasteVectors — runs the three-mode taste-vector
//      compute (all/peak/comfort) sharing the mode-independent prep.
//
// What stays in background.js:
//   - storage IO (read inputs, write outputs)
//   - downstream pipeline steps that need worker context
//     (recomputeQualityAxes calls bulkFetchByIds; rec-pipeline calls
//      bulkFetchByIds; computeAllShowsScored is too entangled with
//      mediaById merging to lift cleanly without a bigger refactor)
//   - retry-on-bridge-fill scheduling
//
// This is a "lift the obvious pure parts" pass; the orchestration
// shape can keep deepening over time as more steps prove pure.

import { computeTasteVector, buildTasteVectorPrep, SURVEY_TAG_WEIGHT } from './taste-vector.js';
import { applyStatedPreferenceOverride } from './stated-preference.js';
import { pickDominantSource } from './external-source-helpers.js';

// Pure: returns a shallow-augmented entry, doesn't mutate the input.
// No-op if crMeta is missing or has no tag-like fields.
//
// CR's tagging is honest but independent of AL — CR may tag a show
// with categories AL missed (Comedy, Drama, Romance) or keywords
// (Heroic, Coming of Age) that add real signal. Bridge by case-
// insensitive name match: if AL already has the tag, AL's wins (its
// rank is more precise). Net new CR tags get rank 70 (mid-strength —
// present but not show-defining).
export function mergeCrTagsIntoEntry(entry, crMeta) {
  if (!crMeta || !entry) return entry;
  const seen = new Set();
  for (const t of entry.tags || []) if (t?.name) seen.add(t.name.toLowerCase());
  for (const g of entry.genres || []) if (g) seen.add(g.toLowerCase());

  const tagsOut = [...(entry.tags || [])];
  const genresOut = [...(entry.genres || [])];

  // tenant_categories is CR's genre-equivalent — broader categorical
  // labels (Action, Drama, Romance, etc.). Treat as supplemental
  // genres so they implicitly get rank 100 in scoring.
  for (const cat of crMeta.tenantCategories || []) {
    if (!cat) continue;
    const k = String(cat).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    genresOut.push(cat);
  }

  // CR keywords are finer-grained tag-likes. Add at rank 70 — mid-
  // strength because CR's keyword tagging is less rank-precise than
  // AL's community-voted ranks.
  for (const kw of crMeta.keywords || []) {
    if (!kw) continue;
    const k = String(kw).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    tagsOut.push({ name: kw, rank: 70, category: 'CR Keyword', isMediaSpoiler: false });
  }

  return { ...entry, tags: tagsOut, genres: genresOut };
}

// Apply mergeCrTagsIntoEntry across the whole cache. Returns a fresh
// object — original aniListCache untouched.
export function augmentCacheWithCrTags(aniListCache, crSeriesMeta) {
  const out = {};
  for (const [crId, entry] of Object.entries(aniListCache || {})) {
    out[crId] = mergeCrTagsIntoEntry(entry, crSeriesMeta?.[crId]);
  }
  return out;
}

// Empty-watchShapes shell for survey-only users (no real CR sync).
// Without this, computeTasteVector would have nothing to iterate
// over and the survey taps would silently disappear. Caller must
// still ensure surveyShapes/surveyTagShapes are non-empty before
// using this stub — synthesizeSurveyContributions builds it on demand.
const EMPTY_WATCH_SHAPES = Object.freeze({
  series: {},
  summary: Object.freeze({
    completed: 0, inProgress: 0, paused: 0,
    droppedEarly: 0, droppedMid: 0, sampled: 0,
    seriesWithRewatches: 0, rewatchedEpisodeCount: 0,
  }),
});

// Fold Quick Taste Check signals into the watchShapes/cache that the
// taste-vector pipeline consumes. Two channels:
//
//   Show taps (surveyShapes) — synthesized as fake watchShape entries
//   keyed `survey:${aniListId}` with completionRatio 1.0/0.3 (loved/
//   disliked) and _surveyOrigin: true so seriesWeightFor applies the
//   0.6 dampening. Real-watch precedence: any AL ID with a real CR
//   watchShape skips its survey entry. Bridge-cache miss is also
//   skipped (and the AL ID logged for the bridge-fill auto-retry).
//
//   Tag taps (surveyTagShapes) — direct ±SURVEY_TAG_WEIGHT injection
//   into raw[tag] downstream, bypassing the inference pipeline.
//
// Returns:
//   {
//     effectiveWatchShapes,     // base + synthetic (or stub for
//                               //   survey-only users)
//     effectiveCache,           // augmentedCache + cache additions
//     surveyTagBoosts,          // {[tag]: ±0.6} for computeTasteVector
//     applyState,               // diag blob for surveyApplyState write
//   }
// Or null when the caller has nothing to compute against (no real
// history AND no survey signals).
export function synthesizeSurveyContributions({
  watchShapes,
  surveyShapes,
  surveyTagShapes,
  aniListCache,
  augmentedCache,
  bridgeCache,
}) {
  const hasSurveyShows = surveyShapes && Object.keys(surveyShapes).length > 0;
  const hasSurveyTags = surveyTagShapes && Object.keys(surveyTagShapes).length > 0;
  if (!watchShapes && !(hasSurveyShows || hasSurveyTags)) return null;

  // Survey-only users: synthesize a stub watchShapes so the rest of
  // the pipeline runs end-to-end without the early-return that used
  // to silently drop their taps.
  let baseWatchShapes = watchShapes || EMPTY_WATCH_SHAPES;

  // Real-watch precedence — index AL IDs that have actual CR shapes
  // so survey taps for those shows get skipped (real behavior wins).
  const realWatchAniListIds = new Set();
  for (const [crId] of Object.entries(baseWatchShapes.series || {})) {
    const al = aniListCache?.[crId];
    if (al?.aniListId != null) realWatchAniListIds.add(al.aniListId);
  }

  const syntheticShapes = {};
  const cacheAdditions = {};
  let syntheticCount = 0;
  let syntheticSkippedNoMedia = 0;
  let syntheticSkippedRealWatch = 0;
  // AL IDs whose tap couldn't be folded because the bridge cache
  // hadn't returned their Media yet. Persisted by the caller so the
  // bridge-cache change listener can re-trigger recompute when any
  // arrive.
  const skippedNoMediaIds = [];
  for (const [aniListIdStr, surveyEntry] of Object.entries(surveyShapes || {})) {
    const aniListId = Number(aniListIdStr);
    if (!aniListId || !surveyEntry?.state) continue;
    if (realWatchAniListIds.has(aniListId)) {
      syntheticSkippedRealWatch++;
      continue;
    }
    const media = bridgeCache?.[aniListId];
    if (!media) {
      syntheticSkippedNoMedia++;
      skippedNoMediaIds.push(aniListId);
      continue;
    }
    const synthKey = `survey:${aniListId}`;
    const isLoved = surveyEntry.state === 'loved';
    const isDisliked = surveyEntry.state === 'disliked';
    if (!isLoved && !isDisliked) continue;
    syntheticShapes[synthKey] = {
      label: isLoved ? 'completed' : 'dropped-mid',
      completionRatio: isLoved ? 1.0 : 0.3,
      epsWatched: 1,
      lastPlayedAt: new Date(surveyEntry.tappedAt || Date.now()).toISOString(),
      monthsSinceLastPlay: 0,
      isRewatched: false,
      crossAudioRewatch: false,
      rewatchedEpisodes: [],
      _surveyOrigin: true,
    };
    cacheAdditions[synthKey] = mergeCrTagsIntoEntry(media, null);
    syntheticCount++;
  }

  const effectiveWatchShapes = syntheticCount > 0
    ? { ...baseWatchShapes, series: { ...baseWatchShapes.series, ...syntheticShapes } }
    : baseWatchShapes;
  const effectiveCache = syntheticCount > 0
    ? { ...augmentedCache, ...cacheAdditions }
    : augmentedCache;

  // Tag taps → direct boosts map.
  const surveyTagBoosts = {};
  let tagTapCount = 0;
  for (const [tag, entry] of Object.entries(surveyTagShapes || {})) {
    if (!tag || !entry?.state) continue;
    if (entry.state === 'loved')    { surveyTagBoosts[tag] = +SURVEY_TAG_WEIGHT; tagTapCount++; }
    if (entry.state === 'disliked') { surveyTagBoosts[tag] = -SURVEY_TAG_WEIGHT; tagTapCount++; }
  }

  return {
    effectiveWatchShapes,
    effectiveCache,
    surveyTagBoosts,
    applyState: {
      foldedShows: syntheticCount,
      skippedRealWatch: syntheticSkippedRealWatch,
      skippedNoMedia: syntheticSkippedNoMedia,
      skippedNoMediaIds,
      foldedTags: tagTapCount,
      appliedAt: Date.now(),
    },
  };
}

// Synthesize watch-shape entries from imported AniList/MAL list-status
// for shows the user has rated/marked externally but never started
// on Crunchyroll. Without this, an aniListId in externalScores that
// has no matching watchShapes.series entry is "stranded" — the taste-
// vector loop never iterates past it because it iterates by CR series
// id. Per CONTEXT.md "External score" + the 2026-05-04 grilling
// pass (a), we synthesize a shape from list-status:
//   completed  → label 'completed', completionRatio 1.0
//   dropped    → label 'dropped-mid', completionRatio 0.4
// (Other statuses — watching/paused/planning — skipped; intent
// without engagement isn't enough to anchor a synthesized shape.)
//
// Synthetic shapes carry _externalOrigin: true so future code that
// wants to differentiate them (e.g., lower confidence in
// deriveConfidence, exclude from validation snapshots) has a flag
// to read. The Sentiment seam already accepts the externalScores
// channel for the score+confidence contribution; this function
// provides the *vehicle* (a synthesized shape entry) that gets the
// engine's per-series loop to visit them at all.
//
// Real-watch precedence is preserved — aniListIds with an existing
// shape (from real CR data OR an earlier survey-synthesis pass)
// are skipped so they don't get shadowed.
//
// Inputs:
//   baseWatchShapes — output of synthesizeSurveyContributions or
//                     raw watchShapes; we add to it
//   augmentedCache  — the same level's cache (includes any survey-
//                     synthesized cache entries)
//   externalScores  — { [aniListId]: { anilist?: {…}, mal?: {…} } }
//                     from chrome.storage.local.externalScores
//   bridgeCache     — aniListBridgeCache (AL-id-keyed Media projections)
//
// Returns the same shape as synthesizeSurveyContributions for
// chainable composition.

// External list-status → synthesized shape config. completed maps
// to a full-completion shape; dropped to a mid-drop. Other statuses
// (watching/paused/planning) deliberately skipped — see comment above.
const EXTERNAL_STATUS_SHAPE = {
  completed: { label: 'completed',   completionRatio: 1.0 },
  dropped:   { label: 'dropped-mid', completionRatio: 0.4 },
};

export function synthesizeExternalShapes({
  baseWatchShapes,
  augmentedCache,
  externalScores,
  bridgeCache,
}) {
  if (!externalScores || Object.keys(externalScores).length === 0) {
    return {
      effectiveWatchShapes: baseWatchShapes,
      effectiveCache: augmentedCache,
      applyState: { foldedShows: 0, skippedExisting: 0, skippedNoMedia: 0, skippedNoStatus: 0, skippedNonEngaging: 0 },
    };
  }
  // Index aniListIds that already have a shape (real CR or earlier
  // synthesis). Includes BOTH crSeriesId-keyed real entries (look up
  // aniListId via cache) and synthetic-keyed entries (already encode
  // aniListId in their key like 'survey:12345').
  // Synthetic key match is a strict regex — `seriesKey.split(':')`
  // would silently misinterpret keys with multiple colons. Anchored
  // pattern with named tokens makes the invariant explicit.
  const SYNTHETIC_KEY_RE = /^(survey|external):(\d+)$/;
  const existingAniListIds = new Set();
  for (const [seriesKey, _shape] of Object.entries(baseWatchShapes?.series || {})) {
    const synthMatch = typeof seriesKey === 'string' ? seriesKey.match(SYNTHETIC_KEY_RE) : null;
    if (synthMatch) {
      const aniListId = Number(synthMatch[2]);
      if (Number.isInteger(aniListId)) existingAniListIds.add(aniListId);
      continue;
    }
    const al = augmentedCache?.[seriesKey];
    if (Number.isInteger(al?.aniListId)) existingAniListIds.add(al.aniListId);
  }

  const syntheticShapes = {};
  const cacheAdditions = {};
  let foldedShows = 0;
  let skippedExisting = 0;
  let skippedNoMedia = 0;
  let skippedNoStatus = 0;
  let skippedNonEngaging = 0;

  for (const [aniListIdStr, sources] of Object.entries(externalScores)) {
    const aniListId = Number(aniListIdStr);
    if (!Number.isInteger(aniListId)) continue;
    if (existingAniListIds.has(aniListId)) {
      skippedExisting++;
      continue;
    }
    // Pick the dominant source via the shared helper — AL takes
    // precedence when linked, MAL next, freeform last. Adding any
    // future source requires only updating EXTERNAL_SOURCES.
    // Critical fix 2026-05-19: prior to this, freeform-only entries
    // were silently skipped by synthesizeExternalShapes, meaning their
    // status/score never reached the taste vector.
    const sourceEntry = pickDominantSource(sources);
    if (!sourceEntry?.status) {
      skippedNoStatus++;
      continue;
    }
    const shapeCfg = EXTERNAL_STATUS_SHAPE[sourceEntry.status];
    if (!shapeCfg) {
      skippedNonEngaging++;
      continue;
    }
    const media = bridgeCache?.[aniListId];
    if (!media) {
      skippedNoMedia++;
      continue;
    }
    const synthKey = `external:${aniListId}`;
    // updatedAt from AL/MAL is Unix epoch seconds (last list mutation
    // — rating change, status flip, progress update). Used by
    // series-sentiment's recencyFactorFor (36-month half-life). Without
    // this calculation, every imported entry got monthsSinceLastPlay=0
    // hardcoded, treating a 2-year-old rating with the same weight as
    // yesterday's. 2026-05-04 audit fix.
    let monthsSinceLastPlay = 0;
    let updatedAtIso = new Date().toISOString();
    if (typeof sourceEntry.updatedAt === 'number' && sourceEntry.updatedAt > 0) {
      const updatedMs = sourceEntry.updatedAt * 1000;
      updatedAtIso = new Date(updatedMs).toISOString();
      monthsSinceLastPlay = Math.max(0, (Date.now() - updatedMs) / (30 * 24 * 60 * 60 * 1000));
    }
    // For dropped entries, prefer the actual episodes-watched ratio
    // over the 0.4 default heuristic when AL gives us both progress
    // and the show's episode count. A drop at ep 1/12 (8% completion)
    // is a much weaker negative signal than a drop at ep 9/12 (75%);
    // hardcoding 0.4 averaged them. Completed entries stay at 1.0
    // (that's the definition; AL might report progress=12/12 or
    // progress=0 for a "completed without tracking" entry — neither
    // changes the result).
    let completionRatio = shapeCfg.completionRatio;
    if (
      sourceEntry.status === 'dropped'
      && typeof sourceEntry.progress === 'number' && sourceEntry.progress > 0
      && typeof media.episodes === 'number' && media.episodes > 0
    ) {
      completionRatio = Math.min(1, sourceEntry.progress / media.episodes);
    }
    syntheticShapes[synthKey] = {
      label: shapeCfg.label,
      completionRatio,
      epsWatched: sourceEntry.progress || 1,
      lastPlayedAt: updatedAtIso,
      monthsSinceLastPlay,
      isRewatched: false,
      crossAudioRewatch: false,
      rewatchedEpisodes: [],
      _externalOrigin: true,
    };
    cacheAdditions[synthKey] = mergeCrTagsIntoEntry(media, null);
    foldedShows++;
  }

  const effectiveWatchShapes = foldedShows > 0
    ? { ...baseWatchShapes, series: { ...baseWatchShapes.series, ...syntheticShapes } }
    : baseWatchShapes;
  const effectiveCache = foldedShows > 0
    ? { ...augmentedCache, ...cacheAdditions }
    : augmentedCache;

  return {
    effectiveWatchShapes,
    effectiveCache,
    applyState: { foldedShows, skippedExisting, skippedNoMedia, skippedNoStatus, skippedNonEngaging },
  };
}

// Run the three-mode taste-vector compute, sharing the mode-
// independent prep across all three calls. Returns the trio plus a
// stamped computedAt. Caller persists the storage writes.
export function computeAllTasteVectors({
  effectiveWatchShapes,
  effectiveCache,
  surveyTagBoosts,
  surveyTagShapes,  // raw { [tag]: { state, tappedAt } } map for the override
  userRatings,
  userReactions,
  watchlistBySeries,
  externalScores,
  cachedPrep,
  modes,  // optional ['all'] | ['all', 'peak', 'comfort'] (default: all three)
}) {
  // cachedPrep optionally provided by the orchestrator via the
  // runner-built vectorPrep stage. When present (and matches the
  // current effective inputs), skip the ~150ms rebuild. Caller is
  // responsible for cache validity — only pass cachedPrep when
  // effective* are equivalent to the raw inputs the cache was built
  // from (i.e., no survey synthesis happened this recompute).
  const prep = cachedPrep || buildTasteVectorPrep(effectiveWatchShapes, effectiveCache);
  const computedAt = Date.now();
  const sharedExtras = { userRatings, userReactions, watchlistBySeries, externalScores };
  const wantModes = Array.isArray(modes) && modes.length > 0
    ? new Set(modes) : new Set(['all', 'peak', 'comfort']);
  // Build the behavioral vectors first (no override applied yet).
  // Override is applied per-mode below so each mode's vector reflects
  // the user's stated preferences regardless of what mode-specific
  // behavioral signal said. surveyTagBoosts is now legacy / unused;
  // surveyTagShapes drives the floor/ceiling override.
  const vectorAll = computeTasteVector(effectiveWatchShapes, effectiveCache,
    { surveyTagBoosts, prep, ...sharedExtras });
  const vectorPeak = wantModes.has('peak')
    ? computeTasteVector(effectiveWatchShapes, effectiveCache,
        { mode: 'peak', surveyTagBoosts, prep, ...sharedExtras })
    : null;
  const vectorComfort = wantModes.has('comfort')
    ? computeTasteVector(effectiveWatchShapes, effectiveCache,
        { mode: 'comfort', surveyTagBoosts, prep, ...sharedExtras })
    : null;
  // Apply stated-preference override on top of behavioral. The
  // override fires AFTER the behavioral build so floor/ceiling
  // semantics work cleanly: behavior already past the floor → no-op;
  // behavior below floor → override forces the floor. Same per mode
  // since each mode's behavioral mass differs but the user's stated
  // preference applies regardless of mode.
  // Architecture decision (per /improve-codebase-architecture grill):
  // override targets PEAK VECTOR ONLY. the user's all-vector at +17 on
  // Ecchi already reflects his blended ecchi watching (peak-tier love
  // + comfort-tier tolerance + drops). His tap on "Ecchi" means
  // "more of the GOOD ecchi I demonstrated love for" — the peak
  // vector is built from avgScore≥75 contributors so it carries that
  // distinction. Applying the override to all-vector or comfort-vector
  // would lift trash ecchi shows on cards (wrong) instead of just the
  // peak rec pool (right).
  //
  // The visible effect of a tap: side panel rec pool's peak bucket
  // surfaces more peak-tier ecchi recs. On-page cards (which use
  // all-vector) stay unchanged. The survey-side acknowledgment surface
  // (#2 of the architecture review) needs to communicate this.
  const vectorAllOverridden = vectorAll;        // unchanged
  const vectorComfortOverridden = vectorComfort; // unchanged
  const vectorPeakOverridden = (vectorPeak && surveyTagShapes)
    ? applyStatedPreferenceOverride(vectorPeak, surveyTagShapes)
    : vectorPeak;

  // Diagnostic: log every override that fired/no-op'd on the peak
  // vector. Tells us whether the user's taps actually translated
  // into peak-vector changes.
  if (vectorPeakOverridden?.overrideDiag) {
    const entries = Object.entries(vectorPeakOverridden.overrideDiag);
    if (entries.length > 0) {
      const bounds = vectorPeakOverridden.overrideBounds || {};
      console.log(`[crsmart] stated-preference override [peak] (floor=${bounds.floor?.toFixed(2)} ceiling=${bounds.ceiling?.toFixed(2)}):`,
        entries.map(([tag, d]) =>
          `${tag} ${d.state}: ${d.before.toFixed(2)} → ${d.after.toFixed(2)} (${d.fired ? 'fired' : 'no-op:' + (d.reason || '')})`
        ).join(' · '));
    } else {
      console.log('[crsmart] stated-preference override [peak]: no surveyTagShapes entries');
    }
  } else if (!surveyTagShapes) {
    console.log('[crsmart] stated-preference override [peak]: no surveyTagShapes input');
  } else if (!vectorPeak) {
    console.log('[crsmart] stated-preference override [peak]: vectorPeak not built (mode skipped)');
  } else {
    console.log('[crsmart] stated-preference override [peak]: surveyTagShapes had ' +
      Object.keys(surveyTagShapes).length + ' entries but override returned no diag');
  }
  return {
    vectorAll: { ...vectorAllOverridden, computedAt },
    vectorPeak: vectorPeakOverridden ? { ...vectorPeakOverridden, computedAt } : null,
    vectorComfort: vectorComfortOverridden ? { ...vectorComfortOverridden, computedAt } : null,
    prep,
  };
}
