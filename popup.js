// source-row.js owns the source-row state machine (state derivation +
// uniform DOM application). The two renderers below (renderExternalRow
// for AniList/MAL OAuth, renderMalXmlRow for the XML import row) funnel
// through it so the visual + class composition stays in one place.
import { deriveSourceRowState, applyRowVisuals } from './source-row.js';
// _importState subscription — replaces the popup's setTimeout poll.
// Event-driven, no IPC unless something changed.
import { subscribeImportState } from './import-state-channel.js';

// Dev-mode reveal: dev-only sections (axis sandbox, validation snapshot)
// stay hidden unless the popup is opened with ?dev=1 in its URL — reach
// it via chrome-extension://<id>/popup.html?dev=1.
(function revealDevOnlyIfRequested() {
  try {
    const isDev = new URLSearchParams(location.search).has('dev');
    if (isDev) {
      document.documentElement.classList.add('crsmart-dev');
      document.querySelectorAll('.dev-only[hidden]').forEach(el => {
        el.removeAttribute('hidden');
      });
    }
    // Toggle the dev-probe gate read by crsmart-probe.js: opening the popup
    // with ?dev=1 enables the page-DOM probe shadow for external dev tools;
    // any normal popup open turns it back off, so production never leaves the
    // engine-state shadow enabled. (No leak in normal use.)
    try { chrome.storage?.local?.set({ _crsmartDevProbes: isDev }); } catch {}
  } catch {}
})();

// Popup — concept dummy. Renders archetype blend from hard-coded mock data
// (the user's Stage 0 hypothesized blend), shows Crunchyroll connection
// status from chrome.storage, and lets the user pick up to 2 mood chips
// (with search + shuffle). Profile completeness and recent picks blocks
// are collapsible. None of this is wired to real scoring yet — the popup
// exists so we can react to the shape of the surface before the engine
// is built.

// Color per archetype id — decoupled from score data so we can swap the
// data source (mock → real) without losing the palette. Keys mirror the
// ids in archetypes.js. Any new archetype added there without a color
// here falls back to neutral grey via resolveArchColor().
//
// Kept aligned with tile.js's ARCHETYPE_COLORS — same palette across
// surfaces so the swatch in the popup matches the corner badge on
// in-page tiles. If you add an archetype to archetypes.js, add a colour
// here AND in tile.js to keep the two in sync.
const ARCH_COLORS = {
  'comfort-isekai':     '#ff8c28',
  'serious-isekai':     '#a04040',
  'mainstream-shounen': '#e74c3c',
  'magic-academy':      '#5b8def',
  'romance-open':       '#ff6699',
  'fujoshi-yuri':       '#b450ff',
  'auteur':             '#1abc9c',
  'otome-villainess':   '#ffd14a',
  'cgdct':              '#ffb6cf',
  'sports':             '#ff6a3d',
  'mecha':              '#5d9aff',
  'horror':             '#a14fc6',
  'mahou-shoujo':       '#ff5f9d',
  'mind-game-thriller': '#9aa9c2',
  'hard-scifi':         '#2cd8c4',
  'battle-seinen':      '#e04848',
  'xianxia':            '#e0bd58',
  'josei':              '#d29785',
};
function resolveArchColor(id) { return ARCH_COLORS[id] || '#888'; }

// The full archetype blend lives in chrome.storage.local under
// 'archetypeBlend' (written by background.js on taste recompute). Values
// are cosine-sim scores, not percentages — we normalize for display,
// showing only the honest band (per stage_1d memo: mid-rank archetypes
// are noisy until the IDF fix). Top MAX_ARCH_ROWS entries render as
// bars; the rest stay hidden behind a "show all" affordance added later.
const MAX_ARCH_ROWS = 5;
const MIN_ARCH_SCORE = 0.01; // cold-start guard; below this, user has no honest lanes

async function renderArchetypes() {
  const list = document.getElementById('archetype-list');
  if (!list) return;
  let blend = null;
  try {
    const data = await chrome.storage.local.get('archetypeBlend');
    blend = data?.archetypeBlend?.archetypes || null;
  } catch (_) { blend = null; }

  const ranked = Array.isArray(blend)
    ? blend.filter(a => (a?.score ?? 0) >= MIN_ARCH_SCORE).slice(0, MAX_ARCH_ROWS)
    : [];

  if (ranked.length === 0) {
    // Cold-start or pre-sync. Keep the section visible so the
    // top-archetypes surface doesn't disappear silently — a placeholder
    // signals "we know this belongs here, data just hasn't landed yet."
    list.innerHTML = `<li class="arch arch-empty"><span class="muted small">still learning your taste — sync your CR history to fill this in.</span></li>`;
    return;
  }

  // Normalize to percentages within the displayed band only — same
  // visual shape as before (bars summing toward a max), just grounded
  // in real cosine-sim output. Using the displayed band (not the full
  // 8-archetype sum) keeps the top bar meaningful when later rows fall
  // below threshold; we're answering "relative weight among your honest
  // lanes," not "fraction of all possible taste."
  const total = ranked.reduce((acc, a) => acc + (a.score || 0), 0) || 1;
  const maxPct = Math.max(...ranked.map(a => (a.score / total) * 100));
  list.innerHTML = ranked.map(a => {
    const pct = Math.round((a.score / total) * 100);
    const color = resolveArchColor(a.id);
    return `
      <li class="arch">
        <div class="arch-name">
          <span class="arch-swatch" style="background:${color}"></span>
          <span class="arch-label">${escapeHtml(a.name)}</span>
        </div>
        <div class="arch-pct">${pct}%</div>
        <div class="arch-bar">
          <div class="arch-fill" style="width:${(pct / maxPct) * 100}%;background:${color}"></div>
        </div>
      </li>
    `;
  }).join('');
}

function wireCollapsibles() {
  document.querySelectorAll('.collapsible').forEach(section => {
    const head = section.querySelector('.block-head');
    head.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!collapsed));
    });
  });
}

async function refreshStatus() {
  const pill = document.getElementById('status-pill');
  try {
    const local = await chrome.storage.local.get(['profileId', 'lastSeenAt']);
    const session = await chrome.storage.session.get(['crToken', 'crTokenAt']);
    if (session.crToken && local.profileId) {
      pill.textContent = 'connected';
      pill.classList.remove('disconnected');
    } else if (local.profileId) {
      pill.textContent = 'open Crunchyroll to sync';
      pill.classList.add('disconnected');
    } else {
      pill.textContent = 'not connected';
      pill.classList.add('disconnected');
    }
  } catch (_) {
    pill.textContent = 'not connected';
    pill.classList.add('disconnected');
  }
}

// Surface the user's Quick Taste Check footprint inside the
// top-archetypes block: a one-line summary of how many show + tag taps
// are currently folded into the vector, plus a tap-to-confirm clear
// button that wipes them. The button stays hidden when there's no
// survey signal to clear, so the row reads as informational rather
// than always-asking-to-be-tapped. Auto-runs on storage change of
// surveyShapes / surveyTagShapes via the existing live-update
// listener.
async function refreshSurveyFootprint() {
  const row = document.getElementById('archetypes-survey');
  const countEl = document.getElementById('archetypes-survey-count');
  const btn = document.getElementById('archetypes-survey-clear');
  if (!row || !countEl || !btn) return;
  try {
    const { surveyShapes = {}, surveyTagShapes = {} } =
      await chrome.storage.local.get(['surveyShapes', 'surveyTagShapes']);
    const shows = Object.keys(surveyShapes).length;
    const tags = Object.keys(surveyTagShapes).length;
    const total = shows + tags;
    if (total === 0) {
      row.hidden = true;
      btn.hidden = true;
      // Cancel any in-flight confirm state so a re-add doesn't carry
      // over the prior session's pending wipe.
      btn.classList.remove('is-confirming');
      btn.textContent = 'clear my survey taps';
      return;
    }
    row.hidden = false;
    btn.hidden = false;
    const parts = [];
    if (shows > 0) parts.push(`${shows} show tap${shows === 1 ? '' : 's'}`);
    if (tags > 0)  parts.push(`${tags} tag tap${tags === 1 ? '' : 's'}`);
    countEl.textContent = `${parts.join(' · ')} folded into your taste`;
  } catch (_) {
    row.hidden = true;
  }
}

const SURVEY_CLEAR_CONFIRM_MS = 4000;
let surveyClearConfirmTimer = null;
function wireSurveyClearButton() {
  const btn = document.getElementById('archetypes-survey-clear');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('is-confirming')) {
      // First click: arm confirm state with a count for clarity.
      const { surveyShapes = {}, surveyTagShapes = {} } =
        await chrome.storage.local.get(['surveyShapes', 'surveyTagShapes']);
      const total = Object.keys(surveyShapes).length + Object.keys(surveyTagShapes).length;
      if (total === 0) return;
      btn.classList.add('is-confirming');
      btn.textContent = `tap again to clear ${total} tap${total === 1 ? '' : 's'}`;
      if (surveyClearConfirmTimer) clearTimeout(surveyClearConfirmTimer);
      surveyClearConfirmTimer = setTimeout(() => {
        btn.classList.remove('is-confirming');
        btn.textContent = 'clear my survey taps';
        surveyClearConfirmTimer = null;
      }, SURVEY_CLEAR_CONFIRM_MS);
      return;
    }
    // Second click within the confirm window: wipe.
    if (surveyClearConfirmTimer) {
      clearTimeout(surveyClearConfirmTimer);
      surveyClearConfirmTimer = null;
    }
    btn.classList.remove('is-confirming');
    btn.textContent = 'clearing…';
    try {
      await chrome.storage.local.remove([
        'surveyShapes', 'surveyTagShapes', 'surveyApplyState',
      ]);
      // The worker's storage.onChanged listener picks up the wipe
      // and schedules a debounced recompute, which clears the
      // previously-folded survey contributions from the taste vector.
      // archetypeBlend will live-update the bars in the popup once
      // the recompute finishes.
    } catch (err) {
      console.warn('[crsmart-popup] survey clear failed', err);
    }
  });
}

async function refreshHistoryCount() {
  const meta = document.getElementById('source-cr-meta');
  const foot = document.getElementById('archetypes-foot');
  const btn = document.getElementById('source-cr-refresh');
  try {
    const { crHistorySummary, aniListMeta, watchShapes, crHistorySyncing,
            userRatings, userReactions, surveyShapes, surveyTagShapes } =
      await chrome.storage.local.get(
        ['crHistorySummary', 'aniListMeta', 'watchShapes', 'crHistorySyncing',
         'userRatings', 'userReactions', 'surveyShapes', 'surveyTagShapes']);
    if (btn) {
      btn.classList.toggle('spinning', !!crHistorySyncing);
      btn.disabled = !!crHistorySyncing;
    }
    if (crHistorySyncing && meta) {
      meta.textContent = 'refreshing…';
      return;
    }
    if (crHistorySummary && crHistorySummary.seriesCount) {
      const s = crHistorySummary.seriesCount;
      const e = crHistorySummary.episodeCount;
      let line = `${s} series · ${e} eps`;
      if (aniListMeta && aniListMeta.totalSeries) {
        const m = aniListMeta.totalMatched || 0;
        const t = aniListMeta.totalSeries;
        line += aniListMeta.inProgress
          ? ` · enriching ${m}/${t}`
          : ` · ${m}/${t} enriched`;
      }
      if (watchShapes?.summary) {
        const w = watchShapes.summary;
        const dropped = (w.droppedEarly || 0) + (w.droppedMid || 0);
        line += ` · ${w.completed || 0} done · ${dropped} dropped`;
        if (w.seriesWithRewatches) line += ` · ${w.seriesWithRewatches} rewatched`;
      }
      // Transparency surface — show the user how many direct feedback
      // signals the engine is currently folding in. Ratings + reactions
      // live on show-page cards; counting them here makes the data
      // surface discoverable without a separate panel.
      const ratingCount = userRatings ? Object.keys(userRatings).length : 0;
      const reactionCount = userReactions
        ? Object.values(userReactions).reduce(
            (n, e) => n + (Array.isArray(e?.tags) ? e.tags.length : 0), 0)
        : 0;
      if (ratingCount > 0) line += ` · ${ratingCount} rated`;
      if (reactionCount > 0) line += ` · ${reactionCount} reaction${reactionCount === 1 ? '' : 's'} captured`;
      // Quick Taste Check signal — count both modes' active taps
      // (skip-state entries don't get persisted so length is the
      // tap count). Surfaced separately from CR history so the user
      // sees survey input as a distinct contribution.
      const surveyShowTaps = surveyShapes ? Object.keys(surveyShapes).length : 0;
      const surveyTagTaps = surveyTagShapes ? Object.keys(surveyTagShapes).length : 0;
      const totalSurveyTaps = surveyShowTaps + surveyTagTaps;
      if (totalSurveyTaps > 0) line += ` · ${totalSurveyTaps} survey tap${totalSurveyTaps === 1 ? '' : 's'}`;
      if (meta) meta.textContent = line;
      if (foot) {
        foot.textContent = totalSurveyTaps > 0
          ? `based on ${s} series in your CR history + ${totalSurveyTaps} survey tap${totalSurveyTaps === 1 ? '' : 's'} · `
          : `based on ${s} series in your CR history · `;
      }
    } else if (surveyShapes || surveyTagShapes) {
      // Survey-only path (no CR history yet) — surface the tap
      // count so the user knows what's powering the taste shape.
      const surveyShowTaps = surveyShapes ? Object.keys(surveyShapes).length : 0;
      const surveyTagTaps = surveyTagShapes ? Object.keys(surveyTagShapes).length : 0;
      const totalSurveyTaps = surveyShowTaps + surveyTagTaps;
      if (meta) meta.textContent = totalSurveyTaps > 0
        ? `${totalSurveyTaps} survey tap${totalSurveyTaps === 1 ? '' : 's'} · sync CR history for fuller picks`
        : 'syncing…';
      if (foot && totalSurveyTaps > 0) {
        foot.textContent = `based on ${totalSurveyTaps} survey tap${totalSurveyTaps === 1 ? '' : 's'} · `;
      }
    } else {
      if (meta) meta.textContent = 'syncing…';
    }
  } catch (_) {
    if (meta) meta.textContent = '—';
  }
}

// Live-update: when the background worker finishes a sync (or when the
// token lands while the popup is already open), refresh the affected
// surfaces in place rather than waiting for the next popup open.
function wireStorageLiveUpdate() {
  if (!chrome?.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.crHistorySummary) refreshHistoryCount();
    if (area === 'local' && changes.aniListMeta) refreshHistoryCount();
    if (area === 'local' && changes.watchShapes) refreshHistoryCount();
    if (area === 'local' && changes.crHistorySyncing) refreshHistoryCount();
    if (area === 'local' && changes.userRatings) refreshHistoryCount();
    if (area === 'local' && changes.userReactions) refreshHistoryCount();
    if (area === 'local' && changes.surveyShapes) {
      refreshHistoryCount();
      refreshSurveyFootprint();
    }
    if (area === 'local' && changes.surveyTagShapes) {
      refreshHistoryCount();
      refreshSurveyFootprint();
    }
    if (area === 'local' && changes.archetypeBlend) renderArchetypes();
    if (area === 'local' && changes.anilistFetchProgress) refreshSyncProgress();
    if (area === 'local' && changes.crHistoryProgress) refreshSyncProgress();
    if (area === 'session' && changes.crToken) refreshStatus();
    if (area === 'local' && changes.profileId) refreshStatus();
  });
}

// ── Sync progress bars ──────────────────────────────────────────────
// Reads anilistFetchProgress + crHistoryProgress from storage and
// renders two stacked bars above the profile-completeness block. The
// section is hidden whenever both keys are absent so an idle popup
// stays clean. Counts render as "current/total · ETA" when total is
// known; "page N · waiting on total" when the API hasn't reported total
// yet (history fetch's first page).
async function refreshSyncProgress() {
  const wrap = document.getElementById('sync-progress');
  if (!wrap) return;
  let store;
  try {
    store = await chrome.storage.local.get(['anilistFetchProgress', 'crHistoryProgress']);
  } catch (_) { store = {}; }
  const al = store.anilistFetchProgress || null;
  const cr = store.crHistoryProgress || null;

  const aniRow = document.getElementById('progress-anilist');
  const aniTitle = document.getElementById('progress-anilist-title');
  const aniCounts = document.getElementById('progress-anilist-counts');
  const aniFill = document.getElementById('progress-anilist-fill');
  if (al && aniRow) {
    aniRow.hidden = false;
    aniTitle.textContent = al.label || 'AniList';
    const pct = al.total > 0 ? Math.min(100, Math.round((al.current / al.total) * 100)) : 0;
    aniCounts.textContent = al.total > 0
      ? `${al.current}/${al.total} · ${pct}%`
      : 'starting…';
    aniFill.style.width = al.total > 0 ? `${pct}%` : '6%';
    aniFill.classList.toggle('indeterminate', !(al.total > 0));
  } else if (aniRow) {
    aniRow.hidden = true;
  }

  const crRow = document.getElementById('progress-crhistory');
  const crTitle = document.getElementById('progress-crhistory-title');
  const crCounts = document.getElementById('progress-crhistory-counts');
  const crFill = document.getElementById('progress-crhistory-fill');
  if (cr && crRow) {
    crRow.hidden = false;
    crTitle.textContent = cr.label || 'Crunchyroll history';
    if (cr.total > 0) {
      const pct = Math.min(100, Math.round((cr.current / cr.total) * 100));
      crCounts.textContent = `${cr.current}/${cr.total} eps · ${pct}%`;
      crFill.style.width = `${pct}%`;
      crFill.classList.remove('indeterminate');
    } else {
      // total unknown until first page reports — show indeterminate bar
      crCounts.textContent = `page ${cr.page || 1} · ${cr.current} eps`;
      crFill.style.width = '6%';
      crFill.classList.add('indeterminate');
    }
  } else if (crRow) {
    crRow.hidden = true;
  }

  wrap.hidden = !(al || cr);
}

// Open / focus the Quick Taste Check survey in a new tab. If the
// survey tab is already open we focus it instead of creating a
// duplicate; resume-by-default UX is handled inside survey.js
// (taps persist across opens via chrome.storage.local.surveyShapes).
function wireSurveyOpen() {
  const btn = document.getElementById('survey-open-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const url = chrome.runtime.getURL('survey.html');
    try {
      const tabs = await chrome.tabs.query({ url });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId != null) {
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url });
      }
      window.close(); // dismiss the popup so the survey is foreground
    } catch (err) {
      console.warn('[crsmart-popup] survey-open failed', err);
    }
  });
}

function wireMalXmlOpen() {
  const btn = document.getElementById('mal-xml-open-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const url = chrome.runtime.getURL('import-mal-xml.html');
    try {
      const tabs = await chrome.tabs.query({ url });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId != null) {
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url });
      }
      window.close();
    } catch (err) {
      console.warn('[crsmart-popup] mal-xml-open failed', err);
    }
  });

  const row = document.getElementById('source-mal-xml');
  if (!row) return;

  // Clear (⏻) — drops MAL externalScores entries. No confirm prompt
  // since the action is reversible: re-import the XML to restore.
  const clearBtn = row.querySelector('[data-role="clear"]');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (clearBtn.disabled) return;
      clearBtn.disabled = true;
      try {
        const resp = await externalSendMessage('crsmart:external:clear-source-data', { source: 'mal' });
        if (!resp?.ok) {
          console.warn('[crsmart-popup] clear MAL failed', resp);
        }
      } catch (err) {
        console.warn('[crsmart-popup] clear MAL threw', err);
      }
      refreshExternalPanel();
    });
  }

  // Impact toggle (▾/▴) — show/hide the engine-impact panel. Same
  // pattern the OAuth rows use.
  const impactToggle = row.querySelector('[data-role="impact-toggle"]');
  const impactPanel = row.querySelector('[data-role="impact"]');
  if (impactToggle && impactPanel) {
    impactToggle.addEventListener('click', () => {
      const showing = !impactPanel.hidden;
      impactPanel.hidden = showing;
      impactToggle.textContent = showing ? '▾' : '▴';
      impactToggle.setAttribute('aria-expanded', String(!showing));
    });
  }
}

function wireFreeformOpen() {
  const btn = document.getElementById('freeform-open-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const url = chrome.runtime.getURL('import-freeform.html');
    try {
      // Reuse an open freeform-import tab if present, otherwise spawn
      // one. Mirrors wireMalXmlOpen so the UX is identical across the
      // two paste-style importers.
      const tabs = await chrome.tabs.query({ url });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId != null) {
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url });
      }
      window.close();
    } catch (err) {
      console.warn('[crsmart-popup] freeform-open failed', err);
    }
  });

  const row = document.getElementById('source-freeform');
  if (!row) return;

  // Clear (⏻) — drops freeform externalScores entries. Same shape as
  // the MAL XML clear; the SW's clear-source-data handler walks every
  // AL ID, removes only the 'freeform' source slot, leaves other
  // sources intact, and triggers the pipeline recompute.
  const clearBtn = row.querySelector('[data-role="clear"]');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (clearBtn.disabled) return;
      clearBtn.disabled = true;
      try {
        const resp = await externalSendMessage('crsmart:external:clear-source-data', { source: 'freeform' });
        if (!resp?.ok) {
          console.warn('[crsmart-popup] clear freeform failed', resp);
        }
      } catch (err) {
        console.warn('[crsmart-popup] clear freeform threw', err);
      }
      refreshExternalPanel();
    });
  }

  const impactToggle = row.querySelector('[data-role="impact-toggle"]');
  const impactPanel = row.querySelector('[data-role="impact"]');
  if (impactToggle && impactPanel) {
    impactToggle.addEventListener('click', () => {
      const showing = !impactPanel.hidden;
      impactPanel.hidden = showing;
      impactToggle.textContent = showing ? '▾' : '▴';
      impactToggle.setAttribute('aria-expanded', String(!showing));
    });
  }
}

function wireHistoryRefresh() {
  const btn = document.getElementById('source-cr-refresh');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spinning');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'forceRefresh' });
      if (!res?.ok) {
        const meta = document.getElementById('source-cr-meta');
        if (meta) meta.textContent = res?.reason === 'no-token-or-profile'
          ? 'open Crunchyroll first'
          : 'refresh failed';
      }
    } catch (e) {
      const meta = document.getElementById('source-cr-meta');
      if (meta) meta.textContent = 'refresh failed';
    } finally {
      // Storage listener will clear spinning/disabled once crHistorySyncing
      // is removed by the worker. Leave UI state alone here.
    }
  });
}

// Validation snapshot button. Asks the worker to build a snapshot,
// then triggers a JSON download. The user moves the file into
// validation/snapshots/ for the diff workflow.
function wireValidateSnapshot() {
  const btn = document.getElementById('validate-snapshot-btn');
  const status = document.getElementById('validate-status');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    if (status) status.textContent = 'building snapshot…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'crsmart:validate-snapshot' });
      if (!res?.ok || !res.snapshot) {
        if (status) status.textContent = `failed: ${res?.reason || 'unknown'}`;
        return;
      }
      const snap = res.snapshot;
      const payload = JSON.stringify(snap, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const ts = (snap.generatedAt || new Date().toISOString()).replace(/[:.]/g, '-');
      const filename = `${snap.user || 'andrew'}-snapshot-${ts}.json`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const passed = snap.cases ? snap.cases.filter(c => c.pass === true).length : 0;
      const total = snap.cases ? snap.cases.length : 0;
      const failed = snap.cases ? snap.cases.filter(c => c.pass === false).length : 0;
      if (status) {
        status.textContent = `${snap.engine.scoredEntryCount} shows · cases ${passed}/${total} pass` + (failed ? ` · ${failed} failed` : '');
      }
    } catch (err) {
      if (status) status.textContent = `error: ${err?.message || err}`;
    } finally {
      btn.disabled = false;
    }
  });
}

// Dev-only: rebuild the bundled rec-pool from Crunchyroll's full catalog.
// Fires the SW long-job, polls its progress in chrome.storage, then
// downloads the assembled (minified) sidecar for committing as
// data/rec-pool-by-cr-id.json. The SW reuses the live CR token + enrichOne;
// the popup can be closed and reopened mid-run (state lives in storage).
function wireCrCatalogExport() {
  const btn = document.getElementById('cr-catalog-btn');
  const status = document.getElementById('cr-catalog-status');
  if (!btn) return;
  const KEY = '_devCatalogExport';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let polling = false;

  async function downloadSidecar(sidecar) {
    const payload = JSON.stringify(sidecar); // compact — matches the slimmed asset
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rec-pool-by-cr-id.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { [KEY]: st } = await chrome.storage.local.get(KEY);
        if (!st) { if (status) status.textContent = ''; break; }
        if (st.status === 'running') {
          const pct = st.total ? ` (${Math.round(100 * st.current / st.total)}%)` : '';
          const phase = st.phase === 'browse' ? 'enumerating catalog' : 'resolving to AniList';
          if (status) status.textContent = `${phase}: ${st.current}/${st.total || '?'}${pct}`;
          btn.disabled = true;
          await sleep(2000);
          continue;
        }
        if (st.status === 'error') {
          if (status) status.textContent = `failed: ${st.error || 'unknown'}`;
          btn.disabled = false;
          break;
        }
        if (st.status === 'done') {
          const s = st.summary || {};
          const r = s.resolved || {};
          if (st.sidecar) await downloadSidecar(st.sidecar);
          if (status) {
            status.textContent = `done: ${s.hitCount} shows (catalog ${s.catalogTotal}, `
              + `kept ${s.carriedOver} + new ${r.verified || 0} verified / `
              + `${r['unverified-best-guess'] || 0} best-guess · ${r['no-match'] || 0} no-match · ${r.error || 0} err)`;
          }
          btn.disabled = false;
          break;
        }
        break;
      }
    } finally {
      polling = false;
    }
  }

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    if (status) status.textContent = 'starting…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'crsmart:dev:cr-catalog:start' });
      if (!res?.ok) { if (status) status.textContent = 'failed to start'; btn.disabled = false; return; }
      poll();
    } catch (err) {
      if (status) status.textContent = `error: ${err?.message || err}`;
      btn.disabled = false;
    }
  });

  // Preview button — opens the match-review page (reads _devCatalogPreview).
  const previewBtn = document.getElementById('cr-catalog-preview-btn');
  if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
      const url = chrome.runtime.getURL('catalog-preview.html');
      const tabs = await chrome.tabs.query({ url });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url });
      }
    });
  }

  // Resume polling if a run is already in flight when the popup opens.
  chrome.storage.local.get(KEY).then(({ [KEY]: st }) => {
    if (st && st.status === 'running') poll();
  });
}

// ── Backup & restore ────────────────────────────────────────────────
// Inline export panel in Settings → "Backup & restore" section. Reads
// the bucket checkboxes, calls into backup-schema.js to produce the
// envelope, downloads as JSON. Restore happens in a separate tab
// (import.html) — clicking the import button just opens it; the file
// picker + preview + atomic write all live there because Chrome MV3
// popup behaviour around <input type="file"> is unreliable (popup
// closes on focus loss to the OS file dialog).
function wireBackupRestore() {
  const exportBtn = document.getElementById('backup-export-btn');
  const importBtn = document.getElementById('backup-import-btn');
  const status = document.getElementById('backup-export-status');
  if (!exportBtn || !importBtn) return;

  // Disable Export when no buckets are checked. AniList OAuth sub-toggle
  // also disables when AniList itself is unchecked (token wouldn't ride
  // along anyway, so the choice is meaningless). Header summary updates
  // to "N / 4 buckets" so the collapsed-by-default section communicates
  // current state without needing to be open.
  const bucketCount = document.getElementById('backup-bucket-count');
  const headerSummary = document.getElementById('backup-summary');
  function syncControlState() {
    const checked = document.querySelectorAll('.backup-bucket-cb:checked');
    const total = document.querySelectorAll('.backup-bucket-cb').length;
    exportBtn.disabled = checked.length === 0;
    if (bucketCount) {
      bucketCount.textContent = checked.length === total
        ? `${total} buckets`
        : `${checked.length} / ${total} buckets`;
    }
    if (headerSummary) {
      headerSummary.textContent = checked.length === 0
        ? 'pick at least one'
        : `${checked.length} / ${total} · ready`;
    }
  }
  document.querySelectorAll('.backup-bucket-cb').forEach(cb => {
    cb.addEventListener('change', syncControlState);
  });
  syncControlState();

  exportBtn.addEventListener('click', async () => {
    if (exportBtn.disabled) return;
    if (!window.crsmartBackupSchema) {
      if (status) status.textContent = 'backup module not loaded';
      return;
    }
    exportBtn.disabled = true;
    if (status) status.textContent = 'building backup…';
    try {
      const buckets = [...document.querySelectorAll('.backup-bucket-cb:checked')]
        .map(cb => cb.dataset.bucket);
      const envelope = await window.crsmartBackupSchema.buildBackupEnvelope({
        buckets,
      });
      const payload = JSON.stringify(envelope, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const dateStamp = envelope.exportedAt.slice(0, 10);  // YYYY-MM-DD
      const filename = `crsmart-backup-${dateStamp}.json`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // Size readout — gives the user a sense of what they got. KB to
      // one decimal so 350.4 reads as informative, not noisy.
      const sizeKb = (payload.length / 1024).toFixed(1);
      if (status) status.textContent = `✓ saved ${filename} · ${sizeKb} KB`;
    } catch (err) {
      console.warn('[crsmart-popup] backup export failed', err);
      if (status) status.textContent = `error: ${err?.message || err}`;
    } finally {
      syncControlState();  // re-evaluate disabled state
    }
  });

  importBtn.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'crsmart:open-import-tab' });
    } catch (err) {
      console.warn('[crsmart-popup] open-import-tab failed', err);
    }
  });
}

// ── Page navigation ─────────────────────────────────────────────────
// The popup has two pages: 'main' (everything that was already here) and
// 'settings' (surface toggles). We swap visibility rather than animating —
// popup is small enough that crossfade adds no signal, only flicker.
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('hidden', p.dataset.page !== name);
  });
  if (name === 'settings') {
    paintSettingsToggles();
    paintDealbreakers();
  }
}

// ── Dealbreakers section ──────────────────────────────────────────
// Renders active + suggested chips. Active chips click to remove;
// suggested click to promote. Writes through surface-settings so the
// worker's onChanged listener reruns the rerank with the new filter.

// Pitch per-tag for suggested chips — why did this surface. Derived
// from the dimension's blurb so the reason is legible at a glance.
function chipHoverFor(candidate) {
  const score = candidate.score?.toFixed(2) ?? '?';
  const mag = candidate.magnitude?.toFixed(1) ?? '?';
  const base = candidate.blurb ? `${candidate.blurb}\n` : '';
  return `${base}Score ${score} · magnitude ${mag}\n(strongly avoided in your history)`;
}

async function paintDealbreakers() {
  if (!window.SURFACE_SETTINGS) return;
  const [cur, stored] = await Promise.all([
    window.SURFACE_SETTINGS.getSurfaceSettings(),
    chrome.storage.local.get('dealbreakerCandidates'),
  ]);
  const activeTags = Array.isArray(cur.dealbreakerTags) ? cur.dealbreakerTags : [];
  const activeSet = new Set(activeTags);
  const activeHost = document.getElementById('dealbreaker-active');
  const suggestedHost = document.getElementById('dealbreaker-suggested');
  const summary = document.getElementById('dealbreaker-summary');
  const suggestedGroup = document.getElementById('dealbreaker-suggested-group');
  if (!activeHost || !suggestedHost) return;

  // Active chips — currently-excluded tags.
  activeHost.innerHTML = '';
  if (activeTags.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dealbreaker-empty';
    empty.textContent = 'None set. Accept a suggestion below, or leave empty.';
    activeHost.appendChild(empty);
  } else {
    for (const tag of activeTags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dealbreaker-chip active';
      chip.title = 'tap to remove';
      chip.innerHTML = `${tag} <span class="chip-action">×</span>`;
      chip.addEventListener('click', () => removeDealbreaker(tag));
      activeHost.appendChild(chip);
    }
  }

  // Suggested chips — dimension-derived candidates the user hasn't
  // accepted yet (or explicitly removed). Hide if empty so the section
  // doesn't feel noisy when there's nothing to offer.
  const candidates = stored.dealbreakerCandidates?.candidates || [];
  const suggestedCandidates = candidates.filter(c => {
    // Suggestion is a dimension; translate its tag bundle into which
    // AniList tags it would cover. If any are already in activeSet,
    // the suggestion is redundant.
    return c.matched?.some(m => !activeSet.has(m.tag)) ?? false;
  });
  suggestedHost.innerHTML = '';
  if (suggestedCandidates.length === 0) {
    suggestedGroup.style.display = 'none';
  } else {
    suggestedGroup.style.display = '';
    for (const cand of suggestedCandidates) {
      // The dimension's top matched tag (by |weight|) is the one we'd
      // actually add as a dealbreaker — single specific tag is more
      // intelligible than "the whole dimension."
      const topMatch = cand.matched?.find(m => !activeSet.has(m.tag));
      if (!topMatch) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dealbreaker-chip suggested';
      chip.title = chipHoverFor(cand);
      chip.innerHTML = `<span class="chip-action">+</span> ${topMatch.tag}`;
      chip.addEventListener('click', () => addDealbreaker(topMatch.tag));
      suggestedHost.appendChild(chip);
    }
  }

  if (summary) summary.textContent = String(activeTags.length);
}

async function addDealbreaker(tag) {
  const cur = await window.SURFACE_SETTINGS.getSurfaceSettings();
  const next = Array.isArray(cur.dealbreakerTags) ? cur.dealbreakerTags.slice() : [];
  if (next.includes(tag)) return;
  next.push(tag);
  await window.SURFACE_SETTINGS.setSurfaceSettings({ dealbreakerTags: next });
  paintDealbreakers();
}

async function removeDealbreaker(tag) {
  const cur = await window.SURFACE_SETTINGS.getSurfaceSettings();
  const next = (Array.isArray(cur.dealbreakerTags) ? cur.dealbreakerTags : [])
    .filter(t => t !== tag);
  await window.SURFACE_SETTINGS.setSurfaceSettings({ dealbreakerTags: next });
  paintDealbreakers();
}

function wirePages() {
  const openSettings = document.getElementById('open-settings');
  if (openSettings) openSettings.addEventListener('click', () => showPage('settings'));
  const settingsBack = document.getElementById('settings-back');
  if (settingsBack) settingsBack.addEventListener('click', () => showPage('main'));
}

// ── Surface toggles ─────────────────────────────────────────────────
async function paintSettingsToggles() {
  if (!window.SURFACE_SETTINGS) return;
  const cur = await window.SURFACE_SETTINGS.getSurfaceSettings();
  const sp = document.getElementById('setting-side-panel');
  const sh = document.getElementById('setting-show-page-panel');
  const cb = document.getElementById('setting-cover-bleed');
  const cw = document.getElementById('setting-card-width');
  const cwLabel = document.getElementById('card-width-value');
  const hbl = document.getElementById('setting-hero-bg-lock');
  const hbb = document.getElementById('setting-hero-bg-blur');
  const hbbLabel = document.getElementById('hero-bg-blur-value');
  const hbbRow = document.getElementById('setting-hero-bg-blur-row');
  const hbsc = document.getElementById('setting-hero-bg-scale');
  const hbscLabel = document.getElementById('hero-bg-scale-value');
  const hbscRow = document.getElementById('setting-hero-bg-scale-row');
  const hboy = document.getElementById('setting-hero-bg-offset-y');
  const hboyLabel = document.getElementById('hero-bg-offset-y-value');
  const hboyRow = document.getElementById('setting-hero-bg-offset-y-row');
  const hbs = document.getElementById('setting-hero-bg-size');
  const hbsLabel = document.getElementById('hero-bg-size-value');
  const hbsRow = document.getElementById('setting-hero-bg-size-row');
  const hbd = document.getElementById('setting-hero-bg-dark');
  const hbdLabel = document.getElementById('hero-bg-dark-value');
  const hbdRow = document.getElementById('setting-hero-bg-dark-row');
  const hbm = document.getElementById('setting-hero-bg-mid');
  const hbmLabel = document.getElementById('hero-bg-mid-value');
  const hbmRow = document.getElementById('setting-hero-bg-mid-row');
  const hco = document.getElementById('setting-hero-cr-overlay');
  const hcoLabel = document.getElementById('hero-cr-overlay-value');
  const hcoRow = document.getElementById('setting-hero-cr-overlay-row');
  const hcf = document.getElementById('setting-hero-cr-bottom-fade');
  const hcfLabel = document.getElementById('hero-cr-bottom-fade-value');
  const hcfRow = document.getElementById('setting-hero-cr-bottom-fade-row');
  const hce = document.getElementById('setting-hero-cr-bottom-end');
  const hceLabel = document.getElementById('hero-cr-bottom-end-value');
  const hceRow = document.getElementById('setting-hero-cr-bottom-end-row');
  const hcbd = document.getElementById('setting-hero-cr-bottom-dark');
  const hcbdLabel = document.getElementById('hero-cr-bottom-dark-value');
  const hcbdRow = document.getElementById('setting-hero-cr-bottom-dark-row');
  const hcd = document.getElementById('setting-hero-cr-diagonal');
  const hcdLabel = document.getElementById('hero-cr-diagonal-value');
  const hcdRow = document.getElementById('setting-hero-cr-diagonal-row');
  const hcw = document.getElementById('setting-hero-cr-left-wash');
  const hcwLabel = document.getElementById('hero-cr-left-wash-value');
  const hcwRow = document.getElementById('setting-hero-cr-left-wash-row');
  if (sp) sp.checked = !!cur.sidePanel;
  if (sh) sh.checked = !!cur.showPagePanel;
  if (cb) cb.checked = !!cur.coverBleed;
  const gr = document.getElementById('setting-genre-row');
  if (gr) gr.checked = cur.genreRow !== false;
  const ss = document.getElementById('setting-show-spoilers');
  if (ss) ss.checked = cur.showSpoilers === true;
  const das = document.getElementById('setting-dev-axis-sandbox');
  if (das) das.checked = cur.devAxisSandbox === true;
  const dko = document.getElementById('setting-dev-keep-onboarding');
  if (dko) dko.checked = cur.devKeepOnboarding === true;
  const ktb = document.getElementById('setting-keep-tour-button');
  // Honor both the new user-facing key and the legacy dev-only key so a
  // user who'd toggled the dev override doesn't lose their pin after
  // the rename.
  if (ktb) ktb.checked = cur.keepTourButton === true || cur.devKeepTourButton === true;
  // CF re-ranker — top-level cfEnabled storage key (it's an engine flag,
  // not a surface setting, so it lives outside surfaceSettings).
  const dcf = document.getElementById('setting-dev-cf-enabled');
  if (dcf) {
    chrome.storage.local.get('cfEnabled').then(({ cfEnabled }) => {
      dcf.checked = cfEnabled === true;
    });
  }
  // CF dev pills on side panel — separate top-level flag because the
  // toolbar-opened side panel can't carry a ?dev=1 URL parameter.
  const dcp = document.getElementById('setting-dev-cf-pills');
  if (dcp) {
    chrome.storage.local.get('cfDevPills').then(({ cfDevPills }) => {
      dcp.checked = cfDevPills === true;
    });
  }
  // Phase 4: Taste-shape view tunables.
  // Animation tempo (4-state: off / swift / balanced / leisurely).
  // Migrated 2026-05 from the binary tasteShapeIntroAnim checkbox.
  const tempoEl = document.getElementById('setting-taste-shape-anim-tempo');
  if (tempoEl) {
    const tempo = cur.tasteShapeAnimTempo
      || (cur.tasteShapeIntroAnim === false ? 'off' : 'balanced');
    tempoEl.querySelectorAll('.seg').forEach(b => {
      b.classList.toggle('active', b.dataset.val === tempo);
    });
  }
  const tsab = document.getElementById('setting-taste-shape-animate-bg');
  if (tsab) tsab.checked = cur.tasteShapeAnimateBg !== false;
  const tsbo = document.getElementById('setting-taste-shape-bg-opacity');
  const tsboLabel = document.getElementById('taste-shape-bg-opacity-value');
  if (tsbo) tsbo.value = String(cur.tasteShapeBgOpacity ?? 100);
  if (tsboLabel) tsboLabel.textContent = String(cur.tasteShapeBgOpacity ?? 100);
  if (cw) cw.value = String(cur.cardMaxWidth ?? 820);
  if (cwLabel) cwLabel.textContent = String(cur.cardMaxWidth ?? 820);
  const bgLockOn = cur.heroBgLock !== false;
  if (hbl) hbl.checked = bgLockOn;
  if (hbsc) hbsc.value = String(cur.heroBgScale ?? 140);
  if (hbscLabel) hbscLabel.textContent = String(cur.heroBgScale ?? 140);
  if (hbscRow) hbscRow.classList.toggle('disabled', !bgLockOn);
  if (hboy) hboy.value = String(cur.heroBgOffsetY ?? 0);
  if (hboyLabel) hboyLabel.textContent = String(cur.heroBgOffsetY ?? 0);
  if (hboyRow) hboyRow.classList.toggle('disabled', !bgLockOn);
  if (hbb) hbb.value = String(cur.heroBgBlur ?? 16);
  if (hbbLabel) hbbLabel.textContent = String(cur.heroBgBlur ?? 16);
  if (hbbRow) hbbRow.classList.toggle('disabled', !bgLockOn);
  if (hbs) hbs.value = String(cur.heroBgSize ?? 80);
  if (hbsLabel) hbsLabel.textContent = String(cur.heroBgSize ?? 80);
  if (hbsRow) hbsRow.classList.toggle('disabled', !bgLockOn);
  if (hbd) hbd.value = String(cur.heroBgDark ?? 100);
  if (hbdLabel) hbdLabel.textContent = String(cur.heroBgDark ?? 100);
  if (hbdRow) hbdRow.classList.toggle('disabled', !bgLockOn);
  if (hbm) hbm.value = String(cur.heroBgMid ?? 100);
  if (hbmLabel) hbmLabel.textContent = String(cur.heroBgMid ?? 100);
  if (hbmRow) hbmRow.classList.toggle('disabled', !bgLockOn);
  if (hco) hco.value = String(cur.heroCrOverlay ?? 100);
  if (hcoLabel) hcoLabel.textContent = String(cur.heroCrOverlay ?? 100);
  if (hcoRow) hcoRow.classList.toggle('disabled', !bgLockOn);
  if (hcf) hcf.value = String(cur.heroCrBottomFade ?? 45);
  if (hcfLabel) hcfLabel.textContent = String(cur.heroCrBottomFade ?? 45);
  if (hcfRow) hcfRow.classList.toggle('disabled', !bgLockOn);
  if (hce) hce.value = String(cur.heroCrBottomEnd ?? 82);
  if (hceLabel) hceLabel.textContent = String(cur.heroCrBottomEnd ?? 82);
  if (hceRow) hceRow.classList.toggle('disabled', !bgLockOn);
  if (hcbd) hcbd.value = String(cur.heroCrBottomDark ?? 100);
  if (hcbdLabel) hcbdLabel.textContent = String(cur.heroCrBottomDark ?? 100);
  if (hcbdRow) hcbdRow.classList.toggle('disabled', !bgLockOn);
  if (hcd) hcd.value = String(cur.heroCrDiagonal ?? 100);
  if (hcdLabel) hcdLabel.textContent = String(cur.heroCrDiagonal ?? 100);
  if (hcdRow) hcdRow.classList.toggle('disabled', !bgLockOn);
  if (hcw) hcw.value = String(cur.heroCrLeftWash ?? 100);
  if (hcwLabel) hcwLabel.textContent = String(cur.heroCrLeftWash ?? 100);
  if (hcwRow) hcwRow.classList.toggle('disabled', !bgLockOn);
}

function wireSettingsToggles() {
  if (!window.SURFACE_SETTINGS) return;
  const sp = document.getElementById('setting-side-panel');
  const sh = document.getElementById('setting-show-page-panel');
  const cb = document.getElementById('setting-cover-bleed');
  const cw = document.getElementById('setting-card-width');
  const cwLabel = document.getElementById('card-width-value');
  const hbl = document.getElementById('setting-hero-bg-lock');
  const hbb = document.getElementById('setting-hero-bg-blur');
  const hbbLabel = document.getElementById('hero-bg-blur-value');
  const hbbRow = document.getElementById('setting-hero-bg-blur-row');
  const hbsc = document.getElementById('setting-hero-bg-scale');
  const hbscLabel = document.getElementById('hero-bg-scale-value');
  const hbscRow = document.getElementById('setting-hero-bg-scale-row');
  const hboy = document.getElementById('setting-hero-bg-offset-y');
  const hboyLabel = document.getElementById('hero-bg-offset-y-value');
  const hboyRow = document.getElementById('setting-hero-bg-offset-y-row');
  const hbs = document.getElementById('setting-hero-bg-size');
  const hbsLabel = document.getElementById('hero-bg-size-value');
  const hbsRow = document.getElementById('setting-hero-bg-size-row');
  const hbd = document.getElementById('setting-hero-bg-dark');
  const hbdLabel = document.getElementById('hero-bg-dark-value');
  const hbdRow = document.getElementById('setting-hero-bg-dark-row');
  const hbm = document.getElementById('setting-hero-bg-mid');
  const hbmLabel = document.getElementById('hero-bg-mid-value');
  const hbmRow = document.getElementById('setting-hero-bg-mid-row');
  const hco = document.getElementById('setting-hero-cr-overlay');
  const hcoLabel = document.getElementById('hero-cr-overlay-value');
  const hcoRow = document.getElementById('setting-hero-cr-overlay-row');
  const hcf = document.getElementById('setting-hero-cr-bottom-fade');
  const hcfLabel = document.getElementById('hero-cr-bottom-fade-value');
  const hcfRow = document.getElementById('setting-hero-cr-bottom-fade-row');
  const hce = document.getElementById('setting-hero-cr-bottom-end');
  const hceLabel = document.getElementById('hero-cr-bottom-end-value');
  const hceRow = document.getElementById('setting-hero-cr-bottom-end-row');
  const hcbd = document.getElementById('setting-hero-cr-bottom-dark');
  const hcbdLabel = document.getElementById('hero-cr-bottom-dark-value');
  const hcbdRow = document.getElementById('setting-hero-cr-bottom-dark-row');
  const hcd = document.getElementById('setting-hero-cr-diagonal');
  const hcdLabel = document.getElementById('hero-cr-diagonal-value');
  const hcdRow = document.getElementById('setting-hero-cr-diagonal-row');
  const hcw = document.getElementById('setting-hero-cr-left-wash');
  const hcwLabel = document.getElementById('hero-cr-left-wash-value');
  const hcwRow = document.getElementById('setting-hero-cr-left-wash-row');
  if (sp) sp.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ sidePanel: sp.checked });
  });
  if (sh) sh.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ showPagePanel: sh.checked });
  });
  if (cb) cb.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ coverBleed: cb.checked });
  });
  const gr = document.getElementById('setting-genre-row');
  if (gr) gr.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ genreRow: gr.checked });
  });
  const ss = document.getElementById('setting-show-spoilers');
  if (ss) ss.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ showSpoilers: ss.checked });
  });
  const das = document.getElementById('setting-dev-axis-sandbox');
  if (das) das.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ devAxisSandbox: das.checked });
  });
  const dko = document.getElementById('setting-dev-keep-onboarding');
  if (dko) dko.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ devKeepOnboarding: dko.checked });
  });
  const ktb = document.getElementById('setting-keep-tour-button');
  if (ktb) ktb.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ keepTourButton: ktb.checked });
  });
  const dcf = document.getElementById('setting-dev-cf-enabled');
  if (dcf) dcf.addEventListener('change', () => {
    chrome.storage.local.set({ cfEnabled: dcf.checked });
    // No immediate visual change — the next rec recompute pass picks
    // up the new flag. the user can force one by adjusting any rating
    // or reaction.
  });
  const dcp = document.getElementById('setting-dev-cf-pills');
  if (dcp) dcp.addEventListener('change', () => {
    chrome.storage.local.set({ cfDevPills: dcp.checked });
    // Side panel listens for this via storage.onChanged and re-renders
    // the next card paint — no reload needed.
  });
  // "Show me around again" — re-fires the onboarding tour overlay
  // AND clears coachMarksSeen so the picks/shape/card coach marks
  // also re-fire. Tour lives on CR (not as a tab), so we delegate to
  // background.js's show-tour handler which finds an open CR tab or
  // opens one with a session-flag handoff.
  const rwBtn = document.getElementById('reopen-welcome-btn');
  if (rwBtn) rwBtn.addEventListener('click', async () => {
    try {
      await chrome.storage.local.remove('coachMarksSeen');
    } catch (_) {}
    try {
      await chrome.runtime.sendMessage({ type: 'crsmart:show-tour' });
    } catch (_) {}
    window.close();
  });
  // Phase 4: Taste-shape view tunables.
  // Animation tempo segmented control (off / swift / balanced /
  // leisurely). Click handler delegated on the container — each seg
  // button writes its data-val to surfaceSettings.tasteShapeAnimTempo.
  // Also clears the legacy tasteShapeIntroAnim key so a future re-read
  // doesn't get a stale binary value (migration shim still treats
  // missing as 'balanced').
  const tempoEl = document.getElementById('setting-taste-shape-anim-tempo');
  if (tempoEl) tempoEl.addEventListener('click', e => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    tempoEl.querySelectorAll('.seg').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    window.SURFACE_SETTINGS.setSurfaceSettings({
      tasteShapeAnimTempo: btn.dataset.val,
      tasteShapeIntroAnim: btn.dataset.val !== 'off',
    });
  });
  const tsab = document.getElementById('setting-taste-shape-animate-bg');
  if (tsab) tsab.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ tasteShapeAnimateBg: tsab.checked });
  });
  const tsbo = document.getElementById('setting-taste-shape-bg-opacity');
  const tsboLabel = document.getElementById('taste-shape-bg-opacity-value');
  if (tsbo) tsbo.addEventListener('input', () => {
    const val = parseInt(tsbo.value, 10);
    if (tsboLabel) tsboLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ tasteShapeBgOpacity: val });
  });
  if (cw) cw.addEventListener('input', () => {
    const val = parseInt(cw.value, 10);
    if (cwLabel) cwLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ cardMaxWidth: val });
  });
  if (hbl) hbl.addEventListener('change', () => {
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroBgLock: hbl.checked });
    for (const [row, el] of [[hbscRow, hbsc], [hboyRow, hboy], [hbbRow, hbb], [hbsRow, hbs], [hbdRow, hbd], [hbmRow, hbm], [hcoRow, hco], [hcfRow, hcf], [hceRow, hce], [hcbdRow, hcbd], [hcdRow, hcd], [hcwRow, hcw]]) {
      if (row) row.classList.toggle('disabled', !hbl.checked);
      if (el) el.disabled = !hbl.checked;
    }
  });
  if (hbsc) hbsc.addEventListener('input', () => {
    const val = parseInt(hbsc.value, 10);
    if (hbscLabel) hbscLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroBgScale: val });
  });
  if (hboy) hboy.addEventListener('input', () => {
    const val = parseInt(hboy.value, 10);
    if (hboyLabel) hboyLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroBgOffsetY: val });
  });
  if (hbb) hbb.addEventListener('input', () => {
    const val = parseInt(hbb.value, 10);
    if (hbbLabel) hbbLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroBgBlur: val });
  });
  if (hbs) hbs.addEventListener('input', () => {
    const val = parseInt(hbs.value, 10);
    if (hbsLabel) hbsLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroBgSize: val });
  });
  if (hbd) hbd.addEventListener('input', () => {
    const val = parseInt(hbd.value, 10);
    if (hbdLabel) hbdLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroBgDark: val });
  });
  if (hbm) hbm.addEventListener('input', () => {
    const val = parseInt(hbm.value, 10);
    if (hbmLabel) hbmLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroBgMid: val });
  });
  if (hco) hco.addEventListener('input', () => {
    const val = parseInt(hco.value, 10);
    if (hcoLabel) hcoLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroCrOverlay: val });
  });
  if (hcf) hcf.addEventListener('input', () => {
    const val = parseInt(hcf.value, 10);
    if (hcfLabel) hcfLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroCrBottomFade: val });
  });
  if (hce) hce.addEventListener('input', () => {
    const val = parseInt(hce.value, 10);
    if (hceLabel) hceLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroCrBottomEnd: val });
  });
  if (hcbd) hcbd.addEventListener('input', () => {
    const val = parseInt(hcbd.value, 10);
    if (hcbdLabel) hcbdLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroCrBottomDark: val });
  });
  if (hcd) hcd.addEventListener('input', () => {
    const val = parseInt(hcd.value, 10);
    if (hcdLabel) hcdLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroCrDiagonal: val });
  });
  if (hcw) hcw.addEventListener('input', () => {
    const val = parseInt(hcw.value, 10);
    if (hcwLabel) hcwLabel.textContent = String(val);
    window.SURFACE_SETTINGS.setSurfaceSettings({ heroCrLeftWash: val });
  });
}

async function init() {
  renderArchetypes();
  wireCollapsibles();
  wireStorageLiveUpdate();
  wireHistoryRefresh();
  wireSurveyOpen();
  wireMalXmlOpen();
  wireFreeformOpen();
  wireSurveyClearButton();
  wirePages();
  wireSettingsToggles();
  wireValidateSnapshot();
  wireCrCatalogExport();
  wireBackupRestore();
  wireEngineHealth();
  wireStartHereBanner();
  refreshStatus();
  refreshHistoryCount();
  refreshSurveyFootprint();
  refreshSyncProgress();
  refreshEngineHealth();
  refreshStartHereBanner();
  refreshProfileCompleteness();
}

// Profile-completeness — turns the placeholder bar into a real
// percentage based on which signals exist, plus a one-line reason
// explaining the next biggest lever. Four buckets contribute, each
// worth 25% at full saturation:
//
//   - CR watch history (≥1 watch-shape)   — 25%
//   - AniList or MAL link with imports    — 25%
//   - Quick Taste Check survey (≥10 taps) — 25%
//   - Calibrated signal (≥80 watch shapes
//     OR ≥30 survey taps)                 — 25%
//
// The reason line surfaces the cheapest unfilled bucket so the user
// knows what one move will move the needle most.
async function refreshProfileCompleteness() {
  const fillEl = document.getElementById('completeness-fill');
  const numEl  = document.getElementById('completeness-num');
  const reason = document.getElementById('completeness-reason');
  if (!fillEl || !numEl) return;
  try {
    const stored = await chrome.storage.local.get([
      'watchShapes',
      'surveyShapes',
      'surveyTagShapes',
    ]);
    const watchSummary = stored.watchShapes?.summary || {};
    const watchCount = (watchSummary.completed || 0) + (watchSummary.inProgress || 0)
                     + (watchSummary.sampled || 0)  + (watchSummary.paused || 0)
                     + (watchSummary.droppedEarly || 0) + (watchSummary.droppedMid || 0);
    const surveyCount = Object.keys(stored.surveyShapes || {}).length
                      + Object.keys(stored.surveyTagShapes || {}).length;

    let hasLinked = false;
    let externalImported = 0;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'crsmart:external:status' });
      hasLinked = !!(resp?.ok && (resp.linked || []).length > 0);
      externalImported = (resp?.importStats?.byProvider || [])
        .reduce((s, p) => s + (p.imported || 0), 0);
    } catch {}

    const buckets = [
      { name: 'CR history',     done: watchCount > 0,
        nudge: 'Watch a few shows on Crunchyroll' },
      { name: 'External list',  done: hasLinked && externalImported > 0,
        nudge: 'Connect AniList or MAL to add a richer signal' },
      { name: 'Survey taps',    done: surveyCount >= 10,
        nudge: 'Take the Quick Taste Check (~3 min, ~10 taps)' },
      { name: 'Calibrated',     done: watchCount >= 80 || surveyCount >= 30,
        nudge: surveyCount > 0 || watchCount > 0
          ? 'Watch (or tap) more — the engine sharpens past ~80 shows'
          : 'Any signal at all — watch, tap, or import' },
    ];
    const doneCount = buckets.filter(b => b.done).length;
    const pct = doneCount * 25;

    fillEl.style.width = `${pct}%`;
    numEl.textContent = `${pct}%`;

    if (reason) {
      const firstUnfilled = buckets.find(b => !b.done);
      if (!firstUnfilled) {
        reason.innerHTML = '<strong>Strong signal across the board.</strong> ' +
          'The engine has plenty to work with — recs should be sharp.';
      } else if (pct === 0) {
        reason.innerHTML = `<strong>${firstUnfilled.nudge}</strong> ` +
          'to get the engine off zero.';
      } else {
        reason.innerHTML = `Next biggest lever: <strong>${firstUnfilled.nudge}</strong>.`;
      }
    }
  } catch (err) {
    console.warn('[crsmart-popup] refreshProfileCompleteness failed', err);
  }
}

// "Start here" empty-state banner — three modes:
//   - cold          : never opened the welcome tab. "Start here" CTA
//                     opens it.
//   - reengage      : opened welcome ≥24h ago but no progress signal
//                     (no survey tap / no AniList import / no CR sync
//                     produced any watch-shape). "Resume setup" CTA
//                     re-opens welcome; "not now" mutes for 48h.
//   - anilist-stuck : chose AniList path ≥5min ago but no import
//                     completion signal. "Retry AniList" CTA jumps
//                     straight to the AniList connect; "not now" mutes.
// All modes auto-hide once any progress signal lands.
function wireStartHereBanner() {
  const btn = document.getElementById('start-here-btn');
  const dismissBtn = document.getElementById('start-here-dismiss');
  if (btn) btn.addEventListener('click', async () => {
    const banner = document.getElementById('start-here-banner');
    const mode = banner?.dataset?.mode || 'cold';
    if (mode === 'anilist-stuck') {
      // Skip the tour — go straight to the AniList row's connect
      // action. Wire by clicking it programmatically so the existing
      // handler runs (auth flow, sign-in, import kickoff).
      const connectBtn = document.querySelector(
        '#source-anilist [data-action="connect"]');
      if (connectBtn) {
        connectBtn.click();
        return;
      }
    }
    // Cold + reengage modes both fire the tour. Background's
    // show-tour handler does the smart fallback (focus existing CR
    // tab + message it; else open CR + session flag).
    try {
      await chrome.runtime.sendMessage({ type: 'crsmart:show-tour' });
    } catch (err) {
      console.warn('[crsmart-popup] show-tour message failed', err);
    }
    window.close();
  });
  if (dismissBtn) dismissBtn.addEventListener('click', async () => {
    try {
      await chrome.storage.local.set({ welcomeReengageDismissedAt: Date.now() });
    } catch {}
    refreshStartHereBanner();
  });
}

// Re-engage / anilist-stuck thresholds — kept generous so we don't
// nag a user who's just reading the popup mid-install.
const REENGAGE_AGE_MS = 24 * 60 * 60 * 1000;       // 24h since welcomeSeen
const ANILIST_STUCK_AGE_MS = 5 * 60 * 1000;        // 5min since anilist choice
const NUDGE_MUTE_MS = 48 * 60 * 60 * 1000;         // dismiss mutes for 48h

// Funnel state painter — pure DOM mutation, no async. Three steps,
// each one resolves to (done | active | pending). Welcome is done
// once welcomeSeen exists; build is done once any taste signal
// exists; picks is done once welcomeCompletedAt is set. The "active"
// dot tracks the next pending step so the user always sees forward motion.
function syncPopupFunnel({ welcomeOpened, hasBuildSignal, hasPicksSignal }) {
  const steps = [
    { id: 'popup-funnel-welcome', done: welcomeOpened },
    { id: 'popup-funnel-build',   done: hasBuildSignal },
    { id: 'popup-funnel-picks',   done: hasPicksSignal },
  ];
  let firstPending = -1;
  steps.forEach((s, i) => {
    const el = document.getElementById(s.id);
    if (!el) return;
    el.classList.remove('is-done', 'is-active');
    if (s.done) el.classList.add('is-done');
    else if (firstPending === -1) {
      el.classList.add('is-active');
      firstPending = i;
    }
  });
}

async function refreshStartHereBanner() {
  const banner = document.getElementById('start-here-banner');
  const titleEl = document.getElementById('start-here-title');
  const bodyEl = document.getElementById('start-here-body');
  const btn = document.getElementById('start-here-btn');
  const dismissBtn = document.getElementById('start-here-dismiss');
  const funnel = document.getElementById('popup-funnel');
  if (!banner || !titleEl || !bodyEl || !btn) return;
  try {
    const stored = await chrome.storage.local.get([
      'surveyShapes',
      'surveyTagShapes',
      'tourSeen',
      'welcomeCompletedAt',
      'welcomeReengageDismissedAt',
    ]);
    const hasSurveySignal =
      (stored.surveyShapes && Object.keys(stored.surveyShapes).length > 0) ||
      (stored.surveyTagShapes && Object.keys(stored.surveyTagShapes).length > 0);

    let hasLinked = false;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'crsmart:external:status' });
      hasLinked = !!(resp?.ok && (resp.linked || []).length > 0);
    } catch {}

    // Update funnel state — same shape every refresh so the user
    // sees their progress reflected even if the banner is hidden.
    // tourSeen.at is the "Welcome step done" signal (it's set the
    // first time the tour modal mounts, on install or re-watch).
    syncPopupFunnel({
      welcomeOpened: !!stored.tourSeen?.at,
      hasBuildSignal: hasSurveySignal || hasLinked,
      hasPicksSignal: !!stored.welcomeCompletedAt,
    });

    // If any signal lands we're done — also true if welcomeCompletedAt
    // is set (cr-history sync may produce signal without surveyShapes).
    const hasAnySignal = hasSurveySignal || hasLinked || !!stored.welcomeCompletedAt;
    if (hasAnySignal) {
      banner.hidden = true;
      // Keep the funnel visible until ALL three are done so the user
      // sees the milestone resolve. Hide once picks-stage lands too.
      if (funnel) funnel.hidden = !!stored.welcomeCompletedAt;
      return;
    }
    if (funnel) funnel.hidden = false;

    // Muted by recent "not now" tap?
    const dismissedAt = stored.welcomeReengageDismissedAt || 0;
    if (dismissedAt && (Date.now() - dismissedAt) < NUDGE_MUTE_MS) {
      banner.hidden = true;
      return;
    }

    const tourSeen = stored.tourSeen;
    const tourAgeMs = tourSeen?.at ? (Date.now() - tourSeen.at) : Infinity;

    // Mode resolution:
    //   1. Never opened tour → cold
    //   2. Tour opened, AniList chosen, ≥5min ago, no import → anilist-stuck
    //   3. Tour opened ≥24h ago, no progress → reengage
    //   4. Tour opened recently → cold (still in active install window;
    //      don't nag during the first 24h so a user mid-flow isn't pushed)
    let mode = 'cold';
    if (tourSeen) {
      if (tourSeen.choice === 'anilist' && tourAgeMs >= ANILIST_STUCK_AGE_MS) {
        mode = 'anilist-stuck';
      } else if (tourAgeMs >= REENGAGE_AGE_MS) {
        mode = 'reengage';
      } else {
        // Tour opened, no signal yet, but we're still inside the active
        // install window — hide the banner rather than nag.
        banner.hidden = true;
        return;
      }
    }

    banner.dataset.mode = mode;
    if (mode === 'cold') {
      titleEl.textContent = 'Pick how to start';
      bodyEl.textContent =
        'Smart Scoring needs a tiny bit of taste signal to recommend ' +
        'well. Three minutes is plenty.';
      btn.textContent = 'Start here';
      if (dismissBtn) dismissBtn.hidden = true;
    } else if (mode === 'reengage') {
      titleEl.textContent = 'Pick up where you left off';
      bodyEl.textContent =
        "Looks like setup didn't finish. ~3 minutes in the Quick Taste " +
        "Check is enough to start getting picks.";
      btn.textContent = 'Resume setup';
      if (dismissBtn) dismissBtn.hidden = false;
    } else if (mode === 'anilist-stuck') {
      titleEl.textContent = "AniList didn't finish";
      bodyEl.textContent =
        "The AniList import didn't land — could be a sign-in cancel, a " +
        "rate limit, or a network blip. Retry from here.";
      btn.textContent = 'Retry AniList';
      if (dismissBtn) dismissBtn.hidden = false;
    }
    banner.hidden = false;
  } catch (err) {
    console.warn('[crsmart-popup] refreshStartHereBanner failed', err);
  }
}
init();

// ── Engine health section ───────────────────────────────────────
// Populates the status-at-a-glance summary + the expanded grid.
// Reads `_engineHealth`, `_engineErrors`, `_anilistRateLimit`,
// `allShowsScoredMeta` from chrome.storage. Live-updates on change.

function relTime(iso) {
  if (!iso) return null;
  const t = typeof iso === 'string' ? Date.parse(iso) : iso;
  if (!Number.isFinite(t)) return null;
  const ageMs = Date.now() - t;
  if (ageMs < 0) return 'just now';
  const sec = Math.round(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function wireEngineHealth() {
  if (!chrome?.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes._engineHealth || changes._engineErrors
        || changes._anilistRateLimit || changes.allShowsScoredMeta) {
      refreshEngineHealth();
    }
  });
}

async function refreshEngineHealth() {
  const summary = document.getElementById('engine-status-summary');
  const grid = document.getElementById('engine-grid');
  const foot = document.getElementById('engine-foot');
  if (!grid || !summary) return;

  const { _engineHealth: health, _engineErrors: errors, _anilistRateLimit: rateLimit,
    allShowsScoredMeta: scoredMeta } = await chrome.storage.local.get([
    '_engineHealth', '_engineErrors', '_anilistRateLimit', 'allShowsScoredMeta',
  ]);

  // Summary line: "synced 2m ago · 638 shows" or "no data" or "stale"
  if (!health) {
    summary.textContent = 'no recompute yet';
    grid.innerHTML = '<div class="engine-key">status</div><div class="engine-val">waiting for first recompute</div>';
    if (foot) foot.textContent = '';
    return;
  }
  const ageStr = relTime(health.lastRecomputeAt || health.recordedAt);
  const ageMs = Date.now() - (Date.parse(health.lastRecomputeAt || health.recordedAt) || 0);
  const stale = ageMs > 24 * 60 * 60 * 1000;
  const scoredCount = scoredMeta?.entryCount ?? '?';
  summary.textContent = `synced ${ageStr || '?'} · ${scoredCount} shows`;

  const rows = [];
  rows.push(['last recompute', ageStr ? `${ageStr} (${health.lastRecomputeMs}ms)` : '?', stale ? 'warn' : '']);
  rows.push(['signal', health.lastRecomputeSignal || '?', '']);
  rows.push(['schema version', String(health.schemaVersion ?? '?'), '']);
  rows.push(['scored entries', String(scoredCount), '']);

  // Errors: count + most recent.
  const errCount = Array.isArray(errors) ? errors.length : 0;
  if (errCount > 0) {
    const last = errors[errors.length - 1];
    rows.push(['recent errors', `${errCount} (last: ${last?.source || '?'})`, errCount >= 5 ? 'bad' : 'warn']);
  } else {
    rows.push(['recent errors', 'none', '']);
  }

  // Rate-limit telemetry (optional; populated when the AniList path
  // tracks 429 events explicitly — currently not wired but the slot
  // is here for when it is).
  if (rateLimit && (rateLimit.count429s || rateLimit.totalBackoffMs)) {
    const ms = rateLimit.totalBackoffMs || 0;
    const sec = Math.round(ms / 1000);
    rows.push(['rate-limit hits', `${rateLimit.count429s || 0} (${sec}s backoff)`, sec > 30 ? 'warn' : '']);
  }

  grid.innerHTML = rows.map(([k, v, cls]) =>
    `<div class="engine-key">${k}</div><div class="engine-val${cls ? ' ' + cls : ''}">${v}</div>`
  ).join('');

  if (foot) {
    if (stale) {
      foot.textContent = 'Engine hasn\'t recomputed in over a day. Check Crunchyroll history sync.';
    } else if (errCount >= 5) {
      foot.textContent = `${errCount} recent errors logged. Check the worker console for details.`;
    } else {
      foot.textContent = 'Engine healthy.';
    }
  }
}

// ── External-source rows in profile completeness ────────────────
// AniList + MAL live as rows in the existing source-list (matching
// the CR / Quick taste check rows visually) rather than a separate
// section. State is driven by background.js's `crsmart:external:*`
// message handler; we render into pre-existing DOM elements rather
// than building a new collapsible.
//
// Per-row states + button labels:
//   not linked, configured       → icon '+',  button 'connect'
//   not linked, NOT configured   → icon '+',  button 'soon' (disabled, dimmed row)
//   linked, no import in flight  → icon '✓',  button 'import'
//   linked, import in progress   → icon '✓',  button '…' (disabled), subtitle = phase + progress
//   linked, errored last attempt → icon '✓',  button 'retry', subtitle = error
//
// Import progress polls _importState every 1.5s while a phase is
// active; when phase clears (or hits 'error'), polling stops.

const EXTERNAL_SOURCE_DISPLAY = { anilist: 'AniList', mal: 'MyAnimeList' };
let externalLastError = {}; // per-source { message, code } from last action

async function externalSendMessage(type, extras = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extras }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, code: 'send-failed', message: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, code: 'no-response' });
    });
  });
}

// Row state derivation + DOM application moved to source-row.js
// (the canonical seam for "what can a source row be in?"). This file
// now only handles: which DOM element to target, which inputs to gather
// from refreshExternalPanel's response, and binding the impact-panel
// renderer (which stays here because it owns the impact-table HTML).
function renderExternalRow(source, inputs) {
  const row = document.getElementById(`source-${source}`);
  if (!row) return;
  const state = deriveSourceRowState({ kind: 'oauth', source, ...inputs });
  applyRowVisuals(row, state, { renderImpact: renderImpactPanel });
  // AniList links by public username (no OAuth): show the username field only
  // while not linked. Once linked, the row shows the account + import/resync.
  if (source === 'anilist') {
    const uInput = row.querySelector('[data-role="username"]');
    if (uInput) {
      uInput.hidden = !!inputs.linked;
      if (inputs.linked) uInput.value = '';
    }
  }
}

async function refreshExternalPanel() {
  const resp = await externalSendMessage('crsmart:external:status');
  if (!resp?.ok) return;
  const linkedSet = new Set(resp.linked || []);
  const configured = resp.configured || { anilist: true, mal: true };
  for (const source of ['anilist', 'mal']) {
    renderExternalRow(source, {
      configured: configured[source] !== false,
      linked: linkedSet.has(source),
      account: resp.accounts?.[source] || null,
      importState: resp.importState || null,
      lastError: externalLastError[source] || null,
      stats: resp.importStats?.[source] || null,
      impact: resp.importImpact?.[source] || null,
    });
  }
  // MAL OAuth row stays hidden when the client ID is still a TODO
  // placeholder — the "coming soon" subtitle is honest but confusing
  // when there's already a working XML-import row directly below.
  // Only reveal the OAuth row when it's actually configured AND
  // either linked or in dev mode.
  const malRow = document.getElementById('source-mal');
  if (malRow) {
    const malConfigured = configured.mal !== false;
    const shouldShow = malConfigured && (
      linkedSet.has('mal') || document.documentElement.classList.contains('crsmart-dev')
    );
    if (shouldShow) malRow.removeAttribute('hidden');
    else malRow.setAttribute('hidden', '');
  }
  // MAL XML row: subtitle + clear + impact when MAL data is present.
  // Renders independently of OAuth — the externalScores key carries
  // 'mal'-tagged entries regardless of import path.
  renderMalXmlRow({
    stats: resp.importStats?.mal || null,
    impact: resp.importImpact?.mal || null,
  });
  // Freeform-notes row — same shape as MAL XML (no OAuth, drag-drop
  // import surface, "clear" button instead of "signout"). The stats
  // + impact slots are already populated by the SW since
  // computeExternalImportStats / computeExternalImportImpact iterate
  // source keys generically.
  renderFreeformRow({
    stats: resp.importStats?.freeform || null,
    impact: resp.importImpact?.freeform || null,
  });
  // _importState updates arrive via subscribeImportState (see the
  // unsubscribe wiring at wireExternalRows). No polling.
}

async function externalActionLink(source) {
  externalLastError[source] = null;
  const extras = { source };
  // AniList: link by public username (no OAuth). Gather it from the row input.
  if (source === 'anilist') {
    const row = document.getElementById('source-anilist');
    const uInput = row?.querySelector('[data-role="username"]');
    const userName = (uInput?.value || '').trim();
    if (!userName) {
      externalLastError[source] = { code: 'no-username', message: 'enter your AniList username' };
      if (uInput) { uInput.hidden = false; uInput.focus(); }
      await refreshExternalPanel();
      return;
    }
    extras.userName = userName;
  }
  console.log(`[crsmart:popup] externalActionLink(${source}) → sending crsmart:external:link`);
  const resp = await externalSendMessage('crsmart:external:link', extras);
  console.log(`[crsmart:popup] externalActionLink(${source}) ← response`, resp);
  if (!resp.ok) {
    // Surface the failure in the row subtitle (deriveSourceRowState shows
    // lastError.message even when not linked). For AniList username links the
    // common cases are a typo or a private list.
    externalLastError[source] = {
      code: resp.code,
      message: resp.code === 'reauth_required'
        ? 'session expired — connect again'
        : resp.code === 'cancelled'
          ? `link cancelled: ${resp.message || 'no redirect received'}`
          : `${resp.message || `link failed: ${resp.code || 'unknown'}`}`,
    };
    await refreshExternalPanel();
    return;
  }
  // Linked OK — reflect it immediately, then auto-start the import so one
  // "connect" does the whole thing (validate username → fetch list → import),
  // with the row showing live progress ("fetching list…", "imported N").
  await refreshExternalPanel();
  await externalActionImport(source);
}

async function externalActionImport(source) {
  externalLastError[source] = null;
  // Don't await — import can run for minutes; status polling covers
  // the rest. The promise's eventual resolution surfaces failures
  // via lastError so the row can flip to a 'retry' state.
  externalSendMessage('crsmart:external:start-import', { source }).then((resp) => {
    if (!resp.ok) {
      if (resp.code === 'reauth_required') {
        externalLastError[source] = { code: resp.code, message: 'session expired — reconnect' };
      } else if (resp.code !== 'cancelled') {
        externalLastError[source] = { code: resp.code, message: `import failed: ${resp.message || 'unknown'}` };
      }
    }
    refreshExternalPanel();
  });
  await refreshExternalPanel();
}

// Format a delta value with arrow + sign. Used by the impact panel.
function formatDelta(item, valKey) {
  if (item.before == null && item.after != null) {
    return { text: `+${(item.after).toFixed(valKey === 'magnitude' ? 1 : 3)} (new)`, klass: 'new' };
  }
  if (item.after == null && item.before != null) {
    return { text: `dropped from top-5`, klass: 'gone' };
  }
  if (item.delta == null) return { text: '—', klass: '' };
  const arrow = item.delta > 0 ? '↑' : item.delta < 0 ? '↓' : '·';
  const klass = item.delta > 0 ? 'up' : item.delta < 0 ? 'down' : '';
  const fmt = valKey === 'magnitude' ? Math.abs(item.delta).toFixed(1) : Math.abs(item.delta).toFixed(3);
  return { text: `${arrow} ${fmt}`, klass };
}

function renderImpactSection(label, items, valKey) {
  if (!items || items.length === 0) return '';
  const rows = items.slice(0, 6).map(item => {
    const d = formatDelta(item, valKey);
    return `<div class="impact-row">
      <span class="impact-name">${escapeHtml(item.name)}</span>
      <span class="impact-delta ${d.klass}">${escapeHtml(d.text)}</span>
    </div>`;
  }).join('');
  return `<div class="impact-section">
    <div class="impact-section-title">${escapeHtml(label)}</div>
    ${rows}
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// MAL XML row — same renderer + state derivation as the OAuth path,
// just with kind:'xml' so deriveSourceRowState picks the XML branch.
// The row's structure differs (no resync button, "clear" instead of
// "signout") but the state shape is identical.
function renderMalXmlRow({ stats, impact }) {
  const row = document.getElementById('source-mal-xml');
  if (!row) return;
  const state = deriveSourceRowState({ kind: 'xml', stats, impact });
  applyRowVisuals(row, state, { renderImpact: renderImpactPanel });
}

// Freeform-notes row — identical shape to MAL XML: file-import (or
// paste) surface, "clear" button instead of "signout", impact panel.
// Reuses the xml state-derivation branch since they're structurally
// the same row.
function renderFreeformRow({ stats, impact }) {
  const row = document.getElementById('source-freeform');
  if (!row) return;
  const state = deriveSourceRowState({ kind: 'xml', stats, impact });
  applyRowVisuals(row, state, { renderImpact: renderImpactPanel });
}

function renderImpactPanel(row, impact) {
  const toggle = row.querySelector('[data-role="impact-toggle"]');
  const panel = row.querySelector('[data-role="impact"]');
  if (!toggle || !panel) return;
  if (!impact) {
    toggle.hidden = true;
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  toggle.hidden = false;
  // Summary line — top-level metrics that always make sense.
  const tagDelta = impact.tags?.delta ?? 0;
  const summaryParts = [];
  if (tagDelta !== 0) {
    summaryParts.push(`${tagDelta > 0 ? '+' : ''}${tagDelta} tags`);
  }
  if (impact.contributing && impact.contributing.delta != null && impact.contributing.delta !== 0) {
    summaryParts.push(`${impact.contributing.delta > 0 ? '+' : ''}${impact.contributing.delta} contributing series`);
  }
  const summary = summaryParts.length > 0
    ? summaryParts.join(' · ')
    : 'no measurable shift';

  panel.innerHTML = `
    <div class="impact-summary">After import: ${summary}</div>
    ${renderImpactSection('archetypes', impact.archetypes, 'score')}
    ${renderImpactSection('studios', impact.studios, 'weight')}
    ${renderImpactSection('dimensions', impact.dimensions, 'magnitude')}
  `;
}

function wireExternalRows() {
  // Single delegated handler — the button text changes between
  // 'connect' / 'import' / 'soon' / etc., but data-action carries
  // the intent so we don't have to introspect text.
  let wired = 0;
  for (const source of ['anilist', 'mal']) {
    const row = document.getElementById(`source-${source}`);
    if (!row) { console.warn(`[crsmart:popup] missing row #source-${source}`); continue; }
    const btn = row.querySelector('.source-action');
    if (!btn) { console.warn(`[crsmart:popup] missing button in #source-${source}`); continue; }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const action = btn.dataset.action;
      console.log(`[crsmart:popup] external click: source=${source} action=${action} disabled=${btn.disabled}`);
      if (action === 'connect') externalActionLink(source);
      else if (action === 'import') externalActionImport(source);
      // 'soon' / 'busy' are no-ops; button is disabled but defensive.
    });
    // Impact-panel toggle. The panel's content is populated by
    // renderImpactPanel during render; this just flips visibility.
    const toggle = row.querySelector('[data-role="impact-toggle"]');
    const panel = row.querySelector('[data-role="impact"]');
    if (toggle && panel) {
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const isOpen = !panel.hidden;
        panel.hidden = isOpen;
        toggle.classList.toggle('is-open', !isOpen);
      });
    }
    // Resync icon-button — same code path as the right-side "import"
    // button, but more discoverable in the linked state. AniList's
    // re-fetch is incremental at the enrichment layer (already-cached
    // shows skip the per-show GraphQL fetch), so this is cheap.
    const resyncBtn = row.querySelector('[data-role="resync"]');
    if (resyncBtn) {
      resyncBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (resyncBtn.disabled) return;
        externalActionImport(source);
      });
    }
    // Disconnect icon-button — clears stored OAuth tokens + account
    // via crsmart:external:sign-out. After it resolves, a fresh
    // refreshExternalPanel call flips the row back to the +/connect
    // resting state. Doesn't drop already-imported externalScores
    // (those persist independently — disconnecting just stops future
    // re-syncs, doesn't undo past imports).
    const signoutBtn = row.querySelector('[data-role="signout"]');
    if (signoutBtn) {
      signoutBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (signoutBtn.disabled) return;
        signoutBtn.disabled = true;
        try {
          const resp = await externalSendMessage('crsmart:external:sign-out', { source });
          if (!resp?.ok) {
            console.warn(`[crsmart:popup] sign-out(${source}) failed:`, resp);
          }
        } finally {
          await refreshExternalPanel();
        }
      });
    }
    wired++;
  }
  console.log(`[crsmart:popup] external rows wired: ${wired}/2`);
  refreshExternalPanel();

  // Subscribe to _importState changes so the row updates instantly
  // when the importer crosses a phase boundary, instead of the popup
  // polling every 1500ms. refreshExternalPanel re-fetches the full
  // status (which also re-reads _importState via the SW handler), but
  // any change is the trigger.
  //
  // The listener is naturally cleaned up when the popup's JS context
  // dies on close — no explicit unsubscribe required for this surface.
  subscribeImportState(() => {
    refreshExternalPanel();
  });
}

// Fire after DOMContentLoaded — popup.html parses synchronously, so
// by the time this script reaches its tail the elements exist.
wireExternalRows();
