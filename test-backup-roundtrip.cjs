// Round-trip + edge-case tests for backup-schema.js.
//
// Runs under plain Node — mocks chrome.storage.local with an in-memory
// Map and chrome.runtime.getManifest() with a fake version string, then
// loads backup-schema.js via vm so the same code that runs in the
// browser is what we're testing.
//
// Scenarios covered:
//   A. Save-everything round-trip on a populated storage
//      → expect identical post-import state, smart-conditional says
//        "trust file's engineOutput"
//   B. CR-only export, AniList-only export, and survey-only export
//      → import each onto a clean device → only their keys land
//      → engineOutput ride-along + smart-conditional flags as expected
//   C. Settings-only export (no engineOutput rides along)
//      → import on populated device → settings replace, source intact
//   D. Per-bucket replace semantics: import a CR-only file onto a
//      device that already has AniList — verify AniList is untouched
//   E. OAuth filter: file with only AniList token doesn't carry MAL
//      tokens (filter at export); on import with both linked, MAL
//      preserved on device (merge at import)
//   F. Schema-too-new rejected with typed error code
//   G. Invalid JSON rejected with typed error code
//   H. Smart-conditional rule: device has CR + AniList, file has CR
//      only → engineOutput should NOT be trusted
//   I. Smart-conditional rule: device has nothing, file has full
//      → engineOutput SHOULD be trusted
//
// Run: node Crunchyroll\ Smart\ Scoring_Extension/test-backup-roundtrip.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Mock chrome.storage ──────────────────────────────────────────
function makeChromeMock(initialStorage = {}) {
  const store = new Map(Object.entries(initialStorage));
  const lastError = { current: null };
  return {
    storage: {
      local: {
        get(keys, cb) {
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
          if (typeof cb === 'function') cb(result);
        },
        set(map, cb) {
          for (const [k, v] of Object.entries(map)) store.set(k, v);
          if (typeof cb === 'function') cb();
        },
        remove(keys, cb) {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) store.delete(k);
          if (typeof cb === 'function') cb();
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: '1.4.2-test' }),
      get lastError() { return lastError.current; },
    },
    _store: store,
    _lastError: lastError,
  };
}

// Load backup-schema.js into a fresh context with the chrome mock.
function loadSchema(chromeMock) {
  const src = fs.readFileSync(path.join(__dirname, 'backup-schema.js'), 'utf8');
  const ctx = {
    chrome: chromeMock,
    window: {},
    globalThis: {},
    Promise,
    Object,
    Array,
    JSON,
    Error,
    Date,
    Map,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.crsmartBackupSchema;
}

// ── Synthetic data shaped like real storage ──────────────────────
function buildSyntheticDeviceState() {
  return {
    // CR bucket
    watchShapes: { 12345: { score: 0.8 }, 67890: { score: 0.6 } },
    profileId: 'test-profile-id',
    lastSeenAt: 1714000000000,
    crSeriesMeta: { 12345: { title: 'Frieren' } },
    crToAniListId: { 12345: 154587 },
    popularSeedDone: true,
    // AniList bucket
    externalScores: {
      154587: { anilist: { score: 9, status: 'COMPLETED' } },
      457: { anilist: { score: 10, status: 'COMPLETED' } },
    },
    aniListMeta: { lastImportAt: 1714000000000 },
    oauthTokens: {
      anilist: { access_token: 'al-token-xxx', expires_at: 1900000000000, account: { id: 1, name: 'andrew' } },
      mal: { access_token: 'mal-token-yyy', expires_at: 1800000000000, account: { id: 2, name: 'andrew-mal' } },
    },
    // Survey bucket
    surveyShapes: { 12345: { taps: 2 } },
    surveyTagShapes: { 'Action': { taps: 5 } },
    userRatings: { 12345: 9 },
    userReactions: { 67890: ['banger'] },
    // Settings bucket
    surfaceSettings: { dealbreakerTags: ['Loli'], heroBgLock: false },
    tourSeen: { at: 1714000000000, completedAt: 1714000010000 },
    // Engine output (derived)
    tasteVector: { 'Slice of Life': 0.92, 'Action': 0.34 },
    tasteVectorPeak: { 'Action': 0.6 },
    archetypeBlend: { archetypes: [{ id: 'auteur', name: 'Auteur', score: 0.65 }] },
    allShowsScored: { 12345: { score: 92 }, 67890: { score: 71 } },
    aniListBridgeCache: { 154587: { id: 154587, title: 'Frieren' } },
    aniListCache: { 12345: { aniListId: 154587 } },
    // Synthetic / excluded keys (should never be in any bucket)
    _importState: { progress: 0.5 },
    _devAxisSandbox: { foo: 1 },
    _tourMetrics: { mounts: 5, completes: 2, slidesViewed: { 1: 5 } },
  };
}

// ── Test runner ───────────────────────────────────────────────────
const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); })
    .catch(err => {
      results.push({ name, ok: false, err: err.message || String(err) });
      console.log(`  ✗ ${name}\n      ${err.stack || err.message}`);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'assertEq'}: expected ${e}, got ${a}`);
}
function assertHas(obj, key, msg) {
  if (!(key in obj)) throw new Error(`${msg || 'assertHas'}: missing key '${key}'`);
}
function assertLacks(obj, key, msg) {
  if (key in obj) throw new Error(`${msg || 'assertLacks'}: unexpected key '${key}'`);
}

async function main() {
  console.log('\n── backup-schema round-trip tests ──\n');

  // ── A: Save-everything round-trip ───────────────────────────
  console.log('A. Save-everything round-trip');
  await test('export with all 4 source buckets includes engineOutput', async () => {
    const initial = buildSyntheticDeviceState();
    const chromeMock = makeChromeMock(initial);
    const Schema = loadSchema(chromeMock);
    const env = await Schema.buildBackupEnvelope({
      buckets: ['cr', 'anilist', 'survey', 'settings'],
      includeAnilistOAuth: true,
    });
    assertEq(env.schemaVersion, 1, 'schemaVersion should be 1');
    assertHas(env.buckets, 'cr');
    assertHas(env.buckets, 'anilist');
    assertHas(env.buckets, 'survey');
    assertHas(env.buckets, 'settings');
    assertHas(env.buckets, 'engineOutput');
    // OAuth ride-along under anilist bucket
    assertHas(env.buckets.anilist, 'oauthTokens');
    assert(env.buckets.anilist.oauthTokens.anilist, 'AniList OAuth in envelope');
  });

  await test('full restore on empty device — instant (smart-conditional says trust file)', async () => {
    const initial = buildSyntheticDeviceState();
    const exportChrome = makeChromeMock(initial);
    const Schema1 = loadSchema(exportChrome);
    const env = await Schema1.buildBackupEnvelope({
      buckets: ['cr', 'anilist', 'survey', 'settings'],
      includeAnilistOAuth: true,
    });

    // Simulate fresh device (empty storage). Re-load schema with new chrome mock.
    const importChrome = makeChromeMock({});
    const Schema2 = loadSchema(importChrome);
    const deviceState = {
      sourceBucketsWithData: await Schema2.detectDeviceSourceBuckets(),
    };
    assertEq(deviceState.sourceBucketsWithData, [], 'fresh device has no source buckets');
    const useEngineOutput = Schema2.shouldUseBackedUpEngineOutput(deviceState, env);
    assert(useEngineOutput, 'smart-conditional should say USE engineOutput on empty device');

    const result = await Schema2.restoreBackup({
      buckets: env.buckets,
      useFileEngineOutput: true,
    });
    assert(result.ok, 'restore ok');
    // Verify a few key shapes round-tripped
    importChrome.storage.local.get(['watchShapes', 'externalScores', 'tasteVector', 'oauthTokens'], (got) => {
      assertEq(got.watchShapes, initial.watchShapes, 'watchShapes round-trip');
      assertEq(got.externalScores, initial.externalScores, 'externalScores round-trip');
      assertEq(got.tasteVector, initial.tasteVector, 'tasteVector (engineOutput) round-trip');
      assert(got.oauthTokens?.anilist, 'AniList token landed');
      // MAL token should NOT be in the file (only AniList was filtered in)
      assertLacks(got.oauthTokens, 'mal', 'MAL token should not have come along');
    });
  });

  // ── B: Per-bucket exports ────────────────────────────────────
  console.log('\nB. Single-bucket exports');
  await test('CR-only export contains CR + engineOutput, no anilist/survey/settings', async () => {
    const chromeMock = makeChromeMock(buildSyntheticDeviceState());
    const Schema = loadSchema(chromeMock);
    const env = await Schema.buildBackupEnvelope({ buckets: ['cr'] });
    assertHas(env.buckets, 'cr');
    assertHas(env.buckets, 'engineOutput');
    assertLacks(env.buckets, 'anilist');
    assertLacks(env.buckets, 'survey');
    assertLacks(env.buckets, 'settings');
  });

  await test('settings-only export skips engineOutput (no source data triggers ride-along)', async () => {
    const chromeMock = makeChromeMock(buildSyntheticDeviceState());
    const Schema = loadSchema(chromeMock);
    const env = await Schema.buildBackupEnvelope({ buckets: ['settings'] });
    assertHas(env.buckets, 'settings');
    assertLacks(env.buckets, 'engineOutput');
    assertLacks(env.buckets, 'cr');
  });

  // ── C: Per-bucket replace, untouched buckets preserved ──────
  console.log('\nC. Per-bucket replace semantics');
  await test('CR-only import on device with AniList preserves AniList', async () => {
    const exportChrome = makeChromeMock(buildSyntheticDeviceState());
    const Schema1 = loadSchema(exportChrome);
    const env = await Schema1.buildBackupEnvelope({ buckets: ['cr'] });

    // Device has fresh AniList data not in the file
    const deviceWithAnilist = {
      externalScores: { 1: { anilist: { score: 7 } } },
      surfaceSettings: { dealbreakerTags: ['Ecchi'] },
    };
    const importChrome = makeChromeMock(deviceWithAnilist);
    const Schema2 = loadSchema(importChrome);
    const result = await Schema2.restoreBackup({
      buckets: { cr: env.buckets.cr },
      useFileEngineOutput: false,
    });
    assert(result.ok, 'restore ok');
    importChrome.storage.local.get(['watchShapes', 'externalScores', 'surfaceSettings'], (got) => {
      assertEq(got.watchShapes, env.buckets.cr.watchShapes, 'CR data restored');
      assertEq(got.externalScores, deviceWithAnilist.externalScores, 'AniList preserved');
      assertEq(got.surfaceSettings, deviceWithAnilist.surfaceSettings, 'Settings preserved');
    });
  });

  // ── D: OAuth filter + merge ──────────────────────────────────
  console.log('\nD. OAuth filter at export, merge at import');
  await test('export filters out MAL token even if user has both linked', async () => {
    const chromeMock = makeChromeMock(buildSyntheticDeviceState());
    const Schema = loadSchema(chromeMock);
    const env = await Schema.buildBackupEnvelope({
      buckets: ['anilist'],
      includeAnilistOAuth: true,
    });
    assertHas(env.buckets.anilist.oauthTokens, 'anilist');
    assertLacks(env.buckets.anilist.oauthTokens, 'mal',
      'MAL token leaked into file (filter failed)');
  });

  await test('OAuth import merges into existing oauthTokens (preserves MAL)', async () => {
    // File has only AniList token
    const fileEnvelope = {
      schemaVersion: 1,
      buckets: {
        anilist: {
          externalScores: { 154587: { anilist: { score: 9 } } },
          oauthTokens: { anilist: { access_token: 'NEW-AL-TOKEN' } },
        },
      },
    };
    // Device already has MAL linked
    const deviceState = {
      oauthTokens: {
        mal: { access_token: 'EXISTING-MAL', account: { id: 99 } },
      },
    };
    const chromeMock = makeChromeMock(deviceState);
    const Schema = loadSchema(chromeMock);
    await Schema.restoreBackup({
      buckets: fileEnvelope.buckets,
      useFileEngineOutput: false,
    });
    chromeMock.storage.local.get('oauthTokens', (got) => {
      assert(got.oauthTokens?.anilist?.access_token === 'NEW-AL-TOKEN', 'AniList token merged');
      assert(got.oauthTokens?.mal?.access_token === 'EXISTING-MAL', 'MAL token preserved');
    });
  });

  // ── E: Smart-conditional rule ────────────────────────────────
  console.log('\nE. Smart-conditional engineOutput trust');
  await test('partial file (CR only) on populated device with CR+AniList → don\'t trust file engineOutput', async () => {
    const env = {
      schemaVersion: 1,
      buckets: {
        cr: { watchShapes: {} },
        engineOutput: { tasteVector: {} },
      },
    };
    const deviceState = { sourceBucketsWithData: ['cr', 'anilist'] };
    const Schema = loadSchema(makeChromeMock({}));
    assert(!Schema.shouldUseBackedUpEngineOutput(deviceState, env),
      'should NOT trust engineOutput when device has AniList that file doesn\'t');
  });

  await test('full file on empty device → trust file engineOutput', async () => {
    const env = {
      schemaVersion: 1,
      buckets: {
        cr: { watchShapes: {} },
        anilist: { externalScores: {} },
        survey: {},
        engineOutput: { tasteVector: {} },
      },
    };
    const deviceState = { sourceBucketsWithData: [] };
    const Schema = loadSchema(makeChromeMock({}));
    assert(Schema.shouldUseBackedUpEngineOutput(deviceState, env),
      'should trust engineOutput when device has no source data');
  });

  await test('settings-only on fresh device → don\'t use file engineOutput (no source restored)', async () => {
    const env = {
      schemaVersion: 1,
      buckets: {
        settings: { surfaceSettings: {} },
        engineOutput: { tasteVector: {} },  // unusual but possible if file was hand-edited
      },
    };
    const deviceState = { sourceBucketsWithData: [] };
    const Schema = loadSchema(makeChromeMock({}));
    assert(!Schema.shouldUseBackedUpEngineOutput(deviceState, env, ['settings']),
      'settings-only restore should not write engineOutput, even on fresh device');
  });

  await test('per-bucket override unchecks AniList → engineOutput trust flips off', async () => {
    const env = {
      schemaVersion: 1,
      buckets: {
        cr: { watchShapes: {} },
        anilist: { externalScores: {} },
        engineOutput: { tasteVector: {} },
      },
    };
    const deviceState = { sourceBucketsWithData: ['cr', 'anilist'] };
    const Schema = loadSchema(makeChromeMock({}));
    // User selects all buckets
    assert(Schema.shouldUseBackedUpEngineOutput(deviceState, env, ['cr', 'anilist', 'engineOutput']),
      'with all buckets selected, should trust');
    // User unchecks AniList — file's engineOutput is now wrong for the merged state
    assert(!Schema.shouldUseBackedUpEngineOutput(deviceState, env, ['cr', 'engineOutput']),
      'with anilist unchecked, should NOT trust');
  });

  // ── F: Schema-too-new rejected ───────────────────────────────
  console.log('\nF. Schema rejection');
  await test('schemaVersion higher than current rejected with typed error', async () => {
    const Schema = loadSchema(makeChromeMock({}));
    const futureFile = JSON.stringify({ schemaVersion: 999, buckets: {} });
    let caught;
    try { Schema.parseBackupEnvelope(futureFile); }
    catch (err) { caught = err; }
    assert(caught, 'parse should throw');
    assertEq(caught.code, 'schema-too-new', 'error code');
    assert(caught.message.includes('newer version'), 'user-readable message');
  });

  await test('invalid JSON rejected with typed error', async () => {
    const Schema = loadSchema(makeChromeMock({}));
    let caught;
    try { Schema.parseBackupEnvelope('{not valid json'); }
    catch (err) { caught = err; }
    assert(caught, 'parse should throw');
    assertEq(caught.code, 'invalid-json', 'error code');
  });

  await test('non-envelope JSON rejected with typed error', async () => {
    const Schema = loadSchema(makeChromeMock({}));
    let caught;
    try { Schema.parseBackupEnvelope('{"hello":"world"}'); }
    catch (err) { caught = err; }
    assert(caught, 'parse should throw');
    assertEq(caught.code, 'missing-envelope', 'error code');
  });

  // ── G: Synthetic / excluded keys ─────────────────────────────
  console.log('\nG. Synthetic key exclusion');
  await test('synthetic keys (_importState, _devAxisSandbox, _tourMetrics) excluded from envelope', async () => {
    const chromeMock = makeChromeMock(buildSyntheticDeviceState());
    const Schema = loadSchema(chromeMock);
    const env = await Schema.buildBackupEnvelope({
      buckets: ['cr', 'anilist', 'survey', 'settings'],
    });
    const flat = JSON.stringify(env);
    assert(!flat.includes('_importState'), '_importState leaked');
    assert(!flat.includes('_devAxisSandbox'), '_devAxisSandbox leaked');
    assert(!flat.includes('_tourMetrics'), '_tourMetrics leaked');
  });

  // ── H: Atomicity ─────────────────────────────────────────────
  console.log('\nH. Atomic restore');
  await test('restore failure rolls back to prior state', async () => {
    const chromeMock = makeChromeMock({ watchShapes: { existing: 1 } });
    // Force the FIRST set call (the import) to fail via lastError.
    // The wrapper in backup-schema.js checks chrome.runtime.lastError
    // inside the cb and rejects the Promise. Subsequent set calls (the
    // rollback) succeed.
    let callsBeforeFailure = 0;
    const realSet = chromeMock.storage.local.set;
    chromeMock.storage.local.set = (map, cb) => {
      callsBeforeFailure++;
      if (callsBeforeFailure === 1) {
        // Simulate quota by setting lastError BEFORE invoking the cb,
        // and don't actually mutate the store. Wrapper sees the error
        // and rejects.
        chromeMock._lastError.current = { message: 'simulated quota error' };
        if (cb) cb();
        chromeMock._lastError.current = null;
        return;
      }
      // Subsequent calls (rollback) succeed normally.
      realSet.call(chromeMock.storage.local, map, cb);
    };
    const Schema = loadSchema(chromeMock);
    const result = await Schema.restoreBackup({
      buckets: { cr: { watchShapes: { newone: 99 } } },
      useFileEngineOutput: false,
    });
    assert(!result.ok, 'restore should fail');
    assert(result.error.includes('simulated quota error'), 'error message surfaced');
    // Existing data should still be there (rollback succeeded)
    chromeMock.storage.local.set = realSet;
    chromeMock.storage.local.get('watchShapes', (got) => {
      assertEq(got.watchShapes, { existing: 1 }, 'rolled back to existing data');
    });
  });

  // ── Summary ──────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n── ${passed}/${results.length} passed ──`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ✗ ${r.name}\n    ${r.err}`);
    }
    process.exit(1);
  }
}

main();
