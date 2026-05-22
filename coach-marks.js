// One-time coach marks — gentle in-place tooltips that fire on the
// first encounter with a surface (Picks tab, Shape tab, Smart Score
// card) and never again. Per the alpha-polish plan (Q6) the surface
// only gets a coach mark if it isn't self-explaining; reactions/
// vibes/dealbreakers are deliberately quiet.
//
// Storage shape:
//   chrome.storage.local.coachMarksSeen = { [key]: true, ... }
//
// Used from sidepanel.js (picks, shape) and content.js (smart-score-card).
// Lives at module scope so each surface's bundle imports the same
// state-resolution path; the worker doesn't participate.

const STORAGE_KEY = 'coachMarksSeen';
const STYLE_ID = 'crsmart-coach-mark-styles';

let _seenCache = null;
let _stylesInjected = false;

function injectStylesOnce() {
  if (_stylesInjected) return;
  if (document.getElementById(STYLE_ID)) {
    _stylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .crsmart-coach-mark {
      max-width: 280px;
      padding: 12px 14px;
      background: #1c1916;
      color: #f0e8df;
      border: 1px solid rgba(255, 140, 40, 0.4);
      border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.45;
      animation: crsmart-coach-mark-in 220ms ease-out both;
      pointer-events: auto;
    }
    @keyframes crsmart-coach-mark-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .crsmart-coach-mark.is-dismissing {
      animation: crsmart-coach-mark-out 180ms ease-in both;
    }
    @keyframes crsmart-coach-mark-out {
      from { opacity: 1; }
      to   { opacity: 0; transform: translateY(-2px); }
    }
    .crsmart-coach-mark-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
    }
    .crsmart-coach-mark-title {
      color: #ff8c28;
      font-size: 12px;
      letter-spacing: 0.4px;
    }
    .crsmart-coach-mark-text { color: #f0e8df; }
    .crsmart-coach-mark-dismiss {
      background: rgba(255, 140, 40, 0.15);
      color: #ff8c28;
      border: 1px solid rgba(255, 140, 40, 0.4);
      border-radius: 6px;
      padding: 4px 10px;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background 100ms ease;
    }
    .crsmart-coach-mark-dismiss:hover { background: rgba(255, 140, 40, 0.25); }
  `;
  (document.head || document.documentElement).appendChild(style);
  _stylesInjected = true;
}

async function loadSeen() {
  if (_seenCache) return _seenCache;
  // Context-invalidation guard — same reason the inline copy in
  // content.js needs it. The sidepanel context survives most
  // extension reloads but defensive checks here cost nothing and
  // make the helper safe to drop into a content-script consumer
  // later.
  if (!chrome?.runtime?.id) {
    _seenCache = {};
    return _seenCache;
  }
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, 'surfaceSettings']);
    // Dev override: surfaceSettings.devKeepOnboarding bypasses the
    // seen map entirely so coach marks re-fire every load. Don't
    // cache when the dev flag is on — re-read each call so toggling
    // off mid-session restores normal behavior on the next showCoachMarkOnce.
    if (stored?.surfaceSettings?.devKeepOnboarding === true) {
      return {};
    }
    _seenCache = stored?.[STORAGE_KEY] || {};
  } catch {
    _seenCache = {};
  }
  return _seenCache;
}

async function markSeen(key) {
  const seen = await loadSeen();
  if (seen[key]) return;
  seen[key] = true;
  if (!chrome?.runtime?.id) return;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: seen });
  } catch {}
}

// Show a coach mark once. If `key` has already been seen, this is a
// no-op. Caller passes:
//   - key: stable id, e.g. 'picks-tab'
//   - anchor: DOM element to position next to (we anchor below it)
//   - title: short bold line
//   - body: longer prose
//   - placement: 'below' | 'above' | 'right' (default 'below')
//
// Returns the coach-mark element so callers can override styling if
// needed; null if it didn't fire (already seen or anchor missing).
export async function showCoachMarkOnce({
  key,
  anchor,
  title,
  body,
  placement = 'below',
} = {}) {
  if (!key || !anchor) return null;
  const seen = await loadSeen();
  if (seen[key]) return null;

  injectStylesOnce();

  // Build the element. Inline-styled positioning keeps it independent
  // of which surface mounts it (side-panel vs CR-injected card).
  const el = document.createElement('div');
  el.className = `crsmart-coach-mark crsmart-coach-mark--${placement}`;
  el.dataset.coachKey = key;
  el.setAttribute('role', 'tooltip');
  el.innerHTML = `
    <div class="crsmart-coach-mark-body">
      <strong class="crsmart-coach-mark-title"></strong>
      <span class="crsmart-coach-mark-text"></span>
    </div>
    <button class="crsmart-coach-mark-dismiss" type="button" aria-label="Got it">Got it</button>
  `;
  el.querySelector('.crsmart-coach-mark-title').textContent = title || '';
  el.querySelector('.crsmart-coach-mark-text').textContent = body || '';

  positionRelativeTo(el, anchor, placement);

  // Append to body so the tooltip floats above the surface without
  // inheriting overflow:hidden constraints.
  document.body.appendChild(el);

  const dismiss = async () => {
    el.classList.add('is-dismissing');
    setTimeout(() => el.remove(), 180);
    await markSeen(key);
    document.removeEventListener('click', onDocClick, true);
    window.removeEventListener('resize', reposition);
  };
  const onDocClick = () => dismiss();
  const reposition = () => positionRelativeTo(el, anchor, placement);

  el.querySelector('.crsmart-coach-mark-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss();
  });
  // Any click anywhere also dismisses — coach marks are deliberately
  // unsticky so they never feel like a modal.
  setTimeout(() => document.addEventListener('click', onDocClick, true), 50);
  window.addEventListener('resize', reposition);

  return el;
}

function positionRelativeTo(el, anchor, placement) {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  el.style.position = 'fixed';
  el.style.zIndex = '2147483640';
  if (placement === 'above') {
    el.style.left = `${Math.max(8, rect.left)}px`;
    el.style.top = `${Math.max(8, rect.top - margin - 80)}px`;
  } else if (placement === 'right') {
    el.style.left = `${rect.right + margin}px`;
    el.style.top = `${rect.top}px`;
  } else {
    el.style.left = `${Math.max(8, rect.left)}px`;
    el.style.top = `${rect.bottom + margin}px`;
  }
}
