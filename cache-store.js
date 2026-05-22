// Cache-store — TTL-aware entry-cache module with exponential error
// backoff, in-memory mirror, and debounced persistence. Single seam
// for entry-keyed caches that knows about transient vs. permanent
// failures.
//
// The error-backoff bug it fixes: a transient AniList rate-limit
// stores an `_matchConfidence: 'error'` entry. The prior stale
// predicate treated those as stale → re-enqueued → re-hammered AL,
// so yesterday's 429 caused today's 429s. cache-store routes errors
// through markError, which sets `_retryAfter` via exponential backoff
// (1m → 5m → 30m → 2h → 12h → 24h, doubling per failure).
// getStaleIds skips entries whose `_retryAfter` is in the future.
//
// In-memory mirror: each cache is hydrated from chrome.storage on
// first access, then all reads serve from memory. Writes update
// memory immediately and schedule a debounced flush to storage
// (default 500ms). Drops the read-merge-write storm in bulkEnrich
// from ~600 storage round-trips to a few flushes per pass. SW death
// during a flush window loses at most one debounce-window of writes,
// which the next stale-id selection re-enqueues — no integrity loss.
//
// Self-correction: a chrome.storage.onChanged listener picks up
// out-of-band writes (e.g. a code path that hasn't been migrated
// yet, or another extension surface writing to the same key) and
// refreshes the in-memory mirror so reads stay consistent.

const caches = new Map(); // name -> config

const DEFAULT_BACKOFF_MS = [
  60_000,        // 1m
  300_000,       // 5m
  1_800_000,     // 30m
  7_200_000,     // 2h
  43_200_000,    // 12h
  86_400_000,    // 24h
];
const DEFAULT_FLUSH_DEBOUNCE_MS = 500;

export function register(name, config = {}) {
  caches.set(name, {
    storageKey:      config.storageKey ?? name,
    ttl:             config.ttl ?? 30 * 24 * 60 * 60 * 1000,
    errorBackoffMs:  config.errorBackoffMs ?? DEFAULT_BACKOFF_MS,
    schemaVersion:   config.schemaVersion,
    flushDebounceMs: config.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS,
    // In-memory mirror state.
    data:            null,
    loadPromise:     null,
    flushTimer:      null,
    flushPending:    false,
  });
}

// Hydrate the in-memory mirror from chrome.storage on first access.
// Concurrent first-access calls share a single load promise.
async function loadAll(name) {
  const c = caches.get(name);
  if (!c) throw new Error(`cache-store: no cache "${name}" registered`);
  if (c.data) return c.data;
  if (c.loadPromise) return c.loadPromise;
  c.loadPromise = (async () => {
    const stored = await chrome.storage.local.get(c.storageKey);
    c.data = stored[c.storageKey] || {};
    return c.data;
  })();
  try { return await c.loadPromise; }
  finally { c.loadPromise = null; }
}

// Schedule a debounced flush. Resets the timer on every call so a
// burst of writes coalesces into one storage op flushDebounceMs after
// the last write. The boundary case (SW death during the window) is
// acceptable: getStaleIds will re-enqueue the lost entries on next
// pass, no data integrity loss.
function scheduleFlush(name) {
  const c = caches.get(name);
  if (c.flushTimer) clearTimeout(c.flushTimer);
  c.flushPending = true;
  c.flushTimer = setTimeout(async () => {
    c.flushTimer = null;
    c.flushPending = false;
    try {
      await chrome.storage.local.set({ [c.storageKey]: c.data });
    } catch (err) {
      console.warn(`[cache-store] flush failed (${name})`, err?.message);
    }
  }, c.flushDebounceMs);
}

// Force a flush now and await it. Useful before SW-suspending ops or
// when telemetry needs to be visible to other surfaces immediately.
export async function flush(name) {
  const c = caches.get(name);
  if (!c) return;
  if (c.flushTimer) { clearTimeout(c.flushTimer); c.flushTimer = null; }
  if (!c.data) return;
  c.flushPending = false;
  await chrome.storage.local.set({ [c.storageKey]: c.data });
}

// Self-correct the in-memory mirror when storage changes from outside
// this module. Lazy: only updates caches that have been hydrated.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [name, c] of caches) {
    if (!c.data || !changes[c.storageKey]) continue;
    // Skip our own writes (the only one in flight is the debounced
    // flush we initiated). Detect by comparing the new value to
    // c.data's current shape — they'll be reference-different but
    // structurally equal. Simplest heuristic: ignore if our own flush
    // is pending or just fired (no other writer should be racing us
    // for the migrated keys).
    if (c.flushPending) continue;
    c.data = changes[c.storageKey].newValue || {};
  }
});

// Single-entry stale check. Treats:
//   - missing entry          → stale (needs fetch)
//   - permanent no-match     → not stale (don't re-search)
//   - in error backoff       → not stale (don't re-hammer)
//   - schema-version mismatch → stale (refetch by id)
//   - past TTL               → stale
//   - legacy error entry     → 1m grace from fetchedAt, then stale once
//
// The legacy-error grace exists so today's `_matchConfidence: 'error'`
// entries (written before this module existed) get exactly one retry
// attempt after a one-minute cooldown. If that retry succeeds, the
// entry is fully migrated; if it fails, markError gives it proper
// exponential backoff going forward.
function isEntryStale(config, entry) {
  if (!entry) return true;
  if (entry._noMatch) return false;
  if (entry._matchConfidence === 'error' && entry._retryAfter == null) {
    if (Date.now() < (entry.fetchedAt || 0) + 60_000) return false;
    return true;
  }
  if (entry._retryAfter && Date.now() < entry._retryAfter) return false;
  if (config.schemaVersion != null && entry._schema !== config.schemaVersion) return true;
  if (!entry.fetchedAt) return true;
  if (Date.now() - entry.fetchedAt >= config.ttl) return true;
  return false;
}

export async function get(name, id) {
  const data = await loadAll(name);
  return data[id] ?? null;
}

export async function getMany(name, ids) {
  const data = await loadAll(name);
  if (!ids) return { ...data };
  const out = {};
  for (const id of ids) if (data[id]) out[id] = data[id];
  return out;
}

export async function isStale(name, id) {
  const c = caches.get(name);
  if (!c) throw new Error(`cache-store: no cache "${name}" registered`);
  const data = await loadAll(name);
  return isEntryStale(c, data[id]);
}

export async function getStaleIds(name, ids) {
  const c = caches.get(name);
  if (!c) throw new Error(`cache-store: no cache "${name}" registered`);
  const data = await loadAll(name);
  const out = [];
  for (const id of ids) {
    if (isEntryStale(c, data[id])) out.push(id);
  }
  return out;
}

export async function inBackoff(name, id) {
  const data = await loadAll(name);
  const entry = data[id];
  if (!entry || entry._noMatch) return false;
  return !!(entry._retryAfter && Date.now() < entry._retryAfter);
}

// Write a successful entry. Clears any prior backoff state and stamps
// fetchedAt to now (unless the caller pre-stamped it).
export async function put(name, id, entry) {
  const data = await loadAll(name);
  data[id] = withFreshMetadata(entry);
  scheduleFlush(name);
}

// Batch ops flush immediately rather than debouncing — they represent
// "a complete batch operation done" and the caller's downstream code
// usually reads the cache right after (e.g. recomputeQualityAxes →
// computeAllShowsScored). Per-item put / markError still debounce.
export async function putBatch(name, entries) {
  const data = await loadAll(name);
  for (const [id, entry] of Object.entries(entries)) {
    data[id] = withFreshMetadata(entry);
  }
  await flush(name);
}

// Shallow-merge partial fields into existing entries. Preserves all
// cache metadata (_retryAfter, _attemptCount, fetchedAt, _noMatch),
// so this is the right call for *augmentation* passes (external-tags
// merge, quality-axes annotation) that add fields without re-fetching.
// Brand-new entries created by merge get default fresh metadata.
// Flushes immediately — same rationale as putBatch.
export async function mergeBatch(name, entries) {
  const data = await loadAll(name);
  for (const [id, entry] of Object.entries(entries)) {
    const prior = data[id];
    if (prior) {
      // Preserve metadata + payload; let entry's fields override prior's.
      data[id] = { ...prior, ...entry };
    } else {
      data[id] = withFreshMetadata(entry);
    }
  }
  await flush(name);
}

function withFreshMetadata(entry) {
  return {
    ...entry,
    fetchedAt:     entry.fetchedAt ?? Date.now(),
    _retryAfter:   0,
    _attemptCount: 0,
  };
}

// Mark a transient failure. Bumps attemptCount, computes the next
// retryAfter via exponential backoff. Preserves the prior entry's
// payload + _matchConfidence — a verified entry that briefly
// rate-limits stays verified, just with backoff metadata.
export async function markError(name, id, errorMessage) {
  const c = caches.get(name);
  const data = await loadAll(name);
  const prior = data[id] || {};
  const attemptCount = (prior._attemptCount || 0) + 1;
  const idx = Math.min(attemptCount - 1, c.errorBackoffMs.length - 1);
  data[id] = {
    ...prior,
    _retryAfter:   Date.now() + c.errorBackoffMs[idx],
    _attemptCount: attemptCount,
    _lastError:    String(errorMessage || ''),
    _lastErrorAt:  Date.now(),
  };
  scheduleFlush(name);
}

// Mark a permanent miss (e.g. AniList has no record for this title).
// Verified entries are protected — a search-side miss shouldn't
// downgrade a previously-fetched verified result. Non-verified entries
// get the noMatch marker so they're skipped on every future cycle.
export async function markNoMatch(name, id, reason) {
  const data = await loadAll(name);
  const prior = data[id] || {};
  if (prior._matchConfidence === 'verified'
      || prior._matchConfidence === 'unverified-best-guess') {
    // Don't downgrade. Just clear any backoff state from prior errors.
    data[id] = { ...prior, _retryAfter: 0, _attemptCount: 0 };
  } else {
    data[id] = {
      ...prior,
      _matchConfidence: 'no-match',
      _noMatch:         true,
      _noMatchReason:   reason || null,
      fetchedAt:        Date.now(),
      _retryAfter:      0,
      _attemptCount:    0,
    };
  }
  scheduleFlush(name);
}

// Diagnostic counts for popup telemetry / debugging.
export async function stats(name) {
  const c = caches.get(name);
  if (!c) throw new Error(`cache-store: no cache "${name}" registered`);
  const data = await loadAll(name);
  const now = Date.now();
  let fresh = 0, stale = 0, inBackoffCount = 0, noMatch = 0;
  for (const entry of Object.values(data)) {
    if (entry._noMatch) { noMatch++; continue; }
    if (entry._retryAfter && now < entry._retryAfter) { inBackoffCount++; continue; }
    if (isEntryStale(c, entry)) stale++;
    else fresh++;
  }
  return { total: Object.keys(data).length, fresh, stale, inBackoff: inBackoffCount, noMatch };
}
