(() => {
// Injects Smart Scoring tiles into Crunchyroll's top navigation bar,
// alongside the search / bookmark / profile icons. Two buttons:
//
//   - sparkle ✦  — opens the Smart Picks side panel. Always rendered
//                  (modulo surfaceSettings.sidePanel = false).
//   - tour star  — fires the onboarding tour overlay. ONE-SHOT — only
//                  rendered while tourSeen.dismissedAt is unset. The
//                  moment the tour modal closes, the storage write
//                  trips this script's onChanged listener and the
//                  button removes itself from DOM (no page reload
//                  needed). After dismiss, popup menu's "Show me
//                  around again" is the only re-watch path.
//
// CR is a React SPA — the top bar can be re-rendered on navigation, so
// we keep a MutationObserver alive and re-inject any missing tiles.
// Throttled via rAF so the observer doesn't churn on every DOM mutation.
//
// We match CR's native tile structure so we sit cleanly in the row:
//   <a class="erc-header-tile state-icon-only erc-search-header-button-old">
// — same height (60px), same horizontal padding (0 9px), same icon color
// (rgb(187,187,187)), with the orange brand color on hover.

const SETTINGS_KEY = 'surfaceSettings';
const TOUR_SEEN_KEY = 'tourSeen';

let surfaceEnabled = true;     // gates the sparkle button
let tourButtonAlive = true;    // gates the tour button (true = render)
let keepTourButton = false;    // user override: keep button visible past dismiss

// Outline 4-point sparkle.
const ICON_SPARKLE = `
<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3 L13.6 10.4 L21 12 L13.6 13.6 L12 21 L10.4 13.6 L3 12 L10.4 10.4 Z"/>
</svg>`;

// Five-point star with a dot — distinct from the sparkle so users
// can tell the two buttons apart at a glance.
const ICON_TOUR = `
<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 2 L14.4 8.6 L21.5 9 L16 13.5 L17.6 20.5 L12 16.6 L6.4 20.5 L8 13.5 L2.5 9 L9.6 8.6 Z"/>
</svg>`;

// Button registry. Each spec defines render gating + click behavior.
// shouldRender() reads module-level state (set by storage listeners)
// rather than re-fetching storage on every inject pass — that keeps
// the inject hot path synchronous.
const BUTTONS = [
  {
    id: 'crsmart-topbar-tour-btn',
    title: 'Take the Smart Scoring tour — 90 sec',
    icon: ICON_TOUR,
    // User override wins: surfaceSettings.keepTourButton keeps the
    // button rendering even after the user dismissed the tour. Surfaced
    // in the popup as a real toggle for users who want the tour easily
    // re-triggerable, plus QA iteration where the tour can be re-fired
    // without resetting storage.
    shouldRender: () => keepTourButton || tourButtonAlive,
    onClick: () => {
      try {
        chrome.runtime.sendMessage({ type: 'crsmart:show-tour' });
      } catch (err) {
        if (!String(err?.message || err).includes('Extension context invalidated')) {
          console.warn('[crsmart] tour sendMessage failed', err);
        }
      }
    },
  },
  {
    id: 'crsmart-topbar-btn',     // legacy id — sidepanel button
    title: 'Smart Picks — recommendations from your taste',
    icon: ICON_SPARKLE,
    shouldRender: () => surfaceEnabled,
    onClick: () => {
      // When the extension is reloaded while a CR tab stays open, the
      // injected chrome.runtime reference goes undefined OR sendMessage
      // throws "Extension context invalidated" — same root cause, two
      // different surfaces. Optional chaining handles the
      // chrome-undefined case silently; the catch handles the
      // sendMessage-throw case. Other errors still surface.
      try {
        if (!chrome?.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({ type: 'crsmart:open-side-panel' });
      } catch (err) {
        if (!String(err?.message || err).includes('Extension context invalidated')) {
          console.warn('[crsmart] sendMessage failed', err);
        }
      }
    },
  },
];

async function loadInitialState() {
  try {
    const data = await chrome.storage.local.get([SETTINGS_KEY, TOUR_SEEN_KEY]);
    const cur = data[SETTINGS_KEY] || {};
    surfaceEnabled = cur.sidePanel !== false;
    // Honor both the new user-facing key and the legacy dev-only key
    // so installs with devKeepTourButton already set in storage don't
    // suddenly lose their override after the rename.
    keepTourButton = cur.keepTourButton === true || cur.devKeepTourButton === true;
    // Tour button shows iff user hasn't dismissed yet. dismissedAt is
    // set on every close (CTA, ✕, Esc) — sticky one-shot.
    tourButtonAlive = !data[TOUR_SEEN_KEY]?.dismissedAt;
  } catch (_) {
    surfaceEnabled = true;
    tourButtonAlive = true;
    keepTourButton = false;
  }
}

function watchState() {
  if (!chrome?.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needsReinject = false;
    if (changes[SETTINGS_KEY]) {
      const next = changes[SETTINGS_KEY].newValue || {};
      const prevSurface = surfaceEnabled;
      const prevKeep = keepTourButton;
      surfaceEnabled = next.sidePanel !== false;
      keepTourButton = next.keepTourButton === true || next.devKeepTourButton === true;
      if (prevSurface !== surfaceEnabled || prevKeep !== keepTourButton) {
        needsReinject = true;
      }
    }
    if (changes[TOUR_SEEN_KEY]) {
      const next = changes[TOUR_SEEN_KEY].newValue || {};
      const prev = tourButtonAlive;
      tourButtonAlive = !next.dismissedAt;
      if (prev !== tourButtonAlive) needsReinject = true;
    }
    if (needsReinject) {
      // Tear down any tile whose shouldRender() now returns false,
      // then re-run the inject pass to rebuild.
      for (const spec of BUTTONS) {
        if (!spec.shouldRender()) {
          const el = document.getElementById(spec.id);
          if (el) el.remove();
        }
      }
      scheduleInject();
    }
  });
}

function createTile(spec) {
  const tile = document.createElement('a');
  tile.id = spec.id;
  tile.href = '#';
  tile.role = 'button';
  tile.title = spec.title;
  tile.setAttribute('aria-label', spec.title);
  tile.className = 'erc-header-tile state-icon-only erc-smartpicks-header-button';
  tile.innerHTML = spec.icon;

  // Match CR's native icon tiles.
  Object.assign(tile.style, {
    background: 'none',
    border: 'none',
    color: 'rgb(187, 187, 187)',
    cursor: 'pointer',
    padding: '0 9px',
    margin: '0',
    height: '60px',
    minWidth: '42px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    textDecoration: 'none',
    transition: 'color 0.15s, transform 0.1s',
    flexShrink: '0',
    boxSizing: 'border-box',
  });

  tile.addEventListener('mouseenter', () => { tile.style.color = '#f47521'; });
  tile.addEventListener('mouseleave', () => { tile.style.color = 'rgb(187, 187, 187)'; });
  tile.addEventListener('mousedown',  () => { tile.style.transform = 'scale(0.92)'; });
  tile.addEventListener('mouseup',    () => { tile.style.transform = 'scale(1)'; });
  tile.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    spec.onClick();
  });
  return tile;
}

// Find the search anchor itself (NOT its inner SVG container). Tiles
// are injected as siblings BEFORE the search anchor inside the shared
// action-item flex row, so spacing comes out the same as bookmark/profile.
function findSearchAnchor() {
  return (
    document.querySelector('a.erc-search-header-button-old') ||
    document.querySelector('[class*="erc-search-header-button"]') ||
    document.querySelector('header a[aria-label*="Search" i]') ||
    document.querySelector('header [data-t*="search" i]')
  );
}

function tryInject() {
  const search = findSearchAnchor();
  if (!search || !search.parentElement) return false;

  for (const spec of BUTTONS) {
    if (!spec.shouldRender()) {
      // Remove if currently injected.
      const existing = document.getElementById(spec.id);
      if (existing) existing.remove();
      continue;
    }
    const existing = document.getElementById(spec.id);
    // Already in correct parent — leave alone.
    if (existing && existing.parentElement === search.parentElement) continue;
    // Stale copy in wrong parent (post-React-rerender) — remove + re-add.
    if (existing) existing.remove();
    const tile = createTile(spec);
    search.parentElement.insertBefore(tile, search);
  }
  return true;
}

let pending = false;
function scheduleInject() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    tryInject();
  });
}

// Boot.
(async () => {
  await loadInitialState();
  watchState();
  scheduleInject();
  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.body, { childList: true, subtree: true });
})();
})();
