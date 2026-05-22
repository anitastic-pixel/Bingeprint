// Typed storage seam for the extension.
//
// Pre-this-module, ~90 chrome.storage.local.get/set call sites across
// background.js, content.js, popup.js, survey.js, and sidepanel.js
// each carried their own raw key strings ('tasteVector', 'archetypeBlend',
// 'surveyShapes', ...) plus their own default-fallback patterns. There
// was no module that owned the persistence schema — schema renames meant
// grep-replace across five files, and there was no single answer to
// "what's persisted, in what shape, with what nullability."
//
// This module owns:
//   1. The canonical key constants for every persisted resource
//      (STORAGE_KEYS export — point of truth for renames + audits)
//   2. Convenience read accessors that fetch a known group of keys in
//      one IPC round-trip (getTasteState, getSurveyState, ...)
//   3. A single chrome.storage.onChanged listener that fans out to
//      keyed subscribers via subscribe(key, handler) — replaces the
//      five separate onChanged wires that each surface used to set up.
//
// Adoption is incremental: existing call sites still work against
// chrome.storage directly. New code (and refactors) should reach for
// the typed accessors here so the schema knowledge concentrates in
// one place over time.

// ── Key catalogue ────────────────────────────────────────────────
// Every storage key the codebase persists. Grep-friendly: rename one
// constant, every consumer follows.

export const STORAGE_KEYS = Object.freeze({
  // ── Taste pipeline outputs ──────────────────────────────────
  tasteVector:           'tasteVector',           // legacy 'all' diagnostic
  tasteVectorPeak:       'tasteVectorPeak',       // peak-mode (avg ≥ threshold)
  tasteVectorComfort:    'tasteVectorComfort',    // comfort-mode (avg < threshold)
  archetypeBlend:        'archetypeBlend',        // ranked archetype list (sorted desc by score, see scoreArchetypes)
  tasteDimensions:       'tasteDimensions',       // signed-cosine dim scores (sorted desc by score, see scoreDimensions)
  tasteShapeRadar:       'tasteShapeRadar',       // G09: 8-axis viewing-psych radar
  dealbreakerCandidates: 'dealbreakerCandidates', // suggested anti-tags
  studioCreatorIndex:    'studioCreatorIndex',    // studio + creator affinity (+ topStudios/topCreators top-30 id arrays sorted by totalWeight)
  watchHistoryScored:    'watchHistoryScored',    // calibration: history × vector
  recommendationCandidates: 'recommendationCandidates', // dual-mode rec pools
  recommendationsScored: 'recommendationsScored', // rerank output
  allShowsScored:        'allShowsScored',        // tier-1: every cache entry scored
  allShowsScoredMeta:    'allShowsScoredMeta',    // schema version of above

  // ── Watch / catalog state ──────────────────────────────────
  watchShapes:           'watchShapes',           // derived from CR history
  aniListCache:          'aniListCache',          // CR-id-keyed AL projections
  aniListBridgeCache:    'aniListBridgeCache',    // AL-id-keyed bulk-fetch cache
  aniListMeta:           'aniListMeta',           // enrichment progress
  aniListFetchProgress:  'anilistFetchProgress',  // active fetch %
  crSeriesMeta:          'crSeriesMeta',          // CR API enrichment
  crToAniListId:         'crToAniListId',         // crSeriesId → aniListId
  crHistorySummary:      'crHistorySummary',      // sync summary
  crHistorySyncing:      'crHistorySyncing',      // sync-in-flight flag
  crHistoryProgress:     'crHistoryProgress',     // sync %
  popularSeedDone:       'popularSeedDone',       // one-shot bootstrap flag

  // ── Survey state ───────────────────────────────────────────
  surveyShapes:          'surveyShapes',          // Quick Taste Check show taps
  surveyTagShapes:       'surveyTagShapes',       // Genres-mode tag taps
  surveyStudioShapes:    'surveyStudioShapes',    // Studios-mode studio taps (data collection only; engine wiring deferred)
  surveyApplyState:      'surveyApplyState',      // last-apply diag (skipped count)
  surveyViewPref:        'surveyViewPref',        // mainstream/all/deepcuts
  surveyActiveMode:      'surveyActiveMode',      // shows/genres
  surveyMatureFilter:    'surveyMatureFilter',    // mature toggle bool
  surveyServiceFilter:   'surveyServiceFilter',   // service-pill filter
  surveyOnboardingDismissed: 'surveyOnboardingDismissed',

  // ── User feedback ──────────────────────────────────────────
  userRatings:           'userRatings',           // per-show rating overlay
  userReactions:         'userReactions',         // per-show reaction tags
  surfaceSettings:       'surfaceSettings',       // dealbreakerTags + sliders

  // ── Collaborative-filtering re-ranker (ADR-0003 bounded exception) ─
  // Silent re-ranker — nudges internal ranking score only, never the
  // displayed Smart Score. Default OFF; turned ON via popup dev row
  // during Phase D observation; default ON for all users only after
  // Phase D passes. See docs/CF-RERANKER-DESIGN.md.
  cfEnabled:             'cfEnabled',             // boolean feature flag
  cfDevPills:            'cfDevPills',            // bool: show per-card CF Δ pills in side panel (dev affordance; toolbar side panel can't pass ?dev=1)
  _cfDiagnostics:        '_cfDiagnostics',        // synthetic — last fold-in size, delta histogram (dev only)

  // ── Auth / identity (session storage, see session keys below) ─
  profileId:             'profileId',             // CR profile id (local)
  lastSeenAt:            'lastSeenAt',            // bridge keepalive

  // ── External-source linking (AniList + MAL OAuth) ──────────
  // Per CONTEXT.md "External score" — imports from linked AniList /
  // MAL accounts fold into Sentiment. Tokens stored unencrypted in
  // chrome.storage.local with read-only scopes (see oauth-manager.js
  // for the security tradeoff). 2026-05-04.
  oauthTokens:           'oauthTokens',           // { anilist?: {…}, mal?: {…} }
  externalScores:        'externalScores',        // imported scores per Series, by source
  _importState:          '_importState',          // synthetic — import progress + accumulator (NOT a pipeline input; never triggers recompute)
  _devAxisSandbox:       '_devAxisSandbox',       // synthetic — dev axis-sandbox slider state (NOT a pipeline input)

  // ── Quality / dim diagnostics ──────────────────────────────
  qualityIndex:          'qualityIndex',          // director/studio priors
  qualityCorpusMeta:     'qualityCorpusMeta',     // sample-count gates
  _tagNameDumpDone:      '_tagNameDumpDone',      // one-shot diag stamp
});

// session storage — cleared on browser restart, carries the auth token.
export const SESSION_KEYS = Object.freeze({
  crToken:               'crToken',
  crTokenAt:             'crTokenAt',
});

// ── Read helpers ─────────────────────────────────────────────────
// Each helper returns a plain object with default fallbacks, plus the
// single IPC round-trip that backs it. Callers that read multiple
// related keys should prefer the grouped helper over multiple
// individual gets.

// Pull a single key with a default. Wraps the chrome.storage shape so
// callers stop writing the destructure-with-default pattern by hand.
export async function get(key, fallback = null) {
  try {
    const data = await chrome.storage.local.get(key);
    return data[key] ?? fallback;
  } catch (_) {
    return fallback;
  }
}

// Pull many keys in one IPC. Returns a plain object keyed the same.
// Missing keys are absent (not undefined); callers can use destructure
// with their own defaults.
export async function getMany(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (_) {
    return {};
  }
}

export async function set(key, value) {
  try { await chrome.storage.local.set({ [key]: value }); } catch (_) {}
}

export async function setMany(map) {
  try { await chrome.storage.local.set(map); } catch (_) {}
}

export async function remove(keys) {
  try { await chrome.storage.local.remove(keys); } catch (_) {}
}

// ── Grouped accessors ────────────────────────────────────────────
// Pre-built read groups for hot paths so a single round-trip
// reads everything a consumer wants. Add new groups as new
// consumers emerge.

// All three taste-vector modes + the archetype blend + dimensions.
// Used by surfaces that paint the "your taste shape" UI.
export async function getTasteState() {
  const data = await getMany([
    STORAGE_KEYS.tasteVector,
    STORAGE_KEYS.tasteVectorPeak,
    STORAGE_KEYS.tasteVectorComfort,
    STORAGE_KEYS.archetypeBlend,
    STORAGE_KEYS.tasteDimensions,
    STORAGE_KEYS.dealbreakerCandidates,
  ]);
  return {
    tasteVector: data.tasteVector || null,
    tasteVectorPeak: data.tasteVectorPeak || null,
    tasteVectorComfort: data.tasteVectorComfort || null,
    archetypeBlend: data.archetypeBlend || null,
    tasteDimensions: data.tasteDimensions || null,
    dealbreakerCandidates: data.dealbreakerCandidates || null,
  };
}

// Survey-side mutable state — taps + tag taps + last-apply diag.
// Used by the popup's footprint row, the survey UI's reset path,
// and the worker's recompute orchestrator.
export async function getSurveyState() {
  const data = await getMany([
    STORAGE_KEYS.surveyShapes,
    STORAGE_KEYS.surveyTagShapes,
    STORAGE_KEYS.surveyApplyState,
  ]);
  return {
    surveyShapes: data.surveyShapes || {},
    surveyTagShapes: data.surveyTagShapes || {},
    surveyApplyState: data.surveyApplyState || null,
  };
}

// Wipe survey state — used by the popup's clear-survey-taps button
// and the survey page's per-refresh reset. Storage onChanged listeners
// elsewhere pick up the deletes and trigger debounced recompute.
export async function clearSurveyState() {
  await remove([
    STORAGE_KEYS.surveyShapes,
    STORAGE_KEYS.surveyTagShapes,
    STORAGE_KEYS.surveyApplyState,
  ]);
}

// Inputs that the taste-pipeline pass reads from storage in one
// IPC. The pipeline itself doesn't touch storage (pure functions);
// the worker calls this helper once and feeds the result in.
// Defaults are populated so downstream code can trust shapes.
export async function getRecomputeInputs() {
  const data = await getMany([
    STORAGE_KEYS.aniListCache,
    STORAGE_KEYS.crSeriesMeta,
    STORAGE_KEYS.surveyShapes,
    STORAGE_KEYS.surveyTagShapes,
    STORAGE_KEYS.aniListBridgeCache,
    STORAGE_KEYS.watchShapes,
    STORAGE_KEYS.userRatings,
    STORAGE_KEYS.userReactions,
    STORAGE_KEYS.externalScores,
    'crWatchlist',
  ]);
  // Deprecated-tag-key scrubbing lives in survey-state.js's
  // restoreFromStorage now (the canonical owner of survey shapes).
  // The redundant scrub here was removed 2026-05-04 cleanup pass.
  const tagShapes = data.surveyTagShapes || {};
  return {
    aniListCache: data.aniListCache || {},
    crSeriesMeta: data.crSeriesMeta || {},
    surveyShapes: data.surveyShapes || {},
    surveyTagShapes: tagShapes,
    bridgeCache: data.aniListBridgeCache || {},
    watchShapes: data.watchShapes || null,
    userRatings: data.userRatings || {},
    userReactions: data.userReactions || {},
    externalScores: data.externalScores || {},
    crWatchlist: data.crWatchlist || null,
  };
}

// Inputs that computeAllShowsScored reads — overlaps with
// getRecomputeInputs but also pulls watchlist + CR personal recs
// + reactions for the boost calculations.
//
// `prefetched` (optional) lets callers that already have the heavy
// keys (aniListCache, watchShapes, bridgeCache, crSeriesMeta) hand
// them in to avoid double-deserialization. Per timing data, reading
// aniListCache costs ~300ms; persistTasteVector already loaded it
// via getRecomputeInputs, so passing it through avoids paying the
// cost twice.
export async function getOffPoolScoringInputs(prefetched = {}) {
  // Only fetch keys we don't already have.
  const skipKeys = new Set();
  if (prefetched.aniListCache) skipKeys.add(STORAGE_KEYS.aniListCache);
  if (prefetched.bridgeCache) skipKeys.add(STORAGE_KEYS.aniListBridgeCache);
  if (prefetched.watchShapes) skipKeys.add(STORAGE_KEYS.watchShapes);
  if (prefetched.crSeriesMeta) skipKeys.add(STORAGE_KEYS.crSeriesMeta);
  if (prefetched.userReactions) skipKeys.add(STORAGE_KEYS.userReactions);
  if (prefetched.userRatings) skipKeys.add(STORAGE_KEYS.userRatings);
  const allKeys = [
    STORAGE_KEYS.aniListCache,
    STORAGE_KEYS.aniListBridgeCache,
    STORAGE_KEYS.watchShapes,
    'crWatchlist',
    'crPersonalRecs',
    STORAGE_KEYS.crSeriesMeta,
    STORAGE_KEYS.userReactions,
    STORAGE_KEYS.userRatings,
    'studioCreatorIndex',
  ];
  const fetchKeys = allKeys.filter(k => !skipKeys.has(k));
  const data = fetchKeys.length > 0 ? await getMany(fetchKeys) : {};
  return {
    aniListCache: prefetched.aniListCache || data.aniListCache || {},
    bridgeCache: prefetched.bridgeCache || data.aniListBridgeCache || {},
    watchShapes: prefetched.watchShapes || data.watchShapes || null,
    crWatchlist: data.crWatchlist || null,
    crPersonalRecs: data.crPersonalRecs || null,
    crSeriesMeta: prefetched.crSeriesMeta || data.crSeriesMeta || {},
    userReactions: prefetched.userReactions || data.userReactions || {},
    userRatings: prefetched.userRatings || data.userRatings || {},
    studioCreatorIndex: data.studioCreatorIndex || null,
  };
}

// ── Subscription seam ────────────────────────────────────────────
// Single chrome.storage.onChanged listener fans out to keyed
// subscribers. Each surface (popup, survey, content, sidepanel,
// background) used to register its own onChanged wire and then run
// an if-tree to dispatch by key — five parallel listeners on the
// same firehose. This module owns one, and the subscribers register
// against named keys.

// Lazy-registered global listener — we only attach to chrome.storage
// the first time someone subscribes, so importing this module from
// non-event-listening contexts (utility scripts) doesn't burn a
// listener slot.
const subscribers = new Map(); // key → Set<handler>
const sessionSubscribers = new Map(); // key → Set<handler>
let listenerAttached = false;

function ensureListenerAttached() {
  if (listenerAttached) return;
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  listenerAttached = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    const map = area === 'local' ? subscribers
              : area === 'session' ? sessionSubscribers
              : null;
    if (!map) return;
    for (const key of Object.keys(changes)) {
      const handlers = map.get(key);
      if (!handlers || handlers.size === 0) continue;
      // Snapshot before iteration — handlers may unsubscribe each other.
      for (const handler of [...handlers]) {
        try { handler(changes[key]); }
        catch (err) { console.warn(`[storage-schema] subscriber for ${key} threw`, err); }
      }
    }
  });
}

// Subscribe to changes on a storage key. Returns an unsubscribe fn.
// Handler receives the raw chrome.storage change record
// ({ oldValue, newValue }) so callers can diff if they need to.
//
// Signature: subscribe(key, handler) → unsubscribe()
//   subscribe([k1, k2], handler) is also accepted; the handler fires
//   on EITHER key changing, with the change record forwarded.
export function subscribe(key, handler, options = {}) {
  ensureListenerAttached();
  const area = options.area || 'local';
  const map = area === 'session' ? sessionSubscribers : subscribers;
  const keys = Array.isArray(key) ? key : [key];
  for (const k of keys) {
    let set = map.get(k);
    if (!set) { set = new Set(); map.set(k, set); }
    set.add(handler);
  }
  return () => {
    for (const k of keys) {
      const set = map.get(k);
      if (!set) continue;
      set.delete(handler);
      if (set.size === 0) map.delete(k);
    }
  };
}
