// Stage 1b — watch-history sync. Stage 1c — AniList enrichment.
//
// Fires when bridge.js writes a new crToken to chrome.storage.session.
// Paginates Crunchyroll's /content/v2/{profileId}/watch-history endpoint,
// projects each item to a stable internal shape, and persists under
// chrome.storage.local.crHistory[{profileId}] so multi-profile is a non-event.
//
// Trigger model: eager-on-token-observation, gated by 24h staleness check.
// We piggyback on the existing token-capture pipeline rather than adding
// chrome.alarms — the user is already on CR when the token fires, so
// the data is hot and the freshness window is reasonable.
//
// After history sync, kick off AniList enrichment for any series that
// don't already have a fresh cache entry (30-day TTL). Enrichment runs
// in the background at ~80 req/min, persisting incrementally — a worker
// restart only loses the in-flight item.

import { bulkEnrich, bulkFetchByIds, enrichOne, enrichOneByMappedId, fetchPopularCrShows, fetchTopShowsByTag, anilistIsPaused, anilistPauseMsLeft, SCHEMA_VERSION as ANILIST_SCHEMA_VERSION, hasTvRootCandidate, searchTopByTitle, searchTopByTitleBatched, fetchUserListByName } from './anilist.js';
import { deriveWatchShapes, unprojectedFields } from './watch-shapes.js';
import { buildSnapshot } from './validation-runner.js';
import { diversifyRanked } from './diversify-recs.js';
import { deriveRadar, proseFor, shapeIdentityFor, taglineFor, topAxes } from './radar-derive.js';
import { runAllNewLenses } from './lens-pipeline.js';
import { pickDominantSource, iterExternalSources } from './external-source-helpers.js';
import { LENSES } from './lens-registry.js';
import {
  augmentCacheWithCrTags,
  synthesizeSurveyContributions,
  synthesizeExternalShapes,
  computeAllTasteVectors,
} from './taste-pipeline.js';
import {
  STORAGE_KEYS,
  getMany,
  set as storageSet,
  getRecomputeInputs,
  getOffPoolScoringInputs,
} from './storage-schema.js';
import { computeTagBurnoutIndex } from './burnout-index.js';
import { scoreArchetypes } from './archetypes.js';
import { scoreDimensions, dimensionsWithZeroMagnitude, dealbreakerCandidates } from './dimensions.js';
import { syncExternalTags, EXTERNAL_TAGS_SCHEMA } from './external-tags.js';
import { annotateCacheWithQuality, buildQualityIndex, computeShowQuality } from './quality-axes.js';
import { scoreShow, scoreWatchHistory, prepareShow, scorePreparedShow } from './per-show-score.js';
import { buildFranchise, collectFranchiseNeighborhoodIds } from './franchise.js';
import { aggregateRecommendations } from './recommend.js';
import { rankRecommendations } from './rank-recommendations.js';
import * as cfEngine from './cf-engine.js';
import { computeStudioCreatorIndex } from './studio-creator-index.js';
import { computeReactionOverlay } from './reactions.js';
import { REACTION_TAGS_BY_KEY } from './reactions.js';
import { buildPercentileMapper } from './score-normalizer.js';
import { scoreAllShowsImpl } from './all-shows-scoring.js';
import { PipelineRunner } from './pipeline-runner.js';
import { vectorPrepStage } from './taste-vector.js';
import {
  authenticate as oauthAuthenticate,
  getAccount as oauthGetAccount,
  signOut as oauthSignOut,
  listLinkedSources as oauthListLinkedSources,
  getConfiguredSources as oauthGetConfiguredSources,
  AuthError,
} from './oauth-manager.js';
import {
  importFromAniList,
  importFromMal,
  importFromMalXml,
  importFromFreeform,
  clearSourceData,
  cancelActiveImport,
  getImportState,
} from './external-list-importer.js';
import * as gateway from './provider-gateway.js';
import * as cache from './cache-store.js';
import { markWelcomeProgress, refreshBadge, migrateLegacyWelcomeSeen } from './welcome-progress.js';

// Open the welcome tab on first install. Update + browser-restart
// fire onInstalled too — gate on reason='install' so we don't
// re-open the welcome screen every time the worker spins up.
// The welcome page hosts the cold-start choice (Quick Taste Check
// primary, AniList shortcut secondary, browse tertiary) — without
// it, a fresh install lands on a toolbar icon the user may never
// click.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Two paths trigger a tour fire:
  //   - reason='install' — brand new install, always fire
  //   - reason='update'  — existing user upgraded; fire ONLY if
  //                        tourSeen.completedAt is unset (i.e. this
  //                        is their first time encountering the tour
  //                        feature). Without this, users who had the
  //                        extension before the tour shipped never
  //                        see it on upgrade.
  if (reason !== 'install' && reason !== 'update') return;

  if (reason === 'install') {
    // Paint the toolbar badge dot ('!') so the icon advertises itself
    // until the user actually starts using Smart Scoring (any survey
    // tap, any list import, or first CR watch-shape clears it via
    // markWelcomeProgress in welcome-progress.js).
    refreshBadge();
    markWelcomeProgress('welcome-opened');
    fireTourOnCR();
    return;
  }

  // reason === 'update'. Run migration first so welcomeSeen → tourSeen
  // promotion is reflected; then check if tour was ever completed.
  await migrateLegacyWelcomeSeen();
  try {
    const stored = await chrome.storage.local.get('tourSeen');
    if (stored.tourSeen?.completedAt) return;
    fireTourOnCR();
  } catch (err) {
    console.warn('[crsmart-bg] update tour-fire check failed', err);
  }
});

// Quick Taste Check cold-start seed for aniListBridgeCache.
//
// data/survey-anchors-media.json is a static sidecar carrying pre-
// fetched AniList Media for the 265 archetype anchors + 54 genre
// representatives (deduped, 272 unique). Seeding the bridge cache
// from it means a fresh install renders the swipe with zero AniList
// round-trips, and the taste vector built from those swipes is real
// Stage-1d output rather than a placeholder waiting for hydration.
//
// Refresh the sidecar with `node tools/refresh-survey-sidecar.mjs`
// after editing the anchor files, BY_ID_QUERY/projectMedia, or
// SCHEMA_VERSION in anilist.js.
//
// Idempotent — bridgeCacheSeedSchema in storage records the last
// successfully-seeded schema. Match against current
// ANILIST_SCHEMA_VERSION short-circuits subsequent worker spin-ups;
// a schema bump forces a re-seed (and the resulting putBatch overwrites
// stale entries that the runtime would otherwise still serve).
async function seedBridgeCacheFromSidecar() {
  try {
    const { bridgeCacheSeedSchema } = await chrome.storage.local.get('bridgeCacheSeedSchema');
    if (bridgeCacheSeedSchema === ANILIST_SCHEMA_VERSION) {
      console.log(`[crsmart] bridge-seed: skip — already seeded at schema ${ANILIST_SCHEMA_VERSION}`);
      return;
    }

    const res = await fetch(chrome.runtime.getURL('data/survey-anchors-media.json'));
    if (!res.ok) {
      console.warn('[crsmart] bridge-seed: sidecar fetch failed', res.status);
      return;
    }
    const sidecar = await res.json();
    if (sidecar._schema !== ANILIST_SCHEMA_VERSION) {
      console.warn(
        `[crsmart] bridge-seed: sidecar schema ${sidecar._schema} != engine schema ${ANILIST_SCHEMA_VERSION} ` +
        '— skipping; rerun tools/refresh-survey-sidecar.mjs to regenerate'
      );
      return;
    }

    const entries = sidecar.media || {};
    const ids = Object.keys(entries).map(Number).filter(Number.isInteger);
    const stale = await cache.getStaleIds('aniListBridgeCache', ids);
    const alreadyCached = ids.length - stale.length;

    const additions = {};
    for (const id of stale) {
      const entry = entries[id];
      if (entry && entry._schema === ANILIST_SCHEMA_VERSION) {
        additions[id] = entry;
      }
    }
    if (Object.keys(additions).length > 0) {
      await cache.putBatch('aniListBridgeCache', additions);
    }
    await chrome.storage.local.set({ bridgeCacheSeedSchema: ANILIST_SCHEMA_VERSION });
    console.log(
      `[crsmart] bridge-seed: complete — ${Object.keys(additions).length} seeded from sidecar, ` +
      `${alreadyCached} already cached, ${stale.length - Object.keys(additions).length} stale-but-not-in-sidecar ` +
      `(of ${ids.length} anchor IDs, schema ${ANILIST_SCHEMA_VERSION})`
    );
  } catch (err) {
    console.warn('[crsmart] bridge-seed failed:', err);
  }
}

// Re-paint the badge on every worker boot (suspend / resume cycles
// otherwise drop the badge text). Also runs the legacy welcomeSeen →
// tourSeen migration once — idempotent if already done.
(async () => {
  await migrateLegacyWelcomeSeen();
  await refreshBadge();
  await seedBridgeCacheFromSidecar();
})();

// Show-tour entry point — used by install handler, popup menu's
// "Show me around again," and the top-bar tour button.
//
// Tab targeting precedence (this matters — picking the wrong tab is
// exactly the bug the first cut hit):
//   1. preferredTabId   — caller-specified, e.g. sender.tab.id from a
//                         content-script click. Always wins because we
//                         know exactly which tab the user touched.
//   2. active CR tab    — chrome.tabs.query({active, lastFocusedWindow}).
//                         Covers the popup-menu re-watch path (popup
//                         has no sender.tab; user's foreground tab is
//                         the right context).
//   3. any open CR tab  — last-resort if no CR tab is active. Better
//                         than opening a new one when the user has CR
//                         already in some background window.
//   4. open CR + flag   — no CR tab anywhere; open one and let the
//                         session flag trigger tour.js on first inject.
// CF re-ranker (ADR-0003) — build the cfApply closure passed to
// rankRecommendations. Returns null when cfEnabled is off, the engine
// fails to init, the user has no usable ratings, or the fold-in
// produces a degenerate vector. Cheap to call multiple times per
// recompute — cfEngine.init() is idempotent + de-duped.
//
// Signal fold-in (extended 2026-05-15 from explicit ratings to all
// available implicit channels):
//
//   1. AniList/MAL imported scores  — explicit 1-10, full confidence
//   2. In-extension thumbs (±1)     — coarse-mapped to 9/2, full conf
//   3. Watch-completion (watchShapes) — completed → 8, in-progress
//      gradient-mapped from completionRatio, dropped → 2-3, sampled
//      → 4. Confidence 0.5-0.6 (weaker than explicit ratings)
//   4. Watchlist (crWatchlist)      — favorited → 7, plain → 5.
//      Aspirational signal, confidence 0.3
//   5. Reactions (userReactions)    — sentiment derived from tagged
//      reaction weights via REACTION_TAGS_BY_KEY, confidence 0.7
//
// MAX-per-show resolution: when a single show carries multiple signals
// (e.g. AniList imported + watch-completed + reacted), the strongest
// effective contribution wins. Prevents double-counting.
//
// Time decay: applied to INFERRED signals only (watch-shape, watchlist
// — aspirational intent), per north-star commitment that stated signals
// (ratings, reactions, survey taps) don't decay. Stated signals pass
// null-timestamps to keep decay = 1.0. A timestamped statement is still
// a statement; it shouldn't quietly erode under the user.
//
// Rationale: persona (a) cold-start users who rate nothing explicitly
// still get useful fold-in via watch-completion as they accumulate
// CR history. Pre-Tier-1, this user got CF-zero.
const SIGNAL_HALF_LIFE_DAYS = 365;

function decayFactor(timestampMs, nowMs) {
  if (!timestampMs || !Number.isFinite(timestampMs)) return 1.0;
  const ageDays = Math.max(0, (nowMs - timestampMs) / (1000 * 60 * 60 * 24));
  return Math.exp(-ageDays / SIGNAL_HALF_LIFE_DAYS);
}

// Derive (score, signalStrength, timestamp) from a watch-shape entry.
// Strength caps how much the rating contributes vs explicit signal.
function watchShapeSignal(shape) {
  if (!shape) return null;
  const label = shape.label;
  const ratio = typeof shape.completionRatio === 'number'
    ? shape.completionRatio : null;
  const ts = shape.lastPlayedAt
    ? (typeof shape.lastPlayedAt === 'number' ? shape.lastPlayedAt : Date.parse(shape.lastPlayedAt))
    : null;
  if (label === 'completed') {
    // Rewatched-completed is the strongest implicit positive we have.
    const score = shape.isRewatched ? 9 : 8;
    return { score, strength: shape.isRewatched ? 0.7 : 0.6, ts };
  }
  if (label === 'inProgress' || label === 'in-progress') {
    // Gradient on completion: half-done → 7, just started → 5.
    const r = ratio != null ? ratio : 0.5;
    const score = 5 + Math.round(4 * r); // 5..9
    return { score, strength: r > 0.5 ? 0.5 : 0.3, ts };
  }
  if (label === 'paused') {
    return { score: 6, strength: 0.4, ts };
  }
  if (label === 'sampled') {
    return { score: 4, strength: 0.3, ts };
  }
  if (label === 'droppedEarly' || label === 'dropped-early') {
    return { score: 2, strength: 0.6, ts };
  }
  if (label === 'droppedMid' || label === 'dropped-mid') {
    return { score: 3, strength: 0.6, ts };
  }
  return null;
}

// Aggregate sentiment from a userReactions entry. Maps tagged reactions
// (positive + negative) to a 0-10 score via the curated REACTION_TAGS
// weights, then computes a confidence based on tag count.
function reactionSignal(entry) {
  if (!entry || !Array.isArray(entry.tags) || entry.tags.length === 0) return null;
  let totalWeight = 0;
  let nCounted = 0;
  for (const tagKey of entry.tags) {
    const r = REACTION_TAGS_BY_KEY[tagKey];
    if (!r || typeof r.weight !== 'number') continue;
    totalWeight += r.weight;
    nCounted++;
  }
  if (nCounted === 0) return null;
  const avg = totalWeight / nCounted; // expected range ~-1..+1
  // Map avg -1..+1 → score 1..10 with neutral at ~5.5
  const score = Math.max(1, Math.min(10, 5.5 + avg * 4.5));
  const ts = entry.updatedAt && Number.isFinite(entry.updatedAt) ? entry.updatedAt : null;
  return { score, strength: 0.7, ts };
}

async function buildCFApply() {
  const { cfEnabled } = await chrome.storage.local.get('cfEnabled');
  if (!cfEnabled) return null;
  try {
    await cfEngine.init();
  } catch (err) {
    console.warn('[crsmart] cf-engine init failed; ranking without CF:', err);
    return null;
  }
  const {
    externalScores = {},
    userRatings = {},
    watchShapes = {},
    crWatchlist = {},
    userReactions = {},
    aniListCache = {},
  } = await chrome.storage.local.get([
    'externalScores', 'userRatings', 'watchShapes',
    'crWatchlist', 'userReactions', 'aniListCache',
  ]);

  // crSeriesId → aniListId map (needed for watch-shape + watchlist
  // signals which are CR-keyed; CF model is AniList-keyed).
  const crToAli = {};
  for (const [crId, entry] of Object.entries(aniListCache)) {
    if (entry?.aniListId) crToAli[crId] = entry.aniListId;
  }

  // Effective per-show map: aniListId → { effective, score, strength,
  // ts, source }. `effective = score * strength * decay(ts)` is the
  // comparison key for MAX-per-show resolution.
  const now = Date.now();
  const eff = {};
  const consider = (aliRaw, score, strength, ts, source) => {
    if (aliRaw == null || score == null) return;
    const ali = String(aliRaw);
    const decay = decayFactor(ts, now);
    const effective = score * strength * decay;
    const cur = eff[ali];
    if (!cur || Math.abs(effective) > Math.abs(cur.effective)) {
      eff[ali] = { effective, score, strength, ts, source, decay };
    }
  };

  // 1. External-source explicit ratings — confidence 1.0, NO decay.
  // Per north-star: stated signals don't decay. A 2018 rating of 10
  // still means "I love this," not "I loved it five years ago."
  // Iterates the shared source list (anilist > mal > freeform) and
  // takes the first present source's score. Critical fix 2026-05-19:
  // pre-helper, this loop hardcoded anilist|mal, so freeform-imported
  // scores never landed in the effective-scores map.
  for (const [aliStr, sources] of Object.entries(externalScores)) {
    let score = null;
    for (const { entry } of iterExternalSources(sources)) {
      if (entry?.score && entry.score > 0) { score = entry.score; break; }
    }
    if (score == null) continue;
    consider(aliStr, Number(score), 1.0, null, 'external');
  }

  // 2. In-extension thumbs — confidence 1.0
  for (const [aliStr, thumb] of Object.entries(userRatings)) {
    if (thumb === '+1') consider(aliStr, 9, 1.0, null, 'thumb');
    else if (thumb === '-1') consider(aliStr, 2, 1.0, null, 'thumb');
  }

  // 3. Watch-shape (per-series). aniListCache maps CR series → AL id.
  const series = watchShapes?.series || {};
  for (const [crId, shape] of Object.entries(series)) {
    const ali = crToAli[crId];
    if (!ali) continue;
    const sig = watchShapeSignal(shape);
    if (!sig) continue;
    consider(ali, sig.score, sig.strength, sig.ts, 'watch-shape');
  }

  // 4. Watchlist — aspirational signal, modest strength
  for (const item of (crWatchlist?.items || [])) {
    const ali = item?.seriesId ? crToAli[item.seriesId] : null;
    if (!ali) continue;
    const score = item.isFavorite ? 7 : 5;
    const strength = item.isFavorite ? 0.4 : 0.25;
    consider(ali, score, strength, item.addedAt || null, 'watchlist');
  }

  // 5. Reactions — sentiment from tagged reaction weights. Stated
  // signal per north-star → no decay.
  for (const [aliStr, entry] of Object.entries(userReactions)) {
    const sig = reactionSignal(entry);
    if (!sig) continue;
    consider(aliStr, sig.score, sig.strength, null, 'reaction');
  }

  // Build the ratings map ALS expects. Pass `score * strength * decay`
  // as the effective rating — cf-engine's confidence formula
  // (c = 1 + alpha * r) then absorbs the multi-signal weighting.
  const ratings = {};
  for (const [aliStr, info] of Object.entries(eff)) {
    ratings[aliStr] = info.score * info.strength * info.decay;
  }

  const userVec = cfEngine.computeUserVector(ratings);
  if (!userVec) return null;
  const n = Object.keys(ratings).length;
  // Source histogram for diagnostics — shows how the fold-in distribution
  // shifts between signal types as the user's library matures.
  const sourceCounts = {};
  for (const info of Object.values(eff)) {
    sourceCounts[info.source] = (sourceCounts[info.source] || 0) + 1;
  }
  chrome.storage.local.set({
    _cfDiagnostics: {
      computedAt: Date.now(),
      nRatedShows: n,
      vectorNorm: Math.sqrt(Array.from(userVec).reduce((s, v) => s + v * v, 0)),
      sourceCounts,
    },
  }).catch(() => {});
  return (aniListId, tags) => cfEngine.cfRankDelta(aniListId, tags, userVec, n);
}

async function fireTourOnCR(preferredTabId) {
  const trySend = async (tabId) => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'crsmart:show-tour' });
      return true;
    } catch (_) {
      // No listener on the tab (content script not yet loaded, CSP,
      // tab navigated away mid-call). Caller falls through.
      return false;
    }
  };

  try {
    // 1. Caller-specified tab (sender.tab.id from content-script click).
    if (preferredTabId != null) {
      if (await trySend(preferredTabId)) return;
    }

    // 2. User's active tab in the focused window — but only if it's CR.
    //    `lastFocusedWindow: true` is more reliable than
    //    `currentWindow: true` when the call originates from the popup
    //    (popup has its own implicit "current window" that isn't the CR one).
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (activeTab?.url && /crunchyroll\.com/.test(activeTab.url)) {
      if (await trySend(activeTab.id)) return;
    }

    // 3. Fall back to any open CR tab — pull the active one in any
    //    window if available, else just the first match.
    const allCrTabs = await chrome.tabs.query({ url: '*://*.crunchyroll.com/*' });
    if (allCrTabs && allCrTabs.length > 0) {
      const target = allCrTabs.find(t => t.active) || allCrTabs[0];
      try {
        await chrome.tabs.update(target.id, { active: true });
        if (target.windowId) await chrome.windows.update(target.windowId, { focused: true });
      } catch (_) {}
      if (await trySend(target.id)) return;
    }

    // 4. No CR tab anywhere — set the session flag and open CR.
    await chrome.storage.session.set({ 'crsmart:auto-open-tour': true });
    if (!allCrTabs || allCrTabs.length === 0) {
      await chrome.tabs.create({ url: 'https://www.crunchyroll.com/' });
    }
  } catch (err) {
    console.warn('[crsmart-bg] fireTourOnCR failed', err);
  }
}

// Register Crunchyroll with the provider gateway. resolveToken pulls
// the latest crToken from chrome.storage.session — bridge.js writes
// it whenever the user navigates CR, and the gateway's 401-retry
// path re-resolves once if the cached token went stale mid-request.
// Centralizing the bearer here means CR fetch helpers no longer
// thread a `token` parameter through 5 levels of function calls.
//
// defaultGapMs=500: matches the prior PAGE_DELAY_MS used in history
// pagination + bulk meta chunks. CR has no published rate limit;
// 500ms is conservative for an undocumented endpoint.
gateway.registerProvider('cr', {
  baseUrl: 'https://www.crunchyroll.com',
  defaultGapMs: 500,
  retry: { maxAttempts: 3, on: ['429', '5xx', 'network'] },
  tripBreakerImmediately: {},
  tripBreakerOnExhaust: { 429: 5 * 60 * 1000 },
  resolveToken: async () => {
    const s = await chrome.storage.session.get('crToken');
    return s?.crToken || null;
  },
});

// Adapter for the inline CR fetch sites. Each call returns the
// gateway's Result<T, ErrorKind>; callers branch on result.ok and
// pull data from result.data on success. URL is built at the call
// site (each endpoint composes its own query string). The bearer
// token is auto-resolved by the gateway's resolveToken hook above.
async function crFetch(url, contextLabel) {
  return gateway.request('cr', {
    method: 'GET',
    url,
    contextLabel,
  });
}

const STALE_MS = 24 * 60 * 60 * 1000;
const ANILIST_STALE_MS = 30 * 24 * 60 * 60 * 1000; // tags/score drift is slow
const PAGE_SIZE = 100;

// Register the AniList entry-cache with cache-store. Owns TTL +
// schema-version checks + exponential error backoff so a transient
// rate-limit doesn't cause every subsequent enrichment cycle to
// re-hammer AL on the same failed entries.
cache.register('aniListCache', {
  ttl: ANILIST_STALE_MS,
  schemaVersion: ANILIST_SCHEMA_VERSION,
});

// CR franchise-meta entry-cache. Tightens semantics over the prior
// "crMetaFetchedAt gates the whole cache" pattern — per-entry TTL
// means only stale entries re-fetch, not the whole cache, so a single
// new series ID in seriesIdSet doesn't invalidate the other 600.
cache.register('crSeriesMeta', {
  ttl: STALE_MS,  // 24h, matching the prior global staleness window
});

// AniList franchise/import bridge-cache. Holds AL Media projections
// keyed by aniListId (vs aniListCache which is keyed by CR series ID).
// Previously never expired — adding a 30-day TTL stops unbounded
// growth and keeps tag/score drift bounded.
cache.register('aniListBridgeCache', {
  ttl: ANILIST_STALE_MS,
  schemaVersion: ANILIST_SCHEMA_VERSION,
});

// ── Engine telemetry for validation snapshots ──────────────────
//
// Lightweight circular buffer + status object persisted to chrome.storage
// so the validation snapshot can surface "what broke recently / how is
// the engine doing" data for future debugging. NOT user-facing — the
// keys are prefixed with `_` to mark them as debug-only.
//
// Why local cache + persistence: if the worker crashes or the user
// closes Chrome before flushing, an in-memory buffer loses the data
// the validation snapshot needs. Writing-on-record means errors are
// captured even when async failures end the worker.
const ENGINE_ERROR_LIMIT = 20;
const _engineErrorBuffer = [];
let _engineErrorFlushTimer = null;
function logEngineError(source, kind, message) {
  const entry = {
    at: new Date().toISOString(),
    source: source || 'unknown',
    kind: kind || 'error',
    message: typeof message === 'string'
      ? message
      : (message?.message || String(message || '')),
  };
  _engineErrorBuffer.push(entry);
  if (_engineErrorBuffer.length > ENGINE_ERROR_LIMIT) {
    _engineErrorBuffer.splice(0, _engineErrorBuffer.length - ENGINE_ERROR_LIMIT);
  }
  // Coalesce flushes so a burst of errors writes once. 1s debounce.
  if (_engineErrorFlushTimer) clearTimeout(_engineErrorFlushTimer);
  _engineErrorFlushTimer = setTimeout(async () => {
    _engineErrorFlushTimer = null;
    try {
      await chrome.storage.local.set({ _engineErrors: _engineErrorBuffer.slice() });
    } catch (_) { /* storage issues here would just lose telemetry — non-critical */ }
  }, 1000);
}

// Records the latest persistTasteVector run's timing + status for the
// snapshot's `health` section. Replaces the previous run; we only care
// about the most recent state, not history.
async function recordEngineHealth(payload) {
  try {
    await chrome.storage.local.set({ _engineHealth: { ...payload, recordedAt: Date.now() } });
  } catch (_) {}
}
const CR_META_CHUNK = 50; // cms/objects accepts comma-separated IDs

// Guard against re-entry: a second sync trigger while enrichment is
// already running would double-spend the AniList budget.
let enrichmentInFlight = false;

// Survey-tap debounce. Each tap writes to surveyShapes (Shows mode)
// or surveyTagShapes (Genres mode); the storage listener schedules a
// recompute 2 s after the most-recent tap. Done click in the survey
// UI bypasses this via the survey:applyAndRecompute message handler
// so the summary screen sees fresh data immediately.
let surveyRecomputeTimer = null;
function scheduleSurveyDebouncedRecompute() {
  if (surveyRecomputeTimer) clearTimeout(surveyRecomputeTimer);
  surveyRecomputeTimer = setTimeout(async () => {
    surveyRecomputeTimer = null;
    try { await persistTasteVector(null); }
    catch (err) { console.warn('[crsmart] survey debounced recompute error', err); }
  }, 2000);
}

// Debounce a rating click. Passes signal: 'rating' so persistTasteVector
// skips the rating-invariant stages (quality axes, rec pool) — cuts
// recompute from ~3s to ~1.4s. Rec pool refreshes on the next
// non-rating recompute.
let ratingRecomputeTimer = null;
function scheduleRatingDebouncedRecompute() {
  if (ratingRecomputeTimer) clearTimeout(ratingRecomputeTimer);
  ratingRecomputeTimer = setTimeout(async () => {
    ratingRecomputeTimer = null;
    try { await persistTasteVector(null, { signal: 'rating' }); }
    catch (err) { console.warn('[crsmart] rating debounced recompute error', err); }
  }, 300);
}

// Reactions affect rec ordering meaningfully (per-tag polarity
// signals), so the rec pool should refresh. Passes no signal (full
// pipeline runs).
let reactionRecomputeTimer = null;
function scheduleReactionDebouncedRecompute() {
  if (reactionRecomputeTimer) clearTimeout(reactionRecomputeTimer);
  reactionRecomputeTimer = setTimeout(async () => {
    reactionRecomputeTimer = null;
    try { await persistTasteVector(null); }
    catch (err) { console.warn('[crsmart] reaction debounced recompute error', err); }
  }, 300);
}


// Retrigger persistTasteVector when the bridge cache fills with one
// of the AL IDs that the last apply skipped because its Media hadn't
// arrived. Reads the skipped-id list from surveyApplyState, intersects
// with the new bridge entries, and only schedules if there's a match.
// Cheap — set membership check, no recompute when nothing changed.
async function handleBridgeCacheFillForSkippedTaps(change) {
  const { surveyApplyState } = await getMany([STORAGE_KEYS.surveyApplyState]);
  const skipped = surveyApplyState?.skippedNoMediaIds;
  if (!Array.isArray(skipped) || skipped.length === 0) return;
  const oldCache = change.oldValue || {};
  const newCache = change.newValue || {};
  // Match the skipped IDs against entries that just appeared (newCache
  // has them, oldCache didn't). Skips when the cache changed but none
  // of the changes matched a skipped tap.
  const recovered = skipped.filter(id => newCache[id] && !oldCache[id]);
  if (recovered.length === 0) return;
  console.log(`[crsmart] survey-retry: bridge cache filled ${recovered.length} previously-skipped tap(s),`
    + ` scheduling recompute`);
  scheduleSurveyDebouncedRecompute();
}

// Convert CR's 1-5 star rating distribution into a 0-100 average to
// match AniList's averageScore scale. Distribution shape:
//   { '1s': {percentage, displayed, unit}, '2s': {...}, ..., '5s': {...} }
// where percentage is a numeric 0-100. Weighted mean over the buckets:
//   avg_stars = (1*p1 + 2*p2 + ... + 5*p5) / sum(p)
//   avg_100   = avg_stars * 20  (1★ → 20/100, 5★ → 100/100)
// Returns null when the distribution is missing or empty (CR returned
// the show but no users rated it yet).
function computeCrAvgFromRatingDistribution(rating) {
  if (!rating) return null;
  let weighted = 0;
  let totalPct = 0;
  for (let s = 1; s <= 5; s++) {
    const pct = rating[`${s}s`]?.percentage;
    if (typeof pct !== 'number') continue;
    weighted += s * pct;
    totalPct += pct;
  }
  if (totalPct <= 0) return null;
  return +((weighted / totalPct) * 20).toFixed(1);
}

// mergeCrTagsIntoEntry moved to taste-pipeline.js — import above.
// preferMainAnimationStudios moved to all-shows-scoring.js (its
// only caller) — a copy still lives in rank-recommendations.js.

// User-configured dealbreakers live inside surfaceSettings so all
// persistent preferences are in one storage key. Returns a string[] of
// AniList tag (or genre) names that should exclude any rec where that
// tag is central (rank ≥ 50) — rank check lives in rankRecommendations.
async function getDealbreakerTags() {
  const { surfaceSettings } = await chrome.storage.local.get('surfaceSettings');
  const tags = surfaceSettings?.dealbreakerTags;
  return Array.isArray(tags) ? tags : [];
}

console.log('[crsmart] background worker booted');

// Pipeline runner instance — singleton owned by this worker. Stages
// register against it; it owns IO + ordering + signal-aware skip
// dispatch. This is the foundation laid by /improve-codebase-architecture
// candidate #5; stages are migrated onto it incrementally.
//
// Step A (this commit): vectorPrep registered. Other stages still
// run inline in persistTasteVector. Subsequent commits migrate them.
//
// vectorPrep is the smallest meaningful first stage — pure function
// of (watchShapes, aniListCache), invariant under rating signals,
// computed in ~150ms today on every recompute. Caching it here
// delivers candidate #2's payoff (vector-prep memoization).
const pipelineRunner = new PipelineRunner();
pipelineRunner.register(vectorPrepStage);

// Boot-time initialization: schema-aware sweep marks any stage with
// a bumped schema dirty (vectorPrep on first install/upgrade), then
// flush builds + persists their outputs. Subsequent recomputes read
// from storage when fresh.
async function initPipelineRunner() {
  try {
    await pipelineRunner.bootSweep();
    await pipelineRunner.flush();
    console.log('[crsmart] pipeline-runner: initial sweep complete');
  } catch (err) {
    console.warn('[crsmart] pipeline-runner: init error', err);
  }
}
initPipelineRunner();

// Wire storage changes to the runner so vectorPrep refreshes when
// its inputs (watchShapes, aniListCache) change. Other stages will
// hook in via the same mechanism as they migrate.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let touched = false;
  if (changes.watchShapes) { pipelineRunner.markChanged('watchShapes'); touched = true; }
  if (changes.aniListCache) { pipelineRunner.markChanged('aniListCache'); touched = true; }
  // markChanged auto-flushes on next microtask via PipelineRunner's
  // _scheduleAutoFlush — no explicit flush call needed.
});

// One-shot startup log of the OAuth redirect URL. This is the URL
// the extension expects AL / MAL to redirect back to after the user
// approves the auth flow. Each platform's OAuth app registration UI
// asks for it; copy the value from the worker console into both
// platforms' app-config screens. Format:
//   https://<chrome-extension-id>.chromiumapp.org/
// Note: for unpacked dev extensions without a manifest "key" field,
// the extension ID is per-profile-random — every "Load unpacked" of
// a fresh path produces a different ID, which changes the redirect
// URL. Locking the ID requires a packed .pem'd manifest key (not
// done here; one-time crypto-key step that's a separate ops task).
// (Removed the chrome.identity OAuth redirect-URL diagnostic: AniList now
// imports by public username — no OAuth, no chrome.identity, no "identity"
// permission. MAL is XML-upload only.)

// The toolbar action opens popup.html (mock taste-profile / vibe / settings
// surface). The side panel is opened by a button injected into CR's topbar
// via topbar-button.js → message → here.
//
// setPanelBehavior persists across worker restarts, so we must explicitly
// set openPanelOnActionClick back to false — without this, a previous run
// that enabled it would keep hijacking the action click and the popup
// would never appear.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  .catch(err => console.warn('[crsmart] sidePanel.setPanelBehavior failed', err));

// Per-windowId presence tracking for the side panel. The panel opens a
// long-lived port to background on boot ('crsmart-side-panel-presence');
// when the port disconnects we know the panel was closed. Used by the
// topbar-button toggle: clicking again while open should close the
// panel, not re-open it.
const _panelOpenWindowIds = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'crsmart-side-panel-presence') return;
  let registeredWindowId = null;
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'register' && typeof msg.windowId === 'number') {
      registeredWindowId = msg.windowId;
      _panelOpenWindowIds.add(msg.windowId);
    }
  });
  port.onDisconnect.addListener(() => {
    if (registeredWindowId != null) {
      _panelOpenWindowIds.delete(registeredWindowId);
      chrome.storage.session.remove([`crsmart_panel_open_${registeredWindowId}`]).catch(() => {});
    }
  });
});

// Debounce rapid topbar clicks. The "double-click required" symptom is
// most often a service-worker cold-start: the first click wakes the
// worker, the second is the one that actually executes. With both
// reaching the handler now (worker stays warm), a 600ms guard prevents
// the user from accidentally toggling the panel closed on the second
// click of a habitual double-click.
let _lastTopbarActionAt = 0;
const _TOPBAR_DEBOUNCE_MS = 600;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'crsmart:open-side-panel') {
    const now = Date.now();
    if (now - _lastTopbarActionAt < _TOPBAR_DEBOUNCE_MS) return;
    _lastTopbarActionAt = now;

    const windowId = sender?.tab?.windowId;
    if (windowId == null) return;

    if (_panelOpenWindowIds.has(windowId)) {
      // Toggle: panel is open in this window → ask it to close itself.
      // chrome.sidePanel has no close API, so the panel listens for
      // this message and calls window.close().
      chrome.runtime.sendMessage({ type: 'crsmart:panel-close', windowId }).catch(() => {});
      chrome.storage.session.remove([`crsmart_panel_open_${windowId}`]).catch(() => {});
      return;
    }

    // Mark this window's panel as intentionally opened so the panel can
    // distinguish an explicit open from Chrome restoring it from a previous
    // session (which would show a blank/gray column before data is ready).
    // chrome.storage.session is cleared on Chrome close, so the flag is
    // absent on the next Chrome launch and the panel correctly closes itself.
    chrome.storage.session.set({ [`crsmart_panel_open_${windowId}`]: true }).catch(() => {});

    // chrome.sidePanel.open requires a user gesture — the message originated
    // from a click handler in the content script, so the activation propagates.
    chrome.sidePanel.open({ windowId })
      .then(() => {
        // Replay-intro must fire AFTER the panel is reliably booted +
        // visible. Without the delay, two failure modes hit:
        //   1. On a from-closed open, the message arrives before the
        //      panel's runtime.onMessage listener is registered, so
        //      it's dropped. Boot's own setSurface plays the intro,
        //      but Chrome's ~200ms panel-mount animation means the
        //      user catches only the tail. They report "no intro."
        //   2. On a from-open replay, the message arrives instantly
        //      and works — but for consistency the same delay applies.
        // 500ms covers panel mount (~200ms) + script boot (~150-250ms)
        // on typical hardware. Errors are silently ignored: the
        // message has no receiver if the panel was closed mid-flight.
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'crsmart:replay-shape-intro' }).catch(() => {});
        }, 500);
      })
      .catch(err => console.warn('[crsmart] sidePanel.open failed', err));
  }
  // Onboarding tour entry points (locked via /grill-me design pass):
  //   - 'crsmart:show-tour'        — fires the tour overlay on CR.
  //                                  Used by popup menu + install handler.
  //   - 'crsmart:open-survey-tab'  — opens survey.html in a new tab.
  //                                  Used by tour's slide-5 CTA so the
  //                                  user's CR session is preserved.
  //   - 'crsmart:open-help-tab'    — opens help.html in a new tab.
  //                                  Routed through here (not a direct
  //                                  chrome-extension:// anchor) because
  //                                  some content blockers treat http →
  //                                  chrome-extension navigation from a
  //                                  CR page as a cross-origin redirect
  //                                  and block it (ERR_BLOCKED_BY_CLIENT).
  if (msg?.type === 'crsmart:show-tour') {
    // sender.tab.id is set when the message originates from a content
    // script (top-bar tour button click) — fire on THAT tab so the
    // overlay lands where the user clicked. Undefined when sent from
    // the popup, which falls through to the active-tab path.
    fireTourOnCR(sender?.tab?.id);
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'crsmart:open-survey-tab') {
    chrome.tabs.create({ url: chrome.runtime.getURL('survey.html') })
      .then(() => sendResponse({ ok: true }))
      .catch(err => {
        console.warn('[crsmart-bg] open-survey-tab failed', err);
        sendResponse({ ok: false });
      });
    return true;  // async response
  }
  if (msg?.type === 'crsmart:open-help-tab') {
    // Optional section anchor — callers can request a deep-link like
    // 'smart-score' to land directly on the Smart Card help section
    // instead of the top of the help page. Sanitized to a safe slug
    // so a content-script bug can't smuggle arbitrary text into the
    // URL fragment.
    const rawSection = typeof msg.section === 'string' ? msg.section : '';
    const safeSection = rawSection.replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
    const url = safeSection
      ? chrome.runtime.getURL(`help.html#${safeSection}`)
      : chrome.runtime.getURL('help.html');
    chrome.tabs.create({ url })
      .then(() => sendResponse({ ok: true }))
      .catch(err => {
        console.warn('[crsmart-bg] open-help-tab failed', err);
        sendResponse({ ok: false });
      });
    return true;  // async response
  }
  // Open the restore-from-backup flow in a new tab. Routed through here
  // (rather than letting the popup directly call chrome.tabs.create)
  // to keep all extension-origin tab opens flowing through the SW —
  // matches open-survey-tab + open-help-tab.
  if (msg?.type === 'crsmart:open-import-tab') {
    chrome.tabs.create({ url: chrome.runtime.getURL('import.html') })
      .then(() => sendResponse({ ok: true }))
      .catch(err => {
        console.warn('[crsmart-bg] open-import-tab failed', err);
        sendResponse({ ok: false });
      });
    return true;  // async response
  }
  // Post-restore broadcast. The import flow has just done a single
  // atomic chrome.storage.local.set with the imported buckets. The
  // taste-pipeline + sidebar/popup surfaces already subscribe to
  // chrome.storage.onChanged for their respective keys, so most of the
  // refresh is automatic. The thing they DON'T do for free is recompute
  // when source data changed but engineOutput was held back (smart-
  // conditional rule said "don't trust file's engineOutput, recompute"):
  // in that case we explicitly request a recompute here.
  //
  // useFileEngineOutput=true → sources changed AND engineOutput in the
  // file is authoritative. The set() already wrote both source + output
  // keys; surfaces re-render via storage onChanged. No recompute needed.
  //
  // useFileEngineOutput=false → sources changed, file's engineOutput
  // was discarded (or absent). The current engineOutput on the device
  // is now stale relative to the new source data — request a fresh
  // recompute. Worker's persistTasteVector / scoring pipeline will run.
  if (msg?.type === 'crsmart:backup-restored') {
    // Recompute trigger needs BOTH conditions:
    //   1) the file's engineOutput was discarded (smart-conditional
    //      said don't trust it, or the file didn't carry one)
    //   2) source data actually changed — at least one of cr / anilist /
    //      survey was in the restored buckets
    // Without (2) the engine state is still consistent with the device's
    // unchanged source data, so a recompute would be wasted work.
    const restoredBuckets = Array.isArray(msg.restoredBuckets) ? msg.restoredBuckets : [];
    const sourceDataChanged = restoredBuckets.some(b =>
      b === 'cr' || b === 'anilist' || b === 'survey'
    );
    if (msg.useFileEngineOutput === false && sourceDataChanged) {
      // Fire-and-forget — recompute happens asynchronously, surfaces
      // observe progress via existing storage broadcasts.
      persistTasteVector(null).catch(err =>
        console.warn('[crsmart-bg] post-restore recompute failed', err)
      );
    }
    sendResponse({ ok: true });
    return;
  }
});

// chrome.storage.session defaults to TRUSTED_CONTEXTS only — content
// scripts (bridge.js) cannot write to it without this opt-in. Without
// the call, session.set from bridge silently no-ops, the worker's
// onChanged listener never fires, and sync never starts. Discovered
// the hard way: local.set landed (profileId persisted) but session.set
// vanished, so maybeSyncHistory always saw hasToken:false despite
// dozens of successful captures in the page console.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .then(() => console.log('[crsmart] session storage opened to content scripts'))
  .catch(err => console.warn('[crsmart] setAccessLevel failed', err));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.crToken && changes.crToken.newValue) {
    console.log('[crsmart] new crToken observed, attempting sync');
    maybeSyncHistory().catch(err => console.warn('[crsmart] sync error', err));
  }
  if (area === 'local' && changes.userReactions) {
    rerankFromReactions().catch(err =>
      console.warn('[crsmart] reaction-rerank error', err));
    // Reactions feed series-sentiment (Phase 2b) — full recompute
    // updates the user's tag mass for similar-show propagation AND
    // refreshes the rec pool (reactions' tag polarity meaningfully
    // shifts rec ordering). Uses the reaction-specific debounce so
    // it doesn't inherit the rating signal's rec-pool skip.
    scheduleReactionDebouncedRecompute();
  }
  // userRatings (👍/😐/👎 from the card) trigger a debounced full
  // recompute. Earlier this also did a fast-path patch for instant
  // feedback, but fast-path and slow-path produced different values
  // (slow-path also rebuilds the taste vector with the rating
  // contribution, lifting the show's raw tasteScore further) — the
  // visible flicker between intermediate states was worse than the
  // 300ms wait. Single coherent update wins.
  if (area === 'local' && changes.userRatings) {
    scheduleRatingDebouncedRecompute();
  }
  // External-source list import (AniList / MAL) finished writing.
  // Treat it like a non-rating signal — the import lands tag-bearing
  // contributions on potentially hundreds of new series, which means
  // the rec pool, archetype blend, and quality axes all need a fresh
  // pass. Uses persistTasteVector with no signal opt = full pipeline.
  if (area === 'local' && changes.externalScores) {
    persistTasteVector(null).catch(err =>
      console.warn('[crsmart] externalScores recompute error', err));
  }
  // Survey live-saves taps to surveyShapes (Shows mode) and
  // surveyTagShapes (Genres mode). Debounce a taste vector recompute
  // so we don't thrash on every tap (one recompute ~50ms, user can
  // tap a tile every few hundred ms during a fast survey).
  // 2s after the last tap, persistTasteVector runs, the broadcast
  // fires, open CR cards refresh. Done click also triggers
  // applyAndRecompute immediately, bypassing the debounce.
  if (area === 'local' && (changes.surveyShapes || changes.surveyTagShapes)) {
    scheduleSurveyDebouncedRecompute();
  }
  // Bridge-cache fills retroactively. If the last persistTasteVector run
  // skipped any survey show-taps because their AL Media hadn't arrived
  // (logged under surveyApplyState.skippedNoMediaIds), and one of those
  // IDs just landed in the bridge cache, kick a debounced recompute so
  // the user's tap folds in retroactively. Without this, a tap on a
  // show whose Media was rate-limited at survey time stays a no-op
  // until the next manual interaction.
  if (area === 'local' && changes[ANILIST_BRIDGE_CACHE_KEY]) {
    handleBridgeCacheFillForSkippedTaps(changes[ANILIST_BRIDGE_CACHE_KEY]).catch(err =>
      console.warn('[crsmart] bridge-fill survey-retry error', err));
  }
  // Dealbreaker changes → rerank with the new filter applied. Piggybacks
  // on the same rerank path as reactions; getDealbreakerTags reads fresh
  // from storage inside. Only fires when dealbreakerTags specifically
  // changed (ignore other surfaceSettings edits like slider positions).
  if (area === 'local' && changes.surfaceSettings) {
    const prev = changes.surfaceSettings.oldValue?.dealbreakerTags || [];
    const next = changes.surfaceSettings.newValue?.dealbreakerTags || [];
    const changed = prev.length !== next.length
      || prev.some((t, i) => t !== next[i]);
    if (changed) {
      console.log('[crsmart] dealbreakers changed, reranking:',
        `${prev.length} → ${next.length} tags`);
      rerankFromReactions().catch(err =>
        console.warn('[crsmart] dealbreaker-rerank error', err));
    }
  }
});

// Re-score the cached candidate heads with the latest reaction overlay.
// Cheap — no AniList fetch, reads the sidecar cache written by the last
// full pass. Runs on every userReactions change so the ring/rank updates
// immediately (the user's explicit ask: "score-update happen at rating time").
async function rerankFromReactions() {
  const {
    recommendationRerankCache: cache,
    tasteVectorPeak,
    tasteVectorComfort,
    userReactions = {},
  } = await chrome.storage.local.get([
    'recommendationRerankCache', 'tasteVectorPeak', 'tasteVectorComfort', 'userReactions',
  ]);
  if (!cache || !cache.mediaById || !tasteVectorPeak || !tasteVectorComfort) {
    console.log('[crsmart] reaction-rerank: no cached rank data yet, skipping');
    return;
  }
  // Compute a recsById shim off the current recommendationsScored so the
  // overlay knows which topTags each rated show matched on.
  const { recommendationsScored } = await chrome.storage.local.get('recommendationsScored');
  const seedRecsById = {};
  for (const bucket of ['peak', 'comfort']) {
    const ranked = recommendationsScored?.[bucket]?.ranked || [];
    for (const r of ranked) {
      if (!seedRecsById[r.aniListId]) seedRecsById[r.aniListId] = r;
    }
  }
  const overlay = computeReactionOverlay(userReactions, seedRecsById);

  const dealbreakerTags = await getDealbreakerTags();
  // Recompute quality axes against the current cache — a reaction
  // rerank that happens weeks after the initial rank would otherwise
  // use stale qualityAxes (cache.mediaById is frozen from the prior
  // fetch). Cheap to redo; uses current aniListCache as the pedigree
  // source.
  const { aniListCache: currentCache = {} } = await chrome.storage.local.get('aniListCache');
  annotateMediaByIdWithQuality(cache.mediaById, currentCache);

  // Merge aniListCache (the user's watched-history entries) into mediaById
  // as franchise-walk bridges. The rec-fetch only pulls Media for the
  // rec candidates themselves; without this merge, buildFranchise on a
  // rec central can't reach intermediate seasons that exist only in the
  // user's cache (e.g. Demon Slayer S1's franchise walk needs Mugen
  // Train Arc TV from cache to find the SEQUEL→Entertainment District
  // link). Bulk-fetched entries win on key collision since they're the
  // freshest copy of relations[].
  const mediaForRank = mergeAniListCacheIntoMediaById(cache.mediaById, currentCache);
  // Also fold in the franchise bridge cache built during full passes —
  // those nodes were lazy-fetched specifically to extend franchise reach
  // and shouldn't disappear on a reaction-triggered rerank.
  const { [ANILIST_BRIDGE_CACHE_KEY]: bridgeCache = {} } =
    await chrome.storage.local.get(ANILIST_BRIDGE_CACHE_KEY);
  for (const [id, m] of Object.entries(bridgeCache)) {
    if (!mediaForRank[id]) mediaForRank[id] = m;
  }
  const {
    studioCreatorIndex,
    tasteScorePercentileMapperPeak,
    tasteScorePercentileMapperComfort,
    finalScorePercentileMapper,
    userRatings = {},
  } = await chrome.storage.local.get([
    'studioCreatorIndex',
    'tasteScorePercentileMapperPeak',
    'tasteScorePercentileMapperComfort',
    'finalScorePercentileMapper',
    'userRatings',
  ]);

  const cfApply = await buildCFApply();
  const peakScored = rankRecommendations(
    cache.peakHead, mediaForRank, tasteVectorPeak,
    { overlay, dealbreakerTags, studioCreatorIndex,
      tasteScorePercentileMapper: tasteScorePercentileMapperPeak,
      finalScorePercentileMapper, userRatings, cfApply });
  const comfortScored = rankRecommendations(
    cache.comfortHead, mediaForRank, tasteVectorComfort,
    { overlay, dealbreakerTags, studioCreatorIndex,
      tasteScorePercentileMapper: tasteScorePercentileMapperComfort,
      finalScorePercentileMapper, userRatings, cfApply });
  // G03: diversify rec lists on the rerank path too — reaction
  // changes shouldn't undo the variety the side panel learned.
  peakScored.ranked = diversifyRanked(peakScored.ranked);
  comfortScored.ranked = diversifyRanked(comfortScored.ranked);

  await chrome.storage.local.set({
    recommendationsScored: {
      peak: { ...peakScored, computedAt: Date.now() },
      comfort: { ...comfortScored, computedAt: Date.now() },
    },
  });
  console.log(`[crsmart] reaction-rerank: ${Object.keys(overlay).length} tags shifted, `
    + `${peakScored.ranked.length} peak / ${comfortScored.ranked.length} comfort re-scored`);
}

// Also try on worker startup — handles the case where the token was
// captured during a previous session and is still fresh.
maybeSyncHistory().catch(() => {});

// Phase 3: external-tag enrichment via the manami anime-offline-database.
// Weekly dump, fetched on worker boot with a 7-day staleness gate, then
// merged into aniListCache in place. Consumers (taste-vector, dimensions,
// per-show-score) already iterate tags[] so no downstream changes needed.
// Runs independently of the history/enrichment sync — it's a pure tag-
// vocabulary enrichment that doesn't depend on the user's watch activity.
maybeSyncExternalTags().catch(err =>
  console.warn('[crsmart] external-tags sync error', err));

// Tier 3: seed top-500 popular shows so the card renders on shows
// the user browses but hasn't watched. One-shot (gated by a version
// string) — runs once per install. Subsequent visits refresh
// individual entries via the on-visit enrichOne path.
maybeSeedPopularShows().catch(err =>
  console.warn('[crsmart] popular-seed error', err));

// Bumped 2026-05-16 from v2-top1500 → v3-asset when the seed source
// switched from a runtime AL walk to the bundled rec-pool-by-cr-id.json
// asset. Bumped same day → v4-asset-deep when the asset grew from a
// single POPULARITY_DESC walk (~600) to a multi-strategy union
// (POPULARITY + SCORE + TRENDING + 18 per-genre walks → 722). Existing
// installs get a one-time re-seed; the merge preserves user's verified
// entries so this is safe regardless of prior seed state.
// Bumped 2026-05-20 → v6-catalog: the rec-pool was rebuilt from CR's full
// discover/browse catalog (722 → 1,902 shows, ~98% of CR's 1,950-series
// catalog). Re-seed so existing installs pick up the ~1,180 new shows + the
// CR→AniList fast-path map entries for them. (v5-crmap populated crToAniListId
// from the 722-pool; this supersedes it.)
const POPULAR_SEED_VERSION = 'v7-catalog';

// Merge a { [crSeriesId]: projectedMedia } record into aniListCache.
// Returns { added, skipped }. Verified entries (from enrichOne's
// title+format+verify pass) win over popular-seed entries on conflict.
async function mergePopularSeedIntoCache(byCrId) {
  const { aniListCache = {}, crToAniListId = {} } =
    await chrome.storage.local.get(['aniListCache', 'crToAniListId']);
  let added = 0;
  let skipped = 0;
  let mapped = 0;
  for (const [crId, projected] of Object.entries(byCrId)) {
    // Seed the CR→AniList fast-path map from the pool. manami carries no
    // Crunchyroll links, so the rec-pool is the only population source;
    // without this the on-visit handler title-searches every series
    // instead of taking the fetch-by-id fast path (background.js ~1634).
    if (projected?.aniListId != null && crToAniListId[crId] == null) {
      crToAniListId[crId] = projected.aniListId;
      mapped++;
    }
    if (aniListCache[crId] && aniListCache[crId]._matchConfidence === 'verified') {
      skipped++;
      continue;
    }
    aniListCache[crId] = projected;
    added++;
  }
  await chrome.storage.local.set({ aniListCache, crToAniListId });
  return { added, skipped, mapped, cacheSize: Object.keys(aniListCache).length };
}

// Refresh quality axes + allShowsScored against the newly-enriched
// cache so the seed data is immediately scorable without waiting for
// the next taste-refresh cycle. Skipped if no taste vector exists yet
// (first-install case before any history has landed).
async function recomputeScoredAfterPopularSeed() {
  await recomputeQualityAxes();
  const { tasteVectorAll } = await chrome.storage.local.get('tasteVectorAll');
  if (tasteVectorAll) {
    await computeAllShowsScored(tasteVectorAll);
  }
}

async function maybeSeedPopularShows() {
  const stored = await chrome.storage.local.get(['popularSeedDone', 'aniListCache']);
  if (stored.popularSeedDone?.version === POPULAR_SEED_VERSION) {
    return; // already seeded at this schema
  }

  // Phase B: try the bundled static asset first. Zero AL roundtrips,
  // works on fresh installs before any history sync has populated the
  // cache. Refresh with `node tools/refresh-rec-pool.mjs`.
  try {
    const res = await fetch(chrome.runtime.getURL('data/rec-pool-by-cr-id.json'));
    if (res.ok) {
      const asset = await res.json();
      if (asset._schema !== ANILIST_SCHEMA_VERSION) {
        console.warn(
          `[crsmart] popular-seed: asset schema ${asset._schema} != engine schema ${ANILIST_SCHEMA_VERSION} ` +
          '— falling back to live walk; rerun tools/refresh-rec-pool.mjs to regenerate'
        );
      } else if (asset.byCrId && Object.keys(asset.byCrId).length > 0) {
        const t0 = Date.now();
        const merged = await mergePopularSeedIntoCache(asset.byCrId);
        await chrome.storage.local.set({
          popularSeedDone: {
            at: Date.now(),
            version: POPULAR_SEED_VERSION,
            source: 'asset',
            added: merged.added,
            skipped: merged.skipped,
          },
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(
          `[crsmart] popular-seed (from asset): +${merged.added} new, ${merged.skipped} skipped ` +
          `(verified preserved), +${merged.mapped} CR→AL fast-path entries. ` +
          `Cache size: ${merged.cacheSize} (${elapsed}s)`
        );
        await recomputeScoredAfterPopularSeed();
        return;
      }
    }
  } catch (err) {
    console.warn('[crsmart] popular-seed: asset load failed, falling back to live walk', err);
  }

  // Fallback: live walk. Same gating as before — pause-respecting,
  // deferred until aniListCache has some content so the seed isn't
  // racing the first history sync.
  if (anilistIsPaused()) {
    const secondsLeft = Math.ceil(anilistPauseMsLeft() / 1000);
    console.log(`[crsmart] popular-seed: skipping live fallback — circuit-breaker paused ${secondsLeft}s`);
    return;
  }
  if (!stored.aniListCache || Object.keys(stored.aniListCache).length === 0) {
    return; // retry on next boot once the cache exists
  }
  console.log(`[crsmart] popular-seed (live fallback): asset unavailable, walking AL (target 1500)…`);
  const t0 = Date.now();
  let result;
  try {
    result = await fetchPopularCrShows({ targetCount: 1500, maxPages: 60 });
  } catch (err) {
    console.warn('[crsmart] popular-seed fetch failed', err);
    return;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const gained = Object.keys(result.byCrId).length;
  console.log(`[crsmart] popular-seed (live): ${gained} CR-linked shows found across ${result.pagesFetched} pages `
    + `(${result.totalScanned} AniList entries scanned, ${elapsed}s)`);

  const merged = await mergePopularSeedIntoCache(result.byCrId);
  await chrome.storage.local.set({
    popularSeedDone: {
      at: Date.now(),
      version: POPULAR_SEED_VERSION,
      source: 'live',
      added: merged.added,
      skipped: merged.skipped,
    },
  });
  console.log(`[crsmart] popular-seed merged: +${merged.added} new, ${merged.skipped} skipped (verified entries preserved). `
    + `Cache size: ${merged.cacheSize}`);

  await recomputeScoredAfterPopularSeed();
}

async function maybeSyncExternalTags() {
  const stored = await chrome.storage.local.get(
    ['aniListCache', 'externalTagsFetchedAt', 'externalTagsSchema']);
  const aniListCache = stored.aniListCache || {};
  if (Object.keys(aniListCache).length === 0) {
    console.log('[crsmart] external-tags: no aniListCache yet, deferring merge');
    return;
  }
  // Schema-version gate: if the filter changed, the existing merged
  // tags are stale (greedy-merged or filtered against the old rule).
  // Clear the timestamp so the next sync fires regardless of age.
  const schemaMismatch = stored.externalTagsSchema !== EXTERNAL_TAGS_SCHEMA;
  const lastFetched = schemaMismatch ? 0 : (stored.externalTagsFetchedAt || 0);
  if (schemaMismatch) {
    console.log(`[crsmart] external-tags: schema changed (`
      + `${stored.externalTagsSchema || 'none'} → ${EXTERNAL_TAGS_SCHEMA}), forcing resync`);
  }
  const result = await syncExternalTags(aniListCache, lastFetched);
  if (!result) {
    console.log('[crsmart] external-tags: cache fresh, skipping');
    return;
  }
  // Augmentation pass — syncExternalTags adds external-tag fields to
  // existing entries without re-fetching. mergeBatch preserves cache
  // metadata (fetchedAt, _retryAfter, _attemptCount) so backoff state
  // and TTL aren't accidentally reset.
  await cache.mergeBatch('aniListCache', result.cache);
  await chrome.storage.local.set({
    externalTagsFetchedAt: Date.now(),
    externalTagsSchema: EXTERNAL_TAGS_SCHEMA,
    // CR series ID → AniList ID lookup extracted from manami's sources[]
    // arrays. Enables enrichOne to skip the title-search step when we
    // already know the AniList ID — faster cold-start, fewer AniList
    // requests, works around AniList's own externalLinks gaps (e.g.
    // MHA S1's CR URL isn't in AniList's externalLinks but lives in
    // manami's aggregate from other sources).
    crToAniListId: result.crToAniListId || {},
  });
  console.log(`[crsmart] external-tags — CR→AniList ID map: ${Object.keys(result.crToAniListId || {}).length} entries`);
  const s = result.stats;
  console.log(`[crsmart] external-tags: merged ${s.tagsAdded} tags into `
    + `${s.seriesTouched}/${s.seriesMatched} series, skipped ${s.candidatesSkipped} non-interesting `
    + `(DB: ${result.indexStats.totalEntries} entries, `
    + `${result.indexStats.withAniList} with AniList IDs, lastUpdate ${result.indexStats.lastUpdate})`);
  if (s.topAddedTags.length) {
    console.log('[crsmart] external-tags — most-added (top 15):',
      s.topAddedTags.map(t => `${t.tag} (${t.count})`).join(' · '));
  }
  // Taste vector + dimensions now depend on the enriched tag set —
  // recompute so the added vocabulary flows through to scoring and the
  // popup/card surfaces pick it up via the existing storage listeners.
  await persistTasteVector(null);
}

// Popup-triggered force refresh. Bypasses the 24h staleness gate: useful
// when the user knows they've watched something since the last sync and
// doesn't want to wait on the TTL. We also clear the AniList staleness
// on demand — cache fresh vs. cache present is the same codepath here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'forceRefresh') return false;
  (async () => {
    try {
      const { profileId } = await chrome.storage.local.get('profileId');
      const { crToken } = await chrome.storage.session.get('crToken');
      if (!profileId || !crToken) {
        sendResponse({ ok: false, reason: 'no-token-or-profile' });
        return;
      }
      await chrome.storage.local.set({ crHistorySyncing: { startedAt: Date.now() } });
      await syncHistory(profileId);
      await chrome.storage.local.remove('crHistorySyncing');
      sendResponse({ ok: true });
    } catch (err) {
      await chrome.storage.local.remove('crHistorySyncing');
      sendResponse({ ok: false, reason: String(err?.message || err) });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});

// Survey page message bridge.
//
// survey:fetchTileMedia — bulk-fetch projected Media for a list of
//   AL IDs (the Quick Taste Check anchor tiles). Hydrates the
//   aniListBridgeCache so the survey page renders with cover art +
//   tags. Reuses bulkFetchByIds, which is the same path the rec
//   pool's franchise-enrichment uses.
//
// survey:applyAndRecompute — fired when the user clicks Done. Forces
//   an immediate persistTasteVector run so the user sees their freshly-
//   updated taste shape on the summary screen instead of waiting for
//   the next sync trigger. Survey shapes already saved live per tap;
//   this just kicks the recompute.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'survey:fetchTileMedia') {
    const ids = Array.isArray(msg.aniListIds)
      ? msg.aniListIds.filter(n => typeof n === 'number')
      : [];
    (async () => {
      if (!ids.length) {
        sendResponse({ ok: true, fetched: 0 });
        return;
      }
      try {
        // Race-safe seed — boot IIFE may not have completed yet on
        // first install when the user lands on the survey fast.
        // No-op after the first call thanks to the bridgeCacheSeedSchema
        // gate.
        await seedBridgeCacheFromSidecar();
        const missing = await cache.getStaleIds('aniListBridgeCache', ids);
        if (!missing.length) {
          sendResponse({ ok: true, fetched: 0, fromCache: ids.length });
          return;
        }
        const fresh = await bulkFetchByIds(missing);
        const additions = {};
        for (const [id, media] of Object.entries(fresh || {})) {
          if (media) additions[id] = media;
        }
        if (Object.keys(additions).length > 0) {
          await cache.putBatch('aniListBridgeCache', additions);
        }
        console.log(`[crsmart] survey: hydrated ${Object.keys(fresh || {}).length} tile-media entries`);
        sendResponse({ ok: true, fetched: Object.keys(fresh || {}).length });
      } catch (err) {
        console.warn('[crsmart] survey:fetchTileMedia error', err);
        sendResponse({ ok: false, reason: String(err?.message || err) });
      }
    })();
    return true;
  }
  // sidebar:backfillCovers — fired by sidepanel.js when it renders
  // recs whose coverImage.large/medium is null (typically the
  // new-lens entries that come straight from allShowsScored, before
  // any rec-pool fetch has touched their Media). Bulk-fetches the
  // listed aniListIds and patches coverImage into the live storage
  // keys so storage.onChanged triggers a re-render with real covers.
  //   - aniListBridgeCache: long-term cache for any future render
  //   - allShowsScored[crSeriesId]: patched if the entry is currently
  //     missing coverImage (don't clobber populated entries)
  //   - recommendationsScored[lens].ranked[].coverImage: patched in
  //     place so the next render() call reads the freshly hydrated
  //     URL without waiting for a full recompute.
  if (msg?.type === 'sidebar:backfillCovers') {
    const ids = Array.isArray(msg.aniListIds)
      ? msg.aniListIds.filter(n => typeof n === 'number')
      : [];
    (async () => {
      if (!ids.length) {
        sendResponse({ ok: true, fetched: 0 });
        return;
      }
      if (anilistIsPaused()) {
        sendResponse({ ok: false, reason: 'rate-limited',
          retryInMs: anilistPauseMsLeft() });
        return;
      }
      try {
        const fresh = await bulkFetchByIds(ids);
        const freshById = {};
        const additionsForBridge = {};
        for (const [id, media] of Object.entries(fresh || {})) {
          if (!media) continue;
          freshById[+id] = media;
          additionsForBridge[id] = media;
        }
        if (Object.keys(additionsForBridge).length > 0) {
          await cache.putBatch('aniListBridgeCache', additionsForBridge);
        }
        // Patch live storage keys so the side panel re-renders with
        // covers immediately. Three writes:
        //   1. aniListCache[crSeriesId].coverImage — the SOURCE of
        //      truth that computeAllShowsScored rebuilds from. Without
        //      this, the next persistTasteVector run reconstructs
        //      allShowsScored from the still-cover-less cache and
        //      clobbers our other two patches. (First version of this
        //      handler didn't write here; covers appeared then vanished
        //      on the next recompute.)
        //   2. allShowsScored[crSeriesId].coverImage — patched in place
        //      so the side panel re-renders immediately, before any
        //      recompute settles.
        //   3. recommendationsScored[lens].ranked[i].coverImage — same
        //      reasoning, for the new lenses that read directly from
        //      this list.
        // Don't clobber populated entries — only fill nulls.
        const stored = await chrome.storage.local.get(['aniListCache', 'allShowsScored', 'recommendationsScored']);
        const aniListCache = stored.aniListCache || {};
        const allShowsScored = stored.allShowsScored || {};
        const recScored = stored.recommendationsScored || {};
        let patchedCache = 0;
        let patchedAll = 0;
        for (const [crSeriesId, entry] of Object.entries(allShowsScored)) {
          const al = entry?.aniListId;
          if (al == null) continue;
          const fetched = freshById[al];
          if (!fetched?.coverImage) continue;
          if (!(entry.coverImage?.large || entry.coverImage?.medium)) {
            entry.coverImage = fetched.coverImage;
            patchedAll++;
          }
          const cacheEntry = aniListCache[crSeriesId];
          if (cacheEntry && !(cacheEntry.coverImage?.large || cacheEntry.coverImage?.medium)) {
            cacheEntry.coverImage = fetched.coverImage;
            patchedCache++;
          }
        }
        let patchedRec = 0;
        for (const lensData of Object.values(recScored)) {
          for (const r of (lensData?.ranked || [])) {
            const al = r?.aniListId;
            if (al == null) continue;
            if (r.coverImage?.large || r.coverImage?.medium) continue;
            const fetched = freshById[al];
            if (fetched?.coverImage) {
              r.coverImage = fetched.coverImage;
              patchedRec++;
            }
          }
        }
        if (patchedAll > 0 || patchedRec > 0 || patchedCache > 0) {
          await chrome.storage.local.set({
            aniListCache,
            allShowsScored,
            recommendationsScored: recScored,
          });
        }
        console.log(`[crsmart] sidebar: backfilled covers — fetched=${Object.keys(freshById).length}, patched cache=${patchedCache}, allShows=${patchedAll}, recs=${patchedRec}`);
        sendResponse({ ok: true, fetched: Object.keys(freshById).length, patchedCache, patchedAll, patchedRec });
      } catch (err) {
        console.warn('[crsmart] sidebar:backfillCovers error', err);
        sendResponse({ ok: false, reason: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === 'survey:applyAndRecompute') {
    (async () => {
      try {
        await persistTasteVector(null);
        sendResponse({ ok: true });
      } catch (err) {
        console.warn('[crsmart] survey:applyAndRecompute error', err);
        sendResponse({ ok: false, reason: String(err?.message || err) });
      }
    })();
    return true;
  }
  // survey:seedCandidatesForTag — user clicked the seed CTA on a
  // 'fired-no-candidates' tap-effect row. Fetch top peak shows for
  // the named tag from AniList (sorted SCORE_DESC), persist as
  // seededCandidates[tag], then trigger a recompute so the rec
  // pipeline picks them up.
  if (msg?.type === 'survey:seedCandidatesForTag') {
    const tag = String(msg.tag || '').trim();
    (async () => {
      if (!tag) {
        sendResponse({ ok: false, reason: 'no-tag' });
        return;
      }
      if (anilistIsPaused()) {
        sendResponse({ ok: false, reason: 'rate-limited',
          retryInMs: anilistPauseMsLeft() });
        return;
      }
      try {
        const fetched = await fetchTopShowsByTag(tag, { perPage: 15 });
        if (!Object.keys(fetched).length) {
          sendResponse({ ok: false, reason: 'no-results' });
          return;
        }
        // Persist alongside any existing seeded tags. Each tag's
        // entry holds the AniList projections by id; the rec
        // pipeline merges these into the candidate pool.
        const { seededCandidates = {} } = await chrome.storage.local.get('seededCandidates');
        seededCandidates[tag] = {
          aniListIds: Object.keys(fetched).map(id => parseInt(id, 10)),
          mediaByAniListId: fetched,
          seededAt: Date.now(),
        };
        await chrome.storage.local.set({ seededCandidates });
        // Fire a recompute so the side panel reflects the new
        // candidates immediately.
        await persistTasteVector(null);
        sendResponse({ ok: true, count: Object.keys(fetched).length });
      } catch (err) {
        console.warn('[crsmart] survey:seedCandidatesForTag error', err);
        sendResponse({ ok: false, reason: String(err?.message || err) });
      }
    })();
    return true;
  }
  return false;
});

// Content-script ping when the user lands on a series page. Refreshes
// this one series' franchise totals so the card's commitment line stays
// current with CR (AniList's relation edges lag CR on currently-airing
// shows — e.g. JJK S3 aired before AniList added the S2→S3 sequel edge).
// Deduped per series per session via an in-memory set so a quick re-nav
// doesn't hammer /cms/objects.
const refreshedSeriesThisSession = new Set();
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'refreshCrMetaForSeries') return false;
  const seriesId = msg.seriesId;
  if (!seriesId || typeof seriesId !== 'string') {
    sendResponse({ ok: false, reason: 'no-series-id' });
    return true;
  }
  if (refreshedSeriesThisSession.has(seriesId)) {
    sendResponse({ ok: true, skipped: 'already-refreshed-this-session' });
    return true;
  }
  (async () => {
    try {
      const { crToken } = await chrome.storage.session.get('crToken');
      if (!crToken) { sendResponse({ ok: false, reason: 'no-token' }); return; }
      // NOTE: dedup is added at the END of the chain, only when we got
      // a verified/best-guess AniList entry. A transient failure
      // (no-match, error, no-token, rate-limit) used to dedup-poison
      // the seriesId for the rest of the session — second visit got
      // skipped entirely and the user saw a permanently-empty card
      // until they restarted Chrome. Now bad outcomes leave the dedup
      // un-set so the next visit retries.

      // 1) franchise totals (season_count, episode_count) via cms/objects
      const meta = await fetchCrSeriesMeta([seriesId]);

      // 2) per-season row list so we can filter non-TV entries (OVAs,
      //    Director's Cuts, Recaps) out of the count. Running the probe
      //    alongside the first real fetch is free — it self-gates.
      await probeCrSeasonsShape(seriesId).catch(err =>
        console.warn('[crsmart] seasons probe error', err));
      const seasons = await fetchCrSeasons(seriesId);

      // 3) fresh AniList relations. Relation edges for currently-airing
      //    shows (new movies, sequels) land later than the initial
      //    search, and franchise-level movies (Slime's Scarlet Bond)
      //    sometimes only appear after the movie debuts. A fresh enrich
      //    on series-page visit catches both without waiting for the
      //    30-day bulk TTL.
      const { aniListCache = {} } = await chrome.storage.local.get('aniListCache');
      const existing = aniListCache[seriesId];
      const slug = msg.slug || null;
      const title = msg.title || existing?.title?.english || existing?.title?.romaji || null;
      let aniListRefreshed = false;
      if (anilistIsPaused()) {
        const secondsLeft = Math.ceil(anilistPauseMsLeft() / 1000);
        console.log(`[crsmart] on-visit refresh (${seriesId}): skipping enrichOne — circuit-breaker paused ${secondsLeft}s`);
      } else
      if (title) {
        try {
          // Fast path: if manami's CR→AniList map resolves this
          // series, fetch by AniList ID directly instead of running
          // title search + verify. Falls back to enrichOne when the
          // map doesn't have it (long-tail CR shows or entries
          // missing CR URLs in manami's aggregate).
          const { crToAniListId = {} } = await chrome.storage.local.get('crToAniListId');
          const mappedAniListId = crToAniListId[seriesId];
          const fresh = mappedAniListId
            ? await enrichOneByMappedId({ seriesId, aniListId: mappedAniListId })
            : await enrichOne({ seriesId, title, slug });
          // Route through cache-store. markError + markNoMatch both
          // preserve a prior verified entry (no downgrade), so the
          // "don't overwrite verified with error" guard moves into
          // the cache module — no caller-side classification needed.
          // aniListRefreshed only fires when actual data lands so we
          // don't trigger a re-score for backoff/no-match marks.
          if (fresh) {
            if (fresh._matchConfidence === 'error') {
              await cache.markError('aniListCache', seriesId, fresh._error);
            } else if (fresh._matchConfidence === 'no-match'
                    || fresh._matchConfidence === 'no-title') {
              await cache.markNoMatch('aniListCache', seriesId,
                                      fresh._error || fresh._matchConfidence);
            } else {
              await cache.put('aniListCache', seriesId, fresh);
              aniListRefreshed = true;
            }
          }
        } catch (err) {
          console.warn('[crsmart] on-visit AniList refresh failed', err);
        }
      }

      // Persist CR meta through cache-store; seasons-cache stays a
      // direct chrome.storage write (it has its own per-entry
      // fetchedAt and isn't an entry-cache yet).
      if (meta[seriesId]) {
        await cache.put('crSeriesMeta', seriesId, meta[seriesId]);
      }
      if (seasons) {
        const stored = await chrome.storage.local.get('crSeasonsCache');
        const mergedSeasons = { ...(stored.crSeasonsCache || {}) };
        mergedSeasons[seriesId] = { fetchedAt: Date.now(), seasons };
        await chrome.storage.local.set({ crSeasonsCache: mergedSeasons });
      }

      // Tier 2: if AniList data just landed for this series (or got
      // refreshed), rescore the whole allShowsScored map so the
      // content script can render a card for this visit. Async
      // fire-and-forget — content-script's storage listener will
      // repaint when the allShowsScored write lands.
      if (aniListRefreshed) {
        // Flush the on-visit cache.put so the next chrome.storage read
        // (inside recomputeQualityAxes / computeAllShowsScored) sees
        // the new entry. Without this, the debounced flush window
        // races against the downstream reads.
        await cache.flush('aniListCache');
        const { tasteVectorAll } = await chrome.storage.local.get('tasteVectorAll');
        if (tasteVectorAll) {
          // Also annotate qualityAxes so the pedigree chip can fire
          // on off-pool shows. Small cost (builds the quality index
          // once from the whole cache) compared to the full taste
          // refresh; fine to run on every series visit.
          await recomputeQualityAxes();
          await computeAllShowsScored(tasteVectorAll);
        }
      }

      // Tier 2.5: focused franchise-bridge enrichment for THIS series.
      // computeAllShowsScored runs over 600+ entries with mediaById built
      // only from aniListCache, so deep franchises (Dr. Stone S1 → S2 →
      // Special → S3 → Science Future) under-reach when only one node
      // is in cache. Doing on-visit enrichment for the visited series
      // alone keeps the cost bounded (one franchise per page nav, max
      // ~50 fetches gated by budget + bridge cache) while filling in
      // start/end years that the rec path already gets via lazy
      // enrichment. Skipped when the series isn't in aniListCache.
      await enrichOneSeriesFranchise(seriesId).catch(err =>
        console.warn('[crsmart] on-visit franchise enrich failed', err));

      // Dedup AT THE END, only when we have a usable AniList entry.
      // Re-read aniListCache (enrichOneSeriesFranchise may have written
      // additional bridge entries; we want to check the canonical
      // entry for THIS seriesId).
      const { aniListCache: finalCache = {} } = await chrome.storage.local.get('aniListCache');
      const finalEntry = finalCache[seriesId];
      const finalGood = finalEntry
        && (finalEntry._matchConfidence === 'verified'
            || finalEntry._matchConfidence === 'unverified-best-guess');
      if (finalGood) {
        refreshedSeriesThisSession.add(seriesId);
      } else {
        console.log(`[crsmart] on-visit refresh (${seriesId}): leaving dedup un-set`
          + ` (confidence=${finalEntry?._matchConfidence || 'missing'}); next visit will retry`);
      }

      sendResponse({
        ok: true,
        meta: meta[seriesId] || null,
        seasonsCount: seasons?.length || 0,
        aniListRefreshed,
      });
    } catch (err) {
      sendResponse({ ok: false, reason: String(err?.message || err) });
    }
  })();
  return true;
});

// Validation snapshot. Reads current engine state from chrome.storage,
// loads curated cases from validation/cases.json (extension URL),
// runs them through the validation-runner, returns the snapshot
// JSON to the caller (popup) for download. See
// docs/PRD-SCORING-PHILOSOPHY.md §Validation methodology and
// validation/README.md for the workflow.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'crsmart:validate-snapshot') return false;
  (async () => {
    try {
      // G13-prep: snapshot now also pulls recommendationsScored
      // (per-lens slices), tasteShapeRadar (compact summary), and the
      // debug telemetry keys (engine errors, health, rate-limit log).
      // All optional — missing keys produce null sections.
      const stored = await chrome.storage.local.get([
        'allShowsScored', 'tasteVectorAll', 'recommendationsScored',
        'tasteShapeRadar',
        '_engineErrors', '_engineHealth', '_anilistRateLimit',
      ]);
      const { allShowsScored, tasteVectorAll, recommendationsScored, tasteShapeRadar } = stored;
      if (!allShowsScored || !Object.keys(allShowsScored).length) {
        sendResponse({ ok: false, reason: 'no-scored-shows-yet' });
        return;
      }
      let cases = null;
      try {
        const resp = await fetch(chrome.runtime.getURL('validation/cases.json'));
        if (resp.ok) cases = await resp.json();
      } catch (err) {
        console.warn('[crsmart] validate: cases.json load failed', err);
      }
      const snapshot = buildSnapshot({
        allShowsScored,
        tasteVectorAll,
        cases,
        userId: msg.userId || 'andrew',
        recommendationsScored,
        tasteShapeRadar,
        engineErrors: stored._engineErrors,
        engineHealth: stored._engineHealth,
        anilistRateLimit: stored._anilistRateLimit,
      });
      sendResponse({ ok: true, snapshot });
    } catch (err) {
      sendResponse({ ok: false, reason: String(err?.message || err) });
    }
  })();
  return true;
});

// External-source link/import message routing for the popup UI.
// All messages prefixed `crsmart:external:*` route through this
// listener. Async work uses the sendResponse + return true pattern
// matching the other handlers in this file. AuthError codes
// (`reauth_required`, `cancelled`, `token_exchange_failed`) bubble
// up to the popup so it can branch on err.code rather than parse
// strings.
// Link AniList by public username — replaces OAuth (AniList rejects PKCE +
// implicit, so OAuth would require shipping a client secret). Validates the
// username AND that the list is public by fetching it once, then stores the
// account under oauthTokens.anilist (no token, linkedVia:'username') so
// getAccount('anilist') + the import path keep working unchanged.
async function linkAniListByUsername(userName) {
  const name = String(userName || '').trim();
  if (!name) { const e = new Error('Enter your AniList username.'); e.code = 'no-username'; throw e; }
  const { account } = await fetchUserListByName(name); // throws not-found-or-private
  const { oauthTokens = {} } = await chrome.storage.local.get('oauthTokens');
  oauthTokens.anilist = { account, linkedVia: 'username', linkedAt: Date.now() };
  await chrome.storage.local.set({ oauthTokens });
  return { account };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (typeof msg?.type !== 'string' || !msg.type.startsWith('crsmart:external:')) {
    return false;
  }
  (async () => {
    try {
      switch (msg.type) {
        case 'crsmart:external:link': {
          // AniList: link by public username (no OAuth, no token, no secret).
          // Validates the username + that the list is public by fetching it,
          // then stores the account so the import path can re-fetch by name.
          if (msg.source === 'anilist') {
            const result = await linkAniListByUsername(msg.userName);
            sendResponse({ ok: true, ...result });
            return;
          }
          // Other sources (MAL, if ever wired) keep the OAuth flow.
          const result = await oauthAuthenticate(msg.source);
          sendResponse({ ok: true, ...result });
          return;
        }
        case 'crsmart:external:status': {
          // Cheap "is signed in?" check — pulls cached account from
          // storage without hitting the network. Returns linked
          // sources + per-source configured flag + import state in
          // one round-trip so the popup can render its full panel
          // from one message. configured=false → source is wired in
          // code but its OAuth client ID hasn't been registered yet
          // (popup renders "coming soon", disables Link button).
          const linked = await oauthListLinkedSources();
          const accounts = {};
          for (const source of linked) {
            accounts[source] = await oauthGetAccount(source);
          }
          const configured = oauthGetConfiguredSources();
          const importState = await getImportState();
          // Compute per-source import stats: how many entries did
          // we import vs. how many of those have a CR watch-shape
          // and therefore actually contribute to the taste vector.
          // Stranded = imported - contributing. Surfaces the real
          // engine integration ratio so the user sees, e.g.,
          // "896 imported / 314 contributing" rather than thinking
          // all 896 are folded in. Only computed when an import
          // exists in storage; cheap O(catalog + import) walk.
          const importStats = await computeExternalImportStats();
          const importImpact = await computeExternalImportImpact();
          sendResponse({ ok: true, linked, accounts, configured, importState, importStats, importImpact });
          return;
        }
        case 'crsmart:external:start-import': {
          // Async: kicks off importFromAniList / importFromMal and
          // resolves with the import result. The popup typically
          // doesn't await this — it polls _importState via the
          // status message instead. But responding with the final
          // outcome means the popup CAN await for short imports.
          const fn = msg.source === 'mal' ? importFromMal : importFromAniList;
          const result = await fn();
          // Graduate the user out of cold-start state if the import
          // wrote ≥ 1 entry. result.imported can be 0 if the user has
          // an empty list — don't graduate on an empty success.
          if (result?.imported > 0) {
            markWelcomeProgress(msg.source === 'mal' ? 'mal' : 'anilist');
          }
          sendResponse({ ok: true, result });
          return;
        }
        case 'crsmart:external:start-mal-xml-import': {
          // Same shape as start-import but the entries come pre-parsed
          // from import-mal-xml.html instead of being fetched from
          // MAL's API. Routes through importFromMalXml which feeds the
          // parsed list into the same cross-walk + enrich + flush
          // pipeline. Source label stays 'mal' so engine snapshots and
          // externalScores keys don't fragment.
          const result = await importFromMalXml(msg.entries);
          if (result?.imported > 0) markWelcomeProgress('mal');
          sendResponse({ ok: true, result });
          return;
        }
        case 'crsmart:external:start-freeform-import': {
          // Page-side parser+matcher already resolved msg.entries to
          // AL IDs; we just dispatch to importFromFreeform which feeds
          // the resolved set through the enrich + flush stages.
          // Per-source slot is 'freeform' (separate from 'mal'/'anilist'
          // so cross-source confidence semantics work). Graduates the
          // welcome funnel like the API/XML paths.
          const result = await importFromFreeform({ entries: msg.entries });
          if (result?.imported > 0) markWelcomeProgress('freeform');
          sendResponse({ ok: true, result });
          return;
        }
        case 'crsmart:external:freeform-al-search-batched': {
          // Batched AL Search for the freeform-import matcher. The
          // page-side matcher (freeform-matcher.js's resolveFreeformList)
          // accepts a searchFn via DI; the page-side adapter in
          // import-freeform.js debounces per-title searchFn calls into
          // batches of up to 10 and sends ONE message here per batch.
          //
          // Routes through searchTopByTitleBatched which builds an
          // aliased GraphQL query (q0/q1/.../q9), sends one HTTP
          // request to AL, and demultiplexes the response back to
          // per-title result lists. On whole-batch failure (network
          // error / 5xx / breaker open), searchTopByTitleBatched falls
          // back internally to per-title searchTopByTitle queries —
          // slower but resilient.
          //
          // Per Q11 of the 2026-05-18 grill: only titles leave the
          // device. Scores, status, favorites stay page-side.
          //
          // Replaces the previous 'crsmart:external:freeform-al-search'
          // single-query handler (2026-05-19 grill). The new handler's
          // internal fallback covers the single-query path implicitly,
          // so we don't need both routes.
          const titles = Array.isArray(msg.titles) ? msg.titles : [];
          if (titles.length === 0) {
            sendResponse({ ok: true, results: {} });
            return;
          }
          const results = await searchTopByTitleBatched(titles, { limit: 5 });
          sendResponse({ ok: true, results });
          return;
        }
        case 'crsmart:external:cancel-import': {
          cancelActiveImport();
          sendResponse({ ok: true });
          return;
        }
        case 'crsmart:external:sign-out': {
          await oauthSignOut(msg.source);
          sendResponse({ ok: true });
          return;
        }
        case 'crsmart:external:clear-source-data': {
          // Delete a source's contributions from externalScores. Used
          // by the MAL XML row's "clear" affordance — XML imports don't
          // carry an OAuth token to revoke, so this is the only
          // un-do path for the user. The storage.set triggers
          // pipeline-runner recompute automatically.
          const result = await clearSourceData(msg.source);
          sendResponse({ ok: true, result });
          return;
        }
        default:
          sendResponse({ ok: false, reason: `unknown external message: ${msg.type}` });
      }
    } catch (err) {
      const reason = err instanceof AuthError
        ? { code: err.code, message: err.message }
        : { code: 'error', message: String(err.message || err) };
      sendResponse({ ok: false, ...reason });
    }
  })();
  return true;
});

// Per-source counts: imported = entries written by the importer;
// contributing = entries with a matching CR watch-shape (i.e., the
// engine's per-series loop actually walks past them); stranded =
// imported - contributing. The contributing count is what shapes
// the taste vector / archetype blend / studio-creator index. A high
// stranded ratio means the user has rated lots on AL/MAL but never
// started those shows on CR, so the imported scores aren't
// reaching Sentiment yet (open Q in CONTEXT.md, captured in
// 2026-05-04 BRAINSTORM entry — synthesizing behavioral shapes
// from AL list-status is the candidate fix).
async function computeExternalImportStats() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.externalScores,
    STORAGE_KEYS.aniListCache,
    STORAGE_KEYS.aniListBridgeCache,
    STORAGE_KEYS.watchShapes,
  ]);
  const ext = stored[STORAGE_KEYS.externalScores] || {};
  const cache = stored[STORAGE_KEYS.aniListCache] || {};
  const bridge = stored[STORAGE_KEYS.aniListBridgeCache] || {};
  const shapes = stored[STORAGE_KEYS.watchShapes]?.series || {};
  // Build the set of aniListIds the engine "sees" via a real CR
  // watch-shape (overlap with watchShapes).
  const realWatchAlIds = new Set();
  for (const [crSeriesId, _shape] of Object.entries(shapes)) {
    const alId = cache[crSeriesId]?.aniListId;
    if (Number.isInteger(alId)) realWatchAlIds.add(alId);
  }
  // An entry "contributes" if it would land in effectiveWatchShapes
  // after synthesizeExternalShapes runs:
  //   (a) it has a real CR watch-shape (real overlap), OR
  //   (b) its dominant source has status 'completed'/'dropped' AND
  //       the bridge cache has its Media (synthesis precondition).
  // Mirrors synthesizeExternalShapes logic so the popup reflects the
  // engine's actual integrated set, not the storage-overlap subset.
  const out = {};
  for (const [aniListIdStr, sources] of Object.entries(ext)) {
    const aniListId = Number(aniListIdStr);
    if (!Number.isInteger(aniListId)) continue;
    const realOverlap = realWatchAlIds.has(aniListId);
    const dominant = pickDominantSource(sources);
    const status = dominant?.status;
    const synthEligible = !realOverlap
      && (status === 'completed' || status === 'dropped')
      && !!bridge[aniListId];
    const contributes = realOverlap || synthEligible;
    for (const source of Object.keys(sources || {})) {
      if (!out[source]) out[source] = { imported: 0, contributing: 0, viaRealWatch: 0, viaSynthesis: 0 };
      out[source].imported++;
      if (contributes) out[source].contributing++;
      if (realOverlap) out[source].viaRealWatch++;
      else if (synthEligible) out[source].viaSynthesis++;
    }
  }
  for (const source of Object.keys(out)) {
    out[source].stranded = out[source].imported - out[source].contributing;
  }
  return out;
}

// Diff the pre-import engine snapshot (captured by the importer's
// captureEngineSnapshot) against the current post-recompute state.
// Returns a per-source object describing what shifted in:
//   tags          — taste-vector tag count delta
//   archetypes    — list of {name, before, after, delta} for the
//                   union of pre/post top-5 (so additions + drop-outs
//                   show up alongside score shifts)
//   studios       — same shape as archetypes
//   dimensions    — same shape, magnitude instead of score
// When no snapshot exists for a source, returns null for that slot.
async function computeExternalImportImpact() {
  const stored = await chrome.storage.local.get([
    '_engineImpactBefore',
    'tasteVectorAll',
    'archetypeBlend',
    'studioCreatorIndex',
    'tasteDimensions',
  ]);
  const before = stored._engineImpactBefore || {};
  if (Object.keys(before).length === 0) return {};

  // Build "now" snapshot in the same shape captureEngineSnapshot uses.
  const tasteVec = stored.tasteVectorAll || {};
  const archBlend = stored.archetypeBlend?.archetypes || stored.archetypeBlend || [];
  const studioIdx = stored.studioCreatorIndex?.studios || {};
  const dims = stored.tasteDimensions?.dimensions || stored.tasteDimensions || {};
  const dimsArr = Array.isArray(dims) ? dims : Object.values(dims);
  const archArr = Array.isArray(archBlend) ? archBlend : [];

  const nowTags = Object.keys(tasteVec.raw || {}).length;
  const nowContributing = tasteVec.contributingSeries || null;
  const nowArchetypesAll = archArr
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map(a => ({ id: a.id || a.name, name: a.name, score: +(a.score || 0).toFixed(4) }));
  const nowStudiosAll = Object.values(studioIdx)
    .sort((a, b) => (b.totalWeight || 0) - (a.totalWeight || 0))
    .map(s => ({ id: s.id, name: s.name, weight: +(s.totalWeight || 0).toFixed(3) }));
  const nowDimensionsAll = dimsArr
    .filter(d => typeof d.magnitude === 'number')
    .sort((a, b) => (b.magnitude || 0) - (a.magnitude || 0))
    .map(d => ({ id: d.id, name: d.name, magnitude: +(d.magnitude || 0).toFixed(2) }));

  // Diff helper — for each ranked list, take the union of pre top-5
  // and post top-5, then for each name look up before/after values.
  // Items that drop out of top-5 still appear (after = null) so the
  // diff explains *why* a new entry replaced them.
  function diffRanked(beforeList, afterListAll, valKey) {
    const beforeTop = (beforeList || []).slice(0, 5);
    const afterTop = afterListAll.slice(0, 5);
    const names = new Set([...beforeTop.map(x => x.name), ...afterTop.map(x => x.name)]);
    const beforeByName = new Map(beforeList.map(x => [x.name, x[valKey]]));
    const afterByNameAll = new Map(afterListAll.map(x => [x.name, x[valKey]]));
    const out = [];
    for (const name of names) {
      const b = beforeByName.has(name) ? beforeByName.get(name) : null;
      const a = afterByNameAll.has(name) ? afterByNameAll.get(name) : null;
      out.push({
        name,
        before: b,
        after: a,
        delta: (a != null && b != null) ? +(a - b).toFixed(3) : null,
        wasInBefore: beforeTop.some(x => x.name === name),
        isInAfter: afterTop.some(x => x.name === name),
      });
    }
    // Sort by absolute delta desc, then by post value desc.
    out.sort((x, y) => Math.abs(y.delta || 0) - Math.abs(x.delta || 0) || (y.after || 0) - (x.after || 0));
    return out;
  }

  const out = {};
  for (const [source, snap] of Object.entries(before)) {
    if (!snap) continue;
    out[source] = {
      capturedAt: snap.capturedAt,
      tags: { before: snap.tasteTags, after: nowTags, delta: nowTags - (snap.tasteTags || 0) },
      contributing: snap.contributingSeries != null
        ? { before: snap.contributingSeries, after: nowContributing, delta: (nowContributing || 0) - snap.contributingSeries }
        : null,
      archetypes: diffRanked(snap.topArchetypes || [], nowArchetypesAll, 'score'),
      studios:    diffRanked(snap.topStudios || [],    nowStudiosAll,    'weight'),
      dimensions: diffRanked(snap.topDimensions || [], nowDimensionsAll, 'magnitude'),
    };
  }
  return out;
}

async function maybeSyncHistory() {
  // Schema-stale check fires before the freshness check so a formula
  // bump triggers a recompute even when the history cache is "fresh
  // enough" to skip a re-sync. Without this, formula changes only land
  // on the next genuine history refresh — could be hours/days.
  await recomputeIfSchemaStale().catch(err =>
    console.warn('[crsmart] schema-stale check error', err));

  const local = await chrome.storage.local.get(['profileId', 'crHistory']);
  const session = await chrome.storage.session.get(['crToken']);
  console.log('[crsmart] maybeSyncHistory:', {
    hasProfileId: !!local.profileId,
    hasToken: !!session.crToken,
    cachedFetchedAt: local.crHistory?.[local.profileId]?.fetchedAt || null,
  });
  if (!local.profileId || !session.crToken) return;
  const cached = local.crHistory && local.crHistory[local.profileId];
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < STALE_MS) {
    console.log('[crsmart] cache fresh, skipping sync');
    // Still consider enrichment — an earlier run may have been cut short,
    // or the AniList TTL may have lapsed even though history is fresh.
    if (cached.items?.length) {
      const seriesIds = new Set(cached.items.map(i => i.seriesId).filter(Boolean));
      probeRatingsShape(seriesIds).catch(err =>
        console.warn('[crsmart] ratings probe error', err));
      probeSeriesShape(seriesIds).catch(err =>
        console.warn('[crsmart] series probe error', err));
      probeHistoryRawShape(local.profileId).catch(err =>
        console.warn('[crsmart] history probe error', err));
      // Refresh CR-franchise episode counts (TTL-gated) before deriving
      // shapes — without these, completionRatio clamps to 100% on any
      // multi-season watch. Re-derives shapes after meta lands so cached
      // runs catch the correction.
      (async () => {
        try {
          await ensureCrSeriesMeta(seriesIds);
          await persistWatchShapes(cached.items);
        } catch (err) {
          console.warn('[crsmart] cr-meta / shapes error', err);
        }
      })();
      maybeEnrichAniList(local.profileId, cached.items).catch(err =>
        console.warn('[crsmart] anilist enrichment error', err));
    }
    return;
  }
  await syncHistory(local.profileId);
}

async function syncHistory(profileId) {
  const items = [];
  let page = 1;
  let total = null;
  let diag = null;

  console.log('[crsmart] starting sync for profile', profileId.slice(0, 8) + '…');

  while (true) {
    const url = `https://www.crunchyroll.com/content/v2/${profileId}/watch-history`
      + `?page=${page}&page_size=${PAGE_SIZE}&locale=en-US&preferred_audio_language=en-US`;
    const result = await crFetch(url, `watch-history page ${page}`);
    if (!result.ok) {
      if (result.kind === 'auth' && result.status === 401) {
        console.warn('[crsmart] 401 — token stale, bailing (next capture will retrigger)');
      } else {
        console.warn('[crsmart] watch-history failed', page, result.message);
      }
      await setCrHistoryProgress(null);
      return;
    }
    const json = result.data;
    if (total === null) total = typeof json.total === 'number' ? json.total : null;
    const data = Array.isArray(json.data) ? json.data : [];
    console.log(`[crsmart] page ${page}: got ${data.length} items (total reported: ${total})`);
    if (page === 1 && data[0] && !diag) {
      diag = describeShape(data[0]);
      console.log('[crsmart] schema diag (first item):', diag);
      // Surface any raw fields we're throwing away — catches e.g. a
      // hidden play_count we haven't been projecting.
      const unused = unprojectedFields(data[0]);
      if (unused.length) {
        console.log('[crsmart] schema diag — unprojected fields:', unused);
      }
    }
    if (data.length === 0) break;
    for (const raw of data) items.push(projectItem(raw));
    // Surface pagination progress so the popup can render a bar.
    // total is the API's reported episode count; items.length is what
    // we've projected so far. Total can be null briefly if the first
    // page hadn't reported yet — the popup tolerates total=-1 as
    // "unknown, show indeterminate bar."
    await setCrHistoryProgress({
      phase: 'history-fetch',
      label: 'Fetching CR watch history',
      current: items.length,
      total: typeof total === 'number' ? total : -1,
      page,
      startedAt: Date.now(),
    });
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  // Pagination done — clear the bar. AniList enrichment may still run
  // after this and will set its own progress key.
  await setCrHistoryProgress(null);

  const all = (await chrome.storage.local.get('crHistory')).crHistory || {};
  all[profileId] = {
    fetchedAt: Date.now(),
    total: total != null ? total : items.length,
    items,
    _diag: diag,
  };
  await chrome.storage.local.set({ crHistory: all });
  // Coarse signal: how many series unique? Used for the popup completeness count.
  const seriesIds = new Set(items.map(i => i.seriesId).filter(Boolean));
  await chrome.storage.local.set({
    crHistorySummary: {
      profileId,
      fetchedAt: Date.now(),
      episodeCount: items.length,
      seriesCount: seriesIds.size,
    },
  });
  console.log(`[crsmart] sync complete: ${items.length} eps, ${seriesIds.size} series`);

  // Pull franchise-level episode counts from CR (bulk, ~4 requests for
  // 300 series). Needed before shapes so completionRatio isn't computed
  // against AniList's per-season number.
  try {
    await ensureCrSeriesMeta(seriesIds);
  } catch (err) {
    console.warn('[crsmart] cr-meta error', err);
  }

  // Pull the user's watchlist alongside history. These are shows the
  // user explicitly saved (intent to watch) but haven't started, or
  // have started and bookmarked. Strongest taste signal short of an
  // actual watch. One request, no pagination needed for typical
  // watchlists. Stored separately so downstream surfaces can annotate
  // recs ("you've already saved this") without conflating "saved" with
  // "watched". Failure is non-fatal — the rest of the sync proceeds.
  try {
    await fetchAndPersistWatchlist(profileId);
  } catch (err) {
    console.warn('[crsmart] watchlist fetch error', err);
  }

  // Pull CR's own personalized recommendations for the user. Different
  // signal class from our content-based taste vector — CR runs a
  // collaborative-filtering engine over their full user base, so this
  // captures co-watching patterns ("people who watched X also loved Y")
  // that pure tag-similarity can't see. Used as a 4th sub-score blended
  // at low weight (~10%) — complements taste-vector + community recs
  // without dictating the final ranking.
  try {
    await fetchAndPersistCrPersonalRecs(profileId);
  } catch (err) {
    console.warn('[crsmart] cr-personal-recs fetch error', err);
  }

  // Derive watch shapes (completed/dropped/in-progress + per-ep rewatches)
  // from the freshly-synced items. Pure computation, no API calls.
  await persistWatchShapes(items);

  // One-shot recon: dump the structural shape of cms/objects?ratings=true
  // for a single known series so we can confirm whether the rating field
  // is the logged-in user's rating, the global average, or both. Logs
  // keys + types only — never values. Self-gating via storage flag.
  probeRatingsShape(seriesIds).catch(err =>
    console.warn('[crsmart] ratings probe error', err));
  probeSeriesShape(seriesIds).catch(err =>
    console.warn('[crsmart] series probe error', err));

  // Hand off to AniList enrichment. Don't await — let it run async so the
  // history sync's storage writes (which the popup reacts to) land first.
  maybeEnrichAniList(profileId, items).catch(err =>
    console.warn('[crsmart] anilist enrichment error', err));
}

// One-shot cache migration: when projectMedia's output shape changes,
// re-fetch every cached entry that has a known AniList ID. Skips the
// search/verify pass — those IDs are already canonical, so we just pull
// fresh Media via the by-ID query and merge in. Preserves _matchConfidence,
// _searchTitle, and the previous fetchedAt so existing TTL math still works.
async function migrateAniListCacheSchema() {
  const { aniListCache = {} } = await chrome.storage.local.get('aniListCache');
  const stale = [];
  let incompleteRetries = 0;
  for (const [crId, entry] of Object.entries(aniListCache)) {
    if (!entry?.aniListId) continue; // 'no-match' / 'no-title' / 'error'
    const schemaStale = entry._schema !== ANILIST_SCHEMA_VERSION;
    // Even on the current schema, retry entries whose franchise root-walk
    // didn't complete (no _descriptionFromRoot:true) but which still have
    // a TV PREQUEL/PARENT to walk toward. A 429 mid-walk during the
    // previous pass would have left these holding a closer-to-root but
    // still-per-season description; this gives them another shot.
    const walkIncomplete =
      !schemaStale &&
      entry._descriptionFromRoot !== true &&
      hasTvRootCandidate(entry);
    if (!schemaStale && !walkIncomplete) continue;
    if (walkIncomplete) incompleteRetries++;
    stale.push({ crId, aniListId: entry.aniListId, prev: entry });
  }
  if (stale.length === 0) return 0;
  console.log(`[crsmart] anilist schema migration: ${stale.length} entries need refresh (${incompleteRetries} root-walk retries)`);
  const ids = stale.map(s => s.aniListId);
  // Pre-seed the root-walk cache with EVERY entry the user has on
  // disk — both aniListCache (keyed by CR series ID; one entry per
  // CR show) and aniListBridgeCache (keyed by aniListId; intermediate
  // franchise nodes pulled in by enrichFranchiseBridges). Without
  // the bridge cache, multi-hop walks through intermediate seasons
  // not in the user's CR history (Slime S3 → S2 Part 2 → S2 → S1)
  // would still issue fresh fetches per hop — and a 429 anywhere
  // leaves the walk incomplete with description still per-season.
  const { aniListBridgeCache = {} } = await chrome.storage.local.get('aniListBridgeCache');
  const seedRootCache = new Map();
  for (const entry of Object.values(aniListCache)) {
    if (entry?.aniListId != null) seedRootCache.set(entry.aniListId, entry);
  }
  for (const entry of Object.values(aniListBridgeCache)) {
    if (entry?.aniListId != null && !seedRootCache.has(entry.aniListId)) {
      seedRootCache.set(entry.aniListId, entry);
    }
  }
  console.log(`[crsmart] root-walk seed: ${seedRootCache.size} cached entries available to walker`);
  let mediaById;
  try {
    mediaById = await bulkFetchByIds(ids, { seedRootCache });
  } catch (err) {
    console.warn('[crsmart] schema migration: bulkFetchByIds failed', err);
    return 0;
  }
  const migratedEntries = {};
  let migrated = 0;
  let dropped = 0;
  for (const { crId, aniListId, prev } of stale) {
    const fresh = mediaById[aniListId];
    if (!fresh) { dropped++; continue; }
    migratedEntries[crId] = {
      ...fresh,
      _matchConfidence: prev._matchConfidence ?? 'verified',
      _searchTitle: prev._searchTitle ?? null,
      _verifiedFromCount: prev._verifiedFromCount,
      // Keep the original fetchedAt so the 30-day TTL still gates the
      // expensive search-based path; only the projection got refreshed.
      fetchedAt: prev.fetchedAt ?? Date.now(),
    };
    migrated++;
  }
  // Only write the migrated entries — putBatch preserves un-migrated
  // entries in cache as-is. Cleared backoff state on migrated ones is
  // correct: we successfully re-fetched them.
  if (Object.keys(migratedEntries).length > 0) {
    await cache.putBatch('aniListCache', migratedEntries);
  }
  console.log(`[crsmart] anilist schema migration: ${migrated} migrated, ${dropped} dropped (no media returned)`);
  return migrated;
}

// Build the unique-series list from history items, then bulk-enrich any
// that aren't already in cache (or whose cache is older than 30 days).
// Persists incrementally — each completed series is written before the
// next request fires.
async function maybeEnrichAniList(profileId, historyItems) {
  if (enrichmentInFlight) {
    console.log('[crsmart] anilist: enrichment already running, skipping');
    return;
  }

  // Schema migration runs before stale-check so freshly-migrated entries
  // don't get re-enqueued for full search/verify on the same pass. If it
  // refreshed anything, kick off persistTasteVector so the studio-creator
  // index + downstream rec rerank pick up the new fields immediately
  // (without waiting for the next watch-shape refresh).
  try {
    const migrated = await migrateAniListCacheSchema();
    if (migrated > 0) {
      console.log('[crsmart] schema migration touched cache, recomputing taste vector');
      await persistTasteVector();
    }
  } catch (err) {
    console.warn('[crsmart] schema migration error', err);
  }

  const seenIds = new Set();
  const allSeries = [];
  for (const it of historyItems) {
    if (!it.seriesId || seenIds.has(it.seriesId)) continue;
    seenIds.add(it.seriesId);
    allSeries.push({
      seriesId: it.seriesId,
      title: it.seriesTitle,
      slug: it.seriesSlug,
    });
  }

  const now = Date.now();
  // Stale-id selection lives in cache-store now: it knows about TTL,
  // schema-version mismatch, exponential backoff (so transient errors
  // don't re-hammer AL), and permanent no-match (so AL-doesn't-have-it
  // skips skip every cycle). Replaces the prior pattern that treated
  // every '_matchConfidence === error' entry as stale (which caused
  // yesterday's 429 to drive today's 429s).
  const allIds = allSeries.map(s => s.seriesId);
  const staleSet = new Set(await cache.getStaleIds('aniListCache', allIds));
  const todo = allSeries.filter(s => staleSet.has(s.seriesId));

  console.log(`[crsmart] anilist: ${allSeries.length} unique series, ${todo.length} need enrichment`);

  await chrome.storage.local.set({
    aniListMeta: {
      profileId,
      startedAt: now,
      totalSeries: allSeries.length,
      totalCached: allSeries.length - todo.length,
      totalProcessed: 0,
      totalMatched: 0,
      inProgress: todo.length > 0,
    },
  });

  if (todo.length === 0) {
    console.log('[crsmart] anilist: all series fresh, nothing to do');
    // Recount matches from cache so the popup doesn't read 0/N — the
    // bulk-progress writer never gets a chance to set totalMatched here.
    const cacheSnapshot = await cache.getMany('aniListCache', allIds);
    const matchedFromCache = allSeries.filter(s => {
      const c = cacheSnapshot[s.seriesId];
      return c && (c._matchConfidence === 'verified'
                || c._matchConfidence === 'unverified-best-guess');
    }).length;
    await chrome.storage.local.set({
      aniListMeta: {
        profileId,
        startedAt: now,
        finishedAt: now,
        totalSeries: allSeries.length,
        totalCached: allSeries.length,
        totalProcessed: allSeries.length,
        totalMatched: matchedFromCache,
        inProgress: false,
      },
    });
    return;
  }

  enrichmentInFlight = true;
  let processed = 0;
  let matched = 0;

  // Surface initial enrichment progress so the popup bar appears
  // immediately, before the first item completes.
  await setAniListProgress({
    phase: 'history-enrich',
    label: 'Enriching watch history',
    current: 0,
    total: todo.length,
    startedAt: Date.now(),
  });

  try {
    await bulkEnrich(todo, async ({ done, total, current, result }) => {
      // Route through cache-store: success → put (clears any prior
      // backoff state); transient error → markError (exponential
      // backoff so we don't re-hammer); permanent miss → markNoMatch
      // (skip forever unless manually invalidated). Replaces the prior
      // read-merge-write dance + the 'error entries are stale' bug.
      if (result._matchConfidence === 'error') {
        await cache.markError('aniListCache', current.seriesId, result._error);
      } else if (result._matchConfidence === 'no-match'
              || result._matchConfidence === 'no-title') {
        await cache.markNoMatch('aniListCache', current.seriesId,
                                result._error || result._matchConfidence);
      } else {
        await cache.put('aniListCache', current.seriesId, result);
      }

      processed++;
      if (result._matchConfidence === 'verified' || result._matchConfidence === 'unverified-best-guess') {
        matched++;
      }

      // Throttle meta updates to every 5 items + final, otherwise the
      // popup re-renders ~once per second and we churn storage.
      if (done % 5 === 0 || done === total) {
        await chrome.storage.local.set({
          aniListMeta: {
            profileId,
            startedAt: now,
            totalSeries: allSeries.length,
            totalCached: allSeries.length - todo.length,
            totalProcessed: processed,
            totalMatched: matched + (allSeries.length - todo.length),
            inProgress: done < total,
          },
        });
        await setAniListProgress({
          phase: 'history-enrich',
          label: 'Enriching watch history',
          current: done,
          total,
          startedAt: Date.now(),
        });
      }

      if (done % 25 === 0 || done === total) {
        console.log(`[crsmart] anilist: ${done}/${total} (${result._matchConfidence}: ${current.title})`);
      }
    });
    console.log(`[crsmart] anilist enrichment complete: ${processed} processed, ${matched} matched`);
    // bulkEnrich's per-item writes go through cache.put / markError /
    // markNoMatch which schedule debounced flushes. Force-flush here
    // so downstream stages (taste-vector recompute, scoring) see every
    // entry without waiting for the debounce window.
    await cache.flush('aniListCache');
  } finally {
    enrichmentInFlight = false;
    await setAniListProgress(null);
    // Final flush in case the last batch landed on a non-multiple of 5
    await chrome.storage.local.set({
      aniListMeta: {
        profileId,
        startedAt: now,
        finishedAt: Date.now(),
        totalSeries: allSeries.length,
        totalCached: allSeries.length - todo.length,
        totalProcessed: processed,
        totalMatched: matched + (allSeries.length - todo.length),
        inProgress: false,
      },
    });
    // Fresh tags may have landed — recompute the blend so downstream sees
    // a taste vector that reflects the newly-enriched cache, not just the
    // subset that existed when persistWatchShapes last ran.
    try {
      await persistTasteVector();
    } catch (err) {
      console.warn('[crsmart] taste-vector post-enrich error', err);
    }
  }
}

// Defensive projection — handle snake_case (raw API) and camelCase (in case
// CR ever serves a normalized shape). The wrapper key is `panel` per CR's
// content/v2 conventions; episode-specific fields nest under episode_metadata.
function projectItem(raw) {
  const panel = raw.panel || raw;
  const meta = panel.episode_metadata || panel.episodeMetadata || {};
  return {
    episodeId:     panel.id || raw.id || null,
    seriesId:      meta.series_id || meta.seriesId || panel.parent_id || panel.parentId || null,
    seriesTitle:   meta.series_title || meta.seriesTitle || panel.parent_title || panel.parentTitle || null,
    seriesSlug:    meta.series_slug_title || meta.seriesSlugTitle || panel.parent_slug || panel.parentSlug || null,
    episodeTitle:  panel.title || null,
    episodeNumber: meta.episode_number != null ? meta.episode_number
                  : meta.episodeNumber != null ? meta.episodeNumber
                  : meta.episode != null ? meta.episode : null,
    seasonNumber:  meta.season_number != null ? meta.season_number
                  : meta.seasonNumber != null ? meta.seasonNumber
                  : meta.season_display_number != null ? Number(meta.season_display_number) || null
                  : null,
    seasonId:      meta.season_id || meta.seasonId || null,
    seasonTitle:   meta.season_title || meta.seasonTitle || null,
    episodeAirDate: meta.episode_air_date || meta.episodeAirDate || null,
    isDubbed:      meta.is_dubbed != null ? meta.is_dubbed
                  : meta.isDubbed != null ? meta.isDubbed : null,
    isSubbed:      meta.is_subbed != null ? meta.is_subbed
                  : meta.isSubbed != null ? meta.isSubbed : null,
    playhead:      raw.playhead != null ? raw.playhead : null,
    durationMs:    meta.duration_ms || meta.durationMs || panel.duration_ms || panel.durationMs || null,
    fullyWatched:  raw.fully_watched != null ? raw.fully_watched
                  : raw.fullyWatched != null ? raw.fullyWatched : null,
    neverWatched:  raw.never_watched != null ? raw.never_watched
                  : raw.neverWatched != null ? raw.neverWatched : null,
    lastWatchedAt: raw.date_played || raw.datePlayed || raw.last_played || raw.lastPlayed || null,
  };
}

// One-shot probe to surface raw watch-history fields the projector might
// be discarding — specifically anything that looks like a play counter
// (play_count, view_count, viewed_at[]). If CR exposes one, we can swap
// the temporal-anomaly rewatch heuristic for ground truth. Self-gates.
async function probeHistoryRawShape(profileId) {
  const { _historyProbeDone } = await chrome.storage.local.get('_historyProbeDone');
  if (_historyProbeDone) return;
  const url = `https://www.crunchyroll.com/content/v2/${profileId}/watch-history`
    + `?page=1&page_size=1&locale=en-US&preferred_audio_language=en-US`;
  const result = await crFetch(url, 'history probe');
  if (!result.ok) { console.warn('[crsmart] history probe failed', result.message); return; }
  const json = result.data;
  const item = json?.data?.[0];
  if (!item) { console.log('[crsmart] history probe — empty data'); return; }
  console.log('[crsmart] history probe — full item shape:', describeShape(item));
  console.log('[crsmart] history probe — unprojected fields:', unprojectedFields(item));
  await chrome.storage.local.set({ _historyProbeDone: { at: Date.now() } });
}

// Pull franchise-level episode counts from CR's own cms/objects bulk
// endpoint. CR's series_id groups all seasons under one record — so
// series_metadata.episode_count is the franchise total, which is what
// we actually want for completionRatio. AniList's per-season count was
// clamping multi-season watches (MHA 266/21) to 100%.
async function fetchCrSeriesMeta(seriesIds) {
  const ids = [...new Set(seriesIds)].filter(Boolean);
  const out = {};
  let crFieldsLogged = false;
  for (let i = 0; i < ids.length; i += CR_META_CHUNK) {
    const chunk = ids.slice(i, i + CR_META_CHUNK);
    const url = `https://www.crunchyroll.com/content/v2/cms/objects/${chunk.join(',')}`
      + `?ratings=true&preferred_audio_language=en-US&locale=en-US`;
    const result = await crFetch(url, `cr-meta chunk ${Math.floor(i / CR_META_CHUNK)}`);
    if (!result.ok) {
      console.warn('[crsmart] cr-meta failed', 'chunk', Math.floor(i / CR_META_CHUNK), result.message);
      continue;
    }
    const json = result.data;
    const data = Array.isArray(json.data) ? json.data : [];
    for (const item of data) {
      const id = item?.id;
      if (!id) continue;
      const sm = item.series_metadata || {};
      // First chunk surfaces the field shape so we know what CR is
      // actually returning (subset of fields varies by CR API revision).
      if (!crFieldsLogged && data.indexOf(item) === 0) {
        const tenantSample = sm.tenant_categories?.slice(0, 4);
        console.log('[crsmart] cr-meta field shape:', {
          smKeys: Object.keys(sm).sort(),
          tenant_categories_sample: tenantSample,
          has_keywords: 'keywords' in item || 'keywords' in sm,
        });
        crFieldsLogged = true;
      }
      // Capture episode/season counts (existing) PLUS the tag-like
      // fields CR exposes in series_metadata. These bridge into the
      // taste-vector pipeline as supplemental tags — AL's tagging is
      // honest but incomplete; CR's tenant_categories + keywords often
      // include tags AL is missing (e.g., MHA might be tagged "Heroic"
      // on CR but not on AL). Defensive: any field that doesn't exist
      // on this CR API revision becomes null and is skipped downstream.
      const count = sm.episode_count;
      const seasonCount = sm.season_count;
      if (typeof count === 'number') {
        // CR exposes a 1-5 star rating distribution under .rating when
        // ratings=true is on the query. Shape: { '1s': {percentage,
        // displayed, unit}, ..., '5s': {...}, average: '4.7', total: '12345' }.
        // We compute a 0-100 average from the distribution so it can be
        // compared directly against AniList's 0-100 averageScore.
        const crAvgScore = computeCrAvgFromRatingDistribution(item.rating);
        out[id] = {
          episodeCount: count,
          seasonCount: seasonCount ?? null,
          // CR's genre-like buckets (Action, Drama, Romance, Comedy,
          // etc.) — usually 1-3 per show, broader than AL tags.
          tenantCategories: Array.isArray(sm.tenant_categories)
            ? sm.tenant_categories.map(c => typeof c === 'string' ? c
                : (c?.tenant_category || c?.name || null)).filter(Boolean)
            : [],
          // CR's per-show keywords if exposed (tag-like, finer-grained).
          keywords: Array.isArray(item.keywords) ? item.keywords
            : (Array.isArray(sm.keywords) ? sm.keywords : []),
          // Audio/sub locale availability — useful for sub/dub
          // preference modeling later (also feeds future "is dub
          // available" badges).
          audioLocales: Array.isArray(sm.audio_locales) ? sm.audio_locales : [],
          subtitleLocales: Array.isArray(sm.subtitle_locales) ? sm.subtitle_locales : [],
          // Mature-content flags. Preserve for filter hooks; not used
          // in scoring directly.
          maturityRatings: Array.isArray(sm.maturity_ratings) ? sm.maturity_ratings : [],
          // CR community rating (Western audience) — drives the
          // "audiences disagree" chip when it diverges meaningfully
          // from AniList's averageScore (broader / Japan-leaning
          // audience). Stored as 0-100 to match AL's scale.
          crAverageScore: crAvgScore,
          crRatingTotal: parseInt(item.rating?.total || '0', 10) || 0,
        };
      }
    }

  }
  return out;
}

// Refresh CR-meta cache if older than STALE_MS or missing. Returns the
// current map (either freshly fetched or the existing cache).
// Pull the user's watchlist (saved-but-not-watched + bookmarks) and
// store it as a Set-shaped object keyed by seriesId. Lightweight — one
// request with n=200 covers nearly any user (CR's UI caps at 200 items).
//
// Response shape per CR's discover convention:
//   { data: [{ panel: { id, title, parent_id?, ... }, ... }, ...], total }
// where panel.id is the series ID for series-typed watchlist entries.
// We probe the first item once per profile to confirm the shape and
// log unprojected fields the same way watch-history does — saves a
// future-us debug trip.
async function fetchAndPersistWatchlist(profileId) {
  const url = `https://www.crunchyroll.com/content/v2/discover/${profileId}/watchlist`
    + `?order=desc&n=200&locale=en-US`;
  const result = await crFetch(url, 'watchlist');
  if (!result.ok) {
    if (result.kind === 'auth' && result.status === 401) {
      console.warn('[crsmart] watchlist 401 — token stale');
    } else {
      console.warn('[crsmart] watchlist failed', result.message);
    }
    return null;
  }
  const json = result.data;
  const data = Array.isArray(json.data) ? json.data : [];

  // One-shot schema probe so we catch any shape drift in the future.
  const { _watchlistShapeDone } = await chrome.storage.local.get('_watchlistShapeDone');
  if (!_watchlistShapeDone && data[0]) {
    console.log('[crsmart] watchlist schema diag (first item):', describeShape(data[0]));
    await chrome.storage.local.set({ _watchlistShapeDone: true });
  }

  // Project each item to { seriesId, addedAt, fullyWatched, isFavorite }.
  // CR's watchlist row has the panel + a sibling object with metadata
  // about the saved state — we surface enough to drive UI annotations.
  const items = [];
  for (const raw of data) {
    const panel = raw.panel || raw;
    // For series watchlist entries the id IS the series id; for episode
    // entries (rare on watchlist but possible) parent_id is the series.
    const seriesId = panel.id || panel.parent_id || panel.parentId || null;
    if (!seriesId) continue;
    items.push({
      seriesId,
      title: panel.title || raw.title || null,
      addedAt: raw.date_added || raw.dateAdded || null,
      fullyWatched: raw.fully_watched === true || raw.fullyWatched === true,
      isFavorite: raw.is_favorite === true || raw.isFavorite === true,
      neverWatched: raw.never_watched === true || raw.neverWatched === true,
    });
  }

  await chrome.storage.local.set({
    crWatchlist: {
      profileId,
      fetchedAt: Date.now(),
      total: typeof json.total === 'number' ? json.total : items.length,
      items,
      // Set-shaped lookup for fast O(1) checks downstream — content.js
      // can ask "is this seriesId in the watchlist" without scanning
      // the full array on every card render.
      seriesIdSet: items.reduce((acc, it) => { acc[it.seriesId] = true; return acc; }, {}),
    },
  });
  console.log(`[crsmart] watchlist: ${items.length} entries saved`);
  return items;
}

// Pull CR's own personalized recommendations. CR computes these on
// their backend via collaborative filtering — what users-similar-to-you
// have watched and rated highly. Different signal class from our
// taste-vector (content-based, tag-similarity) so it catches matches
// pure tag overlap can miss.
//
// Position in the response IS the rank — earlier means CR thinks it's
// a better match. We store both seriesId and rank so downstream can
// scale the boost (top of the list contributes more than bottom).
//
// Endpoint shape: { data: [{ panel: { id, ... }, ... }, ...], total }
// Same projection pattern as watchlist.
async function fetchAndPersistCrPersonalRecs(profileId) {
  const url = `https://www.crunchyroll.com/content/v2/discover/${profileId}/recommendations`
    + `?n=100&locale=en-US`;
  const result = await crFetch(url, 'cr-personal-recs');
  if (!result.ok) {
    if (result.kind === 'auth' && result.status === 401) {
      console.warn('[crsmart] cr-personal-recs 401 — token stale');
    } else {
      console.warn('[crsmart] cr-personal-recs failed', result.message);
    }
    return null;
  }
  const json = result.data;
  const data = Array.isArray(json.data) ? json.data : [];

  const { _crPersonalRecsShapeDone } = await chrome.storage.local.get('_crPersonalRecsShapeDone');
  if (!_crPersonalRecsShapeDone && data[0]) {
    console.log('[crsmart] cr-personal-recs schema diag (first item):', describeShape(data[0]));
    await chrome.storage.local.set({ _crPersonalRecsShapeDone: true });
  }

  const items = [];
  const rankBySeries = {};
  for (let i = 0; i < data.length; i++) {
    const raw = data[i];
    const panel = raw.panel || raw;
    const seriesId = panel.id || panel.parent_id || panel.parentId || null;
    if (!seriesId || rankBySeries[seriesId] != null) continue; // first occurrence wins
    items.push({
      seriesId,
      rank: i + 1,
      title: panel.title || raw.title || null,
    });
    rankBySeries[seriesId] = i + 1;
  }

  await chrome.storage.local.set({
    crPersonalRecs: {
      profileId,
      fetchedAt: Date.now(),
      total: items.length,
      items,
      rankBySeries,
    },
  });
  console.log(`[crsmart] cr-personal-recs: ${items.length} CF recommendations stored`);
  return items;
}

async function ensureCrSeriesMeta(seriesIdSet) {
  const ids = [...seriesIdSet].filter(Boolean);
  // Per-entry staleness via cache-store: only re-fetch what's
  // actually stale, instead of invalidating the whole cache on a
  // single global timestamp. Today's series get refetched; last
  // week's franchise stays cached.
  const staleIds = await cache.getStaleIds('crSeriesMeta', ids);
  if (staleIds.length === 0) {
    return await cache.getMany('crSeriesMeta', ids);
  }
  const meta = await fetchCrSeriesMeta(staleIds);
  if (Object.keys(meta).length > 0) {
    await cache.putBatch('crSeriesMeta', meta);
  }
  console.log(`[crsmart] cr-meta: fetched ${Object.keys(meta).length} of `
    + `${staleIds.length} stale franchise episode counts`);
  return await cache.getMany('crSeriesMeta', ids);
}

// Compute behavior labels (completed/dropped/in-progress + per-episode
// rewatch flags) from cached history items, persist under chrome.storage.
// Prefers CR's franchise-level episode_count; falls back to AniList's
// per-season count when CR didn't return one.
async function persistWatchShapes(items) {
  const { aniListCache = {}, crSeriesMeta = {} } = await chrome.storage.local.get(
    ['aniListCache', 'crSeriesMeta']);
  const episodeCounts = {};
  for (const it of items) {
    const id = it.seriesId;
    if (!id || episodeCounts[id] != null) continue;
    const crCount = crSeriesMeta[id]?.episodeCount;
    const alCount = aniListCache[id]?.episodes;
    if (typeof crCount === 'number' && crCount > 0) episodeCounts[id] = crCount;
    else if (typeof alCount === 'number' && alCount > 0) episodeCounts[id] = alCount;
  }
  const shapes = deriveWatchShapes(items, episodeCounts);
  await chrome.storage.local.set({ watchShapes: shapes });
  const s = shapes.summary;
  console.log(`[crsmart] watch-shapes: ${s.completed} completed · ${s.inProgress} in-progress · ${s.paused} paused · ${s.droppedEarly + s.droppedMid} dropped · ${s.sampled} sampled · ${s.seriesWithRewatches} rewatched (${s.rewatchedEpisodeCount} eps)`);
  // Graduate the user out of cold-start the first time CR returns
  // any watch-shape — this is the "Just browse" path's progress signal.
  // Subsequent calls are idempotent on welcomeCompletedAt (only the
  // first one moves the timestamp).
  if ((s.completed + s.inProgress + s.sampled + s.paused + s.droppedEarly + s.droppedMid) > 0) {
    markWelcomeProgress('cr-history');
  }
  // Recompute taste vector on every shape refresh. Cheap (<300 series × ~15
  // tags each) and stays in lockstep with watchShapes so downstream never
  // sees a stale blend.
  await persistTasteVector(shapes);
}

// Aggregate watch-shapes + AniList tags into a single tag-weighted vector
// representing what the user actually enjoys. Runs after every shape
// refresh and again when enrichment lands a new batch of tags.
//
// Signal-aware stage skip (applies #1's payoff before the full pipeline
// runner adoption lands):
//
//   options.signal — when 'rating', skip stages that don't materially
//     change in response to a rating click:
//       - recomputeQualityAxes (depends on aniListCache only — community
//         averageScore + studio craft prior; rating-invariant)
//       - persistDualModeRecommendations (rec pool — sentiment shifts
//         from a single rating barely move rec ordering; refreshes on
//         next non-rating recompute anyway)
//     Saves ~1.6s per rating click. User-visible: rated show's score
//     updates within ~1.4s instead of ~3s. Tradeoff: rec pool stays
//     up to one recompute cycle stale relative to the latest rating —
//     accuracy preserved on the rated show itself, marginal staleness
//     on rec-list ordering until the next history sync / reaction /
//     survey-tap fires the full pipeline.
async function persistTasteVector(watchShapesArg, options = {}) {
  const signal = options.signal || null;
  const skipRecPool = signal === 'rating';
  const skipQualityAxes = signal === 'rating';
  // Storage write buffer: persistTasteVector previously did ~6 separate
  // chrome.storage.local.set() calls in sequence, each ~50ms IPC. Batch
  // them into one flush before computeAllShowsScored runs (since that
  // function reads studioCreatorIndex from storage and needs the fresh
  // value). Saves ~250ms on every recompute.
  const pendingWrites = {};
  // Per-stage timing instrumentation so we can see where rating-click
  // recompute time actually goes. Logs as a single line at the end.
  // Keyed by stage name; values are ms elapsed.
  const stageTimings = {};
  const stage = (name, fn) => {
    const t0 = performance.now();
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(r => { stageTimings[name] = +(performance.now() - t0).toFixed(1); return r; });
    }
    stageTimings[name] = +(performance.now() - t0).toFixed(1);
    return result;
  };
  const persistT0 = performance.now();
  // Single typed read of every input the recompute pipeline needs.
  // The watchShapes argument override (passed by the post-derive
  // path) wins when present — saves a re-read after the worker
  // just computed fresh shapes.
  const inputs = await stage('getRecomputeInputs', () => getRecomputeInputs());
  const {
    aniListCache,
    crSeriesMeta,
    surveyShapes,
    surveyTagShapes,
    bridgeCache,
    userRatings,
    userReactions,
    externalScores,
    crWatchlist,
  } = inputs;
  let watchShapes = watchShapesArg ?? inputs.watchShapes;
  // Per-series watchlist map keyed by crSeriesId so series-sentiment
  // can look up "is this on the user's CR watchlist / favorited?" in
  // O(1) during the per-series compute. Same shape used by
  // computeAllShowsScored.
  const watchlistBySeries = {};
  for (const it of (crWatchlist?.items || [])) {
    if (it.seriesId) watchlistBySeries[it.seriesId] = it;
  }

  // Augment cache with CR's tag-like fields, then synthesize the
  // Quick Taste Check contributions. Both are pure helpers in
  // taste-pipeline.js — orchestration here, mechanics there.
  const augmentedCache = stage('augmentCache', () => augmentCacheWithCrTags(aniListCache, crSeriesMeta));
  const synth = stage('synthesizeSurvey', () => synthesizeSurveyContributions({
    watchShapes,
    surveyShapes,
    surveyTagShapes,
    aniListCache,
    augmentedCache,
    bridgeCache,
  }));
  if (!synth) return; // no real history AND no survey signals
  const { surveyTagBoosts, applyState } = synth;
  let { effectiveWatchShapes, effectiveCache } = synth;
  if (applyState.foldedShows > 0) {
    console.log(`[crsmart] taste-vector: folded ${applyState.foldedShows} survey shapes`
      + ` (skipped ${applyState.skippedRealWatch} real-watch precedent,`
      + ` ${applyState.skippedNoMedia} no-media)`);
  }
  if (applyState.foldedTags > 0) {
    console.log(`[crsmart] taste-vector: folded ${applyState.foldedTags} tag-taps via surveyTagBoosts`);
  }

  // Persist apply-state for the survey UI. Summary screen reads
  // .skippedNoMedia to warn the user that some taps haven't folded
  // yet; the bridge-cache change listener reads .skippedNoMediaIds
  // to decide whether a freshly-cached AL ID warrants a retry.
  pendingWrites.surveyApplyState = applyState;

  // Fold AL/MAL imported list-status into watchShapes for shows the
  // user has rated externally but never started on CR. Without this,
  // an aniListId in externalScores with no matching CR shape is
  // "stranded" — the engine's per-series loop never visits it. See
  // synthesizeExternalShapes for the shape-mapping rules.
  const extSynth = stage('synthesizeExternal', () => synthesizeExternalShapes({
    baseWatchShapes: effectiveWatchShapes,
    augmentedCache: effectiveCache,
    externalScores,
    bridgeCache,
  }));
  effectiveWatchShapes = extSynth.effectiveWatchShapes;
  effectiveCache = extSynth.effectiveCache;
  if (extSynth.applyState.foldedShows > 0) {
    const a = extSynth.applyState;
    console.log(`[crsmart] taste-vector: folded ${a.foldedShows} external shapes`
      + ` (skipped ${a.skippedExisting} existing, ${a.skippedNoMedia} no-media,`
      + ` ${a.skippedNoStatus} no-status, ${a.skippedNonEngaging} non-engaging)`);
  }

  // Stage 1d-c B: compute three vectors. 'all' is kept for backward
  // compat + diagnostics (archetype blend, calibration). 'peak' and
  // 'comfort' are the user-facing modes the popup will toggle between.
  // computeAllTasteVectors handles the shared mode-independent prep.
  const { vectorAll, vectorPeak, vectorComfort } = stage('computeTasteVectors', () => computeAllTasteVectors({
    effectiveWatchShapes,
    effectiveCache,
    surveyTagBoosts,
    surveyTagShapes,  // raw map for the floor/ceiling override
    userRatings,
    userReactions,
    watchlistBySeries,
    externalScores,
    // On rating signal, build only vectorAll. peak/comfort feed the
    // rec pipeline which is skipped — building them would waste ~150ms.
    modes: skipRecPool ? ['all'] : ['all', 'peak', 'comfort'],
  }));
  // On rating signal, only vectorAll was built; preserve previously-
  // persisted peak/comfort vectors so the next non-rating recompute
  // can read them (or rebuild from scratch — either is fine).
  pendingWrites.tasteVector = vectorAll;
  if (vectorPeak) pendingWrites.tasteVectorPeak = vectorPeak;
  if (vectorComfort) pendingWrites.tasteVectorComfort = vectorComfort;
  console.log(`[crsmart] taste-vector [all]: ${vectorAll.summary.contributingSeries}/`
    + `${vectorAll.summary.totalSeriesWithShape} series, ${vectorAll.summary.uniqueTags} tags`);
  if (vectorPeak) {
    console.log(`[crsmart] taste-vector [peak]: ${vectorPeak.summary.contributingSeries}/`
      + `${vectorPeak.summary.totalSeriesWithShape} series, ${vectorPeak.summary.uniqueTags} tags`);
    console.log('[crsmart] taste-vector [peak] top 10:', vectorPeak.top.slice(0, 10));
  }
  if (vectorComfort) {
    console.log(`[crsmart] taste-vector [comfort]: ${vectorComfort.summary.contributingSeries}/`
      + `${vectorComfort.summary.totalSeriesWithShape} series, ${vectorComfort.summary.uniqueTags} tags`);
    console.log('[crsmart] taste-vector [comfort] top 10:', vectorComfort.top.slice(0, 10));
  }

  // Archetype blend piggybacks on the same refresh — cheap and keeps the
  // two structures in lockstep, so downstream never reads one that's
  // older than the other. Uses 'all' vector (diagnostic, not user-facing).
  const blend = stage('scoreArchetypes', () => scoreArchetypes(vectorAll));
  const dimensions = stage('scoreDimensions', () => scoreDimensions(vectorAll));
  pendingWrites.archetypeBlend = { archetypes: blend, computedAt: Date.now() };
  pendingWrites.tasteDimensions = { dimensions, computedAt: Date.now() };

  // G09: Taste Shape radar — 8 viewing-psychology axes derived from
  // tag mass. Pure derivation, runs alongside the existing archetype
  // blend computation. Persisted under 'tasteShapeRadar' for future
  // side-panel Shape view (G10) to render. Cheap (~1ms; pure
  // sums over the user's tag map) so no need for opt-out.
  // Signal-bearing series count = completed + in-progress. Dropped &
  // sampled don't carry enough taste signal to count toward
  // calibration confidence. Feeds 'cold'/'thin'/'calibrated' on the
  // radar; sidepanel surfaces 'thin' as a "still calibrating" pill.
  const summary = watchShapes?.summary || {};
  const signalSeriesCount = (summary.completed || 0) + (summary.inProgress || 0);
  const radar = stage('radarDerive', () => deriveRadar(vectorAll, { signalSeriesCount }));
  if (radar) {
    // shapeIdentityFor returns name + family + resolved family/archetype
    // HSL colors so the side panel can theme without re-running the
    // lookup. Family is one of 8 thematic palettes (Drama / Romance /
    // Comfort / Spectacle / Auteur / Comedy / Mystery / Mixed); brand
    // orange is preserved as Mixed for users without strong patterns.
    const identity = shapeIdentityFor(radar);
    pendingWrites.tasteShapeRadar = {
      ...radar,
      proseSummary: proseFor(radar),
      shapeName: identity?.name || 'Mixed Taste',
      // Tagline = top-3 axis adjective forms joined.
      // E.g., 'character-deep, drama-heavy, mainstream taste'.
      // Sits as byline under shape name on the identity surface.
      tagline: taglineFor(radar),
      // Family palette identity — 2026-05-03 grilling. Used by side
      // panel to set CSS custom properties on the shape surface.
      family: identity?.family || 'mixed',
      familyName: identity?.familyName || 'Mixed',
      familyBaseHsl: identity?.familyBaseHsl,
      archetypeHsl: identity?.archetypeHsl,
      isSignature: !!identity?.isSignature,
      // Phase 1 visual encoding (2026-05): vertex glyph + polygon line
      // treatment let the side panel differentiate archetypes within a
      // family without leaning on hue offset alone. See radar-derive.js
      // resolveArchetypeVisual for the curated/algorithmic mapping.
      glyph: identity?.glyph || 'circle',
      lineTreatment: identity?.lineTreatment || 'solid',
    };
    const top3 = topAxes(radar, 3).map(a => `${a.name}: ${a.value}`).join(' · ');
    const a = identity?.archetypeHsl;
    console.log(`[crsmart] taste shape radar — "${pendingWrites.tasteShapeRadar.shapeName}" `
      + `[${identity?.familyName}${identity?.isSignature ? ' ★' : ''}] `
      + `hsl(${a?.h}, ${a?.s}%, ${a?.l}%) · (${radar.confidenceLevel}) `
      + `· tagline: "${pendingWrites.tasteShapeRadar.tagline}" · top 3: ${top3}`);
  }
  console.log('[crsmart] archetype blend [all]:',
    blend.map(a => `${a.name}: ${a.score} (cov ${a.coverage})`).join(' · '));
  // Dimensions: log top (leans toward) and bottom (leans away) so we
  // can see both signals at a glance. Mid-rank dimensions are noisy
  // anyway and don't belong in a top-line summary.
  // Rank by |score| × magnitude so thin-evidence strong-score dimensions
  // (e.g. one anti-tag in a small bundle flips score to -1 with magnitude
  // 0.3) don't outrank genuine leans with broad tag support. Keeps the
  // top-line summary honest to where the user's mass actually lives.
  const sig = d => Math.abs(d.score) * d.magnitude;
  // Split visible (tone/theme) from hidden (character-archetype) — the
  // hidden ones inform dealbreaker surfacing but don't belong in the
  // user-facing blend.
  const visibleDims = dimensions.filter(d => !d.hiddenInBlend);
  const topVisible = visibleDims
    .filter(d => d.score > 0)
    .sort((a, b) => sig(b) - sig(a))
    .slice(0, 8);
  const bottomVisible = visibleDims
    .filter(d => d.score < 0)
    .sort((a, b) => sig(b) - sig(a))
    .slice(0, 5);
  const fmt = d => `${d.name}: ${d.score} [mag ${d.magnitude}]`;
  console.log('[crsmart] dimensions — leans toward:', topVisible.map(fmt).join(' · '));
  if (bottomVisible.length) {
    console.log('[crsmart] dimensions — leans away:', bottomVisible.map(fmt).join(' · '));
  }
  // Hidden character-archetype dimensions — logged but not surfaced in
  // the popup's visible blend. Shows which ones have any signal at all
  // so we can spot tag-name misses early.
  const hiddenDims = dimensions.filter(d => d.hiddenInBlend && d.magnitude > 0);
  if (hiddenDims.length) {
    console.log('[crsmart] character-archetype dims:',
      hiddenDims.sort((a, b) => sig(b) - sig(a)).map(fmt).join(' · '));
  }
  // Naming-miss diagnostic: any dimension that didn't match a single
  // user tag. Either the user's corpus doesn't touch that axis, or the
  // bundle's tag names don't match AniList's canonical forms. Logs
  // each dim with its attempted tag names so we can diff against the
  // canonical tag dump instead of guessing which it is.
  const zeroMag = dimensionsWithZeroMagnitude(dimensions);
  if (zeroMag.length) {
    console.log('[crsmart] dimensions — zero magnitude:',
      zeroMag.map(z => `${z.name} [tried: ${z.tags.join(', ')}]`).join(' · '));
  }
  // Dealbreaker candidates — strongly-negative hidden dimensions with
  // enough magnitude to trust the signal. These DON'T auto-apply; the
  // popup surfaces them as suggestions, the user toggles.
  const candidates = dealbreakerCandidates(dimensions);
  if (candidates.length) {
    console.log('[crsmart] dealbreaker candidates:',
      candidates.map(fmt).join(' · '));
  }
  pendingWrites.dealbreakerCandidates = { candidates, computedAt: Date.now() };
  // Surface the vector's explicit anti-tags — individual tags the user
  // avoids, independent of dimensions. Gives UI a direct list to say
  // "you tend to skip X" without reducing to an axis score.
  if (vectorAll.bottom?.length) {
    console.log('[crsmart] anti-tags (top 8):',
      vectorAll.bottom.slice(0, 8).map(t => `${t.tag}: ${t.weight}`).join(' · '));
  }

  // One-shot canonical-tag dump so we can diff archetype bundles against
  // AniList's real tag names. Logs every tag in the user's vector
  // alphabetically. Gated: deletes key + re-runs when bundles change.
  // Tag-name dump gate is bumped each time dimension bundles change so
  // the canonical list re-logs whenever we're tuning tag names. Keyed
  // to a short version string — bump when bundle edits land.
  const TAG_DUMP_VERSION = 'v2-dim35';
  const { _tagNameDumpDone } = await chrome.storage.local.get('_tagNameDumpDone');
  if (_tagNameDumpDone?.version !== TAG_DUMP_VERSION) {
    const names = Object.keys(vectorAll.raw).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }));
    console.log(`[crsmart] tag-name dump (${names.length} unique):`, names);
    pendingWrites._tagNameDumpDone = { at: Date.now(), version: TAG_DUMP_VERSION };
  }

  // Studio + creator affinity index, derived from the same watchShapes ×
  // aniListCache and the same series-sentiment seam taste-vector reads
  // from. Both indexes now share one source of truth for "how does the
  // user feel about each series?" — drift is no longer possible.
  const studioCreator = stage('studioCreator', () => computeStudioCreatorIndex(watchShapes, aniListCache, {
    userRatings,
    userReactions,
    watchlistBySeries,
    externalScores,
  }));
  pendingWrites.studioCreatorIndex = { ...studioCreator, computedAt: Date.now() };

  // Flush all buffered writes in one IPC call. After this point,
  // computeAllShowsScored can read the freshly-persisted
  // studioCreatorIndex from storage.
  await stage('flushBatch', () => chrome.storage.local.set(pendingWrites));
  const studioCount = Object.keys(studioCreator.studios).length;
  const creatorCount = Object.keys(studioCreator.creators).length;
  const topStudios = (studioCreator.topStudios || [])
    .slice(0, 5)
    .map(id => studioCreator.studios[id])
    .filter(Boolean)
    .map(s => `${s.name} (w=${s.totalWeight}, n=${s.count}, loved=${s.lovedCount})`);
  console.log(`[crsmart] studio-creator index: ${studioCount} studios, ${creatorCount} creators`);
  console.log('[crsmart] studio-creator top studios:', topStudios);

  // Per-show calibration on 'all' vector — diagnostic only, doesn't
  // cascade into recommendations anymore (those run per mode below).
  // watchHistoryScored is a calibration diagnostic — feeds the popup's
  // "show me the math" panel, no real-time card surface. Skipping on
  // rating signal saves ~330ms; it'll refresh on the next non-rating
  // recompute (history sync, reaction, survey-tap). Worst case the
  // diagnostic is one rating click stale when the user opens the popup,
  // which is rare relative to rating clicks.
  if (signal !== 'rating') {
    await stage('watchHistoryScored', () => persistWatchHistoryScored(watchShapes, vectorAll));
  }

  // Phase 4: quality axes. Annotate each cache entry with craftPrior /
  // consensusQuality / adaptationRisk before rec ranking so downstream
  // consumers (rec-rerank, card pitch) have them available. Derived
  // from existing cache fields only — no external sources in v1.
  // Skipped on rating signal (rating-invariant; saves ~80ms).
  if (!skipQualityAxes) await stage('qualityAxes', () => recomputeQualityAxes());

  // Order matters: computeAllShowsScored runs FIRST because it builds
  // and persists the cache-wide tasteScorePercentileMapper that
  // persistDualModeRecommendations needs for cross-surface tasteN
  // consistency. Without this ordering, the rec pipeline falls back
  // to in-pool min-max and the side panel disagrees with the on-page
  // card on the same show's tasteN.
  // Pass prefetched heavy inputs that persistTasteVector already loaded
  // via getRecomputeInputs. Saves ~300ms of redundant aniListCache
  // deserialization inside computeAllShowsScored.
  //
  // CF re-ranker — build cfApply ONCE at the orchestrator level so the
  // 5-source signal aggregation + ALS fold-in (~50ms) happens a single
  // time per recompute, regardless of how many child stages need it.
  // Both computeAllShowsScored (Candidate 2: attach per-entry) and
  // persistDualModeRecommendations (Candidate 1: dedup of its two
  // legacy + new-lens internal calls) consume the same closure.
  const cfApply = await buildCFApply();
  await stage('allShowsScored', () => computeAllShowsScored(vectorAll, {
    signal,
    cfApply,
    prefetched: {
      aniListCache,
      bridgeCache,
      watchShapes,
      crSeriesMeta,
      userReactions,
      userRatings,
    },
  }));

  // Recommendation pipeline runs once but scores per mode against a
  // shared Media fetch — peak and comfort top-60 are unioned, fetched
  // together, then ranked twice with their respective taste vectors.
  // Reads tasteScorePercentileMapper that computeAllShowsScored just
  // wrote, so rec-pool tasteN agrees with off-pool tasteN.
  // Skipped on rating signal (saves ~1.5s; rec pool refreshes on next
  // non-rating recompute — history sync, reaction, survey-tap, etc.).
  if (!skipRecPool) await stage('dualModeRecs', () => persistDualModeRecommendations(watchShapes, vectorPeak, vectorComfort, { cfApply }));

  // Dump per-stage timings — invaluable for diagnosing where the
  // recompute spends its time. Per-signal so we can compare rating-
  // click cost vs full-recompute cost.
  const totalMs = +(performance.now() - persistT0).toFixed(1);
  const breakdown = Object.entries(stageTimings)
    .sort((a, b) => b[1] - a[1])
    .map(([name, ms]) => `${name}=${ms}ms`)
    .join(' · ');
  console.log(`[crsmart] persistTasteVector signal=${signal || 'full'} total=${totalMs}ms · ${breakdown}`);
  // Capture for snapshot's `health` section. Async, fire-and-forget;
  // if it fails the snapshot just shows null health which is fine.
  recordEngineHealth({
    lastRecomputeAt: new Date().toISOString(),
    lastRecomputeSignal: signal || 'full',
    lastRecomputeMs: totalMs,
    stageTimings,
    schemaVersion: ALL_SHOWS_SCORED_SCHEMA,
  });
}

// Score every aniListCache entry using scoreShow + tasteVector, plus
// quality axes. Unlike rankRecommendations (which normalizes across
// a rec-pool candidate set), this scores each show in absolute terms
// against the cache's OWN distribution — off-pool shows can't
// normalize against a pool they're not in. Cheap: ~300 shows × one
// dot-product each, sub-100ms.
// Schema version stamped on allShowsScored so we can detect stale caches
// and force a recompute when scoring formulas change. Bump whenever the
// off-pool scoring path mutates: new boost, new sub-score, new weight,
// new cache field shape. Without this, formula changes only take effect
// on next history sync (could be days), and the existing allShowsScored
// silently uses old math.
//
// History:
//   v1 — initial stamping (post-shipping reaction overlay + verified-favorite)
//   v2 — added confidence + audienceDelta + crAverageScore per entry
//   v3 — added tasteNInLane + primaryArchetype per entry (#4 lane-rel)
//   v4 — drop-attribution discriminative weighting in taste vector (#6)
//   v5 — archetype space expanded 8→18 (cgdct, sports, mecha, horror,
//        mahou-shoujo, mind-game-thriller, hard-scifi, battle-seinen,
//        xianxia, josei); cached archetypeBreakdown + showArchetypeFit
//        are missing dimensions and must be recomputed
// Bumped 12 → 13 for G01/G02 (edge-anchored hybrid calibration).
// Bumped 13 → 14 for G02-followup: bottomFloor=0.10 (display 1.0).
// Bumped 14 → 15 for G05: rating overrides as clamps.
// Bumped 15 → 16 for G03: rec-list diversification.
// Bumped 16 → 17 for G07: franchise-aware adaptationRisk override
// (Mob Psycho 100 III no longer fires RUSHED SHAPE on a 12-eps season
// when the franchise has 36+ eps total).
// Bumped 17 → 18 for G06: IDF clamp [0.5, 5.0] on taste-vector tag
// weights (tames runaway rare-tag emphasis).
// Bumped 18 → 19 for G09 part 1: taste shape radar derivation.
// Bumped 19 → 20 for G11: per-axis contributingTags in radar output.
// Bumped 20 → 21 for G12: per-archetype completion-rate-aware drop.
// Bumped 21 → 22 for G13-deep + 5 new lenses.
// Bumped 22 → 23 for G11-deep: per-axis contributingShows.
// Bumped 23 → 24 for the CR-availability fix-pack: side panel hard-
// filters non-CR shows, every entry now persists crSiteUrl, and
// per-show scoring handles rank-null tags via genre-only fallback.
// Forces recompute so existing allShowsScored entries get crSiteUrl
// + recommendationsScored gets re-ranked with the CR filter.
// Bumped 24 → 25 for the Taste Shape palette pass: tasteShapeRadar
// now carries family + familyBaseHsl + archetypeHsl + isSignature.
// SHAPE_NAMES expanded from 15 to 32 archetypes across 8 thematic
// family palettes. Schema bump forces a recompute so existing radars
// get the new fields and the side panel can theme by family.
// Bumped 25 → 26 for the External score synthesis pass: imported
// AL/MAL entries with completed/dropped status that don't have a
// matching CR watch-shape now synthesize a watch-shape entry so the
// engine's per-series loop folds them in. Affects taste vectors,
// archetype blends, studio-creator index, and downstream scoring.
// Bumped 26 → 27 for AL data-utilization audit fixes (2026-05-04):
// synthesized external shapes now compute monthsSinceLastPlay from
// the imported updatedAt timestamp (was hardcoded 0 — every imported
// entry got full recency weight regardless of age). Schema bump
// forces a recompute so existing imports pick up time-decayed weights.
// (REPEATING → completed status mapping in anilist.js takes effect
// on the next AL import, not on existing externalScores data —
// re-import to flip rewatched entries.)
// Bumped 27 → 28 for SHAPE_NAMES expansion (2026-05-04): added 8
// archetypes (Tournament Devotee + Curious Romantic + Comfort Curio
// signatures; Pure Action Viewer + Wholesome Romance Reader anchored
// 2-axis; Hard Sci-Fi Watcher + Indie Cast Devotee + Period Romance
// Reader 2-axis pures). New 3-axis signatures match earlier in the
// priority ladder, so existing users whose top-3 hits one of them
// will see their displayed archetype shift on next recompute. The
// tasteShapeRadar output (name + family + palette HSL) updates;
// the underlying axis values are unchanged.
const ALL_SHOWS_SCORED_SCHEMA = 28;

// computeConfidence moved to all-shows-scoring.js (its only caller).

// applyOverlayLocal removed — both the rec-pool path
// (rank-recommendations.js) and the off-pool path
// (computeAllShowsScored) now go through composeFeedback in
// feedback-overlay.js, so the symmetry the previous comment
// promised is enforced by sharing one implementation instead of
// two near-duplicates.


// Thin IO orchestrator around scoreAllShowsImpl. Loads inputs (incl.
// the previous-run franchise cache on rating signal), calls the pure
// compute body, then persists + broadcasts. The IO/compute seam means
// scoreAllShowsImpl can be exercised from outside the worker without
// chrome.storage mocking.
async function computeAllShowsScored(tasteVector, options = {}) {
  if (!tasteVector) return;
  // Prefetched inputs from persistTasteVector — avoids re-deserializing
  // aniListCache (~2MB → ~300ms) when the orchestrator already loaded
  // it. Pass-through to getOffPoolScoringInputs.
  const prefetched = options.prefetched || {};
  // On rating signal, franchise data is rating-invariant (derived
  // from AniList relations only). Loading the previous run's
  // allShowsScored lets us reuse each entry's franchise field instead
  // of calling buildFranchise ~600 times. Per timing instrumentation
  // this is the dominant cost — saves ~800-1000ms per rating click.
  const reuseFranchiseFromPrevious = options.signal === 'rating';
  let previousByAniListId = null;
  if (reuseFranchiseFromPrevious) {
    const { allShowsScored: prev } = await chrome.storage.local.get('allShowsScored');
    if (prev) {
      previousByAniListId = {};
      for (const e of Object.values(prev)) {
        if (e?.aniListId != null) previousByAniListId[e.aniListId] = e;
      }
    }
  }
  // One typed read for every input this pass needs — replaces the
  // 7-key chrome.storage.local.get with a named accessor that the
  // schema layer owns.
  const inputs = await getOffPoolScoringInputs(prefetched);

  const result = scoreAllShowsImpl({
    inputs,
    tasteVector,
    previousByAniListId,
    cfApply: options.cfApply,
  });
  if (!result) return;

  const {
    allShowsScored,
    tastePercentileMapper,
    finalScoreMapper,
    dataQualityIssues,
    reactionOverlayTagCount,
    overlayHasSignal,
    entryCount,
    innerTimings,
    innerT0,
  } = result;
  const { userRatings, userReactions, watchShapes } = inputs;

  const _persistT0 = performance.now();
  // Tag-burnout index — computed alongside allShowsScored persistence
  // because it reads from the just-finalized scored entries (with
  // their userWatchShape, topTags, calibrated finalScore). Picks up
  // userRatings + userReactions from the closure scope. Pure function;
  // skip if there's nothing useful (cold-start with empty allShowsScored).
  const tagBurnoutIndex = Object.keys(allShowsScored).length > 0
    ? computeTagBurnoutIndex({
        allShowsScored,
        ratings: userRatings || {},
        reactions: userReactions || {},
        watchShapes,
      })
    : {};
  const burnoutTagCount = Object.keys(tagBurnoutIndex).length;
  if (burnoutTagCount > 0) {
    const top = Object.entries(tagBurnoutIndex)
      .sort(([, a], [, b]) => b.delta - a.delta)
      .slice(0, 5)
      .map(([tag, e]) => `${tag} (Δ${e.delta.toFixed(2)}, n=${e.sampleSize})`);
    console.log(`[crsmart] burnout index: ${burnoutTagCount} tags fired — top: ${top.join(', ')}`);
  } else {
    console.log('[crsmart] burnout index: 0 tags fired (cold-start or no decline detected)');
  }
  await chrome.storage.local.set({
    allShowsScored,
    allShowsScoredMeta: {
      schema: ALL_SHOWS_SCORED_SCHEMA,
      computedAt: Date.now(),
      reactionOverlayTagCount,
      entryCount,
    },
    // Sorted tasteScore distribution. Read by rank-recommendations
    // for cross-surface consistency: same show resolves to the same
    // tasteN whether the user's looking at the side panel or the
    // on-page card.
    tasteScorePercentileMapper: tastePercentileMapper,
    // G01/G02: sorted finalScore distribution. Read by rec-pool path
    // (rankRecommendations) so its per-show calibration anchors against
    // the SAME population as the off-pool path. A 7.5 means "top
    // quartile of your scored catalog" regardless of surface.
    finalScorePercentileMapper: finalScoreMapper,
    // Tag-burnout — sparse map of tags where the user used to like
    // them and recent watches show decline. content.js's chip render
    // path picks one fired tag per card and renders as "Shōnen formula
    // fatigue" / equivalent.
    tagBurnoutIndex,
    // Data-quality issue summary computed above. Surfaced via
    // window.__crsmart probe + monitor asserts so structural defects
    // (empty studios, format/eps conflicts, missing years) are visible
    // before they manifest as broken card rows.
    _dataQualityIssues: dataQualityIssues,
  });
  innerTimings.persist = performance.now() - _persistT0;
  const innerTotal = +(performance.now() - innerT0).toFixed(1);
  const innerOther = +(innerTotal - innerTimings.franchise - innerTimings.creator
    - innerTimings.confidence - innerTimings.persist).toFixed(1);
  const innerBreakdown = `loop+other=${innerOther}ms · franchise=${innerTimings.franchise.toFixed(1)}ms`
    + ` · creator=${innerTimings.creator.toFixed(1)}ms · confidence=${innerTimings.confidence.toFixed(1)}ms`
    + ` · persist=${innerTimings.persist.toFixed(1)}ms`;
  console.log(`[crsmart] all-shows-scored: ${entryCount} entries scored (taste × quality)`
    + (overlayHasSignal ? ` · reaction overlay: ${reactionOverlayTagCount} tags` : ''));
  console.log(`[crsmart] all-shows-scored inner breakdown: ${innerBreakdown}`);

  // Broadcast a "scored-updated" tick to every CR tab so the content
  // script can force a re-render. The chrome.storage.onChanged listener
  // already covers most cases, but during a manual refresh the sync
  // writes ~10 keys in sequence and timing edge cases can leave the
  // card missing — earlier writes remove + reschedule the card before
  // allShowsScored is final, and if the user's series isn't in the
  // intermediate state the schedule no-ops. The broadcast is the
  // belt-and-suspenders that guarantees a fresh render after the final
  // scoring write lands. Best-effort: tabs.query failure doesn't break
  // anything; storage.onChanged is still primary.
  try {
    // Match both https://www.crunchyroll.com/* and the bare-domain
    // variant so all CR tabs receive the broadcast.
    const tabs = await chrome.tabs.query({
      url: ['https://www.crunchyroll.com/*', 'https://crunchyroll.com/*'],
    });
    console.log(`[crsmart] scored-updated broadcast: dispatching to ${tabs.length} CR tab(s)`);
    let dispatched = 0;
    let failed = 0;
    const errs = [];
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'crsmart:scored-updated' });
        dispatched++;
      } catch (err) {
        failed++;
        if (errs.length < 3) errs.push(`${tab.url || '?'}: ${err?.message || err}`);
      }
    }
    console.log(`[crsmart] scored-updated broadcast: ${dispatched} delivered, ${failed} skipped`);
    if (errs.length) console.log('[crsmart] broadcast skip reasons (sample):', errs);
  } catch (err) {
    console.warn('[crsmart] scored-updated broadcast failed', err);
  }
}

// On worker boot / sync trigger, check whether allShowsScored was
// computed under a stale schema version. If so, force a recompute via
// persistTasteVector. Without this, formula changes (boost values,
// new sub-scores, new fields) only take effect on the NEXT history
// sync — could be hours/days later. Schema mismatch = invisible
// staleness; bumping the constant + this check forces fresh math.
async function recomputeIfSchemaStale() {
  const { allShowsScoredMeta, watchShapes, tasteVector } = await chrome.storage.local.get(
    ['allShowsScoredMeta', 'watchShapes', 'tasteVector']);
  const stored = allShowsScoredMeta?.schema;
  if (stored === ALL_SHOWS_SCORED_SCHEMA) return false;
  if (!watchShapes) {
    console.log('[crsmart] schema check: stored=' + stored
      + ', current=' + ALL_SHOWS_SCORED_SCHEMA + '; no watchShapes yet, deferring');
    return false;
  }
  console.log('[crsmart] schema bump detected (stored='
    + (stored ?? 'null') + ', current=' + ALL_SHOWS_SCORED_SCHEMA
    + ') — recomputing taste vector + allShowsScored');
  await persistTasteVector(watchShapes);
  return true;
}

async function recomputeQualityAxes() {
  const { aniListCache = {} } = await chrome.storage.local.get('aniListCache');
  if (Object.keys(aniListCache).length === 0) return;
  const stats = annotateCacheWithQuality(aniListCache);
  // Augmentation pass — annotateCacheWithQuality mutates entries in
  // place with quality-axis fields. mergeBatch preserves cache
  // metadata so backoff state and TTL aren't reset.
  await cache.mergeBatch('aniListCache', aniListCache);
  console.log(`[crsmart] quality axes: ${stats.scored}/${stats.total} with consensus, `
    + `${stats.withCraft}/${stats.total} with craft-prior, `
    + `${stats.highRisk}/${stats.withAdaptation} flagged high adaptation-risk `
    + `(indexed ${stats.directorsIndexed} directors, ${stats.studiosIndexed} studios)`);

  // Spot-check dump — log top/bottom by each axis so the user can
  // sanity-check whether the numbers match their opinion of those
  // specific shows. Self-gates so it only fires the first time axes
  // land (and on schema bumps); flip the key to re-fire. Title lookup
  // preferred english → romaji → "(id)".
  const { _qualitySpotCheckDone } = await chrome.storage.local.get('_qualitySpotCheckDone');
  const QUALITY_SPOT_CHECK_VERSION = 'v2-p75';
  if (_qualitySpotCheckDone?.version === QUALITY_SPOT_CHECK_VERSION) return;
  const titleOf = (e) => e?.title?.english || e?.title?.romaji || `(aniListId ${e?.aniListId})`;
  // Dedup by AniList ID so shows CR has under two series pages (JJK
  // appeared twice in the prior dump) don't repeat in the top-10.
  const seenForDump = new Set();
  const rows = [];
  for (const e of Object.values(aniListCache)) {
    if (!e?.qualityAxes) continue;
    const key = e.aniListId ?? titleOf(e);
    if (seenForDump.has(key)) continue;
    seenForDump.add(key);
    rows.push({ title: titleOf(e), ax: e.qualityAxes });
  }
  const byCraft = rows.filter(r => r.ax.craftPrior != null).sort((a, b) => b.ax.craftPrior - a.ax.craftPrior);
  const byRisk = rows.filter(r => r.ax.adaptationRisk != null).sort((a, b) => b.ax.adaptationRisk - a.ax.adaptationRisk);
  console.log('[crsmart] quality spot-check — top 10 craftPrior:',
    byCraft.slice(0, 10).map(r => `${r.title}: ${r.ax.craftPrior.toFixed(2)}`).join(' · '));
  console.log('[crsmart] quality spot-check — bottom 10 craftPrior:',
    byCraft.slice(-10).reverse().map(r => `${r.title}: ${r.ax.craftPrior.toFixed(2)}`).join(' · '));
  console.log('[crsmart] quality spot-check — top 10 adaptationRisk (rushed shapes):',
    byRisk.slice(0, 10).map(r => `${r.title}: ${r.ax.adaptationRisk.toFixed(2)}`).join(' · '));
  console.log('[crsmart] quality spot-check — bottom 10 adaptationRisk (safest shapes):',
    byRisk.slice(-10).reverse().map(r => `${r.title}: ${r.ax.adaptationRisk.toFixed(2)}`).join(' · '));
  await chrome.storage.local.set({
    _qualitySpotCheckDone: { at: Date.now(), version: QUALITY_SPOT_CHECK_VERSION },
  });
}

// Decorate freshly-fetched rec-candidate Media with qualityAxes in
// memory so the ranker sees them. Rec candidates are by definition
// shows the user HASN'T watched — they're absent from aniListCache
// and therefore don't carry the cache annotation. The quality index,
// though, is built from the cache (the user's watch history), and it's
// exactly the right lookup table: "does this rec's director / studio
// have a track record among shows the user has actually engaged with?"
// Build a {[aniListId]: media} view that combines the rec-fetched
// mediaById with the user's aniListCache. Used as buildFranchise's
// bridge map — the BFS walks deeper through any node that's in this
// map, so widening it here lets a rec central (e.g. Demon Slayer S1)
// reach later arcs that exist only in the user's cache (Mugen Train
// Arc TV → SEQUEL → Entertainment District). Bulk-fetched entries win
// on key collision (freshest relations + tags). Pure: returns a new
// object, doesn't mutate either input.
function mergeAniListCacheIntoMediaById(mediaById, aniListCache) {
  const merged = {};
  for (const e of Object.values(aniListCache || {})) {
    if (e?.aniListId != null) merged[e.aniListId] = e;
  }
  for (const [k, v] of Object.entries(mediaById || {})) merged[k] = v;
  return merged;
}

// ── Franchise bridge cache + lazy enrichment ────────────────────────
// Some shows have long sequel chains (Demon Slayer's 6 arcs, MHA's 8
// seasons) where intermediate seasons aren't in the user's history or
// the popular-seed top-1500. Without those intermediates, the BFS in
// buildFranchise can't walk past 1-2 hops, leaving the year range
// short (DS S1 → Mugen Train Arc TV → Entertainment District relation
// node, but ED itself isn't cached so the 2024 Hashira Training Arc
// is unreachable).
//
// The fix is structural: before ranking, walk the franchise neighborhood
// of every rec central, identify missing intermediate aniListIds, and
// lazy-fetch them in throttled batches. Persist the results under
// aniListBridgeCache so subsequent runs don't re-fetch the same nodes.
//
// Throttling defaults are conservative — functionality first, speed
// later. Honors anilistIsPaused() so a tripped circuit breaker skips
// enrichment cleanly (fall back to current best-effort year range).
const ANILIST_BRIDGE_CACHE_KEY = 'aniListBridgeCache';
const ANILIST_FETCH_PROGRESS_KEY = 'anilistFetchProgress';
const FRANCHISE_ENRICH_BUDGET = 500;
const FRANCHISE_ENRICH_BATCH = 50;
// Walk depth per pass. The BFS naturally halts when the frontier hits
// uncached nodes (those go into `missing`), so a high cap is mostly
// free — it just lets the walk traverse cached intermediates without
// truncation. AOT's chain (S1 → S2 → S3 → S3 P2 → Final Season → FSP2
// → Final Chapters Special 1/2 → The Last Attack movie) is ~7 deep;
// 8 covers it with headroom. Multi-pass keeps us going even on chains
// that grow each cycle (each pass walks one node deeper into freshly
// cached territory).
const FRANCHISE_ENRICH_MAX_PASSES = 8;

async function setAniListProgress(payload) {
  try {
    if (payload == null) {
      await chrome.storage.local.remove(ANILIST_FETCH_PROGRESS_KEY);
    } else {
      await chrome.storage.local.set({
        [ANILIST_FETCH_PROGRESS_KEY]: { ...payload, updatedAt: Date.now() },
      });
    }
  } catch (_) { /* storage race during shutdown — non-fatal */ }
}

// Mirror of setAniListProgress for the CR-history pagination phase.
// Separate key so the popup can render two stacked bars without
// conflating the sources.
const CR_HISTORY_PROGRESS_KEY = 'crHistoryProgress';
async function setCrHistoryProgress(payload) {
  try {
    if (payload == null) {
      await chrome.storage.local.remove(CR_HISTORY_PROGRESS_KEY);
    } else {
      await chrome.storage.local.set({
        [CR_HISTORY_PROGRESS_KEY]: { ...payload, updatedAt: Date.now() },
      });
    }
  } catch (_) { /* non-fatal */ }
}

// Side-effect: mutates `mediaById` in place (additions only). Returns
// the count of fresh fetches and persists newly-fetched Media into
// the bridge cache for next-run reuse. Centrals is the rec-central
// list whose franchises we want fully reachable; mediaById is the
// already-merged (bulk-fetch + aniListCache + prior-bridge) view.
//
// Multi-pass: each pass walks maxHops out from each central, fetches
// missing intermediates, then loops. After fetch, the freshly-cached
// nodes can be walked through in the next pass — that's how we reach
// further than maxHops in a single call. Without multi-pass, DS would
// stop at Entertainment District (2 hops); with maxPasses=3 × maxHops=2
// we reach 6 hops, enough to cover Hashira Training (5 hops) and beyond.
async function enrichFranchiseBridges(centrals, mediaById, options = {}) {
  const maxHops = options.maxHops ?? 2;
  const maxPasses = options.maxPasses ?? FRANCHISE_ENRICH_MAX_PASSES;
  const budget = options.budget ?? FRANCHISE_ENRICH_BUDGET;

  // Hydrate bridge cache up front — even if we can't fetch anything new
  // (paused breaker), prior runs' bridges should still flow into mediaById.
  const { [ANILIST_BRIDGE_CACHE_KEY]: bridgeCache = {} } =
    await chrome.storage.local.get(ANILIST_BRIDGE_CACHE_KEY);
  let bridgeMerged = 0;
  for (const [id, m] of Object.entries(bridgeCache)) {
    if (!mediaById[id]) { mediaById[id] = m; bridgeMerged++; }
  }

  if (anilistIsPaused()) {
    const secondsLeft = Math.ceil(anilistPauseMsLeft() / 1000);
    console.log(`[crsmart] franchise-enrich: skipping fresh fetches — circuit-breaker paused ${secondsLeft}s (merged ${bridgeMerged} from bridge cache)`);
    return { fetched: 0, fromCache: bridgeMerged, passes: 0 };
  }

  let totalFetched = 0;
  const freshlyFetched = {};
  const everMissing = new Set();
  let passNum = 0;
  let stopped = false;

  await setAniListProgress({
    phase: 'franchise-enrich',
    label: 'Enriching franchise data',
    current: 0,
    total: 0, // unknown until first walk
    startedAt: Date.now(),
  });

  for (passNum = 0; passNum < maxPasses; passNum++) {
    if (anilistIsPaused()) {
      console.log(`[crsmart] franchise-enrich: pause hit before pass ${passNum + 1}, stopping`);
      stopped = true;
      break;
    }
    if (totalFetched >= budget) {
      console.log(`[crsmart] franchise-enrich: budget exhausted at pass ${passNum + 1} (${totalFetched}/${budget})`);
      break;
    }

    // Walk each central's franchise neighborhood. Union missing IDs.
    const missingThisPass = new Set();
    for (const central of centrals) {
      if (!central) continue;
      const ids = collectFranchiseNeighborhoodIds(central, mediaById, { maxHops });
      for (const id of ids) {
        if (!everMissing.has(id)) missingThisPass.add(id);
      }
    }
    if (missingThisPass.size === 0) {
      // Saturated — every node within reach is already in mediaById.
      break;
    }

    for (const id of missingThisPass) everMissing.add(id);
    const remainingBudget = budget - totalFetched;
    const toFetch = [...missingThisPass].slice(0, remainingBudget);
    console.log(`[crsmart] franchise-enrich pass ${passNum + 1}/${maxPasses}: ${missingThisPass.size} new missing, fetching ${toFetch.length}`);

    for (let i = 0; i < toFetch.length; i += FRANCHISE_ENRICH_BATCH) {
      if (anilistIsPaused()) {
        console.log('[crsmart] franchise-enrich: pause hit mid-pass, stopping');
        stopped = true;
        break;
      }
      const batch = toFetch.slice(i, i + FRANCHISE_ENRICH_BATCH);
      let result;
      try {
        // skipRootDescription: bridge nodes only feed franchise totals
        // (season/ep/movie counts) — they never render their own opener
        // text, so the per-node root-walk (the dominant cost of these
        // passes) is pure waste here. The visited central still gets its
        // root description from the on-visit enrichOne path.
        result = await bulkFetchByIds(batch, { skipRootDescription: true });
      } catch (err) {
        console.warn('[crsmart] franchise-enrich: bulkFetch failed', err);
        stopped = true;
        break;
      }
      for (const [id, m] of Object.entries(result || {})) {
        if (!m) continue;
        mediaById[id] = m;
        freshlyFetched[id] = m;
        totalFetched++;
      }
      await setAniListProgress({
        phase: 'franchise-enrich',
        label: `Enriching franchise data · pass ${passNum + 1}/${maxPasses}`,
        current: totalFetched,
        total: Math.max(totalFetched, everMissing.size),
        startedAt: Date.now(),
      });

    }
    if (stopped) break;
  }

  // Persist bridges so next pass doesn't re-fetch.
  if (Object.keys(freshlyFetched).length > 0) {
    Object.assign(bridgeCache, freshlyFetched);
    try {
      await cache.putBatch('aniListBridgeCache', freshlyFetched);
    } catch (err) {
      console.warn('[crsmart] franchise-enrich: bridge-cache write failed', err);
    }
  }

  await setAniListProgress(null);

  console.log(`[crsmart] franchise-enrich: ${totalFetched} fetched across ${passNum} pass${passNum === 1 ? '' : 'es'}${stopped ? ' (stopped early)' : ''}, bridge cache size now ${Object.keys(bridgeCache).length}`);
  return { fetched: totalFetched, fromCache: bridgeMerged, passes: passNum };
}

// Focused franchise enrichment for a single CR series. Triggered on
// page-visit (after on-visit AniList refresh + computeAllShowsScored)
// so the visited show's franchise totals come up to date even when its
// chain is too deep for the global computeAllShowsScored pass to
// resolve. Walks the bridge graph from the user's cached entry, fetches
// missing intermediates within a small per-visit budget, then rebuilds
// just THIS entry's franchise field in allShowsScored. The card's
// storage-onChanged listener picks up the update and repaints in place.
async function enrichOneSeriesFranchise(seriesId) {
  const {
    aniListCache = {},
    allShowsScored = {},
    [ANILIST_BRIDGE_CACHE_KEY]: bridgeCache = {},
  } = await chrome.storage.local.get([
    'aniListCache', 'allShowsScored', ANILIST_BRIDGE_CACHE_KEY,
  ]);

  const central = aniListCache[seriesId];
  if (!central?.aniListId) return; // no AniList match yet — nothing to walk

  // Build a mediaById view that combines the user's whole watched-history
  // cache with the persistent bridge cache. Bridge wins on collision (it
  // has the freshest relations from the rec-path enrichment passes).
  const mediaById = {};
  for (const e of Object.values(aniListCache)) {
    if (e?.aniListId != null) mediaById[e.aniListId] = e;
  }
  for (const [id, m] of Object.entries(bridgeCache)) {
    if (!mediaById[id]) mediaById[id] = m;
  }

  // Smaller per-visit budget than the rec-path's 500 — we're only walking
  // one franchise, not 60 candidates. Same multi-pass machinery, same
  // circuit-breaker awareness; persists into the same bridgeCache so a
  // second visit costs near-zero.
  const updated = allShowsScored[seriesId];
  if (!updated) return; // computeAllShowsScored hasn't run yet — nothing to patch

  // Perceived-speed (paint best-available first): build the franchise with
  // ZERO network from aniListCache + the persisted bridge cache and write it
  // immediately. On repeat visits the bridge cache is already complete, so
  // the card shows the full franchise instantly and the fetch pass below is a
  // no-op. On first visits it shows partial coverage right away, then refines.
  // Guarded so we only pay the (whole-map) storage write when it changes —
  // computeAllShowsScored already wrote a bridge-less franchise upstream, so
  // this fires exactly when cached bridges add something.
  const cachedFranchise = buildFranchise(central, mediaById);
  if (!sameFranchise(updated.franchise, cachedFranchise)) {
    updated.franchise = cachedFranchise;
    await chrome.storage.local.set({ allShowsScored });
  }

  await enrichFranchiseBridges([central], mediaById, {
    maxHops: 8,
    maxPasses: 8,
    budget: 50,
  });

  // Refine with the now-deeper graph; write only if the fetch pass actually
  // changed the franchise (avoids a redundant repaint when nothing new came).
  const refinedFranchise = buildFranchise(central, mediaById);
  if (!sameFranchise(updated.franchise, refinedFranchise)) {
    updated.franchise = refinedFranchise;
    await chrome.storage.local.set({ allShowsScored });
  }
}

// Cheap structural equality for the franchise field — avoids redundant
// whole-map allShowsScored writes (each one repaints the card).
function sameFranchise(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ── Dev tool: full Crunchyroll catalog → rec-pool export ─────────────
// Enumerates CR's entire series catalog via discover/browse (which
// paginates the whole ~1,950-series catalog — no AniList page-100 cap),
// resolves each NEW series to AniList via enrichOne, and stores an
// assembled { [crId]: projectedMedia } sidecar that the popup downloads
// for committing as data/rec-pool-by-cr-id.json. Dev-only, one-shot,
// gated behind the ?dev=1 popup. Reuses the live cr-gateway token (so the
// auto-refresh + 429 handling carry the long run) + enrichOne's proven
// title→AniList match+verify path.
const CR_CATALOG_EXPORT_KEY = '_devCatalogExport';
const CR_CATALOG_PREVIEW_KEY = '_devCatalogPreview';
let crCatalogExportRunning = false;

// MV3 keepalive: a long detached job (no pending event) gets the service
// worker suspended after ~30s idle even mid-await, killing the run. A
// trivial chrome API call every 20s resets the idle timer so the worker
// survives a multi-minute job. Started/stopped around the catalog export.
let crCatalogKeepAlive = null;
function startCatalogKeepAlive() {
  if (crCatalogKeepAlive) return;
  crCatalogKeepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);
}
function stopCatalogKeepAlive() {
  if (crCatalogKeepAlive) { clearInterval(crCatalogKeepAlive); crCatalogKeepAlive = null; }
}

async function enumerateCrCatalog(onProgress) {
  const out = [];
  const pageSize = 100;
  let start = 0;
  let total = Infinity;
  while (start < total) {
    const url = 'https://www.crunchyroll.com/content/v2/discover/browse'
      + `?n=${pageSize}&start=${start}&type=series&sort_by=alphabetical&locale=en-US`;
    const res = await crFetch(url, 'cr-catalog-browse');
    if (!res.ok) throw new Error(`CR browse failed at start=${start}: ${res.kind} ${res.status || ''}`);
    total = res.data?.total ?? out.length;
    const items = res.data?.data || [];
    if (!items.length) break;
    for (const it of items) {
      if (it?.id && it?.type === 'series') {
        out.push({ crId: it.id, title: it.title, slug: it.slug_title || it.slug || null });
      }
    }
    start += items.length;
    if (onProgress) await onProgress(out.length, total);
  }
  return { series: out, total };
}

// Slim a freshly-projected entry to the bundled-pool shape: top-6 staff,
// no image URL (matches the staff-slim applied to the committed asset).
function slimPoolEntry(m) {
  if (m && Array.isArray(m.staff)) {
    m.staff = m.staff.slice(0, 6).map(s => ({ id: s.id ?? null, role: s.role, name: s.name ?? null }));
  }
  return m;
}

// Pick the best AniList candidate for a CR title from batched-search results.
// Title-only (the batched lite query has no externalLinks to CR-verify), so
// confidence reflects title agreement: exact normalized match → 'verified',
// decent token overlap → 'unverified-best-guess', else 'no-match'. The
// preview's ⚠ flag re-checks overlap so weak best-guesses surface for review.
const _normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// CR lists some titles as "English (Japanese alt-title)" or
// "English - Japanese alt-title" — the dual-title drags simple overlap below
// the match threshold (e.g. "A Lull in the Sea (Nagi-Asu: Nagi no Asukara)"
// vs AniList's "Nagi no Asukara"). Return a clean search query (the base
// title before the separator) plus every variant to score candidates
// against. base == full for ordinary titles (no "(…)" / " - "), so this is
// strictly additive — it can only recover the dual-title tail, not regress.
function titleSearchVariants(title) {
  const full = String(title || '').trim();
  const variants = new Set();
  if (full) variants.add(full);
  let base = full, inner = null;
  const paren = full.match(/^(.*\S)\s*\(([^)]+)\)\s*$/);
  if (paren) { base = paren[1].trim(); inner = paren[2].trim(); }
  else {
    const dash = full.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dash) { base = dash[1].trim(); inner = dash[2].trim(); }
  }
  if (base && base !== full) variants.add(base);
  if (inner) {
    variants.add(inner);
    const colon = inner.match(/^[^:]+:\s*(.+)$/); // "Nagi-Asu: Nagi no Asukara" → "Nagi no Asukara"
    if (colon) variants.add(colon[1].trim());
  }
  return { search: base || full, variants: [...variants].filter(Boolean) };
}

function pickAniListMatch(variants, cands) {
  if (!variants.length || !cands.length) return { conf: 'no-match' };
  const targets = variants
    .map(v => ({ norm: _normTitle(v), set: new Set(_normTitle(v).split(' ').filter(Boolean)) }))
    .filter(t => t.norm);
  if (!targets.length) return { conf: 'no-match' };
  let best = null, bestScore = 0;
  for (const c of cands) {
    const names = [c.title?.english, c.title?.romaji, c.title?.native, ...(c.synonyms || [])]
      .filter(Boolean).map(_normTitle).filter(Boolean);
    let cScore = 0;
    for (const n of names) {
      const nset = new Set(n.split(' ').filter(Boolean));
      for (const t of targets) {
        if (n === t.norm) { cScore = 1; break; }
        let inter = 0;
        for (const x of t.set) if (nset.has(x)) inter++;
        cScore = Math.max(cScore, inter / Math.min(t.set.size, nset.size));
      }
      if (cScore === 1) break;
    }
    if (cScore > bestScore) { bestScore = cScore; best = c; }
    if (bestScore === 1) break;
  }
  const alTitle = best ? (best.title?.english || best.title?.romaji || best.title?.native || null) : null;
  if (!best || bestScore < 0.5) return { conf: 'no-match', aniListId: null, alTitle: null };
  return { aniListId: best.aniListId, alTitle, conf: bestScore >= 0.999 ? 'verified' : 'unverified-best-guess' };
}

async function runCrCatalogExport() {
  if (crCatalogExportRunning) return;
  crCatalogExportRunning = true;
  startCatalogKeepAlive();
  const startedAt = Date.now();
  const writeState = (s) => chrome.storage.local.set({ [CR_CATALOG_EXPORT_KEY]: { startedAt, ...s } });
  try {
    await writeState({ status: 'running', phase: 'browse', current: 0, total: 0 });
    await setAniListProgress({ phase: 'cr-catalog', label: 'Enumerating CR catalog', current: 0, total: 0, startedAt });

    // 1) enumerate the entire CR catalog
    const { series, total } = await enumerateCrCatalog(async (current, tot) => {
      await setAniListProgress({ phase: 'cr-catalog', label: 'Enumerating CR catalog', current, total: tot, startedAt });
      await writeState({ status: 'running', phase: 'browse', current, total: tot });
    });

    // 2) seed from the existing bundled pool (already slimmed) so we only
    //    resolve net-new shows.
    const byCrId = {};
    try {
      const pool = await (await fetch(chrome.runtime.getURL('data/rec-pool-by-cr-id.json'))).json();
      Object.assign(byCrId, pool.byCrId || {});
    } catch (err) {
      console.warn('[crsmart] cr-catalog: existing pool unreadable, starting fresh', err);
    }
    const carriedOver = Object.keys(byCrId).length;

    // 3) resolve net-new CR shows to AniList via the proven enrichOne path
    const toResolve = series.filter(s => !byCrId[s.crId]);
    const conf = { verified: 0, 'unverified-best-guess': 0, 'no-match': 0 };
    // Per-show match rows for the preview page. Kept in a SEPARATE storage
    // key (not in the sidecar) so the committed pool stays clean. Includes
    // misses so low-confidence / failed matches are reviewable.
    const preview = [];
    const writePreview = (partial) => chrome.storage.local.set({
      [CR_CATALOG_PREVIEW_KEY]: { rows: preview, partial, updatedAt: Date.now() },
    });

    // Phase A — batched title→AniList match. One request resolves ~10 titles
    // via GraphQL aliases (vs one search per show); the only practical shape
    // against AniList's 30/min limit (~150 requests total, not ~1,900). It's
    // title-only (no CR-link verification), so the preview's ⚠ flag is the
    // accuracy backstop.
    const matchByCrId = {};
    const SEARCH_BATCH = 10;
    let matched = 0;
    for (let i = 0; i < toResolve.length; i += SEARCH_BATCH) {
      const chunk = toResolve.slice(i, i + SEARCH_BATCH);
      const prepared = chunk.map(s => ({ s, tv: titleSearchVariants(s.title) }));
      let byTitle = {};
      try { byTitle = await searchTopByTitleBatched(prepared.map(p => p.tv.search), { limit: 6 }); }
      catch (err) { console.warn('[crsmart] cr-catalog: batched search failed', err); }
      for (const { s, tv } of prepared) {
        const m = pickAniListMatch(tv.variants, byTitle[tv.search.trim()] || []);
        matchByCrId[s.crId] = m;
        conf[m.conf] = (conf[m.conf] || 0) + 1;
        preview.push({ crId: s.crId, crTitle: s.title, alId: m.aniListId ?? null, alTitle: m.alTitle ?? null, conf: m.conf });
      }
      matched += chunk.length;
      await setAniListProgress({ phase: 'cr-catalog', label: 'Matching CR → AniList', current: matched, total: toResolve.length, startedAt });
      await writeState({ status: 'running', phase: 'match', current: matched, total: toResolve.length, carriedOver });
      if (matched % 50 < SEARCH_BATCH || matched === toResolve.length) await writePreview(matched < toResolve.length);
    }
    await writePreview(false);

    // Phase B — bulk-fetch full projections (tags/relations/score) for the
    // matched ids in pages of 50 (root-walks skipped), then assemble.
    const matchedIds = [...new Set(Object.values(matchByCrId).map(m => m.aniListId).filter(Boolean))];
    await setAniListProgress({ phase: 'cr-catalog', label: 'Fetching matched show data', current: 0, total: matchedIds.length, startedAt });
    await writeState({ status: 'running', phase: 'fetch', current: 0, total: matchedIds.length, carriedOver });
    let mediaById = {};
    try { mediaById = await bulkFetchByIds(matchedIds, { skipRootDescription: true }); }
    catch (err) { console.warn('[crsmart] cr-catalog: bulkFetchByIds failed', err); }

    for (const s of toResolve) {
      const m = matchByCrId[s.crId];
      if (!m?.aniListId) continue;
      const media = mediaById[m.aniListId];
      if (!media) continue;
      byCrId[s.crId] = {
        ...slimPoolEntry({ ...media }),
        _matchConfidence: m.conf,
        _seedStrategy: 'cr-catalog',
        fetchedAt: Date.now(),
      };
    }

    // 4) assemble the sidecar in the same shape as the committed asset
    const sidecar = {
      _generatedAt: new Date().toISOString(),
      _schema: ANILIST_SCHEMA_VERSION,
      _strategy: 'cr-catalog',
      _hitCount: Object.keys(byCrId).length,
      _catalogTotal: total,
      _resolved: { attempted: toResolve.length, carriedOver, ...conf },
      byCrId,
    };
    await writeState({
      status: 'done', phase: 'done',
      current: sidecar._hitCount, total: sidecar._hitCount,
      finishedAt: Date.now(),
      summary: { hitCount: sidecar._hitCount, catalogTotal: total, carriedOver, resolved: { attempted: toResolve.length, ...conf } },
      sidecar,
    });
    await setAniListProgress(null);
    console.log(`[crsmart] cr-catalog export done: ${sidecar._hitCount} shows (catalog ${total}, new resolved ${JSON.stringify(conf)})`);
  } catch (err) {
    console.warn('[crsmart] cr-catalog export failed', err);
    await writeState({ status: 'error', error: String(err?.message || err), finishedAt: Date.now() });
    await setAniListProgress(null);
  } finally {
    crCatalogExportRunning = false;
    stopCatalogKeepAlive();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'crsmart:dev:cr-catalog:start') return false;
  if (crCatalogExportRunning) { sendResponse({ ok: true, alreadyRunning: true }); return false; }
  runCrCatalogExport();
  sendResponse({ ok: true, started: true });
  return false;
});

function annotateMediaByIdWithQuality(mediaById, aniListCache) {
  const index = buildQualityIndex(aniListCache);
  for (const media of Object.values(mediaById || {})) {
    if (!media) continue;
    media.qualityAxes = computeShowQuality(media, index);
  }
}

async function persistWatchHistoryScored(watchShapes, tasteVector) {
  const { aniListCache = {} } = await chrome.storage.local.get('aniListCache');
  if (!watchShapes) {
    const stored = await chrome.storage.local.get('watchShapes');
    watchShapes = stored.watchShapes;
  }
  if (!tasteVector) {
    const stored = await chrome.storage.local.get('tasteVector');
    tasteVector = stored.tasteVector;
  }
  if (!watchShapes || !tasteVector) return;
  const { ranked, bucketStats, skipped } = scoreWatchHistory(watchShapes, aniListCache, tasteVector);
  await chrome.storage.local.set({
    watchHistoryScored: {
      ranked,
      bucketStats,
      skipped,
      computedAt: Date.now(),
    },
  });
  console.log(`[crsmart] per-show calibration — skipped ${skipped.noCache} (no cache) `
    + `+ ${skipped.noData} (no tags/genres in cache)`);

  // Diagnostic: when noData is alarmingly high, dump match-confidence
  // distribution across the cache so we know whether the gap is failed
  // matches ('none') or verified entries with empty tag arrays. The
  // cache may contain old stubs from before enrichment improvements;
  // a confidence-bucket sample tells us where to look.
  if (skipped.noData > 50) {
    const confDist = {};
    const noDataSamples = {};
    const errorReasons = {};
    for (const [crId, entry] of Object.entries(aniListCache)) {
      const conf = entry?._matchConfidence ?? 'unknown';
      confDist[conf] = (confDist[conf] || 0) + 1;
      const empty = !(entry?.tags?.length) && !(entry?.genres?.length);
      if (empty) {
        (noDataSamples[conf] ||= []);
        if (noDataSamples[conf].length < 5) {
          noDataSamples[conf].push({
            crId,
            searched: entry?._searchTitle ?? null,
            title: entry?.title?.english || entry?.title?.romaji || null,
            error: entry?._error ?? null,
          });
        }
      }
      if (conf === 'error' && entry?._error) {
        const key = String(entry._error).slice(0, 80);
        errorReasons[key] = (errorReasons[key] || 0) + 1;
      }
    }
    console.log('[crsmart] cache match-confidence distribution:', confDist);
    console.log('[crsmart] empty-data samples by confidence:', noDataSamples);
    if (Object.keys(errorReasons).length) {
      console.log('[crsmart] error-confidence reason distribution:', errorReasons);
    }
  }
  console.log('[crsmart] per-show calibration — bucket stats:',
    Object.fromEntries(Object.entries(bucketStats).map(
      ([k, v]) => [k, `n=${v.n} median=${v.median} (p25=${v.p25} p75=${v.p75})`])));
  console.log('[crsmart] per-show calibration — top 15:',
    ranked.slice(0, 15).map(r => ({
      title: r.title, label: r.label, score: r.score,
      topArch: Object.entries(r.archetypeBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    })));
  console.log('[crsmart] per-show calibration — bottom 10:',
    ranked.slice(-10).map(r => ({
      title: r.title, label: r.label, score: r.score,
    })));
}

// Stage 1d-c B: dual-mode recommendation pipeline. Aggregates B1 per
// mode (different perSeriesWeights → different candidate sets), unions
// the top candidates, fetches Media once, then re-ranks twice. Persists
// `recommendationsScored.{peak,comfort}` for the popup to toggle.
async function persistDualModeRecommendations(watchShapes, vectorPeak, vectorComfort, options = {}) {
  const { aniListCache = {} } = await chrome.storage.local.get('aniListCache');
  if (!watchShapes || !vectorPeak || !vectorComfort) return;
  // CF re-ranker — accept a pre-built cfApply from the orchestrator
  // (persistTasteVector). Saves a redundant rebuild on the same recompute
  // pass (Candidate 1 of architecture review 2026-05-15). Falls back to
  // building one if the caller didn't provide it (legacy + standalone
  // invocations).
  const cfApply = options.cfApply !== undefined
    ? options.cfApply
    : await buildCFApply();

  // Per-mode percentile mappers. Without this, rec-pool tasteN was
  // being mapped against the all-vector's score distribution — peak
  // and comfort vectors produce smaller raw scores (smaller L2 norms,
  // fewer contributors), so every rec-pool show landed in the lower
  // percentiles. JJK S1 in peak pool was showing tasteN=0.30. Each
  // mode now gets its own mapper built from cache-wide scores against
  // that mode's vector.
  //
  // Score-cache seam: prepare each show ONCE (tag filtering, implied-
  // tag expansion, archetype-fit) and reuse the prep across both
  // mode-vector dot products. Both vectors share tagImplications
  // from buildTasteVectorPrep, so the prep is identical between
  // them. Cuts the cache-iteration cost roughly in half vs the old
  // pattern of two full scoreShow calls per entry.
  const peakRawScores = [];
  const comfortRawScores = [];
  const sharedTagImplications = vectorPeak?.tagImplications || vectorComfort?.tagImplications || {};
  for (const entry of Object.values(aniListCache)) {
    if (!entry || !((entry.tags?.length || 0) > 0 || (entry.genres?.length || 0) > 0)) continue;
    const prepared = prepareShow(entry, sharedTagImplications);
    peakRawScores.push(scorePreparedShow(prepared, vectorPeak).score);
    comfortRawScores.push(scorePreparedShow(prepared, vectorComfort).score);
  }
  const peakTasteMapper = buildPercentileMapper(peakRawScores);
  const comfortTasteMapper = buildPercentileMapper(comfortRawScores);
  await chrome.storage.local.set({
    tasteScorePercentileMapperPeak: peakTasteMapper,
    tasteScorePercentileMapperComfort: comfortTasteMapper,
  });

  const b1Peak = aggregateRecommendations(watchShapes, aniListCache, vectorPeak, { topN: 100 });
  const b1Comfort = aggregateRecommendations(watchShapes, aniListCache, vectorComfort, { topN: 100 });

  await chrome.storage.local.set({
    recommendationCandidates: {
      peak: { ...b1Peak, computedAt: Date.now() },
      comfort: { ...b1Comfort, computedAt: Date.now() },
    },
  });

  console.log(`[crsmart] rec-candidates [peak]: ${b1Peak.summary.uniqueCandidates} unique `
    + `(${b1Peak.summary.recsFromBoostedSources}/${b1Peak.summary.totalRecsConsidered} boosted)`);
  console.log(`[crsmart] rec-candidates [comfort]: ${b1Comfort.summary.uniqueCandidates} unique `
    + `(${b1Comfort.summary.recsFromBoostedSources}/${b1Comfort.summary.totalRecsConsidered} boosted)`);

  // Union of top 60 from each mode, deduped — most popular candidates
  // overlap between modes, so this typically fetches 70-90 IDs (~2
  // batches) instead of 120.
  const TOP_N_TO_ENRICH = 60;
  const peakHead = b1Peak.candidates.slice(0, TOP_N_TO_ENRICH);
  const comfortHead = b1Comfort.candidates.slice(0, TOP_N_TO_ENRICH);

  // Seeded candidates from survey "Seed from AniList" CTA. Each
  // tagged seed-pool was fetched via SCORE_DESC tag query; we merge
  // them into peakHead so the override-boosted peak vector can score
  // them. Comfort head intentionally untouched — seed CTA is a peak-
  // tier intent ("surface the GOOD ecchi"), not a comfort intent.
  // recScore = 0.30 puts seeded shows below behavioral candidates by
  // default; their tasteScore (boosted by override) does the lifting.
  const { seededCandidates = {} } = await chrome.storage.local.get('seededCandidates');
  const SEEDED_REC_SCORE = 0.30;
  const seededIdSet = new Set();
  const peakIdSet = new Set(peakHead.map(c => c.aniListId));
  const seededMediaById = {};
  let seededCount = 0;
  for (const [tag, entry] of Object.entries(seededCandidates)) {
    if (!Array.isArray(entry?.aniListIds)) continue;
    for (const id of entry.aniListIds) {
      if (peakIdSet.has(id) || seededIdSet.has(id)) continue;
      seededIdSet.add(id);
      peakHead.push({
        aniListId: id,
        title: entry.mediaByAniListId?.[id]?.title || null,
        score: SEEDED_REC_SCORE,
        sources: [{ title: tag, weight: SEEDED_REC_SCORE, kind: 'tag-seed' }],
      });
      // Hand the projected media into the bulkFetch path so we don't
      // re-fetch — fetchTopShowsByTag already returned full projections.
      if (entry.mediaByAniListId?.[id]) {
        seededMediaById[id] = entry.mediaByAniListId[id];
      }
      seededCount++;
    }
  }
  if (seededCount > 0) {
    console.log(`[crsmart] rec-pool: merged ${seededCount} seeded candidate(s) from `
      + `${Object.keys(seededCandidates).length} tag(s) into peakHead`);
  }

  const idSet = new Set([
    ...peakHead.map(c => c.aniListId),
    ...comfortHead.map(c => c.aniListId),
  ]);
  const allIds = [...idSet];
  if (allIds.length === 0) return;

  if (anilistIsPaused()) {
    const secondsLeft = Math.ceil(anilistPauseMsLeft() / 1000);
    console.log(`[crsmart] rec-rank: skipping bulkFetchByIds — circuit-breaker paused ${secondsLeft}s (cached recs still serve)`);
    return;
  }
  // Skip fetching seeded IDs — fetchTopShowsByTag already returned
  // full projections for them and stored them on seededCandidates.
  const idsNeedingFetch = allIds.filter(id => !seededMediaById[id]);
  console.log(`[crsmart] rec-rank: fetching ${idsNeedingFetch.length} unique candidate Media `
    + `(union of peak top ${peakHead.length} + comfort top ${comfortHead.length}; `
    + `${Object.keys(seededMediaById).length} pre-projected from seed)…`);
  let mediaById;
  try {
    mediaById = idsNeedingFetch.length > 0
      ? await bulkFetchByIds(idsNeedingFetch)
      : {};
  } catch (err) {
    console.warn('[crsmart] rec-rank: bulkFetchByIds failed', err);
    return;
  }
  // Merge seeded projections into the fetched set so downstream sees
  // a single mediaById.
  for (const [id, m] of Object.entries(seededMediaById)) {
    if (!mediaById[id]) mediaById[id] = m;
  }
  console.log(`[crsmart] rec-rank: ${Object.keys(mediaById).length}/${allIds.length} Media available `
    + `(${idsNeedingFetch.length} fetched + ${Object.keys(seededMediaById).length} seeded)`);

  // Attach qualityAxes to each rec candidate so the ranker (and
  // downstream card-pitch consumers) have pedigree + consensus +
  // adaptation-risk data. Computed against the quality index built
  // from the user's watched-history cache — rec candidates haven't
  // been watched by definition, so they carry no cache entry of
  // their own.
  annotateMediaByIdWithQuality(mediaById, aniListCache);

  // Load current reactions + preserve candidate head shape for rerank —
  // re-scoring on reaction change reads this cache instead of refetching.
  // userRatings (👍/👎) are passed into rankRecommendations for the G05
  // override clamp on the calibrated finalScore.
  const { userReactions = {}, userRatings = {} } = await chrome.storage.local.get([
    'userReactions', 'userRatings',
  ]);

  const dealbreakerTags = await getDealbreakerTags();

  // Merge user's aniListCache into mediaById so rec centrals' franchise
  // walks can use cached entries as bridges. See helper for rationale.
  const mediaForRank = mergeAniListCacheIntoMediaById(mediaById, aniListCache);

  // Lazy-fetch missing franchise intermediates so year ranges and
  // season counts reach the full sequel chain (DS S1 → ... → Hashira
  // Training Arc 2024). Mutates mediaForRank in place; persists to
  // aniListBridgeCache for next-run reuse.
  const recCentrals = [
    ...peakHead.map(c => mediaForRank[c.aniListId]),
    ...comfortHead.map(c => mediaForRank[c.aniListId]),
  ].filter(Boolean);
  // maxHops=8 lets the walk traverse fully through whatever's already
  // cached without truncation; multi-pass extends the chain by one node
  // per pass when fetched intermediates unlock the next level. AOT's
  // 7-deep chain saturates in ~3 passes when bridge cache is warm,
  // ~7 passes from cold. Bridge cache makes subsequent runs near-zero.
  await enrichFranchiseBridges(recCentrals, mediaForRank, { maxHops: 8 });

  // Build a recsById shim from an initial (no-overlay) rank so we know
  // which topTags each rated show surfaced. Without this, reactions on
  // shows the user just rated can't contribute until the next full pass.
  const { studioCreatorIndex, finalScorePercentileMapper } = await chrome.storage.local.get([
    'studioCreatorIndex',
    // G01/G02: read the off-pool finalScore mapper that
    // computeAllShowsScored persisted earlier in this recompute.
    // Passed into rankRecommendations so the rec pool calibrates
    // against the same population (cross-surface band consistency).
    'finalScorePercentileMapper',
  ]);
  // Use the locally-built mode mappers (computed above) directly —
  // they're guaranteed in sync with this run's vectors. The persisted
  // copies are for the rerank-from-reactions path which fires later.
  // cfApply already resolved at function entry (Candidate 1 dedup).
  const peakSeed = rankRecommendations(peakHead, mediaForRank, vectorPeak,
    { dealbreakerTags, studioCreatorIndex,
      tasteScorePercentileMapper: peakTasteMapper,
      finalScorePercentileMapper, userRatings, cfApply });
  const comfortSeed = rankRecommendations(comfortHead, mediaForRank, vectorComfort,
    { dealbreakerTags, studioCreatorIndex,
      tasteScorePercentileMapper: comfortTasteMapper,
      finalScorePercentileMapper, userRatings, cfApply });
  const seedRecsById = {};
  for (const r of [...peakSeed.ranked, ...comfortSeed.ranked]) {
    if (!seedRecsById[r.aniListId]) seedRecsById[r.aniListId] = r;
  }
  const overlay = computeReactionOverlay(userReactions, seedRecsById);

  const peakScored = rankRecommendations(peakHead, mediaForRank, vectorPeak,
    { overlay, dealbreakerTags, studioCreatorIndex,
      tasteScorePercentileMapper: peakTasteMapper,
      finalScorePercentileMapper, userRatings, cfApply });
  const comfortScored = rankRecommendations(comfortHead, mediaForRank, vectorComfort,
    { overlay, dealbreakerTags, studioCreatorIndex,
      tasteScorePercentileMapper: comfortTasteMapper,
      finalScorePercentileMapper, userRatings, cfApply });

  // G03: rec-list diversification. Reorders the ranked output so the
  // first picks aren't near-duplicates of each other. Only affects
  // display order; no rec's calibrated finalScore is modified.
  // Applies to both peak and comfort lenses; future creator-driven
  // lens may opt out via `diversify: false`.
  peakScored.ranked = diversifyRanked(peakScored.ranked);
  comfortScored.ranked = diversifyRanked(comfortScored.ranked);

  // Sidecar cache of fetched Media + the candidate heads so rerank on
  // reaction change doesn't re-hit AniList. Stored separately from
  // recommendationsScored so the shape of that key stays stable.
  await chrome.storage.local.set({
    recommendationRerankCache: {
      mediaById,
      peakHead,
      comfortHead,
      overlayTagCount: Object.keys(overlay).length,
      computedAt: Date.now(),
    },
    recommendationsScored: {
      peak: { ...peakScored, computedAt: Date.now() },
      comfort: { ...comfortScored, computedAt: Date.now() },
    },
  });

  // G13-deep + new lenses: run the 5 additional lenses (in-the-air,
  // from-people-you-trust, take-a-chance, canon, try-again) over
  // allShowsScored. Each lens is a filter+sort over the canonical
  // calibrated finalScore (north-star Q7) — no rescoring, just
  // selection. Diversification per lens config (off for
  // from-people-you-trust where concentration is the point).
  try {
    const { allShowsScored = {}, watchShapes = {}, archetypeBlend, studioCreatorIndex, aniListCache = {} } =
      await chrome.storage.local.get([
        'allShowsScored', 'watchShapes', 'archetypeBlend', 'studioCreatorIndex', 'aniListCache',
      ]);
    const archetypeArr = Array.isArray(archetypeBlend?.archetypes)
      ? archetypeBlend.archetypes : [];
    // CF re-ranker — reuses the cfApply built at function entry
    // (Candidate 1 dedup of architecture review 2026-05-15).
    // aniListCache passed in so buildLensState can do franchise-sibling
    // watched-exclusion (sequels of a watched show stay out of
    // discovery lenses).
    const newLensRanked = runAllNewLenses(LENSES, {
      allShowsScored,
      watchShapes,
      archetypeBlend: archetypeArr,
      studioCreatorIndex,
      aniListCache,
      cfApply,
    });
    if (Object.keys(newLensRanked).length > 0) {
      // Merge into recommendationsScored without overwriting peak/comfort.
      const { recommendationsScored: existing = {} } = await chrome.storage.local.get('recommendationsScored');
      await chrome.storage.local.set({
        recommendationsScored: { ...existing, ...newLensRanked },
      });
      const summary = Object.entries(newLensRanked)
        .map(([id, r]) => `${id}=${r.ranked.length}`)
        .join(' · ');
      console.log(`[crsmart] new-lenses ranked: ${summary}`);
    }
  } catch (err) {
    console.warn('[crsmart] new-lenses run failed', err);
    logEngineError('lens-pipeline', 'run-failed', err);
  }

  const fmt = r => ({
    title: r.title?.english || r.title?.romaji || null,
    final: r.finalScore,
    sub: r.subScores,
    avg: r.averageScore,
    because: r.sources.slice(0, 2).map(s => s.title).filter(Boolean),
  });
  console.log(`[crsmart] rec-rank [peak]: ${peakScored.ranked.length} ranked, top 15:`,
    peakScored.ranked.slice(0, 15).map(fmt));
  console.log(`[crsmart] rec-rank [comfort]: ${comfortScored.ranked.length} ranked, top 15:`,
    comfortScored.ranked.slice(0, 15).map(fmt));

  // Tap-effect diagnostic: for each user-tapped tag, did the peak rec
  // pool actually surface candidates with that tag? The override
  // (stated-preference.js) fixes SCORING math but doesn't touch
  // candidate selection — `aggregateRecommendations` walks watched
  // shows and pulls their AniList recommendations. the user's shounen-
  // heavy history generates shounen recommendations; tapping "Ecchi"
  // can't surface ecchi shows that aren't in the candidate pool.
  //
  // This persists per-tag status the survey-side acknowledgment
  // surface (next commit) reads to voice "your tap fired and matches
  // X candidates" vs "your tap fired but no matching candidates —
  // want to seed the pool with top peak ecchi from AniList?"
  const overrideDiag = vectorPeak?.overrideDiag || {};
  const overrideEntries = Object.entries(overrideDiag);
  if (overrideEntries.length > 0) {
    const peakRanked = peakScored.ranked || [];
    // Centrality threshold matches the dealbreaker-rank gate elsewhere
    // in the engine — a tag at rank ≥50 means the show is meaningfully
    // about that tag, not just incidentally tagged.
    const TAG_CENTRALITY_RANK = 50;
    const perTag = {};
    for (const [tagName, diag] of overrideEntries) {
      // Two windows:
      //   - Behavioral matches: peak top 30 with this tag at rank ≥50
      //     (or as a genre). These are shows the user's history pulled in
      //     organically that happen to carry the tapped tag.
      //   - Seeded matches: any rec in the full ranked list whose
      //     _seededFromTag === tagName. These came from the seed CTA's
      //     SCORE_DESC AniList query for this exact tag, so they're
      //     canonical regardless of where they end up in the rank order
      //     (recScore=0.30 puts them mid-pool by default; whether they
      //     surface in top picks depends on the rest of the user's
      //     pool, but the seed itself succeeded).
      const matching = [];
      for (const rec of peakRanked.slice(0, 30)) {
        const tags = rec.topTags || [];
        const genres = rec.genres || [];
        const hasTag = tags.some(t => t?.tag === tagName && (t.rank || 0) >= TAG_CENTRALITY_RANK);
        const hasGenre = genres.includes(tagName);
        if (hasTag || hasGenre) {
          matching.push({
            title: rec.title?.english || rec.title?.romaji || null,
            finalScore: rec.finalScore,
            rank: peakRanked.indexOf(rec) + 1,
            viaSeed: false,
          });
        }
      }
      for (const rec of peakRanked) {
        if (rec._seededFromTag !== tagName) continue;
        if (matching.some(m => m.rank === peakRanked.indexOf(rec) + 1)) continue;
        matching.push({
          title: rec.title?.english || rec.title?.romaji || null,
          finalScore: rec.finalScore,
          rank: peakRanked.indexOf(rec) + 1,
          viaSeed: true,
        });
      }
      // Sort by rank so topMatches surfaces best-ranked first.
      matching.sort((a, b) => a.rank - b.rank);
      // Status derivation:
      //   fired + matches > 0 → 'fired-with-candidates' (best case)
      //   fired + matches = 0 → 'fired-no-candidates' (architectural gap; show seed CTA)
      //   no-op + reason='behavior-stronger' → 'noop-behavior-stronger' (history already > floor)
      //   no-op + reason='thin-vector' → 'noop-thin-vector' (peak vector empty/thin)
      let status;
      if (diag.fired) {
        status = matching.length > 0 ? 'fired-with-candidates' : 'fired-no-candidates';
      } else if (diag.reason === 'thin-vector') {
        status = 'noop-thin-vector';
      } else {
        status = 'noop-behavior-stronger';
      }
      perTag[tagName] = {
        state: diag.state,
        before: diag.before,
        after: diag.after,
        status,
        candidatesMatching: matching.length,
        topMatches: matching.slice(0, 3),
      };
    }
    await chrome.storage.local.set({
      surveyTapEffects: { perTag, computedAt: Date.now() },
    });
    // Worker log for verification — the user can paste these to diagnose
    // why a tap did or didn't move recs.
    const summary = Object.entries(perTag)
      .map(([tag, e]) => `${tag}=${e.status}(${e.candidatesMatching} matches)`)
      .join(' · ');
    console.log(`[crsmart] tap-effect diagnostic: ${summary}`);
  }
}

// One-shot probe of /cms/objects?ratings=true to learn the rating field
// shape — is it user_rating, average, both? Once we know, we can decide
// whether to plumb it into the engine as a CF-substitute signal. Logs
// the structural shape only; the user's actual rating value never lands
// in the console. Self-gates after one successful run.
async function probeRatingsShape(seriesIdSet) {
  const { _ratingsProbeDone } = await chrome.storage.local.get('_ratingsProbeDone');
  if (_ratingsProbeDone) return;
  const seriesId = [...seriesIdSet][0];
  if (!seriesId) return;
  const url = `https://www.crunchyroll.com/content/v2/cms/objects/${seriesId}`
    + `?ratings=true&preferred_audio_language=en-US&locale=en-US`;
  const result = await crFetch(url, 'ratings probe');
  if (!result.ok) {
    console.warn('[crsmart] ratings probe failed', result.message);
    return;
  }
  const json = result.data;
  const shape = describeShape(json);
  console.log('[crsmart] ratings probe — full envelope shape:', shape);
  // Most CR responses wrap the object in data[0]; surface the rating subtree
  // explicitly so it's easy to read.
  const item = json?.data?.[0];
  if (item?.rating) {
    console.log('[crsmart] ratings probe — item.rating shape:', describeShape(item.rating));
  } else {
    console.log('[crsmart] ratings probe — no item.rating subtree (key may differ)');
  }
  await chrome.storage.local.set({ _ratingsProbeDone: { at: Date.now(), seriesId } });
}

// One-shot probe of cms/objects to see whether CR exposes a franchise-
// level episode count (episode_count, season_count, etc.) directly on
// the series record. If yes we use it instead of AniList's per-season
// count — AL's per-season count was misclassifying multi-season watches
// (e.g. MHA 266 watched / 21 total → clamped to 100% completionRatio).
// Logs all top-level series keys + types. Self-gates.
async function probeSeriesShape(seriesIdSet) {
  const { _seriesProbeDone } = await chrome.storage.local.get('_seriesProbeDone');
  if (_seriesProbeDone) return;
  const seriesId = [...seriesIdSet][0];
  if (!seriesId) return;
  const url = `https://www.crunchyroll.com/content/v2/cms/objects/${seriesId}`
    + `?ratings=true&preferred_audio_language=en-US&locale=en-US`;
  const result = await crFetch(url, 'series probe');
  if (!result.ok) { console.warn('[crsmart] series probe failed', result.message); return; }
  const json = result.data;
  const item = json?.data?.[0];
  if (!item) { console.log('[crsmart] series probe — empty data'); return; }
  console.log('[crsmart] series probe — seriesId:', seriesId);
  console.log('[crsmart] series probe — top-level keys + types:', describeShape(item, 1));
  // Surface any nested series_metadata/episode_metadata subtree so we can
  // see if the franchise counts live under a nested object.
  for (const k of Object.keys(item)) {
    const v = item[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      console.log(`[crsmart] series probe — nested '${k}':`, describeShape(v, 1));
    }
  }
  await chrome.storage.local.set({ _seriesProbeDone: { at: Date.now(), seriesId } });
}

// Fetch CR's own per-series season list. The series_metadata.season_count
// on cms/objects is a raw row count — for shows like Re:Zero it includes
// the Director's Cut as a separate "season", and for Slime the split
// cours ('S2 Part 2') are separate rows too. /seasons exposes each row's
// title + episode counts so we can filter to what a human would call a
// TV season before reporting it in the commitment line.
async function fetchCrSeasons(seriesId) {
  const url = `https://www.crunchyroll.com/content/v2/cms/series/${seriesId}/seasons`
    + `?preferred_audio_language=en-US&locale=en-US`;
  const result = await crFetch(url, `seasons ${seriesId}`);
  if (!result.ok) {
    console.warn('[crsmart] seasons failed', seriesId, result.message);
    return null;
  }
  const json = result.data;
  return Array.isArray(json?.data) ? json.data : null;
}

// One-shot probe of /seasons so we can see the row-level fields without
// logging any user content. Self-gates so it only runs once across the
// lifetime of the install.
async function probeCrSeasonsShape(seriesId) {
  const { _seasonsProbeDone } = await chrome.storage.local.get('_seasonsProbeDone');
  if (_seasonsProbeDone) return;
  const seasons = await fetchCrSeasons(seriesId);
  if (!seasons?.length) return;
  console.log('[crsmart] seasons probe — seriesId:', seriesId, 'rows:', seasons.length);
  console.log('[crsmart] seasons probe — row keys + types:', describeShape(seasons[0], 1));
  // Log just the title + a couple of boolean-looking fields from each
  // row. Titles aren't user data and are essential for checking the
  // filter heuristic against the actual response.
  const rowSummary = seasons.map(s => {
    const keys = Object.keys(s);
    const flags = {};
    for (const k of keys) {
      const v = s[k];
      if (typeof v === 'boolean') flags[k] = v;
    }
    return { title: s.title, season_number: s.season_number, flags };
  });
  console.log('[crsmart] seasons probe — row summary:', rowSummary);
  await chrome.storage.local.set({ _seasonsProbeDone: { at: Date.now(), seriesId } });
}

// Schema diagnostic: structural keys only, never values. Lets us verify
// that the projection assumptions hold against the live API without
// putting user data in logs.
function describeShape(obj, depth = 0) {
  if (depth > 2 || obj == null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) return `[len ${obj.length}]`;
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    out[k] = (v && typeof v === 'object') ? describeShape(v, depth + 1) : typeof v;
  }
  return out;
}
