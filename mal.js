// MyAnimeList API client. Mirrors anilist.js's shape — module-level
// pause state for circuit-breaker, request helper that all callers
// route through, functional exports for each operation.
//
// Why a separate module: per the architecture grilling on 2026-05-04
// (#4), AL and MAL have unrelated APIs (AL = GraphQL, MAL = REST),
// unrelated rate limits (AL: 90/min, MAL: undocumented but generous),
// and unrelated endpoints. Sharing a "client" abstraction would just
// rename two things into one without consolidating behavior. They
// each get their own module; cross-source orchestration lives in
// external-list-importer.js.
//
// Public interface (current):
//   fetchUserList(accessToken) → returns { [malId]: {score, status,
//                                progress, updatedAt} } across the
//                                user's full list (paginated)
//
// Future operations (sync / refresh) follow the same pattern: take an
// access token, return lightweight per-Series records keyed by malId.
// The orchestrator does the malId → aniListId cross-walk.

import * as gateway from './provider-gateway.js';

const API_BASE = 'https://api.myanimelist.net/v2';

// Register MAL with the provider gateway. Behavior preserved from the
// pre-gateway implementation:
//   - 429 retries up to 3× honoring Retry-After (capped 120s).
//   - 429 after exhaust trips a 5-min breaker (much shorter than AL's
//     15min — MAL recovers faster from politeness pauses).
//   - Network errors retry up to 3× with a 3s gap.
//   - 5xx is NOT auto-retried (preserving today's behavior).
//
// defaultGapMs=200: matches the prior caller-side pacing in
// fetchUserList. MAL doesn't publish a hard rate limit; 5 req/sec is
// well within "be reasonable."
gateway.registerProvider('mal', {
  baseUrl: API_BASE,
  defaultGapMs: 200,
  retry: { maxAttempts: 3, on: ['429', 'network'] },
  tripBreakerImmediately: {},
  tripBreakerOnExhaust: { 429: 5 * 60 * 1000 },
});

// Breaker-state queries delegate to the gateway. Kept as named exports
// so any future consumer can ask "is MAL paused?" the same way AL exposes.
export function malIsPaused() { return gateway.isBreakerOpen('mal'); }
export function malPauseMsLeft() { return gateway.getProviderHealth('mal').breakerMsLeft; }

// REST adapter on top of the gateway. The gateway owns transport;
// this function adds the bearer header and the accessToken-required
// invariant. Throws on failure to preserve the contract every existing
// caller in this module relies on.
async function malRequest(path, opts = {}) {
  if (!opts.accessToken) {
    throw new Error(`mal ${opts.contextLabel || path}: accessToken required`);
  }
  const result = await gateway.request('mal', {
    method: 'GET',
    path,
    headers: { 'Authorization': `Bearer ${opts.accessToken}` },
    contextLabel: opts.contextLabel || path,
    signal: opts.signal,
  });
  if (!result.ok) {
    if (result.kind === 'breaker-open') {
      const secondsLeft = Math.ceil((result.retryAfterMs ?? 0) / 1000);
      throw new Error(`mal circuit-breaker (${opts.contextLabel || path}): paused for ${secondsLeft}s`);
    }
    if (result.kind === 'auth' && result.status === 401) {
      // Token revoked / expired. The OAuth manager owns refresh.
      throw new Error(`mal http 401 (${opts.contextLabel || path}) — token invalid`);
    }
    throw new Error(result.message);
  }
  return result.data;
}

// MAL list-status values map onto the Sentiment status vocabulary as:
//   watching       → 'watching'
//   completed      → 'completed'
//   on_hold        → 'paused'
//   dropped        → 'dropped'
//   plan_to_watch  → 'planning'
const MAL_STATUS_NORMALIZE = {
  'watching':       'watching',
  'completed':      'completed',
  'on_hold':        'paused',
  'dropped':        'dropped',
  'plan_to_watch':  'planning',
};

// Fetch the authenticated user's full anime list. Paginated (MAL's
// default page size is 100; we follow paging.next until exhausted).
// Returns { [malId]: { score, status, progress, updatedAt } } —
// score is null when user hasn't rated (MAL stores 0 for unscored).
//
// Note: keys are MAL IDs, NOT AniList IDs. The cross-walk happens in
// external-list-importer.js, which queries AL's `Media(idMal: …)` to
// resolve aniListId for each entry.
export async function fetchUserList(accessToken, opts = {}) {
  if (!accessToken) throw new Error('fetchUserList requires accessToken');
  const signal = opts.signal || null;
  const onPage = typeof opts.onPage === 'function' ? opts.onPage : null;

  const out = {};
  // The fields parameter requests exactly what we need; smaller
  // payload = faster pagination over a 1500-entry list.
  let nextUrl = `${API_BASE}/users/@me/animelist?fields=list_status&limit=1000&nsfw=true`;
  let pageNum = 0;
  while (nextUrl) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const json = await malRequest(nextUrl, { accessToken, contextLabel: `userList page ${pageNum}` });
    pageNum++;
    const entries = json?.data || [];
    for (const entry of entries) {
      const malId = entry?.node?.id;
      if (!Number.isInteger(malId)) continue;
      const ls = entry.list_status || {};
      const score = (typeof ls.score === 'number' && ls.score > 0) ? ls.score : null;
      const status = MAL_STATUS_NORMALIZE[ls.status] || null;
      out[malId] = {
        score,
        status,
        progress:  ls.num_episodes_watched ?? null,
        updatedAt: ls.updated_at ?? null,
      };
    }
    if (onPage) {
      try { await onPage({ pageNum, totalSoFar: Object.keys(out).length, batch: entries.length }); }
      catch (err) { console.warn('[mal] fetchUserList onPage threw', err); }
    }
    nextUrl = json?.paging?.next || null;

  }
  return out;
}

// XML export parsing lives in mal-xml.js — pure helpers, no
// provider-gateway dependency. Imported by import-mal-xml.html.
// See mal-xml.js header for why the split.

