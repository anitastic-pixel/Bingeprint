// Quick Taste Check — survey page logic.
//
// State model:
//   surveyShapes (chrome.storage.local) is keyed by aniListId. Each
//   entry is one of:
//     { state: 'loved',    tappedAt: number }
//     { state: 'disliked', tappedAt: number }
//   Skipped tiles aren't persisted (default state is "no entry").
//
// Tap cycle (cycleNextState):
//   skip → loved → disliked → skip
//
// Tile data lookup precedence:
//   1) aniListBridgeCache by AL ID (worker has fetched it)
//   2) aniListCache by CR series ID where the AL ID matches
//   3) On-demand bulk fetch via the worker (queued, debounced)
//   Tiles render with a placeholder skeleton until data lands.
//
// Save behavior:
//   Live save per tap to chrome.storage.local.surveyShapes. Worker's
//   storage.onChanged listener picks up the change; persistTasteVector
//   is debounced 2s after the last tap (handled in background.js).
//
// Done button:
//   Sends 'forceTasteRecompute' to the worker so the user gets an
//   immediate refresh instead of waiting for the next sync trigger.
//   Then renders the summary screen.

import {
  SURVEY_ANCHORS,
  ARCHETYPE_LABEL_BY_ID,
  SURVEY_VIEW_FILTERS,
  STREAMING_SERVICES,
  STREAMING_SERVICE_BY_ID,
  servicesForAnchor,
} from './survey-anchors.js';
import { SURVEY_GENRE_ANCHORS, GENRE_SECTION_ORDER, GENRE_SECTION_LABEL_BY_ID } from './survey-genre-anchors.js';
import { STORAGE_KEYS, clearSurveyState, subscribe as subscribeStorage } from './storage-schema.js';
import {
  STATE,
  loadAllPrefs as loadAllStatePrefs,
  resetForFreshSession,
  setMode as stateSetMode,
  setView as stateSetView,
  setMatureOn as stateSetMatureOn,
  toggleServiceFilter as stateToggleServiceFilter,
  clearServiceFilter as stateClearServiceFilter,
  dismissOnboarding as stateDismissOnboarding,
  recordShowTap,
  recordTagTap,
  undoLastAction as stateUndoLastAction,
  clearActiveModeTaps,
  totalTapCount,
  activeModeTapCount,
  tapStateForShow,
  tapStateForTag,
} from './survey-state.js';
import {
  archAccent,
  archFlavor,
  genreSectionAccent,
  GENRE_SECTION_FLAVOR_BY_ID,
  buildServiceBadge,
  buildTierBadge,
  playTapFeedback,
  playTapFlash,
  syncCloneVisuals,
} from './tile.js';
import {
  renderTastePreview,
  applyTasteSidebarVisibility,
  createTastePillClickHandler,
} from './taste-preview.js';
import { confidenceLevelFor, updateConfidenceBadge } from './confidence.js';
import { showCoachMarkOnce } from './coach-marks.js';
import {
  applyTaste,
  applyAndTransition,
  renderSummary,
  renderPendingTapsNotice,
  renderTapEffectsNotice,
} from './apply-flow.js';
import {
  DRAG_THRESHOLD_PX,
  MOMENTUM_DECAY,
  MIN_VELOCITY,
  ELASTIC_RUBBER_FACTOR,
  ELASTIC_BACK_MS,
  IDLE_DRIFT_DELAY_MS,
  DRIFT_PX_PER_FRAME,
  attachClickSuppressor,
  markDragEnded,
  createMotionDirSetter,
  createIdleScheduler,
  prefersReducedMotion,
} from './row-interaction.js';

// Storage key constants — keep the local aliases as a transition
// shim so existing references in this file (search/replace radius
// is wide) keep working. New code should reach for STORAGE_KEYS
// directly; over time these aliases can be removed.
const SURVEY_SHAPES_KEY = STORAGE_KEYS.surveyShapes;
const SURVEY_TAG_SHAPES_KEY = STORAGE_KEYS.surveyTagShapes;
const SURVEY_STUDIO_SHAPES_KEY = STORAGE_KEYS.surveyStudioShapes;
const ANILIST_BRIDGE_CACHE_KEY = STORAGE_KEYS.aniListBridgeCache;
const VIEW_PREF_KEY = STORAGE_KEYS.surveyViewPref;
const ACTIVE_MODE_KEY = STORAGE_KEYS.surveyActiveMode;
const MATURE_FILTER_KEY = STORAGE_KEYS.surveyMatureFilter;
const SERVICE_FILTER_KEY = STORAGE_KEYS.surveyServiceFilter;
const ONBOARDING_DISMISSED_KEY = STORAGE_KEYS.surveyOnboardingDismissed;
const DEFAULT_VIEW = 'all';
const DEFAULT_MODE = 'shows';
const VALID_MODES = new Set(['shows', 'genres', 'studios']);
const VALID_SERVICE_IDS = new Set(STREAMING_SERVICES.map(s => s.id));

// STATE moved to survey-state.js — see imports above. Existing
// reads (STATE.shapes, STATE.matureOn, ...) still work via the
// transitional re-export; mutations should go through the typed
// helpers (recordShowTap, setMode, setMatureOn, etc.).

// Per-archetype accent palette. Each archetype gets its own hue so
// long scrolls don't read as a uniform orange wash; the section
// header bar, the row's progress fill, and the hover tint all pull
// from the same var. Colors are picked to evoke the archetype's
// vibe while staying readable on the warm-dark base.
// ARCHETYPE_ACCENT_BY_ID + archAccent moved to tile.js — imported above.

// Pre-built lookups for the bridge-cache storage listener — avoids
// O(anchors) per cache change. Hoisted once at module load.
const SHOW_ANCHOR_AL_IDS = new Set(SURVEY_ANCHORS.map(a => a.aniListId));
const GENRE_REP_AL_IDS = new Set(
  SURVEY_GENRE_ANCHORS.map(g => g.representativeAniListId)
);

// Tear down a row before its DOM container is replaced. Disconnects
// the ResizeObserver from makeRowInfinite (which would otherwise
// hold a reference to the detached row indefinitely) and stops the
// drift / momentum rAFs (which would otherwise keep scheduling
// against the detached row forever, draining frame budget). The
// row's pointer / wheel / click listeners are GC'd along with the
// element naturally — no manual removal needed.
function tearDownRow(rowEl) {
  if (!rowEl) return;
  if (rowEl._loopRO) {
    try { rowEl._loopRO.disconnect(); } catch (_) {}
    rowEl._loopRO = null;
  }
  if (typeof rowEl._loopTeardown === 'function') {
    try { rowEl._loopTeardown(); } catch (_) {}
    rowEl._loopTeardown = null;
  }
}

// Tear down every wired row inside a grid container, then clear it.
// Called by renderGrid / renderGenreGrid before innerHTML = '' so we
// don't leak observers or rAFs across re-renders.
function clearGridContent(gridEl) {
  if (!gridEl) return;
  for (const row of gridEl.querySelectorAll('.tile-grid-row')) {
    tearDownRow(row);
  }
  gridEl.innerHTML = '';
}

// Vibe phrase per archetype — a one-liner that gives the section
// flavor. Anime users respond to feel-words; section names alone
// read as form labels. Phrases are short on purpose so the header
// row stays compact.
// Archetype flavor + Genre palette/flavor moved to tile.js. Imported above.

// Section-aware page tint — finds the .tile-grid-section closest to
// the viewport center and writes its accent to body's --section-tint
// var. The body::after radial gradient picks that up and applies a
// soft full-page wash, so scrolling through Mainstream Shounen tints
// the page orange, Mecha tints it blue, etc. Smooth CSS transition
// blends the handoff between adjacent sections.
let lastSectionTint = '';
function updateSectionTint() {
  const sections = document.querySelectorAll(
    '.tab-content:not([hidden]) .tile-grid-section'
  );
  if (sections.length === 0) return;
  const center = window.innerHeight / 2;
  let closest = null;
  let minDist = Infinity;
  for (const sec of sections) {
    const rect = sec.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const secCenter = rect.top + rect.height / 2;
    const dist = Math.abs(secCenter - center);
    if (dist < minDist) {
      minDist = dist;
      closest = sec;
    }
  }
  if (!closest) return;
  let accent = null;
  if (closest.dataset.archetypeId) {
    accent = archAccent(closest.dataset.archetypeId);
  } else if (closest.dataset.section) {
    accent = genreSectionAccent(closest.dataset.section);
  }
  if (accent && accent !== lastSectionTint) {
    lastSectionTint = accent;
    document.body.style.setProperty('--section-tint', accent);
    // Section just became dominant — fire a brief horizontal flash on
    // it so the transition is felt, not just seen as a tint shift.
    triggerSectionFlash(closest);
  }
}

// Adds .is-just-active on the section for the lifetime of one short
// CSS animation. Removing the class on animationend lets the flash
// retrigger if the user re-enters the section later. Throttled by a
// stamp on the element so rapid scroll-jitter doesn't restart the
// animation in the same beat.
function triggerSectionFlash(sectionEl) {
  const now = performance.now();
  const last = sectionEl._sectionFlashAt || 0;
  if (now - last < 600) return;
  sectionEl._sectionFlashAt = now;
  sectionEl.classList.remove('is-just-active');
  // Force a reflow so re-adding the class restarts the animation.
  void sectionEl.offsetWidth;
  sectionEl.classList.add('is-just-active');
  const cleanup = () => sectionEl.classList.remove('is-just-active');
  sectionEl.addEventListener('animationend', cleanup, { once: true });
  // Belt-and-suspenders cleanup if animationend doesn't fire.
  setTimeout(cleanup, 900);
}

// Live header height → CSS var. Sticky archetype headers pin to
// var(--header-stick) so they always sit just under the live (and
// possibly compacted) survey-header. Recomputed on scroll, resize,
// and mode-switch.
let lastHeaderStick = -1;
function updateHeaderStick() {
  const headerEl = document.querySelector('.survey-header');
  const appEl = document.querySelector('.survey-app');
  if (!headerEl || !appEl) return;
  // Round up so a fractional pixel doesn't leave a 1px gap below the
  // header through which tile content can peek as it scrolls past.
  const next = Math.ceil(headerEl.getBoundingClientRect().height);
  if (next === lastHeaderStick) return;
  lastHeaderStick = next;
  appEl.style.setProperty('--header-stick', `${next}px`);
}

// Mature + streaming service gating, shared by visibleAnchors() and
// the hint-count helper below. Pulled out so the two stay in sync.
function passesNonViewFilters(anchor) {
  if (anchor.mature && !STATE.matureOn) return false;
  if (STATE.serviceFilter.size > 0) {
    const services = servicesForAnchor(anchor);
    if (!services.some(s => STATE.serviceFilter.has(s))) return false;
  }
  return true;
}

// Anchors filtered by the current view + mature toggle + streaming
// service filter. Tap state lives in STATE.shapes keyed by aniListId,
// so a show that's hidden in the current view still keeps its
// loved/disliked state and re-appears with that state intact when the
// user switches views.
function visibleAnchors() {
  const viewFilter = SURVEY_VIEW_FILTERS[STATE.view] || SURVEY_VIEW_FILTERS.all;
  return SURVEY_ANCHORS.filter(a => passesNonViewFilters(a) && viewFilter(a));
}

// Count anchors that would be visible for a given view key (applies
// mature + service filter but uses the view key passed in, not
// STATE.view). Used by syncViewHints to populate the per-view tile
// counts in the Mainstream/All/Deep Cuts buttons.
function countAnchorsForView(viewKey) {
  const viewFilter = SURVEY_VIEW_FILTERS[viewKey] || SURVEY_VIEW_FILTERS.all;
  let count = 0;
  for (const a of SURVEY_ANCHORS) {
    if (passesNonViewFilters(a) && viewFilter(a)) count++;
  }
  return count;
}

// ── State helpers ───────────────────────────────────────────────
const STATE_CYCLE = ['skip', 'loved', 'disliked'];
function cycleNextState(current) {
  const idx = STATE_CYCLE.indexOf(current || 'skip');
  return STATE_CYCLE[(idx + 1) % STATE_CYCLE.length];
}

// loadAllPrefs + per-field save helpers moved to survey-state.js.
// boot() calls loadAllStatePrefs(allMediaAniListIds) instead.
// Save fns are now internal to the state module — mutators
// (setMode/setView/...) persist on every change.

// Decide whether the banner should be visible given current state.
// Visible iff: zero taps AND the user hasn't manually dismissed.
// Auto-fades (rather than just hides) when transitioning from
// visible → not-visible so the disappearance feels intentional.
//
// Side effect: any tap implicitly persists the dismissed flag so
// undoing back to 0 taps doesn't re-show the banner. The user has
// engaged with the survey — re-onboarding would feel patronizing.
// Funnel strip — three-step progress indicator above the survey.
// Welcome is always done; Build flips to done after the first tap;
// Picks is reserved for the apply transition (handled in onDone).
function syncOnboardingFunnel() {
  const buildStep = document.getElementById('funnel-step-build');
  if (!buildStep) return;
  if (tapCount() > 0) {
    buildStep.classList.remove('is-active');
    buildStep.classList.add('is-done');
  } else {
    buildStep.classList.remove('is-done');
    buildStep.classList.add('is-active');
  }
}

function syncOnboardingBanner() {
  syncOnboardingFunnel();
  const banner = document.getElementById('onboarding-banner');
  if (!banner) return;

  // Auto-dismiss now lives inside survey-state.js's tap mutators —
  // no in-line dismissal needed here. This sync function purely
  // reads the current state to decide visibility.

  const shouldShow = tapCount() === 0 && !STATE.onboardingDismissed;
  if (shouldShow) {
    banner.hidden = false;
    banner.classList.remove('is-fading');
    return;
  }
  if (banner.hidden) return;
  // Trigger fade-out animation, then hide on animationend (with a
  // setTimeout backstop in case animationend doesn't fire — e.g.
  // reduced-motion users skip the animation).
  banner.classList.add('is-fading');
  const finish = () => {
    banner.hidden = true;
    banner.classList.remove('is-fading');
  };
  banner.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 500);
}

async function dismissOnboarding() {
  // State + persistence in survey-state. We just wire the visual
  // fade-out animation that lives at this layer.
  const dismissed = await stateDismissOnboarding();
  if (dismissed) syncOnboardingBanner();
}

async function toggleServiceFilter(serviceId) {
  const changed = await stateToggleServiceFilter(serviceId);
  if (!changed) return;
  syncServicePills();
  syncViewHints();
  // Fade-out → swap → fade-in. Sequential (not crossfade) so the
  // glow + tile state never get caught between old and new during
  // the transition.
  fadeSwapGrid(() => renderGrid());
}

async function clearServiceFilter() {
  const changed = await stateClearServiceFilter();
  if (!changed) return;
  syncServicePills();
  syncViewHints();
  fadeSwapGrid(() => renderGrid());
}

// Build the pill row from STREAMING_SERVICES. "All Services" pill is
// inserted first; service-specific pills follow in `order`. Each pill
// gets a `--service-color` CSS var that the active-state styling reads
// for the brand-colored fill + halo.
function renderServicePills() {
  const root = document.getElementById('service-filter');
  if (!root) return;
  root.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'service-btn';
  allBtn.dataset.service = 'all';
  allBtn.setAttribute('aria-pressed', 'false');
  allBtn.innerHTML = `
    <span class="service-btn-dot"></span>
    <span class="service-btn-label">All Services</span>
  `;
  allBtn.addEventListener('click', () => clearServiceFilter());
  root.appendChild(allBtn);

  const ordered = [...STREAMING_SERVICES].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  for (const service of ordered) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'service-btn';
    btn.dataset.service = service.id;
    btn.style.setProperty('--service-color', service.color);
    btn.setAttribute('aria-pressed', 'false');
    btn.title = service.label;
    btn.innerHTML = `
      <span class="service-btn-dot"></span>
      <span class="service-btn-label">${escapeHtml(service.label)}</span>
    `;
    btn.addEventListener('click', () => toggleServiceFilter(service.id));
    root.appendChild(btn);
  }

  syncServicePills();
}

function syncServicePills() {
  const root = document.getElementById('service-filter');
  if (!root) return;
  const allActive = STATE.serviceFilter.size === 0;
  for (const btn of root.querySelectorAll('.service-btn')) {
    const id = btn.dataset.service;
    const isActive = id === 'all' ? allActive : STATE.serviceFilter.has(id);
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }
}

async function setMode(nextMode) {
  // Mutation lives in survey-state.js; here we orchestrate the
  // post-switch UI sync. survey-state captures the scroll position,
  // clears lastAction, and persists; we wire everything else.
  const changed = await stateSetMode(nextMode);
  if (!changed) return;
  syncModeUI();
  syncUndoButton();
  resetClearAllConfirm();
  syncClearAllButton();
  renderTasteShape();
  window.scrollTo({ top: STATE.scrollTopByMode[nextMode] || 0, behavior: 'instant' });
  updateSectionTint();
}

function syncModeUI() {
  // Tabs: which one is active.
  for (const btn of document.querySelectorAll('.mode-tab')) {
    const isActive = btn.dataset.mode === STATE.activeMode;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  // Tab panels: which one is visible.
  for (const panel of document.querySelectorAll('.tab-content')) {
    const isActive = panel.dataset.mode === STATE.activeMode;
    panel.hidden = !isActive;
  }
  // Shows-only controls in the sticky header (service filter +
  // view switcher) hide when in Genres mode — those filters don't
  // apply to genre tiles.
  const showsControls = document.getElementById('header-shows-controls');
  if (showsControls) showsControls.hidden = STATE.activeMode !== 'shows';
  // Header height changed (controls grew/shrank) → re-measure stick offset.
  if (typeof updateHeaderStick === 'function') updateHeaderStick();
  // Studios mode — render fresh on tab switch. Function defined
  // later in the file; safe-call to handle early init paths where
  // it might not be available yet.
  if (STATE.activeMode === 'studios' && typeof renderStudioGrid === 'function') {
    renderStudioGrid();
  }
}

async function setMatureOn(nextOn) {
  const changed = await stateSetMatureOn(nextOn);
  if (!changed) return;
  syncMaturePill();
  // Re-render both grids: Mature section in Genres appears/disappears,
  // and mature show anchors appear/disappear in the Shows grid.
  // The fade wraps both renders since they're a single logical
  // change from the user's view.
  fadeSwapGrid(() => {
    renderGenreGrid();
    renderGrid();
  });
  syncViewHints();
}

function syncMaturePill() {
  const pill = document.getElementById('mature-toggle');
  if (!pill) return;
  pill.classList.toggle('is-on', STATE.matureOn);
  pill.setAttribute('aria-pressed', STATE.matureOn ? 'true' : 'false');
  const label = pill.querySelector('.mature-pill-label');
  if (label) label.textContent = `Mature: ${STATE.matureOn ? 'on' : 'off'}`;
}

async function setView(nextView) {
  const changed = await stateSetView(nextView);
  if (!changed) return;
  syncViewButtons();
  fadeSwapGrid(() => renderGrid());
}

function syncViewButtons() {
  const buttons = document.querySelectorAll('.view-btn');
  for (const btn of buttons) {
    const isActive = btn.dataset.view === STATE.view;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
}

// Recompute the per-view tile counts shown in the Mainstream/All/Deep
// Cuts button hints. Reflects current mature + service filter state,
// so the user sees how many tiles each view will produce *given their
// current filter selection*. "top 3 picks · 12 on Netflix" beats
// "top 3 picks · 54 tiles" when Netflix is the active filter.
function syncViewHints() {
  const filterSize = STATE.serviceFilter.size;
  const filterSuffix = filterSize > 0
    ? ' on ' + Array.from(STATE.serviceFilter)
        .map(id => STREAMING_SERVICE_BY_ID[id]?.shortLabel || id)
        .join('/')
    : ' tiles';

  const hints = {
    mainstream: { label: 'top 5', count: countAnchorsForView('mainstream') },
    all:        { label: 'all',   count: countAnchorsForView('all') },
    deepcuts:   { label: 'rare',  count: countAnchorsForView('deepcuts') },
  };

  for (const [key, { label, count }] of Object.entries(hints)) {
    const el = document.querySelector(`[data-view-hint="${key}"]`);
    if (el) el.textContent = `${label} · ${count}${filterSuffix}`;
  }
}

// saveSurveyShapes / saveSurveyTagShapes — persistence now happens
// inside survey-state.js's recordShowTap / recordTagTap and
// clearActiveModeTaps. No external callers remain.

// Union of every AL ID we need cover art for: show anchors + genre
// representative shows. Genre tiles reuse the same aniListBridgeCache
// path so there's a single hydration pipeline.
function allMediaAniListIds() {
  const ids = new Set();
  for (const a of SURVEY_ANCHORS) ids.add(a.aniListId);
  for (const g of SURVEY_GENRE_ANCHORS) ids.add(g.representativeAniListId);
  return ids;
}

async function fetchMissingMedia() {
  const missing = [];
  for (const id of allMediaAniListIds()) {
    if (!STATE.tileMedia[id]) missing.push(id);
  }
  if (missing.length === 0) return;
  try {
    await chrome.runtime.sendMessage({
      type: 'survey:fetchTileMedia',
      aniListIds: missing,
    });
    // The worker writes to aniListBridgeCache; storage.onChanged below
    // will re-render the tiles when the data lands.
  } catch (err) {
    console.warn('[crsmart-survey] fetch tile media failed', err);
  }
}

// ── Rendering ───────────────────────────────────────────────────
function archetypeOrder() {
  // Preserve the order anchors were declared in. SURVEY_ANCHORS is
  // already grouped by archetype; pull the unique archetype IDs from
  // the *visible* set so empty sections (where every anchor was
  // filtered out) don't render as bare headers.
  const seen = new Set();
  const order = [];
  for (const a of visibleAnchors()) {
    if (seen.has(a.archetypeId)) continue;
    seen.add(a.archetypeId);
    order.push(a.archetypeId);
  }
  return order;
}

function tileStateFor(aniListId) {
  return STATE.shapes[aniListId]?.state || 'skip';
}

// buildServiceBadge / buildTierBadge moved to tile.js — imported above.

function renderTile(anchor) {
  const media = STATE.tileMedia[anchor.aniListId];
  const stateName = tileStateFor(anchor.aniListId);
  const titleText = (media?.title?.english || media?.title?.romaji || anchor.displayName);
  const coverUrl = media?.coverImage?.large || media?.coverImage?.medium || null;
  const services = servicesForAnchor(anchor);
  // is-loading triggers the shimmer overlay until the bridge cache
  // resolves the AL ID. storage.onChanged fires renderGrid() when media
  // lands, naturally dropping the class.
  const isLoading = !media;

  const tile = document.createElement('div');
  tile.className = `tile state-${stateName}${isLoading ? ' is-loading' : ''}`;
  tile.dataset.aniListId = String(anchor.aniListId);
  tile.dataset.archetypeId = anchor.archetypeId;
  // Compose tile tooltip: title + services so the user can see service
  // info on hover even where the stripe is too thin to read.
  tile.title = `${titleText} · ${services.map(id => STREAMING_SERVICE_BY_ID[id]?.label || id).join(', ')}`;

  const cover = document.createElement('div');
  cover.className = 'tile-cover';
  if (coverUrl) cover.style.backgroundImage = `url("${coverUrl}")`;

  const serviceBadge = buildServiceBadge(services);
  if (serviceBadge) cover.appendChild(serviceBadge);

  const tierBadge = buildTierBadge(anchor);
  if (tierBadge) cover.appendChild(tierBadge);

  const badge = document.createElement('span');
  badge.className = 'tile-state-badge';
  badge.textContent = stateName === 'loved' ? '❤' : stateName === 'disliked' ? '✕' : '';
  cover.appendChild(badge);

  const title = document.createElement('div');
  title.className = 'tile-title';
  title.textContent = titleText;

  tile.appendChild(cover);
  tile.appendChild(title);

  // Click handling is delegated at the row level — see attachRowClick
  // — so cloned tiles in the infinite-loop scroll work without their
  // own listeners.
  return tile;
}

// Fade-swap helper — three phases:
//   1. Rewind: any drifted/dragged loop rows smoothly transition
//      their track back to the natural start position. The user
//      sees the rows "reset" before the page fades out.
//   2. Fade out: survey-main animates to opacity 0.
//   3. Swap + fade in: DOM swap behind opacity 0; class drop
//      snaps survey-main back to opacity 1 so the per-section
//      stagger handles the visible re-entry.
//
// Re-entry safety: each call increments swapToken; the post-rewind
// and post-fade-out awaits check if their token still matches the
// latest. State mutations from intermediate swaps still apply
// synchronously on click, so the latest renderX call paints the
// up-to-date state. Earlier swaps' callbacks bail.
//
// Honors prefers-reduced-motion: short-circuits to direct call.
const REWIND_DURATION_MS = 200;
const FADE_OUT_DURATION_MS = 140;
let swapToken = 0;
async function fadeSwapGrid(fn) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    fn();
    return;
  }
  const main = document.getElementById('survey-main');
  if (!main) { fn(); return; }
  const myToken = ++swapToken;

  // Phase 1: rewind any drifted loop rows back to their start
  // position. Visible (page is at full opacity here) so the user
  // perceives the rows "scrolling back" before the swap.
  rewindLoopRowsToStart();
  await new Promise(r => setTimeout(r, REWIND_DURATION_MS));
  if (myToken !== swapToken) return;

  // Phase 2: fade out. Restart the animation if a previous swap's
  // is-swapping class is still there.
  if (main.classList.contains('is-swapping')) {
    main.classList.remove('is-swapping');
    void main.offsetWidth;
  }
  main.classList.add('is-swapping');
  await new Promise(r => setTimeout(r, FADE_OUT_DURATION_MS));
  if (myToken !== swapToken) return;

  // Phase 3: swap behind opacity 0, then drop the class so
  // survey-main snaps back to 1 and the section stagger handles
  // the visible re-entry.
  fn();
  void main.offsetWidth;
  main.classList.remove('is-swapping');
}

// Smoothly rewind every active loop row's track back to its
// initial position (translate3d(-originalContentWidth, 0, 0)).
// Stops the row's idle drift / momentum / motion-dir timers
// first via _loopTeardown so the inline transition isn't fighting
// per-frame transform writes from the drift loop. Fire-and-forget;
// fadeSwapGrid awaits a parallel timer matching REWIND_DURATION_MS.
function rewindLoopRowsToStart() {
  const rows = document.querySelectorAll('.tile-grid-row.is-loop');
  for (const row of rows) {
    const track = row._loopTrack;
    const ocw = row._loopOriginalContentWidth;
    if (!track || ocw == null) continue;
    // Stop drift / momentum / idle timer so they don't write the
    // transform underneath the rewind transition.
    if (typeof row._loopTeardown === 'function') row._loopTeardown();
    track.style.transition = `transform ${REWIND_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0.28, 1)`;
    row._loopPos = ocw;
    track.style.transform = `translate3d(${-ocw}px, 0, 0)`;
  }
}

// ── Drag-scroll + momentum + elastic edges + slim progress + idle drift
// ──────────────────────────────────────────────────────────────
// Constants + shared mechanics (click suppressor, motion-dir setter,
// idle scheduler) live in row-interaction.js so the scroll-mode and
// loop-mode enhancers below share the same source of truth. Tweaks
// to drag feel happen in one file.

// Apply pointer-drag scroll, momentum decay, elastic edge bounce,
// progress-bar tracking, and idle auto-drift to a horizontal scroll
// row. Idempotent — sets a data flag so re-rendered rows aren't
// double-wired (renderGrid clears the grid each call, so each row
// is fresh anyway, but the guard is cheap).
function enhanceScrollRow(rowEl, progressFillEl) {
  if (!rowEl || rowEl.dataset.dragWired === '1') return;
  rowEl.dataset.dragWired = '1';

  // Drag + momentum is user-initiated, OK under reduced-motion.
  // Auto-drift is decorative — skip it entirely. Elastic snap-back
  // is instant (no transition) so the animation isn't visible.
  const reduceMotion = prefersReducedMotion();

  let isDown = false;
  let isDrag = false;
  let startX = 0;
  let startScrollLeft = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let momentumRAF = 0;
  let driftRAF = 0;
  let isDrifting = false;
  let idleTimer = 0;
  let elasticOffset = 0;

  function maxScroll() {
    return rowEl.scrollWidth - rowEl.clientWidth;
  }

  // Compute a wrapped scrollLeft target for loop rows. Returns the
  // unchanged input for non-loop rows or rows that haven't been
  // measured yet. The caller assigns the returned value as
  // rowEl.scrollLeft — the browser then only commits the post-wrap
  // value, so the pre-wrap (edge) state is never painted.
  function maybeWrapTarget(target) {
    if (!rowEl.classList.contains('is-loop')) return target;
    const cloneRegionWidth = rowEl._loopCloneRegionWidth;
    const originalContentWidth = rowEl._loopOriginalContentWidth;
    const tileWidth = rowEl._loopTileWidth;
    if (!cloneRegionWidth || !originalContentWidth || !tileWidth) return target;
    const buffer = tileWidth * 0.5;
    // While loops handle huge velocities that could skip past one
    // wrap-cycle in a single frame.
    while (target < buffer) target += originalContentWidth;
    while (target > cloneRegionWidth + originalContentWidth - buffer) {
      target -= originalContentWidth;
    }
    return target;
  }

  function updateProgress() {
    if (rowEl.classList.contains('is-loop')) return; // applyLoopTransform handles loop progress
    if (!progressFillEl) return;
    const m = maxScroll();
    if (m <= 0) {
      progressFillEl.style.width = '100%';
      return;
    }
    const ratio = Math.max(0, Math.min(1, rowEl.scrollLeft / m));
    progressFillEl.style.width = `${ratio * 100}%`;
  }

  function applyElastic(amount) {
    elasticOffset = amount;
    rowEl.style.transform = amount === 0 ? '' : `translateX(${amount}px)`;
  }

  function snapElasticBack() {
    if (elasticOffset === 0) return;
    if (reduceMotion) {
      // Instant clamp — no spring animation for motion-sensitive users.
      elasticOffset = 0;
      rowEl.style.transform = '';
      return;
    }
    rowEl.style.transition = `transform ${ELASTIC_BACK_MS}ms cubic-bezier(0.34, 1.4, 0.64, 1)`;
    elasticOffset = 0;
    rowEl.style.transform = '';
    setTimeout(() => { rowEl.style.transition = ''; }, ELASTIC_BACK_MS + 30);
  }

  function stopMomentum() {
    if (momentumRAF) {
      cancelAnimationFrame(momentumRAF);
      momentumRAF = 0;
    }
  }

  function momentumStep() {
    if (Math.abs(velocity) < MIN_VELOCITY) {
      momentumRAF = 0;
      return;
    }
    const m = maxScroll();
    const isLoop = rowEl.classList.contains('is-loop');
    let target = rowEl.scrollLeft - velocity;
    if (isLoop) {
      // Pre-wrap so the visible scroll position is always inside the
      // safe zone. Browser never paints the pre-wrap (edge) value.
      target = maybeWrapTarget(target);
      rowEl.scrollLeft = target;
    } else {
      rowEl.scrollLeft = target;
      // Non-loop rows: clip momentum at edges (no wrap).
      if (rowEl.scrollLeft <= 0 || rowEl.scrollLeft >= m) {
        momentumRAF = 0;
        return;
      }
    }
    velocity *= MOMENTUM_DECAY;
    momentumRAF = requestAnimationFrame(momentumStep);
  }

  function stopDrift() {
    if (driftRAF) {
      cancelAnimationFrame(driftRAF);
      driftRAF = 0;
    }
    isDrifting = false;
  }

  function startDrift() {
    stopDrift();
    // Loop rows have their own drift in enhanceLoopRow.
    if (rowEl.classList.contains('is-loop')) return;
    isDrifting = true;
    function step() {
      // Bail if the row converted to loop mode after we started drifting.
      if (rowEl.classList.contains('is-loop')) {
        isDrifting = false;
        driftRAF = 0;
        return;
      }
      const m = maxScroll();
      if (m <= 0 || rowEl.scrollLeft >= m - 1) {
        isDrifting = false;
        driftRAF = 0;
        return;
      }
      rowEl.scrollLeft += DRIFT_PX_PER_FRAME;
      driftRAF = requestAnimationFrame(step);
    }
    driftRAF = requestAnimationFrame(step);
  }

  function resetIdle() {
    stopDrift();
    // Auto-drift is decorative spontaneous motion — skip for users
    // who've requested reduced motion.
    if (reduceMotion) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(startDrift, IDLE_DRIFT_DELAY_MS);
  }

  // ── Pointer events ──────────────────────────────────────────
  // IMPORTANT: setPointerCapture only fires AFTER drag is confirmed,
  // not on pointerdown. Capturing on pointerdown can cause Chrome to
  // redirect the synthetic click event from the tile to the captured
  // row, breaking the tap-to-cycle interaction. Capturing later means
  // taps (no movement) keep their natural click target on the tile.
  rowEl.addEventListener('pointerdown', (e) => {
    // Loop rows have their own transform-based handler — bail.
    if (rowEl.classList.contains('is-loop')) return;
    // Mouse: only primary button. Touch/pen: always.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    isDown = true;
    isDrag = false;
    startX = e.clientX;
    lastX = e.clientX;
    lastTime = performance.now();
    startScrollLeft = rowEl.scrollLeft;
    velocity = 0;
    stopMomentum();
    stopDrift();
    rowEl.style.transition = '';
  });

  rowEl.addEventListener('pointermove', (e) => {
    if (rowEl.classList.contains('is-loop')) return;
    if (!isDown) return;
    const dx = e.clientX - startX;

    if (!isDrag && Math.abs(dx) > DRAG_THRESHOLD_PX) {
      isDrag = true;
      rowEl.classList.add('is-dragging');
      // Now that this is definitely a drag, capture the pointer so
      // continued movement outside the row still routes to us.
      try { rowEl.setPointerCapture(e.pointerId); } catch (_) {}
    }

    if (isDrag) {
      e.preventDefault();
      const m = maxScroll();
      let target = startScrollLeft - dx;
      const isLoop = rowEl.classList.contains('is-loop');
      if (isLoop) {
        // Pre-wrap the target BEFORE assigning scrollLeft so the
        // browser never paints the edge frame. If the wrap shifted
        // the target, also shift startScrollLeft by the same amount
        // so subsequent dx-based math stays consistent.
        const wrapped = maybeWrapTarget(target);
        if (wrapped !== target) {
          startScrollLeft += wrapped - target;
          target = wrapped;
        }
        rowEl.scrollLeft = target;
      } else if (m <= 0) {
        // Nothing to scroll — pure elastic feel both directions
        applyElastic(dx * ELASTIC_RUBBER_FACTOR);
      } else if (target < 0) {
        rowEl.scrollLeft = 0;
        applyElastic(-target * ELASTIC_RUBBER_FACTOR);
      } else if (target > m) {
        rowEl.scrollLeft = m;
        applyElastic(-(target - m) * ELASTIC_RUBBER_FACTOR);
      } else {
        rowEl.scrollLeft = target;
        if (elasticOffset !== 0) applyElastic(0);
      }

      // Track velocity over the most recent move sample
      const now = performance.now();
      const dt = now - lastTime;
      if (dt > 0) {
        // Convert px-per-ms to px-per-frame (~16ms target).
        velocity = ((e.clientX - lastX) / dt) * 16;
      }
      lastX = e.clientX;
      lastTime = now;
    }
  });

  function endPointer(e) {
    if (rowEl.classList.contains('is-loop')) return;
    if (!isDown) return;
    isDown = false;
    try { rowEl.releasePointerCapture(e.pointerId); } catch (_) {}

    if (isDrag) {
      rowEl.classList.remove('is-dragging');
      // Tell the click suppressor that the upcoming click is a drag-end,
      // not a tap. Cleared on a microtask so a follow-up real click works.
      markDragEnded(rowEl);

      if (elasticOffset !== 0) snapElasticBack();
      momentumRAF = requestAnimationFrame(momentumStep);
    }
    isDrag = false;
    resetIdle();
  }

  rowEl.addEventListener('pointerup', endPointer);
  rowEl.addEventListener('pointercancel', endPointer);

  // Capture-phase click suppressor — eats the click after a drag so
  // onTileClick doesn't fire on the tile that happened to be under
  // the pointer.
  attachClickSuppressor(rowEl);

  // Native scroll (wheel/keyboard/trackpad) keeps the progress in sync
  // and resets the idle timer (but ignore drift-triggered scroll events).
  rowEl.addEventListener('scroll', () => {
    if (rowEl.classList.contains('is-loop')) return;
    updateProgress();
    if (!isDrifting) resetIdle();
  });

  // Wheel/touch interaction halts drift and re-arms the idle timer.
  rowEl.addEventListener('wheel', () => {
    if (rowEl.classList.contains('is-loop')) return;
    stopDrift();
    resetIdle();
  }, { passive: true });

  rowEl.addEventListener('mouseenter', () => {
    if (rowEl.classList.contains('is-loop')) return;
    stopDrift();
  });
  rowEl.addEventListener('mouseleave', () => {
    if (rowEl.classList.contains('is-loop')) return;
    resetIdle();
  });

  // Initial state
  updateProgress();
  resetIdle();
}

// Cursor-following 3D tilt on tile hover. Delegated at the row level
// (one mousemove listener per row, 18 rows total) instead of per-tile
// (~265 listeners) — same UX, way less binding.
//
// Sets --tilt-x / --tilt-y CSS vars on the hovered tile based on
// cursor position relative to tile center. The tile's transform
// reads those vars to compose lift+scale+rotate. Suppressed during
// .is-dragging so the kinetic scroll isn't disturbed.
const TILT_MAX_DEG = 4;
function attachTileTilt(rowEl) {
  if (!rowEl || rowEl.dataset.tiltWired === '1') return;
  rowEl.dataset.tiltWired = '1';

  let activeTile = null;
  let raf = 0;

  function clearActive() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (activeTile) {
      activeTile.classList.remove('is-tilting');
      activeTile.style.removeProperty('--tilt-x');
      activeTile.style.removeProperty('--tilt-y');
      activeTile = null;
    }
  }

  rowEl.addEventListener('mousemove', (e) => {
    if (rowEl.classList.contains('is-dragging')) {
      clearActive();
      return;
    }
    const tile = e.target.closest ? e.target.closest('.tile') : null;
    if (!tile || !rowEl.contains(tile)) {
      clearActive();
      return;
    }
    if (tile !== activeTile) {
      if (activeTile) {
        activeTile.classList.remove('is-tilting');
        activeTile.style.removeProperty('--tilt-x');
        activeTile.style.removeProperty('--tilt-y');
      }
      activeTile = tile;
      tile.classList.add('is-tilting');
    }
    const rect = tile.getBoundingClientRect();
    const dx = ((e.clientX - rect.left) / rect.width) * 2 - 1;   // -1..1
    const dy = ((e.clientY - rect.top) / rect.height) * 2 - 1;   // -1..1
    const tiltX = -dy * TILT_MAX_DEG; // rotateX
    const tiltY = dx * TILT_MAX_DEG;  // rotateY
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (activeTile === tile) {
        tile.style.setProperty('--tilt-x', `${tiltX}deg`);
        tile.style.setProperty('--tilt-y', `${tiltY}deg`);
      }
    });
  });

  rowEl.addEventListener('mouseleave', clearActive);
}

// ── Row-level click delegation ──────────────────────────────────
// One click listener per row instead of one per tile. Necessary for
// the infinite-loop carousel since cloned tiles don't carry their own
// addEventListener bindings (cloneNode skips listeners). The handler
// dispatches to onTileClick / onGenreTileClick based on which dataset
// attribute is present on the closest tile ancestor of the click.
//
// Drag suppression: enhanceScrollRow sets data-drag-just-ended on the
// row when the gesture was a drag. We bail out then so a drag-release
// doesn't accidentally cycle a tile's state.
function attachRowClick(rowEl, kind /* 'show' | 'genre' */) {
  if (!rowEl || rowEl.dataset.clickWired === '1') return;
  rowEl.dataset.clickWired = '1';
  rowEl.addEventListener('click', (e) => {
    if (rowEl.dataset.dragJustEnded === '1') {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const tile = e.target.closest ? e.target.closest('.tile') : null;
    if (!tile || !rowEl.contains(tile)) return;
    if (kind === 'show') {
      const id = parseInt(tile.dataset.aniListId, 10);
      if (!Number.isNaN(id)) onTileClick(id, tile);
    } else {
      const tag = tile.dataset.tag;
      if (tag) onGenreTileClick(tag, tile);
    }
  });
}

// ── Infinite-loop carousel (translate3d track) ─────────────────
// Loop rows use a transform-based track: a single inner element holds
// THREE concatenated copies of the original tiles, and JS writes
// `transform: translate3d(-pos, 0, 0)` on every drag/momentum/drift
// frame. Pos is kept in [originalContentWidth, 2*originalContentWidth)
// — the middle copy. When pos drifts outside that band we wrap by
// exactly +/- originalContentWidth. The wrap is INVISIBLE because the
// three copies are identical: shifting the track by one copy-width
// puts the same visible tiles at the same viewport positions.
//
// Why translate3d, not scrollLeft? scrollLeft has two limitations:
// (1) browser clamps to [0, max], so wrap requires +/- originalContent
// Width which is large and can show the clone-edge for one paint
// frame before the wrap commits, and (2) scroll events fire AFTER
// paint, leaving a one-frame visible teleport. A translate-based
// track wraps in JS in the same frame as the position update — no
// scroll events, no edge clamp, no paint flash.

function makeRowInfinite(rowEl) {
  if (!rowEl || rowEl.dataset.loopWired === '1') return;

  // Defer measurement until the row actually has a non-zero box.
  //
  // Genres-mode tab-content is `hidden` at boot, so a synchronous
  // rAF measurement returns clientWidth=0 / scrollWidth=0 — the
  // resulting ocw was 0 and wrapPos's `while` loops degenerated
  // into infinite spins on the first drift frame after tab switch
  // (the "stuck/jittering" symptom on Genres rows).
  //
  // ResizeObserver fires once the row gains a non-zero box (either
  // immediately on a visible row, or after the tab unhides), so the
  // wiring waits for real layout instead of guessing. Keeps observing
  // until convertRowToLoop actually succeeds (it may bail if the
  // measurement still came back zero).
  const ro = new ResizeObserver(() => {
    // If the row was removed from the DOM before wiring succeeded
    // (e.g. a filter change replaced it), bail and disconnect so
    // we're not holding a reference to a detached node.
    if (!rowEl.isConnected) {
      ro.disconnect();
      return;
    }
    if (rowEl.dataset.loopWired === '1') {
      ro.disconnect();
      return;
    }
    if (rowEl.clientWidth === 0) return;
    requestAnimationFrame(() => {
      if (rowEl.dataset.loopWired === '1') return;
      convertRowToLoop(rowEl);
      if (rowEl.dataset.loopWired === '1') ro.disconnect();
    });
  });
  ro.observe(rowEl);
  // Stash the observer so tearDownRow can disconnect it on
  // grid replace.
  rowEl._loopRO = ro;
}

function convertRowToLoop(rowEl) {
  if (rowEl.dataset.loopWired === '1') return;

  const originals = Array.from(rowEl.querySelectorAll('.tile'));
  // Need at least 3 tiles to clone safely; below that the visual
  // wrap looks awkward. Above the threshold we always loop — even
  // sections that fit without scrolling get the endless-cycle +
  // idle-drift behavior, so short genre sections (Demographics with
  // 5 tiles) feel alive like the Shows-mode All view.
  if (originals.length < 3) return;

  // Build the track. The wrap math (pos kept in [ocw, 2*ocw) on a
  // 3-copy track) is only safe when one copy is at least as wide as
  // the viewport — otherwise pos at 2*ocw - epsilon shows the visible
  // window extending past 3*ocw with a blank stripe at the right
  // edge (the "stuck/jittering" symptom on short rows that fit in
  // the viewport).
  //
  // Fix: if a single pass through the originals produces a content
  // unit narrower than the viewport, repeat the originals as clones
  // INSIDE the unit until the unit-width exceeds clientWidth + buffer.
  // Then 3 copies of that fattened unit gives us safe wrap room at
  // any viewport size.
  const track = document.createElement('div');
  track.className = 'tile-grid-track';
  for (const tile of originals) {
    track.appendChild(tile);
  }
  rowEl.appendChild(track);

  const VIEWPORT_BUFFER = 100;
  const targetUnitWidth = rowEl.clientWidth + VIEWPORT_BUFFER;
  // Cap the unit-fattening loop so a tiny row (or a measurement
  // glitch returning 0) can't blow up DOM size.
  const MAX_UNIT_REPEATS = 6;
  let unitRepeats = 1;
  while (track.scrollWidth < targetUnitWidth && unitRepeats < MAX_UNIT_REPEATS) {
    for (const orig of originals) {
      const clone = orig.cloneNode(true);
      clone.classList.add('is-clone');
      track.appendChild(clone);
    }
    unitRepeats++;
  }
  // Snapshot the children that make up one full unit so subsequent
  // duplications copy the right slice.
  const unitTiles = Array.from(track.children);

  // Append two more copies of the unit as clones — total 3 copies.
  for (let copy = 0; copy < 2; copy++) {
    for (const t of unitTiles) {
      const clone = t.cloneNode(true);
      clone.classList.add('is-clone');
      track.appendChild(clone);
    }
  }

  // Measure the real repeat period as the distance between the first
  // tile of unit-1 and the first tile of unit-2. Using the per-tile
  // x-position gives a wrap that aligns exactly, so dragging through
  // many wraps doesn't accumulate sub-pixel drift visible as
  // "stuck/jittering" on small rows.
  const tilesPerUnit = unitTiles.length;
  const firstTileRect = track.children[0].getBoundingClientRect();
  const unit2FirstTileRect = track.children[tilesPerUnit].getBoundingClientRect();
  const measuredPeriod = unit2FirstTileRect.left - firstTileRect.left;

  // Defensive bail: if measurement still came back 0 (display:none
  // somewhere in the parent chain, browser quirk, etc.), undo the
  // track wrapping and leave the row in its pre-loop state. Don't
  // mark as loopWired so a later makeRowInfinite call can retry
  // when the row actually has a layout.
  if (measuredPeriod <= 0) {
    for (const tile of originals) rowEl.appendChild(tile);
    track.remove();
    return;
  }

  rowEl.classList.add('is-loop');
  rowEl.dataset.loopWired = '1';

  const originalContentWidth = measuredPeriod;

  // Stash dimensions for the loop-mode handlers.
  rowEl._loopTrack = track;
  rowEl._loopOriginalContentWidth = originalContentWidth;
  // Pos starts at the middle copy — gives equal headroom in both
  // directions before any wrap is needed.
  rowEl._loopPos = originalContentWidth;
  applyLoopTransform(rowEl);

  // Wire the transform-based interaction handlers AFTER the loop
  // structure exists. enhanceScrollRow's existing scrollLeft logic is
  // a no-op on loop rows (it returns early when .is-loop is set).
  enhanceLoopRow(rowEl);
}

// Apply the current pos as a translate3d on the track.
function applyLoopTransform(rowEl) {
  const track = rowEl._loopTrack;
  const pos = rowEl._loopPos;
  if (!track || pos == null) return;
  track.style.transform = `translate3d(${-pos}px, 0, 0)`;
  // Mirror the visual position to the slim progress bar — show
  // progress through one copy of originals.
  const ocw = rowEl._loopOriginalContentWidth;
  if (ocw) {
    const fill = rowEl.parentElement
      ? rowEl.parentElement.querySelector('.tile-grid-progress-fill')
      : null;
    if (fill) {
      const visualPos = ((pos % ocw) + ocw) % ocw;
      const ratio = Math.max(0, Math.min(1, visualPos / ocw));
      fill.style.width = `${ratio * 100}%`;
    }
  }
}

// Loop-mode interaction handler — drag, momentum, drift, wheel all
// update rowEl._loopPos and write the transform synchronously. Pos
// is kept in [originalContentWidth, 2*originalContentWidth) by an
// exact +/- originalContentWidth wrap that's visually invisible (three
// identical copies in the track).
function enhanceLoopRow(rowEl) {
  if (rowEl.dataset.loopHandlersWired === '1') return;
  rowEl.dataset.loopHandlersWired = '1';

  const reduceMotion = prefersReducedMotion();

  let isDown = false;
  let isDrag = false;
  let startX = 0;
  let startPos = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let momentumRAF = 0;
  let driftRAF = 0;
  let isDrifting = false;
  let idleTimer = 0;

  // Direction-aware edge overlay: write -1 / 0 / +1 to the rowframe's
  // --motion-dir CSS var so the leading edge brightens and the
  // trailing edge dims as content slides through the row.
  // createMotionDirSetter owns the auto-reset timer; teardown stops it.
  const motionDir = createMotionDirSetter(rowEl);
  const setMotionDir = motionDir.setMotionDir;

  function ocw() { return rowEl._loopOriginalContentWidth || 1; }

  // Wrap pos to [originalContentWidth, 2*originalContentWidth) so the
  // viewport always renders from the middle copy. Wraps by exactly
  // originalContentWidth — invisible because the 3 copies are
  // identical. While loops handle huge velocities that could skip
  // a whole copy in one frame.
  function wrapPos(p) {
    const w = ocw();
    while (p < w) p += w;
    while (p >= 2 * w) p -= w;
    return p;
  }

  function setPos(p) {
    rowEl._loopPos = wrapPos(p);
    applyLoopTransform(rowEl);
  }

  function stopMomentum() {
    if (momentumRAF) {
      cancelAnimationFrame(momentumRAF);
      momentumRAF = 0;
    }
  }

  function momentumStep() {
    // Bail when the row has been removed from the DOM (filter swap,
    // mode switch). Without this guard the rAF chain keeps spinning
    // against a detached node forever — every renderGrid call
    // accumulated more orphaned schedulers, draining frame budget.
    if (!rowEl.isConnected || Math.abs(velocity) < MIN_VELOCITY) {
      momentumRAF = 0;
      return;
    }
    setPos(rowEl._loopPos - velocity);
    // velocity > 0 (last drag was rightward) → tiles slide right → +1.
    setMotionDir(velocity > 0 ? 1 : -1);
    velocity *= MOMENTUM_DECAY;
    momentumRAF = requestAnimationFrame(momentumStep);
  }

  function stopDrift() {
    if (driftRAF) {
      cancelAnimationFrame(driftRAF);
      driftRAF = 0;
    }
    isDrifting = false;
  }

  function startDrift() {
    stopDrift();
    isDrifting = true;
    // Drift moves pos forward → tiles slide left on screen → -1.
    setMotionDir(-1);
    function step() {
      // Same isConnected guard as momentumStep — kills the rAF chain
      // when the row is replaced so we don't leak schedulers.
      if (!rowEl.isConnected) {
        isDrifting = false;
        driftRAF = 0;
        return;
      }
      setPos(rowEl._loopPos + DRIFT_PX_PER_FRAME);
      driftRAF = requestAnimationFrame(step);
    }
    driftRAF = requestAnimationFrame(step);
  }

  function resetIdle() {
    stopDrift();
    if (reduceMotion) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(startDrift, IDLE_DRIFT_DELAY_MS);
  }

  // ── Pointer drag ──────────────────────────────────────────
  rowEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    isDown = true;
    isDrag = false;
    startX = e.clientX;
    lastX = e.clientX;
    lastTime = performance.now();
    startPos = rowEl._loopPos;
    velocity = 0;
    stopMomentum();
    stopDrift();
  });

  rowEl.addEventListener('pointermove', (e) => {
    if (!isDown) return;
    const dx = e.clientX - startX;
    if (!isDrag && Math.abs(dx) > DRAG_THRESHOLD_PX) {
      isDrag = true;
      rowEl.classList.add('is-dragging');
      try { rowEl.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (isDrag) {
      e.preventDefault();
      // Drag right (dx > 0) should reveal earlier content — pos
      // decreases, track shifts right visually.
      setPos(startPos - dx);
      // dx > 0 (drag-right) → tiles slide right → +1.
      // dx < 0 (drag-left)  → tiles slide left  → -1.
      const lastDx = e.clientX - lastX;
      if (Math.abs(lastDx) > 0.5) {
        setMotionDir(lastDx > 0 ? 1 : -1);
      }
      const now = performance.now();
      const dt = now - lastTime;
      if (dt > 0) {
        velocity = ((e.clientX - lastX) / dt) * 16;
      }
      lastX = e.clientX;
      lastTime = now;
    }
  });

  function endPointer(e) {
    if (!isDown) return;
    isDown = false;
    try { rowEl.releasePointerCapture(e.pointerId); } catch (_) {}
    if (isDrag) {
      rowEl.classList.remove('is-dragging');
      markDragEnded(rowEl);
      momentumRAF = requestAnimationFrame(momentumStep);
    }
    isDrag = false;
    resetIdle();
  }
  rowEl.addEventListener('pointerup', endPointer);
  rowEl.addEventListener('pointercancel', endPointer);

  // Click suppression after drag — shared with enhanceScrollRow.
  attachClickSuppressor(rowEl);

  // ── Wheel — manual handling ───────────────────────────────
  // Native scroll-into-loop-row would do nothing (overflow:hidden,
  // no scrollLeft), so wheel events need to write to pos directly.
  // We capture horizontal wheel deltas + shift+vertical (common
  // browser convention for horizontal scroll on vertical wheels).
  rowEl.addEventListener('wheel', (e) => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey
      ? (e.deltaX || e.deltaY)
      : 0;
    if (dx === 0) return; // pure vertical, let page scroll
    e.preventDefault();
    setPos(rowEl._loopPos + dx);
    // dx > 0 (scroll right via wheel) → pos increases → tiles slide left → -1.
    setMotionDir(dx > 0 ? -1 : 1);
    stopDrift();
    resetIdle();
  }, { passive: false });

  rowEl.addEventListener('mouseenter', stopDrift);
  rowEl.addEventListener('mouseleave', resetIdle);

  // Kick off drift immediately on row setup instead of waiting the
  // IDLE_DRIFT_DELAY_MS grace period. The idle delay is for AFTER
  // an interaction (drag/wheel/tap), where letting the user re-orient
  // before drift resumes feels right. On initial render the user
  // hasn't done anything yet, so the row should be alive from frame
  // one. Reduced-motion users still skip drift entirely (resetIdle
  // bails on the matchMedia check inside startDrift's wrapper).
  if (reduceMotion) {
    resetIdle();
  } else {
    startDrift();
  }

  // Teardown hook — tearDownRow calls this before grid replacement
  // so the rAF chain + idle timer + motion-reset timer all stop when
  // the row leaves the DOM. Without this, every filter swap would
  // strand the previous render's drift schedulers in active rotation.
  rowEl._loopTeardown = () => {
    stopDrift();
    stopMomentum();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    motionDir.teardown();
  };
}

// syncTileVisuals moved to tile.js as syncCloneVisuals — imported above.
const syncTileVisuals = syncCloneVisuals;

function renderGrid() {
  const grid = document.getElementById('tile-grid');
  // Tear down rows before replacing so the row enhancers (drift rAF,
  // momentum rAF, ResizeObserver, idle/motion timers) all release
  // their references to the soon-to-be-detached rows.
  clearGridContent(grid);
  const order = archetypeOrder();
  const visible = visibleAnchors();

  // Empty-state: filter combination produces no shows. Tell the user
  // why instead of showing an empty page.
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tile-grid-empty';
    if (STATE.serviceFilter.size > 0) {
      const labels = Array.from(STATE.serviceFilter)
        .map(id => STREAMING_SERVICE_BY_ID[id]?.shortLabel || id)
        .join(' / ');
      empty.textContent = `No shows in this view on ${labels}. Try toggling another service or switching to All.`;
    } else {
      empty.textContent = 'No shows match the current filters.';
    }
    grid.appendChild(empty);
    updateConfidenceBadge();
    return;
  }

  // Build all sections in a DocumentFragment first, append once at
  // the end, then wire enhancements after the rows are attached. One
  // reflow instead of N. Wirings (drag/tilt/click/loop) need rows
  // in the DOM so observers/listeners see real layout, hence the
  // two-pass: build → attach → wire.
  const frag = document.createDocumentFragment();
  const wirings = [];
  let sectionIdx = 0;
  for (const archId of order) {
    const anchorsForArch = visible.filter(a => a.archetypeId === archId);
    if (!anchorsForArch.length) continue;
    const tappedCount = anchorsForArch.filter(a => tileStateFor(a.aniListId) !== 'skip').length;
    const section = buildSectionShell({
      kind: 'archetype',
      id: archId,
      accent: archAccent(archId),
      headlineText: ARCHETYPE_LABEL_BY_ID[archId] || archId,
      flavorText: archFlavor(archId),
      countText: `${tappedCount} of ${anchorsForArch.length} tapped`,
      tiles: anchorsForArch.map(renderTile),
      idx: sectionIdx++,
    });
    frag.appendChild(section.root);
    wirings.push({ row: section.row, progressFill: section.progressFill, kind: 'show' });
  }
  grid.appendChild(frag);
  for (const w of wirings) {
    enhanceScrollRow(w.row, w.progressFill);
    attachTileTilt(w.row);
    attachRowClick(w.row, w.kind);
    makeRowInfinite(w.row);
  }

  updateConfidenceBadge();
}

// Build the standard section shell — header, row, edge-glows,
// progress bar — for a single archetype or genre category. Returns
// { root, row, progressFill } for the caller to attach + wire. The
// kind discriminator drives the dataset attribute (data-archetype-id
// vs data-section) and view-transition-name prefix; everything else
// is identical between Shows and Genres modes.
function buildSectionShell({ kind, id, accent, headlineText, flavorText, countText, tiles, idx = 0 }) {
  const section = document.createElement('section');
  section.className = 'tile-grid-section';
  if (kind === 'archetype') {
    section.dataset.archetypeId = id;
    section.style.viewTransitionName = `archetype-${id}`;
  } else {
    section.dataset.section = id;
    section.style.viewTransitionName = `genre-section-${id}`;
  }
  section.style.setProperty('--arch-accent', accent);
  // --section-idx drives the stagger animation-delay so each
  // section enters with a small offset from its neighbour. The CSS
  // owns the keyframe + delay calc; we just hand it the index.
  section.style.setProperty('--section-idx', String(idx));

  const header = document.createElement('div');
  header.className = 'tile-grid-section-header';
  header.innerHTML = `
    <div class="section-header-text">
      <span class="section-header-name">${escapeHtml(headlineText)}</span>
      ${flavorText ? `<span class="section-header-flavor">${escapeHtml(flavorText)}</span>` : ''}
    </div>
    <span class="tile-grid-section-count">${escapeHtml(countText)}</span>
  `;
  section.appendChild(header);

  const row = document.createElement('div');
  row.className = 'tile-grid-row';
  for (const tile of tiles) row.appendChild(tile);

  const rowFrame = document.createElement('div');
  rowFrame.className = 'tile-grid-rowframe';
  rowFrame.appendChild(row);
  const glowL = document.createElement('div');
  glowL.className = 'row-glow row-glow-l';
  const glowR = document.createElement('div');
  glowR.className = 'row-glow row-glow-r';
  rowFrame.appendChild(glowL);
  rowFrame.appendChild(glowR);
  section.appendChild(rowFrame);

  const progress = document.createElement('div');
  progress.className = 'tile-grid-progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'tile-grid-progress-fill';
  progress.appendChild(progressFill);
  section.appendChild(progress);

  return { root: section, row, progressFill };
}

// ── Genres-mode rendering ────────────────────────────────────────
function tagStateFor(tag) {
  return STATE.tagShapes[tag]?.state || 'skip';
}

function visibleGenreAnchors() {
  return SURVEY_GENRE_ANCHORS.filter(a => !a.mature || STATE.matureOn);
}

function renderGenreTile(anchor) {
  const media = STATE.tileMedia[anchor.representativeAniListId];
  const stateName = tagStateFor(anchor.tag);
  // Local cover takes precedence; AL bridge is the fallback layer
  // beneath it. CSS multi-background renders failed image layers as
  // transparent, so a missing local file falls through to AL.
  const alCoverUrl = media?.coverImage?.large || media?.coverImage?.medium || null;
  const coverLayers = [];
  if (anchor.localCoverPath) coverLayers.push(`url("${anchor.localCoverPath}")`);
  if (alCoverUrl) coverLayers.push(`url("${alCoverUrl}")`);
  const coverCss = coverLayers.length > 0 ? coverLayers.join(', ') : null;
  // Genre tiles can have a local cover override (e.g. Mature tags),
  // so they're "loading" only when no local AND no AL cover are
  // available — i.e. the bridge cache hasn't resolved this rep yet.
  const isLoading = !coverCss;

  const tile = document.createElement('div');
  tile.className = `tile state-${stateName}${isLoading ? ' is-loading' : ''}`;
  tile.dataset.tag = anchor.tag;
  tile.dataset.category = anchor.category;
  tile.title = anchor.displayName;

  const cover = document.createElement('div');
  cover.className = 'tile-cover';
  if (coverCss) cover.style.backgroundImage = coverCss;

  const badge = document.createElement('span');
  badge.className = 'tile-state-badge';
  badge.textContent = stateName === 'loved' ? '❤' : stateName === 'disliked' ? '✕' : '';
  cover.appendChild(badge);

  const title = document.createElement('div');
  title.className = 'tile-title';
  title.textContent = anchor.displayName;

  tile.appendChild(cover);
  tile.appendChild(title);

  // Click handling is delegated at the row level — see attachRowClick.
  return tile;
}

function renderGenreGrid() {
  const grid = document.getElementById('genre-grid');
  if (!grid) return;
  clearGridContent(grid);
  const visible = visibleGenreAnchors();

  // Same DocumentFragment + two-pass attach/wire pattern as
  // renderGrid. Shared buildSectionShell handles the boilerplate so
  // any future row-level changes apply to both modes uniformly.
  const frag = document.createDocumentFragment();
  const wirings = [];
  let sectionIdx = 0;
  for (const sectionId of GENRE_SECTION_ORDER) {
    const anchorsForSection = visible.filter(a => a.category === sectionId);
    if (!anchorsForSection.length) continue;
    const tappedCount = anchorsForSection.filter(a => tagStateFor(a.tag) !== 'skip').length;
    const section = buildSectionShell({
      kind: 'section',
      id: sectionId,
      accent: genreSectionAccent(sectionId),
      headlineText: GENRE_SECTION_LABEL_BY_ID[sectionId] || sectionId,
      flavorText: GENRE_SECTION_FLAVOR_BY_ID[sectionId] || '',
      countText: `${tappedCount} of ${anchorsForSection.length} tapped`,
      tiles: anchorsForSection.map(renderGenreTile),
      idx: sectionIdx++,
    });
    frag.appendChild(section.root);
    wirings.push({ row: section.row, progressFill: section.progressFill, kind: 'genre' });
  }
  grid.appendChild(frag);
  for (const w of wirings) {
    enhanceScrollRow(w.row, w.progressFill);
    attachTileTilt(w.row);
    attachRowClick(w.row, w.kind);
    makeRowInfinite(w.row);
  }

  updateConfidenceBadge();
}

function refreshGenreTileVisual(tile, tag) {
  const stateName = tagStateFor(tag);
  tile.className = `tile state-${stateName}`;
  const badge = tile.querySelector('.tile-state-badge');
  if (badge) {
    badge.textContent = stateName === 'loved' ? '❤' : stateName === 'disliked' ? '✕' : '';
  }
}

function updateGenreSectionCount(sectionId) {
  const sections = document.querySelectorAll('#genre-grid .tile-grid-section');
  for (const section of sections) {
    if (section.dataset.section !== sectionId) continue;
    const visibleForSection = visibleGenreAnchors().filter(a => a.category === sectionId);
    const tappedCount = visibleForSection.filter(a => tagStateFor(a.tag) !== 'skip').length;
    const countEl = section.querySelector('.tile-grid-section-count');
    if (countEl) countEl.textContent = `${tappedCount} of ${visibleForSection.length} tapped`;
    return;
  }
}

async function onGenreTileClick(tag, tileEl) {
  const current = tagStateFor(tag);
  const next = cycleNextState(current);
  const category = tileEl.dataset.category;

  // State + persistence + onboarding auto-dismiss inside survey-state.
  await recordTagTap(tag, next, current, category);

  refreshGenreTileVisual(tileEl, tag);
  syncTileVisuals(tileEl, 'data-tag', refreshGenreTileVisual, tag);
  playTapFeedback(tileEl, next);
  updateGenreSectionCount(category);
  updateConfidenceBadge();
  syncUndoButton();
  resetClearAllConfirm();
  syncClearAllButton();
  renderTasteShape(tag);
  syncOnboardingBanner();
}

function refreshTileVisual(tile, aniListId) {
  // Update only the state classes + badge text on a single tile, without
  // re-rendering the grid. Cheap and avoids the user's scroll position
  // jumping after a tap.
  const stateName = tileStateFor(aniListId);
  tile.className = `tile state-${stateName}`;
  const badge = tile.querySelector('.tile-state-badge');
  if (badge) {
    badge.textContent = stateName === 'loved' ? '❤' : stateName === 'disliked' ? '✕' : '';
  }
}

// Tap-feedback animations (heart/X burst, sparks, scale-pop) moved
// to tile.js — composed behind playTapFeedback(tileEl, nextState).
// All callers in this file now use playTapFeedback directly.

function updateSectionCount(archId) {
  // Update the per-archetype "X of N tapped" header line in place.
  // The denominator reflects the *visible* anchor count for the
  // current view, so the header reads correctly when the user is
  // in Mainstream (2 of 2) vs All (3 of 3).
  const sections = document.querySelectorAll('.tile-grid-section');
  for (const section of sections) {
    const firstTile = section.querySelector('.tile');
    if (firstTile?.dataset.archetypeId !== archId) continue;
    const anchorsForArch = visibleAnchors().filter(a => a.archetypeId === archId);
    const tappedCount = anchorsForArch
      .filter(a => tileStateFor(a.aniListId) !== 'skip').length;
    const countEl = section.querySelector('.tile-grid-section-count');
    if (countEl) countEl.textContent = `${tappedCount} of ${anchorsForArch.length} tapped`;
    break;
  }
}

// ── Confidence indicator ────────────────────────────────────────
// tapCount lives in survey-state.js as totalTapCount(); local alias
// here so existing call sites don't have to migrate together.
const tapCount = totalTapCount;

// confidenceLevelFor + updateConfidenceBadge moved to confidence.js
// — imported above.

// ── Tile click handler ──────────────────────────────────────────
async function onTileClick(aniListId, tileEl) {
  const current = tileStateFor(aniListId);
  const next = cycleNextState(current);
  const archetypeId = tileEl.dataset.archetypeId;

  // State mutation, undo recording, persistence, and onboarding
  // auto-dismiss now happen inside survey-state.js. We orchestrate
  // the visual side effects (tile refresh, animation, surface sync).
  await recordShowTap(aniListId, next, current, archetypeId);

  refreshTileVisual(tileEl, aniListId);
  // Mirror the new state to any clone tiles in the same loop row.
  syncTileVisuals(tileEl, 'data-ani-list-id', refreshTileVisual, aniListId);
  playTapFeedback(tileEl, next);
  updateSectionCount(archetypeId);
  updateConfidenceBadge();
  syncUndoButton();
  resetClearAllConfirm();
  syncClearAllButton();
  renderTasteShape(archetypeId);
  syncOnboardingBanner();
  maybeFireGenresTabCoachMark();
}

// Fires once after the user has tapped ~10 shows in Shows mode but
// hasn't visited Genres yet. Surfaces the genre-tap shortcut at the
// moment they've earned the tip — early enough to be useful, late
// enough that the basic tap gesture is internalized.
function maybeFireGenresTabCoachMark() {
  if (STATE.activeMode !== 'shows') return;
  const showTaps = Object.keys(STATE.shapes || {}).length;
  if (showTaps < 10) return;
  const anchor = document.querySelector('.mode-tab[data-mode="genres"]');
  if (!anchor) return;
  showCoachMarkOnce({
    key: 'survey-genres-tab',
    anchor,
    title: 'Try Genres mode',
    body:
      "Tap a genre you always click — it counts as roughly one " +
      "completed-show worth of signal. Useful for taste angles that " +
      "no single show on the grid quite captures.",
    placement: 'below',
  }).catch(err => console.warn('[crsmart-survey] genres coach-mark failed', err));
}

// ── Undo last tap ───────────────────────────────────────────────
// Wrapper around survey-state's undoLastAction — handles the visual
// side effects after the state mutation lands. The state module
// owns the action restoration + persistence; we own the DOM sync.
async function undoLastAction() {
  const action = await stateUndoLastAction();
  if (!action) return;
  if (action.kind === 'show') {
    const tileEl = document.querySelector(`.tile[data-ani-list-id="${action.aniListId}"]`);
    if (tileEl) { refreshTileVisual(tileEl, action.aniListId); playTapFlash(tileEl); }
    updateSectionCount(action.archetypeId);
    renderTasteShape(action.archetypeId);
  } else if (action.kind === 'tag') {
    const tileEl = document.querySelector(`.tile[data-tag="${action.tag}"]`);
    if (tileEl) { refreshGenreTileVisual(tileEl, action.tag); playTapFlash(tileEl); }
    updateGenreSectionCount(action.category);
    renderTasteShape(action.tag);
  }
  updateConfidenceBadge();
  syncUndoButton();
  resetClearAllConfirm();
  syncClearAllButton();
}

function syncUndoButton() {
  const btn = document.getElementById('undo-btn');
  if (!btn) return;
  btn.hidden = !STATE.lastAction;
}

// ── Clear all taps (mode-scoped) ────────────────────────────────
// Tap-to-confirm pattern: first click enters confirm state (pulsing
// border, label flips to "tap again to clear N"), second click within
// CLEAR_CONFIRM_TIMEOUT actually wipes. Auto-resets on timeout, on a
// tile tap, on undo, or on mode switch — anywhere the user signals
// they're doing something else.
const CLEAR_CONFIRM_TIMEOUT_MS = 4000;
const CLEAR_BTN_DEFAULT_LABEL = '↺ clear all';
let clearConfirmTimer = null;

// modeTapCount lives in survey-state.js as activeModeTapCount();
// alias here for existing callers.
const modeTapCount = activeModeTapCount;

function syncClearAllButton() {
  const btn = document.getElementById('clear-all-btn');
  if (!btn) return;
  const count = modeTapCount();
  if (count === 0) {
    btn.hidden = true;
    resetClearAllConfirm();
  } else {
    btn.hidden = false;
  }
}

function resetClearAllConfirm() {
  if (clearConfirmTimer) {
    clearTimeout(clearConfirmTimer);
    clearConfirmTimer = null;
  }
  const btn = document.getElementById('clear-all-btn');
  if (btn) {
    btn.classList.remove('is-confirming');
    btn.textContent = CLEAR_BTN_DEFAULT_LABEL;
  }
}

async function onClearAllClick() {
  const btn = document.getElementById('clear-all-btn');
  if (!btn) return;
  const count = modeTapCount();
  if (count === 0) return;

  if (!btn.classList.contains('is-confirming')) {
    // First click — arm the confirm state.
    btn.classList.add('is-confirming');
    btn.textContent = `tap again to clear ${count} ${count === 1 ? 'tap' : 'taps'}`;
    clearConfirmTimer = setTimeout(() => resetClearAllConfirm(), CLEAR_CONFIRM_TIMEOUT_MS);
    return;
  }

  // Second click — wipe.
  resetClearAllConfirm();
  // State wipe + persistence + lastAction clear in survey-state.
  await clearActiveModeTaps();
  if (STATE.activeMode === 'shows') renderGrid();
  else if (STATE.activeMode === 'genres') renderGenreGrid();
  else if (STATE.activeMode === 'studios') renderStudioGrid();
  updateConfidenceBadge();
  syncUndoButton();
  syncClearAllButton();
  renderTasteShape();
  syncOnboardingBanner();
}

// Live taste-shape preview lives in taste-preview.js — see imports
// above. survey.js's local renderTasteShape is now a thin alias
// that calls renderTastePreview with the highlight argument.
function renderTasteShape(highlightId) {
  renderTastePreview({ highlightId });
}
const onTasteShapeClick = createTastePillClickHandler();

// applyTasteWithProgress / onDone / renderSummary /
// renderPendingTapsNotice moved to apply-flow.js. The boot wiring
// below uses applyAndTransition('summary' | 'back-to-grid' |
// 'close-tab') instead of orchestrating each step by hand.
async function onDone() {
  // Light up the third funnel step before transitioning so the user
  // sees the strip resolve before the summary view loads.
  const picksStep = document.getElementById('funnel-step-picks');
  if (picksStep) {
    picksStep.classList.remove('is-active');
    picksStep.classList.add('is-done');
  }
  await applyAndTransition('summary', document.getElementById('done-btn'));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── Boot ────────────────────────────────────────────────────────
async function boot() {
  // Per-refresh reset: wipe surveyShapes, surveyTagShapes, and the
  // surveyApplyState diag so each page load starts from a clean
  // slate. The user-facing taste signal is rebuilt from whatever
  // they tap during this session. Triggers a debounced recompute
  // on the worker (storage.onChanged listener picks up the wipe),
  // which clears the previously-folded survey contributions from
  // the taste vector.
  await clearSurveyState();
  resetForFreshSession();

  // One round-trip to load everything else. survey-state.js owns
  // the dispatch into its internal STATE object.
  await loadAllStatePrefs(allMediaAniListIds);
  syncViewButtons();
  syncModeUI();
  syncMaturePill();
  renderServicePills();
  syncViewHints();
  renderTasteShape();
  syncOnboardingBanner();
  syncClearAllButton();
  renderGrid();
  renderGenreGrid();
  // Initial tint pull — sections exist now, paint the body wash for
  // whichever one is at viewport center on load.
  updateSectionTint();
  // Fire-and-forget bulk fetch for missing tile media (covers both
  // show anchors and genre representative shows); storage.onChanged
  // will repaint when the bridge cache fills.
  fetchMissingMedia();

  document.getElementById('done-btn').addEventListener('click', onDone);

  // Compact-on-scroll header morph. The survey-header is sticky from
  // the start; once the user scrolls past ~40px, .is-compact triggers
  // the title/subtitle collapse via CSS transitions. After every
  // toggle we re-measure the live header height and write it to the
  // --header-stick CSS var so sticky archetype headers can pin to it.
  const COMPACT_THRESHOLD_PX = 40;
  let compactRAF = 0;
  const updateCompact = () => {
    compactRAF = 0;
    const headerEl = document.querySelector('.survey-header');
    if (!headerEl) return;
    const compact = window.scrollY > COMPACT_THRESHOLD_PX;
    headerEl.classList.toggle('is-compact', compact);
    updateHeaderStick();
    // Scroll-depth → background hue shift. 0 at top, 1 by the time
    // the user has scrolled one full viewport-height. Capped at 1
    // so deep scrolling doesn't invert the gradient.
    const depth = Math.min(1, window.scrollY / Math.max(window.innerHeight, 1));
    document.body.style.setProperty('--scroll-depth', depth.toFixed(3));
    // Section-aware tint: pick the section closest to viewport
    // center and bleed its accent into the body's color wash.
    updateSectionTint();
  };
  window.addEventListener('scroll', () => {
    if (compactRAF) return;
    compactRAF = requestAnimationFrame(updateCompact);
  }, { passive: true });
  window.addEventListener('resize', () => {
    updateHeaderStick();
    applyTasteSidebarVisibility();
  }, { passive: true });
  updateCompact();

  // Click on a sidebar/inline taste-shape pill → smooth-scroll to
  // that archetype's section (Shows mode only).
  const sidebarPills = document.getElementById('taste-sidebar-pills');
  const inlinePills = document.getElementById('taste-shape-pills');
  if (sidebarPills) sidebarPills.addEventListener('click', onTasteShapeClick);
  if (inlinePills) inlinePills.addEventListener('click', onTasteShapeClick);
  // Refine + Close go through apply-flow.js's applyAndTransition,
  // which handles the apply-with-progress + the named transition
  // ('back-to-grid' / 'close-tab'). All three buttons share one
  // pipeline now.
  document.getElementById('refine-btn').addEventListener('click', (e) => {
    applyAndTransition('back-to-grid', e.currentTarget);
  });
  // Primary "Open Smart Picks" — opens the side panel synchronously.
  // chrome.sidePanel.open() requires an UNSPENT user gesture, so the
  // click handler cannot `await` anything before calling it. Previously
  // we awaited chrome.windows.getCurrent() to look up windowId; that
  // single await consumed the gesture, so the open call landed in
  // gesture-less state and Chrome rejected it (visible to the user
  // as the panel opening then snapping closed, and needing multiple
  // clicks before one happened to win the race). Fix: cache windowId
  // at page-init time so the click handler has a synchronous value
  // ready, and call sidePanel.open before any await. The cache uses a
  // mutable variable rather than a closure-captured constant so a
  // late-loading window context (rare) doesn't permanently break the
  // button.
  let cachedWindowId = null;
  chrome.windows.getCurrent().then(w => { cachedWindowId = w?.id ?? null; })
    .catch(err => console.warn('[crsmart-survey] windowId cache failed', err));
  const openPicksBtn = document.getElementById('open-picks-btn');
  if (openPicksBtn) {
    openPicksBtn.addEventListener('click', (e) => {
      // Synchronous open with the pre-cached windowId — preserves the
      // user-gesture token. Falls back to a windowId-less open if the
      // cache hasn't filled (Chrome treats it as "current window").
      const openArgs = cachedWindowId != null ? { windowId: cachedWindowId } : {};
      try {
        chrome.sidePanel.open(openArgs).catch(err => {
          console.warn('[crsmart-survey] sidePanel.open failed', err);
        });
      } catch (err) {
        console.warn('[crsmart-survey] sidePanel.open threw', err);
      }
      // applyTaste round-trip + tab close, sequenced after open.
      applyAndTransition('open-picks', e.currentTarget);
    });
  }
  document.getElementById('close-btn').addEventListener('click', (e) => {
    applyAndTransition('close-tab', e.currentTarget);
  });

  // View-switcher buttons (Mainstream / All / Deep Cuts). Tap state
  // persists across switches because shapes is keyed by aniListId,
  // not by what's currently visible.
  for (const btn of document.querySelectorAll('.view-btn')) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }

  // Mode tabs (Shows / Genres). Per-tab scroll is restored on switch.
  for (const btn of document.querySelectorAll('.mode-tab')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }

  // Mature pill — global modifier for both modes.
  const maturePill = document.getElementById('mature-toggle');
  if (maturePill) {
    maturePill.addEventListener('click', () => setMatureOn(!STATE.matureOn));
  }

  // Onboarding banner dismiss button. Sets the persisted flag so it
  // never reappears on this profile.
  const onboardDismiss = document.getElementById('onboarding-dismiss');
  if (onboardDismiss) {
    onboardDismiss.addEventListener('click', () => dismissOnboarding());
  }

  // Undo button + Ctrl+Z / Cmd+Z keyboard shortcut.
  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) {
    undoBtn.addEventListener('click', () => undoLastAction());
  }

  // Clear-all button (mode-scoped, tap-to-confirm).
  const clearAllBtn = document.getElementById('clear-all-btn');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => onClearAllClick());
  }
  document.addEventListener('keydown', (e) => {
    // Don't hijack undo when the user is typing in a future input field.
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    const isUndoChord = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
    if (isUndoChord && STATE.lastAction) {
      e.preventDefault();
      undoLastAction();
    }
  });
  syncUndoButton();

  // Watch for bridge-cache updates so tiles fill in as the worker
  // resolves missing media. Re-renders both grids when relevant covers
  // (show-anchor or genre-rep) land.
  // Storage subscriptions via the typed seam — replaces the old
  // single-onChanged-with-if-tree pattern. Each handler registers
  // against a named key and the storage-schema module fans out
  // from one global onChanged listener.
  subscribeStorage(STORAGE_KEYS.aniListBridgeCache, (change) => {
    // Iterate only the keys that actually changed (newly added)
    // and Set-test against pre-built anchor ID sets — avoids the
    // O(anchors × cache_keys) scan the previous implementation
    // did on every CR-page bridge fill.
    const next = change.newValue || {};
    const old = change.oldValue || {};
    let touchedShows = false;
    let touchedGenres = false;
    for (const key of Object.keys(next)) {
      if (old[key]) continue;
      const id = Number(key);
      if (!Number.isFinite(id)) continue;
      if (STATE.tileMedia[id]) continue;
      const isShow = SHOW_ANCHOR_AL_IDS.has(id);
      const isGenre = GENRE_REP_AL_IDS.has(id);
      if (!isShow && !isGenre) continue;
      STATE.tileMedia[id] = next[key];
      if (isShow) touchedShows = true;
      if (isGenre) touchedGenres = true;
    }
    if (touchedShows) renderGrid();
    if (touchedGenres) renderGenreGrid();
  });
  subscribeStorage(STORAGE_KEYS.surveyApplyState, () => {
    // surveyApplyState updates land here whenever the worker re-runs
    // persistTasteVector — including the auto-retry that fires when
    // the bridge cache fills with previously-skipped IDs. If the
    // summary is visible, refresh the pending-taps notice so the
    // count ticks down live as taps fold in.
    const summaryEl = document.getElementById('summary-screen');
    if (summaryEl && !summaryEl.hidden) {
      renderPendingTapsNotice();
    }
  });
  // surveyTapEffects is written by background's persistDualModeRecs
  // after the override + rec pool rerank lands. When it updates, the
  // summary's tap-effects panel needs to re-render so the user sees
  // the engine's voice-back per tap.
  subscribeStorage('surveyTapEffects', () => {
    const summaryEl = document.getElementById('summary-screen');
    if (summaryEl && !summaryEl.hidden) {
      renderTapEffectsNotice();
    }
  });
}

// ── Studios mode (MVP: data collection only) ────────────────────
//
// Renders studios from studioCreatorIndex sorted by user's existing
// totalWeight (top 50). Each chip cycles through three states on
// click: default → loved → disliked → default. State persists to
// surveyStudioShapes for future engine wiring.
//
// Engine integration deferred to a follow-up commit. The math (how
// studio taps fold into creator-affinity scoring) needs design once
// we have data + an honest "feels off" complaint to design against.
//
// Limitations vs Shows/Genres mode (intentional MVP scope):
// - No undo/clear-all integration with the lastAction state machine
// - No live taste-shape preview from studio taps
// - No summary-screen integration

const STUDIO_STATES = ['skip', 'loved', 'disliked'];
let _studioShapesCache = {};

function loadStudioShapes() {
  return chrome.storage.local.get(SURVEY_STUDIO_SHAPES_KEY)
    .then(data => {
      _studioShapesCache = data[SURVEY_STUDIO_SHAPES_KEY] || {};
    });
}

function studioStateFor(studioId) {
  const entry = _studioShapesCache[studioId];
  return entry?.polarity || 'skip';
}

async function cycleStudioState(studioId) {
  const cur = studioStateFor(studioId);
  const idx = STUDIO_STATES.indexOf(cur);
  const next = STUDIO_STATES[(idx + 1) % STUDIO_STATES.length];
  if (next === 'skip') {
    delete _studioShapesCache[studioId];
  } else {
    _studioShapesCache[studioId] = { polarity: next, tappedAt: Date.now() };
  }
  await chrome.storage.local.set({ [SURVEY_STUDIO_SHAPES_KEY]: _studioShapesCache });
  return next;
}

async function renderStudioGrid() {
  const grid = document.getElementById('studio-grid');
  if (!grid) return;
  await loadStudioShapes();
  const { studioCreatorIndex } = await chrome.storage.local.get('studioCreatorIndex');
  const studios = studioCreatorIndex?.studios || {};
  const sorted = Object.values(studios)
    .filter(s => s?.name && s?.id != null)
    .sort((a, b) => (b.totalWeight || 0) - (a.totalWeight || 0))
    .slice(0, 50);

  grid.innerHTML = '';
  if (sorted.length === 0) {
    grid.innerHTML = '<div class="tile-grid-empty">No studio data yet — sync your Crunchyroll history first to see studios you\'ve watched.</div>';
    return;
  }

  for (const studio of sorted) {
    const state = studioStateFor(studio.id);
    const chip = document.createElement('button');
    chip.className = `studio-chip state-${state}`;
    chip.dataset.studioId = String(studio.id);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', state !== 'skip' ? 'true' : 'false');
    chip.innerHTML = `
      <span class="studio-chip-icon" aria-hidden="true">${state === 'loved' ? '❤' : state === 'disliked' ? '✕' : ''}</span>
      <span class="studio-chip-name">${escapeHtmlSurvey(studio.name)}</span>
      <span class="studio-chip-meta">${studio.count || 0} watched · loved ${studio.lovedCount || 0}</span>
    `;
    chip.addEventListener('click', async () => {
      const next = await cycleStudioState(studio.id);
      chip.className = `studio-chip state-${next}`;
      chip.setAttribute('aria-pressed', next !== 'skip' ? 'true' : 'false');
      const iconEl = chip.querySelector('.studio-chip-icon');
      if (iconEl) iconEl.textContent = next === 'loved' ? '❤' : next === 'disliked' ? '✕' : '';
    });
    grid.appendChild(chip);
  }
}

function escapeHtmlSurvey(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

boot();
