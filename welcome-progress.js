// Welcome / onboarding progress — the single place that decides
// "has this user actually started using Smart Scoring?" Three signals
// graduate them out of the cold-start state:
//
//   - 'survey'       — first show or tag tap in the Quick Taste Check
//   - 'anilist'      — AniList or MAL import wrote ≥ 1 entry
//   - 'cr-history'   — Crunchyroll watch-history sync produced ≥ 1
//                      watch-shape (i.e. the user actually watches CR)
//
// Any one of those flips welcomeCompletedAt (idempotent — first signal
// wins, later ones bump the funnel counter but don't move the
// timestamp). Drives:
//
//   - the toolbar badge dot ('!' until completed, then cleared)
//   - the popup empty-state re-engagement nudge
//     (welcomeSeen but !welcomeCompletedAt && age > 24h)
//   - the AniList-failure-recovery row (welcomeSeen.choice === 'anilist'
//     but no anilist-completion signal after 5 min)
//   - local-only funnel metrics (_funnelMetrics) for the author to
//     QA the flow without telemetry
//
// All storage lives under chrome.storage.local. Keys are flat:
//
//   welcomeCompletedAt: 1714300800000      // ms epoch, set once
//   _funnelMetrics:     { survey: 1, anilist: 0, crHistory: 23,
//                          welcomeOpened: 1, sidePanelOpened: 4 }

const STORAGE_KEY_COMPLETED  = 'welcomeCompletedAt';
const STORAGE_KEY_METRICS    = '_funnelMetrics';
const BADGE_TEXT             = '!';
const BADGE_BG               = '#ff8c28';

// Map of caller-passed source → metric key. Keeps the wire surface
// stable even if metric naming evolves later.
const SOURCE_METRIC = {
  survey:           'survey',
  anilist:          'anilist',
  mal:              'anilist',          // collapse list providers into one bucket
  freeform:         'anilist',          // freeform-notes import — same engine input as MAL/AL
  'cr-history':     'crHistory',
  'welcome-opened': 'welcomeOpened',
  'side-panel-opened': 'sidePanelOpened',
};

// Sources that count as "user has actually started" — flipping
// welcomeCompletedAt. The reach metrics (welcome opened, side panel
// opened) bump funnel counters but don't graduate the user.
const COMPLETION_SOURCES = new Set(['survey', 'anilist', 'mal', 'freeform', 'cr-history']);

async function readStorage() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_COMPLETED, STORAGE_KEY_METRICS]);
    return {
      completedAt: stored[STORAGE_KEY_COMPLETED] ?? null,
      metrics:     stored[STORAGE_KEY_METRICS]   ?? {},
    };
  } catch (_) {
    return { completedAt: null, metrics: {} };
  }
}

// Set the toolbar badge based on completed-at. Wrapped in a
// chrome.action existence check so this module can be imported from
// pages that don't have action access (popup, sidepanel) without
// throwing — only the worker actually paints the badge.
async function syncBadge(completedAt) {
  if (!chrome?.action?.setBadgeText) return;
  try {
    if (completedAt) {
      await chrome.action.setBadgeText({ text: '' });
    } else {
      await chrome.action.setBadgeText({ text: BADGE_TEXT });
      if (chrome.action.setBadgeBackgroundColor) {
        await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
      }
    }
  } catch (_) { /* badge paint is best-effort */ }
}

// Mark a progress signal. Idempotent on completion: once
// welcomeCompletedAt is set, later calls only bump the funnel counter.
//
//   markWelcomeProgress('survey')
//   markWelcomeProgress('anilist')
//   markWelcomeProgress('cr-history')
//   markWelcomeProgress('welcome-opened')
//   markWelcomeProgress('side-panel-opened')
export async function markWelcomeProgress(source) {
  const metricKey = SOURCE_METRIC[source];
  if (!metricKey) return;
  try {
    const { completedAt, metrics } = await readStorage();
    const next = { ...metrics, [metricKey]: (metrics[metricKey] || 0) + 1 };
    const patch = { [STORAGE_KEY_METRICS]: next };
    let nextCompleted = completedAt;
    if (!completedAt && COMPLETION_SOURCES.has(source)) {
      nextCompleted = Date.now();
      patch[STORAGE_KEY_COMPLETED] = nextCompleted;
    }
    await chrome.storage.local.set(patch);
    if (nextCompleted !== completedAt) {
      await syncBadge(nextCompleted);
    }
  } catch (_) { /* storage write is best-effort */ }
}

// Read snapshot for the popup empty-state.
//
//   { tourSeen, welcomeCompletedAt, funnel }
//
// tourSeen is fetched here too so the popup only does one IPC.
// (Legacy shim: welcomeSeen → tourSeen migration handled by
// migrateLegacyWelcomeSeen below — called once at worker boot.)
export async function getWelcomeProgress() {
  try {
    const stored = await chrome.storage.local.get([
      'tourSeen',
      STORAGE_KEY_COMPLETED,
      STORAGE_KEY_METRICS,
    ]);
    return {
      tourSeen:           stored.tourSeen ?? null,
      welcomeCompletedAt: stored[STORAGE_KEY_COMPLETED] ?? null,
      funnel:             stored[STORAGE_KEY_METRICS]   ?? {},
    };
  } catch (_) {
    return { tourSeen: null, welcomeCompletedAt: null, funnel: {} };
  }
}

// One-time migration: welcomeSeen { at, choice } → tourSeen
// { at, choice }. Called from worker boot (background.js → here).
// Idempotent: if tourSeen already exists, leaves both keys alone.
//
// IMPORTANT: only `at` and `choice` migrate. dismissedAt and
// completedAt stay unset — because legacy users never actually saw
// the tour (they saw the old welcome.html, which was a totally
// different surface). Marking it completed would suppress the tour
// + the top-bar button on upgrade, which is exactly the regression
// reported the first time we shipped this. The install handler
// (background.js) compensates: on reason='update', if tourSeen
// has no completedAt, fire the tour as if it were fresh.
//
// Removes legacy welcomeSeen on success.
export async function migrateLegacyWelcomeSeen() {
  try {
    const stored = await chrome.storage.local.get(['welcomeSeen', 'tourSeen']);
    if (stored.tourSeen) return;
    if (!stored.welcomeSeen) return;
    const at = stored.welcomeSeen.at || Date.now();
    const tourSeen = {
      at,
      choice: stored.welcomeSeen.choice ?? null,
    };
    await chrome.storage.local.set({ tourSeen });
    await chrome.storage.local.remove('welcomeSeen');
  } catch (_) { /* best-effort */ }
}

// Worker-only: paint the badge to match current completion state.
// Called from background.js's onInstalled (initial '!') and on every
// service-worker boot (re-paint after suspend so the badge survives).
export async function refreshBadge() {
  const { completedAt } = await readStorage();
  await syncBadge(completedAt);
}

// Reset everything — only used by the dev "Show me around again"
// affordance / tests. Clears completedAt and the funnel counters,
// re-paints the badge dot.
export async function resetWelcomeProgress() {
  try {
    await chrome.storage.local.remove([STORAGE_KEY_COMPLETED, STORAGE_KEY_METRICS]);
    await syncBadge(null);
  } catch (_) {}
}
