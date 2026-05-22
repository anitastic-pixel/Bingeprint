// Live taste-shape preview module — five tightly-coupled functions
// in survey.js used to implement this self-contained sub-feature:
// "given the user's current taps, render their leaning archetypes/
// tags as ranked pills and let them click to scroll." The functions
// referenced each other and got called together (every tap), but
// they were spread across 130 lines mixed with unrelated code.
//
// This module owns the whole surface:
//   - computeShowShape / computeTagShape — pure scoring of taps
//     into ranked archetype/tag rows (loved counts +1, disliked
//     -0.7; the engine still does its own real recompute on Done).
//   - renderTastePreview — paints both the inline panel and the
//     desktop sidebar from the same data.
//   - applyTasteSidebarVisibility — the desktop-vs-mobile breakpoint
//     decision that hides one panel or the other.
//   - createPillClickHandler — closure-bound click handler that
//     smooth-scrolls to the relevant section (archetype section in
//     Shows mode, category section in Genres mode).
//
// State access goes through survey-state.js's STATE re-export
// during the migration window; the long-term shape would subscribe
// to the 'tap' / 'modeChanged' events from survey-state instead of
// being re-rendered explicitly by callers.

import { SURVEY_ANCHORS, ARCHETYPE_LABEL_BY_ID } from './survey-anchors.js';
import { SURVEY_GENRE_ANCHORS } from './survey-genre-anchors.js';
import { STATE, totalTapCount } from './survey-state.js';
import { archAccent } from './tile.js';

const INLINE_PILL_LIMIT = 5;
const SIDEBAR_PILL_LIMIT = 8;
const SIDEBAR_BREAKPOINT_PX = 1280;

// ── Pure scoring ────────────────────────────────────────────────

// Score per archetype: loved counts as +1, disliked as -0.7
// (matches the engine's negative-tap dampening intuition). Returns
// rows ranked by score, ties broken by raw loved count.
export function computeShowShape() {
  const counts = {};
  for (const anchor of SURVEY_ANCHORS) {
    const shape = STATE.shapes[anchor.aniListId];
    if (!shape) continue;
    if (!counts[anchor.archetypeId]) {
      counts[anchor.archetypeId] = { id: anchor.archetypeId, loved: 0, disliked: 0 };
    }
    if (shape.state === 'loved')        counts[anchor.archetypeId].loved++;
    else if (shape.state === 'disliked') counts[anchor.archetypeId].disliked++;
  }
  return Object.values(counts)
    .map(c => ({ ...c, score: c.loved - c.disliked * 0.7 }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || b.loved - a.loved);
}

// Per-tag version — each tag tap contributes ±1 (binary, since
// tags are tapped directly, not derived from anchor lists).
export function computeTagShape() {
  const items = [];
  for (const tag in STATE.tagShapes) {
    const shape = STATE.tagShapes[tag];
    if (!shape) continue;
    const item = { tag, loved: 0, disliked: 0 };
    if (shape.state === 'loved')        item.loved = 1;
    else if (shape.state === 'disliked') item.disliked = 1;
    item.score = item.loved - item.disliked * 0.7;
    if (item.score > 0) items.push(item);
  }
  return items.sort((a, b) => b.score - a.score || b.loved - a.loved);
}

// ── Rendering ───────────────────────────────────────────────────

// Paint the preview into both the inline panel and the desktop
// sidebar. highlightId pulses the just-tapped pill so the change
// registers visually. Caller passes the dom roots and option ids.
export function renderTastePreview({ highlightId } = {}) {
  const inlineRoot = document.getElementById('taste-shape-pills');
  const sidebarRoot = document.getElementById('taste-sidebar-pills');
  const labelEl = document.getElementById('taste-shape-label');
  const sidebarTitle = document.getElementById('taste-sidebar-title');
  const sidebarCount = document.getElementById('taste-sidebar-count');
  if (!inlineRoot && !sidebarRoot) return;

  const showsMode = STATE.activeMode === 'shows';
  if (labelEl) labelEl.textContent = showsMode ? 'Leaning toward:' : 'Top tags:';
  if (sidebarTitle) sidebarTitle.textContent = showsMode ? 'Your taste so far' : 'Top tags so far';
  if (sidebarCount) {
    const taps = totalTapCount();
    sidebarCount.textContent = `${taps} tap${taps === 1 ? '' : 's'}`;
  }

  const fullItems = showsMode ? computeShowShape() : computeTagShape();
  const inlineItems = fullItems.slice(0, INLINE_PILL_LIMIT);
  const sidebarItems = fullItems.slice(0, SIDEBAR_PILL_LIMIT);
  const emptyHint = showsMode
    ? 'tap a show you love to see your shape take form →'
    : 'tap a tag you love to see your shape take form →';

  const buildPills = (items) => {
    if (items.length === 0) return `<span class="taste-shape-empty">${emptyHint}</span>`;
    const topScore = items[0].score;
    return items.map(item => {
      const id = showsMode ? item.id : item.tag;
      const label = showsMode ? (ARCHETYPE_LABEL_BY_ID[item.id] || item.id) : item.tag;
      const fillPct = Math.max(25, Math.round((item.score / topScore) * 100));
      const isHi = highlightId && id === highlightId;
      const accent = showsMode ? archAccent(item.id) : 'var(--loved)';
      return (
        `<span class="shape-pill${isHi ? ' is-pulsing' : ''}" ` +
        `data-shape-id="${escapeHtml(id)}" ` +
        `style="--fill: ${fillPct}%; --pill-accent: ${accent}">` +
        `<span class="shape-pill-name">${escapeHtml(label)}</span>` +
        `<span class="shape-pill-count">❤ ${item.loved}</span>` +
        `</span>`
      );
    }).join('');
  };

  if (inlineRoot) inlineRoot.innerHTML = buildPills(inlineItems);
  if (sidebarRoot) sidebarRoot.innerHTML = buildPills(sidebarItems);

  applyTasteSidebarVisibility();

  // Pulse the sidebar on a fresh tap so the change registers even if
  // the user's eye is on the tile grid. Re-applies on next frame so
  // the animation restarts each tap.
  if (highlightId) {
    const sb = document.getElementById('taste-sidebar');
    if (sb && !sb.hidden) {
      sb.classList.remove('is-pulsing');
      requestAnimationFrame(() => sb.classList.add('is-pulsing'));
    }
  }
}

// ── Sidebar visibility (breakpoint-driven) ─────────────────────
// Sidebar is visible above 1280px (with the empty-state hint
// before the first tap). Below that the inline panel takes over
// and the sidebar hides.
export function applyTasteSidebarVisibility() {
  const sb = document.getElementById('taste-sidebar');
  const inline = document.getElementById('taste-shape');
  if (!sb || !inline) return;
  const wide = window.matchMedia(`(min-width: ${SIDEBAR_BREAKPOINT_PX}px)`).matches;
  sb.hidden = !wide;
  inline.classList.toggle('is-sidebar-active', wide);
}

// ── Click handler ──────────────────────────────────────────────
// Pill click → smooth-scroll to the relevant section. Shows mode
// jumps to the named archetype section. Genres mode looks up the
// tag's category in SURVEY_GENRE_ANCHORS and scrolls to that
// category section. Returns a function suitable for an event
// listener (factory so survey.js can wire once at boot without
// importing the inner logic).
export function createTastePillClickHandler() {
  return function onTastePillClick(e) {
    const pill = e.target.closest('.shape-pill');
    if (!pill) return;
    const id = pill.dataset.shapeId;
    if (!id) return;
    let section = null;
    if (STATE.activeMode === 'shows') {
      section = document.querySelector(
        `.tile-grid-section[data-archetype-id="${id}"]`
      );
    } else {
      const anchor = SURVEY_GENRE_ANCHORS.find(a => a.tag === id);
      if (anchor) {
        const escaped = String(anchor.category).replace(/"/g, '\\"');
        section = document.querySelector(
          `.tile-grid-section[data-section="${escaped}"]`
        );
      }
    }
    if (!section) return;
    const stick = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--header-stick') || '96',
      10
    );
    const top = section.getBoundingClientRect().top + window.scrollY - stick - 12;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
  };
}

// Local copy of escapeHtml — avoids a circular import on survey.js
// for a 4-line helper.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
