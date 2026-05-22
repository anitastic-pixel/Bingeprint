// Page-world script. Wraps window.fetch AND XMLHttpRequest BEFORE
// Crunchyroll's bundle loads so we can observe their authenticated API
// calls and capture the Bearer token from the Authorization header. The
// token then lets us call /content/v2/{profileId}/watch-history ourselves
// with full pagination — far better than DOM-scraping the virtualized
// history page.
//
// Why both fetch and XHR: as of the current CR build, the watchlist /
// content/v2 endpoints go through XHR (third-party extensions like the
// JP-subtitle fix sit in the XHR path, which is how we noticed). Earlier
// recon showed watch-history via fetch. Wrap both so we don't depend on
// which transport CR happens to use this week.
//
// Posts captures back to bridge.js (isolated world) via window.postMessage.
// We never log the token or expose it to other scripts.

(() => {
  if (window.__crsmart_fetch_wrapped) return;
  window.__crsmart_fetch_wrapped = true;

  const matchesContentV2 = (url) => {
    const s = String(url);
    return s.includes('/content/v2/'); // both absolute and relative forms
  };

  const extractProfileId = (url) => {
    // /content/v2/{profileId}/... where profileId is a UUID. Some endpoints
    // (e.g., /content/v2/discover/{profileId}/watchlist) nest the UUID
    // deeper, so accept either position.
    const m = String(url).match(/\/content\/v2\/(?:discover\/)?([0-9a-f-]{36})\//i);
    return m ? m[1] : null;
  };

  const emit = (token, profileId) => {
    window.postMessage({
      __crsmart: true,
      kind: 'cr-auth',
      hasToken: !!token,
      token: token || undefined,
      profileId: profileId || undefined,
      ts: Date.now(),
    }, window.location.origin);
  };

  // ── fetch wrap ─────────────────────────────────────────────────────
  const origFetch = window.fetch;

  const extractFetchToken = (init) => {
    if (!init || !init.headers) return null;
    const h = init.headers;
    if (h instanceof Headers) {
      const v = h.get('authorization') || h.get('Authorization');
      return v && v.startsWith('Bearer ') ? v.slice(7) : null;
    }
    if (Array.isArray(h)) {
      for (const [k, v] of h) {
        if (k.toLowerCase() === 'authorization' && typeof v === 'string' && v.startsWith('Bearer ')) {
          return v.slice(7);
        }
      }
      return null;
    }
    if (typeof h === 'object') {
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === 'authorization' && typeof h[k] === 'string' && h[k].startsWith('Bearer ')) {
          return h[k].slice(7);
        }
      }
    }
    return null;
  };

  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (matchesContentV2(url)) {
        const token = extractFetchToken(init) || (input instanceof Request ? extractFetchToken({ headers: input.headers }) : null);
        const profileId = extractProfileId(url);
        if (token || profileId) emit(token, profileId);
      }
    } catch (_) { /* never break the page */ }
    return origFetch.apply(this, arguments);
  };

  // ── XHR wrap ───────────────────────────────────────────────────────
  // We stash the URL on the instance in open(), then sniff Authorization
  // in setRequestHeader(). This is robust to other extensions that have
  // also wrapped XHR — wraps chain in installation order; whichever
  // wrapper installed last sees the call first, then delegates inward.
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSetRequestHeader = XHR.setRequestHeader;

  XHR.open = function (method, url) {
    try { this.__crsmart_url = url; } catch (_) {}
    return origOpen.apply(this, arguments);
  };

  XHR.setRequestHeader = function (name, value) {
    try {
      if (name && String(name).toLowerCase() === 'authorization'
          && typeof value === 'string' && value.startsWith('Bearer ')
          && this.__crsmart_url && matchesContentV2(this.__crsmart_url)) {
        emit(value.slice(7), extractProfileId(this.__crsmart_url));
      }
    } catch (_) { /* never break the page */ }
    return origSetRequestHeader.apply(this, arguments);
  };

  // Single install log — confirms the IIFE ran end to end and gives us a
  // structural snapshot of the XHR slots so we can detect a third-party
  // extension that replaced the constructor outright (in which case our
  // prototype wrap is a no-op because CR's `new XMLHttpRequest()` builds
  // a different class).
  console.log('[crsmart] inject: wrap installed', {
    xhrIsNative: /\[native code\]/.test(window.XMLHttpRequest.toString()),
    fetchIsNative: /\[native code\]/.test(window.fetch.toString()),
  });
})();
