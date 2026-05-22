// Apply pipeline + summary screen — owns the lifecycle of "user
// presses Done/Refine/Close, the engine recomputes, the result is
// surfaced." Pre-this-module these concerns lived as four
// standalone functions in survey.js (applyTasteWithProgress, onDone,
// renderSummary, renderPendingTapsNotice) plus three button
// handlers that each orchestrated apply + transition by hand.
//
// What lives here:
//   - applyTaste(triggerBtn) — sends the applyAndRecompute message
//     and toggles the global progress bar + the trigger button's
//     spinner state for the duration. Used by every apply path.
//   - applyAnd(target, triggerBtn) — composes apply + a named
//     post-transition: 'summary' | 'back-to-grid' | 'close-tab'.
//     The three buttons (Done — apply, Refine, Close) call this
//     instead of orchestrating the steps themselves.
//   - renderSummary — paints the summary screen with the freshly-
//     recomputed taste vector + archetype blend, polled briefly
//     since the vector is written by the worker after our message.
//   - renderPendingTapsNotice — surfaces the "N taps haven't
//     folded yet" notice from surveyApplyState.

import { STORAGE_KEYS, getMany } from './storage-schema.js';
import { totalTapCount } from './survey-state.js';
import { confidenceLevelFor } from './confidence.js';

// ── Apply (with progress UI) ────────────────────────────────────

export async function applyTaste(triggerBtn) {
  const progressEl = document.getElementById('apply-progress');
  if (progressEl) progressEl.hidden = false;
  if (triggerBtn) triggerBtn.classList.add('is-applying');
  try {
    await chrome.runtime.sendMessage({ type: 'survey:applyAndRecompute' });
  } catch (err) {
    console.warn('[crsmart-survey] applyAndRecompute message failed', err);
  } finally {
    if (progressEl) progressEl.hidden = true;
    if (triggerBtn) triggerBtn.classList.remove('is-applying');
  }
}

// Compose apply + transition. Caller passes a target + the button
// element so the spinner state lives on the right control. The
// 'summary' target renders the summary screen; 'back-to-grid' goes
// the other direction; 'close-tab' uses chrome.tabs.remove with a
// window.close() fallback.
export async function applyAndTransition(target, triggerBtn) {
  await applyTaste(triggerBtn);
  if (target === 'summary') {
    await renderSummary();
  } else if (target === 'back-to-grid') {
    document.getElementById('survey-main').hidden = false;
    document.getElementById('summary-screen').hidden = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  } else if (target === 'close-tab') {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id != null) {
        await chrome.tabs.remove(tab.id);
        return;
      }
    } catch (err) {
      console.warn('[crsmart-survey] tabs.remove fallback', err);
    }
    window.close();
  } else if (target === 'open-picks') {
    // Side-panel open already happened in the click handler before
    // applyTaste was awaited (chrome.sidePanel.open needs an unspent
    // user gesture). We intentionally leave the survey tab open so
    // the user can keep iterating on taps if the recs don't feel
    // right — the side panel updates live as taps land in storage.
    // Earlier versions closed this tab; that turned out to be hostile
    // in dev/QA flows and the friend-metaphor argument ("don't need
    // both surfaces") wasn't worth the friction.
  }
}

// ── Summary screen ──────────────────────────────────────────────

export async function renderSummary() {
  // Pull the freshly-recomputed taste vector from storage and show
  // a top-archetypes / top-tags / top-anti-tags readout. The vector
  // is computed inside the worker after our applyAndRecompute message.
  // We poll briefly for the new vector to land.
  let vector = null;
  let archetypeBlend = null;
  for (let i = 0; i < 8; i++) {
    const data = await getMany([STORAGE_KEYS.tasteVector, STORAGE_KEYS.archetypeBlend]);
    if (data.tasteVector?.computedAt &&
        data.tasteVector.computedAt > (Date.now() - 30_000)) {
      vector = data.tasteVector;
      archetypeBlend = data.archetypeBlend;
      break;
    }
    await new Promise(r => setTimeout(r, 250));
  }

  document.getElementById('survey-main').hidden = true;
  document.getElementById('summary-screen').hidden = false;

  paintListInto('summary-archetypes',
    (archetypeBlend?.archetypes || []).slice(0, 4),
    a => ({ name: a.name || a.id, value: `${(a.score * 100).toFixed(0)}%` }));

  paintListInto('summary-positive-tags',
    (vector?.top || []).slice(0, 8),
    t => ({ name: t.tag, value: t.weight.toFixed(1) }));

  paintListInto('summary-anti-tags',
    (vector?.bottom || []).slice(0, 6),
    t => ({ name: t.tag, value: t.weight.toFixed(1) }),
    'none yet');

  // Confidence readout
  const taps = totalTapCount();
  const conf = confidenceLevelFor(taps);
  const labelEl = document.getElementById('confidence-readout-label');
  labelEl.textContent = conf.level;
  labelEl.classList.remove('confidence-low', 'confidence-mid', 'confidence-high');
  labelEl.classList.add(conf.cls);
  const hintEl = document.getElementById('confidence-readout-hint');
  hintEl.textContent = taps >= 15
    ? `Strong signal — ${taps} taps. The engine has plenty to work with.`
    : taps >= 5
    ? `Decent signal — ${taps} taps. Tap a few more for sharper picks.`
    : `Light signal — ${taps} taps. Tap more tiles to sharpen your taste shape.`;

  await renderPendingTapsNotice();
  await renderTapEffectsNotice();
  await renderTopPicks();
}

// Top-3 picks preview — paints the first three peak-mode recs into
// the celebration screen so the friend sees actual recommendations
// land before they leave the tab. Each pick is a clickable row that
// opens the show's CR series page. Hidden if recommendations haven't
// been computed yet (e.g. cold-start, no CR history).
async function renderTopPicks() {
  const section = document.getElementById('summary-top-picks');
  const list = document.getElementById('summary-picks-list');
  const spreadEl = document.getElementById('summary-spread');
  if (!section || !list) return;

  let recs = [];
  let allRanked = [];
  try {
    const stored = await chrome.storage.local.get(['recommendationsScored']);
    const peak = stored.recommendationsScored?.peak;
    allRanked = peak?.ranked || [];
    recs = allRanked.slice(0, 3);
  } catch (err) {
    console.warn('[crsmart-survey] renderTopPicks fetch failed', err);
  }

  if (!recs.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

  // Spread feedback — gap between top-3 average and bottom-3 average.
  // Wide gap (≥20 points on the 0-100 scale) = engine has confidence,
  // tier bands will be populated. Tight gap = signal is thin and the
  // user would benefit from more taps before clicking into Smart Picks.
  // Only renders if we have ≥10 ranked recs so the bottom isn't dominated
  // by random noise.
  if (spreadEl) {
    if (allRanked.length >= 10) {
      const top3 = allRanked.slice(0, 3);
      const bottom3 = allRanked.slice(-3);
      const avg = arr =>
        arr.reduce((s, r) => s + (r.finalScore || 0), 0) / arr.length;
      const gap = Math.round((avg(top3) - avg(bottom3)) * 100);
      if (gap >= 25) {
        spreadEl.textContent =
          `Strong spread — your top picks are ${gap} points above the bottom of ` +
          `the ranking. The engine has real confidence in these.`;
        spreadEl.className = 'summary-spread spread-strong';
      } else if (gap >= 12) {
        spreadEl.textContent =
          `Decent spread — ${gap}-point gap between your top and bottom picks. ` +
          `A few more taps would sharpen it further.`;
        spreadEl.className = 'summary-spread spread-decent';
      } else {
        spreadEl.textContent =
          `Tight spread — only ${gap} points between your top and bottom picks. ` +
          `~10 more taps will help the engine differentiate before you dive in.`;
        spreadEl.className = 'summary-spread spread-tight';
      }
      spreadEl.hidden = false;
    } else {
      spreadEl.hidden = true;
    }
  }

  list.innerHTML = '';
  for (const rec of recs) {
    const title =
      rec.title?.english || rec.title?.romaji || rec.title?.native || 'Untitled';
    const url =
      rec.crSiteUrl ||
      (rec.aniListId ? `https://anilist.co/anime/${rec.aniListId}` : '');
    const score = typeof rec.finalScore === 'number'
      ? Math.round(rec.finalScore * 100)
      : null;

    const li = document.createElement('li');
    li.className = 'summary-pick';

    const a = document.createElement('a');
    a.className = 'summary-pick-link';
    a.href = url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const titleEl = document.createElement('span');
    titleEl.className = 'summary-pick-title';
    titleEl.textContent = title;

    a.appendChild(titleEl);

    if (score !== null) {
      const scoreEl = document.createElement('span');
      scoreEl.className = 'summary-pick-score';
      scoreEl.textContent = `${score}`;
      a.appendChild(scoreEl);
    }

    li.appendChild(a);
    list.appendChild(li);
  }
}

// Tap-effect surface — voices the engine's response to each
// surveyTagShapes tap so the user sees what changed (or didn't).
//
// Persisted by background.js's persistDualModeRecommendations as
// surveyTapEffects.perTag. Per-tag status:
//   'fired-with-candidates'   — tap registered + peak pool has matching shows
//   'fired-no-candidates'     — tap registered but no candidates match (gap)
//   'noop-behavior-stronger'  — your watch history already exceeded the floor
//   'noop-thin-vector'        — peak vector too thin to act on
//
// Architecture review locked the friend-voice tone for these messages.
// The 'fired-no-candidates' case offers a CTA to seed the pool from
// AniList (wired in a follow-up commit; for now the CTA is a no-op
// placeholder).
export async function renderTapEffectsNotice() {
  const container = document.getElementById('summary-tap-effects');
  if (!container) return;
  try {
    const { surveyTapEffects } = await getMany(['surveyTapEffects']);
    const perTag = surveyTapEffects?.perTag || {};
    const entries = Object.entries(perTag);
    if (entries.length === 0) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'tap-effects-heading';
    heading.textContent = 'Your tag taps:';
    container.appendChild(heading);
    for (const [tag, effect] of entries) {
      const row = document.createElement('div');
      row.className = `tap-effect-row tap-effect-${effect.status}`;
      row.innerHTML = renderTapEffectRow(tag, effect);
      container.appendChild(row);
    }
    wireSeedButtons(container);
  } catch (err) {
    console.warn('[crsmart-survey] renderTapEffectsNotice failed', err);
    container.hidden = true;
  }
}

// Wire the "Seed from AniList" CTA buttons. Each button sends a
// runtime message to the worker, which fetches top peak shows by
// tag and triggers a recompute. The button transitions through
// states (idle → seeding → seeded/failed) inline so the user sees
// what's happening without a separate spinner.
function wireSeedButtons(container) {
  const buttons = container.querySelectorAll('button.tap-effect-seed-btn');
  for (const btn of buttons) {
    btn.addEventListener('click', async () => {
      const tag = btn.dataset.seedTag;
      if (!tag || btn.disabled) return;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Seeding…';
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'survey:seedCandidatesForTag',
          tag,
        });
        if (resp?.ok) {
          btn.textContent = `✓ Seeded ${resp.count} shows`;
          btn.classList.add('tap-effect-seed-btn--ok');
          // The recompute fires automatically; the surveyTapEffects
          // change listener will re-render this row to 'fired-with-
          // candidates' status with the seeded shows surfaced.
        } else if (resp?.reason === 'rate-limited') {
          const sec = Math.ceil((resp.retryInMs || 0) / 1000);
          btn.textContent = `Rate-limited (retry in ${sec}s)`;
          btn.disabled = false;
        } else if (resp?.reason === 'no-results') {
          btn.textContent = 'No matching AniList shows';
          btn.classList.add('tap-effect-seed-btn--err');
        } else {
          btn.textContent = `Failed${resp?.reason ? ': ' + resp.reason : ''}`;
          btn.classList.add('tap-effect-seed-btn--err');
          btn.disabled = false;
        }
      } catch (err) {
        console.warn('[crsmart-survey] seed CTA failed', err);
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
  }
}

function renderTapEffectRow(tag, effect) {
  const verb = effect.state === 'loved' ? 'loved' : 'disliked';
  const safeTag = escapeHtml(tag);
  switch (effect.status) {
    case 'fired-with-candidates': {
      const matchTitles = (effect.topMatches || [])
        .map(m => m.title).filter(Boolean).slice(0, 2);
      const matchPhrase = matchTitles.length
        ? ` — surfacing ${matchTitles.map(t => escapeHtml(t)).join(', ')}` +
          (effect.candidatesMatching > matchTitles.length
            ? ` and ${effect.candidatesMatching - matchTitles.length} more`
            : '')
        : '';
      return `<span class="tap-effect-status">✓</span>
        <span class="tap-effect-text">
          <strong>${safeTag}</strong> ${verb} → boost landed${matchPhrase}.
          Open Smart Picks to see them.
        </span>`;
    }
    case 'fired-no-candidates':
      return `<span class="tap-effect-status">⚠</span>
        <span class="tap-effect-text">
          <strong>${safeTag}</strong> ${verb} → boost landed, but your peak
          rec pool doesn't have any ${safeTag} shows yet.
          Your watch history hasn't generated ${safeTag} candidates from
          AniList recommendations.
          <button class="tap-effect-seed-btn" data-seed-tag="${safeTag}"
                  type="button" title="Fetch top peak ${safeTag} shows from AniList and add them to your rec pool">
            Seed top ${safeTag} from AniList
          </button>
        </span>`;
    case 'noop-behavior-stronger': {
      const before = (effect.before ?? 0).toFixed(1);
      return `<span class="tap-effect-status">·</span>
        <span class="tap-effect-text">
          <strong>${safeTag}</strong> ${verb} → no change. Your watch history
          already says you ${verb === 'loved' ? 'love' : 'avoid'} ${safeTag}
          (mass ${before}); the tap was redundant.
        </span>`;
    }
    case 'noop-thin-vector':
      return `<span class="tap-effect-status">·</span>
        <span class="tap-effect-text">
          <strong>${safeTag}</strong> ${verb} → no change yet. Your peak-tier
          watch history is too thin for tag taps to override. Watch a few
          well-rated shows first.
        </span>`;
    default:
      return `<span class="tap-effect-text"><strong>${safeTag}</strong> ${verb}</span>`;
  }
}

// Paint a {name, value} list into a UL with the standard
// summary-list-item shape. Dash-stub when empty unless an
// emptyText override is supplied.
function paintListInto(elId, items, projector, emptyText = '—') {
  const list = document.getElementById(elId);
  if (!list) return;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<li class="summary-list-item"><span class="summary-list-name">${escapeHtml(emptyText)}</span></li>`;
    return;
  }
  for (const item of items) {
    const proj = projector(item);
    const li = document.createElement('li');
    li.className = 'summary-list-item';
    li.innerHTML = `
      <span class="summary-list-name">${escapeHtml(proj.name)}</span>
      <span class="summary-list-weight">${escapeHtml(proj.value)}</span>
    `;
    list.appendChild(li);
  }
}

// Pending-taps notice — visible only when surveyApplyState.
// skippedNoMedia > 0. The bridge-cache listener in background.js
// auto-retries when the missing media arrives, so this notice is
// informational ("N taps still loading") rather than actionable.
export async function renderPendingTapsNotice() {
  const noticeEl = document.getElementById('summary-pending');
  if (!noticeEl) return;
  try {
    const { surveyApplyState } = await getMany([STORAGE_KEYS.surveyApplyState]);
    const skipped = surveyApplyState?.skippedNoMedia || 0;
    if (skipped > 0) {
      const countEl = document.getElementById('summary-pending-count');
      if (countEl) countEl.textContent = `${skipped} ${skipped === 1 ? 'tap' : 'taps'}`;
      noticeEl.hidden = false;
    } else {
      noticeEl.hidden = true;
    }
  } catch (_) {
    noticeEl.hidden = true;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
