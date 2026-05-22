// Tests for the freeform-import path in external-list-importer.js.
//
// Run: node "Crunchyroll Smart Scoring_Extension/test-external-list-importer-freeform.js"
//
// What this exercises:
//   - buildFreeformAccumulator (pure)
//   - backfillConfidenceMetadata (idempotent migration)
//   - preserveLockedFreeformEntries (lockedByUser stickiness)
//   - importFromFreeform end-to-end against a mocked chrome.storage
//     and a pre-seeded bridge cache (so enrichMissing skips and no
//     real network is needed)
//
// The trickiest part is wiring the ESM dependency graph: anilist.js
// registers a provider at module-init, and the cache module only
// knows about bridge caches once background.js has called
// `cache.register(...)`. We do the registration ourselves before the
// orchestrator's first IPC hits the cache module.

// ── Chrome mock ──────────────────────────────────────────────────
//
// In-memory backing store with a thin chrome.storage.local + a no-op
// chrome.storage.onChanged + chrome.runtime.getManifest stub. Set on
// globalThis BEFORE importing any production module so all transitive
// imports see the mock.
function makeChromeMock(initialStorage = {}) {
  const store = new Map(Object.entries(initialStorage));
  const sessionStore = new Map();
  const onChangedListeners = new Set();
  function fireChanged(changes) {
    for (const fn of [...onChangedListeners]) {
      try { fn(changes, 'local'); } catch { /* swallow */ }
    }
  }
  return {
    runtime: {
      getManifest: () => ({ version: '0.test.0' }),
      id: 'test-extension-id',
    },
    storage: {
      local: {
        get(keys) {
          return new Promise((resolve) => {
            const result = {};
            if (keys === null || keys === undefined) {
              for (const [k, v] of store) result[k] = v;
            } else if (typeof keys === 'string') {
              if (store.has(keys)) result[keys] = store.get(keys);
            } else if (Array.isArray(keys)) {
              for (const k of keys) if (store.has(k)) result[k] = store.get(k);
            } else if (typeof keys === 'object') {
              for (const k of Object.keys(keys)) {
                result[k] = store.has(k) ? store.get(k) : keys[k];
              }
            }
            resolve(result);
          });
        },
        set(map) {
          return new Promise((resolve) => {
            const changes = {};
            for (const [k, v] of Object.entries(map)) {
              changes[k] = { oldValue: store.get(k), newValue: v };
              store.set(k, v);
            }
            fireChanged(changes);
            resolve();
          });
        },
        remove(keys) {
          return new Promise((resolve) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            const changes = {};
            for (const k of arr) {
              if (store.has(k)) {
                changes[k] = { oldValue: store.get(k), newValue: undefined };
                store.delete(k);
              }
            }
            fireChanged(changes);
            resolve();
          });
        },
        clear() {
          return new Promise((resolve) => {
            store.clear();
            resolve();
          });
        },
      },
      session: {
        get(keys) { return Promise.resolve({}); },
        set(map) { for (const [k, v] of Object.entries(map)) sessionStore.set(k, v); return Promise.resolve(); },
        remove() { return Promise.resolve(); },
        setAccessLevel() { return Promise.resolve(); },
      },
      onChanged: {
        addListener(fn) { onChangedListeners.add(fn); },
        removeListener(fn) { onChangedListeners.delete(fn); },
      },
    },
    _peek: () => Object.fromEntries(store),
    _clear: () => store.clear(),
  };
}

const chromeMock = makeChromeMock();
globalThis.chrome = chromeMock;

// ── Imports (after globalThis.chrome is set) ─────────────────────
const cache = await import('./cache-store.js');
const elImporter = await import('./external-list-importer.js');
const { backfillConfidenceMetadata, importFromFreeform, _freeformInternals } = elImporter;

// Register caches the way background.js normally does so getStaleIds
// can resolve.
cache.register('aniListBridgeCache', {
  storageKey: 'aniListBridgeCache',
  ttl: 30 * 24 * 60 * 60 * 1000,
});

// ── Test runner ──────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passCount += 1;
  else {
    failCount += 1;
    failures.push({ label, actual: a, expected: e });
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}
function assertTrue(cond, label) {
  if (cond) passCount += 1;
  else {
    failCount += 1;
    failures.push({ label });
    console.error(`FAIL: ${label} (assertion was false)`);
  }
}

// Helper: seed bridge cache so enrichMissing skips network entirely.
async function seedBridgeCache(aniListIds) {
  const entries = {};
  for (const id of aniListIds) {
    entries[id] = {
      _schema: 13,
      aniListId: id,
      title: { english: `Test Show ${id}`, romaji: `Test Show ${id}`, native: null },
      synonyms: [],
      fetchedAt: Date.now(),
    };
  }
  await chromeMock.storage.local.set({ aniListBridgeCache: entries });
}

// ── A. buildFreeformAccumulator (pure) ───────────────────────────
{
  const out = _freeformInternals.buildFreeformAccumulator([
    {
      aniListId: 5114, titleRaw: 'FMAB', status: 'completed', score: 10,
      scoreOriginal: '10/10', scoreScale: '10pt-slash', isFavorite: true,
      matchedVia: 'freeform-local-exact', confidence: 1.0, lockedByUser: false,
    },
    {
      aniListId: 101348, titleRaw: 'Vinland Saga', status: 'completed', score: 9,
      matchedVia: 'freeform-local-fuzz', confidence: 0.92, lockedByUser: false,
    },
  ]);
  assertEq(Object.keys(out).length, 2, 'A: 2 entries built');
  assertEq(out[5114].score, 10, 'A: score 10 preserved');
  assertEq(out[5114].isFavorite, true, 'A: isFavorite preserved');
  assertEq(out[5114]._source, 'freeform', 'A: _source stamped');
  assertEq(out[5114].matchedVia, 'freeform-local-exact', 'A: matchedVia preserved');
  assertEq(out[5114].confidence, 1.0, 'A: confidence preserved');
  assertEq(out[5114].lockedByUser, false, 'A: lockedByUser preserved');
  assertTrue(typeof out[5114].updatedAt === 'string', 'A: updatedAt stamped');
}

// ── B. buildFreeformAccumulator drops invalid IDs ───────────────
{
  const out = _freeformInternals.buildFreeformAccumulator([
    { aniListId: 1, titleRaw: 'Valid' },
    { aniListId: 0, titleRaw: 'Zero-invalid' },
    { aniListId: null, titleRaw: 'Null' },
    { aniListId: 'bad', titleRaw: 'String' },
    null,
    undefined,
  ]);
  assertEq(Object.keys(out).length, 1, 'B: only valid entry survived');
  assertTrue(out[1] !== undefined, 'B: AL ID 1 retained');
}

// ── C. backfillConfidenceMetadata stamps legacy MAL/AL entries ──
{
  chromeMock._clear();
  await chromeMock.storage.local.set({
    externalScores: {
      '5114': {
        anilist: { score: 9, status: 'completed', _source: 'api' },
      },
      '121': {
        mal: { score: 8, status: 'completed', _source: 'xml' },
      },
      '101348': {
        weirdSource: { score: 10, status: 'completed' }, // unknown source key
      },
    },
  });
  const r1 = await backfillConfidenceMetadata();
  assertEq(r1.stamped, 3, 'C: 3 legacy entries stamped');
  const after = (await chromeMock.storage.local.get('externalScores')).externalScores;
  assertEq(after['5114'].anilist.confidence, 1.0, 'C: AL confidence 1.0');
  assertEq(after['5114'].anilist.matchedVia, 'anilist-api', 'C: AL matchedVia');
  assertEq(after['5114'].anilist.lockedByUser, false, 'C: AL lockedByUser=false');
  assertEq(after['121'].mal.matchedVia, 'mal-xml', 'C: MAL xml matchedVia');
  assertEq(after['101348'].weirdSource.matchedVia, 'unknown-pre-migration-weirdSource', 'C: unknown source fallback');
  // Re-run is a no-op.
  const r2 = await backfillConfidenceMetadata();
  assertEq(r2.stamped, 0, 'C: re-run is idempotent');
}

// ── D. importFromFreeform end-to-end (clean state) ───────────────
{
  chromeMock._clear();
  await seedBridgeCache([5114, 101348]);
  // Pre-populate empty cache state to skip enrichment.
  const entries = [
    {
      aniListId: 5114, titleRaw: 'FMAB', status: 'completed', score: 10,
      scoreOriginal: '10/10', scoreScale: '10pt-slash', isFavorite: true,
      matchedVia: 'freeform-local-exact', confidence: 1.0, lockedByUser: false,
    },
    {
      aniListId: 101348, titleRaw: 'Vinland Saga', status: 'completed', score: 9,
      matchedVia: 'freeform-local-fuzz', confidence: 0.92, lockedByUser: false,
    },
  ];
  const result = await importFromFreeform({ entries });
  assertEq(result.source, 'freeform', 'D: source label');
  assertEq(result.imported, 2, 'D: 2 entries written');
  assertEq(result.preserved, 0, 'D: 0 preserved (clean state)');

  const stored = (await chromeMock.storage.local.get('externalScores')).externalScores;
  assertEq(stored['5114'].freeform.score, 10, 'D: FMAB freeform slot written');
  assertEq(stored['5114'].freeform.matchedVia, 'freeform-local-exact', 'D: matchedVia');
  assertEq(stored['5114'].freeform._source, 'freeform', 'D: _source');
  assertEq(stored['5114'].freeform.lockedByUser, false, 'D: lockedByUser=false');
  assertEq(stored['101348'].freeform.score, 9, 'D: Vinland slot written');

  // _importState should be cleared after success.
  const importState = (await chromeMock.storage.local.get('_importState'))._importState;
  assertTrue(!importState, 'D: _importState cleared on success');

  // _engineImpactBefore[freeform] should be populated.
  const snapshot = (await chromeMock.storage.local.get('_engineImpactBefore'))._engineImpactBefore;
  assertTrue(snapshot && snapshot.freeform, 'D: engine snapshot captured');
}

// ── E. Re-import preserves lockedByUser entries ──────────────────
{
  chromeMock._clear();
  await seedBridgeCache([5114, 101348, 9253]);

  // First import: mark Vinland as locked-by-user.
  await importFromFreeform({
    entries: [
      { aniListId: 5114, titleRaw: 'FMAB', score: 10, matchedVia: 'freeform-local-exact', confidence: 1.0 },
      { aniListId: 101348, titleRaw: 'Vinland Saga', score: 9, matchedVia: 'user-confirmed', confidence: 1.0, lockedByUser: true },
      { aniListId: 9253, titleRaw: 'Steins;Gate', score: 10, matchedVia: 'freeform-local-fuzz', confidence: 0.91 },
    ],
  });

  // Verify all three are present, Vinland locked.
  let stored = (await chromeMock.storage.local.get('externalScores')).externalScores;
  assertEq(Object.keys(stored).length, 3, 'E1: 3 entries after first import');
  assertEq(stored['101348'].freeform.lockedByUser, true, 'E1: Vinland locked');

  // Second import: only FMAB; Vinland and Steins;Gate are NOT in the
  // new batch. Locked Vinland should survive; Steins;Gate should be
  // dropped (replace semantics for non-locked entries).
  await importFromFreeform({
    entries: [
      { aniListId: 5114, titleRaw: 'FMAB', score: 10, matchedVia: 'freeform-local-exact', confidence: 1.0 },
    ],
  });
  stored = (await chromeMock.storage.local.get('externalScores')).externalScores;
  assertTrue(stored['5114']?.freeform, 'E2: FMAB still present');
  assertTrue(stored['101348']?.freeform, 'E2: Vinland (locked) preserved');
  assertEq(stored['101348'].freeform.lockedByUser, true, 'E2: Vinland still locked');
  assertTrue(!stored['9253'], 'E2: Steins;Gate (not locked, not in new batch) dropped');
}

// ── F. Re-import overwrites non-locked entries ──────────────────
{
  chromeMock._clear();
  await seedBridgeCache([5114]);
  // First import: FMAB with score 9.
  await importFromFreeform({
    entries: [
      { aniListId: 5114, titleRaw: 'FMAB', score: 9, matchedVia: 'freeform-local-fuzz', confidence: 0.91 },
    ],
  });
  let stored = (await chromeMock.storage.local.get('externalScores')).externalScores;
  assertEq(stored['5114'].freeform.score, 9, 'F1: initial score 9');

  // Second import: FMAB with score 10. Non-locked, so overwrite wins.
  await importFromFreeform({
    entries: [
      { aniListId: 5114, titleRaw: 'FMAB', score: 10, matchedVia: 'freeform-local-exact', confidence: 1.0 },
    ],
  });
  stored = (await chromeMock.storage.local.get('externalScores')).externalScores;
  assertEq(stored['5114'].freeform.score, 10, 'F2: score upgraded to 10');
  assertEq(stored['5114'].freeform.matchedVia, 'freeform-local-exact', 'F2: matchedVia upgraded');
}

// ── G. Cross-source coexistence ──────────────────────────────────
{
  chromeMock._clear();
  await seedBridgeCache([5114]);
  // Pre-seed an MAL XML entry for FMAB.
  await chromeMock.storage.local.set({
    externalScores: {
      '5114': {
        mal: {
          score: 10, status: 'completed', _source: 'xml',
          confidence: 1.0, matchedVia: 'mal-xml', lockedByUser: false,
        },
      },
    },
  });
  // Import the same FMAB via freeform with lower confidence.
  await importFromFreeform({
    entries: [
      { aniListId: 5114, titleRaw: 'FMAB', score: 9, matchedVia: 'freeform-local-fuzz', confidence: 0.88 },
    ],
  });
  const stored = (await chromeMock.storage.local.get('externalScores')).externalScores;
  // Both source slots should coexist — downstream uses Math.max(confidence)
  // to resolve, which is a read-time concern, not a write-time one.
  assertTrue(stored['5114'].mal, 'G: MAL slot intact');
  assertTrue(stored['5114'].freeform, 'G: freeform slot added');
  assertEq(stored['5114'].mal.score, 10, 'G: MAL score unchanged');
  assertEq(stored['5114'].freeform.score, 9, 'G: freeform score added');
}

// ── H. importFromFreeform rejects bad input ──────────────────────
{
  let threw = false;
  try { await importFromFreeform({ entries: 'not-an-array' }); }
  catch { threw = true; }
  assertTrue(threw, 'H: non-array entries rejected');

  let threw2 = false;
  try { await importFromFreeform({}); }
  catch { threw2 = true; }
  assertTrue(threw2, 'H: missing entries rejected');
}

// ── Summary ──────────────────────────────────────────────────────
console.log();
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${failCount}`);
if (failCount > 0) {
  console.log();
  console.log('Failure summary:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
console.log('All freeform orchestrator tests passed.');
