// Microtask-debounced batch adapter for the freeform-import matcher's
// AL Search fallback path.
//
// Lived inline in import-freeform.js until the 2026-05-19 architecture
// review flagged it as a deepening opportunity: pure JS (no DOM, no
// chrome.*) ~50 lines of non-trivial debounce logic, untestable in
// Node because the host file is browser-bound. Extracted here as a
// higher-order function that takes `sendBatch` as a DI parameter —
// the page wires chrome.runtime.sendMessage; tests inject a mock.
//
// ## Why batching?
//
// The matcher's resolveFreeformList pass-1 fires searchFn
// synchronously for every unmatched row. Without batching that
// produces N chrome.runtime messages → N SW round-trips → N × 800ms
// AL gateway pacing. For a 50-miss import, ~40s wall-clock.
//
// Batched (this adapter): pass-1's synchronous burst gets collected
// into chunks of up to 10 titles each. One SW message per chunk →
// one AL HTTP request with 10 GraphQL aliases → one gateway slot
// consumed. Same 50-miss import drops to ~6.5s — 6× faster.
//
// ## How the timing works
//
// Pass-1 of resolveFreeformList runs synchronously: a `for` loop that
// calls searchFn(title) for each unmatched row. Each searchFn call is
// synchronous-up-to-the-await, so by the end of the loop all titles
// have been queued.
//
// `queueMicrotask` fires AFTER the current sync block ends but
// BEFORE any IO or setTimeout. So:
//   1. searchFn(title1) → push to queue, schedule microtask
//   2. searchFn(title2) → push to queue, no new microtask (flushScheduled)
//   3. ... up to searchFn(titleN)
//   4. Sync block ends
//   5. Microtask fires → flush whatever's in queue (up to BATCH_CAP)
//   6. If queue still has items → schedule next microtask
//
// At BATCH_CAP+1 titles, the first 10 flush IMMEDIATELY (no microtask
// wait) so we don't sit on a full batch hoping more arrive.
//
// ## Interface contract
//
// createBatchedSearchAdapter({ sendBatch, batchCap }) → searchFn
//
//   sendBatch: (titles: string[]) => Promise<{ [title]: results[] }>
//     Sends a batched search request. Returns a map from input title
//     to result list. Missing titles in the response map are treated
//     as empty results (per Q2 of the 2026-05-19 grill: partial
//     success is OK, no per-alias retry).
//
//   batchCap: number — max titles per batch. Defaults to 10.
//     The AL community library convention; balance between request
//     count and complexity-per-request.
//
//   returns: searchFn(title) → Promise<results[]>
//     Matcher-side contract: same Promise-returning signature the
//     pre-batched single-query adapter had. The matcher's
//     resolveFreeformList doesn't change.
//
// Per-analyze instance recommended — caller creates one adapter per
// run so cancelled batches can't leak into the next analyze.

const DEFAULT_BATCH_CAP = 10;

export function createBatchedSearchAdapter({ sendBatch, batchCap = DEFAULT_BATCH_CAP } = {}) {
  if (typeof sendBatch !== 'function') {
    throw new TypeError('createBatchedSearchAdapter: sendBatch must be a function');
  }
  let pendingBatch = [];
  let flushScheduled = false;

  async function flushBatch(batch) {
    let results = {};
    try {
      results = await sendBatch(batch.map((b) => b.title)) || {};
    } catch {
      // sendBatch failed entirely — resolve all queued titles to empty
      // results so the matcher routes them to unmatched. Mirrors the
      // pre-batch behavior of "AL Search failure → empty array."
      for (const { resolve } of batch) resolve([]);
      return;
    }
    for (const { title, resolve } of batch) {
      resolve(Array.isArray(results[title]) ? results[title] : []);
    }
  }

  function flushNow() {
    if (pendingBatch.length === 0) return;
    // Pull the first BATCH_CAP items off the queue. If more remain,
    // schedule another microtask to flush them — keeps batches
    // back-to-back on the page side; the SW's gateway still
    // serializes them with 800ms pacing.
    const batch = pendingBatch.splice(0, batchCap);
    flushBatch(batch);
    if (pendingBatch.length > 0) {
      queueMicrotask(flushNow);
    }
  }

  return function searchFn(title) {
    return new Promise((resolve) => {
      pendingBatch.push({ title, resolve });
      if (pendingBatch.length >= batchCap) {
        // Full batch — flush immediately, don't wait for microtask.
        flushNow();
      } else if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          flushScheduled = false;
          flushNow();
        });
      }
    });
  };
}
