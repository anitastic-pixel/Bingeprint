// Provider gateway — single seam for all outbound HTTP from the SW.
//
// Owns: per-provider serial queue, retry, Retry-After, circuit-breaker,
// in-flight dedup, 429 + backoff telemetry. HTTP-only — providers that
// need envelope semantics (e.g. AniList GraphQL) layer that on top.
//
// Returns Result<T, ErrorKind> instead of throwing for HTTP outcomes:
//   { ok: true,  status, data }
//   { ok: false, kind, status?, retryAfterMs?, message }
//
// where kind ∈ 'rate-limited' | 'auth' | 'network' | 'http-error'
//             | 'parse' | 'aborted' | 'breaker-open'
//
// Throws only for programmer-error situations (provider not registered).
// AL/MAL still expose throw-shaped wrappers; CR will adopt the Result
// shape directly so transient failures stop being indistinguishable
// from "user has no items."

const providers       = new Map(); // name -> config
const breakerStates   = new Map(); // name -> { until, count429s, totalBackoffMs }
const inflight        = new Map(); // dedupKey -> Promise<Result>
const queueTails      = new Map(); // name -> Promise (serial chain per provider)
const lastFinishedAt  = new Map(); // name -> timestamp of last request finishing
const dynamicGaps     = new Map(); // name -> adaptive gap (ms) learned from rate-limit headers

// Map provider names to the storage telemetry slot popup.js already
// reads. Today only AL has a slot; MAL/CR slots will land with their
// ports and the popup will gain rows for them.
const TELEMETRY_KEY_BY_PROVIDER = {
  anilist: '_anilistRateLimit',
};

export function registerProvider(name, config) {
  // config:
  //   baseUrl                — string, prepended when req.path is relative
  //   defaultGapMs           — number, ms wait after each request to this provider
  //   retry: { maxAttempts, on: ['429','5xx','network'] }
  //   tripBreakerImmediately — { [status]: durationMs }   trip on first hit
  //   tripBreakerOnExhaust   — { [status]: durationMs }   trip after retries exhausted
  //   resolveToken?          — async () => string | null
  //                            When set, the gateway adds 'Authorization: Bearer <token>'
  //                            to every request unless the caller pre-set Authorization.
  //                            On 401, the gateway re-resolves once and retries (handles
  //                            token rotation, e.g. CR's bridge.js writing a new token).
  //                            Returns auth-error Result if resolveToken throws or yields null.
  providers.set(name, {
    baseUrl: '',
    defaultGapMs: 0,
    // adaptiveRateLimit: when true, the gateway reads the response's
    // `X-RateLimit-Limit` header and paces ~10% under that per-minute
    // budget, clamped to [GAP_FLOOR, GAP_CEIL]. Lets a provider whose
    // limit fluctuates (AniList: 90/min normally, 30/min when degraded
    // or penalised) self-tune instead of being hardcoded to one number.
    // defaultGapMs is the conservative starting gap until the first
    // response reveals the real limit.
    adaptiveRateLimit: false,
    retry: { maxAttempts: 3, on: ['429', '5xx', 'network'] },
    tripBreakerImmediately: {},
    tripBreakerOnExhaust: {},
    resolveToken: null,
    ...config,
  });
  if (!breakerStates.has(name)) {
    breakerStates.set(name, { until: 0, count429s: 0, totalBackoffMs: 0 });
  }
}

export function getProviderHealth(name) {
  const state = breakerStates.get(name);
  if (!state) return { breakerUntil: 0, breakerMsLeft: 0, count429s: 0, totalBackoffMs: 0 };
  return {
    breakerUntil:    state.until,
    breakerMsLeft:   Math.max(0, state.until - Date.now()),
    count429s:       state.count429s,
    totalBackoffMs:  state.totalBackoffMs,
    effectiveGapMs:  dynamicGaps.get(name) ?? providers.get(name)?.defaultGapMs ?? 0,
  };
}

export function isBreakerOpen(name) {
  const state = breakerStates.get(name);
  return !!state && Date.now() < state.until;
}

// Submit a request through the gateway.
//
// req:
//   method        — 'GET' | 'POST' | ...           (default 'GET')
//   path          — appended to baseUrl, OR
//   url           — absolute URL                   (overrides path)
//   headers       — extra headers                  (Content-Type set automatically for body)
//   body          — string | object | undefined    (objects JSON-stringified)
//   signal        — AbortSignal
//   contextLabel  — short string for log lines
//   expectBody    — 'json' (default) | 'text' | 'none'
//   dedup         — false to opt out (default: true)
//   dedupKey      — override the auto-generated key
export async function request(providerName, req) {
  const config = providers.get(providerName);
  if (!config) {
    throw new Error(`provider-gateway: no provider "${providerName}" registered`);
  }

  const url = req.url
    ? req.url
    : (req.path && req.path.startsWith('http') ? req.path : `${config.baseUrl}${req.path ?? ''}`);

  const dedupOn = req.dedup !== false;
  const dedupKey = req.dedupKey ?? buildDedupKey(providerName, req.method ?? 'GET', url, req.body);
  if (dedupOn && inflight.has(dedupKey)) {
    return inflight.get(dedupKey);
  }

  const promise = enqueue(providerName, config, () => execute(providerName, config, url, req));

  if (dedupOn) {
    inflight.set(dedupKey, promise);
    promise.finally(() => {
      if (inflight.get(dedupKey) === promise) inflight.delete(dedupKey);
    });
  }
  return promise;
}

// Per-provider serial queue. defaultGapMs paces requests at the
// provider boundary so callers don't reinvent rate-limiting.
//
// Pacing semantics: gap is enforced BEFORE the next request, gating
// against the timestamp of the last request's completion. Idle time
// counts toward the gap (a request after a long quiet period fires
// immediately, no pointless wait), and the LAST request in a batch
// returns to its caller without paying the gap (we only sleep when
// there's a *next* request to gate). Cross-caller pacing falls out
// for free — concurrent callers serialize through the same chain.
function enqueue(providerName, config, fn) {
  const prev = queueTails.get(providerName) ?? Promise.resolve();
  const next = prev.then(async () => {
    // Effective gap: the adaptive value learned from rate-limit headers if
    // present, otherwise the provider's configured default.
    const gap = dynamicGaps.get(providerName) ?? config.defaultGapMs;
    if (gap > 0) {
      const lastEnd = lastFinishedAt.get(providerName) ?? 0;
      const elapsed = Date.now() - lastEnd;
      if (elapsed < gap) {
        await new Promise(r => setTimeout(r, gap - elapsed));
      }
    }
    try {
      return await fn();
    } finally {
      lastFinishedAt.set(providerName, Date.now());
    }
  });
  // Suppress rejection on the chain so a thrown request doesn't kill
  // pacing for everyone after it. The returned `next` still surfaces
  // any thrown error to the original caller.
  queueTails.set(providerName, next.catch(() => {}));
  return next;
}

async function execute(providerName, config, url, req) {
  const state = breakerStates.get(providerName);
  if (Date.now() < state.until) {
    return {
      ok: false,
      kind: 'breaker-open',
      retryAfterMs: state.until - Date.now(),
      message: `${providerName} circuit-breaker open for ${Math.ceil((state.until - Date.now()) / 1000)}s`,
    };
  }

  const method = req.method ?? 'GET';
  const headers = { 'Accept': 'application/json', ...(req.headers || {}) };
  let body;
  if (req.body != null) {
    if (typeof req.body === 'string') {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
  }
  const contextLabel = req.contextLabel ?? `${method} ${url}`;
  const retry = config.retry;
  const retryOn = new Set(retry.on);
  const maxAttempts = retry.maxAttempts;

  // Auto-resolve auth token if the provider is configured for it AND
  // the caller hasn't pre-set Authorization. Tracks the resolved value
  // so 401-retry can detect token rotation (e.g. CR's bridge.js wrote
  // a new token mid-session) and try once more with the fresh one.
  let resolvedToken = null;
  if (config.resolveToken && !headers['Authorization']) {
    try {
      resolvedToken = await config.resolveToken();
    } catch (err) {
      return { ok: false, kind: 'auth', message: `${providerName} resolveToken failed (${contextLabel}): ${err?.message ?? err}` };
    }
    if (!resolvedToken) {
      return { ok: false, kind: 'auth', message: `${providerName}: no token available (${contextLabel})` };
    }
    headers['Authorization'] = `Bearer ${resolvedToken}`;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (req.signal?.aborted) {
      return { ok: false, kind: 'aborted', message: `${providerName} aborted (${contextLabel})` };
    }

    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: req.signal });
    } catch (networkErr) {
      if (networkErr?.name === 'AbortError') {
        return { ok: false, kind: 'aborted', message: networkErr.message };
      }
      if (!retryOn.has('network') || attempt === maxAttempts) {
        return {
          ok: false, kind: 'network',
          message: `${providerName} network error (${contextLabel}): ${networkErr?.message ?? networkErr}`,
        };
      }
      console.warn(`[gateway] ${providerName} network error (${contextLabel}), retry in 3s`, networkErr?.message);
      try { await sleep(3000, req.signal); }
      catch { return { ok: false, kind: 'aborted', message: `${providerName} aborted (${contextLabel})` }; }
      continue;
    }

    // Learn the real rate-limit budget from this response (any status —
    // 429s carry the headers too) and re-pace future requests accordingly.
    maybeAdaptGap(providerName, config, res);

    // Immediate breaker trips (e.g. AL 403). Set state, then return —
    // don't burn more attempts hammering Cloudflare.
    const immediateMs = config.tripBreakerImmediately[res.status];
    if (immediateMs) {
      state.until = Date.now() + immediateMs;
      console.warn(`[gateway] ${providerName} ${res.status} (${contextLabel}) — breaker engaged for ${Math.round(immediateMs / 1000)}s`);
      writeTelemetry(providerName, state);
      return {
        ok: false,
        kind: res.status === 401 ? 'auth' : (res.status === 403 ? 'auth' : 'http-error'),
        status: res.status,
        message: `${providerName} http ${res.status} (${contextLabel}) — breaker engaged`,
      };
    }

    if (res.status === 429) {
      state.count429s++;
      if (attempt === maxAttempts || !retryOn.has('429')) {
        const exhaustMs = config.tripBreakerOnExhaust[429];
        if (exhaustMs) {
          state.until = Date.now() + exhaustMs;
          console.warn(`[gateway] ${providerName} 429 exhausted (${contextLabel}) — breaker engaged for ${Math.round(exhaustMs / 1000)}s`);
        }
        writeTelemetry(providerName, state);
        return {
          ok: false, kind: 'rate-limited', status: 429,
          message: `${providerName} http 429 (${contextLabel}, gave up after ${attempt} tries)`,
        };
      }
      const ra = parseInt(res.headers.get('Retry-After') || '60', 10);
      const waitMs = Math.min(Math.max(ra, 1) * 1000, 120_000);
      state.totalBackoffMs += waitMs;
      writeTelemetry(providerName, state);
      console.warn(`[gateway] ${providerName} 429 (${contextLabel}), sleeping ${waitMs}ms before retry`);
      try { await sleep(waitMs, req.signal); }
      catch { return { ok: false, kind: 'aborted', message: `${providerName} aborted (${contextLabel})` }; }
      continue;
    }

    if (res.status === 401) {
      // If we auto-resolved the token and still have attempts left,
      // re-resolve once in case the token rotated (CR's bridge.js
      // writes a new crToken whenever the user navigates CR; our
      // first read might be stale by the time the request fires).
      // Retry only if the re-resolved value actually differs — same
      // value coming back means it's a real 401, not stale token.
      if (config.resolveToken && resolvedToken && attempt < maxAttempts) {
        let refreshed = null;
        try { refreshed = await config.resolveToken(); }
        catch (_) { /* fall through to auth-error return */ }
        if (refreshed && refreshed !== resolvedToken) {
          resolvedToken = refreshed;
          headers['Authorization'] = `Bearer ${refreshed}`;
          console.warn(`[gateway] ${providerName} 401 (${contextLabel}) — token rotated, retrying with fresh`);
          continue;
        }
      }
      // Token expired / revoked. The OAuth manager owns refresh;
      // surfacing as 'auth' lets callers route it there.
      return { ok: false, kind: 'auth', status: 401, message: `${providerName} http 401 (${contextLabel})` };
    }

    if (res.status >= 500 && res.status < 600) {
      if (attempt === maxAttempts || !retryOn.has('5xx')) {
        return { ok: false, kind: 'http-error', status: res.status, message: `${providerName} http ${res.status} (${contextLabel})` };
      }
      console.warn(`[gateway] ${providerName} ${res.status} (${contextLabel}), retry in 3s`);
      try { await sleep(3000, req.signal); }
      catch { return { ok: false, kind: 'aborted', message: `${providerName} aborted (${contextLabel})` }; }
      continue;
    }

    if (!res.ok) {
      return { ok: false, kind: 'http-error', status: res.status, message: `${providerName} http ${res.status} (${contextLabel})` };
    }

    let data;
    try {
      const expect = req.expectBody ?? 'json';
      if      (expect === 'text') data = await res.text();
      else if (expect === 'none') data = null;
      else                        data = await res.json();
    } catch (parseErr) {
      return { ok: false, kind: 'parse', status: res.status, message: `${providerName} parse error (${contextLabel}): ${parseErr.message}` };
    }
    return { ok: true, status: res.status, data };
  }

  // Unreachable — every retry-loop path returns above.
  return { ok: false, kind: 'http-error', message: `${providerName} retry loop exhausted (${contextLabel})` };
}

// Adaptive pacing bounds. FLOOR keeps us from over-trusting a high header
// (AniList's normal 90/min → ~733ms, so 700 is a safe floor); CEIL caps the
// slowdown if a provider ever reports an absurdly low limit.
const GAP_FLOOR_MS = 700;
const GAP_CEIL_MS = 5000;

// Re-pace `providerName` from the response's X-RateLimit-Limit header (a
// per-minute budget). Targets ~10% under the budget so the serial queue
// stays comfortably inside it. No-op unless the provider opted in and the
// header is present + numeric — so providers without rate-limit headers
// keep their static defaultGapMs.
function maybeAdaptGap(providerName, config, res) {
  if (!config.adaptiveRateLimit) return;
  const raw = res.headers.get('X-RateLimit-Limit');
  const perMin = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(perMin) || perMin <= 0) return;
  const target = Math.ceil((60000 / perMin) * 1.1);
  const gap = Math.min(Math.max(target, GAP_FLOOR_MS), GAP_CEIL_MS);
  if (dynamicGaps.get(providerName) !== gap) {
    dynamicGaps.set(providerName, gap);
    console.log(`[gateway] ${providerName} rate-limit ${perMin}/min → pacing ${gap}ms`);
  }
}

function buildDedupKey(provider, method, url, body) {
  const bodyKey = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return `${provider}|${method}|${url}|${bodyKey}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(id);
        return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function writeTelemetry(providerName, state) {
  const key = TELEMETRY_KEY_BY_PROVIDER[providerName];
  if (!key) return;
  try {
    await chrome.storage.local.set({
      [key]: {
        count429s:      state.count429s,
        totalBackoffMs: state.totalBackoffMs,
        breakerUntil:   state.until,
        updatedAt:      Date.now(),
      },
    });
  } catch (err) {
    // chrome.storage failure is non-fatal for the request itself.
    console.warn(`[gateway] telemetry write failed (${providerName})`, err?.message);
  }
}
