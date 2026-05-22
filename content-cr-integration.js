// content-cr-integration.js
// ───────────────────────────────────────────────────────────────────
// Crunchyroll DOM glue: hero-background gradient + CR-overlay CSS
// patching + CR meta refresh + extension-context-invalidation
// banner + MutationObserver-based reinjection + async boot.
// (Final of three split content scripts; siblings: content-card.js,
// content-feedback.js.)
//
// MVP CONTEXT (2026-05-12): split out of content.js — NO REWRITE.
// Two extracted blocks from the original content.js are concatenated
// here verbatim:
//   • lines 4908-5167 of content.js — _heroImgTransform through
//     _onExtensionContextDead.
//   • lines 5680-6101 of content.js — equalShallow/equalShallowArray,
//     schedule, cardStaleness, loadInitial, watchStorage,
//     watchSyncBroadcast, and the async init IIFE that wires up
//     MutationObservers and kicks off the first inject.
//
// The async init IIFE at the bottom is the ONLY top-level code that
// runs across the three split files (apart from the audit IIFE in
// content-feedback.js). By the time it runs, all data + function
// declarations from content-card.js, content-feedback.js, and the
// blocks above in this file are loaded — cross-file calls into
// loadInitial / watchStorage / cardModule / pageTitle all resolve.
// ───────────────────────────────────────────────────────────────────

// Single source of truth for the hero-bg img transform string. Combines
// the scale slider with the vertical-offset slider so both update
// consistently when either changes.
function _heroImgTransform() {
  const scale   = (STATE.heroBgScale || 140) / 100;
  const offsetY = STATE.heroBgOffsetY || 0;
  return `scale(${scale}) translateY(${offsetY}vh)`;
}

// Viewport-fixed black gradient overlay. Lives inside
// [data-t="series-hero-background"] (z-index:-1) so it paints above
// the bg image but below in-flow page content automatically.
//
// Scroll-driven: as the user scrolls past the hero section, the
// gradient expands from a bottom-fade to a full-screen black cover
// so the key-art is hidden by the time the episode list is in view.
//
// Edge softness: filter:blur() on the gradient div itself blurs the
// gradient's OWN paint, feathering the transparent→black transition
// outward so the top edge of the black reads as diffuse rather than a
// hard line. Blur stays constant at heroBgBlur px across all scroll
// positions — earlier versions faded it to 0 mid-scroll and the
// resulting hard edge was jarring.
const HERO_GRADIENT_ID = 'crsmart-hero-gradient';
let _heroGradientHeroBottom = null; // page-coord bottom of hero section

function _heroGradientCss(fraction) {
  // fraction: 0 = top of page, 1 = hero fully scrolled past.
  // Stops are spaced more gradually than the earlier ramp (30/65/100)
  // so the darkening reads as a soft wash rather than an abrupt middle.
  const dark      = Math.min(1, Math.max(0, (STATE.heroBgDark ?? 100) / 100));
  const mid       = Math.min(1, Math.max(0, (STATE.heroBgMid  ?? 100) / 100));
  const topAlpha  = (fraction * 0.9 * dark).toFixed(2);
  const mid1Alpha = ((0.75 * mid + 0.20 * fraction) * dark).toFixed(2);
  const mid2Alpha = ((0.95 * mid + 0.05 * fraction) * dark).toFixed(2);
  const baseH     = STATE.heroBgSize || 80;
  const h         = baseH + 40 * fraction;
  const blurPx    = STATE.heroBgBlur || 0;
  const blurStyle = blurPx > 0
    ? `filter:blur(${blurPx}px);-webkit-filter:blur(${blurPx}px);`
    : '';
  return `position:fixed;left:0;right:0;bottom:0;height:${h}vh;pointer-events:none;background:linear-gradient(to bottom,rgba(0,0,0,${topAlpha}) 0%,rgba(0,0,0,${mid1Alpha}) 35%,rgba(0,0,0,${mid2Alpha}) 70%,rgba(0,0,0,1) 100%);${blurStyle}`;
}

function _updateHeroGradientOnScroll() {
  const gradEl = document.getElementById(HERO_GRADIENT_ID);
  if (!gradEl) return;
  if (!_heroGradientHeroBottom) {
    const wrapper = document.querySelector('[class*="series-hero-wrapper"]');
    _heroGradientHeroBottom = wrapper
      ? wrapper.getBoundingClientRect().bottom + window.scrollY
      : window.innerHeight * 1.5;
  }
  const start = _heroGradientHeroBottom * 0.2;
  const range = _heroGradientHeroBottom * 0.45;
  const fraction = Math.min(1, Math.max(0, (window.scrollY - start) / range));
  gradEl.style.cssText = _heroGradientCss(fraction);
}

function installHeroGradient() {
  if (document.getElementById(HERO_GRADIENT_ID)) return;
  const bg = document.querySelector('[data-t="series-hero-background"]');
  if (!bg) return;
  const gradEl = document.createElement('div');
  gradEl.id = HERO_GRADIENT_ID;
  gradEl.style.cssText = _heroGradientCss(0);
  bg.appendChild(gradEl);
  _installCrOverlayCss();
  window.addEventListener('scroll', _updateHeroGradientOnScroll, { passive: true });
}
function removeHeroGradient() {
  document.getElementById(HERO_GRADIENT_ID)?.remove();
  _removeCrOverlayCss();
  window.removeEventListener('scroll', _updateHeroGradientOnScroll);
  _heroGradientHeroBottom = null;
}

// Overrides CR's own ::after pseudo-element on the hero-background.
// Can't touch pseudo-elements via inline style, so we inject a <style>
// block and rewrite it whenever the user moves either slider.
const CR_OVERLAY_STYLE_ID = 'crsmart-cr-overlay-css';
function _installCrOverlayCss() {
  let el = document.getElementById(CR_OVERLAY_STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = CR_OVERLAY_STYLE_ID;
    document.head.appendChild(el);
  }
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const overlay = clamp01((STATE.heroCrOverlay    ?? 100) / 100);
  const diag    = clamp01((STATE.heroCrDiagonal   ?? 100) / 100);
  const wash    = clamp01((STATE.heroCrLeftWash   ?? 100) / 100);
  const bDark   = clamp01((STATE.heroCrBottomDark ?? 100) / 100);
  const fade    = Math.min(100, Math.max(0, STATE.heroCrBottomFade ?? 45));
  const bEnd    = Math.min(100, Math.max(0, STATE.heroCrBottomEnd  ?? 82));
  // Per-layer opacity is baked into each layer's alpha stops so a zeroed
  // layer disappears entirely (instead of merely fading relative to the
  // others). The global `opacity` on ::after then scales everything as
  // a convenience master knob.
  const diagA = (0.55 * diag).toFixed(3);
  const washA0 = (0.85 * wash).toFixed(3);
  const washA1 = (0.50 * wash).toFixed(3);
  const bottomA = bDark.toFixed(3);
  el.textContent = `
[data-t="series-hero-background"]::after {
  background-image:
    linear-gradient(252deg, rgba(0,0,0,${diagA}) 5%, rgba(0,0,0,0) 20%),
    linear-gradient(to right, rgba(0,0,0,${washA0}) 0%, rgba(0,0,0,${washA1}) 15%, rgba(0,0,0,0) 35%),
    linear-gradient(rgba(0,0,0,0) ${fade}%, rgba(0,0,0,${bottomA}) ${bEnd}%) !important;
  opacity: ${overlay.toFixed(2)} !important;
}`;
}
function _removeCrOverlayCss() {
  document.getElementById(CR_OVERLAY_STYLE_ID)?.remove();
}

const _crMetaRequested = new Set();
function _requestCrMetaRefresh({ force = false } = {}) {
  const id = currentCrSeriesId();
  if (!id) return;
  if (!force && _crMetaRequested.has(id)) return;
  _crMetaRequested.add(id);
  // Slug sits between the series id and the query string in the URL —
  // passing it lets the worker fall back when the cached title is
  // stale ('Jujutsu Kaisen' vs a season subtitle CR now displays).
  const slug = (() => {
    const m = location.pathname.match(/\/series\/[A-Z0-9]+\/([^/?#]+)/i);
    return m ? m[1] : null;
  })();
  try {
    chrome.runtime.sendMessage({
      type: 'refreshCrMetaForSeries',
      seriesId: id,
      title: pageTitle(),
      slug,
    });
  } catch (_) { /* extension reloaded; worker will come back on next page */ }
}

// Cold-start retry loop: while the loading stub is mounted, re-fire
// the refresh request periodically so a transient enrichOne failure
// (no-match, error, AniList rate-limit) doesn't leave the user stuck
// staring at a spinner. Each retry forces a fresh round-trip — the
// worker's dedup is end-of-chain and only sticks on verified outcomes,
// so re-firing genuinely retries enrichment. Cleared by cardModule._mount
// when the real card lands.
const _coldStartRetryState = { seriesId: null, attempt: 0, timer: null };
function _scheduleColdStartRetry(seriesId) {
  // Once the extension context is dead, every chrome.* call will throw.
  // Don't schedule new timers into that void — the user already has the
  // refresh CTA in the stub.
  if (_extensionContextDead) return;
  if (_coldStartRetryState.seriesId !== seriesId) {
    if (_coldStartRetryState.timer) clearTimeout(_coldStartRetryState.timer);
    _coldStartRetryState.seriesId = seriesId;
    _coldStartRetryState.attempt = 0;
  }
  if (_coldStartRetryState.timer) return; // already armed
  // Six attempts spread across ~5 minutes. Early ones (10s, 20s) catch
  // the common case of "data landed in storage but our broadcast/event
  // got dropped." Later ones (60s, 90s, 120s) ride out AniList
  // rate-limit cooldowns on heavily-throttled niche shows.
  const delays = [10000, 20000, 35000, 60000, 90000, 120000];
  const delay = delays[Math.min(_coldStartRetryState.attempt, delays.length - 1)];
  _coldStartRetryState.timer = setTimeout(async () => {
    _coldStartRetryState.timer = null;
    _coldStartRetryState.attempt++;
    // If user navigated away or the real card already mounted (no
    // loading stub on the page), abort the retry chain.
    const stub = document.getElementById(CARD_ID);
    if (!stub || stub.dataset.crsmartLoadingFor !== seriesId) {
      _coldStartRetryState.seriesId = null;
      _coldStartRetryState.attempt = 0;
      return;
    }
    if (_coldStartRetryState.attempt > delays.length) {
      console.log(`[crsmart] cold-start retry: gave up after ${delays.length} attempts for ${seriesId}`);
      return;
    }
    console.log(`[crsmart] cold-start retry #${_coldStartRetryState.attempt} for ${seriesId}`);
    // STEP A: re-read storage directly. The chain may have already
    // produced a hit but the broadcast / storage event missed our tab
    // (broadcast fanout to 15+ CR tabs sees most as "Receiving end
    // does not exist"; storage.onChanged misses too if the listener
    // wasn't registered when the change fired). A direct refresh +
    // re-run of tryInject closes that gap independent of the worker.
    try {
      const stored = await chrome.storage.local.get([
        ALL_SHOWS_SCORED_KEY, RECS_KEY, CR_SERIES_META_KEY,
      ]);
      STATE.allShowsScored = stored[ALL_SHOWS_SCORED_KEY] || null;
      STATE.recs = stored[RECS_KEY] || null;
      STATE.crSeriesMeta = stored[CR_SERIES_META_KEY] || {};
    } catch (err) {
      if (_isExtensionContextDead(err)) {
        console.log('[crsmart] cold-start retry: extension context invalidated — aborting retry chain');
        _onExtensionContextDead();
        return;
      }
      console.warn('[crsmart] cold-start retry: storage refresh failed', err);
    }
    cardModule.currentRec = null; // force re-mount path on next tryInject
    tryInject();
    // STEP B: if tryInject mounted the real card, the stub is gone and
    // we won't re-arm. Otherwise prod the worker for another enrichment
    // pass and arm the next retry.
    const stillStub = document.getElementById(CARD_ID)?.dataset?.crsmartLoadingFor === seriesId;
    if (!stillStub) {
      _coldStartRetryState.seriesId = null;
      _coldStartRetryState.attempt = 0;
      return;
    }
    // After attempt 2 (~30s in), surface a manual escape hatch: the
    // user shouldn't have to know that AniList rate limits cause this
    // to take ~5 minutes worst-case. A "Refresh page" link gets them
    // unstuck immediately without waiting for the retry chain.
    if (_coldStartRetryState.attempt >= 2) {
      const stubEl = document.getElementById(CARD_ID);
      if (stubEl && !stubEl.querySelector('.crsmart-loading-refresh-cta')) {
        const subtext = stubEl.querySelector('div > div > div:nth-child(2)');
        if (subtext) {
          subtext.innerHTML += ` <a href="javascript:location.reload()" class="crsmart-loading-refresh-cta" style="color:#ff8c28;text-decoration:none;font-weight:600;margin-left:6px;">Refresh page →</a>`;
        }
      }
    }
    _crMetaRequested.delete(seriesId);
    _requestCrMetaRefresh({ force: true });
    _scheduleColdStartRetry(seriesId);
  }, delay);
}
function _clearColdStartRetry() {
  if (_coldStartRetryState.timer) clearTimeout(_coldStartRetryState.timer);
  _coldStartRetryState.timer = null;
  _coldStartRetryState.seriesId = null;
  _coldStartRetryState.attempt = 0;
}

// "Extension context invalidated" fires on every chrome.* call after
// the extension reloads/updates while content.js is still alive on the
// page. The retry chain mustn't re-arm into that state — it just spams
// the same error every interval. Detect, bail, and swap the loading
// stub for a "reload to recover" message so the user has a clear out.
let _extensionContextDead = false;
function _isExtensionContextDead(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return msg.includes('Extension context invalidated')
      || msg.includes('Extension context was invalidated');
}
function _onExtensionContextDead() {
  _extensionContextDead = true;
  _clearColdStartRetry();
  const stubEl = document.getElementById(CARD_ID);
  if (stubEl && !stubEl.querySelector('.crsmart-context-dead-cta')) {
    const subtext = stubEl.querySelector('div > div > div:nth-child(2)');
    if (subtext) {
      subtext.innerHTML = `Extension was updated — <a href="javascript:location.reload()" class="crsmart-context-dead-cta" style="color:#ff8c28;text-decoration:none;font-weight:600;">refresh page →</a>`;
    }
  }
}

// ── [tryInject + stub builders + cardModule live in content-card.js] ──

// Shallow-equal helpers for patch-vs-rebuild dispatch in cardModule.
// Good-enough for the rec object's flat fields and small arrays
// (topTags up to 20 entries, genres up to ~5). Doesn't deep-walk
// nested objects — pass references so JSON-serialized changes show
// as new identities.
function equalShallow(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}
function equalShallowArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Boot + observers ────────────────────────────────────────────────
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    tryInject();
  });
}

// Card-staleness coalescing. Replaces the previous pattern where each
// of 9 storage-listener branches called `removeCard() + schedule()`
// independently — during a single recompute the worker writes ~11
// keys, 7+ of which would individually fire a card rebuild (or seven).
//
// Now: each listener branch updates STATE synchronously, then calls
// `cardStaleness.notify(key)`. The set of dirty keys aggregates across
// all changes in the current task; a single RAF tick later, _flush
// runs `schedule()` once. Multiple writes → one rebuild.
//
// Why a Set instead of a bare boolean: future zone-aware patching
// (C3 of the card module) wants to know WHICH keys changed so it
// can patch only the affected zones. The Set carries that info to
// the flush.
const cardStaleness = {
  dirtyKeys: new Set(),
  flushScheduled: false,

  // Storage keys whose changes mean the card might need to update.
  // Other keys (RATINGS_KEY etc.) flow through the listener for
  // STATE updates but don't trigger a card refresh.
  // '__settingsShape' is a synthetic key emitted when a popup toggle
  // changes the card's structural shape (genre row / cover bleed /
  // show spoilers) but no underlying data key changed.
  CARD_REFRESH_KEYS: new Set([
    RECS_KEY, ALL_SHOWS_SCORED_KEY, STUDIO_INDEX_KEY,
    ARCHETYPE_BLEND_KEY, CR_SERIES_META_KEY, CR_SEASONS_CACHE_KEY,
    CR_WATCHLIST_KEY, '__settingsShape',
  ]),

  notify(key) {
    this.dirtyKeys.add(key);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => this._flush());
  },

  _flush() {
    const keys = this.dirtyKeys;
    this.dirtyKeys = new Set();
    this.flushScheduled = false;
    let anyCardKey = false;
    for (const k of keys) {
      if (this.CARD_REFRESH_KEYS.has(k)) { anyCardKey = true; break; }
    }
    if (anyCardKey) tryInject();
  },
};

async function loadInitial() {
  try {
    const data = await chrome.storage.local.get(
      [SETTINGS_KEY, RECS_KEY, STUDIO_INDEX_KEY, TAG_BURNOUT_INDEX_KEY, RATINGS_KEY, REACTIONS_KEY, REACTION_STATS_KEY, CR_SERIES_META_KEY, CR_SEASONS_CACHE_KEY, ALL_SHOWS_SCORED_KEY, ARCHETYPE_BLEND_KEY, CR_WATCHLIST_KEY]);
    const settings = data[SETTINGS_KEY] || {};
    STATE.enabled = settings.showPagePanel !== false;
    STATE.coverBleed = settings.coverBleed === true;
    STATE.cardMaxWidth = typeof settings.cardMaxWidth === 'number'
      ? settings.cardMaxWidth : DEFAULT_CARD_MAX_WIDTH;
    STATE.dealbreakerTags = Array.isArray(settings.dealbreakerTags)
      ? settings.dealbreakerTags : [];
    STATE.heroBgLock = settings.heroBgLock !== false;
    STATE.heroBgBlur = typeof settings.heroBgBlur === 'number'
      ? settings.heroBgBlur : 16;
    STATE.heroBgSize = typeof settings.heroBgSize === 'number'
      ? settings.heroBgSize : 80;
    STATE.heroBgDark = typeof settings.heroBgDark === 'number'
      ? settings.heroBgDark : 100;
    STATE.heroBgMid = typeof settings.heroBgMid === 'number'
      ? settings.heroBgMid : 100;
    STATE.heroBgScale = typeof settings.heroBgScale === 'number'
      ? settings.heroBgScale : 140;
    STATE.heroBgOffsetY = typeof settings.heroBgOffsetY === 'number'
      ? settings.heroBgOffsetY : 0;
    STATE.heroCrOverlay = typeof settings.heroCrOverlay === 'number'
      ? settings.heroCrOverlay : 100;
    STATE.heroCrBottomFade = typeof settings.heroCrBottomFade === 'number'
      ? settings.heroCrBottomFade : 45;
    STATE.heroCrBottomEnd = typeof settings.heroCrBottomEnd === 'number'
      ? settings.heroCrBottomEnd : 82;
    STATE.heroCrBottomDark = typeof settings.heroCrBottomDark === 'number'
      ? settings.heroCrBottomDark : 100;
    STATE.heroCrDiagonal = typeof settings.heroCrDiagonal === 'number'
      ? settings.heroCrDiagonal : 100;
    STATE.heroCrLeftWash = typeof settings.heroCrLeftWash === 'number'
      ? settings.heroCrLeftWash : 100;
    STATE.genreRow = settings.genreRow !== false;
    STATE.showSpoilers = settings.showSpoilers === true;
    STATE.recs = data[RECS_KEY] || null;
    STATE.allShowsScored = data[ALL_SHOWS_SCORED_KEY] || null;
    STATE.archetypeBlend = data[ARCHETYPE_BLEND_KEY]?.archetypes || null;
    STATE.studioCreator = data[STUDIO_INDEX_KEY] || null;
    STATE.tagBurnoutIndex = data[TAG_BURNOUT_INDEX_KEY] || {};
    STATE.crSeriesMeta = data[CR_SERIES_META_KEY] || {};
    STATE.crSeasonsCache = data[CR_SEASONS_CACHE_KEY] || {};
    STATE.crWatchlist = data[CR_WATCHLIST_KEY] || null;
    STATE.ratings = data[RATINGS_KEY] || {};
    STATE.reactions = data[REACTIONS_KEY] || {};
    STATE.reactionStats = data[REACTION_STATS_KEY] || {};
  } catch (_) {
    STATE.enabled = true;
  }
}

function watchStorage() {
  if (!chrome?.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SETTINGS_KEY]) {
      const next = changes[SETTINGS_KEY].newValue || {};
      const wasEnabled = STATE.enabled;
      const prevCoverBleed = STATE.coverBleed;
      const prevWidth = STATE.cardMaxWidth;
      const prevBgLock = STATE.heroBgLock;
      const prevBgBlur = STATE.heroBgBlur;
      const prevBgSize = STATE.heroBgSize;
      const prevBgDark = STATE.heroBgDark;
      const prevBgMid = STATE.heroBgMid;
      const prevBgScale = STATE.heroBgScale;
      const prevBgOffsetY = STATE.heroBgOffsetY;
      const prevCrOverlay = STATE.heroCrOverlay;
      const prevCrBottomFade = STATE.heroCrBottomFade;
      const prevCrBottomEnd = STATE.heroCrBottomEnd;
      const prevCrBottomDark = STATE.heroCrBottomDark;
      const prevCrDiagonal = STATE.heroCrDiagonal;
      const prevCrLeftWash = STATE.heroCrLeftWash;
      STATE.enabled = next.showPagePanel !== false;
      STATE.coverBleed = next.coverBleed === true;
      STATE.dealbreakerTags = Array.isArray(next.dealbreakerTags)
        ? next.dealbreakerTags : [];
      STATE.cardMaxWidth = typeof next.cardMaxWidth === 'number'
        ? next.cardMaxWidth : DEFAULT_CARD_MAX_WIDTH;
      STATE.heroBgLock = next.heroBgLock !== false;
      STATE.heroBgBlur = typeof next.heroBgBlur === 'number'
        ? next.heroBgBlur : 16;
      STATE.heroBgSize = typeof next.heroBgSize === 'number'
        ? next.heroBgSize : 80;
      STATE.heroBgDark = typeof next.heroBgDark === 'number'
        ? next.heroBgDark : 100;
      STATE.heroBgMid = typeof next.heroBgMid === 'number'
        ? next.heroBgMid : 100;
      STATE.heroBgScale = typeof next.heroBgScale === 'number'
        ? next.heroBgScale : 140;
      STATE.heroBgOffsetY = typeof next.heroBgOffsetY === 'number'
        ? next.heroBgOffsetY : 0;
      STATE.heroCrOverlay = typeof next.heroCrOverlay === 'number'
        ? next.heroCrOverlay : 100;
      STATE.heroCrBottomFade = typeof next.heroCrBottomFade === 'number'
        ? next.heroCrBottomFade : 45;
      STATE.heroCrBottomEnd = typeof next.heroCrBottomEnd === 'number'
        ? next.heroCrBottomEnd : 82;
      STATE.heroCrBottomDark = typeof next.heroCrBottomDark === 'number'
        ? next.heroCrBottomDark : 100;
      STATE.heroCrDiagonal = typeof next.heroCrDiagonal === 'number'
        ? next.heroCrDiagonal : 100;
      STATE.heroCrLeftWash = typeof next.heroCrLeftWash === 'number'
        ? next.heroCrLeftWash : 100;
      const prevGenreRow = STATE.genreRow;
      STATE.genreRow = next.genreRow !== false;
      const prevShowSpoilers = STATE.showSpoilers;
      STATE.showSpoilers = next.showSpoilers === true;
      // Disable / re-enable special-cases: explicit removeCard / schedule
      // (these aren't coalescable through cardStaleness because they
      // change the existence-shape of the card itself).
      if (wasEnabled && !STATE.enabled) removeCard();
      else if (!wasEnabled && STATE.enabled) schedule();
      // Settings-driven shape changes that just need a card repaint.
      // Routed through cardStaleness so multiple slider drags within
      // the same RAF tick coalesce.
      else if (prevCoverBleed !== STATE.coverBleed
            || prevGenreRow !== STATE.genreRow
            || prevShowSpoilers !== STATE.showSpoilers) {
        // currentRec must be cleared so cardModule.update detects a
        // shape change and full-mounts. Otherwise the patch path
        // would skip rebuilding the chip rows.
        cardModule.currentRec = null;
        cardStaleness.notify('__settingsShape');
      }
      // Width slider fires continuously — update the existing card's
      // max-width in place so the card visibly stretches as the user
      // drags. Don't tear down + rebuild; that would re-run the ring
      // animation guard logic and flicker.
      if (prevWidth !== STATE.cardMaxWidth) {
        const card = document.getElementById(CARD_ID);
        if (card) card.style.maxWidth = `${STATE.cardMaxWidth}px`;
      }
      // heroBgLock toggle: install or teardown gradient + bg lock live.
      if (prevBgLock !== STATE.heroBgLock) {
        if (STATE.heroBgLock) {
          lockHeroBackgroundHeight();
          installHeroGradient();
        } else {
          removeHeroGradient();
          // Restore bg element to its natural styling so the page
          // reverts to CR's original hero layout on toggle-off.
          const bg = document.querySelector('[data-t="series-hero-background"]');
          if (bg) {
            bg.style.cssText = '';
            delete bg.dataset.crsmartHeroLocked;
            bg.querySelectorAll('img').forEach(img => { img.style.cssText = ''; });
          }
        }
      }
      // heroBgBlur / heroBgSize / heroBgDark change: re-run the scroll
      // handler so the new value takes effect immediately.
      if (STATE.heroBgLock &&
          (prevBgBlur !== STATE.heroBgBlur || prevBgSize !== STATE.heroBgSize ||
           prevBgDark !== STATE.heroBgDark || prevBgMid !== STATE.heroBgMid)) {
        _updateHeroGradientOnScroll();
      }
      // heroBgScale / heroBgOffsetY change: update every img's transform
      // in place. CR has two img layers (blurred backdrop + sharp
      // foreground) — both must be transformed so the visible image
      // actually resizes / shifts.
      if (STATE.heroBgLock &&
          (prevBgScale !== STATE.heroBgScale ||
           prevBgOffsetY !== STATE.heroBgOffsetY)) {
        const bg = document.querySelector('[data-t="series-hero-background"]');
        const imgs = bg ? bg.querySelectorAll('img') : [];
        const t = _heroImgTransform();
        imgs.forEach(img => img.style.setProperty('transform', t, 'important'));
      }
      // CR native-overlay sliders: rewrite the injected <style> block
      // so the ::after gradient updates without a page reload.
      if (STATE.heroBgLock &&
          (prevCrOverlay !== STATE.heroCrOverlay ||
           prevCrBottomFade !== STATE.heroCrBottomFade ||
           prevCrBottomEnd !== STATE.heroCrBottomEnd ||
           prevCrBottomDark !== STATE.heroCrBottomDark ||
           prevCrDiagonal !== STATE.heroCrDiagonal ||
           prevCrLeftWash !== STATE.heroCrLeftWash)) {
        _installCrOverlayCss();
      }
    }
    // Card-data updates: STATE updates synchronously, then notify the
    // staleness coalescer. Multiple keys landing in the same task all
    // collapse into one RAF flush + one tryInject call. Previously
    // each branch fired its own removeCard + schedule, so a recompute
    // writing 7 keys caused 7 sequential rebuilds.
    if (changes[RECS_KEY]) {
      STATE.recs = changes[RECS_KEY].newValue || null;
      cardStaleness.notify(RECS_KEY);
    }
    if (changes[ALL_SHOWS_SCORED_KEY]) {
      STATE.allShowsScored = changes[ALL_SHOWS_SCORED_KEY].newValue || null;
      // Rating recompute landed — clear the pending UX state. Pulse
      // animation stops + rate buttons re-enable as soon as the card
      // patches to the new score.
      if (STATE.ratingPending != null) {
        STATE.ratingPending = null;
        if (STATE._ratingPendingTimer) {
          clearTimeout(STATE._ratingPendingTimer);
          STATE._ratingPendingTimer = null;
        }
        const cardEl = document.getElementById(CARD_ID);
        if (cardEl) delete cardEl.dataset.crsmartRatingPending;
      }
      cardStaleness.notify(ALL_SHOWS_SCORED_KEY);
    }
    if (changes[STUDIO_INDEX_KEY]) {
      STATE.studioCreator = changes[STUDIO_INDEX_KEY].newValue || null;
      cardStaleness.notify(STUDIO_INDEX_KEY);
    }
    if (changes[TAG_BURNOUT_INDEX_KEY]) {
      STATE.tagBurnoutIndex = changes[TAG_BURNOUT_INDEX_KEY].newValue || {};
      cardStaleness.notify(TAG_BURNOUT_INDEX_KEY);
    }
    if (changes[ARCHETYPE_BLEND_KEY]) {
      STATE.archetypeBlend = changes[ARCHETYPE_BLEND_KEY].newValue?.archetypes || null;
      cardStaleness.notify(ARCHETYPE_BLEND_KEY);
    }
    if (changes[CR_SERIES_META_KEY]) {
      STATE.crSeriesMeta = changes[CR_SERIES_META_KEY].newValue || {};
      cardStaleness.notify(CR_SERIES_META_KEY);
    }
    if (changes[CR_SEASONS_CACHE_KEY]) {
      STATE.crSeasonsCache = changes[CR_SEASONS_CACHE_KEY].newValue || {};
      cardStaleness.notify(CR_SEASONS_CACHE_KEY);
    }
    if (changes[CR_WATCHLIST_KEY]) {
      STATE.crWatchlist = changes[CR_WATCHLIST_KEY].newValue || null;
      cardStaleness.notify(CR_WATCHLIST_KEY);
    }
    if (changes[RATINGS_KEY]) {
      STATE.ratings = changes[RATINGS_KEY].newValue || {};
      // Don't re-render the whole card on a rating change — the click
      // handler already swapped the strip in place. Storage echo would
      // just cause a flash.
    }
    if (changes[REACTIONS_KEY]) {
      STATE.reactions = changes[REACTIONS_KEY].newValue || {};
      // Like ratings: the click handler re-paints the palette strip in
      // place, so we skip a full card rebuild. The rerank will arrive
      // shortly via RECS_KEY change and repaint on its own.
    }
    if (changes[REACTION_STATS_KEY]) {
      STATE.reactionStats = changes[REACTION_STATS_KEY].newValue || {};
    }
  });
}

// Broadcast hook from the worker: after computeAllShowsScored writes,
// the worker fires this message at every CR tab so the content script
// can force a fresh render. Belt-and-suspenders to chrome.storage.
// onChanged — during a manual history refresh the sync writes ~10 keys
// in sequence and intermediate states can leave the card missing if
// the user's series wasn't yet in the partially-written allShowsScored.
// On this message we force a STATE reload + re-render regardless of
// what storage.onChanged did or didn't do.
function watchSyncBroadcast() {
  if (!chrome?.runtime?.onMessage) return;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'crsmart:scored-updated') return;
    console.log('[crsmart] received scored-updated broadcast — forcing card refresh');
    (async () => {
      try {
        const data = await chrome.storage.local.get(
          [ALL_SHOWS_SCORED_KEY, RECS_KEY, ARCHETYPE_BLEND_KEY, STUDIO_INDEX_KEY, TAG_BURNOUT_INDEX_KEY,
           CR_SERIES_META_KEY, CR_SEASONS_CACHE_KEY, CR_WATCHLIST_KEY]);
        STATE.allShowsScored = data[ALL_SHOWS_SCORED_KEY] || null;
        STATE.recs = data[RECS_KEY] || null;
        STATE.archetypeBlend = data[ARCHETYPE_BLEND_KEY]?.archetypes || null;
        STATE.studioCreator = data[STUDIO_INDEX_KEY] || null;
        STATE.tagBurnoutIndex = data[TAG_BURNOUT_INDEX_KEY] || {};
        STATE.crSeriesMeta = data[CR_SERIES_META_KEY] || {};
        STATE.crSeasonsCache = data[CR_SEASONS_CACHE_KEY] || {};
        STATE.crWatchlist = data[CR_WATCHLIST_KEY] || null;
        // Route through cardStaleness — the broadcast and concurrent
        // storage.onChanged events collapse to one tryInject. RAF
        // throttling in backgrounded tabs is OK: the flush fires
        // when the tab returns, and the user sees the fresh card on
        // re-entry rather than a stale one mid-render.
        cardModule.currentRec = null;  // force full re-mount
        cardStaleness.notify(ALL_SHOWS_SCORED_KEY);
      } catch (err) {
        console.warn('[crsmart] broadcast handler error', err);
      }
    })();
  });
}

(async () => {
  await loadInitial();
  watchStorage();
  watchSyncBroadcast();
  schedule();

  // Reactive re-injection — replaces the previous "observe whole body
  // subtree, fire schedule on every mutation" pattern. That fired
  // schedule() many times per second on busy CR pages (episode list,
  // related recs, season picker, etc., all firing childList events
  // we didn't care about).
  //
  // Two narrow observers:
  //   1. document.body childList only — catches CR remounting the
  //      hero-body element itself (SPA navigation between series).
  //      Cheap; childList without subtree fires only on direct-child
  //      changes.
  //   2. hero-body childList — catches CR re-rendering its inner
  //      content, which can incidentally remove our injected card.
  //      Re-installed every time we find a new hero body (it's
  //      replaced wholesale on series navigation).
  //
  // Either firing → schedule() → tryInject → cardModule.update,
  // which patches/mounts as needed. With C1/C2 in place this is
  // idempotent: no card change = no DOM ops.
  const bodyObserver = new MutationObserver(schedule);
  bodyObserver.observe(document.body, { childList: true });

  let heroObserver = null;
  let heroObserverTarget = null;
  function ensureHeroObserver() {
    const heroBody = document.querySelector(HERO_BODY);
    if (heroBody === heroObserverTarget) return;
    if (heroObserver) heroObserver.disconnect();
    heroObserverTarget = heroBody;
    if (heroBody) {
      heroObserver = new MutationObserver(schedule);
      heroObserver.observe(heroBody, { childList: true });
    }
  }
  // Re-check the hero body on every flush so SPA navigation
  // (which replaces the hero element wholesale) re-binds our
  // observer to the fresh element.
  const _origFlush = cardStaleness._flush.bind(cardStaleness);
  cardStaleness._flush = function() {
    ensureHeroObserver();
    _origFlush();
  };
  ensureHeroObserver();

  // History API hooks — belt-and-suspenders for SPA navigation. The
  // body+hero MutationObservers above cover the case where CR replaces
  // hero DOM on route change, but we've seen the card silently fail to
  // re-inject after pushState navigations where CR happens to mutate
  // only deep descendants of the hero (no childList event on body or
  // the previous hero element). Patching history.pushState /
  // replaceState + listening for popstate guarantees a reinject on any
  // route change regardless of CR's render strategy. Idempotent —
  // schedule() coalesces with concurrent observer fires through
  // cardStaleness's RAF batcher, so we never double-render.
  let _lastHref = location.href;
  function _onUrlMaybeChanged() {
    if (location.href === _lastHref) return;
    _lastHref = location.href;
    // Force a full re-mount on route change. CR replaces the hero
    // wholesale; the previously rendered card belongs to the old show
    // and must be torn down rather than patched in place.
    cardModule.currentRec = null;
    schedule();
  }
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    if (typeof orig !== 'function' || orig.__crsmartPatched) continue;
    const patched = function(...args) {
      const ret = orig.apply(this, args);
      // Defer to next microtask so the URL is settled before we read it.
      Promise.resolve().then(_onUrlMaybeChanged);
      return ret;
    };
    patched.__crsmartPatched = true;
    history[fn] = patched;
  }
  window.addEventListener('popstate', _onUrlMaybeChanged);
  window.addEventListener('hashchange', _onUrlMaybeChanged);
})();
