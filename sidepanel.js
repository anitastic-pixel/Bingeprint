// Smart Picks side panel — reads recommendationsScored from chrome.storage.local
// and renders the active mode's ranked cards. Live-updates when the
// background worker recomputes (storage onChanged fires).
//
// Vibe chip row sits above the card list. Selecting vibes reorders the
// list so cards whose tags overlap the selected vibes float to the top
// (sorted by # matches), and cards with zero matches dim out. Selection
// is per-mode and persists in chrome.storage.local._sidePanelVibes.
//
// Loaded as type="module" so the dev axis sandbox can import the same
// pipeline functions the worker uses (radar-derive.js's
// shapeIdentityFor / proseFor / taglineFor / confidenceLevelFor) for
// real-time radar previews. Vibe-tags.js still loads as a classic
// script (sets window.VIBE_TAGS); we read it via window here.

import { AXIS_DEFS, buildRadarFromAxisValues, getDevSandboxPresets } from './radar-derive.js';
import { mountShapeCanvas } from './shape-canvas-painters.js';
import { showCoachMarkOnce } from './coach-marks.js';

const { VIBE_GROUPS, ALL_VIBE_CHIPS, scoreVibeMatch, vibeMatchDetail,
        searchVibeLexicon, suggestVibeWord } = window.VIBE_TAGS;

const STATE = {
  mode: 'peak',
  // G10: 'picks' or 'shape'. Toggle at top of side panel.
  surface: 'picks',
  data: null,
  // G09: tasteShapeRadar from chrome.storage. Populated by load() and
  // by storage.onChanged. Null until first taste-vector recompute.
  radar: null,
  // Real radar from storage, kept separately so the dev sandbox can
  // restore it on Reset without a fresh storage read.
  realRadar: null,
  // { peak: ['cozy','wholesome'], comfort: [...] }
  vibes: { peak: [], comfort: [] },
  // { [aniListId]: '+1' | '0' | '-1' } — set by show-page rate buttons.
  // Side panel hides '-1' entries so the user's "not for me" verdicts
  // act as engine feedback without us touching the rank pipeline.
  ratings: {},
  // Dev axis-sandbox state.
  //   toggleOn — surfaceSettings.devAxisSandbox; controls whether the
  //              sandbox section is in the DOM at all
  //   active   — sandbox section is visible AND values have been set
  //              (so STATE.radar is the synthetic dev radar, not real)
  //   lockedPresetName — when non-null, the rendered shape name +
  //                      family + palette are forced to the picked
  //                      preset's metadata regardless of what
  //                      shapeIdentityFor matches. Cleared by picking
  //                      "— pick archetype —" or hitting Reset.
  devSandbox: { toggleOn: false, active: false, lockedPresetName: null },
  // Per-lens .rec-list scroll position. Captured on setMode before the
  // mode flips, restored in render() after cards land in the DOM. Keeps
  // the user's place when they tab between Peak and (e.g.) Take a Chance.
  scrollByMode: {},
  // { [lensId]: boolean } — user's choice of which lens pills appear in
  // the mode-bar grid. Missing key = visible (default-on). Persisted at
  // chrome.storage.local.lensVisibility.
  lensVisibility: {},
  // Boolean — collapses the vibe-bar AND the status-bar rank/score
  // legend rows together. The two are "teaching chrome" that earn the
  // same dismissal once learned. Persisted at
  // chrome.storage.local._vibeBarCollapsed.
  vibeBarCollapsed: false,
  // 'detail' | 'casual' | 'compact' — card layout density. Drives the
  // body.view-mode-{name} class which scopes per-mode CSS rules over
  // the same card DOM (so diff-update render is view-mode-agnostic).
  // Persisted at chrome.storage.local._sidePanelViewMode.
  viewMode: 'detail',
};

const VIBE_KEY = '_sidePanelVibes';
const MODE_KEY = '_sidePanelMode';
const SURFACE_KEY = '_sidePanelSurface';
const RADAR_KEY = 'tasteShapeRadar';
const VIBE_BAR_COLLAPSED_KEY = '_vibeBarCollapsed';
const VIEW_MODE_KEY = '_sidePanelViewMode';
const VALID_VIEW_MODES = new Set(['detail', 'casual', 'compact']);

// Dev mode for the side panel: surfaces internal diagnostics like the
// CF re-ranker's delta on each card. Toolbar-opened side panels can't
// carry a ?dev=1 query string (Chrome's side_panel mechanism doesn't
// pass URL params on the toolbar path), so we read a storage flag set
// from the popup dev row instead. Falls back to ?dev=1 in case the
// panel is opened as a regular tab (rare; useful for debugging-from-
// devtools workflows). Updated live via chrome.storage.onChanged so
// flipping the flag without reload re-renders the next card paint.
let DEV_MODE = new URLSearchParams(location.search).has('dev');
chrome.storage.local.get('cfDevPills').then(({ cfDevPills }) => {
  if (cfDevPills === true) DEV_MODE = true;
});
chrome.storage.onChanged?.addListener?.((changes, area) => {
  if (area === 'local' && 'cfDevPills' in changes) {
    DEV_MODE = changes.cfDevPills.newValue === true
      || new URLSearchParams(location.search).has('dev');
    // Re-render to reflect the new pill visibility — cheap, just calls
    // render() which rebuilds the card list from current STATE.data.
    if (typeof scheduleRender === 'function') scheduleRender();
  }
});
const RATINGS_KEY = 'userRatings';

// G13-deep: lens display config. Mirrors lens-registry.js but lives
// here because sidepanel runs as a non-module script. IDs must match
// recommendationsScored storage keys exactly — changing them breaks
// the data lookup. Order is the rendered tab order in the mode-bar.
const LENS_TABS = [
  { id: 'peak',                  name: 'Peak',           hint: 'elevated taste',           group: 'discovery' },
  { id: 'comfort',               name: 'Comfort',        hint: 'brain-off picks',          group: 'discovery' },
  { id: 'in-the-air',            name: 'In the Air',     hint: 'currently airing',         group: 'discovery' },
  { id: 'from-people-you-trust', name: 'People You Trust', hint: 'studios + creators',     group: 'discovery' },
  { id: 'take-a-chance',         name: 'Take a Chance',  hint: 'stretch picks',            group: 'discovery' },
  { id: 'canon',                 name: "You've Missed",  hint: 'high-quality classics',    group: 'discovery' },
  // A visual divider renders between the last 'discovery' tab and the
  // first 'history' tab — see renderModeBar. The split signals
  // discovery (find new shows) vs history (browse what you've engaged
  // with) without adding a row or hiding lenses.
  { id: 'try-again',             name: 'Try Again',      hint: 'dropped — give another shot', group: 'history' },
  { id: 'rewatched',             name: 'Rewatched',      hint: 'shows you came back to',   group: 'history' },
];

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function pickTitle(t) {
  if (!t) return 'Unknown';
  return normalizeFranchiseTitle(t.english || t.romaji || t.native || 'Unknown');
}

// Strip per-season suffixes from an AniList title so the rec card
// surfaces the franchise name instead of the season-specific entry.
// AniList stores each season as its own entry with its own title
// ("Mushoku Tensei: Jobless Reincarnation Season 2", "Tower of God
// Season 2", "Attack on Titan Final Season Part 2"), and the rec
// pipeline picks per-season AL IDs — without normalization the side
// panel reads as a list of season tags rather than shows. Iterates
// in case suffixes stack ("Final Season Part 2"). Conservative on
// patterns: requires an explicit Season/Part/Cour token so titles
// like "Mob Psycho 100" or "Code Geass" stay intact.
// Every pattern ends with `\b.*$` so the strip also captures any
// trailing subtitle ("Solo Leveling Season 2 -Arise from the Shadow-",
// "Attack on Titan: The Final Season -Final Chapters-"). Pre-fix the
// patterns ended at the digit/word, which left subtitles dangling on
// the card.
const SEASON_SUFFIX_PATTERNS = [
  /\s+Final\s+Season\s+Part\s+\d+\b.*$/i,
  /\s+Final\s+Season\b.*$/i,
  /\s+Season\s+\d+\s+Part\s+\d+\b.*$/i,
  /\s+Season\s+\d+\s+Cour\s+\d+\b.*$/i,
  /\s+Season\s+\d+\b.*$/i,
  /\s+S\d+\b.*$/i,                                       // "Tower of God S2"
  /\s+\d+(?:st|nd|rd|th)\s+Season\b.*$/i,                // "2nd Season"
  /\s*:\s*\d+(?:st|nd|rd|th)\s+Season\b.*$/i,            // ": 2nd Season"
  /\s+Part\s+\d+\b.*$/i,
  /\s+Pt\.?\s*\d+\b.*$/i,
  /\s+Cour\s+\d+\b.*$/i,
  // Roman-numeral sequel marker: "Misfit of Demon King Academy II",
  // "Code Geass: Lelouch of the Rebellion II". Anchored to whole-word
  // numerals II–X — single "I" excluded (too risky; appears mid-title)
  // and "V" included even though it can be a one-letter trailing
  // word ("Robotech V") because false positives there are vanishingly
  // rare in anime titles.
  /\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)\b.*$/,
  // Bare single-digit sequel marker — "Bungo Stray Dogs 4", "In/Spectre 2",
  // "Boku no Hero Academia 7". Restricted to ONE digit (\d\b) so multi-
  // digit titles like "Mob Psycho 100", "AKB0048", "5 Centimeters Per
  // Second" stay intact; \s+ in front prevents matching mid-word.
  /\s+\d\b.*$/,
];
function normalizeFranchiseTitle(title) {
  if (!title || typeof title !== 'string') return title;
  let t = title;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const re of SEASON_SUFFIX_PATTERNS) {
      const next = t.replace(re, '').trim();
      if (next !== t && next.length > 0) {
        t = next;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return t;
}

// Same-tab navigation for rec card clicks. Side panel links can't use
// regular target='_self' (would replace the panel itself) or
// target='_blank' (opens new tab — friction; user has to dismiss
// the new tab to get back to where they were). Intercept the click
// and navigate the active CR tab directly via chrome.tabs.update.
// Modifier keys (ctrl/cmd/middle-click) bypass — fall through to
// the browser's native "open in new tab" behavior.
async function navigateToShowFromCard(event, url) {
  if (!url) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) return;
  event.preventDefault();
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id != null) {
      await chrome.tabs.update(activeTab.id, { url, active: true });
    } else {
      // Fallback if no active tab can be found — open a new tab.
      await chrome.tabs.create({ url, active: true });
    }
  } catch (err) {
    console.warn('[crsmart-sidepanel] navigation failed', err);
    // Last resort: let the browser try the default link.
    window.open(url, '_blank');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function relativeTime(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - ts;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// G11-extension: "Why this rec?" line on lens cards. For each lens
// other than peak/comfort (which use the existing 'because you
// watched X' line), generate a one-line explainer about why the
// rec is in this specific list. Audit-trust extension to lens recs.
function lensWhyFor(rec, lensId) {
  if (!rec) return '';
  switch (lensId) {
    case 'in-the-air': {
      // Currently-airing shows. The lens predicate already filtered
      // on status === RELEASING; surface that fact + freshness.
      const yearStr = rec.seasonYear ? ` since ${rec.seasonYear}` : '';
      return `currently airing${yearStr}`;
    }
    case 'from-people-you-trust': {
      // Concentration on user's high-affinity studios/creators. Prefer
      // the trusted-only match list annotated by the lens predicate
      // (rec._trustedMatches). Falls back to raw animationStudios for
      // older cached entries that pre-date the annotation.
      const trusted = rec._trustedMatches;
      const studios = trusted?.studios?.length
        ? trusted.studios
        : (rec.animationStudios || []).map(s => s?.name).filter(Boolean);
      const creators = trusted?.creators || [];
      // Combine — studios lead (stronger signal), creators fill in.
      const names = [...studios, ...creators];
      if (names.length) {
        const shown = names.slice(0, 2).join(' / ');
        const more = names.length > 2 ? ` + ${names.length - 2} more` : '';
        const label = studios.length ? 'studio' : 'creator';
        return `${label} ${shown}${more} — you trust them`;
      }
      return 'a team you trust';
    }
    case 'take-a-chance': {
      // STRETCH-band picks outside top archetypes.
      const archName = rec.primaryArchetype || null;
      if (archName) {
        return `outside your usual lanes — ${archName.replace(/-/g, ' ')}`;
      }
      return 'outside your usual lanes — earned stretch';
    }
    case 'canon': {
      // High-quality unwatched classics.
      const avg = rec.averageScore || 0;
      const yearStr = rec.seasonYear ? ` (${rec.seasonYear})` : '';
      return `community favorite — ${avg}/100${yearStr}`;
    }
    case 'try-again': {
      // Dropped shows currently scoring well. Surface the dropped
      // status + the current score so the contradiction is visible.
      // Floor the printed score at 0.1 so we never read "0.0/10" — by
      // the time this lens predicate fires the rec has finalScore >=
      // 0.65, but the rendered string would still hit "0.0" on legacy
      // entries cached before the predicate tightened.
      const score = rec.finalScore != null
        ? Math.max(0.1, rec.finalScore * 10).toFixed(1)
        : '?';
      return `you dropped this — taste-fit now reads ${score}/10`;
    }
    case 'rewatched':
      // The act of rewatching IS the signal — no need to surface
      // numbers. Stays friend-voice: "you already love this."
      return "you've come back to this — it earned the loop";
    case 'peak': {
      // The lens-why banner exists to surface engine reasoning when the
      // displayed score doesn't already make the case. For peak lens
      // entries whose score IS already strong (≥0.90), the banner fires
      // identically on every card — turning a signal into decoration.
      // Suppress in that case so the banner re-acquires meaning when it
      // does appear (sub-0.90 picks that still landed in your peak lane,
      // which is the genuinely informative case).
      const score = rec.finalScore || 0;
      if (score >= 0.90) return '';
      return 'strong taste match — your discerning lane';
    }
    case 'comfort':
      return 'easy-watch territory — comfort-tier match';
    default:
      // Unknown lens id — keep the existing 'because you watched X'
      // line below as the only explainer.
      return '';
  }
}

// Score → tier name used by the CSS color treatment on .card-final-score.
// Three bands: low (<0.75) dims toward gray, mid (default) keeps the
// standard accent, high (≥0.90) brightens + adds a soft text-glow.
// Thresholds match the engine's own "thin/calibrated" intuition so
// tiers read like a confidence ladder rather than arbitrary cutoffs.
function scoreTier(score) {
  const s = score || 0;
  if (s >= 0.90) return 'high';
  if (s < 0.75) return 'low';
  return 'mid';
}

function renderCard(rec, opts = {}) {
  const tpl = $('#card-template');
  const node = tpl.content.cloneNode(true);
  const title = pickTitle(rec.title);
  // URL fallback chain: prefer Crunchyroll URL (rec.crSiteUrl, set
  // at scoring time from media.externalLinks or crSeriesId
  // reconstruction). Falls back to AniList URL if crSiteUrl is
  // missing — only matters for legacy entries pre-crSiteUrl-
  // persistence; under Q1 hard-filter, side panel recs always
  // have crSiteUrl.
  const url = rec.crSiteUrl
    || rec.siteUrl
    || `https://anilist.co/anime/${rec.aniListId}`;

  const cover = node.querySelector('.card-cover');
  const img = node.querySelector('.card-cover-img');
  cover.href = url;
  // Same-tab nav: intercept click, navigate the user's active CR
  // tab via chrome.tabs.update. Without this, default link behavior
  // would replace the side panel's own content. Ctrl/Cmd-click
  // (middle-click etc.) bypasses the handler and falls through to
  // the browser's "open in new tab" default.
  cover.addEventListener('click', e => navigateToShowFromCard(e, url));
  const coverSrc = rec.coverImage?.large || rec.coverImage?.medium;
  if (coverSrc) {
    img.src = coverSrc;
    img.alt = title;
  } else {
    // No cover URL yet. Hide the broken img and render an initials
    // placeholder so the card doesn't look empty. The new-lens entries
    // (Try Again / In the Air / etc.) read coverImage directly from
    // allShowsScored; for shows that pre-date the cover-fetch path or
    // that landed via a thin AniList query, large/medium can be null.
    // Lazy SW backfill (later in this file) requests the full Media
    // for these IDs so storage.onChanged triggers a re-render with
    // the real cover once it lands.
    img.style.display = 'none';
    const placeholder = document.createElement('span');
    placeholder.className = 'card-cover-placeholder';
    placeholder.textContent = title
      .split(/\s+/)
      .map(w => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
    cover.appendChild(placeholder);
  }
  if (rec.coverImage?.color) {
    cover.style.background = rec.coverImage.color;
  }

  const titleEl = node.querySelector('.card-title');
  titleEl.textContent = title;
  titleEl.href = url;
  titleEl.addEventListener('click', e => navigateToShowFromCard(e, url));

  // Display the franchise's strongest finalScore across lenses (passed
  // in as opts.effectiveFinalScore) rather than this entry's raw score
  // — keeps the same franchise from showing different numbers in Peak
  // vs Try Again. Falls back to the rec's own finalScore for entries
  // where no cross-lens map exists.
  const displayScore = opts.effectiveFinalScore ?? rec.finalScore ?? 0;
  const scoreEl = node.querySelector('.card-final-score');
  scoreEl.textContent = displayScore.toFixed(2);
  // Score tier — data-attr drives CSS coloring so high scores glow,
  // low scores dim toward gray. Same thresholds the engine uses for
  // its calibrated bands (taste-fit etc.).
  scoreEl.setAttribute('data-tier', scoreTier(displayScore));

  // Card-level rank attr powers the #1 aura (CSS [data-rank="1"]
  // selector). Set even when no rank prop passed so re-renders that
  // strip rank can clear it cleanly.
  const cardRoot = node.querySelector('.card');
  if (cardRoot) {
    if (typeof opts.rank === 'number' && opts.rank > 0) {
      cardRoot.setAttribute('data-rank', String(opts.rank));
    } else {
      cardRoot.removeAttribute('data-rank');
    }
  }

  // Rank chip — primary visual signal for "why is this card here?"
  // Answers the friend-voice question that out-of-order displayed scores
  // otherwise leave hanging. The displayed score on each card is honest
  // (engine's calibrated rating of the show in general); the rank
  // position is how that show stacks in *your* picks today after
  // taste-fit, CF re-ranking, and diversification. Combining the two:
  // "#1 pick for you today — and the engine rates it 0.90."
  if (typeof opts.rank === 'number' && opts.rank > 0) {
    const head = node.querySelector('.card-head');
    if (head) {
      const chip = document.createElement('span');
      chip.className = 'card-rank';
      chip.textContent = `#${opts.rank}`;
      // Top-3 ranks get accent-tinted treatment; rest stay muted ghost
      // so the eye lands on the day's actual standouts.
      if (opts.rank <= 3) chip.setAttribute('data-rank-tier', 'top');
      // Insert as the first element of card-head so it leads visually
      // before the title. The rank-vs-score teaching lives in the
      // status-bar legend now, so no per-card title hover needed.
      head.insertBefore(chip, head.firstChild);
    }
  }

  // Vibe-match badge — only when vibes are actively selected. The N/M
  // count drives the badge text; the weighted-strength sum (each vibe
  // 0–100) is exposed via the title for users who want the deeper
  // signal. Rank order is (count DESC, weighted DESC, finalScore DESC).
  if (opts.vibeSelectedCount && opts.vibeMatchCount != null) {
    const head = node.querySelector('.card-head');
    if (head) {
      const badge = document.createElement('span');
      badge.className = 'card-vibe-match';
      badge.textContent = `${opts.vibeMatchCount}/${opts.vibeSelectedCount} vibes`;
      const wstr = opts.vibeMatchWeighted ? ` · strength ${Math.round(opts.vibeMatchWeighted)}` : '';
      badge.title = `Matches ${opts.vibeMatchCount} of your ${opts.vibeSelectedCount} selected vibes${wstr}`;
      head.appendChild(badge);
    }
  }

  // Franchise-aware meta — when rec.franchise rolls up multiple TV
  // seasons, show "N seasons · YYYY–YYYY · M eps" to match the on-
  // page Smart Score card's scope-of-the-whole-show framing.
  // Single-season rec keeps the original "TV · YYYY · N eps" shape.
  const f = rec.franchise;
  const isMultiSeason = f && (f.totalTvSeasons ?? 0) > 1;
  const isMoviesOnlyMulti = f && (f.totalTvSeasons ?? 0) === 0 && (f.movies?.count ?? 0) >= 2;
  if (isMultiSeason) {
    node.querySelector('.card-format').textContent =
      `${f.totalTvSeasons} seasons`;
    let yearText = '';
    const yr = f.yearRange;
    if (Array.isArray(yr) && yr.length === 2) yearText = `${yr[0]}–${yr[1]}`;
    else if (Array.isArray(yr) && yr.length === 1) yearText = `${yr[0]}`;
    node.querySelector('.card-year').textContent = yearText;
    node.querySelector('.card-eps').textContent =
      f.totalTvEps ? `${f.totalTvEps} eps` : '';
  } else if (isMoviesOnlyMulti) {
    // Movies-only multi-film franchises (Heaven's Feel trilogy, etc.)
    // — render "3 movies · 2017–2020" instead of falling through to
    // the single-entry MOVIE · 2017 · 1 eps that misrepresents the
    // CR series page's whole-arc scope.
    node.querySelector('.card-format').textContent = `${f.movies.count} movies`;
    let yearText = '';
    const yr = f.movies.yearRange;
    if (Array.isArray(yr) && yr.length === 2) yearText = `${yr[0]}–${yr[1]}`;
    else if (Array.isArray(yr) && yr.length === 1) yearText = `${yr[0]}`;
    node.querySelector('.card-year').textContent = yearText;
    node.querySelector('.card-eps').textContent = '';
  } else {
    node.querySelector('.card-format').textContent = rec.format || '';
    // Fall back to startDate.year when seasonYear is null — same case
    // commitmentLine handles in content-card.js (ONAs like "To Be Hero
    // X" have startDate.year set but seasonYear unset on AL).
    const yearVal = rec.seasonYear || rec.startDate?.year || '';
    node.querySelector('.card-year').textContent = yearVal;
    node.querySelector('.card-eps').textContent =
      rec.episodes ? `${rec.episodes} eps` : '';
  }
  node.querySelector('.card-avg-score').textContent =
    rec.averageScore ? `★ ${rec.averageScore}` : '';

  const tagsEl = node.querySelector('.card-tags');
  const tags = (rec.topTags || []).slice(0, 4);
  // Friendly-phrase rendering — same map as the in-page card so the
  // two surfaces stay voice-consistent. Falls back to the raw tag
  // name when the phrase engine isn't loaded (extension reload edge
  // case) or when a tag isn't in the map yet.
  const engine = window.crsmartPhraseEngine;
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const phrased = engine ? engine.tagPhrase(t, 'positive') : null;
    chip.textContent = phrased?.text || t.tag;
    tagsEl.appendChild(chip);
  }

  // Lens-specific "why this rec?" line. Empty for peak/comfort
  // (which use the existing 'because you watched X' below).
  const lensWhyEl = node.querySelector('.card-lens-why');
  if (lensWhyEl) {
    const whyText = lensWhyFor(rec, STATE.mode);
    if (whyText) {
      lensWhyEl.textContent = whyText;
    } else {
      lensWhyEl.style.display = 'none';
    }
  }

  const because = node.querySelector('.card-because');
  const sourcesRaw = (rec.sources || [])
    .filter(s => s && s.title)
    .slice(0, 2);
  if (sourcesRaw.length) {
    // Seeded sources come from a tag tap in Quick Taste Check, not a
    // watched show — different lead-in to avoid "because you watched
    // Nudity". If sources are mixed, fall back to the watched phrasing
    // and let the bold tag name speak for itself.
    const allSeeded = sourcesRaw.every(s => s.kind === 'tag-seed');
    const lead = allSeeded ? 'because you tapped ' : 'because you watched ';
    because.appendChild(document.createTextNode(lead));
    sourcesRaw.forEach((s, i) => {
      const b = document.createElement('b');
      // Apply the same franchise normalizer used on rec titles so the
      // "because you watched X" line doesn't read as a string of
      // season tags ("Re:ZERO Season 3, That Time S3") when the user
      // mentally groups them by franchise.
      b.textContent = normalizeFranchiseTitle(s.title);
      because.appendChild(b);
      if (i < sourcesRaw.length - 1) because.appendChild(document.createTextNode(', '));
    });
  }

  const sub = rec.subScores || {};
  for (const k of ['taste', 'rec', 'qual']) {
    const val = sub[k] ?? 0;
    node.querySelector(`.sub-fill[data-key="${k}"]`).style.width = `${val * 100}%`;
    node.querySelector(`.sub-val[data-key="${k}"]`).textContent = val.toFixed(2);
  }

  // CF re-ranker dev overlay — only renders when sidepanel was opened
  // with ?dev=1 AND the rec carries a CF delta (cfApply was active in
  // background.js). Shows the signed delta + cosine + provenance, so
  // the user can audit CF's contribution per card during Phase D
  // observation. Never visible to a default-installation user.
  if (DEV_MODE && rec.cfDelta != null) {
    const head = node.querySelector('.card-head');
    if (head) {
      const pill = document.createElement('span');
      pill.className = 'card-cf-delta';
      const sign = rec.cfDelta >= 0 ? '+' : '';
      const prov = rec.cfProvenance === 'projected' ? ' (proj)' : '';
      pill.textContent = `CF Δ${sign}${rec.cfDelta.toFixed(2)}${prov}`;
      pill.title =
        `cosine=${rec.cfCosine != null ? rec.cfCosine.toFixed(3) : 'n/a'}, ` +
        `provenance=${rec.cfProvenance || 'n/a'}`;
      pill.style.cssText =
        'font: 10px/1 ui-monospace, monospace;' +
        'padding: 2px 5px; border-radius: 4px;' +
        'background: rgba(120, 160, 220, 0.25); color: #cde;' +
        'margin-left: 6px;';
      head.appendChild(pill);
    }
  }

  return node;
}

function renderEmpty() {
  const tpl = $('#empty-template');
  return tpl.content.cloneNode(true);
}

// Lens-aware empty state. The generic "open Crunchyroll and let us
// sync" template only applies to true cold-start (zero history). For a
// user with 50+ watched shows, a specific lens can legitimately return
// zero picks — name the situation honestly so the lens doesn't read
// as broken. The `candidatePool` arg is the unfiltered ranked.length;
// when it's >0 we know data exists, the lens just had no qualifiers.
function renderEmptyForLens(lensId, candidatePool) {
  // True cold-start: no scoring has run yet for this lens at all. Stick
  // with the generic "sync your history" copy.
  if (!candidatePool) {
    return renderEmpty();
  }
  const COPY = {
    'in-the-air':            { icon: '📺', title: 'Nothing airing in your lane yet', hint: 'Currently-airing shows that match your taste will land here as new seasons start.' },
    'from-people-you-trust': { icon: '🎬', title: 'No trusted-studio picks yet',     hint: 'Rate or watch a few more shows so we can learn which studios and creators you trust.' },
    'take-a-chance':         { icon: '🎲', title: 'No stretch picks for you yet',    hint: 'We surface stretch picks outside your top archetypes. Watch more shows to widen the candidate pool.' },
    'canon':                 { icon: '🏛️', title: "You're already on the canon",     hint: "We're not finding well-loved classics you haven't watched — your foundation looks solid." },
    'try-again':             { icon: '↩️', title: 'Nothing worth revisiting',        hint: "We didn't find any dropped shows where your current taste suggests a second look." },
    'rewatched':             { icon: '🔁', title: 'No rewatched shows yet',          hint: "Once you complete a show and come back to even one episode, it'll land here." },
    'peak':                  { icon: '🎯', title: 'No peak picks yet',                hint: "Once we've calibrated your taste, your strongest matches will appear here." },
    'comfort':               { icon: '☕', title: 'No comfort picks yet',             hint: "Brain-off picks land here once we've seen what kinds of shows you cozy into." },
  };
  const c = COPY[lensId] || COPY.peak;
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = `
    <div class="empty-icon">${c.icon}</div>
    <div class="empty-title">${c.title}</div>
    <div class="empty-hint">${c.hint}</div>
  `;
  return wrap;
}

// Patch the mutable fields on an existing card node without re-creating
// it. Used by the diff-update path so re-renders triggered by
// storage.onChanged (a fresh recommendationsScored ref) don't tear
// down and rebuild every DOM node — the prior approach caused visible
// flicker AND made FLIP animation impossible (no stable nodes to
// measure pre/post positions against). Only fields that can actually
// change between renders are patched here: rank chip text, score text,
// vibe-match badge (insert/update/remove based on selection state),
// and cover image (lazy backfill replaces the placeholder). Stable
// fields like topTags / why-this-rec / sub-scores are left as-is; a
// recompute that changes those will be subtle enough that re-rendering
// in-place isn't worth the complexity.
function patchCardOpts(node, rec, opts) {
  const scoreEl = node.querySelector('.card-final-score');
  const display = opts.effectiveFinalScore ?? rec.finalScore ?? 0;
  if (scoreEl) {
    const newScore = display.toFixed(2);
    if (scoreEl.textContent !== newScore) scoreEl.textContent = newScore;
    const newTier = scoreTier(display);
    if (scoreEl.getAttribute('data-tier') !== newTier) {
      scoreEl.setAttribute('data-tier', newTier);
    }
  }
  // Card-level data-rank powers the #1 aura — patch on every diff so
  // when the list re-orders, the aura lands on the new #1, not the
  // previous one.
  const cardRoot = node.classList?.contains('card') ? node : node.querySelector('.card');
  if (cardRoot) {
    if (typeof opts.rank === 'number' && opts.rank > 0) {
      cardRoot.setAttribute('data-rank', String(opts.rank));
    } else {
      cardRoot.removeAttribute('data-rank');
    }
  }
  const rankEl = node.querySelector('.card-rank');
  if (rankEl && typeof opts.rank === 'number') {
    const newRank = `#${opts.rank}`;
    if (rankEl.textContent !== newRank) rankEl.textContent = newRank;
    // Top-3 rank tier flag follows the chip across re-renders.
    const wantTop = opts.rank <= 3;
    const hasTop = rankEl.getAttribute('data-rank-tier') === 'top';
    if (wantTop && !hasTop) rankEl.setAttribute('data-rank-tier', 'top');
    else if (!wantTop && hasTop) rankEl.removeAttribute('data-rank-tier');
  }
  // Vibe-match badge: insert, update, or remove based on selection.
  let vibeBadge = node.querySelector('.card-vibe-match');
  if (opts.vibeSelectedCount && opts.vibeMatchCount != null) {
    const newText = `${opts.vibeMatchCount}/${opts.vibeSelectedCount} vibes`;
    const wstr = opts.vibeMatchWeighted ? ` · strength ${Math.round(opts.vibeMatchWeighted)}` : '';
    const newTitle = `Matches ${opts.vibeMatchCount} of your ${opts.vibeSelectedCount} selected vibes${wstr}`;
    if (!vibeBadge) {
      const head = node.querySelector('.card-head');
      if (head) {
        vibeBadge = document.createElement('span');
        vibeBadge.className = 'card-vibe-match';
        head.appendChild(vibeBadge);
      }
    }
    if (vibeBadge) {
      if (vibeBadge.textContent !== newText) vibeBadge.textContent = newText;
      if (vibeBadge.title !== newTitle) vibeBadge.title = newTitle;
    }
  } else if (vibeBadge) {
    vibeBadge.remove();
  }
  // Cover backfill: if the original render had to use a placeholder
  // because rec.coverImage was missing, swap in the real image now
  // that scheduleCoverBackfill has populated it.
  const img = node.querySelector('.card-cover-img');
  const coverSrc = rec.coverImage?.large || rec.coverImage?.medium;
  if (img && coverSrc && (!img.src || img.src === '' || img.style.display === 'none')) {
    img.src = coverSrc;
    img.style.display = '';
    img.alt = pickTitle(rec.title);
    const placeholder = node.querySelector('.card-cover-placeholder');
    if (placeholder) placeholder.remove();
  }
}

// Franchise-sibling dedup. Multiple per-season AL IDs of the same
// franchise can land in toRender (e.g. Mushoku Tensei S1 + S2 both
// surface as separate recs because manami maps each CR series ID to
// a different AL ID). The user thinks of these as ONE show — having
// two cards with the same display title but different scores reads
// as a bug. Group by normalized franchise title, keep the highest-
// scoring entry per group. Score goes to the kept entry, not an
// average — averaging across entries the user hasn't watched would
// be a synthetic number with no anchor; "best season's score" is
// at least the engine's actual read on a real show.
function dedupeFranchiseSiblings(recs) {
  const seen = new Map();
  for (const rec of recs) {
    const key = pickTitle(rec.title); // already normalized
    const prev = seen.get(key);
    if (!prev || (rec.finalScore || 0) > (prev.finalScore || 0)) {
      seen.set(key, rec);
    }
  }
  return [...seen.values()];
}

// Per-lens dedup leaves cross-lens score discrepancies — Mushoku
// surfaces in Peak at 0.90 (S1) and in Try Again at 0.94 (S2,
// rewatch-boosted). The displayed title is the same after
// normalization, so reading "Mushoku Tensei = 0.94 here, 0.90 there"
// reads as a bug. Walk every lens in STATE.data, find the strongest
// finalScore for each normalized franchise title, return a Map the
// per-card render uses as `effectiveFinalScore`. Matches the on-page
// card's behavior of showing the highest score available for the
// franchise (the rewatch/favorite boosts ride on whichever specific
// season the user touched, but the franchise itself "earned" that
// score).
function buildFranchiseScoreMap(allData) {
  const map = new Map();
  if (!allData) return map;
  for (const lensId of Object.keys(allData)) {
    const ranked = allData[lensId]?.ranked || [];
    for (const r of ranked) {
      if (!r?.title) continue;
      const key = pickTitle(r.title);
      const cur = map.get(key);
      const s = r.finalScore || 0;
      if (cur == null || s > cur) map.set(key, s);
    }
  }
  return map;
}

// Coalesce rapid render() invocations within a single animation frame.
// persistTasteVector writes 3-4 storage keys back-to-back; without
// debouncing, storage.onChanged fires render() for each one, and a
// second render starting while the first's FLIP animation is in
// flight measures pre-mutation positions from the in-flight transform
// rather than the resting position — deltas come out wrong, cards
// visibly snap. rAF coalesce collapses a burst of N storage events
// into one render per paint frame.
let _renderScheduled = false;
function scheduleRender() {
  if (_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(() => {
    _renderScheduled = false;
    render();
  });
}

// FLIP animation — for each existing card that moved between renders,
// invert the translate then transition back to zero. Skips entries
// that didn't move (delta < 1px) and entries that weren't measured
// in the pre-mutation pass (brand-new cards). Also clears any
// in-flight inline transform/transition before measuring so a render
// that interrupts a previous FLIP doesn't pick up the mid-animation
// position as the new "old top."
const FLIP_DURATION_MS = 280;
const FLIP_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
function applyFlipAnimations(list, oldPositions) {
  for (const node of list.querySelectorAll('.card[data-anilist-id]')) {
    const oldTop = oldPositions.get(node.dataset.anilistId);
    if (oldTop == null) continue;
    const newTop = node.getBoundingClientRect().top;
    const delta = oldTop - newTop;
    if (Math.abs(delta) < 1) continue;
    node.style.transition = 'none';
    node.style.transform = `translateY(${delta}px)`;
    requestAnimationFrame(() => {
      node.style.transition = `transform ${FLIP_DURATION_MS}ms ${FLIP_EASING}`;
      node.style.transform = '';
      node.addEventListener('transitionend', function clear() {
        node.style.transition = '';
        node.removeEventListener('transitionend', clear);
      });
    });
  }
}

// Render cards. With no vibes selected, the engine's natural order is
// used. With vibes selected we HARD-FILTER (>= 1 match) AND re-rank
// by (vibeMatch DESC, finalScore DESC) so cards matching MORE of the
// selected vibes float to the top. Without the rerank, selecting 7
// vibes "gives up" — any rec firing even one vibe passes and original
// score-only order is preserved, so the filter feels unresponsive to
// extra selections. With the rerank, each new vibe reshapes the top.
// If zero shows match, we show the no-match notice + bypass link.
//
// Diff-update pass (2026-05-15 night): no more innerHTML='' teardown.
// Cards keyed by data-anilist-id survive across renders — existing
// nodes get patched in place via patchCardOpts; new nodes fade in;
// removed nodes are deleted. Movements are smoothed via FLIP between
// the pre-mutation and post-mutation position measurements. Fixes the
// visible flicker on storage.onChanged + adds reorder animation.
function render() {
  const list = $('#rec-list');

  const modeData = STATE.data?.[STATE.mode];
  const rawRanked = modeData?.ranked || [];
  // Hide entries the user explicitly rejected on the show page. We don't
  // touch the rank pipeline — the underlying recommendationsScored still
  // has them; the side panel just doesn't surface them.
  // Then collapse franchise siblings — multiple per-season AL IDs that
  // share a normalized franchise title get reduced to the strongest
  // entry per franchise, so the panel reads as one card per show.
  const filtered = rawRanked.filter(r => STATE.ratings[r.aniListId] !== '-1');
  const ranked = dedupeFranchiseSiblings(filtered);
  const selectedVibes = STATE.vibes[STATE.mode] || [];
  const anyVibeSelected = selectedVibes.length > 0;
  // Cross-lens franchise score map — keyed by normalized title; value
  // is the highest finalScore for that franchise across every lens
  // currently in STATE.data. Used as `effectiveFinalScore` per card.
  const franchiseScoreMap = buildFranchiseScoreMap(STATE.data);

  if (!ranked.length) {
    list.innerHTML = '';
    list.appendChild(renderEmptyForLens(STATE.mode, rawRanked.length));
    $('#status-text').textContent = 'no data';
    paintVibeMeta(0, 0);
    return;
  }

  let toRender = ranked;
  let matchCount = ranked.length;
  // Map from rec → vibeMatch count, surfaced as a badge on each card
  // when any vibes are selected. Stays null when nothing is selected
  // so the badge stays hidden in the default state.
  let vibeMatchByRec = null;

  if (anyVibeSelected) {
    // Scaled min-threshold. Paired with the rank floor in
    // vibeMatchDetail (minRank=50 default), this keeps the field
    // narrow without filtering out narrow-but-strong matches. 1-2
    // vibes → 1 match; 3-5 → 2; 6-9 → 3. A previous pass used /2
    // which was too aggressive — a 3-vibe-strong show like Mushishi
    // (dreamy/thinky/bittersweet at high rank) wouldn't meet a 4/8
    // count cutoff and got filtered out entirely, leaving broad
    // shounen that fired more vibes but at weaker ranks at the top.
    // The weighted-primary sort below puts strong fires first either
    // way; threshold here is just to prune the long tail of 1-match
    // noise picks.
    const minMatches = Math.max(1, Math.ceil(selectedVibes.length / 3));
    const matched = ranked
      .map((rec, idx) => ({ rec, detail: vibeMatchDetail(rec, selectedVibes), originalIdx: idx }))
      .filter(s => s.detail.count >= minMatches)
      // Primary: weighted strength sum (rank-0-to-100 per fired vibe,
      // summed). A show firing 3 vibes strongly outranks one firing 4
      // weakly — feels closer to what the user means by "this vibe."
      // Secondary: count, so among similar-weight cards the broader
      // match wins. Tertiary: finalScore for ultimate quality tiebreak.
      .sort((a, b) =>
        (b.detail.weighted - a.detail.weighted)
        || (b.detail.count - a.detail.count)
        || ((b.rec.finalScore || 0) - (a.rec.finalScore || 0)));
    matchCount = matched.length;
    vibeMatchByRec = new Map(matched.map(s => [s.rec, s.detail]));
    console.log('[crsmart] vibe filter', {
      mode: STATE.mode,
      vibes: selectedVibes,
      minMatches,
      matched: matched.map(s => ({
        title: pickTitle(s.rec.title),
        count: s.detail.count,
        weighted: s.detail.weighted,
        finalScore: s.rec.finalScore,
      })),
    });
    toRender = matched.map(s => s.rec);
    // QA breadcrumb when the filter comes back empty. Downgraded from
    // warn to info — this is the EXPECTED state mid-toggle while the
    // user is still picking vibes that haven't yet matched anything,
    // and external error trackers were flagging the warn as a bug.
    if (matchCount === 0) {
      console.info('[crsmart] vibe filter empty', {
        lens: STATE.mode,
        vibes: selectedVibes,
        minMatches,
        candidatePool: ranked.length,
      });
    }
  }

  // === DIFF-UPDATE PASS ===
  // 1. Measure existing positions before any DOM mutation so FLIP has
  //    something to compute deltas against. Cancel any in-flight FLIP
  //    transform/transition FIRST so the measurement reads each card's
  //    resting position, not its mid-animation position. Without this,
  //    a render that fires while a previous FLIP is still in flight
  //    captures the in-flight offset as the "old position" and the
  //    next FLIP delta lands at a fraction of the real distance —
  //    visible as a stutter.
  const oldPositions = new Map();
  for (const node of list.querySelectorAll('.card[data-anilist-id]')) {
    if (node.style.transform || node.style.transition) {
      node.style.transition = 'none';
      node.style.transform = '';
    }
    oldPositions.set(node.dataset.anilistId, node.getBoundingClientRect().top);
  }
  // 2. Index existing card nodes by aniListId. Anything that's still
  //    in the new toRender list survives; leftovers get removed at the
  //    end of the pass.
  const existing = new Map();
  for (const node of list.querySelectorAll('.card[data-anilist-id]')) {
    existing.set(node.dataset.anilistId, node);
  }
  // Drop any non-card residue (empty-state, no-vibe-match notice) from
  // the previous render. Cards themselves stay; we'll re-order them
  // via appendChild below.
  for (const child of [...list.children]) {
    if (!child.matches?.('.card[data-anilist-id]')) child.remove();
  }

  if (anyVibeSelected && toRender.length === 0) {
    // Vibes filtered everything out — remove all cards and show the
    // no-match notice. (Existing nodes get the leftover-removal pass.)
    list.appendChild(renderNoVibeMatches(STATE.mode, ranked.length));
  } else {
    for (let i = 0; i < toRender.length; i++) {
      const rec = toRender[i];
      const id = String(rec.aniListId);
      const detail = vibeMatchByRec ? vibeMatchByRec.get(rec) : null;
      // Cross-lens franchise score — falls back to rec's own
      // finalScore if no map entry (e.g. single-lens shows that aren't
      // surfaced anywhere else). Same value is used by both renderCard
      // (fresh) and patchCardOpts (reuse) so a lens switch on the same
      // franchise lands on a consistent number.
      const effectiveFinalScore =
        franchiseScoreMap.get(pickTitle(rec.title)) ?? rec.finalScore;
      const opts = {
        // 1-indexed rank within the displayed list. Friend-voice anchor
        // for "why is this card here?" — answers the question that
        // out-of-order displayed scores otherwise leave hanging
        // (e.g. Mushoku 0.90 above Steins;Gate 0.99 because CF +
        // diversifier ranked it higher *for this user*). Stays
        // accurate when vibe filters reorder the list.
        rank: i + 1,
        vibeMatchCount: detail?.count || 0,
        vibeMatchWeighted: detail?.weighted || 0,
        vibeSelectedCount: selectedVibes.length,
        effectiveFinalScore,
      };
      let node = existing.get(id);
      if (node) {
        // Reuse — patch only the fields that can change between
        // renders. Position moves are handled by the appendChild below
        // (existing-child appendChild is a silent move) + FLIP.
        patchCardOpts(node, rec, opts);
        existing.delete(id);
        list.appendChild(node);
      } else {
        // First time we're seeing this aniListId in the rendered list.
        // Build via renderCard, tag the .card with the stable id, mark
        // for fade-in via .card-entering (CSS handles the transition).
        const frag = renderCard(rec, opts);
        node = frag.firstElementChild;
        if (node) {
          node.dataset.anilistId = id;
          node.classList.add('card-entering');
          list.appendChild(node);
          requestAnimationFrame(() => node.classList.remove('card-entering'));
        }
      }
    }
  }
  // 3. Remove leftovers — cards that were in the prior render but
  //    aren't in toRender anymore (rated -1, filtered by vibe, etc.).
  for (const stale of existing.values()) {
    stale.remove();
  }
  // 4. FLIP — animate any existing card whose position changed.
  applyFlipAnimations(list, oldPositions);

  paintVibeMeta(selectedVibes.length, anyVibeSelected ? matchCount : null);

  const ts = modeData?.computedAt;
  const countLabel = anyVibeSelected
    ? `${matchCount} of ${ranked.length} match vibe`
    : `${ranked.length} picks`;
  $('#status-text').textContent = `${countLabel} · updated ${relativeTime(ts)}`;

  // NOTE: scroll-position restore lives in setMode() now, not here.
  // With the diff-update pass keeping card DOM nodes stable across
  // renders, storage.onChanged-triggered re-renders preserve scroll
  // naturally — restoring scroll on every render would clobber the
  // user's current position whenever the worker writes a recomputed
  // rec list. Mode-switch is the only path that needs explicit
  // restore (different lens = different content = different anchor).

  // Fire-and-forget cover-art backfill for picks missing coverImage. The
  // new lenses read entries straight from allShowsScored, which can have
  // null coverImage for shows fetched through thinner AniList queries.
  // We collect the missing aniListIds and ask the SW to bulkFetchByIds
  // them — the SW patches allShowsScored + recommendationsScored entries
  // in place, storage.onChanged triggers render(), and covers appear.
  scheduleCoverBackfill(toRender);
}

// De-dup backfill requests across renders. STATE.requestedCoverIds
// remembers which aniListIds we've already asked for so toggling lenses
// or vibes doesn't refetch the same set on every render. Cleared if
// the user hits Refresh (full recompute will repopulate covers).
function scheduleCoverBackfill(recs) {
  if (!chrome?.runtime?.sendMessage) return;
  if (!STATE.requestedCoverIds) STATE.requestedCoverIds = new Set();
  const missing = [];
  for (const rec of recs) {
    const hasCover = rec?.coverImage?.large || rec?.coverImage?.medium;
    if (hasCover) continue;
    const id = rec?.aniListId;
    if (typeof id !== 'number') continue;
    if (STATE.requestedCoverIds.has(id)) continue;
    STATE.requestedCoverIds.add(id);
    missing.push(id);
  }
  if (!missing.length) return;
  // Cap per-request so a giant list of bare entries doesn't trigger
  // a multi-page AniList fetch all at once. AniList Page max is 50;
  // we batch lower to leave headroom for the SW's other concurrent
  // fetches.
  const batch = missing.slice(0, 30);
  try {
    chrome.runtime.sendMessage({ type: 'sidebar:backfillCovers', aniListIds: batch });
  } catch (err) {
    console.warn('[crsmart-sidepanel] cover backfill request failed', err);
  }
}

function renderNoVibeMatches(lensId, candidatePool) {
  // Lens-aware empty-state copy. When the candidate pool itself is
  // small (In the Air, You've Missed, Try Again can legitimately
  // surface 10-25 shows total), a vibe selection that doesn't
  // intersect any of them isn't a "wrong vibe combo" problem — it's
  // a narrow-lens problem. Naming the situation helps the user
  // choose between "loosen vibes" and "try a different lens."
  const NARROW_LENSES = new Set(['in-the-air', 'canon', 'try-again']);
  const isNarrow = NARROW_LENSES.has(lensId) && candidatePool <= 30;
  const title = isNarrow
    ? "This lens is narrow today"
    : "No picks match these vibes";
  const hint = isNarrow
    ? `Only ${candidatePool} candidates fit this lens at the moment, and none match your vibe combo. Try a wider lens or `
    : `Try a different vibe combo, or `;
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = `
    <div class="empty-icon">🎯</div>
    <div class="empty-title">${title}</div>
    <div class="empty-hint">
      ${hint}<a href="#" id="vibe-bypass" class="link-inline">show ${isNarrow ? 'this lens unfiltered' : 'top picks anyway'}</a>.
    </div>
  `;
  wrap.querySelector('#vibe-bypass').addEventListener('click', e => {
    e.preventDefault();
    clearVibes();
  });
  return wrap;
}

function setMode(mode) {
  // G13-deep: mode is now any LENS_TABS id, not just peak/comfort.
  // Validate against the registry; unknown modes default to peak.
  const known = LENS_TABS.some(l => l.id === mode);
  if (!known) mode = 'peak';
  // Save current scroll position for the outgoing lens so the user
  // lands back at the same row when they tab back. No-op when the
  // mode didn't actually change (e.g., re-clicking the active pill).
  if (STATE.mode && STATE.mode !== mode) {
    const list = document.getElementById('rec-list');
    if (list) STATE.scrollByMode[STATE.mode] = list.scrollTop;
  }
  STATE.mode = mode;
  $$('.mode-pill').forEach(p => {
    const isActive = p.dataset.mode === mode;
    p.classList.toggle('active', isActive);
    p.setAttribute('aria-selected', String(isActive));
  });
  // Mode-aware typography & accent palette. The body classes only
  // tone for peak vs comfort (existing styling); other lenses use
  // the default neutral tone.
  document.body.classList.toggle('mode-peak', mode === 'peak');
  document.body.classList.toggle('mode-comfort', mode === 'comfort');
  chrome.storage.local.set({ [MODE_KEY]: mode });
  renderVibeChips();
  // Reset the search bar on lens switch — a half-typed query doesn't
  // carry meaning across lenses, and leaving it stale would feel like
  // the input forgot what the user is looking at.
  const searchInput = $('#vibe-search-input');
  if (searchInput) searchInput.value = '';
  closeVibeSearchDropdown();
  render();
  // Restore the per-lens scroll position captured on the previous
  // setMode. Runs HERE (not in render) so storage-driven re-renders
  // don't clobber the user's current scroll mid-session. Skipped when
  // a vibe is selected (filter changes the list length so the old
  // offset is meaningless).
  const list = document.getElementById('rec-list');
  if (list) {
    const anyVibeSelected = (STATE.vibes[STATE.mode] || []).length > 0;
    if (!anyVibeSelected) {
      const saved = STATE.scrollByMode[STATE.mode];
      list.scrollTop = (typeof saved === 'number' && saved > 0) ? saved : 0;
    }
  }
}

// G13-deep + 2026-05-15 grid pass: render the mode-bar pills from
// LENS_TABS as a 2-col grid. Hidden lenses (per STATE.lensVisibility)
// are skipped. A horizontal divider row spans both columns between
// adjacent visible tabs whose `group` field differs (discovery →
// history). The divider is purely visual (aria-hidden) — signals the
// semantic split without adding a row or hiding lenses.
function isLensVisible(lensId) {
  const v = STATE.lensVisibility?.[lensId];
  return v !== false; // missing = visible (default-on)
}
function renderModeBar() {
  const bar = document.getElementById('mode-bar');
  if (!bar) return;
  const parts = [];
  let prevGroup = null;
  for (const lens of LENS_TABS) {
    if (!isLensVisible(lens.id)) continue;
    if (prevGroup && lens.group && prevGroup !== lens.group) {
      parts.push(`<span class="mode-divider" aria-hidden="true"></span>`);
    }
    const isActive = lens.id === STATE.mode;
    parts.push(`<button class="mode-pill${isActive ? ' active' : ''}" data-mode="${lens.id}" role="tab" aria-selected="${isActive}">
      <span class="mode-name">${lens.name}</span>
      <span class="mode-hint">${lens.hint}</span>
    </button>`);
    prevGroup = lens.group || prevGroup;
  }
  bar.innerHTML = parts.join('');
  bar.querySelectorAll('.mode-pill').forEach(p => {
    p.addEventListener('click', () => setMode(p.dataset.mode));
  });
  // If the currently-active lens just got hidden, fall back to the
  // first visible lens so the panel doesn't end up with no active tab.
  if (!isLensVisible(STATE.mode)) {
    const firstVisible = LENS_TABS.find(l => isLensVisible(l.id));
    if (firstVisible) setMode(firstVisible.id);
  }
}

// Inline overlay for customizing visible lenses. Anchored to the
// mode-bar-edit button in the mode-bar-wrap; click-outside dismisses.
// Persists to chrome.storage.local.lensVisibility = { [id]: bool }.
const LENS_VISIBILITY_KEY = 'lensVisibility';
function openLensVisibilityOverlay() {
  closeLensVisibilityOverlay(); // dedup
  const wrap = document.querySelector('.mode-bar-wrap');
  if (!wrap) return;
  const overlay = document.createElement('div');
  overlay.className = 'lens-visibility-overlay';
  overlay.id = 'lens-visibility-overlay';
  // Group rendering — section headers above each cluster of lenses.
  // Mirrors the bar's own divider semantics but spelled out as text
  // here since the overlay has the room to.
  const groupLabel = g => g === 'history' ? 'History' : 'Discovery';
  const groupsSeen = new Set();
  const parts = [`<div class="lens-visibility-overlay-head">Show lens</div>`];
  for (const lens of LENS_TABS) {
    if (lens.group && !groupsSeen.has(lens.group)) {
      groupsSeen.add(lens.group);
      parts.push(`<div class="lens-visibility-overlay-group">${groupLabel(lens.group)}</div>`);
    }
    const checked = isLensVisible(lens.id) ? 'checked' : '';
    parts.push(`<label>
      <input type="checkbox" data-lens-id="${lens.id}" ${checked} />
      <span>${lens.name}</span>
    </label>`);
  }
  overlay.innerHTML = parts.join('');
  wrap.appendChild(overlay);
  // Wire checkbox changes — persist + re-render bar immediately so the
  // user sees the effect without closing the overlay.
  overlay.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const lensId = cb.dataset.lensId;
      const next = { ...(STATE.lensVisibility || {}) };
      next[lensId] = cb.checked;
      STATE.lensVisibility = next;
      chrome.storage.local.set({ [LENS_VISIBILITY_KEY]: next });
      renderModeBar();
    });
  });
  // Click-outside-to-close. Defer one tick so the click that opened
  // the overlay doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('click', onOverlayOutsideClick, { capture: true });
  }, 0);
}
function closeLensVisibilityOverlay() {
  const existing = document.getElementById('lens-visibility-overlay');
  if (existing) existing.remove();
  document.removeEventListener('click', onOverlayOutsideClick, { capture: true });
}
function onOverlayOutsideClick(event) {
  const overlay = document.getElementById('lens-visibility-overlay');
  const editBtn = document.getElementById('mode-bar-edit');
  if (!overlay) return;
  if (overlay.contains(event.target) || editBtn?.contains(event.target)) return;
  closeLensVisibilityOverlay();
}

// Vibe-bar (+ status-bar legend) collapse state. The body class drives
// CSS for both surfaces in one pass (see body.vibe-bar-collapsed rules
// in sidepanel.css). Toggle button caret rotates via the same class.
function applyVibeBarCollapsed() {
  document.body.classList.toggle('vibe-bar-collapsed', STATE.vibeBarCollapsed === true);
  const toggle = document.getElementById('vibe-bar-toggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!STATE.vibeBarCollapsed));
    toggle.setAttribute('title',
      STATE.vibeBarCollapsed ? 'Expand vibe chips' : 'Collapse vibe chips');
  }
}
function toggleVibeBarCollapsed() {
  STATE.vibeBarCollapsed = !STATE.vibeBarCollapsed;
  applyVibeBarCollapsed();
  chrome.storage.local.set({ [VIBE_BAR_COLLAPSED_KEY]: STATE.vibeBarCollapsed });
}

// View mode (Detail / Casual / Compact). The CSS scopes layout rules
// to body.view-mode-{name}, so applying the class is the whole effect.
// Card DOM is unchanged — render() and patchCardOpts stay
// view-mode-agnostic, which means switching modes is instant + the
// FLIP/diff pipeline keeps working unchanged.
function applyViewMode() {
  const mode = VALID_VIEW_MODES.has(STATE.viewMode) ? STATE.viewMode : 'detail';
  for (const m of VALID_VIEW_MODES) {
    document.body.classList.toggle(`view-mode-${m}`, m === mode);
  }
  for (const btn of document.querySelectorAll('.view-mode-btn')) {
    const isActive = btn.dataset.view === mode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }
}
function setViewMode(mode) {
  if (!VALID_VIEW_MODES.has(mode) || mode === STATE.viewMode) return;
  STATE.viewMode = mode;
  applyViewMode();
  chrome.storage.local.set({ [VIEW_MODE_KEY]: mode });
}

// Legend toggle ((?) button next to view-mode toggle). Collapses the
// "# = your rank / 0.9 = engine score" explainer behind a single
// affordance so it doesn't take ~50px of vertical real estate on every
// panel open. State persists via localStorage (UI-only preference,
// doesn't need cross-device sync) so the choice sticks across opens.
const LEGEND_OPEN_KEY = 'crsmart.legendOpen';
function wireLegendToggle() {
  const btn = document.getElementById('status-legend-toggle');
  const body = document.getElementById('status-legend-body');
  if (!btn || !body) return;
  const apply = (open) => {
    body.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  // Default closed; honor stored preference if user has toggled before.
  const stored = (() => {
    try { return localStorage.getItem(LEGEND_OPEN_KEY); }
    catch { return null; }
  })();
  apply(stored === '1');
  btn.addEventListener('click', () => {
    const willOpen = body.hidden;
    apply(willOpen);
    try { localStorage.setItem(LEGEND_OPEN_KEY, willOpen ? '1' : '0'); }
    catch { /* localStorage unavailable — UI still works, just no persistence */ }
  });
}

// G10: surface toggle (Picks ↔ Shape). The two surfaces share one
// side panel — Picks is the rec list (existing behavior); Shape is
// the taste-shape radar view (new). State persists per session
// per north-star Q19b: last-viewed mode opens by default next time.
function setSurface(surface) {
  if (surface !== 'picks' && surface !== 'shape') return;
  STATE.surface = surface;
  $$('.surface-tab').forEach(t => {
    const isActive = t.dataset.surface === surface;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', String(isActive));
  });
  $$('.surface').forEach(s => {
    s.classList.toggle('hidden', !s.classList.contains(`surface-${surface}`));
  });
  // Keep the header "?" deep-link in sync with the active surface.
  const helpLink = document.getElementById('help-link');
  if (helpLink) {
    helpLink.setAttribute('href', `help.html#${surface === 'shape' ? 'shape' : 'picks'}`);
  }
  chrome.storage.local.set({ [SURFACE_KEY]: surface });
  if (surface === 'shape') {
    // Surface tab change: force a render regardless of fingerprint
    // because the surface was just unhidden and we want the intro to
    // replay each time the user lands on it.
    shapeView.render();
    triggerShapeIntro();
  }
  // First-encounter coach marks per the alpha-polish plan (Q6).
  // Anchored to the active tab itself so a click that triggered the
  // switch reads as "the thing you just clicked is this."
  setTimeout(() => {
    const activeTab = document.querySelector(`.surface-tab[data-surface="${surface}"]`);
    if (!activeTab) return;
    if (surface === 'picks') {
      showCoachMarkOnce({
        key: 'side-panel-picks',
        anchor: activeTab,
        title: 'Your Smart Picks',
        body: 'Each card shows a Smart Score and a tier — TRUST ME / STRETCH / WORTH A SHOT. Click one to open it on Crunchyroll.',
      });
    } else if (surface === 'shape') {
      showCoachMarkOnce({
        key: 'side-panel-shape',
        anchor: activeTab,
        title: 'Your Taste Shape',
        body: 'The radar shows what kind of viewer you are. Trust the longest spikes; mid-rank axes need more shows to be confident.',
      });
    }
  }, 250);
}

// ── Phase 4: Taste-shape settings application (2026-05) ────
// Reads the three tunables from STATE (cached from surfaceSettings on
// load + storage.onChanged) and applies them to the live DOM:
//   - tasteShapeAnimateBg → toggles .is-animating on the panel motif
//     so the per-family idle-motion CSS keyframes activate.
//   - tasteShapeBgOpacity → sets --motif-opacity-mul on the motif so
//     the wallpaper can be dialed louder/quieter (the CSS var is
//     consumed via `opacity: var(--motif-opacity-mul, 1)`).
//   - tasteShapeIntroAnim → consulted inside triggerShapeIntro itself
//     (no DOM toggle needed here).
// Idempotent: safe to call on every load(), settings change, and
// surface change; no-ops if the motif element isn't present (cold-
// start renders no motif, so applying class/var is harmless).
function applyTasteShapeSettings() {
  const surface = document.querySelector('.surface-shape');
  if (!surface) return;
  const motif = surface.querySelector(':scope > .shape-panel-motif');
  if (!motif) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // BG motion only when the user opts in AND no reduced-motion pref.
  const animate = STATE.tasteShapeAnimateBg !== false && !reduced;
  motif.classList.toggle('is-animating', animate);
  // Atmosphere intensity (storage key kept as tasteShapeBgOpacity for
  // back-compat). 0–100 → 0.0–1.0 multiplier on the motif container.
  const opacityMul = Math.max(0, Math.min(100, STATE.tasteShapeBgOpacity ?? 100)) / 100;
  motif.style.setProperty('--motif-opacity-mul', String(opacityMul));
  // Tempo — 4-state ('off' | 'swift' | 'balanced' | 'leisurely').
  // Drives both intro-duration (consumed by the intro animation
  // keyframes in CSS) and motif-breath-duration (consumed by canvas
  // painters via window.__animTempo + by any residual CSS keyframes).
  // 'off' takes the same path as animate=false (canvas unmounted),
  // so we only need to set vars for the three "on" tempos.
  const tempo = STATE.tasteShapeAnimTempo || 'balanced';
  const root = document.documentElement;
  switch (tempo) {
    case 'swift':
      root.style.setProperty('--intro-duration', '1.4s');
      root.style.setProperty('--motif-breath-duration', '3s');
      break;
    case 'leisurely':
      root.style.setProperty('--intro-duration', '5s');
      root.style.setProperty('--motif-breath-duration', '12s');
      break;
    case 'off':
    case 'balanced':
    default:
      root.style.setProperty('--intro-duration', '2.9s');
      root.style.setProperty('--motif-breath-duration', '6s');
  }
  // Canvas painters read this directly each frame to scale per-painter
  // start delays and cycle lengths (e.g. auteur brush stagger).
  window.__animTempo = tempo;
}

// Motion toggle in the shape-header — flips
// surfaceSettings.tasteShapeAnimateBg. The storage.onChanged handler
// already re-caches STATE.tasteShapeAnimateBg and re-runs
// paintShapePanelMotif, so writing to storage is the only thing this
// click does. Reduced-motion users get the button labelled accurately
// (their preference still blocks animation regardless of the toggle).
function syncMotionToggle() {
  const btn = document.getElementById('shape-motion-toggle');
  if (!btn) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animating = STATE.tasteShapeAnimateBg !== false && !reduced;
  btn.classList.toggle('is-static', !animating);
  // Title reflects the action click will take next, plus a note when
  // OS-level reduced-motion is the load-bearing reason animations are
  // off (clicking the button won't override that).
  if (reduced && STATE.tasteShapeAnimateBg !== false) {
    btn.title = 'Animations disabled by your system\'s reduced-motion preference';
  } else if (animating) {
    btn.title = 'Hide the animated wallpaper';
  } else {
    btn.title = 'Show the animated wallpaper';
  }
}

function wireMotionToggle() {
  const btn = document.getElementById('shape-motion-toggle');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const stored = await chrome.storage.local.get('surfaceSettings');
    const next = { ...(stored.surfaceSettings || {}) };
    // Defaults to true; flipping respects the current effective value.
    next.tasteShapeAnimateBg = !(next.tasteShapeAnimateBg !== false);
    await chrome.storage.local.set({ surfaceSettings: next });
    // The storage.onChanged listener handles STATE + canvas re-paint.
    // Sync the button text immediately so users see the click landed
    // without waiting for the storage event round-trip.
    STATE.tasteShapeAnimateBg = next.tasteShapeAnimateBg;
    syncMotionToggle();
  });
  syncMotionToggle();
}

// Page Visibility hook: pause every motif animation when the panel
// tab is hidden so we don't burn CPU on offscreen breath/rotate
// loops. Single class on the motif container — the CSS .is-paused-
// by-visibility * { animation-play-state: paused } handles the rest.
function wireVisibilityPause() {
  const apply = () => {
    const motif = document.querySelector('.surface-shape > .shape-panel-motif');
    if (motif) motif.classList.toggle('is-paused-by-visibility', document.hidden);
    // Canvas RAF pause/resume — cancels the loop entirely when the
    // panel tab is hidden so we don't burn CPU painting offscreen.
    if (_shapeCanvasHandle) {
      if (document.hidden) _shapeCanvasHandle.pause();
      else _shapeCanvasHandle.resume();
    }
  };
  document.addEventListener('visibilitychange', apply);
  apply(); // initial state in case the panel mounts already-hidden
}

// ── Phase 3: Intro animation trigger (2026-05) ─────────────
// Plays the ~2.9s shape-tab intro sequence. All animation selectors
// anchor on .surface-shape so SVG/motif inner-html rewrites can't
// strip the state mid-animation. Two classes are toggled together:
//   - intro-armed: forces every animated child to its from-state by
//     default (invisible / dashoffset=100 / etc.). Set on the surface
//     in HTML so a fresh panel boot doesn't briefly flash the fully
//     rendered Shape view before is-entering is added.
//   - is-entering: actually triggers the keyframe animations.
// On cleanup, both are stripped so subsequent re-renders without an
// intro (e.g., dev-sandbox slider tweaks) display elements normally.
//
// The stale-cleanup timer is cancelled on re-trigger so it can't
// strip the classes mid-animation. void offsetWidth between class-
// remove and class-add forces a layout flush that reliably restarts
// the keyframe animations.
//
// Triggers: setSurface('shape'), the storage.onChanged path when a
// real radar update arrives, and crsmart:replay-shape-intro from the
// background topbar handler. Dev-sandbox slider/preset changes do
// NOT trigger this — debug surface, not user-primary (per Q6 spec).
let _shapeIntroCleanupTimer = null;
function triggerShapeIntro() {
  const surface = document.querySelector('.surface-shape');
  if (!surface) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Tempo gates the intro animation. 'off' → skip entirely (same path
  // as reduced-motion). Any other value → play; CSS reads the
  // --intro-duration var (set by applyTasteShapeSettings) to scale.
  // Back-compat: if the legacy tasteShapeIntroAnim === false is still
  // around (pre-migration boot), respect it as 'off'.
  const introDisabled =
    STATE.tasteShapeAnimTempo === 'off' ||
    (STATE.tasteShapeAnimTempo == null && STATE.tasteShapeIntroAnim === false);
  if (reduced || introDisabled) {
    // Skip the animation entirely. Strip intro-armed so the elements
    // display in their final state (the @media reduced-motion CSS
    // override also handles this defensively for boot-time before JS
    // runs, but stripping here keeps the DOM clean).
    surface.classList.remove('is-entering');
    surface.classList.remove('intro-armed');
    return;
  }
  // Cancel any pending cleanup so it can't strip the classes while
  // the new animation is still playing.
  if (_shapeIntroCleanupTimer) {
    clearTimeout(_shapeIntroCleanupTimer);
    _shapeIntroCleanupTimer = null;
  }
  // Reset to from-state and re-arm. Removing is-entering then forcing
  // a reflow before re-adding it is the standard CSS-animation
  // restart pattern.
  surface.classList.remove('is-entering');
  surface.classList.add('intro-armed');
  void surface.offsetWidth;
  surface.classList.add('is-entering');
  // Cleanup ~3s later — strips both classes so the elements default
  // to their base (visible) state. Subsequent renders without the
  // intro pick up the normal CSS, with no flash.
  _shapeIntroCleanupTimer = setTimeout(() => {
    surface.classList.remove('is-entering');
    surface.classList.remove('intro-armed');
    _shapeIntroCleanupTimer = null;
  }, 3100);
}

// ── Phase 2: Panel-wide family BG motif (canvas, 2026-05) ──
// Per-family ambient texture rendered as a panel-level wallpaper
// behind every Shape-surface element. Implementation lives in
// shape-canvas-painters.js — eight hand-authored canvas painters
// (drama/romance/comfort/spectacle/comedy/mystery/auteur/mixed),
// imported as `mountShapeCanvas` and orchestrated by
// paintShapePanelMotif below. The previous SVG buildPanelBgMotif
// + matching CSS keyframes were retired in this pass.
//
// Sub-15% opacity baseline. Cold-start surface skips this entirely
// (renderShape clears the motif container before the cold branch).

// ── G09: Taste Shape rendering ──────────────────────────────
// Builds an SVG radar chart from the radar data, plus a per-axis
// legend below. Pure DOM building; no chart library. Geometry: 8
// axes at 45° intervals starting from top, polygon connects each
// axis's normalized value out from center.
// Shape palette — owns the CSS custom-property writes for --family-h/s/l
// and --arch-h/s/l on the shape surface. Idempotent: comparison short-
// circuits the 6 setProperty calls when neither tuple has changed.
// Previously the writes were inlined at both the cold-start branch and
// the real-radar branch of renderShape, with no dirty check — so any
// storage.onChanged that re-ran renderShape paid the writes regardless
// of whether the archetype actually changed. Concentrating the writes
// here also gives one home for the "default to brand orange when
// familyBaseHsl is missing" fallback that older cached radars need.
const shapePalette = (() => {
  let lastFamily = null;
  let lastArch = null;
  const sameTuple = (a, b) => a && b && a.h === b.h && a.s === b.s && a.l === b.l;
  return {
    apply(surface, familyHsl, archHsl) {
      if (!surface) return;
      const f = familyHsl || { h: 25, s: 100, l: 58 };
      const a = archHsl   || { h: 25, s: 100, l: 58 };
      if (!sameTuple(f, lastFamily)) {
        surface.style.setProperty('--family-h', String(f.h));
        surface.style.setProperty('--family-s', `${f.s}%`);
        surface.style.setProperty('--family-l', `${f.l}%`);
        lastFamily = f;
      }
      if (!sameTuple(a, lastArch)) {
        surface.style.setProperty('--arch-h',   String(a.h));
        surface.style.setProperty('--arch-s',   `${a.s}%`);
        surface.style.setProperty('--arch-l',   `${a.l}%`);
        lastArch = a;
      }
    },
    // Cold-start: neutral grey palette (saturation=0 → grey regardless
    // of hue). Distinct from the brand-orange fallback so genuine Mixed
    // users don't share the cold-start visual.
    applyCold(surface) {
      this.apply(surface,
        { h: 0, s: 0, l: 50 },
        { h: 0, s: 0, l: 45 });
    },
  };
})();

// Radar geometry constants. Lifted out of buildRadarSvg so both the
// initial-mount and the per-render patch path share the same math
// without duplicating literals (RADIUS, viewBox, etc.).
const RADAR_W = 400;
const RADAR_H = 320;
const RADAR_CX = RADAR_W / 2;
const RADAR_CY = RADAR_H / 2;
const RADAR_RADIUS = 100;
const RADAR_LABEL_RADIUS = RADAR_RADIUS + 22;
const RADAR_CURVE_TENSION = 0.3;
const RADAR_FLAT_FALLBACK = 0.1;

// Catmull-Rom (closed) → cubic-bezier path through the value vertices.
// Tension 0.3 keeps single-axis spikes sharp while smoothing the joins;
// when two adjacent vertices both have v < 0.1 (cold-start / very thin
// data), fall back to a straight segment so the curve doesn't loop or
// kink near the center where bunched control points produce ugly math.
// Shared by buildRadarSvg (initial mount string) and patchRadarValues
// (per-render attribute patch) — extracted so the geometry can't drift
// between the two paths.
function computeRadarValueD(positions) {
  const n = positions.length;
  if (n === 0) return '';
  const valueVertices = positions.map(p => {
    const v = Math.max(0, Math.min(1, p.axis.value || 0));
    return {
      v,
      x: RADAR_CX + RADAR_RADIUS * v * Math.cos(p.angle),
      y: RADAR_CY + RADAR_RADIUS * v * Math.sin(p.angle),
    };
  });
  const k = (1 - RADAR_CURVE_TENSION) / 6;
  let d = `M ${valueVertices[0].x.toFixed(2)} ${valueVertices[0].y.toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = valueVertices[(i - 1 + n) % n];
    const p1 = valueVertices[i];
    const p2 = valueVertices[(i + 1) % n];
    const p3 = valueVertices[(i + 2) % n];
    if (p1.v < RADAR_FLAT_FALLBACK && p2.v < RADAR_FLAT_FALLBACK) {
      d += ` L ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
      continue;
    }
    const c1x = p1.x + (p2.x - p0.x) * k;
    const c1y = p1.y + (p2.y - p0.y) * k;
    const c2x = p2.x - (p3.x - p1.x) * k;
    const c2y = p2.y - (p3.y - p1.y) * k;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)},`
      +  ` ${c2x.toFixed(2)} ${c2y.toFixed(2)},`
      +  ` ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d + ' Z';
}

function computeRadarPositions(axes) {
  const N = axes.length;
  return axes.map((a, i) => {
    const angle = (i / N) * 2 * Math.PI - Math.PI / 2;
    return {
      axis: a,
      angle,
      x: RADAR_CX + RADAR_RADIUS * Math.cos(angle),
      y: RADAR_CY + RADAR_RADIUS * Math.sin(angle),
      labelX: RADAR_CX + RADAR_LABEL_RADIUS * Math.cos(angle),
      labelY: RADAR_CY + RADAR_LABEL_RADIUS * Math.sin(angle),
    };
  });
}

// Structural signature — drives the mount-vs-patch decision in
// renderRadarInto. Two SVGs with matching signatures share the same
// static skeleton (grid, spokes, ticks, labels, defs, line-treatment
// scaffolding), so the per-render patch path can update only the
// polygon `d` + vertex cx/cy. A mismatch means we need to rebuild.
// Includes: axis count + axis ids (label geometry), line treatment
// (double-stroke path presence), and glyph-suppression (vertex layer
// presence).
function radarStructuralSig(radar) {
  const axes = radar.axes || [];
  const lineTreatment = radar.lineTreatment || 'solid';
  const showVerts = radar.glyph === null ? '0' : '1';
  return `${axes.length}|${lineTreatment}|${showVerts}|${axes.map(a => a.id).join(',')}`;
}

// Per-render patch: update the polygon path + vertex coordinates on an
// existing SVG without rebuilding the rest. Caller has verified the
// structural signature matches (see renderRadarInto). Roughly 5-10×
// cheaper than a full innerHTML rebuild — more importantly, the polygon
// element is the same DOM ref across renders, so an intro animation
// (stroke-dashoffset trace) keeps its current state instead of being
// interrupted by node replacement.
function patchRadarValues(svgEl, radar) {
  const axes = radar.axes || [];
  if (axes.length === 0) return;
  const positions = computeRadarPositions(axes);
  const d = computeRadarValueD(positions);

  const poly = svgEl.querySelector('.radar-polygon');
  if (poly) poly.setAttribute('d', d);
  const polyDouble = svgEl.querySelector('.radar-polygon-double');
  if (polyDouble) polyDouble.setAttribute('d', d);

  for (let i = 0; i < positions.length; i++) {
    const vert = svgEl.querySelector(`.radar-vertex[data-axis-id="${positions[i].axis.id}"]`);
    if (!vert) continue;
    const v = Math.max(0, Math.min(1, positions[i].axis.value || 0));
    const vx = RADAR_CX + RADAR_RADIUS * v * Math.cos(positions[i].angle);
    const vy = RADAR_CY + RADAR_RADIUS * v * Math.sin(positions[i].angle);
    vert.setAttribute('cx', vx.toFixed(1));
    vert.setAttribute('cy', vy.toFixed(1));
  }
}

// Top-level radar render: mount-or-patch dispatcher. Skeleton (grid,
// spokes, labels, defs) lives ONCE per structural signature; per-radar
// updates flow through patchRadarValues. The signature lets us bail to
// a full rebuild only when the axis layout / line treatment / vertex
// visibility actually changes — in practice the picks→shape→picks
// roundtrip and storage.onChanged re-renders all keep the same sig.
function renderRadarInto(container, radar) {
  if (!container) return;
  if (!radar?.axes?.length) {
    container.innerHTML = '';
    return;
  }
  const sig = radarStructuralSig(radar);
  const existing = container.querySelector('svg');
  if (existing && existing.getAttribute('data-axes-sig') === sig) {
    patchRadarValues(existing, radar);
    return;
  }
  container.innerHTML = buildRadarSvg(radar);
  const fresh = container.querySelector('svg');
  if (fresh) fresh.setAttribute('data-axes-sig', sig);
}

function buildRadarSvg(radar) {
  const axes = radar.axes || [];
  if (axes.length === 0) return '';
  // viewBox sized so the axis labels (positioned at LABEL_RADIUS from
  // center with text-anchor=start/end) live INSIDE the SVG bounds —
  // not just inside via overflow="visible". When the side panel is
  // resized narrow, CSS scales the SVG down with width:100%, and
  // because the font-size is in SVG user units it scales with the
  // viewBox; labels stay readable AND stay inside the panel.
  const W = RADAR_W, H = RADAR_H, CX = RADAR_CX, CY = RADAR_CY;
  const RADIUS = RADAR_RADIUS;

  const positions = computeRadarPositions(axes);

  // Concentric grid rings at value 0.25, 0.5, 0.75, 1.0
  const grid = [0.25, 0.5, 0.75, 1.0].map(level => {
    const pts = positions.map(p => {
      const x = CX + RADIUS * level * Math.cos(p.angle);
      const y = CY + RADIUS * level * Math.sin(p.angle);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`;
  }).join('');

  // Spokes from center to each axis endpoint
  const spokes = positions.map(p =>
    `<line x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="rgba(255,255,255,0.10)" stroke-width="1"/>`
  ).join('');

  // Vertex positions (used by the vertex dots layer below). The path
  // string is computed via the shared helper so initial-mount and
  // per-render patch can't disagree on geometry.
  const valueVertices = positions.map(p => {
    const v = Math.max(0, Math.min(1, p.axis.value || 0));
    return {
      v,
      x: CX + RADIUS * v * Math.cos(p.angle),
      y: CY + RADIUS * v * Math.sin(p.angle),
    };
  });
  const valueD = computeRadarValueD(positions);

  // Axis labels — full axis names ("Comedy / Chaos Appetite",
  // "Romance & Spice", etc.) so the user sees the engine's actual
  // axis identity, not a single-word abbreviation that loses
  // context. Two-line wrap on multi-word names keeps each line
  // short enough that overflow="visible" comfortably handles the
  // sideways extent on left/right axes. Wraps at the last natural
  // delimiter — last " / ", last " & ", or last space — so the
  // delimiter ends line 1 and the trailing word(s) form line 2.
  // Single-word labels (none currently, but defensive) stay one line.
  function wrapAxisLabel(name) {
    // Last-space split. Works for all axis names: "Spectacle Drive"
    // → "Spectacle" / "Drive"; "Comedy / Chaos Appetite" →
    // "Comedy / Chaos" / "Appetite"; "Romance & Spice" →
    // "Romance &" / "Spice"; etc. Trailing punctuation stays on
    // line 1 by design — reads naturally as a continuation.
    const spaceIdx = name.lastIndexOf(' ');
    if (spaceIdx > 0) return [name.slice(0, spaceIdx), name.slice(spaceIdx + 1)];
    return [name];
  }

  const labels = positions.map(p => {
    const dx = p.labelX - CX;
    const anchor = dx < -8 ? 'end' : (dx > 8 ? 'start' : 'middle');
    const lines = wrapAxisLabel(p.axis.name);
    // Vertical centering: shift the first line up by half the wrap
    // count so a two-line label sits visually balanced around the
    // labelY anchor. -0.4em → first line is ~0.4em above center,
    // second line ~1.1em below = ~0.7em below center; visually
    // centered at the spoke endpoint.
    const dy = lines.length === 1 ? '0.35em' : '-0.4em';
    const tspans = lines.map((line, i) =>
      `<tspan x="${p.labelX.toFixed(1)}" dy="${i === 0 ? dy : '1.1em'}">${line}</tspan>`
    ).join('');
    // Use --text-on-tint (set on .surface-shape) so axis labels harmonize
    // subtly with the archetype hue without shifting body copy color.
    return `<text data-axis-id="${p.axis.id}" x="${p.labelX.toFixed(1)}" y="${p.labelY.toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="var(--text-on-tint, rgba(255,255,255,0.85))">${tspans}</text>`;
  }).join('');

  // Vertex dots — small filled circles at each polygon vertex give the
  // shape graspable "anchors" the eye can lock onto, especially for
  // axes near the muted center. Fill color is the archetype hue
  // (read from the shape-surface CSS custom prop via .radar-vertex CSS).
  // glyph === null suppresses the vertex layer entirely (used by the
  // cold-start skeleton).
  const showVertices = radar.glyph !== null;
  const vertices = !showVertices ? '' : positions.map((p, i) => {
    const vx = valueVertices[i];
    // --i carries the vertex index so the intro animation can stagger
    // each vertex's fade-in (CSS reads var(--i, 0) for the delay calc).
    return `<circle class="radar-vertex" data-axis-id="${p.axis.id}" cx="${vx.x.toFixed(1)}" cy="${vx.y.toFixed(1)}" r="3.5" stroke="rgba(20,20,30,0.85)" stroke-width="1.5" style="--i: ${i}"/>`;
  }).join('');

  // Spoke endpoint tick marks (subtle; reads as a graduated scale).
  const endpointTicks = positions.map(p =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.5" fill="rgba(255,255,255,0.20)"/>`
  ).join('');

  // overflow="visible" lets axis labels extend beyond the SVG's
  // viewBox into the surrounding container — without it, "Character"
  // and "Romance" get right-edge / left-edge clipped at the 3 o'clock
  // and 9 o'clock positions even with single-word names. The side
  // panel container has whitespace on both sides for labels to live in.
  //
  // Defs: radial gradient for the value polygon (warmer near center,
  // dimmer at edges) and a soft glow filter for both the polygon
  // stroke and a backdrop circle. Pure cosmetic — the data is the
  // same as the previous flat-fill version.
  // Polygon + vertex + backdrop colors all read from the .surface-shape
  // CSS custom properties (--arch-h/s/l) set in renderShape from the
  // archetype palette. Means one SVG template themes itself across all
  // 32 archetypes — no hardcoded hex.
  // Line treatment: solid (single stroke + standard glow) is the
  // baseline; 'double' adds an inner-lighter parallel stroke under the
  // outer; 'halo' applies a stronger Gaussian-blur glow filter for an
  // extended outer aura. The data-line-treatment attribute on the SVG
  // root lets CSS scope each treatment's stroke styling without
  // duplicating the path element.
  const lineTreatment = radar.lineTreatment || 'solid';
  const filterUrl = lineTreatment === 'halo' ? 'url(#radarGlowHalo)' : 'url(#radarGlow)';
  // For 'double', emit a second path beneath the main stroke — same
  // geometry, wider stroke, lighter hue. The main path renders above.
  const doubleStroke = lineTreatment === 'double'
    ? `<path class="radar-polygon-double" d="${valueD}" pathLength="100" fill="none" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`
    : '';

  // No hardcoded width/height attributes — CSS drives via width:100% +
  // max-width on .shape-radar svg, so the SVG (and its labels, since
  // font-size is in user units) scales proportionally with the panel.
  return `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-label="Taste shape radar" data-line-treatment="${lineTreatment}">
  <defs>
    <radialGradient id="radarFill" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="hsla(var(--arch-h), var(--arch-s), calc(var(--arch-l) + 10%), 0.50)"/>
      <stop offset="100%" stop-color="hsla(var(--arch-h), var(--arch-s), var(--arch-l), 0.22)"/>
    </radialGradient>
    <filter id="radarGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="radarGlowHalo" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <radialGradient id="radarBgGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="hsla(var(--family-h), var(--family-s), var(--family-l), 0.12)"/>
      <stop offset="60%"  stop-color="hsla(var(--family-h), var(--family-s), var(--family-l), 0.03)"/>
      <stop offset="100%" stop-color="hsla(var(--family-h), var(--family-s), var(--family-l), 0)"/>
    </radialGradient>
  </defs>
  <circle cx="${CX}" cy="${CY}" r="${RADIUS + 12}" fill="url(#radarBgGlow)"/>
  ${grid}
  ${spokes}
  ${endpointTicks}
  ${doubleStroke}
  <path class="radar-polygon" d="${valueD}" pathLength="100" fill="url(#radarFill)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" filter="${filterUrl}"/>
  ${vertices}
  ${labels}
</svg>`;
}

// Inject (or reuse) the panel-wide motif container as the first child
// of .surface-shape and mount the canvas painter for the given family.
// Pass family=null to clear (cold-start uses this) — the canvas is
// destroyed and the container left empty.
//
// _shapeCanvasHandle holds the active mount returned by
// mountShapeCanvas. setFamily handles archetype swaps; setMotion(on/off)
// handles the animateBg/reduced-motion toggle without paying canvas
// teardown + ResizeObserver re-setup. Destroy only fires on cold-start
// (family=null) where the canvas legitimately needs to go away.
let _shapeCanvasHandle = null;
let _shapeCanvasFamily = null;

function paintShapePanelMotif(surface, family) {
  if (!surface) return;
  let motifEl = surface.querySelector(':scope > .shape-panel-motif');
  if (!motifEl) {
    motifEl = document.createElement('div');
    motifEl.className = 'shape-panel-motif';
    motifEl.setAttribute('aria-hidden', 'true');
    surface.insertBefore(motifEl, surface.firstChild);
  }
  // Cold-start (family=null) → no canvas at all.
  if (!family) {
    if (_shapeCanvasHandle) { _shapeCanvasHandle.destroy(); _shapeCanvasHandle = null; }
    _shapeCanvasFamily = null;
    return;
  }
  // Motion gate (tasteShapeAnimateBg + reduced-motion). When motion is
  // off, the canvas stays in the DOM but is faded out + cleared via
  // setMotion(false) — visual contract is identical to the legacy
  // destroy/remount path (no frozen frame visible), without paying the
  // teardown cost on every toggle.
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionOk = STATE.tasteShapeAnimateBg !== false && !reduced;
  if (_shapeCanvasHandle) {
    if (_shapeCanvasFamily !== family) {
      _shapeCanvasHandle.setFamily(family);
      _shapeCanvasFamily = family;
    }
    _shapeCanvasHandle.setMotion(motionOk);
  } else if (motionOk) {
    // First mount only happens when motion is on; mounting just to
    // immediately setMotion(false) would be wasted DOM work.
    _shapeCanvasHandle = mountShapeCanvas(motifEl, family, { sizeAnchor: surface });
    _shapeCanvasFamily = family;
  }
  // Re-apply Phase 4 settings (motif opacity var, tempo CSS vars) after
  // each mount/swap so STATE stays in sync.
  applyTasteShapeSettings();
}

// shapeView — single seam for the taste-shape surface. Owns:
//   - The "what radar are we currently rendering?" fingerprint, used
//     for cheap early-outs when storage.onChanged fires for an
//     unchanged radar.
//   - Coordination of renderShape + triggerShapeIntro for the
//     storage.onChanged path (only re-play the intro when there's
//     something actually new to look at).
// Callers stop needing to know whether to call renderShape vs.
// triggerShapeIntro vs. both, and how to compare prev/next radar to
// decide. They hand the module the desired action and get the right
// effect.
const shapeView = (() => {
  let lastFingerprint = null;

  // Stable string capturing every radar field renderShape consumes.
  // Two consecutive renders with the same fingerprint produce
  // identical DOM, so the early-out path skips them entirely.
  // Axis values are rounded to 0.001 to absorb floating-point noise
  // from worker recomputes that produce visually-identical radars.
  function fingerprint(radar) {
    if (!radar) return 'skeleton';
    const axesSig = (radar.axes || [])
      .map(a => `${a.id}:${Math.round((a.value || 0) * 1000)}`)
      .join(',');
    return [
      radar.family || '',
      radar.shapeName || '',
      radar.tagline || '',
      radar.proseSummary || '',
      radar.lineTreatment || '',
      radar.confidenceLevel || '',
      radar.signalSeriesCount ?? '',
      radar._isDevSandbox ? 'sandbox' : '',
      axesSig,
    ].join('|');
  }

  return {
    // Always render — for callers that know the DOM is stale even when
    // the radar fingerprint matches (e.g. surface tab change where the
    // shape view was just unhidden).
    render() {
      lastFingerprint = fingerprint(STATE.radar);
      renderShape();
    },
    // Render if the radar fingerprint changed; no-op otherwise. For
    // storage.onChanged where the worker can write a fresh radar
    // object reference whose contents are identical to the prior one.
    // Returns true when a render happened.
    renderIfChanged() {
      const fp = fingerprint(STATE.radar);
      if (fp === lastFingerprint) return false;
      lastFingerprint = fp;
      renderShape();
      return true;
    },
    // Storage.onChanged path: render + replay the intro animation, but
    // only when the radar actually changed. Skips both for unchanged
    // worker recomputes (most common case — recompute fired for an
    // unrelated reason like signalSeriesCount edge tick).
    renderAndIntroIfChanged() {
      if (this.renderIfChanged()) triggerShapeIntro();
    },
    // Force the next renderIfChanged to run regardless of fingerprint
    // match. Used when the DOM is known-stale (e.g. cold-restart of
    // the panel) and we need to repaint even though STATE.radar
    // didn't change.
    invalidate() {
      lastFingerprint = null;
    },
  };
})();

function renderShape() {
  let radar = STATE.radar;
  const surface = document.querySelector('.surface-shape');
  const nameEl = $('#shape-name');
  const taglineEl = $('#shape-tagline');
  const caveatEl = $('#shape-caveat');
  const familyPillEl = $('#shape-family-pill');
  const proseEl = $('#shape-prose');
  const radarEl = $('#shape-radar');
  const axesEl = $('#shape-axes');
  const coldEl = $('#shape-cold-cta');
  // Cold-start synthesis: when STATE.radar is null (no taste vector yet),
  // build a placeholder radar that satisfies the rest of the render path.
  // The _isSkeleton flag gates downstream renderers (canvas suppressed,
  // axes-empty branch on legend, cold CTA shown, neutral palette). Reads
  // as "this is where your shape will be" without claiming any real
  // archetype's identity. Previously the cold branch was a duplicate
  // early-return at the top of renderShape; collapsing it into a single
  // path removes the drift risk where new features got implemented twice.
  const isSkeleton = !radar;
  if (isSkeleton) {
    radar = {
      _isSkeleton: true,
      family: null,
      familyName: null,
      shapeName: 'Calibrating…',
      tagline: '',
      proseSummary: "We're still building your taste shape. Watch a few shows on Crunchyroll or take the Quick Taste Check, and check back.",
      axes: AXIS_DEFS.map(def => ({
        id: def.id,
        name: def.name,
        value: 0.5,
      })),
      glyph: null,
      lineTreatment: 'solid',
      confidenceLevel: 'skeleton', // distinct from 'cold'/'thin' so caveat skips
      signalSeriesCount: 0,
    };
  }
  if (coldEl) coldEl.hidden = !isSkeleton;
  if (nameEl) nameEl.textContent = radar.shapeName || 'Mixed Taste';
  if (taglineEl) taglineEl.textContent = radar.tagline || '';
  // SANDBOX badge: when the radar is a synthetic dev-sandbox object,
  // replace the kicker text + add a class so the visual treatment
  // makes mode confusion impossible.
  const kickerEl = document.querySelector('.shape-kicker');
  if (kickerEl) {
    if (radar._isDevSandbox) {
      kickerEl.textContent = 'DEV · SANDBOX';
      kickerEl.classList.add('is-dev-sandbox');
    } else {
      kickerEl.textContent = 'Your taste shape';
      kickerEl.classList.remove('is-dev-sandbox');
    }
  }

  // Family palette — drives every themed element (header bg, polygon,
  // bars, headline) via CSS custom props on the shape surface. Cold
  // skeleton gets a neutral grey palette (no claimed archetype hue);
  // real radars get their familyBaseHsl + archetypeHsl tuple.
  if (isSkeleton) shapePalette.applyCold(surface);
  else shapePalette.apply(surface, radar.familyBaseHsl, radar.archetypeHsl);
  // Panel-wide BG motif — wallpaper behind every Shape-surface element.
  // Family-keyed; reads --family-h/s/l set just above. Painted AFTER
  // the CSS custom props so the SVG inherits the right hue.
  paintShapePanelMotif(surface, radar.family);

  // Family pill — small chip below tagline showing the tribe in muted
  // family color. Hidden on Mixed (no real family identity to show).
  if (familyPillEl) {
    if (radar.family && radar.family !== 'mixed' && radar.familyName) {
      familyPillEl.textContent = radar.familyName;
      familyPillEl.hidden = false;
    } else {
      familyPillEl.hidden = true;
    }
  }
  // Caveat pill: 'cold' (no signal) or 'thin' (<30 watched shapes) →
  // explicit "still calibrating" so users don't over-trust the radar.
  // Calibrated = hidden.
  if (caveatEl) {
    const conf = radar.confidenceLevel;
    if (conf === 'thin' || conf === 'cold') {
      caveatEl.hidden = false;
      caveatEl.textContent = conf === 'cold' ? "we don't know your taste yet" : 'still learning';
    } else {
      caveatEl.hidden = true;
    }
  }
  // Low-signal banner + radar dim. Engine's `calibrated` band kicks in
  // at 8 shows but mid-rank archetypes are noisy until ~80 — under
  // that, name the situation visually so the friend doesn't over-trust
  // the radar. Hidden once we've seen enough to be honest, or when
  // the dev sandbox is driving the radar (sandbox state is synthetic).
  const SIGHT_THRESHOLD = 80;
  const lowSignalEl = $('#shape-low-signal');
  const lowSignalMeter = $('#shape-low-signal-meter');
  const seen = radar.signalSeriesCount ?? 0;
  const isLowSignal = !radar._isDevSandbox && seen > 0 && seen < SIGHT_THRESHOLD;
  if (surface) surface.classList.toggle('is-low-signal', isLowSignal);
  if (lowSignalEl) lowSignalEl.hidden = !isLowSignal;
  if (lowSignalMeter) {
    lowSignalMeter.textContent = isLowSignal
      ? `${seen} of ~${SIGHT_THRESHOLD} shows so far`
      : '';
  }
  if (proseEl) proseEl.textContent = radar.proseSummary || '';
  if (radarEl) renderRadarInto(radarEl, radar);
  if (axesEl) {
    // Cold skeleton: clear the legend (matches the pre-collapse cold
    // path which didn't render per-axis bars). The skeleton radar's
    // even octagonal outline is enough visual without listing every
    // axis at a fake 50%.
    if (isSkeleton) {
      axesEl.replaceChildren();
    } else {
      renderAxesDiff(axesEl, radar.axes || []);
      wireShapeSync();
    }
  }
}

// Axis legend — diff-render against existing rows by data-axis-id.
// Each axis gets a (button.axis-row + div.axis-detail) pair; the pair
// is created once and reused across renders so click handlers + the
// user's expanded state survive every storage.onChanged re-render.
// Sort order is driven by appendChild's silent-move semantics: walking
// the desired order and re-appending each pair moves existing nodes
// into place without recreating them. Previously every render rebuilt
// the entire innerHTML, rebound 8 click handlers, and wiped any
// aria-expanded state mid-flight.
function renderAxesDiff(axesEl, rawAxes) {
  const sorted = rawAxes.slice().sort((a, b) => b.value - a.value);
  const TOP_N = 3;
  const WEAK_THRESHOLD = 0.2;

  // Index existing row+detail pairs by axis id.
  const pairs = new Map();
  for (const btn of axesEl.querySelectorAll(':scope > .axis-row')) {
    pairs.set(btn.dataset.axisId, { row: btn, detail: btn.nextElementSibling });
  }

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const id = a.id;
    let pair = pairs.get(id);
    if (!pair) {
      pair = createAxisPair(a);
      pairs.set(id, pair);
    }
    patchAxisPair(pair, a, i, TOP_N, WEAK_THRESHOLD);
    // Append in sorted order. appendChild on an already-attached node
    // is a silent move — keeps existing event handlers + scroll
    // position + aria state intact while the row visually re-ranks.
    axesEl.appendChild(pair.row);
    axesEl.appendChild(pair.detail);
  }

  // Remove pairs that no longer have an axis (defensive — axis count
  // is fixed at 8 in practice, but renders that switch between sandbox
  // synthetic and real radar could legitimately differ).
  const liveIds = new Set(sorted.map(a => a.id));
  for (const [id, pair] of pairs) {
    if (liveIds.has(id)) continue;
    pair.row.remove();
    pair.detail.remove();
  }
}

function createAxisPair(axis) {
  const row = document.createElement('button');
  row.className = 'axis-row';
  row.dataset.axisId = axis.id;
  row.setAttribute('aria-expanded', 'false');
  row.innerHTML = `
    <span class="axis-name">${escapeHtml(axis.name)}</span>
    <span class="axis-bar"><span class="axis-bar-fill"></span></span>
    <span class="axis-value"></span>`;

  const detail = document.createElement('div');
  detail.className = 'axis-detail';
  detail.id = `axis-detail-${axis.id}`;
  detail.hidden = true;

  // Click handler bound ONCE per pair lifetime — survives every diff
  // re-render. Previously this was rebound 8 times per storage.onChanged.
  row.addEventListener('click', () => {
    const expanded = row.getAttribute('aria-expanded') === 'true';
    row.setAttribute('aria-expanded', String(!expanded));
    detail.hidden = expanded;
  });

  return { row, detail };
}

function patchAxisPair(pair, axis, sortIndex, topN, weakThreshold) {
  const { row, detail } = pair;
  // Tier class — recompute every render since rank order can shift as
  // values change. toggle() is idempotent at the class level so no
  // spurious churn when the tier didn't change.
  const v = axis.value || 0;
  const isTop = sortIndex < topN;
  const isWeak = !isTop && v < weakThreshold;
  row.classList.toggle('tier-top', isTop);
  row.classList.toggle('tier-weak', isWeak);

  // Bar fill — updated via CSS custom property so the existing CSS
  // transition on --bar-fill can interpolate between the prev and
  // next value across renders (the old innerHTML approach replaced
  // the whole node so no interpolation was possible).
  const fillPct = Math.max(0, Math.min(100, v * 100));
  const fill = row.querySelector('.axis-bar-fill');
  if (fill) fill.style.setProperty('--bar-fill', `${fillPct.toFixed(1)}%`);

  const valEl = row.querySelector('.axis-value');
  const valText = String(Math.round(v * 100));
  if (valEl && valEl.textContent !== valText) valEl.textContent = valText;

  // Detail content (contributing tags + shows). Rebuild as innerHTML
  // since the inner structure depends on whether there's any signal,
  // and these substrings rarely change across renders for the same
  // axis — and even when they do, they're hidden behind the user
  // clicking the row to expand.
  const tagContribs = (axis.contributingTags || []).slice(0, 6);
  const showContribs = (axis.contributingShows || []).slice(0, 5);
  const tagDetail = tagContribs.length === 0
    ? '<span class="axis-empty">no signal — your watch history doesn\'t touch this axis yet</span>'
    : tagContribs.map(c =>
        `<span class="axis-tag" title="contribution: ${c.contribution}">${escapeHtml(c.tag)}</span>`
      ).join('');
  const showDetail = showContribs.length === 0
    ? ''
    : showContribs.map(s =>
        `<div class="axis-show" title="contribution: ${s.contribution}">${escapeHtml(s.title)}</div>`
      ).join('');
  const showsBlock = showContribs.length === 0 ? '' : `
        <div class="axis-detail-label">shows in your history that fired this axis</div>
        <div class="axis-detail-shows">${showDetail}</div>`;
  detail.innerHTML = `
        <div class="axis-detail-label">strongest tags driving this axis</div>
        <div class="axis-detail-tags">${tagDetail}</div>
        ${showsBlock}`;
}

// Hover/click sync between radar SVG (axis labels + vertex dots)
// and the legend rows below. Both directions keyed off data-axis-id.
// No animation per Q6 confirmation — instant visual jump only, so the
// signal reads as "these two things are the same thing" rather than
// drawing the eye to a moving element.
//
// Idempotent: marks wired elements via data-shape-sync-wired so
// subsequent renders that re-use the same DOM nodes (axes-diff path,
// patched radar SVG) skip re-binding. Only fresh nodes get listeners.
// Previously every renderShape call re-bound 8 row × 2 + 16 SVG nodes
// × 3 = ~64 listeners; with the diff paths in place the DOM is stable
// across renders so we'd accumulate handlers without this guard.
function wireShapeSync() {
  const radarEl = $('#shape-radar');
  const axesEl = $('#shape-axes');
  if (!radarEl || !axesEl) return;
  const setHover = (id, on) => {
    radarEl.querySelectorAll(`[data-axis-id="${id}"]`).forEach(el => {
      el.classList.toggle('is-hovered', on);
    });
    const row = axesEl.querySelector(`.axis-row[data-axis-id="${id}"]`);
    if (row) row.classList.toggle('is-hovered', on);
  };
  // Legend → radar
  for (const row of axesEl.querySelectorAll('.axis-row')) {
    if (row.dataset.shapeSyncWired === '1') continue;
    const id = row.dataset.axisId;
    row.addEventListener('mouseenter', () => setHover(id, true));
    row.addEventListener('mouseleave', () => setHover(id, false));
    row.dataset.shapeSyncWired = '1';
  }
  // Radar → legend (text labels and vertex dots both behave as the
  // axis "handle"). Click on a radar label expands the legend row.
  for (const el of radarEl.querySelectorAll('[data-axis-id]')) {
    if (el.getAttribute('data-shape-sync-wired') === '1') continue;
    const id = el.getAttribute('data-axis-id');
    el.addEventListener('mouseenter', () => setHover(id, true));
    el.addEventListener('mouseleave', () => setHover(id, false));
    el.addEventListener('click', () => {
      const row = axesEl.querySelector(`.axis-row[data-axis-id="${id}"]`);
      if (row) {
        row.click();
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    el.setAttribute('data-shape-sync-wired', '1');
  }
}

// ── Vibe chips ──────────────────────────────────────────
function renderVibeChips() {
  const wrap = $('#vibe-chips');
  const selected = new Set(STATE.vibes[STATE.mode] || []);
  wrap.innerHTML = ALL_VIBE_CHIPS
    .map(word => {
      const sel = selected.has(word) ? ' selected' : '';
      return `<button class="vibe-chip${sel}" data-vibe="${word}">${word}</button>`;
    })
    .join('');
  wrap.querySelectorAll('.vibe-chip').forEach(chip => {
    chip.addEventListener('click', () => toggleVibe(chip.dataset.vibe));
  });
  paintVibeMeta(selected.size, null);
}

function toggleVibe(word) {
  const arr = STATE.vibes[STATE.mode] || [];
  const idx = arr.indexOf(word);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(word);
  STATE.vibes[STATE.mode] = arr;
  persistVibes();
  renderVibeChips();
  render();
}

function clearVibes() {
  STATE.vibes[STATE.mode] = [];
  persistVibes();
  renderVibeChips();
  render();
}

// ── Vibe search bar (2026-05-14) ──────────────────────────
// Search-driven add: typing 'sad' / 'bloody' / 'cute' surfaces a dropdown
// of matching vibes; Enter commits the highlighted row, adding all of its
// constituent vibes to the current lens's selected set. The chip grid
// below is the single source of truth — no separate pills row.

const VIBE_SEARCH = { results: [], highlight: 0, suggestion: null };

function vibeSearchEls() {
  return {
    input: $('#vibe-search-input'),
    dropdown: $('#vibe-search-dropdown'),
  };
}

function updateVibeSearch() {
  const { input, dropdown } = vibeSearchEls();
  if (!input || !dropdown) return;
  const q = input.value;
  if (!q.trim()) {
    closeVibeSearchDropdown();
    return;
  }
  VIBE_SEARCH.results = searchVibeLexicon(q, { maxResults: 8 });
  VIBE_SEARCH.highlight = 0;
  VIBE_SEARCH.suggestion = VIBE_SEARCH.results.length ? null : suggestVibeWord(q);
  renderVibeSearchDropdown(q);
}

function renderVibeSearchDropdown(query) {
  const { dropdown } = vibeSearchEls();
  if (!dropdown) return;
  const selected = new Set(STATE.vibes[STATE.mode] || []);

  if (!VIBE_SEARCH.results.length) {
    const safeQ = escapeHtml(query);
    const sug = VIBE_SEARCH.suggestion;
    const sugHtml = sug
      ? `<div class="vibe-search-empty-suggest">did you mean
           <button type="button" data-suggest="${escapeAttr(sug)}">${escapeHtml(sug)}</button>?
         </div>`
      : '';
    dropdown.innerHTML = `<div class="vibe-search-empty">no matches for "${safeQ}"${sugHtml}</div>`;
    dropdown.hidden = false;
    const sugBtn = dropdown.querySelector('button[data-suggest]');
    if (sugBtn) sugBtn.addEventListener('click', () => {
      const { input } = vibeSearchEls();
      if (input) { input.value = sugBtn.dataset.suggest; updateVibeSearch(); input.focus(); }
    });
    return;
  }

  dropdown.innerHTML = VIBE_SEARCH.results.map((row, i) => {
    const allAdded = row.vibes.every(v => selected.has(v));
    const constituents = row.vibes.map(v => {
      const check = selected.has(v) ? '<span class="selected-check">✓</span> ' : '';
      return `${check}${escapeHtml(v)}`;
    }).join(' + ') + (row.truncated ? ' …' : '');
    const cls = ['vibe-search-row'];
    if (i === VIBE_SEARCH.highlight) cls.push('is-highlighted');
    if (allAdded) cls.push('is-all-added');
    const hint = allAdded ? '<span class="vibe-search-row-hint">all added</span>' : '';
    const sep = row.word === row.vibes[0] && row.vibes.length === 1
      ? '' // word equals the single vibe — no redundant "word · vibe"
      : '<span class="vibe-search-row-sep">·</span>';
    const showWord = !(row.word === row.vibes[0] && row.vibes.length === 1);
    const wordHtml = showWord
      ? `<span class="vibe-search-row-word">${escapeHtml(row.word)}</span>${sep}`
      : '';
    return `<div class="${cls.join(' ')}" data-row="${i}" role="option" aria-selected="${i === VIBE_SEARCH.highlight}">
      ${wordHtml}
      <span class="vibe-search-row-vibes">${constituents}</span>
      ${hint}
    </div>`;
  }).join('');
  dropdown.hidden = false;

  dropdown.querySelectorAll('.vibe-search-row').forEach(el => {
    el.addEventListener('mouseenter', () => {
      VIBE_SEARCH.highlight = Number(el.dataset.row);
      updateHighlight();
    });
    el.addEventListener('mousedown', (e) => {
      // mousedown (not click) so we commit before the input's blur
      // handler fires and closes the dropdown.
      e.preventDefault();
      commitVibeSearchRow(Number(el.dataset.row));
    });
  });
}

function updateHighlight() {
  const { dropdown } = vibeSearchEls();
  if (!dropdown) return;
  dropdown.querySelectorAll('.vibe-search-row').forEach((el, i) => {
    el.classList.toggle('is-highlighted', i === VIBE_SEARCH.highlight);
    el.setAttribute('aria-selected', String(i === VIBE_SEARCH.highlight));
  });
}

function commitVibeSearchRow(idx) {
  const row = VIBE_SEARCH.results[idx];
  if (!row) return;
  const arr = STATE.vibes[STATE.mode] || [];
  const added = [];
  for (const v of row.vibes) {
    if (!arr.includes(v)) { arr.push(v); added.push(v); }
  }
  STATE.vibes[STATE.mode] = arr;
  const { input } = vibeSearchEls();
  if (input) input.value = '';
  closeVibeSearchDropdown();
  persistVibes();
  renderVibeChips();
  render();
  // Pulse the just-selected chips so the user sees the search landed.
  // Pulse all constituents — including already-selected ones — so a
  // partial-add still confirms what the row covered.
  flashChipsForVibes(row.vibes);
  if (input) input.focus();
}

function closeVibeSearchDropdown() {
  const { dropdown } = vibeSearchEls();
  if (!dropdown) return;
  dropdown.hidden = true;
  dropdown.innerHTML = '';
  VIBE_SEARCH.results = [];
  VIBE_SEARCH.highlight = 0;
  VIBE_SEARCH.suggestion = null;
}

function flashChipsForVibes(vibes) {
  if (!vibes || !vibes.length) return;
  const wrap = $('#vibe-chips');
  if (!wrap) return;
  for (const v of vibes) {
    const el = wrap.querySelector(`.vibe-chip[data-vibe="${v}"]`);
    if (!el) continue;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 420);
  }
}

function wireVibeSearch() {
  const { input, dropdown } = vibeSearchEls();
  if (!input || !dropdown) return;
  input.addEventListener('input', updateVibeSearch);
  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden) {
      // Allow Esc to clear the input even when dropdown is closed.
      if (e.key === 'Escape' && input.value) { input.value = ''; e.preventDefault(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (VIBE_SEARCH.results.length) {
        VIBE_SEARCH.highlight = (VIBE_SEARCH.highlight + 1) % VIBE_SEARCH.results.length;
        updateHighlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (VIBE_SEARCH.results.length) {
        VIBE_SEARCH.highlight = (VIBE_SEARCH.highlight - 1 + VIBE_SEARCH.results.length) % VIBE_SEARCH.results.length;
        updateHighlight();
      }
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (VIBE_SEARCH.results.length) {
        e.preventDefault();
        commitVibeSearchRow(VIBE_SEARCH.highlight);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeVibeSearchDropdown();
    }
  });
  input.addEventListener('blur', () => {
    // Delay close so a click on a dropdown row's mousedown handler can
    // run first. The mousedown handler closes the dropdown itself; this
    // is just for click-outside.
    setTimeout(closeVibeSearchDropdown, 120);
  });
}

function escapeAttr(s) { return escapeHtml(s); }

function paintVibeMeta(selectedCount, matchCount) {
  const countEl = $('#vibe-count');
  const clearEl = $('#vibe-clear');
  if (selectedCount === 0) {
    countEl.textContent = 'none';
    countEl.classList.remove('full');
    clearEl.classList.remove('shown');
  } else {
    const m = matchCount == null ? '' : ` · ${matchCount} pick${matchCount === 1 ? '' : 's'}`;
    countEl.textContent = `${selectedCount} vibe${selectedCount === 1 ? '' : 's'}${m}`;
    countEl.classList.add('full');
    clearEl.classList.add('shown');
  }
  paintVibeBreadthHint(selectedCount);
}

// Show a small inline hint under the vibe row when many vibes are
// selected — explains the OR-semantics so users don't expect a tight
// AND filter. Without this, picking 8 atmospheric vibes feels broken
// when "broad shounen also matching one or two" appear near the top.
// The hint disappears at 0-3 vibes (selection is clearly narrow) and
// at 10+ vibes (clear oversaturation, hint becomes obvious noise).
function paintVibeBreadthHint(selectedCount) {
  const barEl = document.getElementById('vibe-bar');
  if (!barEl) return;
  let hint = barEl.querySelector('.vibe-breadth-hint');
  const wantsHint = selectedCount >= 4 && selectedCount <= 9;
  if (!wantsHint) {
    if (hint) hint.remove();
    return;
  }
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'vibe-breadth-hint';
    barEl.appendChild(hint);
  }
  hint.textContent = `Picks fitting more of your ${selectedCount} vibes float to the top. Deselect any vibe you don't actually want to narrow further.`;
}

async function persistVibes() {
  try { await chrome.storage.local.set({ [VIBE_KEY]: STATE.vibes }); }
  catch (_) {}
}

async function load() {
  const stored = await chrome.storage.local.get(
    ['recommendationsScored', MODE_KEY, VIBE_KEY, RATINGS_KEY, SURFACE_KEY, RADAR_KEY,
     'surfaceSettings', '_devAxisSandbox', LENS_VISIBILITY_KEY, VIBE_BAR_COLLAPSED_KEY,
     VIEW_MODE_KEY]);
  STATE.data = stored.recommendationsScored || null;
  STATE.ratings = stored[RATINGS_KEY] || {};
  STATE.realRadar = stored[RADAR_KEY] || null;
  STATE.radar = STATE.realRadar;
  STATE.lensVisibility = stored[LENS_VISIBILITY_KEY] || {};
  STATE.vibeBarCollapsed = stored[VIBE_BAR_COLLAPSED_KEY] === true;
  STATE.viewMode = VALID_VIEW_MODES.has(stored[VIEW_MODE_KEY]) ? stored[VIEW_MODE_KEY] : 'detail';
  applyVibeBarCollapsed();
  applyViewMode();
  // Dev axis-sandbox: read settings + persisted slider state. If the
  // toggle is on, build sandbox section, populate sliders, apply if
  // state exists.
  STATE.devSandbox.toggleOn = stored.surfaceSettings?.devAxisSandbox === true;
  STATE.devSandbox.persistedState = stored._devAxisSandbox || null;
  STATE.devSandbox.lockedPresetName = stored._devAxisSandbox?.lockedPresetName || null;
  // Phase 4: cache the three Taste-shape view tunables on STATE so
  // triggerShapeIntro and renderShape can gate behavior without an
  // async storage round-trip every render.
  STATE.tasteShapeIntroAnim   = stored.surfaceSettings?.tasteShapeIntroAnim !== false;
  STATE.tasteShapeAnimateBg   = stored.surfaceSettings?.tasteShapeAnimateBg !== false;
  STATE.tasteShapeBgOpacity   = stored.surfaceSettings?.tasteShapeBgOpacity ?? 100;
  // 2026-05 migration: tasteShapeIntroAnim (boolean) → tasteShapeAnimTempo
  // (string). If a stored tempo exists, use it. Otherwise derive from the
  // legacy intro-anim toggle: false → 'off', else 'balanced'. The
  // popup's settings UI writes the new key going forward; both keys
  // continue to read so older cached settings still resolve cleanly.
  const storedTempo = stored.surfaceSettings?.tasteShapeAnimTempo;
  STATE.tasteShapeAnimTempo = storedTempo
    || (stored.surfaceSettings?.tasteShapeIntroAnim === false ? 'off' : 'balanced');
  applyTasteShapeSettings();
  // G13-deep: vibes are scoped per lens. Populate slots for all
  // current lenses (legacy peak/comfort + 5 new). Restore stored
  // vibes for any lens that already has them. Orphan keys (a lens
  // removed from LENS_TABS in a later release) are pruned before
  // re-persisting so chrome.storage doesn't accumulate dead state.
  STATE.vibes = {};
  const storedVibes = stored[VIBE_KEY] || {};
  let pruned = false;
  for (const lens of LENS_TABS) {
    const stored_vibes = storedVibes[lens.id];
    STATE.vibes[lens.id] = Array.isArray(stored_vibes) ? stored_vibes : [];
  }
  for (const key of Object.keys(storedVibes)) {
    if (!LENS_TABS.some(l => l.id === key)) pruned = true;
  }
  if (pruned) persistVibes();
  // Always set mode (even on first load) so the body picks up the
  // mode-aware typography class from the start — otherwise peak's
  // sharper styling wouldn't apply until the user clicked the pill.
  // G13-deep: render mode-bar from LENS_TABS first so all pills exist,
  // then setMode resolves and activates the right one.
  renderModeBar();
  // Wire the visibility-edit button (the "⋯" in the bar wrap's corner).
  // Toggles the overlay; idempotent — second click closes it.
  const editBtn = document.getElementById('mode-bar-edit');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      if (document.getElementById('lens-visibility-overlay')) {
        closeLensVisibilityOverlay();
      } else {
        openLensVisibilityOverlay();
      }
    });
  }
  // Vibe-bar collapse toggle — click the header label/caret to fold
  // both the vibe search/chip area AND the status-bar legend rows.
  const vibeToggle = document.getElementById('vibe-bar-toggle');
  if (vibeToggle) {
    vibeToggle.addEventListener('click', toggleVibeBarCollapsed);
  }
  // Apply the loaded collapse state now that the toggle exists so the
  // initial aria-expanded / title attributes are in sync.
  applyVibeBarCollapsed();
  // View-mode toggle (Detail / Casual / Compact). Buttons live in the
  // status-bar; each carries data-view matching its mode. applyViewMode
  // already ran in load(), so the body class is set — this only wires
  // click handlers + ensures the active button reflects current state.
  for (const btn of document.querySelectorAll('.view-mode-btn')) {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
  }
  applyViewMode();
  wireLegendToggle();
  setMode(stored[MODE_KEY] || STATE.mode);
  // G10: surface defaults to last-viewed mode (Q19b). Defaults to
  // 'picks' on first run since that's the high-frequency surface.
  setSurface(stored[SURFACE_KEY] || STATE.surface);
  // Sandbox visibility + initial render. Done after setSurface so the
  // shape view DOM is in its initial state before sandbox layers in.
  applyDevSandboxVisibility();

  // Probe surface (window.__crsmart) — exposes engine-state snapshot for
  // external dev tools to read without going through chrome.storage. Updates
  // every load() cycle so any score/recompute/rating that re-mounts the
  // panel refreshes the snapshot. See crsmart-probe.js.
  if (typeof window !== 'undefined' && window.__crsmart) {
    window.__crsmart.expose('engineHealth', {
      hasData: !!STATE.data,
      scoredCount: STATE.data?.recommendations?.length ?? 0,
      ratingsCount: Object.keys(STATE.ratings || {}).length,
      mode: STATE.mode,
      surface: STATE.surface,
      hasRadar: !!STATE.realRadar,
      topArchetype: STATE.realRadar?.shapeIdentity?.shapeName ?? null,
      ts: new Date().toISOString(),
    });
    // Data-quality issue summary written by background.js
    // computeAllShowsScored. Surfaced as a probe so monitor asserts
    // can fail loudly when structural defects (empty studios, etc.)
    // appear at scoring time, before they manifest as broken cards.
    try {
      const dqRaw = await chrome.storage.local.get('_dataQualityIssues');
      if (dqRaw?._dataQualityIssues) {
        window.__crsmart.expose('dataQualityIssues', dqRaw._dataQualityIssues);
      }
    } catch (_) { /* probe is best-effort */ }
    // Archetype golden-set probe — for each named show, surface its
    // top archetype attribution from showArchetypeFit so monitor
    // asserts can detect regressions like "Mob Psycho's top archetype
    // became magic-academy again" or "AoT's became mecha again." Only
    // populated when allShowsScored is loaded; falls back to {} so
    // asserts can skipOnNull cleanly during cold-start.
    try {
      const ass = await chrome.storage.local.get('allShowsScored');
      const all = ass?.allShowsScored || {};
      const GOLDEN = {
        'GY190DKQR': 'Mob Psycho 100',
        'GG5H5XQX4': 'Frieren',
        'G6NQ5DWZ6': 'My Hero Academia',
        'GR751KNZY': 'Attack on Titan',
        'GMTE00194450': 'Jujutsu Kaisen',
        'GW4HM7W99': 'Grandpa & Grandma Turn Young Again',
        'G5PHNM970': 'Ameku M.D.',
        'GVDHX8504': 'Reborn as a Vending Machine',
        'G24H1NWPJ': 'Psycho-Pass 3',
        'G8DHV7E9Q': 'Inuyashiki',
        'G24H1N5JG': 'Kimi wa Kanata',
      };
      const out = {};
      for (const [id, friendly] of Object.entries(GOLDEN)) {
        const e = all[id];
        if (!e) { out[friendly] = null; continue; }
        const fit = e.showArchetypeFit || {};
        const top = Object.entries(fit).sort((a, b) => b[1] - a[1])[0];
        out[friendly] = top ? { id: top[0], score: +top[1].toFixed(3) } : null;
      }
      window.__crsmart.expose('archetypeGoldenSet', out);
    } catch (_) { /* probe is best-effort */ }
    // Corpus-wide correctness sweep — runs simple per-entry rules
    // across the full allShowsScored map and emits aggregate counts
    // so monitor asserts can catch regressions that wouldn't show up
    // in the named golden-set above. Each rule encodes a class of
    // mistake the 2026-05-12 walk surfaced; the asserts fail if the
    // counts ratchet upward.
    try {
      const ass2 = await chrome.storage.local.get('allShowsScored');
      const all2 = ass2?.allShowsScored || {};
      const ids = Object.keys(all2);
      const counts = {
        sliceOfLifeMecha: 0,        // SoL with mecha as top archetype
        topRankedNoStudio: 0,       // top-100 finalScore with empty studios
        unrelatedMagicAcademy: 0,   // top archetype magic-academy w/o School OR Magic at >=50
      };
      // Compute top-100 by finalScore once
      const ranked = ids.map(id => ({ id, fs: all2[id]?.finalScore ?? 0 })).sort((a, b) => b.fs - a.fs);
      const topIds = new Set(ranked.slice(0, 100).map(r => r.id));
      for (const id of ids) {
        const e = all2[id];
        const fit = e.showArchetypeFit || {};
        const topArch = Object.entries(fit).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const genres = new Set((e.genres || []).map(g => String(g).toLowerCase()));
        if (topArch === 'mecha' && genres.has('slice of life')) counts.sliceOfLifeMecha++;
        if (topIds.has(id) && (!Array.isArray(e.animationStudios) || e.animationStudios.length === 0)) {
          counts.topRankedNoStudio++;
        }
        // realTagRanks isn't stored on the per-show entry, so use the
        // looser proxy: tags + genres list contains 'School' OR 'Magic'.
        if (topArch === 'magic-academy') {
          const names = new Set((e.tags || []).map(t => t?.name).filter(Boolean));
          for (const g of (e.genres || [])) names.add(g);
          const hasSchool = names.has('School') || names.has('School Club');
          const hasMagic = names.has('Magic') || names.has('Witch') || names.has('Sorcery');
          if (!(hasSchool && hasMagic)) counts.unrelatedMagicAcademy++;
        }
      }
      window.__crsmart.expose('corpusCorrectness', {
        entryCount: ids.length,
        counts,
        ts: new Date().toISOString(),
      });
    } catch (_) { /* probe is best-effort */ }
  }
}

// ── Dev axis-sandbox ────────────────────────────────────────────
// Slider-driven preview of arbitrary radar states. Gated behind
// surfaceSettings.devAxisSandbox; persists slider values under
// chrome.storage.local._devAxisSandbox; never writes to tasteShapeRadar
// or triggers a recompute. The synthetic radar runs through the same
// shapeIdentityFor / proseFor / taglineFor pipeline as the real one
// (via radar-derive.js's buildRadarFromAxisValues) — so this is a
// preview of the actual rendering chain, not a parallel mock.

// Full per-archetype presets — generated from SHAPE_NAMES so adding
// a new archetype to radar-derive.js automatically picks it up here.
// Keys are archetype names ("The Character Drama Lover", etc.).
const DEV_SANDBOX_PRESETS = getDevSandboxPresets();

const CONFIDENCE_PRESETS = {
  cold:       { signalSeriesCount: 0,  axisOverride: 'zero' },
  thin:       { signalSeriesCount: 5,  axisOverride: null },
  calibrated: { signalSeriesCount: 30, axisOverride: null },
};

let devSandboxDebounce = null;

function readSandboxFormState() {
  const axisValues = {};
  for (const def of AXIS_DEFS) {
    const slider = document.querySelector(`#dev-sandbox-sliders input[data-axis="${def.id}"]`);
    axisValues[def.id] = slider ? parseFloat(slider.value) : 0;
  }
  const countSlider = document.querySelector('#dev-sandbox-sliders input[data-role="signal-count"]');
  const signalSeriesCount = countSlider ? parseInt(countSlider.value, 10) : 30;
  return { axisValues, signalSeriesCount };
}

function writeSandboxFormState({ axisValues, signalSeriesCount }) {
  for (const def of AXIS_DEFS) {
    const slider = document.querySelector(`#dev-sandbox-sliders input[data-axis="${def.id}"]`);
    if (slider) {
      slider.value = String(axisValues?.[def.id] ?? 0);
      const valEl = slider.parentElement?.querySelector('.dev-sandbox-value');
      if (valEl) valEl.textContent = (parseFloat(slider.value)).toFixed(2);
    }
  }
  const countSlider = document.querySelector('#dev-sandbox-sliders input[data-role="signal-count"]');
  if (countSlider) {
    countSlider.value = String(signalSeriesCount ?? 30);
    const valEl = countSlider.parentElement?.querySelector('.dev-sandbox-value');
    if (valEl) valEl.textContent = countSlider.value;
  }
}

function buildSandboxSliders() {
  const container = document.getElementById('dev-sandbox-sliders');
  if (!container || container.dataset.built === 'true') return;
  const rows = [];
  for (const def of AXIS_DEFS) {
    rows.push(`
      <div class="dev-sandbox-row">
        <span class="dev-sandbox-label">${def.shortName || def.name}</span>
        <input type="range" data-axis="${def.id}" min="0" max="1" step="0.05" value="0">
        <span class="dev-sandbox-value">0.00</span>
      </div>`);
  }
  rows.push(`
    <div class="dev-sandbox-row" style="margin-top:6px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">
      <span class="dev-sandbox-label">Signal series count</span>
      <input type="range" data-role="signal-count" min="0" max="30" step="1" value="30">
      <span class="dev-sandbox-value">30</span>
    </div>`);
  container.innerHTML = rows.join('');
  container.dataset.built = 'true';
  // Slider input → debounced apply.
  for (const input of container.querySelectorAll('input[type="range"]')) {
    input.addEventListener('input', () => {
      const val = input.parentElement?.querySelector('.dev-sandbox-value');
      if (val) val.textContent = input.dataset.role === 'signal-count'
        ? input.value
        : parseFloat(input.value).toFixed(2);
      scheduleSandboxApply();
    });
  }
}

function scheduleSandboxApply() {
  if (devSandboxDebounce) clearTimeout(devSandboxDebounce);
  devSandboxDebounce = setTimeout(() => {
    devSandboxDebounce = null;
    applyDevSandboxFromForm();
  }, 50);
}

function applyDevSandboxFromForm() {
  const formState = readSandboxFormState();
  let synthetic = buildRadarFromAxisValues(formState);
  // If locked to a picked preset, override identity (name + family +
  // palette) with the preset's metadata. Lets the user preview a
  // named archetype's intended visual treatment even when its axis
  // distribution gets shadowed by a higher-priority entry in the
  // matching ladder. Without this, picking "Comedy Fan" rendered
  // as "Action Comedian" because the brute-force preset values
  // happened to match Action Comedian first.
  const locked = STATE.devSandbox.lockedPresetName;
  if (locked && DEV_SANDBOX_PRESETS[locked]) {
    const preset = DEV_SANDBOX_PRESETS[locked];
    synthetic = {
      ...synthetic,
      shapeName: locked,
      family: preset.family,
      familyName: preset.familyName,
      familyBaseHsl: preset.familyBaseHsl,
      archetypeHsl: preset.archetypeHsl,
      isSignature: preset.isSignature,
      glyph: preset.glyph,
      lineTreatment: preset.lineTreatment,
    };
  }
  STATE.radar = synthetic;
  STATE.devSandbox.active = true;
  // Sandbox: force render. Each slider tweak produces a new synthetic
  // radar object, but fingerprint-equality could spuriously skip a
  // re-render when the user dialed a value back to its prior position
  // (where the sub-millisecond float math happens to round identical).
  if (STATE.surface === 'shape') shapeView.render();
  // Persist slider state + lock so they survive panel reloads.
  chrome.storage.local.set({
    _devAxisSandbox: { ...formState, lockedPresetName: locked || null },
  }).catch(() => {});
}

function applyDevSandboxPreset(presetKey) {
  const preset = DEV_SANDBOX_PRESETS[presetKey];
  if (!preset) return;
  // Lock the rendered identity to the picked preset so the visual
  // matches the dropdown selection even if shapeIdentityFor would
  // resolve the axis distribution to a different (higher-priority)
  // archetype. Subsequent slider tweaks keep the lock; pick the
  // empty option or Reset to clear.
  STATE.devSandbox.lockedPresetName = presetKey;
  writeSandboxFormState({ axisValues: preset.axes, signalSeriesCount: preset.signalSeriesCount });
  applyDevSandboxFromForm();
}

function applyConfidencePreset(level) {
  const preset = CONFIDENCE_PRESETS[level];
  if (!preset) return;
  const current = readSandboxFormState();
  const axisValues = preset.axisOverride === 'zero'
    ? Object.fromEntries(AXIS_DEFS.map(d => [d.id, 0]))
    : current.axisValues;
  writeSandboxFormState({ axisValues, signalSeriesCount: preset.signalSeriesCount });
  applyDevSandboxFromForm();
  // Visual selection: highlight the active tier button so the user can
  // see at a glance which confidence preset was last applied. Cleared
  // on resetDevSandbox.
  for (const btn of document.querySelectorAll('.dev-sandbox-confidence-buttons button')) {
    btn.classList.toggle('is-active', btn.dataset.confidence === level);
  }
}

async function resetDevSandbox() {
  await chrome.storage.local.remove('_devAxisSandbox').catch(() => {});
  STATE.devSandbox.active = false;
  STATE.devSandbox.lockedPresetName = null;
  // Also un-select the dropdown so the lock state is visible.
  const presetSelect = document.getElementById('dev-sandbox-preset');
  if (presetSelect) presetSelect.value = '';
  // Clear confidence-tier highlight too — values no longer match a
  // tier preset.
  for (const btn of document.querySelectorAll('.dev-sandbox-confidence-buttons button')) {
    btn.classList.remove('is-active');
  }
  STATE.radar = STATE.realRadar;
  // Re-populate the form from the real radar so sliders show
  // the actual current state (helpful starting point for the
  // next round of tweaks).
  if (STATE.realRadar?.axes) {
    const axisValues = {};
    for (const a of STATE.realRadar.axes) axisValues[a.id] = a.value || 0;
    writeSandboxFormState({ axisValues, signalSeriesCount: 30 });
  }
  if (STATE.surface === 'shape') shapeView.render();
}

function applyDevSandboxVisibility() {
  const section = document.getElementById('dev-sandbox');
  if (!section) return;
  if (!STATE.devSandbox.toggleOn) {
    section.hidden = true;
    if (STATE.devSandbox.active) {
      // Toggle was just turned off mid-session — restore real radar.
      STATE.devSandbox.active = false;
      STATE.radar = STATE.realRadar;
      if (STATE.surface === 'shape') shapeView.render();
    }
    return;
  }
  section.hidden = false;
  buildSandboxSliders();
  populatePresetDropdown(); // ensure dropdown is built before we set its value
  // Restore dropdown selection if a preset was locked at last persist.
  if (STATE.devSandbox.lockedPresetName) {
    const presetSelect = document.getElementById('dev-sandbox-preset');
    if (presetSelect) presetSelect.value = STATE.devSandbox.lockedPresetName;
  }
  // If we have persisted state, apply it; otherwise initialize from
  // the real radar so sliders show current values.
  if (STATE.devSandbox.persistedState) {
    writeSandboxFormState(STATE.devSandbox.persistedState);
    applyDevSandboxFromForm();
  } else if (STATE.realRadar?.axes) {
    const axisValues = {};
    for (const a of STATE.realRadar.axes) axisValues[a.id] = a.value || 0;
    writeSandboxFormState({ axisValues, signalSeriesCount: 30 });
  }
}

function populatePresetDropdown() {
  const presetSelect = document.getElementById('dev-sandbox-preset');
  if (!presetSelect || presetSelect.dataset.populated === 'true') return;
  // Group presets by family so the user can scan within a tribe
  // (e.g., "all the Drama family archetypes"). Iteration order of
  // DEV_SANDBOX_PRESETS preserves SHAPE_NAMES order which is by
  // specificity tier (3-axis sigs first, then 2-axis with low,
  // then 2-axis pure, etc.) — visible as ★ markers on signatures.
  const byFamily = {};
  for (const [name, preset] of Object.entries(DEV_SANDBOX_PRESETS)) {
    if (!byFamily[preset.family]) {
      byFamily[preset.family] = { familyName: preset.familyName, items: [] };
    }
    byFamily[preset.family].items.push({ name, isSignature: preset.isSignature });
  }
  // Family display order — matches the FAMILIES table in
  // radar-derive.js (anchors the visual progression of the dropdown).
  const FAMILY_ORDER = ['drama', 'romance', 'comfort', 'spectacle', 'auteur', 'comedy', 'mystery', 'mixed'];
  let html = '<option value="">— pick archetype —</option>';
  for (const fam of FAMILY_ORDER) {
    const group = byFamily[fam];
    if (!group) continue;
    html += `<optgroup label="${escAttr(group.familyName)}">`;
    for (const item of group.items) {
      const display = item.isSignature ? `${item.name} ★` : item.name;
      html += `<option value="${escAttr(item.name)}">${escHtml(display)}</option>`;
    }
    html += '</optgroup>';
  }
  presetSelect.innerHTML = html;
  presetSelect.dataset.populated = 'true';
}

function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function escHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }

function wireDevSandbox() {
  populatePresetDropdown();
  const presetSelect = document.getElementById('dev-sandbox-preset');
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      if (presetSelect.value) {
        applyDevSandboxPreset(presetSelect.value);
      } else {
        // Empty option picked → unlock; subsequent renders use
        // shapeIdentityFor's actual match.
        STATE.devSandbox.lockedPresetName = null;
        applyDevSandboxFromForm();
      }
    });
  }
  for (const btn of document.querySelectorAll('.dev-sandbox-confidence-buttons button')) {
    btn.addEventListener('click', () => applyConfidencePreset(btn.dataset.confidence));
  }
  const reset = document.getElementById('dev-sandbox-reset');
  if (reset) reset.addEventListener('click', resetDevSandbox);
}

function wire() {
  // G13-deep: mode-pill click handlers are wired by renderModeBar().
  // The querySelector here only catches static pills (now removed)
  // but kept as a defensive handler in case mode-bar fails to render.
  $$('.mode-pill').forEach(p => {
    p.addEventListener('click', () => setMode(p.dataset.mode));
  });
  $$('.surface-tab').forEach(t => {
    t.addEventListener('click', () => setSurface(t.dataset.surface));
  });
  $('#refresh-btn').addEventListener('click', () => load());
  $('#vibe-clear').addEventListener('click', clearVibes);
  wireVibeSearch();
  wireDevSandbox();

  // Topbar-button replay: when the user clicks the CR-page topbar
  // button to open the side panel, background sends a one-shot
  // 'crsmart:replay-shape-intro' message. If the panel is already open
  // and on Shape, replay the intro so the click feels like a fresh
  // open. Ignored on Picks (intro is Shape-specific). Also handles the
  // 'crsmart:panel-close' message: background's topbar toggle asks the
  // panel to close itself when it's already open in that window
  // (chrome.sidePanel has no close API, so the panel calls window.close).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'crsmart:replay-shape-intro' && STATE.surface === 'shape') {
      triggerShapeIntro();
    }
    if (msg?.type === 'crsmart:panel-close') {
      // Best-effort: only close if the message targets THIS window
      // (background includes the windowId). Without the windowId
      // filter, a multi-window user clicking the topbar in window A
      // would close panel B too.
      if (registerPanelPresence.windowId === msg.windowId) {
        window.close();
      }
    }
  });

  registerPanelPresence();

  // Live-update when background recomputes recommendations.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.recommendationsScored) {
      STATE.data = changes.recommendationsScored.newValue || null;
      scheduleRender();
    }
    if (changes[RATINGS_KEY]) {
      STATE.ratings = changes[RATINGS_KEY].newValue || {};
      scheduleRender();
    }
    // Cross-window sync of lens visibility — if another panel window
    // toggles a lens off/on, mirror the change here.
    if (changes[LENS_VISIBILITY_KEY]) {
      STATE.lensVisibility = changes[LENS_VISIBILITY_KEY].newValue || {};
      renderModeBar();
    }
    // Cross-window sync of vibe-bar collapse state — same shape.
    if (changes[VIBE_BAR_COLLAPSED_KEY]) {
      STATE.vibeBarCollapsed = changes[VIBE_BAR_COLLAPSED_KEY].newValue === true;
      applyVibeBarCollapsed();
    }
    // Cross-window sync of view-mode pick.
    if (changes[VIEW_MODE_KEY]) {
      const v = changes[VIEW_MODE_KEY].newValue;
      if (VALID_VIEW_MODES.has(v)) {
        STATE.viewMode = v;
        applyViewMode();
      }
    }
    // G09: live-update the shape view when the worker writes a new
    // radar (taste-vector recompute fires this on history sync,
    // rating change, reaction, survey tap, etc.).
    // Skip when in dev-sandbox mode — the user is actively
    // simulating values; we don't want a real recompute to clobber
    // their tweaks. They can hit Reset to restore.
    if (changes[RADAR_KEY] && !STATE.devSandbox.active) {
      STATE.realRadar = changes[RADAR_KEY].newValue || null;
      STATE.radar = STATE.realRadar;
      if (STATE.surface === 'shape') {
        // Diff-aware: skip the render + intro replay when the new
        // radar's content is identical to what's already painted
        // (worker recomputes can fire for unrelated reasons and
        // produce visually-identical results).
        shapeView.renderAndIntroIfChanged();
      }
    } else if (changes[RADAR_KEY]) {
      // Sandbox active — stash the new real radar so Reset has
      // something fresh to fall back to.
      STATE.realRadar = changes[RADAR_KEY].newValue || null;
    }
    // Live-react to the dev-axis-sandbox toggle so flipping it on or
    // off in the popup updates the side panel without requiring a
    // panel reload. Phase 4 taste-shape tunables apply live the same
    // way: re-cache from surfaceSettings + re-apply class/opacity.
    if (changes.surfaceSettings) {
      const next = changes.surfaceSettings.newValue || {};
      const wasOn = STATE.devSandbox.toggleOn;
      const nowOn = next.devAxisSandbox === true;
      if (wasOn !== nowOn) {
        STATE.devSandbox.toggleOn = nowOn;
        applyDevSandboxVisibility();
      }
      STATE.tasteShapeIntroAnim = next.tasteShapeIntroAnim !== false;
      STATE.tasteShapeAnimateBg = next.tasteShapeAnimateBg !== false;
      STATE.tasteShapeBgOpacity = next.tasteShapeBgOpacity ?? 100;
      const prevTempo = STATE.tasteShapeAnimTempo;
      STATE.tasteShapeAnimTempo = next.tasteShapeAnimTempo
        || (next.tasteShapeIntroAnim === false ? 'off' : 'balanced');
      applyTasteShapeSettings();
      syncMotionToggle();
      // Re-paint the motif so the canvas's motion state matches the new
      // gate. paintShapePanelMotif internally compares family + motion
      // against the last state and no-ops when unchanged, so calling it
      // unconditionally on any settings change is safe + cheap.
      if (STATE.surface === 'shape' && STATE.radar?.family) {
        const surface = document.querySelector('.surface-shape');
        if (surface) paintShapePanelMotif(surface, STATE.radar.family);
      }
    }
  });

  wireVisibilityPause();
  wireMotionToggle();
}

// Open a long-lived port to background and report this panel's window
// id. Background's _panelOpenWindowIds Set tracks the connection; when
// the panel closes, the port auto-disconnects and the Set entry is
// removed, letting the topbar button know it should re-open rather
// than try to close on the next click. Stashes the windowId on the
// function itself so the close-message handler can verify the message
// is for this panel (multi-window safety).
async function registerPanelPresence() {
  try {
    const win = await chrome.windows.getCurrent();
    if (win?.id != null) {
      registerPanelPresence.windowId = win.id;

      // Close if Chrome restored this panel from a previous session rather
      // than the extension explicitly opening it. chrome.storage.session is
      // cleared when Chrome closes, so on the next launch this flag is absent
      // and the panel would show as a blank/gray column. Extension reloads
      // (chrome.runtime.reload) keep the session alive, so the flag persists
      // correctly across those.
      const sessionKey = `crsmart_panel_open_${win.id}`;
      const stored = await chrome.storage.session.get(sessionKey);
      if (!stored[sessionKey]) {
        window.close();
        return;
      }

      const port = chrome.runtime.connect({ name: 'crsmart-side-panel-presence' });
      port.postMessage({ type: 'register', windowId: win.id });
    }
  } catch (err) {
    console.warn('[crsmart] panel presence registration failed', err);
  }
}

wire();
load();

// Cold-start CTA — opens / focuses the survey tab. Same pattern as
// popup.js's survey-open button so the two surfaces converge on a
// single tab if the user opens both.
(function wireColdSurveyLink() {
  const link = document.getElementById('shape-cold-survey-link');
  if (!link) return;
  link.addEventListener('click', async (e) => {
    e.preventDefault();
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
    } catch (_) {
      window.open(url, '_blank');
    }
  });
})();
