// Shared helpers for the user's surface-toggle preferences:
//   - sidePanel:      whether the sparkle button is injected into CR's top bar
//   - showPagePanel:  whether the Smart Score card is injected on series pages
//
// Defaults: both ON. Stored in chrome.storage.local under 'surfaceSettings'.
// Loaded as a plain script; exposes window.SURFACE_SETTINGS.
//
// Wrapped in an IIFE so the top-level constants don't leak into popup.js
// (which shares the popup window's global scope).

(() => {
const STORAGE_KEY = 'surfaceSettings';
const DEFAULTS = {
  sidePanel: true,
  showPagePanel: true,
  // Cover-art bleed on the show-page card defaults OFF — the translucent
  // blurred panel reads as a clean overlay on top of CR's hero, while the
  // bleed is a heavier, themed look the user opts into.
  coverBleed: false,
  // Max-width of the show-page card, in px. 820 matches the previous
  // hard-coded default; the popup exposes a slider so users can tune
  // how wide the card stretches on CR's hero.
  cardMaxWidth: 820,
  // Cinematic hero background: lock the key-art as a viewport-fixed
  // backdrop and darken it progressively as the user scrolls into the
  // episode list. Defaults ON.
  heroBgLock: true,
  // Edge blur: filter:blur applied on the gradient div itself, feathering
  // its transparent→black top edge so the transition reads as diffuse.
  // 0 = crisp (no blur), up to 60 = very soft. Default 16.
  heroBgBlur: 16,
  // Gradient coverage (vh): base height of the gradient at the top of
  // the page. Height grows by 40vh as the user scrolls past the hero.
  // Larger = gradient covers more of the viewport up front, which hides
  // the bottom of the key-art sooner. Default 80.
  heroBgSize: 80,
  // Maximum darkness (0–100 %). Scales all gradient alpha stops. 100 =
  // fully black at bottom; lower values keep the bottom semi-transparent
  // so the key-art tints rather than disappears. Default 100.
  heroBgDark: 100,
  // Mid-stop opacity (0–100 %). Scales the base alpha of the two middle
  // gradient stops (independent of the top/bottom). 100 = current defaults;
  // lower = gradient is more concentrated near the bottom edge. Default 100.
  heroBgMid: 100,
  // Key-art image scale (%). 100 = natural fill; higher zooms in and
  // hides edges; lower shows more of the image. Default 140.
  heroBgScale: 140,
  // Vertical offset of the key-art in vh. Positive = image shifts down
  // on screen (revealing more of the top); negative = shifts up.
  // Default 0 (centered).
  heroBgOffsetY: 0,
  // CR's own ::after overlay gradient (diagonal + left wash + bottom
  // fade). Opacity multiplier 0–100; 100 = original CR strength.
  heroCrOverlay: 100,
  // Start stop (%) of CR's bottom vertical fade — where the black
  // begins fading in. CR's native value is 45.
  heroCrBottomFade: 45,
  // End stop (%) of CR's bottom fade — where it reaches full darkness.
  // CR's native value is ~82. Pull it higher to push black further
  // down; lower to reach black sooner.
  heroCrBottomEnd: 82,
  // Max darkness (0–100 %) at the bottom of CR's fade. 100 = solid
  // black; lower values leave the bottom semi-transparent so the
  // key-art peeks through even at the bottom edge.
  heroCrBottomDark: 100,
  // Diagonal top-left corner shadow (0–100 %). CR's native strength
  // is 100 (matches rgba 0.55 at 5%).
  heroCrDiagonal: 100,
  // Horizontal left wash behind the title text (0–100 %). CR's
  // native strength is 100 (matches rgba 0.85 → 0.5 → 0).
  heroCrLeftWash: 100,
  // Dealbreaker tags — AniList tag/genre names the user has marked
  // as hard-excludes. A show with any of these tags at rank ≥ 50
  // (centrality threshold, see rank-recommendations.js) or any of
  // these as a listed genre is filtered out before scoring. User
  // can populate from the popup's Settings → Dealbreakers section,
  // either accepting auto-surfaced suggestions or adding manually.
  dealbreakerTags: [],
  // Show the dedicated "Genre" row on series-page cards. When ON, the
  // signed rationale rows ("Why you're in" / "What might bug you") only
  // surface tag-level signal — broad genres are filtered out so the
  // chips read as differentiating reasons instead of lane info. When
  // OFF, the broad genres re-enter the signed rows. Default ON.
  genreRow: true,
  // Reveal AniList-flagged spoiler tags directly in signed rationale
  // chips. Default OFF — spoiler-tagged contributors render as a 🔒
  // placeholder requiring a per-chip click to reveal. Toggle ON when
  // you've already seen most of your catalog and the lock is friction.
  showSpoilers: false,
  // Dev axis sandbox: when ON, the side panel's Shape view renders an
  // extra collapsible section with sliders that override the radar's
  // axis values + signalSeriesCount in real-time. Used for testing
  // family palettes / archetype variations / confidence pill states
  // without watching shows / re-rating. Default OFF; sandbox state
  // persists under chrome.storage.local._devAxisSandbox.
  devAxisSandbox: false,
  // Dev: keep onboarding visible. When ON, the survey's "👋 New here?"
  // banner re-shows every load (regardless of surveyOnboardingDismissed)
  // and one-time coach marks re-fire (regardless of coachMarksSeen).
  // Reads gate the *check*, not the write — the user's actual stored
  // dismissal flags aren't touched, so toggling OFF restores normal
  // behavior. Used for QAing the new-user experience without resetting
  // storage between every iteration.
  devKeepOnboarding: false,
  // Keep the top-bar tour button persistent. Normally that button is
  // one-shot (auto-removes after first dismiss). When ON, it stays in
  // CR's top bar regardless of tourSeen.dismissedAt — re-fire the tour
  // from CR without going through the popup menu. Surfaced as a user
  // toggle in the popup; doesn't touch tourSeen so toggling OFF restores
  // the one-shot lifecycle. Legacy devKeepTourButton storage key is
  // still honored at read time by topbar-buttons.js for migration.
  keepTourButton: false,

  // ── Phase 4 (2026-05): Taste-shape view tunables ──────────
  // Continuous per-family BG motion (drama spotlight breath, romance
  // petal drift, mystery rolling fog, etc.). Defaults ON — the
  // animated state is the primary visual identity for each family;
  // a disabled toggle reverts to a static frozen frame. Page
  // Visibility pause + prefers-reduced-motion override are both
  // honored, so battery / motion-sensitive users aren't penalized.
  tasteShapeAnimateBg: true,
  // [Legacy] Intro animation toggle. Superseded by tasteShapeAnimTempo
  // below; kept in defaults so older boots that read this key still
  // resolve to ON. New writes should target tasteShapeAnimTempo.
  tasteShapeIntroAnim: true,
  // BG motif opacity multiplier (0–100, percent). Surfaces in the
  // popup as "Atmosphere intensity" — controls how loud the per-family
  // canvas wallpaper reads behind the radar. Storage key kept for
  // back-compat with the original SVG motif system.
  tasteShapeBgOpacity: 100,
  // Animation tempo (2026-05): 4-state preference replacing the binary
  // tasteShapeIntroAnim. Drives intro-cascade duration and per-family
  // canvas painter timing (auteur brush stagger, motif breath cycles).
  //   'off'        — skip intro entirely; same gate path as reduced-motion
  //   'swift'      — ~1.4s intro / ~3s breath
  //   'balanced'   — ~2.9s intro / ~6s breath (default)
  //   'leisurely'  — ~5s intro / ~12s breath
  tasteShapeAnimTempo: 'balanced',
};
const CARD_WIDTH_MIN = 640;
const CARD_WIDTH_MAX = 1200;
const HERO_BG_SIZE_MIN = 40;
const HERO_BG_SIZE_MAX = 140;
const HERO_BG_BLUR_MAX = 60;

async function getSurfaceSettings() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return { ...DEFAULTS, ...(data[STORAGE_KEY] || {}) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

async function setSurfaceSettings(patch) {
  const current = await getSurfaceSettings();
  const next = { ...current, ...patch };
  try { await chrome.storage.local.set({ [STORAGE_KEY]: next }); } catch (_) {}
  return next;
}

// Subscribe to live changes. Callback receives the new full settings object.
function onSurfaceSettingsChanged(cb) {
  if (!chrome?.storage?.onChanged) return () => {};
  const handler = (changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    cb({ ...DEFAULTS, ...(changes[STORAGE_KEY].newValue || {}) });
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

window.SURFACE_SETTINGS = {
  DEFAULTS,
  CARD_WIDTH_MIN,
  CARD_WIDTH_MAX,
  HERO_BG_SIZE_MIN,
  HERO_BG_SIZE_MAX,
  HERO_BG_BLUR_MAX,
  getSurfaceSettings,
  setSurfaceSettings,
  onSurfaceSettingsChanged,
};
})();
