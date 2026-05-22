// External-list importer — orchestrates AniList + MAL list imports
// into the Sentiment seam.
//
// Public interface:
//   importFromAniList(opts)  → runs full AL import; resolves with
//                              { imported: N, source: 'anilist' }
//   importFromMal(opts)      → runs full MAL import; resolves with
//                              { imported: N, source: 'mal' }
//   getImportState()         → returns the current _importState
//                              (progress + accumulator) or null
//   cancelActiveImport()     → aborts any in-flight import via the
//                              shared AbortController; the next
//                              runImport call sees a cleared state
//
// Architecture decisions locked in the 2026-05-04 grilling (#1):
//   - Coalescing at the importer boundary — one storage.set per
//     source on completion (the recompute-triggering write); progress
//     reported separately via the synthetic _importState key (NOT in
//     the pipeline-input set, never triggers recompute).
//   - Accumulator + progress persisted to _importState on every
//     chunk for SW-restart resilience. SW idle-out during a long
//     enrichment phase means the in-memory state would otherwise be
//     lost; persistence makes the import resumable.
//   - Lives as one module (this file). Per-source fetcher functions
//     (anilist.fetchUserList, mal.fetchUserList) are imported and
//     called from the orchestration logic; cross-source concerns
//     (MAL → AL ID cross-walk, accumulator-flush, recompute trigger)
//     are local.
//
// Pipeline interaction:
//   - Writes to externalScores fire the storage.onChanged listener
//     (background.js owns that listener); when externalScores is
//     wired into the pipeline-runner's input set, the recompute
//     fires automatically. Until that wiring lands (step 5), this
//     module simply persists; no recompute happens yet.

import { STORAGE_KEYS } from './storage-schema.js';
import { getValidToken, getAccount, AuthError } from './oauth-manager.js';
import {
  fetchUserListByName as alFetchUserListByName,
  bulkLookupByMalIds,
  bulkFetchByIds,
} from './anilist.js';
import { fetchUserList as malFetchUserList } from './mal.js';
import * as cache from './cache-store.js';

// ── Active-import shared state ──────────────────────────────────
// Single in-flight import at a time. The popup invokes via message
// to background.js; background routes to importFromAniList or
// importFromMal; this module enforces the singleton.

let activeAbortController = null;

export function cancelActiveImport() {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
}

// ── Storage helpers ─────────────────────────────────────────────

async function readImportState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS._importState);
  return stored[STORAGE_KEYS._importState] || null;
}

async function writeImportState(state) {
  if (state == null) {
    await chrome.storage.local.remove(STORAGE_KEYS._importState);
  } else {
    await chrome.storage.local.set({ [STORAGE_KEYS._importState]: state });
  }
}

export async function getImportState() {
  return readImportState();
}

// Capture a lightweight snapshot of the engine state right now and
// persist it as `_engineImpactBefore[source]`. Used by the popup
// status handler to compute a before-vs-after diff once the import's
// recompute lands. Reads ONLY storage keys the engine already writes
// (no compute), so cost is dominated by IPC. Snapshot shape is
// intentionally small — top-5s of each ranking — so subsequent diff
// rendering doesn't have to filter or rank.
async function captureEngineSnapshot(source) {
  const stored = await chrome.storage.local.get([
    'tasteVectorAll',
    'archetypeBlend',
    'studioCreatorIndex',
    'tasteDimensions',
  ]);
  const tasteVec = stored.tasteVectorAll || {};
  const archBlend = stored.archetypeBlend?.archetypes || stored.archetypeBlend || [];
  const studioIdxFull = stored.studioCreatorIndex || {};
  const studioIdx = studioIdxFull.studios || {};
  const dims = stored.tasteDimensions?.dimensions || stored.tasteDimensions || {};

  // Top studios by total weight. studioCreatorIndex now ships a
  // pre-computed topStudios array (top-30 ids, sorted desc by
  // totalWeight) — read that and cross-reference studioIdx for the
  // display fields. Falls back to the old compute-on-read path for
  // entries written before the 2026-05-19 migration.
  const topStudiosIds = Array.isArray(studioIdxFull.topStudios)
    ? studioIdxFull.topStudios.slice(0, 5)
    : Object.values(studioIdx)
        .sort((a, b) => (b.totalWeight || 0) - (a.totalWeight || 0))
        .slice(0, 5)
        .map(s => s.id);
  const topStudios = topStudiosIds
    .map(id => studioIdx[id])
    .filter(Boolean)
    .map(s => ({ id: s.id, name: s.name, weight: +(s.totalWeight || 0).toFixed(3) }));

  // Top dimensions by magnitude. scoreDimensions's sortedness contract
  // covers score-desc; this snapshot sorts by magnitude (a different
  // signal — strength of evidence vs alignment direction). So the
  // sort here is legitimate work, not a defensive re-sort.
  const dimsArr = Array.isArray(dims) ? dims : Object.values(dims);
  const topDimensions = dimsArr
    .filter(d => typeof d.magnitude === 'number')
    .sort((a, b) => (b.magnitude || 0) - (a.magnitude || 0))
    .slice(0, 5)
    .map(d => ({ id: d.id, name: d.name, magnitude: +(d.magnitude || 0).toFixed(2) }));

  // Top archetypes by score. archetypeBlend is sorted desc by score
  // by scoreArchetypes (see archetypes.js's sortedness contract).
  const archArr = Array.isArray(archBlend) ? archBlend : [];
  const topArchetypes = archArr
    .slice(0, 5)
    .map(a => ({ id: a.id || a.name, name: a.name, score: +(a.score || 0).toFixed(4) }));

  const snapshot = {
    capturedAt: Date.now(),
    tasteTags: Object.keys(tasteVec.raw || {}).length,
    contributingSeries: tasteVec.contributingSeries || null,
    topArchetypes,
    topStudios,
    topDimensions,
  };

  // Stored under a single per-source map so re-imports overwrite
  // their own slot without disturbing other sources.
  const existingWrap = await chrome.storage.local.get('_engineImpactBefore');
  const before = existingWrap._engineImpactBefore || {};
  before[source] = snapshot;
  await chrome.storage.local.set({ _engineImpactBefore: before });
}

// Merge per-source entries into externalScores. Each call replaces
// the slot for the importing source while preserving any other
// source's slot for the same Series. Atomic — single read + single
// write — and this is the only recompute-triggering write the import
// performs.
// Accepts an optional bridgeCacheDelta — entries from this run's
// enrichment that haven't been persisted yet. Bundling both keys into
// a single storage.set call halves the IPC round-trip cost and keeps
// the two pieces of state mutually consistent (bridge cache contains
// every aniListId referenced by the externalScores write below it).
async function flushExternalScores(source, accumulator, bridgeCacheDelta = null) {
  // Bridge-first ordering preserves the load-bearing invariant: every
  // aniListId referenced by externalScores must already be present in
  // aniListBridgeCache by the time downstream sees the externalScores
  // change. Splitting the prior atomic write into bridge → externalScores
  // keeps that invariant intact (we lose IPC atomicity but gain TTL +
  // in-memory mirror on the bridge side).
  if (bridgeCacheDelta && Object.keys(bridgeCacheDelta).length > 0) {
    await cache.putBatch('aniListBridgeCache', bridgeCacheDelta);
  }

  const existingWrap = await chrome.storage.local.get(STORAGE_KEYS.externalScores);
  const existing = existingWrap[STORAGE_KEYS.externalScores] || {};
  // Treat the import as a *replace* of the source's slot, not a
  // patch. If the user un-rated a show on AL (or removed it from
  // their list entirely), it won't appear in this import's
  // accumulator. The previous run's entry would otherwise stay
  // orphaned, silently maintaining a deleted rating in the engine.
  // Walk existing entries and drop this-source's slot for any
  // aniListId not in the new accumulator. 2026-05-04 audit fix.
  let removedStale = 0;
  for (const aniListIdStr of Object.keys(existing)) {
    if (!(aniListIdStr in accumulator) && existing[aniListIdStr]?.[source]) {
      delete existing[aniListIdStr][source];
      removedStale++;
      if (Object.keys(existing[aniListIdStr]).length === 0) {
        delete existing[aniListIdStr];
      }
    }
  }
  for (const [aniListId, entry] of Object.entries(accumulator)) {
    if (!existing[aniListId]) existing[aniListId] = {};
    existing[aniListId][source] = entry;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.externalScores]: existing });
  if (removedStale > 0) {
    console.log(`[crsmart] import (${source}): cleaned ${removedStale} stale entries (un-rated since last import)`);
  }
  return Object.keys(accumulator).length;
}

// ── Enrichment cache check ──────────────────────────────────────
// Before kicking off bulkFetchByIds, prune the candidate set to IDs
// not already in aniListBridgeCache. Reduces the AL request budget
// proportional to how much overlap there is between the user's
// imported list and shows they've already watched on CR.

async function listMissingFromBridgeCache(aniListIds) {
  // getStaleIds returns ids that need a fresh fetch — handles both
  // missing and TTL-stale entries uniformly. Free reuse of cache
  // freshness logic.
  return cache.getStaleIds('aniListBridgeCache', aniListIds);
}

// ── Stage runners ───────────────────────────────────────────────

async function fetchSourceList(source, signal) {
  if (source === 'anilist') {
    // Public username fetch — no OAuth token. The username is stored under
    // the account record at link time (see linkAniListByUsername).
    const account = await getAccount('anilist');
    const userName = account?.name;
    if (!userName) {
      throw new Error('AniList not linked — enter your AniList username first');
    }
    const { list } = await alFetchUserListByName(userName);
    return list;
  }
  if (source === 'mal') {
    const token = await getValidToken('mal');
    return await malFetchUserList(token, { signal });
  }
  throw new Error(`Unknown source: ${source}`);
}

// MAL entries → aniListId-keyed map. Drops MAL IDs that AniList
// doesn't recognize (rare but possible — newly-added MAL shows that
// AL hasn't catalogued, or community-only MAL entries).
async function crossWalkMalToAniList(malEntries, signal, onProgress) {
  const malIds = Object.keys(malEntries).map(Number).filter(Number.isInteger);
  if (malIds.length === 0) return {};
  const malToAl = await bulkLookupByMalIds(malIds, {
    signal,
    onBatch: ({ done, total }) => onProgress?.({ phase: 'crosswalk', done, total }),
  });
  const out = {};
  let mapped = 0;
  let dropped = 0;
  for (const malId of malIds) {
    const aniListId = malToAl[malId];
    if (aniListId) {
      out[aniListId] = malEntries[malId];
      mapped++;
    } else {
      dropped++;
    }
  }
  console.log(`[crsmart] import (mal): cross-walked ${mapped}/${malIds.length} entries (${dropped} dropped — no AL counterpart)`);
  return out;
}

// Returns the enriched-Media delta keyed by aniListId; caller is
// responsible for persisting (flushExternalScores below batches the
// bridge-cache merge into the same storage.set as externalScores
// so both keys move atomically). Returns null when no enrichment
// was needed (all IDs already in bridge cache).
async function enrichMissing(aniListIds, signal, onProgress) {
  const missing = await listMissingFromBridgeCache(aniListIds);
  if (missing.length === 0) {
    console.log('[crsmart] import: 0 enrichment fetches needed (all in bridge cache)');
    return null;
  }
  console.log(`[crsmart] import: enriching ${missing.length}/${aniListIds.length} unknown IDs`);
  return await bulkFetchByIds(missing, {
    signal,
    onBatch: ({ done, total }) => onProgress?.({ phase: 'enrich', done, total }),
  });
}

// ── Top-level orchestrator ──────────────────────────────────────

async function runImport(source, opts = {}) {
  if (activeAbortController) {
    throw new Error('An import is already in flight — cancel it first or wait for it to finish');
  }
  const ac = new AbortController();
  activeAbortController = ac;
  const startedAt = Date.now();
  try {
    // Stage 0: capture pre-import engine state per-source so the
    // popup can show a "what changed" diff after the recompute lands.
    // Reads taste-vector tag count, archetype blend top-5, studio top-5,
    // dimension top-5 from existing storage keys (cheap — no compute,
    // just reads outputs the engine already persists).
    await captureEngineSnapshot(source);

    await writeImportState({
      source,
      phase: 'fetch-list',
      startedAt,
      progress: { phase: 'fetch-list', done: 0, total: 0 },
    });

    // Stage 1: obtain the source's list. API path fetches over the
    // network; XML-import path receives pre-parsed entries from the
    // caller (importFromMalXml). Same downstream shape either way.
    const rawEntries = opts.prefetched != null
      ? opts.prefetched
      : await fetchSourceList(source, ac.signal);
    const rawCount = Object.keys(rawEntries).length;
    const fetchLabel = opts.prefetched != null ? 'parsed-xml' : 'fetched';
    console.log(`[crsmart] import (${source}): ${fetchLabel} ${rawCount} list entries`);

    // Stage 2: cross-walk if MAL.
    let entriesByAlId;
    if (source === 'mal') {
      await writeImportState({
        source, phase: 'crosswalk', startedAt,
        progress: { phase: 'crosswalk', done: 0, total: rawCount },
      });
      entriesByAlId = await crossWalkMalToAniList(rawEntries, ac.signal, async (progress) => {
        await writeImportState({ source, phase: 'crosswalk', startedAt, progress });
      });
    } else {
      entriesByAlId = rawEntries;
    }
    const alIdCount = Object.keys(entriesByAlId).length;

    // Stage 3: enrich unknown AL IDs (delta returned, not yet
    // persisted — flushExternalScores below batches the bridge-cache
    // merge into the same storage.set as externalScores so both keys
    // move atomically).
    await writeImportState({
      source, phase: 'enrich', startedAt,
      progress: { phase: 'enrich', done: 0, total: alIdCount },
    });
    const enrichedDelta = await enrichMissing(
      Object.keys(entriesByAlId).map(Number),
      ac.signal,
      async (progress) => {
        await writeImportState({ source, phase: 'enrich', startedAt, progress });
      },
    );

    // Stage 4: atomic flush of bridge-cache delta + externalScores in
    // a single storage.set call.
    // This is the only recompute-triggering write of the entire import.
    await writeImportState({
      source, phase: 'flush', startedAt,
      progress: { phase: 'flush', done: 0, total: alIdCount },
    });
    const written = await flushExternalScores(source, entriesByAlId, enrichedDelta);
    console.log(`[crsmart] import (${source}): wrote ${written} externalScores entries`);

    // Stage 5: clear progress state. The recompute kicked off by the
    // externalScores write will run independently.
    await writeImportState(null);

    return { source, imported: written, durationMs: Date.now() - startedAt };
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.log(`[crsmart] import (${source}): cancelled by user`);
      // Leave _importState in place for diagnostics; the user can
      // re-run import to overwrite it.
      throw err;
    }
    if (err instanceof AuthError) {
      // Surface auth errors verbatim; the popup needs the typed error
      // to know whether to prompt re-auth vs show a generic failure.
      throw err;
    }
    console.error(`[crsmart] import (${source}) failed:`, err);
    await writeImportState({
      source,
      phase: 'error',
      startedAt,
      error: String(err.message || err),
    });
    throw err;
  } finally {
    if (activeAbortController === ac) activeAbortController = null;
  }
}

export async function importFromAniList() {
  return runImport('anilist');
}

export async function importFromMal() {
  return runImport('mal');
}

// XML-export import path — used when the user can't (or doesn't want
// to) go through MAL's API approval. parseMalXmlExport in mal-xml.js
// produces the same { [malId]: { score, status, progress, updatedAt }}
// shape that fetchUserList does, so we just feed it in as prefetched
// and let runImport handle the cross-walk + enrich + flush stages.
// Source label stays 'mal' so engine snapshots / externalScores keys
// don't fragment across import methods.
export async function importFromMalXml(parsedEntries) {
  if (!parsedEntries || typeof parsedEntries !== 'object') {
    throw new Error('importFromMalXml: parsedEntries must be the object returned by parseMalXmlExport');
  }
  return runImport('mal', { prefetched: parsedEntries });
}

// Clear one source's contribution from externalScores. Walks every
// aniListId, drops the named source slot, drops the parent entry if
// it becomes empty (no other sources still contributing). Returns the
// number of source-slot deletions. The storage.set triggers the
// pipeline-runner's recompute the same way an import write does, so
// the user sees their taste vector / scores update without an explicit
// recompute call here.
//
// Used by the popup's "clear" affordance on the MAL XML row. AniList
// signout currently leaves data in place (only revokes the token); if
// AniList ever wants the same "clear data" UX, calling this with
// source='anilist' does the job.
export async function clearSourceData(source) {
  if (typeof source !== 'string' || !source) {
    throw new Error('clearSourceData: source must be a non-empty string');
  }
  const wrap = await chrome.storage.local.get(STORAGE_KEYS.externalScores);
  const existing = wrap[STORAGE_KEYS.externalScores] || {};
  let dropped = 0;
  for (const aniListIdStr of Object.keys(existing)) {
    if (existing[aniListIdStr]?.[source]) {
      delete existing[aniListIdStr][source];
      dropped++;
      if (Object.keys(existing[aniListIdStr]).length === 0) {
        delete existing[aniListIdStr];
      }
    }
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.externalScores]: existing });
  console.log(`[crsmart] clearSourceData (${source}): dropped ${dropped} entries`);
  return { source, dropped };
}

// ── Freeform-notes import path ──────────────────────────────────────
//
// Third public entry, peer to importFromAniList/importFromMal. Unlike
// the API paths, freeform receives entries already resolved to AL IDs
// by the UI's parser+matcher+review-screen chain (freeform-parser.js +
// freeform-matcher.js + import-freeform UI). So it skips the fetch and
// MAL→AL cross-walk stages and goes straight to enrich + flush.
//
// Entry shape (per the 2026-05-18 grill, Q5/Q6/Q8):
//   {
//     aniListId: number,
//     titleRaw: string,
//     status: 'watching'|'completed'|'paused'|'dropped'|'planning'|null,
//     score: 0-10 | null,
//     scoreOriginal: string | null,   // user-visible token preserved
//     scoreScale: '10pt-slash'|'5pt-slash'|'5-star'|'tier'|'word'|'10pt-bare'|null,
//     isFavorite: bool,
//     userTagsFromImport: string[],
//     matchedVia: 'freeform-local-exact'|'freeform-local-acronym'|
//                 'freeform-local-fuzz'|'freeform-al-search'|'user-confirmed',
//     confidence: 0-1,
//     lockedByUser: bool,             // true if user touched in review
//   }
//
// Re-import semantics (Q8): upsert by AL ID; user-confirmed entries
// (`lockedByUser: true`) survive across re-imports even when not in
// the new accumulator. Implemented here, not in flushExternalScores,
// so the shared flush stays semantically simple.

const FREEFORM_SOURCE = 'freeform';

// Pull existing freeform slots and copy any lockedByUser entries that
// aren't represented in the new accumulator into it. The accumulator
// passed downstream now carries the full intent for this source's
// per-AL-ID slot, so flushExternalScores's replace-semantics doesn't
// wipe user-confirmed work.
async function preserveLockedFreeformEntries(accumulator) {
  const wrap = await chrome.storage.local.get(STORAGE_KEYS.externalScores);
  const existing = wrap[STORAGE_KEYS.externalScores] || {};
  let preserved = 0;
  for (const aniListIdStr of Object.keys(existing)) {
    const slot = existing[aniListIdStr]?.[FREEFORM_SOURCE];
    if (!slot || !slot.lockedByUser) continue;
    if (aniListIdStr in accumulator) continue;
    accumulator[aniListIdStr] = slot;
    preserved += 1;
  }
  if (preserved > 0) {
    console.log(`[crsmart] import (freeform): preserved ${preserved} locked entries across re-import`);
  }
  return preserved;
}

// Build the per-aniListId accumulator from an array of resolved
// freeform entries. Pure: takes entries, returns map. Dedups by
// aniListId — if a list contains two rows that resolved to the same
// AL ID (e.g. user pasted Vinland twice), the later row wins. Drops
// entries with no aniListId (defensive — the UI should filter these
// before calling, but belt + suspenders).
function buildFreeformAccumulator(entries) {
  const out = {};
  let dropped = 0;
  for (const e of entries) {
    if (!e || !e.aniListId) { dropped += 1; continue; }
    const aniListId = Number(e.aniListId);
    if (!Number.isInteger(aniListId) || aniListId <= 0) { dropped += 1; continue; }
    out[aniListId] = {
      score: typeof e.score === 'number' ? e.score : null,
      scoreOriginal: e.scoreOriginal || null,
      scoreScale: e.scoreScale || null,
      status: e.status || null,
      isFavorite: !!e.isFavorite,
      userTagsFromImport: Array.isArray(e.userTagsFromImport) ? e.userTagsFromImport : [],
      titleRaw: e.titleRaw || null,
      matchedVia: e.matchedVia || 'freeform-local-fuzz',
      confidence: typeof e.confidence === 'number' ? e.confidence : null,
      lockedByUser: !!e.lockedByUser,
      updatedAt: new Date().toISOString().slice(0, 10),
      _source: FREEFORM_SOURCE,
    };
  }
  if (dropped > 0) {
    console.warn(`[crsmart] import (freeform): dropped ${dropped} entries with missing/invalid aniListId`);
  }
  return out;
}

// One-time backfill — stamp legacy MAL/AL/MAL-XML entries with
// `confidence: 1.0` and a `matchedVia` derived from their existing
// `_source` field. Required because Q6 made confidence a per-entry
// property and Q8's cross-source resolution (Math.max confidence)
// needs every entry to carry one. Without backfill, a freeform entry
// at 0.92 would override a legacy MAL XML entry that has no
// confidence field — wrong.
//
// Idempotent: re-running on already-stamped entries is a no-op. Safe
// to invoke on every freeform import as a guard; only the first call
// does real work.
export async function backfillConfidenceMetadata() {
  const wrap = await chrome.storage.local.get(STORAGE_KEYS.externalScores);
  const existing = wrap[STORAGE_KEYS.externalScores] || {};
  let stamped = 0;
  for (const aniListIdStr of Object.keys(existing)) {
    const sources = existing[aniListIdStr];
    if (!sources || typeof sources !== 'object') continue;
    for (const sourceKey of Object.keys(sources)) {
      if (sourceKey === FREEFORM_SOURCE) continue; // freeform always carries its own
      const slot = sources[sourceKey];
      if (!slot || typeof slot !== 'object') continue;
      let changed = false;
      if (typeof slot.confidence !== 'number') {
        slot.confidence = 1.0;
        changed = true;
      }
      if (typeof slot.matchedVia !== 'string') {
        // Derive matchedVia from how the entry was originally written.
        // The _source field is what existing writers stamp; the XML path
        // also adds _source:'xml' on top of the source key, so prefer
        // that for finer routing.
        if (slot._source === 'xml') slot.matchedVia = 'mal-xml';
        else if (sourceKey === 'anilist') slot.matchedVia = 'anilist-api';
        else if (sourceKey === 'mal') slot.matchedVia = 'mal-api';
        else slot.matchedVia = `unknown-pre-migration-${sourceKey}`;
        changed = true;
      }
      if (typeof slot.lockedByUser !== 'boolean') {
        slot.lockedByUser = false;
        changed = true;
      }
      if (changed) stamped += 1;
    }
  }
  if (stamped > 0) {
    await chrome.storage.local.set({ [STORAGE_KEYS.externalScores]: existing });
    console.log(`[crsmart] backfillConfidenceMetadata: stamped ${stamped} legacy entries`);
  }
  return { stamped };
}

// Top-level orchestrator for freeform import. Mirrors runImport's
// stage flow but skips fetch + cross-walk (caller provides resolved
// entries) and adds the locked-entry preservation step + backfill.
async function runFreeformImport(entries, opts = {}) {
  if (activeAbortController) {
    throw new Error('An import is already in flight — cancel it first or wait for it to finish');
  }
  const ac = new AbortController();
  activeAbortController = ac;
  const startedAt = Date.now();
  const source = FREEFORM_SOURCE;

  try {
    // Stage 0: pre-import engine snapshot, same shape the API paths use.
    await captureEngineSnapshot(source);

    // Stage 0.5: backfill legacy entries so cross-source confidence
    // semantics work cleanly from the first freeform write onward.
    // Idempotent — only does real work on the first call.
    await backfillConfidenceMetadata();

    await writeImportState({
      source, phase: 'build-accumulator', startedAt,
      progress: { phase: 'build-accumulator', done: 0, total: entries.length },
    });

    // Stage 1: build the per-AL-ID accumulator from caller's entries.
    const accumulator = buildFreeformAccumulator(entries);
    const inputCount = Object.keys(accumulator).length;

    // Stage 2: preserve lockedByUser entries from prior freeform writes
    // that aren't in this batch. Q8's "user-confirmed entries are
    // sticky" guarantee.
    const preservedCount = await preserveLockedFreeformEntries(accumulator);
    const accumulatorCount = Object.keys(accumulator).length;
    console.log(`[crsmart] import (freeform): ${inputCount} input + ${preservedCount} locked = ${accumulatorCount} total`);

    // Stage 3: enrich missing AL IDs. Same pipeline as MAL/AL paths.
    await writeImportState({
      source, phase: 'enrich', startedAt,
      progress: { phase: 'enrich', done: 0, total: accumulatorCount },
    });
    const enrichedDelta = await enrichMissing(
      Object.keys(accumulator).map(Number),
      ac.signal,
      async (progress) => {
        await writeImportState({ source, phase: 'enrich', startedAt, progress });
      },
    );

    // Stage 4: atomic flush.
    await writeImportState({
      source, phase: 'flush', startedAt,
      progress: { phase: 'flush', done: 0, total: accumulatorCount },
    });
    const written = await flushExternalScores(source, accumulator, enrichedDelta);
    console.log(`[crsmart] import (freeform): wrote ${written} externalScores entries`);

    // Stage 5: clear progress.
    await writeImportState(null);

    return {
      source,
      imported: written,
      preserved: preservedCount,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.log('[crsmart] import (freeform): cancelled by user');
      throw err;
    }
    console.error('[crsmart] import (freeform) failed:', err);
    await writeImportState({
      source,
      phase: 'error',
      startedAt,
      error: String(err.message || err),
    });
    throw err;
  } finally {
    if (activeAbortController === ac) activeAbortController = null;
  }
}

// Public entry — called from the UI's import-freeform surface after
// the user clicks Apply on the review screen. `entries` is the
// post-review list with every row carrying an aniListId (rows the
// user couldn't or didn't resolve are filtered upstream).
export async function importFromFreeform({ entries }) {
  if (!Array.isArray(entries)) {
    throw new TypeError('importFromFreeform: entries must be an array');
  }
  return runFreeformImport(entries);
}

// Internal exports for tests. Test-only — production code should use
// the public importFromFreeform entry above.
export const _freeformInternals = Object.freeze({
  buildFreeformAccumulator,
  preserveLockedFreeformEntries,
  FREEFORM_SOURCE,
});
