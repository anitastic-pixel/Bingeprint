// Tests for freeform-search-adapter.js.
//
// Run: node "Crunchyroll Smart Scoring_Extension/test-freeform-search-adapter.js"
//
// Adapter is pure JS so we exercise it directly. The sendBatch DI
// parameter lets tests inject mocks that record call counts, simulate
// failures, return partial result maps, etc.

import { createBatchedSearchAdapter } from './freeform-search-adapter.js';

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
    console.error(`FAIL: ${label}`);
  }
}

// ── A. Single title flushes via microtask ──────────────────────────
{
  const calls = [];
  const sendBatch = async (titles) => {
    calls.push(titles);
    return Object.fromEntries(titles.map((t) => [t, [{ aniListId: 1, title: t }]]));
  };
  const searchFn = createBatchedSearchAdapter({ sendBatch });
  const p = searchFn('Vinland Saga');
  // Before microtask fires, no sendBatch call yet.
  assertEq(calls.length, 0, 'A: no sync sendBatch (waits for microtask)');
  const result = await p;
  assertEq(calls, [['Vinland Saga']], 'A: single-title sendBatch fired once');
  assertEq(result, [{ aniListId: 1, title: 'Vinland Saga' }], 'A: result returned to searchFn');
}

// ── B. Multiple synchronous titles batched into one sendBatch ──────
{
  const calls = [];
  const sendBatch = async (titles) => {
    calls.push(titles);
    return Object.fromEntries(titles.map((t) => [t, [{ aniListId: t.length, title: t }]]));
  };
  const searchFn = createBatchedSearchAdapter({ sendBatch });
  // Fire 3 synchronously — should all land in one batch.
  const promises = [searchFn('A'), searchFn('B'), searchFn('C')];
  const results = await Promise.all(promises);
  assertEq(calls.length, 1, 'B: 3 sync titles → 1 sendBatch call');
  assertEq(calls[0], ['A', 'B', 'C'], 'B: all 3 in one batch');
  assertEq(results.map((r) => r[0].title), ['A', 'B', 'C'], 'B: each promise resolves with its own result');
}

// ── C. Batch cap — first BATCH_CAP flushes immediately ─────────────
{
  const calls = [];
  const sendBatch = async (titles) => {
    calls.push(titles);
    return Object.fromEntries(titles.map((t) => [t, []]));
  };
  const searchFn = createBatchedSearchAdapter({ sendBatch, batchCap: 5 });
  // Fire 7 — first 5 should flush immediately, remaining 2 wait for microtask.
  const promises = [];
  for (let i = 0; i < 7; i++) promises.push(searchFn(`title-${i}`));
  await Promise.all(promises);
  assertEq(calls.length, 2, 'C: 7 titles + cap 5 → 2 sendBatch calls');
  assertEq(calls[0].length, 5, 'C: first batch is the cap (5)');
  assertEq(calls[1].length, 2, 'C: second batch has the overflow (2)');
}

// ── D. sendBatch throws → all queued titles resolve to empty ───────
{
  const sendBatch = async () => { throw new Error('SW unreachable'); };
  const searchFn = createBatchedSearchAdapter({ sendBatch });
  const promises = [searchFn('X'), searchFn('Y')];
  const results = await Promise.all(promises);
  assertEq(results, [[], []], 'D: sendBatch failure → empty results for every title');
}

// ── E. Partial response map → missing titles get empty arrays ──────
{
  const sendBatch = async (titles) => {
    // Return results only for some titles.
    const out = {};
    if (titles.includes('found')) out['found'] = [{ aniListId: 1, title: 'found' }];
    // 'missing' deliberately absent from response.
    return out;
  };
  const searchFn = createBatchedSearchAdapter({ sendBatch });
  const [foundResult, missingResult] = await Promise.all([
    searchFn('found'),
    searchFn('missing'),
  ]);
  assertEq(foundResult.length, 1, 'E: present title gets its result');
  assertEq(missingResult, [], 'E: absent title gets empty array');
}

// ── F. sendBatch returns null / undefined → all empty ──────────────
{
  const sendBatch = async () => null;
  const searchFn = createBatchedSearchAdapter({ sendBatch });
  const result = await searchFn('Some Title');
  assertEq(result, [], 'F: null sendBatch result → empty array');
}

// ── G. sendBatch returns non-array per-title → coerced to empty ────
{
  const sendBatch = async (titles) => Object.fromEntries(titles.map((t) => [t, 'not-an-array']));
  const searchFn = createBatchedSearchAdapter({ sendBatch });
  const result = await searchFn('Some Title');
  assertEq(result, [], 'G: non-array result value coerced to []');
}

// ── H. Constructor validates sendBatch ─────────────────────────────
{
  let threw = false;
  try { createBatchedSearchAdapter({}); }
  catch (err) { threw = err instanceof TypeError; }
  assertTrue(threw, 'H: missing sendBatch throws TypeError');
}

// ── I. Per-instance state isolation ────────────────────────────────
{
  // Two adapters sharing the same sendBatch — verify their queues
  // don't interfere. (Adapter 1's queue overflow doesn't leak into
  // adapter 2's batch.)
  const calls = [];
  const sendBatch = async (titles) => {
    calls.push(titles);
    return Object.fromEntries(titles.map((t) => [t, []]));
  };
  const a1 = createBatchedSearchAdapter({ sendBatch, batchCap: 3 });
  const a2 = createBatchedSearchAdapter({ sendBatch, batchCap: 3 });
  await Promise.all([
    a1('a1-x'), a1('a1-y'),
    a2('a2-x'), a2('a2-y'),
  ]);
  assertEq(calls.length, 2, 'I: 2 adapters → 2 batches (each its own queue)');
  // The two batches should be distinguishable.
  const allTitles = calls.flat().sort();
  assertEq(allTitles, ['a1-x', 'a1-y', 'a2-x', 'a2-y'], 'I: all titles delivered exactly once across batches');
}

// ── J. Repeated calls across microtask boundaries flush correctly ──
{
  const calls = [];
  const sendBatch = async (titles) => {
    calls.push([...titles]);
    return Object.fromEntries(titles.map((t) => [t, []]));
  };
  const searchFn = createBatchedSearchAdapter({ sendBatch });
  // First wave (sync) → batch 1
  const wave1 = Promise.all([searchFn('w1-a'), searchFn('w1-b')]);
  await wave1; // Lets microtask fire
  // Second wave (after microtask) → batch 2
  const wave2 = Promise.all([searchFn('w2-a'), searchFn('w2-b')]);
  await wave2;
  assertEq(calls.length, 2, 'J: two waves → two distinct batches');
  assertEq(calls[0], ['w1-a', 'w1-b'], 'J: first wave grouped');
  assertEq(calls[1], ['w2-a', 'w2-b'], 'J: second wave grouped');
}

// ── Summary ────────────────────────────────────────────────────────
console.log();
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${failCount}`);
if (failCount > 0) {
  console.log();
  console.log('Failure summary:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
console.log('All freeform-search-adapter tests passed.');
