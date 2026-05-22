// Tile module — owns the visual identity + tap feedback for survey
// tiles (both Shows and Genres modes). Pre-this-module these
// concerns lived as nine standalone functions inside survey.js with
// no shared module: the archetype-color palette, the corner badges,
// the burst overlays, the spark spray, the per-frame scale pop, and
// the loop-clone state mirroring. Each carried fragments of "what a
// tile is" without a unified interface.
//
// What lives here:
//   - ARCHETYPE_ACCENT_BY_ID + archAccent — the per-archetype hue
//     palette that drives section bars, progress fills, tile hover
//     borders, AND tap-spark color. Both rendering layers and
//     animation layer share this constant.
//   - GENRE_SECTION_ACCENT_BY_ID + genreSectionAccent — same shape
//     for the five Genres-mode categories.
//   - ARCHETYPE_FLAVOR_BY_ID / GENRE_SECTION_FLAVOR_BY_ID — flavor
//     subtitles each section header carries.
//   - buildServiceBadge — corner badge of streaming-service dots
//   - buildTierBadge — small TOP 5 / RARE pill (All-view only)
//   - playTapFeedback — composes burst + sparks + scale-pop into
//     one call; wraps the three previously-separate functions.
//   - syncCloneVisuals — mirrors a tile-state mutation across loop
//     clones in the same row.
//
// What stays in survey.js (for now):
//   - renderTile / renderGenreTile — tile DOM construction. Tightly
//     coupled to STATE.tileMedia + tileStateFor; can move once the
//     rendering layer has its own subscription to state changes.
//   - refreshTileVisual / refreshGenreTileVisual — same coupling.

import { STREAMING_SERVICE_BY_ID } from './survey-anchors.js';
import { STATE } from './survey-state.js';
import { prefersReducedMotion } from './row-interaction.js';

// ── Archetype accent palette ────────────────────────────────────
// Per-archetype hue used by section bars, progress fills, tile
// hover borders, and tap sparks. Each archetype gets its own color
// so a long scroll reads as a journey across archetypes instead
// of a uniform orange wash.
export const ARCHETYPE_ACCENT_BY_ID = {
  'mainstream-shounen':  '#ff9d4d',
  'magic-academy':       '#c184ff',
  'comfort-isekai':      '#7ed184',
  'serious-isekai':      '#5fb8d8',
  'romance-open':        '#ff7aa8',
  'otome-villainess':    '#d896ff',
  'auteur':              '#f0b860',
  'fujoshi-yuri':        '#ff9bbf',
  'cgdct':               '#ffb6cf',
  'sports':              '#ff6a3d',
  'mecha':               '#5d9aff',
  'horror':              '#a14fc6',
  'mahou-shoujo':        '#ff5f9d',
  'mind-game-thriller':  '#9aa9c2',
  'hard-scifi':          '#2cd8c4',
  'battle-seinen':       '#e04848',
  'xianxia':             '#e0bd58',
  'josei':               '#d29785',
};
export function archAccent(archId) {
  return ARCHETYPE_ACCENT_BY_ID[archId] || '#ff8c28';
}

// ── Archetype flavor subtitles ─────────────────────────────────
// One-line vibe phrase per archetype. Section headers feel curated
// rather than bureaucratic when they carry these.
export const ARCHETYPE_FLAVOR_BY_ID = {
  'mainstream-shounen':  'long-runners · friendship and power-ups',
  'magic-academy':       'spellcraft, schools, found family',
  'comfort-isekai':      'easy-mode worlds, low stakes',
  'serious-isekai':      'survival rules, real stakes',
  'romance-open':        'soft swoons, slow burns',
  'otome-villainess':    'reverse-harem, breaking the script',
  'auteur':              'distinct vision, art-first',
  'fujoshi-yuri':        'female gaze, queer leads',
  'cgdct':               'soft slice-of-life, healing',
  'sports':              'training arcs, rivalry, victory',
  'mecha':               'pilots, war, oversized robots',
  'horror':              'dread, gore, body horror',
  'mahou-shoujo':        'transformation, magic-girl power',
  'mind-game-thriller':  'wits, traps, no easy outs',
  'hard-scifi':          'rigorous worlds, cyberpunk grit',
  'battle-seinen':       'mature combat, moral grey',
  'xianxia':             'cultivation, immortals, ancient China',
  'josei':               'adult women, real relationships',
};
export function archFlavor(archId) { return ARCHETYPE_FLAVOR_BY_ID[archId] || ''; }

// ── Genres-mode palette + flavor ───────────────────────────────
export const GENRE_SECTION_ACCENT_BY_ID = {
  'Demographics': '#ff9d4d',
  'Genres':       '#5d9aff',
  'Themes':       '#c184ff',
  'Settings':     '#5fd5c4',
  'Mature':       '#ff5f9d',
};
export const GENRE_SECTION_FLAVOR_BY_ID = {
  'Demographics': 'who the show is made for',
  'Genres':       'the broad strokes of plot and tone',
  'Themes':       'recurring story devices and shapes',
  'Settings':     'where and when the show takes place',
  'Mature':       'adult-oriented content tags',
};
export function genreSectionAccent(sectionId) {
  return GENRE_SECTION_ACCENT_BY_ID[sectionId] || '#ff8c28';
}

// ── Cover badges ────────────────────────────────────────────────

// Build a corner service badge for a tile. One colored dot per
// streaming service the show is on, anchored to the top-left
// corner of the cover. Up to 3 dots; further services overflow
// into a "+N" label. Returns null for an empty/unknown service list.
export function buildServiceBadge(services) {
  const known = (services || [])
    .map(id => STREAMING_SERVICE_BY_ID[id])
    .filter(Boolean);
  if (known.length === 0) return null;

  const badge = document.createElement('div');
  badge.className = 'tile-service-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.title = known.map(s => s.label).join(' · ');

  for (const svc of known.slice(0, 3)) {
    const dot = document.createElement('span');
    dot.className = 'tile-service-dot';
    dot.style.background = svc.color;
    badge.appendChild(dot);
  }
  if (known.length > 3) {
    const more = document.createElement('span');
    more.className = 'tile-service-more';
    more.textContent = `+${known.length - 3}`;
    badge.appendChild(more);
  }
  return badge;
}

// Tier badge — surfaces "this is a Top 5 popular pick" or "this is
// a deep cut" status only in the All view. Mainstream/Deep Cuts
// views are already filtered, so a badge would be redundant noise.
// Returns null when no badge applies. Reads STATE.view directly so
// the gating reflects live state at render time.
export function buildTierBadge(anchor) {
  if (STATE.view !== 'all') return null;
  let kind = null;
  if (anchor.tier <= 5) kind = 'top';
  else if (anchor.tier >= 9) kind = 'rare';
  if (!kind) return null;

  const badge = document.createElement('span');
  badge.className = `tile-tier-badge tier-${kind}`;
  badge.textContent = kind === 'top' ? 'TOP 5' : 'RARE';
  badge.title = kind === 'top'
    ? 'One of the top 5 popular picks in this archetype'
    : 'A deep-cut pick — fewer fans, sharper signal';
  return badge;
}

// ── Tap feedback ───────────────────────────────────────────────
// Three previously-separate animations compose into one call: the
// burst overlay (heart for love, X for dislike), the spark spray
// (love only), and the scale-pop (every tap). Callers used to
// orchestrate all three by hand at every tap site; now one call
// covers it.

const SPARK_COUNT = 8;

function spawnTileBurst(tileEl, nextState) {
  if (nextState !== 'loved' && nextState !== 'disliked') return;
  const cover = tileEl.querySelector('.tile-cover');
  if (!cover) return;
  const burst = document.createElement('span');
  burst.className = nextState === 'loved' ? 'tile-burst-heart' : 'tile-burst-x';
  burst.textContent = nextState === 'loved' ? '❤' : '✕';
  burst.setAttribute('aria-hidden', 'true');
  cover.appendChild(burst);
  burst.addEventListener('animationend', () => burst.remove(), { once: true });
  // Belt-and-suspenders cleanup if animationend doesn't fire (e.g.
  // reduced-motion + display:none means animation never runs).
  setTimeout(() => burst.remove(), 1200);
  if (nextState === 'loved') spawnTapSparks(cover, tileEl);
}

function spawnTapSparks(cover, tileEl) {
  if (prefersReducedMotion()) return;
  // Pull the section's accent. tile.dataset.archetypeId is set on
  // Shows tiles; Genres tiles fall through to the global loved hue.
  const archId = tileEl.dataset.archetypeId;
  const accent = archId ? archAccent(archId) : 'var(--loved)';
  for (let i = 0; i < SPARK_COUNT; i++) {
    const spark = document.createElement('span');
    spark.className = 'tile-tap-spark';
    const baseAngle = (360 / SPARK_COUNT) * i;
    const jitter = (Math.random() - 0.5) * 24;
    spark.style.setProperty('--angle', `${baseAngle + jitter}deg`);
    spark.style.setProperty('--distance', `${38 + Math.random() * 22}px`);
    spark.style.setProperty('--size', `${5 + Math.random() * 4}px`);
    spark.style.setProperty('--spark-color', accent);
    spark.style.animationDuration = `${520 + Math.random() * 220}ms`;
    cover.appendChild(spark);
    spark.addEventListener('animationend', () => spark.remove(), { once: true });
    setTimeout(() => spark.remove(), 1100);
  }
}

// Public: scale-pop without the burst — used by the undo path
// where the user is reverting a tap, so the celebration animation
// would be misleading.
export function playTapFlash(tileEl) {
  tileEl.classList.remove('is-just-tapped');
  void tileEl.offsetWidth; // force reflow so re-add restarts animation
  tileEl.classList.add('is-just-tapped');
  tileEl.addEventListener(
    'animationend',
    () => tileEl.classList.remove('is-just-tapped'),
    { once: true }
  );
}

// Public composer: every fresh-tap site goes through here. Callers
// don't choose burst/sparks/pop independently — the tile owns the
// composition (scale-pop + heart/X burst + sparks-on-love).
export function playTapFeedback(tileEl, nextState) {
  playTapFlash(tileEl);
  spawnTileBurst(tileEl, nextState);
}

// ── Loop-clone state mirroring ────────────────────────────────
// When a tap mutates a tile's state, every clone of that tile
// inside the same row's loop track needs the same visual update.
// Caller passes the clicked tile, the dataset attribute that
// identifies clones (data-ani-list-id for shows, data-tag for
// genres), the per-tile refresh function, and the id/tag.
export function syncCloneVisuals(tileEl, attrName, refreshFn, idOrTag) {
  const row = tileEl.closest('.tile-grid-row');
  if (!row) return;
  const escaped = String(idOrTag).replace(/"/g, '\\"');
  row.querySelectorAll(`.tile[${attrName}="${escaped}"]`).forEach((t) => {
    if (t !== tileEl) refreshFn(t, idOrTag);
  });
}
