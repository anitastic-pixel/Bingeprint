// OAuth token management for the External score sources (AniList, MAL).
//
// Why this module exists: the AniList/MAL list-import feature needs
// long-lived OAuth tokens for two distinct providers. Without one
// place that owns the lifecycle (auth flow, storage shape, refresh,
// sign-out), each consumer would grow its own auth boilerplate. Per
// the architecture grilling on 2026-05-04, this module is the seam.
//
// Design decisions (locked in CONTEXT.md + the grilling session):
//   - Tokens persisted in chrome.storage.local (key 'oauthTokens'),
//     unencrypted on disk. Tradeoff: a compromised Chrome profile
//     exposes the tokens. Mitigations: read-only scopes (worst-case
//     leak = "an attacker can read someone's anime list"), explicit
//     sign-out, server-side revocation.
//   - chrome.identity.launchWebAuthFlow + PKCE (no embedded secret).
//   - Single 'oauthTokens' key, sources nested. One subscription, one
//     read, one write.
//   - Lazy refresh on 401 + proactive expiry check (5-min headroom)
//     when getValidToken() is called. No background scheduled refresh.
//
// Public interface:
//   authenticate(source)     → kicks off the OAuth dance; resolves
//                              with { account: {id, name} } or rejects
//   getValidToken(source)    → resolves with a fresh access token,
//                              refreshing if expiry is near; throws if
//                              no token exists or refresh fails
//   signOut(source)          → clears stored token; attempts revoke
//                              server-side (best-effort, ignores fail)
//   getAccount(source)       → returns cached { id, name } or null;
//                              cheap synchronous check for "is the
//                              user signed in?"
//
// Extension manifest requirements (NOT YET WIRED — popup integration
// step adds them):
//   - "identity" permission (chrome.identity.launchWebAuthFlow)
//   - host_permissions for AL token endpoint + MAL token + API
//     (auth-flow popups don't need host_permissions but token POST
//     and account-fetch from background do)

import { STORAGE_KEYS } from './storage-schema.js';

// Source-specific configuration. Client IDs aren't secret with PKCE
// (the verifier replaces the secret), so they live in code. the user
// (or whoever ships this) registers the extension as a public OAuth
// client with each provider once and replaces the placeholder IDs.
//
// Refresh-token semantics differ:
//   AniList: NO refresh tokens; access_token lifetime is ~1 year.
//            On expiry, user must re-run authenticate(). Detected as
//            "no refresh_token + within expiry window" → throw a typed
//            error so the popup can prompt re-auth instead of looping.
//   MAL:     Standard refresh tokens; access_token lifetime is ~31
//            days, refresh_token rotates on each use.
const SOURCES = {
  anilist: {
    displayName: 'AniList',
    // Public client ID issued via https://anilist.co/settings/developer.
    clientId: '40647',
    // AniList list-import NO LONGER uses OAuth. AniList rejects both PKCE
    // and implicit grant (only auth-code + client_secret works), which would
    // mean shipping a client secret in a public extension. We instead fetch
    // the user's PUBLIC list by username via anilist.js fetchUserListByName()
    // — no token, no secret, no server. authenticate('anilist') is no longer
    // invoked; the fields below are vestigial and the client_secret is gone.
    authorizeUrl: 'https://anilist.co/api/v2/oauth/authorize',
    tokenUrl:     'https://anilist.co/api/v2/oauth/token',
    flow: 'code+secret',
    // AL uses no scope strings; the token grants access to the user's
    // own data (which is the only thing we need for list-import).
    scope: '',
    hasRefreshToken: false,
    // AL's GraphQL Viewer query — returns the authenticated user's
    // id + name. Used post-authenticate to populate `account`.
    fetchAccount: async (accessToken) => {
      const resp = await fetch('https://graphql.anilist.co/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: 'query{Viewer{id name}}' }),
      });
      if (!resp.ok) throw new Error(`AniList Viewer query failed: ${resp.status}`);
      const data = await resp.json();
      const v = data?.data?.Viewer;
      if (!v?.id) throw new Error('AniList Viewer query returned no user');
      return { id: v.id, name: v.name };
    },
  },
  mal: {
    displayName: 'MyAnimeList',
    // MAL's PKCE flow works correctly (no client_secret needed for
    // public clients).
    flow: 'pkce',
    // Replace with the client ID issued at
    // https://myanimelist.net/apiconfig — App Type = "Other", redirect
    // URL = chrome-extension's chromiumapp.org URL (printed by
    // chrome.identity.getRedirectURL()).
    clientId: 'TODO_MAL_CLIENT_ID',
    authorizeUrl: 'https://myanimelist.net/v1/oauth2/authorize',
    tokenUrl:     'https://myanimelist.net/v1/oauth2/token',
    scope: '',
    hasRefreshToken: true,
    fetchAccount: async (accessToken) => {
      const resp = await fetch('https://api.myanimelist.net/v2/users/@me', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (!resp.ok) throw new Error(`MAL @me query failed: ${resp.status}`);
      const data = await resp.json();
      if (!data?.id) throw new Error('MAL @me returned no user');
      return { id: data.id, name: data.name };
    },
  },
};

// Refresh `expires_at` this many milliseconds before the actual
// expiry. Avoids the round-trip of "fire request → 401 → refresh →
// retry" for predictable expiry. 5 minutes is short enough that we
// don't burn unused tokens, long enough to cover clock skew.
const PROACTIVE_REFRESH_HEADROOM_MS = 5 * 60 * 1000;

// ── PKCE helpers ─────────────────────────────────────────────────
// RFC 7636 — a code_verifier is a high-entropy random string; the
// challenge sent in the authorize URL is its SHA-256 digest, base64url
// encoded. The auth server binds the issued auth code to the
// challenge; redeeming the code requires the original verifier. An
// attacker who intercepts the auth code can't redeem it without the
// verifier, which never leaves the extension.

function base64UrlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier() {
  const arr = new Uint8Array(32); // 32 bytes → 43-char base64url, within RFC's 43-128 range
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

async function generateCodeChallenge(verifier) {
  const enc = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return base64UrlEncode(new Uint8Array(hash));
}

// ── Storage helpers ──────────────────────────────────────────────

async function readAll() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.oauthTokens);
  return stored[STORAGE_KEYS.oauthTokens] || {};
}

async function readSource(source) {
  const all = await readAll();
  return all[source] || null;
}

async function writeSource(source, data) {
  const all = await readAll();
  if (data == null) delete all[source];
  else all[source] = data;
  await chrome.storage.local.set({ [STORAGE_KEYS.oauthTokens]: all });
}

// ── Auth flow ────────────────────────────────────────────────────

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code; // 'reauth_required' | 'cancelled' | 'token_exchange_failed' | 'unknown_source'
  }
}

function getRedirectUrl() {
  // Chrome's standard pattern. Same per-extension URL across all
  // OAuth providers; we let the URL fragment / query carry source
  // disambiguation when needed (auth-flow popups always know their
  // own source).
  return chrome.identity.getRedirectURL();
}

// Run the OAuth Authorization Code + PKCE flow. Returns the token
// payload (access_token, refresh_token, expires_in seconds, ...) on
// success; throws AuthError on cancel / failure.
async function runAuthFlow(source) {
  const cfg = SOURCES[source];
  if (!cfg) throw new AuthError(`Unknown source: ${source}`, 'unknown_source');

  // Setup-time guard — surface a clear error if the client ID is
  // still the TODO_ placeholder. Without this, the OAuth flow opens
  // a popup that 400s on the authorize URL with "invalid client"
  // and the user has no idea why.
  const idMissing = typeof cfg.clientId === 'string' && cfg.clientId.startsWith('TODO_');
  const secretMissing = cfg.flow === 'code+secret'
    && typeof cfg.clientSecret === 'string'
    && cfg.clientSecret.startsWith('TODO_');
  if (idMissing || secretMissing) {
    const setupUrl = source === 'anilist'
      ? 'https://anilist.co/settings/developer'
      : 'https://myanimelist.net/apiconfig';
    let redirect = '';
    try { redirect = chrome.identity.getRedirectURL(); } catch (_) {}
    const missing = idMissing && secretMissing ? 'client ID + client secret'
      : idMissing ? 'client ID' : 'client secret';
    throw new AuthError(
      `${cfg.displayName} OAuth not yet configured (missing ${missing}). `
      + `Register at ${setupUrl} (redirect URL: ${redirect || '<check worker console>'}) `
      + `and paste the issued credentials into oauth-manager.js.`,
      'not_configured',
    );
  }

  if (cfg.flow === 'implicit') return runImplicitFlow(cfg);
  if (cfg.flow === 'code+secret') return runCodeWithSecretFlow(cfg);
  return runPkceFlow(cfg);
}

// Authorization Code Grant with embedded client_secret. Used by
// AniList because they don't support PKCE-only public clients OR
// Implicit Grant. The client_secret in code is a deliberate tradeoff
// (see SOURCES.anilist comments). Otherwise structurally identical
// to the PKCE flow without the verifier/challenge.
async function runCodeWithSecretFlow(cfg) {
  const redirectUri = getRedirectUrl();
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.searchParams.set('client_id', cfg.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  if (cfg.scope) authUrl.searchParams.set('scope', cfg.scope);
  // prompt=login asks the provider to surface the login screen even
  // when the auth window inherits an existing session. Used so a fresh
  // "connect" after disconnect actually lets the user pick which
  // account to sign in as instead of silently reusing whatever cookie
  // the OAuth window already has. AniList currently ignores this
  // param (the consent screen is shown either way once an account is
  // logged in); harmless if unsupported.
  authUrl.searchParams.set('prompt', 'login');

  console.log(`[oauth] ${cfg.displayName} code+secret flow START`);
  console.log(`[oauth] redirectUri:`, redirectUri);
  console.log(`[oauth] authUrl:`, authUrl.toString());

  let redirectResponse;
  try {
    redirectResponse = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });
  } catch (err) {
    console.warn(`[oauth] ${cfg.displayName} launchWebAuthFlow rejected:`, err);
    throw new AuthError(`Auth flow cancelled: ${err.message || err}`, 'cancelled');
  }
  console.log(`[oauth] ${cfg.displayName} redirectResponse:`, redirectResponse);
  if (!redirectResponse) {
    throw new AuthError('Auth flow returned no redirect URL', 'cancelled');
  }

  const redirectParams = new URL(redirectResponse).searchParams;
  if (redirectParams.get('state') !== state) {
    throw new AuthError('OAuth state mismatch (possible CSRF)', 'token_exchange_failed');
  }
  const code = redirectParams.get('code');
  if (!code) {
    const errMsg = redirectParams.get('error_description') || redirectParams.get('error') || 'no code';
    throw new AuthError(`Auth flow returned no code: ${errMsg}`, 'token_exchange_failed');
  }

  // Token exchange with client_secret. AniList's docs specify
  // application/json for the body; their endpoint does NOT accept
  // urlencoded form data the way most providers do.
  const tokenResp = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type:    'authorization_code',
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri:  redirectUri,
      code:          code,
    }),
  });
  if (!tokenResp.ok) {
    const text = await tokenResp.text().catch(() => '');
    throw new AuthError(`Token exchange failed (${tokenResp.status}): ${text.slice(0, 200)}`, 'token_exchange_failed');
  }
  const tokens = await tokenResp.json();
  if (!tokens.access_token) {
    throw new AuthError('Token response missing access_token', 'token_exchange_failed');
  }
  return tokens;
}

// Implicit flow — used by AniList because their token endpoint
// requires a client_secret (PKCE-only public clients fail with 401
// invalid_client). Token comes back directly in the redirect URL's
// fragment as `#access_token=…&token_type=Bearer&expires_in=…&state=…`.
async function runImplicitFlow(cfg) {
  const redirectUri = getRedirectUrl();
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.searchParams.set('client_id', cfg.clientId);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  if (cfg.scope) authUrl.searchParams.set('scope', cfg.scope);

  console.log(`[oauth] ${cfg.displayName} implicit flow START`);
  console.log(`[oauth] redirectUri:`, redirectUri);
  console.log(`[oauth] authUrl:`, authUrl.toString());

  let redirectResponse;
  try {
    redirectResponse = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });
  } catch (err) {
    console.warn(`[oauth] ${cfg.displayName} launchWebAuthFlow rejected:`, err);
    throw new AuthError(`Auth flow cancelled: ${err.message || err}`, 'cancelled');
  }
  console.log(`[oauth] ${cfg.displayName} redirectResponse:`, redirectResponse);
  if (!redirectResponse) {
    throw new AuthError('Auth flow returned no redirect URL', 'cancelled');
  }

  // Implicit flow returns params in the URL fragment, not the query
  // string. Parse manually since URL.hash includes the leading '#'.
  const url = new URL(redirectResponse);
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  // Some providers (defensive) may put error info in the query string
  // even for the implicit flow. Read both and prefer fragment.
  const params = new URLSearchParams(fragment || url.search.slice(1));
  const errorCode = params.get('error');
  if (errorCode) {
    const desc = params.get('error_description') || errorCode;
    throw new AuthError(`Auth provider returned error: ${desc}`, 'token_exchange_failed');
  }
  const returnedState = params.get('state');
  if (returnedState !== state) {
    throw new AuthError('OAuth state mismatch (possible CSRF)', 'token_exchange_failed');
  }
  const accessToken = params.get('access_token');
  if (!accessToken) {
    throw new AuthError('Implicit flow returned no access_token', 'token_exchange_failed');
  }
  // Synthesize the same shape PKCE produces so downstream code
  // (normalizeTokens, store) doesn't branch.
  return {
    access_token: accessToken,
    token_type:   params.get('token_type') || 'Bearer',
    expires_in:   parseInt(params.get('expires_in') || '0', 10) || 0,
    scope:        params.get('scope') || null,
    refresh_token: null, // implicit grant doesn't issue refresh tokens
  };
}

// Authorization Code + PKCE flow — used by MAL. Standard public-
// client flow: high-entropy verifier on this side, SHA-256 challenge
// in the authorize URL, code returns in query params, exchanged for
// tokens via POST with the verifier proving the requestor.
async function runPkceFlow(cfg) {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const redirectUri = getRedirectUrl();
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.searchParams.set('client_id', cfg.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  if (cfg.scope) authUrl.searchParams.set('scope', cfg.scope);

  let redirectResponse;
  try {
    redirectResponse = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });
  } catch (err) {
    throw new AuthError(`Auth flow cancelled: ${err.message || err}`, 'cancelled');
  }
  if (!redirectResponse) {
    throw new AuthError('Auth flow returned no redirect URL', 'cancelled');
  }

  const redirectParams = new URL(redirectResponse).searchParams;
  const returnedState = redirectParams.get('state');
  if (returnedState !== state) {
    throw new AuthError('OAuth state mismatch (possible CSRF)', 'token_exchange_failed');
  }
  const code = redirectParams.get('code');
  if (!code) {
    const errMsg = redirectParams.get('error_description') || redirectParams.get('error') || 'no code';
    throw new AuthError(`Auth flow returned no code: ${errMsg}`, 'token_exchange_failed');
  }

  const tokenResp = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     cfg.clientId,
      code:          code,
      redirect_uri:  redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenResp.ok) {
    const text = await tokenResp.text().catch(() => '');
    throw new AuthError(`Token exchange failed (${tokenResp.status}): ${text.slice(0, 200)}`, 'token_exchange_failed');
  }
  const tokens = await tokenResp.json();
  if (!tokens.access_token) {
    throw new AuthError('Token response missing access_token', 'token_exchange_failed');
  }
  return tokens;
}

// Refresh an existing access_token using the stored refresh_token.
// Only valid for sources where hasRefreshToken=true. AL throws
// 'reauth_required' to signal the popup needs to re-run authenticate().
async function refreshAccessToken(source, stored) {
  const cfg = SOURCES[source];
  if (!cfg.hasRefreshToken || !stored?.refresh_token) {
    throw new AuthError(`${cfg.displayName} requires re-authentication`, 'reauth_required');
  }
  const resp = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     cfg.clientId,
      refresh_token: stored.refresh_token,
    }).toString(),
  });
  if (!resp.ok) {
    // 4xx on refresh = the refresh token itself is invalid (revoked,
    // expired, or rotated and the rotation we have is stale). Either
    // way the user has to re-authenticate.
    throw new AuthError(`Refresh failed (${resp.status})`, 'reauth_required');
  }
  return await resp.json();
}

// Persist tokens with a normalized expires_at timestamp. Both AL and
// MAL return expires_in seconds; convert to absolute ms-since-epoch
// so the proactive-refresh check is a simple comparison.
function normalizeTokens(tokens, prevAccount = null) {
  const expiresInMs = (tokens.expires_in || 0) * 1000;
  return {
    access_token:  tokens.access_token,
    // Preserve previous refresh_token if the response doesn't include
    // a new one (some providers only return refresh_token on initial
    // exchange, not on refresh).
    refresh_token: tokens.refresh_token || prevAccount?.refresh_token || null,
    expires_at:    expiresInMs > 0 ? Date.now() + expiresInMs : null,
    scope:         tokens.scope || null,
    account:       prevAccount?.account || null, // populated separately via fetchAccount
  };
}

// ── Public API ───────────────────────────────────────────────────

export async function authenticate(source) {
  const cfg = SOURCES[source];
  if (!cfg) throw new AuthError(`Unknown source: ${source}`, 'unknown_source');

  const tokens = await runAuthFlow(source);
  const normalized = normalizeTokens(tokens, null);

  // Fetch account details so the popup can show "Signed in as
  // {name}". A failure here doesn't void the auth — the token is
  // valid, just account-fetch failed (network blip, slow API). Store
  // the token; account will populate on next getValidToken+fetch.
  let account = null;
  try {
    account = await cfg.fetchAccount(normalized.access_token);
  } catch (err) {
    console.warn(`[oauth] ${source} account fetch failed`, err);
  }
  normalized.account = account;
  await writeSource(source, normalized);
  return { account };
}

export async function getValidToken(source) {
  const cfg = SOURCES[source];
  if (!cfg) throw new AuthError(`Unknown source: ${source}`, 'unknown_source');
  const stored = await readSource(source);
  if (!stored?.access_token) {
    throw new AuthError(`Not signed in to ${cfg.displayName}`, 'reauth_required');
  }
  // Proactive refresh — if expires_at is within the headroom window,
  // refresh now rather than letting the next request 401. AL stores
  // expires_at but has no refresh path; if AL is near expiry, we
  // throw 'reauth_required' so the popup can prompt re-auth before
  // the user starts a 15-minute import that would die mid-flight.
  if (stored.expires_at != null && stored.expires_at - Date.now() < PROACTIVE_REFRESH_HEADROOM_MS) {
    if (!cfg.hasRefreshToken) {
      throw new AuthError(`${cfg.displayName} session expired — please re-link your account`, 'reauth_required');
    }
    const refreshed = await refreshAccessToken(source, stored);
    const normalized = normalizeTokens(refreshed, stored);
    await writeSource(source, normalized);
    return normalized.access_token;
  }
  return stored.access_token;
}

export async function signOut(source) {
  const cfg = SOURCES[source];
  if (!cfg) throw new AuthError(`Unknown source: ${source}`, 'unknown_source');
  // Best-effort server-side revoke. Both AL and MAL document revoke
  // endpoints (AL doesn't return useful errors; MAL's is at
  // /v1/oauth2/token/revoke). A failed revoke doesn't block local
  // sign-out — clearing local tokens is the load-bearing action.
  // (Revoke implementation is per-source; deferring until popup
  // integration ships, since the local clear is the user-visible
  // half of the operation.)
  await writeSource(source, null);
}

export async function getAccount(source) {
  const stored = await readSource(source);
  return stored?.account || null;
}

// Exposed for test/diag code; not part of the canonical interface.
// Lets diagnostic surfaces ask "which sources have tokens?" without
// a full readAll().
export async function listLinkedSources() {
  const all = await readAll();
  // A source is "linked" if it has an OAuth token OR was linked by public
  // username (AniList — no token, marked linkedVia:'username').
  return Object.keys(all).filter(s => all[s]?.access_token || all[s]?.linkedVia === 'username');
}

// Returns the set of sources whose client IDs are configured (i.e.,
// not a TODO_ placeholder). Lets the popup render an "under
// construction" state for unconfigured sources without hiding the
// row entirely — users see the feature is planned, the Link button
// is disabled, and there's no setup-error surprise on click.
export function getConfiguredSources() {
  const out = {};
  for (const [id, cfg] of Object.entries(SOURCES)) {
    out[id] = !(typeof cfg.clientId === 'string' && cfg.clientId.startsWith('TODO_'));
  }
  return out;
}

// AuthError typed so consumers can branch on `err.code`. Re-exported
// so handlers in background.js / popup.js can `instanceof AuthError`
// or check `code === 'reauth_required'`.
export { AuthError };
