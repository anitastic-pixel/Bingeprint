// Survey state module — owns the mutable shape that the Quick Taste
// Check page operates on. Pre-this-module, a 13-field STATE object
// in survey.js was touched by 80+ functions; setting a field meant
// the caller had to remember to call N follow-up sync/save fns.
//
// This module concentrates that knowledge:
//   1. The state shape lives here, behind named getters/setters that
//      enforce invariants (mode must be in VALID_MODES, view in
//      SURVEY_VIEW_FILTERS, etc.).
//   2. Persistence, undo recording, and onboarding auto-dismiss fire
//      from the mutators — callers don't orchestrate side effects.
//   3. A subscribe() seam fans change events to render hooks so the
//      "set field then call N syncX functions" pattern at every
//      callsite collapses into one subscriber wiring.
//
// What's intentionally still callable from survey.js: pure DOM
// rendering reads (renderTile, buildSectionShell, etc.) which need
// the current state to draw. They get it via getState() — a single
// snapshot accessor — instead of touching individual fields, so
// future moves to virtual-DOM / framework rendering have a clean
// contract to plug into.

import { SURVEY_VIEW_FILTERS, STREAMING_SERVICES } from './survey-anchors.js';
import { STORAGE_KEYS, getMany, set as storageSet, remove as storageRemove } from './storage-schema.js';
import { markWelcomeProgress } from './welcome-progress.js';

const DEFAULT_VIEW = 'all';
const DEFAULT_MODE = 'shows';
// Studios mode shipped 2026-05-02 (BRAINSTORM "Studios mode in the
// survey"); this Set wasn't updated at the time, so setMode('studios')
// has been silently returning false and the tab-click handler in
// survey.js exits early when changed=false. Fix surfaced 2026-05-03
// during a zero-consequence cleanup audit.
export const VALID_MODES = new Set(['shows', 'genres', 'studios']);
export const VALID_SERVICE_IDS = new Set(STREAMING_SERVICES.map(s => s.id));

// ── State shape ─────────────────────────────────────────────────
// Internal — callers should reach for the typed accessors below
// instead of touching this object directly. Survey.js retains
// access via getState() during the migration window; new code
// shouldn't.
const STATE = {
  shapes: {},          // { [aniListId]: { state, tappedAt } }
  tagShapes: {},       // { [tag]: { state, tappedAt } }
  tileMedia: {},       // { [aniListId]: projectedMedia }
  fetchQueue: new Set(),
  view: DEFAULT_VIEW,
  activeMode: DEFAULT_MODE,
  matureOn: false,
  serviceFilter: new Set(),
  scrollTopByMode: { shows: 0, genres: 0 },
  lastAction: null,    // { kind, aniListId|tag, prevState, ... }
  onboardingDismissed: false,
};

// ── Subscribers ─────────────────────────────────────────────────
// Lightweight pub-sub keyed by event name. Render layer subscribes
// once at boot; mutators emit events from inside so the
// post-mutation cascade ("after a tap, refresh confidence + taste
// preview + section count + undo + clear-all") happens via
// subscriptions instead of the caller orchestrating it.
const subscribers = new Map();
function emit(event, payload) {
  const handlers = subscribers.get(event);
  if (!handlers || handlers.size === 0) return;
  for (const h of [...handlers]) {
    try { h(payload); }
    catch (err) { console.warn(`[survey-state] subscriber for ${event} threw`, err); }
  }
}
export function subscribe(event, handler) {
  let set = subscribers.get(event);
  if (!set) { set = new Set(); subscribers.set(event, set); }
  set.add(handler);
  return () => set.delete(handler);
}

// Single snapshot accessor for the render layer. Returns the live
// STATE — callers should not mutate. Provided as a transition seam
// so existing renderX functions don't all need separate per-field
// getters yet.
export function getState() { return STATE; }

// Transitional re-export: survey.js's existing 80+ STATE.x accesses
// continue to work via this name during the migration. New code
// reaching for state should use the typed accessors / mutators
// above instead. Once all reads are migrated, this export can drop.
export { STATE };

// ── Tap state (shows + genres modes) ────────────────────────────

export function tapStateForShow(aniListId)  { return STATE.shapes[aniListId]?.state || 'skip'; }
export function tapStateForTag(tag)         { return STATE.tagShapes[tag]?.state || 'skip'; }

// Total tap count across both modes — drives the confidence ring
// and the "X taps folded into your taste" footer.
export function totalTapCount() {
  let n = 0;
  for (const s of Object.values(STATE.shapes))    if (s.state === 'loved' || s.state === 'disliked') n++;
  for (const s of Object.values(STATE.tagShapes)) if (s.state === 'loved' || s.state === 'disliked') n++;
  return n;
}

// Tap count for the CURRENT mode only — clear-all is mode-scoped
// and the button shows N for whichever mode the user is in.
export function activeModeTapCount() {
  const source = STATE.activeMode === 'shows' ? STATE.shapes : STATE.tagShapes;
  let n = 0;
  for (const s of Object.values(source)) {
    if (s.state === 'loved' || s.state === 'disliked') n++;
  }
  return n;
}

// Record a show or tag tap. Caller passes the new state and the
// previous state for undo recording. Persists asynchronously.
//
//   recordShowTap(aniListId, nextState, prevState, archetypeId)
//   recordTagTap(tag, nextState, prevState, category)
//
// Emits 'tap' so listeners can refresh the live taste-shape
// preview, the confidence ring, the section count.
export async function recordShowTap(aniListId, nextState, prevState, archetypeId) {
  STATE.lastAction = { kind: 'show', aniListId, prevState, archetypeId };
  if (nextState === 'skip') {
    delete STATE.shapes[aniListId];
  } else {
    STATE.shapes[aniListId] = { state: nextState, tappedAt: Date.now() };
  }
  autoDismissOnboardingOnFirstTap();
  emit('tap', { kind: 'show', aniListId, archetypeId, nextState });
  await persistShowTaps();
}

export async function recordTagTap(tag, nextState, prevState, category) {
  STATE.lastAction = { kind: 'tag', tag, prevState, category };
  if (nextState === 'skip') {
    delete STATE.tagShapes[tag];
  } else {
    STATE.tagShapes[tag] = { state: nextState, tappedAt: Date.now() };
  }
  autoDismissOnboardingOnFirstTap();
  emit('tap', { kind: 'tag', tag, category, nextState });
  await persistTagTaps();
}

// Apply the inverse of the last action and clear it. Returns the
// undone action so the caller can emit any UI feedback.
export async function undoLastAction() {
  const action = STATE.lastAction;
  if (!action) return null;
  STATE.lastAction = null;
  if (action.kind === 'show') {
    if (action.prevState === 'skip') delete STATE.shapes[action.aniListId];
    else STATE.shapes[action.aniListId] = { state: action.prevState, tappedAt: Date.now() };
    emit('tap', { kind: 'show', aniListId: action.aniListId, archetypeId: action.archetypeId, undone: true });
    await persistShowTaps();
  } else {
    if (action.prevState === 'skip') delete STATE.tagShapes[action.tag];
    else STATE.tagShapes[action.tag] = { state: action.prevState, tappedAt: Date.now() };
    emit('tap', { kind: 'tag', tag: action.tag, category: action.category, undone: true });
    await persistTagTaps();
  }
  return action;
}

// Wipe every tap in the current mode — drives the clear-all
// button. lastAction becomes meaningless after a wipe.
export async function clearActiveModeTaps() {
  if (STATE.activeMode === 'shows') {
    STATE.shapes = {};
    await persistShowTaps();
  } else {
    STATE.tagShapes = {};
    await persistTagTaps();
  }
  STATE.lastAction = null;
  emit('clearAll', { mode: STATE.activeMode });
}

// ── Filters ─────────────────────────────────────────────────────

export function getMode()   { return STATE.activeMode; }
export function getView()   { return STATE.view; }
export function getMatureOn() { return STATE.matureOn; }
export function getServiceFilter() { return STATE.serviceFilter; }

export async function setMode(nextMode) {
  if (!VALID_MODES.has(nextMode) || nextMode === STATE.activeMode) return false;
  STATE.scrollTopByMode[STATE.activeMode] = window.scrollY;
  STATE.activeMode = nextMode;
  // Mode switch invalidates the pending undo (mode-scoped) and the
  // clear-all confirm state.
  STATE.lastAction = null;
  emit('modeChanged', { mode: nextMode });
  await storageSet(STORAGE_KEYS.surveyActiveMode, nextMode);
  return true;
}

export async function setView(nextView) {
  if (!SURVEY_VIEW_FILTERS[nextView] || nextView === STATE.view) return false;
  STATE.view = nextView;
  emit('viewChanged', { view: nextView });
  await storageSet(STORAGE_KEYS.surveyViewPref, nextView);
  return true;
}

export async function setMatureOn(nextOn) {
  if (nextOn === STATE.matureOn) return false;
  STATE.matureOn = nextOn;
  emit('matureChanged', { matureOn: nextOn });
  await storageSet(STORAGE_KEYS.surveyMatureFilter, nextOn);
  return true;
}

export async function toggleServiceFilter(serviceId) {
  if (!VALID_SERVICE_IDS.has(serviceId)) return false;
  if (STATE.serviceFilter.has(serviceId)) STATE.serviceFilter.delete(serviceId);
  else STATE.serviceFilter.add(serviceId);
  emit('serviceFilterChanged', { filter: STATE.serviceFilter });
  await storageSet(STORAGE_KEYS.surveyServiceFilter, [...STATE.serviceFilter]);
  return true;
}

export async function clearServiceFilter() {
  if (STATE.serviceFilter.size === 0) return false;
  STATE.serviceFilter.clear();
  emit('serviceFilterChanged', { filter: STATE.serviceFilter });
  await storageSet(STORAGE_KEYS.surveyServiceFilter, []);
  return true;
}

// ── Tile media (bridge cache projections) ───────────────────────

export function getTileMediaFor(aniListId) { return STATE.tileMedia[aniListId]; }
export function setTileMedia(aniListId, media) { STATE.tileMedia[aniListId] = media; }

// ── Onboarding ──────────────────────────────────────────────────

export function isOnboardingDismissed() { return STATE.onboardingDismissed; }
export async function dismissOnboarding() {
  if (STATE.onboardingDismissed) return false;
  STATE.onboardingDismissed = true;
  emit('onboardingDismissed');
  await storageSet(STORAGE_KEYS.surveyOnboardingDismissed, true);
  return true;
}

// Auto-dismiss fires the persisted flag once the user makes their
// first real tap, since the banner's whole job is to teach the tap
// gesture. Called from inside recordShowTap / recordTagTap.
//
// Also graduates the user out of cold-start by stamping
// welcomeCompletedAt — the first tap is the cleanest "user has
// actually started using Smart Scoring" signal the survey can emit.
function autoDismissOnboardingOnFirstTap() {
  if (STATE.onboardingDismissed) return;
  STATE.onboardingDismissed = true;
  storageSet(STORAGE_KEYS.surveyOnboardingDismissed, true);
  emit('onboardingDismissed');
  markWelcomeProgress('survey');
}

// ── Boot-time hydration ─────────────────────────────────────────
// One IPC round-trip to populate every persisted field. Called
// after the per-refresh wipe so the pre-wipe defaults take over
// for surveyShapes / surveyTagShapes.
export async function loadAllPrefs(allMediaIdsFn) {
  const stored = await getMany([
    STORAGE_KEYS.surveyShapes,
    STORAGE_KEYS.surveyTagShapes,
    STORAGE_KEYS.surveyViewPref,
    STORAGE_KEYS.surveyActiveMode,
    STORAGE_KEYS.surveyMatureFilter,
    STORAGE_KEYS.surveyServiceFilter,
    STORAGE_KEYS.surveyOnboardingDismissed,
    STORAGE_KEYS.aniListBridgeCache,
  ]);
  STATE.shapes = stored[STORAGE_KEYS.surveyShapes] || {};
  STATE.tagShapes = stored[STORAGE_KEYS.surveyTagShapes] || {};
  // Scrub tag-shape entries for tiles we've removed. Without this
  // they linger in storage forever (no UI to untap a tile that
  // doesn't render) and keep feeding the override / tap-effect
  // surface for a tag that can't match anything in AniList.
  // 2026-04-30: 'Sexual Content' was an AniList category, not a tag.
  const DEPRECATED_TAG_KEYS = ['Sexual Content'];
  let scrubbed = false;
  for (const key of DEPRECATED_TAG_KEYS) {
    if (key in STATE.tagShapes) { delete STATE.tagShapes[key]; scrubbed = true; }
  }
  if (scrubbed) await storageSet(STORAGE_KEYS.surveyTagShapes, STATE.tagShapes);
  if (stored[STORAGE_KEYS.surveyViewPref] && SURVEY_VIEW_FILTERS[stored[STORAGE_KEYS.surveyViewPref]]) {
    STATE.view = stored[STORAGE_KEYS.surveyViewPref];
  }
  if (stored[STORAGE_KEYS.surveyActiveMode] && VALID_MODES.has(stored[STORAGE_KEYS.surveyActiveMode])) {
    STATE.activeMode = stored[STORAGE_KEYS.surveyActiveMode];
  }
  STATE.matureOn = stored[STORAGE_KEYS.surveyMatureFilter] === true;
  const services = Array.isArray(stored[STORAGE_KEYS.surveyServiceFilter])
    ? stored[STORAGE_KEYS.surveyServiceFilter] : [];
  STATE.serviceFilter = new Set(services.filter(id => VALID_SERVICE_IDS.has(id)));
  STATE.onboardingDismissed = stored[STORAGE_KEYS.surveyOnboardingDismissed] === true;
  // Dev override: surfaceSettings.devKeepOnboarding forces the banner
  // to keep showing every load. Read it here rather than gating the
  // sync isOnboardingDismissed() getter so we don't pay an async
  // chrome.storage.local round-trip per render frame. Storage write
  // is untouched — toggling the dev flag off restores normal behavior.
  try {
    const ss = await chrome.storage.local.get('surfaceSettings');
    if (ss?.surfaceSettings?.devKeepOnboarding === true) {
      STATE.onboardingDismissed = false;
    }
  } catch (_) {}
  // Tile-media: project the bridge cache down to anchor IDs only.
  const bridge = stored[STORAGE_KEYS.aniListBridgeCache] || {};
  STATE.tileMedia = {};
  for (const id of allMediaIdsFn()) {
    if (bridge[id]) STATE.tileMedia[id] = bridge[id];
  }
}

// ── Persistence — internal ──────────────────────────────────────

async function persistShowTaps() {
  await storageSet(STORAGE_KEYS.surveyShapes, STATE.shapes);
}
async function persistTagTaps() {
  await storageSet(STORAGE_KEYS.surveyTagShapes, STATE.tagShapes);
}

// Called by survey.js's per-refresh wipe path to reset session
// state in lockstep with the chrome.storage.local.remove that
// clearSurveyState() triggers.
export function resetForFreshSession() {
  STATE.shapes = {};
  STATE.tagShapes = {};
  STATE.lastAction = null;
}
