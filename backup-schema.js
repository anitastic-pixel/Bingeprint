// Backup / restore — format spec, bucket→keys mapping, envelope helpers.
//
// Single source of truth shared by the export panel (popup.js) and the
// import flow (import.js). Encapsulates:
//
//   1. BACKUP_SCHEMA_VERSION — bump when the file format changes in
//      ways that require migration (key renames, structural changes).
//   2. BACKUP_BUCKETS — which storage keys belong to which bucket. The
//      4 user-facing toggles (cr / anilist / survey / settings) plus
//      engineOutput which auto-rides whenever any source bucket ships.
//   3. buildBackupEnvelope({ buckets, includeAnilistOAuth }) — reads
//      chrome.storage.local and produces the JSON envelope to download.
//   4. parseBackupEnvelope(json) — validates an incoming file's
//      envelope shape, schema version, and basic structure. Throws
//      typed errors so import.js can map to user-readable messages.
//   5. restoreBackup(buckets, opts) — atomic write: snapshot affected
//      keys, single chrome.storage.local.set, restore on error.
//   6. shouldUseBackedUpEngineOutput(deviceState, fileEnvelope) — the
//      smart-conditional rule from the design grilling: file's
//      engineOutput is authoritative iff the import covers every
//      source bucket the device will end up with.
//
// Non-module script — exposes its API as `window.crsmartBackupSchema`
// to match the existing popup.js convention (popup.html includes plain
// <script src="..."> tags, not type="module").

(function () {
  'use strict';

  // Bump when the file format changes in ways that need migration.
  // Reserved at 1 even though there are no migrations yet, so future
  // bumps have a chain to start from.
  const BACKUP_SCHEMA_VERSION = 1;

  // Source buckets — user toggles on the export side. Order matters
  // for the smart-conditional rule: we iterate this list to determine
  // device coverage, and we render checkboxes in this order.
  const SOURCE_BUCKETS = ['cr', 'anilist', 'survey', 'settings'];

  // Bucket → list of chrome.storage.local keys.
  //
  // Excluded from every bucket (intentional):
  //   _importState        — synthetic, transient (in-flight progress)
  //   _devAxisSandbox     — dev-only slider state
  //   _tagNameDumpDone    — one-shot diag stamp
  //   _tourMetrics        — local funnel stats; personal usage data,
  //                         not portable (a fresh user starts at zero)
  //   _engineHealth       — diagnostic snapshot, regenerated each cycle
  //
  // Session-storage keys (crToken, crTokenAt) are also out of scope —
  // they're cleared on browser restart and re-derived from the live
  // CR session.
  const BACKUP_BUCKETS = Object.freeze({
    cr: [
      'watchShapes',
      'profileId',
      'lastSeenAt',
      'crSeriesMeta',
      'crToAniListId',
      'crHistorySummary',
      'crHistoryProgress',
      'crHistorySyncing',
      'popularSeedDone',
      'crWatchlist',
      'crPersonalRecs',
    ],
    anilist: [
      'externalScores',
      'aniListMeta',
      'anilistFetchProgress',
      // 'oauthTokens' — included only when includeAnilistOAuth=true
      // (filtered to .anilist only — see filterOAuthTokens below).
    ],
    survey: [
      'surveyShapes',
      'surveyTagShapes',
      'surveyStudioShapes',
      'surveyApplyState',
      'surveyViewPref',
      'surveyActiveMode',
      'surveyMatureFilter',
      'surveyServiceFilter',
      'surveyOnboardingDismissed',
      'userRatings',
      'userReactions',
    ],
    settings: [
      'surfaceSettings',
      'tourSeen',
    ],
    // engineOutput rides along automatically whenever any source bucket
    // is selected. Includes the bridge cache (huge, expensive to rebuild)
    // because it's the dominant cost the user is trying to avoid by
    // backing up at all.
    engineOutput: [
      'tasteVector',
      'tasteVectorPeak',
      'tasteVectorComfort',
      'archetypeBlend',
      'tasteDimensions',
      'tasteShapeRadar',
      'dealbreakerCandidates',
      'studioCreatorIndex',
      'watchHistoryScored',
      'recommendationCandidates',
      'recommendationsScored',
      'allShowsScored',
      'allShowsScoredMeta',
      'aniListCache',
      'aniListBridgeCache',
      'qualityIndex',
      'qualityCorpusMeta',
    ],
  });

  // ── Build (export) ────────────────────────────────────────────

  // Read chrome.storage.local and produce the envelope JSON.
  // opts.buckets — array of source-bucket names to include
  // opts.includeAnilistOAuth — if true AND 'anilist' in buckets, also
  //   ship oauthTokens.anilist (filtered — never includes other
  //   sources' tokens like MAL).
  // opts.includeEngineOutput — overrides the default (rides along
  //   when any source bucket is selected). Lets a caller force-skip
  //   the heavy keys for a "lite" export.
  async function buildBackupEnvelope(opts = {}) {
    const buckets = (opts.buckets || []).filter(b =>
      Object.prototype.hasOwnProperty.call(BACKUP_BUCKETS, b) && b !== 'engineOutput'
    );
    const includeOAuth = !!opts.includeAnilistOAuth;
    const wantEngineOutput = opts.includeEngineOutput !== false &&
                              hasAnySourceBucket(buckets);

    // Collect the union of keys to read in one IPC.
    const keysToRead = new Set();
    for (const bucket of buckets) {
      for (const k of BACKUP_BUCKETS[bucket]) keysToRead.add(k);
    }
    if (wantEngineOutput) {
      for (const k of BACKUP_BUCKETS.engineOutput) keysToRead.add(k);
    }
    if (includeOAuth && buckets.includes('anilist')) {
      keysToRead.add('oauthTokens');
    }
    const stored = await readManyStorageKeys([...keysToRead]);

    // Pack into bucket-shaped sub-objects. Keys whose value is missing
    // (undefined / null) are skipped so the file isn't padded with
    // `"key": null` entries.
    const envelope = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      extensionVersion: getExtensionVersion(),
      buckets: {},
    };
    for (const bucket of buckets) {
      envelope.buckets[bucket] = pickPresent(stored, BACKUP_BUCKETS[bucket]);
    }
    if (wantEngineOutput) {
      envelope.buckets.engineOutput = pickPresent(stored, BACKUP_BUCKETS.engineOutput);
    }
    if (includeOAuth && buckets.includes('anilist') && stored.oauthTokens) {
      const tokens = filterOAuthTokens(stored.oauthTokens, ['anilist']);
      if (Object.keys(tokens).length > 0) {
        envelope.buckets.anilist.oauthTokens = tokens;
      }
    }
    return envelope;
  }

  // ── Parse (import) ────────────────────────────────────────────

  // Validate an envelope shape. Throws BackupParseError with a typed
  // `code` so callers can render appropriate UI:
  //   - 'invalid-json'        — not parseable as JSON
  //   - 'missing-envelope'    — JSON is OK but doesn't look like a backup
  //   - 'schema-too-new'      — schemaVersion > BACKUP_SCHEMA_VERSION
  //   - 'unknown-bucket'      — bucket name we don't recognise (warning,
  //                             not fatal — can be ignored on restore)
  function parseBackupEnvelope(json) {
    let parsed;
    try { parsed = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (err) {
      throw mkError('invalid-json', 'This file isn\'t valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' ||
        typeof parsed.schemaVersion !== 'number' ||
        typeof parsed.buckets !== 'object' || parsed.buckets === null) {
      throw mkError('missing-envelope',
        'This doesn\'t look like a Smart Scoring backup.');
    }
    if (parsed.schemaVersion > BACKUP_SCHEMA_VERSION) {
      throw mkError('schema-too-new',
        `This backup is from a newer version of Smart Scoring ` +
        `(schema v${parsed.schemaVersion}, this build supports v${BACKUP_SCHEMA_VERSION}). ` +
        'Update the extension and try again.');
    }
    // Future: lower schemaVersion → run migrations here.

    // Surface unknown buckets but don't reject — forward-compat hook.
    const knownBuckets = Object.keys(BACKUP_BUCKETS);
    const unknownBuckets = Object.keys(parsed.buckets).filter(b => !knownBuckets.includes(b));

    return {
      schemaVersion: parsed.schemaVersion,
      exportedAt: parsed.exportedAt || null,
      extensionVersion: parsed.extensionVersion || null,
      buckets: parsed.buckets,
      unknownBuckets,
    };
  }

  // ── Smart-conditional engineOutput trust rule ─────────────────
  //
  // Use the file's engineOutput iff the import will cover every
  // source bucket that the device has data in. Otherwise the
  // post-import source state mixes file + device, and the file's
  // engineOutput (computed from the file's source data alone) is
  // wrong for the merged state — caller should recompute.
  //
  // deviceState.sourceBucketsWithData — array of bucket names where
  //   the device currently has some data; computed from a fresh
  //   chrome.storage.local read by import.js.
  // fileEnvelope — parsed envelope from parseBackupEnvelope.
  // selectedBuckets — array of bucket names the user opted to
  //   restore (per-bucket override checkboxes). Defaults to all
  //   source buckets present in the file.
  function shouldUseBackedUpEngineOutput(deviceState, fileEnvelope, selectedBuckets = null) {
    if (!fileEnvelope?.buckets?.engineOutput) return false;
    const fileSourceBucketsSelected = (selectedBuckets || Object.keys(fileEnvelope.buckets))
      .filter(b => SOURCE_BUCKETS.includes(b) && b !== 'settings' && fileEnvelope.buckets[b]);
    // Refuse to write engineOutput when no source bucket is being restored —
    // the engineOutput was computed from the file's source data, and writing
    // it without that source leaves the engine pointing at taste-shape that
    // doesn't match the device's data. Edge case: settings-only restore on
    // any device (empty or populated) — the user explicitly skipped source
    // data, so the file's engineOutput shouldn't ride along either.
    if (fileSourceBucketsSelected.length === 0) return false;
    const deviceSourceBuckets = (deviceState?.sourceBucketsWithData || [])
      .filter(b => SOURCE_BUCKETS.includes(b) && b !== 'settings');
    // file must cover every device source bucket so the merged source state
    // matches the file's engineOutput exactly.
    return deviceSourceBuckets.every(b => fileSourceBucketsSelected.includes(b));
  }

  // Detect which source buckets the device currently has data in. A
  // bucket "has data" if at least one of its keys has a non-empty
  // value in chrome.storage.local. Used by import.js to feed the
  // smart-conditional rule.
  async function detectDeviceSourceBuckets() {
    const allKeys = [];
    for (const bucket of SOURCE_BUCKETS) {
      if (bucket === 'settings') continue;  // settings doesn't gate engineOutput
      for (const k of BACKUP_BUCKETS[bucket]) allKeys.push(k);
    }
    const stored = await readManyStorageKeys(allKeys);
    const result = [];
    for (const bucket of SOURCE_BUCKETS) {
      if (bucket === 'settings') continue;
      const hasAny = BACKUP_BUCKETS[bucket].some(k => isMeaningfulValue(stored[k]));
      if (hasAny) result.push(bucket);
    }
    return result;
  }

  // ── Restore (import) ──────────────────────────────────────────

  // Apply imported buckets atomically. Snapshot affected keys before
  // writing; if the single set() call fails, restore the snapshot. On
  // success, returns the list of keys actually written so the caller
  // can broadcast / trigger recompute.
  //
  // opts.buckets — { bucketName: { key: value, ... } } sub-objects
  //   from the parsed envelope, filtered to the user's per-bucket
  //   override selection.
  // opts.useFileEngineOutput — boolean from shouldUseBackedUpEngineOutput.
  //   When false, skip the file's engineOutput entirely (caller will
  //   trigger recompute).
  async function restoreBackup(opts = {}) {
    const fileBuckets = opts.buckets || {};
    const useFileEngineOutput = !!opts.useFileEngineOutput;

    // Flatten bucket sub-objects into a single { key: value } write map.
    const writeMap = {};
    const wroteKeys = [];
    for (const bucket of Object.keys(fileBuckets)) {
      if (bucket === 'engineOutput' && !useFileEngineOutput) continue;
      const bucketData = fileBuckets[bucket];
      if (!bucketData || typeof bucketData !== 'object') continue;
      // Special case: anilist.oauthTokens is filtered before merge. We
      // don't blindly replace oauthTokens (that'd wipe MAL); we merge
      // the .anilist sub-object into existing tokens.
      if (bucket === 'anilist' && bucketData.oauthTokens) {
        const existing = await readSingleStorageKey('oauthTokens') || {};
        const merged = { ...existing, ...bucketData.oauthTokens };
        writeMap.oauthTokens = merged;
        wroteKeys.push('oauthTokens');
      }
      const knownKeys = (BACKUP_BUCKETS[bucket] || []).slice();
      // engineOutput's known keys are a separate list.
      if (bucket === 'engineOutput') knownKeys.push(...BACKUP_BUCKETS.engineOutput);
      const allowedKeys = new Set(knownKeys);
      for (const key of Object.keys(bucketData)) {
        if (key === 'oauthTokens') continue;  // handled above
        if (!allowedKeys.has(key)) continue;  // unknown sub-key, skip
        writeMap[key] = bucketData[key];
        wroteKeys.push(key);
      }
    }

    if (wroteKeys.length === 0) return { ok: true, wroteKeys: [] };

    // Snapshot the keys we're about to overwrite so we can roll back on
    // failure. chrome.storage.local.set is atomic per call, so a single
    // batched set is itself the success case; the snapshot only matters
    // if the set throws (quota exhaustion, serialization error).
    const snapshot = await readManyStorageKeys(wroteKeys);
    try {
      await writeManyStorageKeys(writeMap);
      return { ok: true, wroteKeys };
    } catch (err) {
      // Roll back. Best-effort — if the rollback also fails (e.g. the
      // same quota issue still applies) we surface the original error.
      try { await writeManyStorageKeys(snapshot); } catch (_) {}
      return { ok: false, error: err?.message || String(err), wroteKeys: [] };
    }
  }

  // ── Internals ─────────────────────────────────────────────────

  function hasAnySourceBucket(buckets) {
    return buckets.some(b => SOURCE_BUCKETS.includes(b) && b !== 'settings');
  }

  function pickPresent(stored, keys) {
    const out = {};
    for (const k of keys) {
      if (isMeaningfulValue(stored[k])) out[k] = stored[k];
    }
    return out;
  }

  function isMeaningfulValue(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'object') {
      if (Array.isArray(v)) return v.length > 0;
      return Object.keys(v).length > 0;
    }
    if (typeof v === 'string') return v.length > 0;
    return true;
  }

  // oauthTokens is a single chrome.storage key carrying a map of
  // {anilist: {...}, mal: {...}}. We never want to ship MAL tokens
  // when the user opted to include AniList only — this helper picks
  // just the requested sources.
  function filterOAuthTokens(tokens, allowedSources) {
    const out = {};
    for (const src of allowedSources) {
      if (tokens[src]) out[src] = tokens[src];
    }
    return out;
  }

  function mkError(code, message) {
    const err = new Error(message);
    err.code = code;
    err.isBackupError = true;
    return err;
  }

  function getExtensionVersion() {
    try { return chrome.runtime.getManifest().version; }
    catch (_) { return null; }
  }

  // Wrap the chrome.storage promise APIs so the rest of this module
  // doesn't need to scatter try/catches. None of these APIs are in
  // hot paths — readability over micro-perf.
  function readSingleStorageKey(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (res) => resolve(res?.[key]));
      } catch (_) { resolve(undefined); }
    });
  }

  function readManyStorageKeys(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (_) { resolve({}); }
    });
  }

  function writeManyStorageKeys(map) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(map, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      } catch (err) { reject(err); }
    });
  }

  // ── Export ────────────────────────────────────────────────────
  const api = {
    BACKUP_SCHEMA_VERSION,
    BACKUP_BUCKETS,
    SOURCE_BUCKETS,
    buildBackupEnvelope,
    parseBackupEnvelope,
    restoreBackup,
    shouldUseBackedUpEngineOutput,
    detectDeviceSourceBuckets,
  };
  if (typeof window !== 'undefined') window.crsmartBackupSchema = api;
  if (typeof globalThis !== 'undefined') globalThis.crsmartBackupSchema = api;
})();
