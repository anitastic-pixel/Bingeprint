// content-card.js
// ───────────────────────────────────────────────────────────────────
// Smart Score card painter (one of three split content scripts).
// Sibling files: content-feedback.js, content-cr-integration.js.
//
// MVP CONTEXT (2026-05-12): split out of content.js to make tree-
// shaking and diff review easier. NO REWRITE — every function and
// constant is byte-for-byte the same as in the original content.js;
// the outer (() => { ... })(); wrapper was removed so the three
// split files share the isolated-world realm scope. Identifier
// collisions with sibling content scripts (chip-tint, phrase-engine,
// vibe-tags, chip-composer, phrase-map, crsmart-probe, topbar-buttons,
// bridge, inject) were checked — all sibling scripts keep their own
// IIFE wrappers, so their internals stay hidden.
//
// Load order (set by manifest.json content_scripts):
//   content-card.js  →  content-feedback.js  →  content-cr-integration.js
//
// Cross-file references resolve at runtime via the shared realm;
// no top-level code in this file invokes functions defined in the
// other two split files (only function bodies do, which run later
// once everything is loaded).
//
// TO RESTORE the original monolith:
//   1. manifest.json → swap the three split entries for ["...","content.js"]
//      (the verbatim block is preserved in _mvp_deferred for copy-paste).
//   2. Rename content.js.deferred → content.js.
//   3. Delete content-card.js / content-feedback.js / content-cr-integration.js.
// ───────────────────────────────────────────────────────────────────

// Series-page Smart Score card.
//
// Pulls the current page's series title from the hero, looks it up in
// recommendationsScored (peak then comfort), and injects a card into the
// hero body just above CR's meta row. If the series isn't in the user's
// computed recommendations (already watched, or just outside the top
// candidate set), nothing renders — we don't want to badge every page.
//
// Rows (top to bottom):
//   1. Score circle + tier chip + pitch line
//   2. "because you watched X, Y" credit line
//   3. Studio affinity ("Wit Studio · 12 of your favorites · incl. ...")
//   4. Source + key-creator affinity (director, composition)
//   5. Tag chips
//   6. Rate buttons (👎 😐 👍) — persisted, side panel respects 👎
//   7. Why-this-rank breakdown (collapsed)
//
// Respects surfaceSettings.showPagePanel from the popup. When the toggle
// flips, we add/remove without requiring a page reload.

const HERO_BODY = '[data-t="series-hero-body"]';
const TITLE_SEL = '[data-t="series-hero-body"] h1';
const META_WRAPPER_PREFIX = 'series-hero__meta-wrapper';
const CARD_ID = 'crsmart-series-card';

const SETTINGS_KEY = 'surfaceSettings';
const RECS_KEY = 'recommendationsScored';
const STUDIO_INDEX_KEY = 'studioCreatorIndex';
const TAG_BURNOUT_INDEX_KEY = 'tagBurnoutIndex';
const RATINGS_KEY = 'userRatings';
const REACTIONS_KEY = 'userReactions';
const REACTION_STATS_KEY = 'userReactionStats';
// CR's own franchise-level episode/season counts from cms/objects. Kept
// fresh by the worker (see background.js fetchCrSeriesMeta). Used here
// to correct the commitment line when AniList's relation walk is behind
// CR's current state — e.g. JJK S3 "Culling Game Part 1" is airing but
// not yet edged from S2 on AniList, so AniList says 2 seasons when CR
// knows about 3.
const ALL_SHOWS_SCORED_KEY = 'allShowsScored';
const CR_SERIES_META_KEY = 'crSeriesMeta';
// CR's per-series row list ({ id, title, season_number, episode counts,
// ... }). Written by the worker on each series-page visit. Lets the
// card filter out non-TV rows (OVAs, Director's Cuts, Recaps) that
// CR's raw season_count conflates with real seasons.
const CR_SEASONS_CACHE_KEY = 'crSeasonsCache';
// User's archetype blend — sorted list of { id, name, blurb, score, ... }
// from scoreArchetypes(tasteVector). Written by the worker on each taste
// recompute. We only ever consult the top 2 per the stage_1d memo (mid-rank
// archetypes are noisy until the IDF fix lands).
const ARCHETYPE_BLEND_KEY = 'archetypeBlend';
// CR watchlist — { profileId, items[], seriesIdSet }. Written by the
// worker after the history sync. Lets the card render an "on your
// watchlist" chip without re-fetching CR's discover endpoint.
const CR_WATCHLIST_KEY = 'crWatchlist';

// Mirror of franchise.js canonicalizeTitleString — content-script is a
// non-module IIFE so we can't import. Strips season/part markers so
// "My Hero Academia Season 7" → "My Hero Academia" and
// "Attack on Titan Final Season Part 2" → "Attack on Titan" when
// displayed in credits/source text. Pure presentation — underlying
// data (aniListId, cache keys) is untouched.
//
// Season/Part/Cour ONLY strip when followed by a number (digit or
// Roman numeral). The earlier `\b` form falsely stripped "Part-Timer"
// from "The Devil is a Part-Timer" because `\b` matched at the hyphen,
// turning the title into "The Devil is a". Numeric-required form leaves
// hyphenated and bare-suffix titles intact.
const SEASON_SUFFIX_RE =
  /\s+(?:Season\s+(?:\d+|[IVX]+)|Part\s+(?:\d+|[IVX]+)|Cour\s+(?:\d+|[IVX]+)|Final Season|The Movie|Movie|Special|OVA|OVAs)\b.*$/i;
function canonicalizeRawTitle(raw) {
  if (!raw || typeof raw !== 'string') return raw || '';
  const stripped = raw.replace(SEASON_SUFFIX_RE, '').trim();
  return stripped || raw;
}

// ── [moved to content-feedback.js: reactions data + audit IIFE + getReactionSubgroup] ──


const DEFAULT_CARD_MAX_WIDTH = 820;

const STATE = {
  enabled: true,
  coverBleed: false,
  cardMaxWidth: DEFAULT_CARD_MAX_WIDTH,
  // G09 dealbreaker visibility: per north-star Q9b, vetoed shows still
  // render on their own series page but with a visible "you marked X
  // as dealbreaker" pill. Captured from surfaceSettings.dealbreakerTags
  // on settings load + storage-onChange.
  dealbreakerTags: [],
  // Cinematic hero bg: lock + scroll-driven gradient. Defaults ON.
  heroBgLock: true,
  // filter:blur on the gradient div itself, feathering its top edge.
  // 0 = crisp; up to 60 = very soft.
  heroBgBlur: 16,
  // Gradient base height in vh at the top of the page. Grows by 40vh
  // as the user scrolls past the hero.
  heroBgSize: 80,
  // Maximum darkness 0–100 %. Scales all gradient alpha stops so the
  // bottom can be semi-transparent instead of fully black.
  heroBgDark: 100,
  // Mid-stop opacity 0–100 %. Scales the base alpha of the two middle
  // stops independently of the overall darkness.
  heroBgMid: 100,
  // Scale of the key-art image in percent. 100 = natural fill size;
  // higher zooms in (hides edges), lower shows more of the image.
  heroBgScale: 140,
  // Vertical offset in vh. Positive = image shifts down on screen.
  heroBgOffsetY: 0,
  // CR's own ::after overlay gradient (diagonal + left wash + bottom
  // fade). Opacity multiplier 0–100; 100 = original CR strength.
  heroCrOverlay: 100,
  // Start stop (%) of CR's bottom vertical fade — where the black
  // begins fading in. CR's native value is 45.
  heroCrBottomFade: 45,
  // End stop (%) / max darkness of CR's bottom fade, and per-layer
  // opacity for the other two CR gradients (diagonal + left wash).
  heroCrBottomEnd: 82,
  heroCrBottomDark: 100,
  heroCrDiagonal: 100,
  heroCrLeftWash: 100,
  recs: null,
  // Per-show scored objects keyed by CR series ID for every show in
  // aniListCache. Fallback source for shows not in the rec pool —
  // gives "every show gets a card" coverage without needing the show
  // to be in the top-60 rec candidates.
  allShowsScored: null,
  // Sorted archetype blend from scoreArchetypes(tasteVector). Consulted
  // by laneForShow when composing the card's lane line. We only read the
  // top 2 in practice; carrying the full list lets us tune topK without a
  // schema change.
  archetypeBlend: null,
  studioCreator: null,
  // { [crSeriesId]: { episodeCount, seasonCount } } — CR's own totals.
  crSeriesMeta: {},
  // { [crSeriesId]: { fetchedAt, seasons: [...] } } — per-row list from
  // CR's /seasons endpoint, used to compute a filtered TV-season count.
  crSeasonsCache: {},
  // { profileId, items[], seriesIdSet } — CR watchlist (saved-but-not-
  // watched + bookmarks + favorites). seriesIdSet is the O(1) lookup
  // we hit on every card render to decide whether to show the
  // "on your watchlist" chip and to feed the watchlist taste signal.
  crWatchlist: null,
  ratings: {}, // { [aniListId]: '+1' | '0' | '-1' }
  // { [aniListId]: { tags: string[], updatedAt } }. Persisted so
  // feedback transfers across sessions the way ratings do.
  reactions: {},
  // { [chipKey]: { count, lastUsed } }. Lifetime pick-frequency per chip,
  // used to pin habitually-used reasons into the "suggested" row so
  // they're one tap away instead of requiring search or the expander.
  // Incremented only on new selections (not deselections) so a misclick
  // that gets untoggled doesn't permanently bias the surface.
  reactionStats: {},
  // Series titles where the user has opened the reaction-tag palette.
  // Session-scoped — a page load starts collapsed, a re-mount keeps
  // it open (same pattern as descriptionExpanded).
  reactionsExpanded: new Set(),
  // Microcopy flash "got it — we'll factor this in" after first tag of
  // a session. Keyed per-series-title so the confirmation feels tied to
  // *this* reaction, not a global toast.
  reactionsJustSaved: new Set(),
  // Per-show palette UI state — search query. Session-only.
  //   reactionSearch[aniListId] = current query string (or '')
  reactionSearch: {},
  // Per-show, per-group "see all" toggle. Presence of a group id in the
  // Set means "show every chip for this group+polarity, not just dice
  // picks" — lets users browse the full vocabulary without having to
  // guess a search word.
  //   reactionGroupsExpanded[aniListId] = Set<groupId>
  reactionGroupsExpanded: {},
  // Per-show, per-group active subgroup filter. Only consulted when a
  // group is expanded. `null` / missing = "all" (no subgroup filter).
  //   reactionSubgroupFilter[aniListId][groupId] = subgroupId | null
  reactionSubgroupFilter: {},
  // Per-show smart-search dropdown state. Session-only — closes on
  // blur, reopens on next keystroke. Mirrors the VIBE_SEARCH shape in
  // sidepanel.js so the dropdown wiring reads the same way.
  //   reactionSearchDropdown[aniListId] = { results, highlight, suggestion, open }
  reactionSearchDropdown: {},
  // When the user clicks the shuffle button, we sample N random chips
  // from the full polarity pool and pin them into the Suggested row
  // (replacing the context-suggestion slot). Stored so a repaint
  // doesn't re-sample mid-interaction. Polarity flip clears the entry.
  //   reactionShuffledSuggestions[aniListId] = [chipKey, ...]
  reactionShuffledSuggestions: {},
  // The chip palette (search bar + Suggested row + group pills +
  // expanded groups) is now hidden behind a "▸ tell me more" expander
  // — the mood combos are the primary input. Session-only.
  //   reactionAdvancedExpanded = Set<aniListId>
  reactionAdvancedExpanded: new Set(),
  // Memo for the Suggested row's context-suggestion result. Key shape
  // is "<aniListId>:<polarity>"; value is a chipKey[] capped at 8.
  // Deterministic per show+polarity (stable djb2 tie-break), so a
  // single computation can be reused across every render of that
  // show+polarity. Session-only — show data is read-only mid-session
  // and a polarity flip just generates a new key.
  reactionContextCache: {},
  currentSeriesTitle: null,
  // Series title we've already played the ring-fill animation for.
  // CR's hero React-hydrates progressively and wipes our card 2-3
  // times per page load; the MutationObserver re-injects each time
  // and would re-animate without this guard, reading as a flicker.
  animatedFor: null,
  // Series titles where the user has expanded the "What it is"
  // synopsis box. Session-scoped (never persisted) so a page load
  // starts collapsed, but a hero re-mount mid-read keeps the box open.
  descriptionExpanded: new Set(),
  // Per-tag spoiler reveal state for the signed rationale chips. Keyed
  // `${aniListId}:${tagName}`. Session-scoped — a page reload resets,
  // a card re-mount keeps reveals (matches descriptionExpanded). Not
  // persisted to chrome.storage; this is a UI flourish, not a setting.
  spoilersRevealed: new Set(),
  // aniListId of the rating currently waiting for the worker's
  // recompute to settle (~1.4s on the user's data). Set by the rate-
  // button click handler; cleared by the allShowsScored storage
  // listener once the new score lands. Drives the score-pulse +
  // disabled-buttons UX during the wait.
  ratingPending: null,
  // Show a dedicated "Genre" row on the card (broad lane info, neutral
  // styling). When true, signed rationale rows exclude broad genres so
  // chips read as differentiating signal. Mirrored from surfaceSettings.
  genreRow: true,
  // When true, spoiler-tagged chips render as plain chips (no 🔒
  // placeholder, no click-to-reveal). Default false — spoilers stay
  // locked unless the user explicitly opts in via popup setting.
  showSpoilers: false,
};

// ── Lookup ──────────────────────────────────────────────────────────
// CR series URLs look like /series/{id}/{slug}. The id is the key
// used by crSeriesMeta and by CR's own cms/objects endpoint — the
// same identifier the worker syncs franchise totals under.
function currentCrSeriesId() {
  const m = location.pathname.match(/\/series\/([A-Z0-9]+)/i);
  return m ? m[1] : null;
}

// Titles on CR /seasons rows that aren't real TV seasons — OVAs,
// recaps, specials, movies bundled into the series. Narrower than
// "looks non-canonical"; specifically, a row is stripped only when its
// title is explicitly one of these categories. Director's Cuts are
// deliberately NOT stripped here — Re:Zero's "Season 1: Director's
// Cut" is the only S1 row on CR, so stripping it under-counts.
//
// Recap/re-edit family (Remastered, Re-Edited, Compilation) catches
// One-Piece-shaped rows like "Fish-Man Island Saga Remastered &
// Re-Edited" — these duplicate the original arc rows with summary cuts
// and shouldn't inflate TV totals.
const NON_TV_SEASON_RE = /\b(OVA|OVAs|OAD|OADs|Special|Specials|Recap|Recaps|Movie|Film|Short|Shorts|Music|Concert|Pilot|Extras|Remaster|Remastered|Re-?Edit|Re-?Edited|Compilation|Promo|Promotional|Trailer|Trailers|Preview|Previews|Interview|Interviews|Behind the Scenes|Making of)\b/i;

// Positive TV signal — explicit "Season N" / "Cour N" / "Part N"
// anywhere in the title with a word boundary trumps everything else.
// Covers:
//   - "Season 1: Director's Cut" (Re:Zero) — at start
//   - "Dr. STONE Season 3" — after the show name
//   - "Re:Zero Season 2 Part 2" — multiple matches, any one is enough
//   - "Lupin the 3rd Part IV/V/VI" — Roman numeral parts (defensive;
//     these otherwise default-TV via rule 6, but explicit signal helps
//     downstream confidence checks)
// The earlier ^-anchored form missed mid-string matches like Dr. Stone's
// where CR's title format is "<Show> Season N" with no separator.
const TV_SEASON_PREFIX_RE = /(?:^|[\s:\-–—])(?:Season|Cour|Part)(?:\s*\d+|\s+[IVX]+)\b/i;

// Classify a single row. Needs a `batchHasDisplayNumbers` flag so a
// batch where CR never populated display_numbers (Slime: all 6 rows
// have empty display_number) falls back cleanly to title-regex
// classification.
// Priority order (first matching rule wins):
//  1. Negative title signal (OVA / Special / Movie / Recap / Extras /
//     OAD / Pilot / Music / Concert / Short / Film / Remaster /
//     Re-Edit / Compilation / Promo / Trailer / Preview / Interview /
//     Behind the Scenes / Making of) → non-TV. Beats a "Season N"
//     reference anywhere else in the title — an "OVA Season 1" row is
//     still an OVA collection. Recap-family terms catch One-Piece
//     "Saga Remastered & Re-Edited" duplicate rows.
//  2. Positive title signal ("Season N" / "Cour N" / "Part N" anywhere
//     with word boundary) → TV. Catches subtitled rows like
//     "Dr. STONE Season 3" and "Re:Zero Season 1: Director's Cut".
//  3. Non-empty display_number → TV. Explicit CR signal.
//  4. Empty display_number AND the batch has SOME populated values
//     AND episode count ≤ 3 → non-TV. CR's "not-a-real-season" hint
//     combined with episode evidence (Mob Psycho's Reigen-special
//     row: '' display + 1 ep). Without the ep-count guard, real
//     seasons CR didn't bother numbering get wrongly stripped
//     (Dr. Stone S1 has 24 eps + empty display — clearly a season).
//  5. Episode count ≤ 1 + no positive keyword → non-TV. 1-ep rows
//     with no "Season N" marker are almost always unlabeled specials.
//  6. Default → TV. Subtitle-only seasons ("Dr. STONE SCIENCE FUTURE",
//     "Attack on Titan Final Season") have no Season-N keyword but
//     high ep counts; default-TV rescues them.
const LIKELY_SPECIAL_EP_THRESHOLD = 3;
function looksLikeTvSeason(row, batchHasDisplayNumbers) {
  const title = typeof row === 'string' ? row : (row?.title || '');
  const displayNumber = typeof row === 'object'
    ? (row?.season_display_number ?? null) : null;
  const episodeCount = typeof row === 'object'
    ? (row?.number_of_episodes ?? row?.episode_count ?? null) : null;

  if (!title.trim()) return true;
  if (NON_TV_SEASON_RE.test(title)) return false;          // rule 1
  if (TV_SEASON_PREFIX_RE.test(title)) return true;        // rule 2
  if (typeof displayNumber === 'string' && displayNumber.trim()) return true; // rule 3
  if (
    batchHasDisplayNumbers &&
    typeof displayNumber === 'string' && displayNumber === '' &&
    typeof episodeCount === 'number' && episodeCount <= LIKELY_SPECIAL_EP_THRESHOLD
  ) {
    return false;                                          // rule 4
  }
  if (typeof episodeCount === 'number' && episodeCount <= 1) return false; // rule 5
  return true;                                             // rule 6 — default TV
}

function batchHasDisplayNumbers(seasons) {
  if (!Array.isArray(seasons)) return false;
  return seasons.some(s =>
    typeof s?.season_display_number === 'string' && s.season_display_number.trim());
}

// Count rows CR considers TV seasons. Dedupes by season_display_number
// when available so a show that has BOTH an original "Season 1" row
// AND a "Season 1: Director's Cut" row (rare but possible) still counts
// as one season. When display numbers aren't exposed, falls back to
// row count.
function countCrTvSeasons(seasons) {
  if (!Array.isArray(seasons) || !seasons.length) return null;
  const hasDisp = batchHasDisplayNumbers(seasons);
  const tvRows = seasons.filter(s => looksLikeTvSeason(s, hasDisp));
  const displayNums = tvRows
    .map(s => s?.season_display_number)
    .filter(n => n != null && n !== '');
  if (displayNums.length === tvRows.length && displayNums.length > 0) {
    // All rows had a display number — dedupe by it.
    return new Set(displayNums.map(String)).size;
  }
  return tvRows.length;
}

// Sum episode counts across the TV rows. Uses the same filter as
// countCrTvSeasons so the two stay in lockstep.
// Detect Demon-Slayer-style split-cour ambiguity: adjacent TV rows
// whose titles end in "Arc" and whose episode counts are each ≤13
// (typical single-cour length). Returns the count of candidate pairs
// — nonzero means "viewer convention might group these as fewer
// seasons than CR's row count." We don't auto-merge because the
// same shape also appears on legitimately-separate arcs (Demon
// Slayer's Swordsmith Village Arc and Hashira Training Arc both
// match, but they aired 2023 vs 2024 — different seasons), so the
// call belongs to the user. Surfaces as a tooltip on the seasons
// token instead.
function detectArcSplitCourPairs(seasons) {
  if (!Array.isArray(seasons) || seasons.length < 2) return 0;
  const hasDisp = batchHasDisplayNumbers(seasons);
  const tvRows = seasons.filter(s => looksLikeTvSeason(s, hasDisp));
  const ARC_SUFFIX_RE = /\bArc\b\s*$/i;
  let pairs = 0;
  for (let i = 0; i < tvRows.length - 1; i++) {
    const a = tvRows[i];
    const b = tvRows[i + 1];
    if (!ARC_SUFFIX_RE.test(a?.title || '')) continue;
    if (!ARC_SUFFIX_RE.test(b?.title || '')) continue;
    const epsA = a?.number_of_episodes;
    const epsB = b?.number_of_episodes;
    if (typeof epsA !== 'number' || typeof epsB !== 'number') continue;
    if (epsA <= 13 && epsB <= 13) pairs++;
  }
  return pairs;
}

function sumCrTvEps(seasons) {
  if (!Array.isArray(seasons)) return null;
  const hasDisp = batchHasDisplayNumbers(seasons);
  let total = 0;
  let sawCount = false;
  for (const s of seasons) {
    if (!looksLikeTvSeason(s, hasDisp)) continue;
    const n = typeof s?.number_of_episodes === 'number'
      ? s.number_of_episodes
      : (typeof s?.episode_count === 'number' ? s.episode_count : null);
    if (typeof n === 'number') { total += n; sawCount = true; }
  }
  return sawCount ? total : null;
}

// Blend CR's own season/episode data into AniList's franchise rollup.
// Uses CR's filtered /seasons list as the authoritative TV-season count
// when we have it (both raises and lowers AniList's number — CR knows
// when an OVA row got added after airing, and it also knows when
// AniList has over-counted split cours). Falls back to CR's raw
// series_metadata.season_count when /seasons isn't cached yet.
//
// Year range: when CR is ahead of AniList on season count, extend the
// range's end to current year. CR doesn't expose a per-season air year
// via series_metadata, so current year is the best floor — a season CR
// lists must exist by now.
const _crSeasonsLogged = new Set();
function augmentFranchiseWithCr(f, rec) {
  const id = currentCrSeriesId();
  if (!id) return f;
  const crMeta = STATE.crSeriesMeta?.[id] || null;
  const crSeasonsEntry = STATE.crSeasonsCache?.[id] || null;
  const crSeasons = crSeasonsEntry?.seasons;
  // One-shot page-console log per series so we can inspect what CR's
  // /seasons returned vs. how our filter classified each row. Helpful
  // for tuning NON_TV_SEASON_RE against live data without having to
  // tail the extension's service-worker console.
  // _crSeasonsLogged gates the console.log to once-per-series (avoids
  // flooding the console with the /seasons dump on every render).
  // The DOM-attribute write is NOT gated — the diag attribute should
  // reflect the latest rec state so external debug probes see fresh
  // values. Previously this guard caused the diag to freeze at the
  // first mount's snapshot, making cross-render inspection misleading.
  {
    const shouldLogConsole = !_crSeasonsLogged.has(id);
    if (shouldLogConsole) _crSeasonsLogged.add(id);
    const diag = {
      seriesId: id,
      crMeta: crMeta, // { seasonCount, episodeCount } — always logged
      hasSeasonsList: Array.isArray(crSeasons),
      rows: crSeasons ? (() => {
        const hasDisp = batchHasDisplayNumbers(crSeasons);
        return crSeasons.map(s => ({
          title: s?.title,
          season_number: s?.season_number,
          season_display_number: s?.season_display_number,
          number_of_episodes: s?.number_of_episodes ?? s?.episode_count,
          isTv: looksLikeTvSeason(s, hasDisp),
        }));
      })() : null,
      aniListFranchise: f ? {
        totalTvSeasons: f.totalTvSeasons,
        totalTvEps: f.totalTvEps,
        yearRange: f.yearRange,
        movies: f.movies,
        extrasCount: f.extrasCount,
      } : null,
      // Score-debug surface: rec subscores + raw matched-tags so we can
      // explain "why is this score N when I expected M" without reading
      // chrome.storage from the page context. Only emitted once per
      // series-load (same gate as the rest of the diag).
      recDebug: rec ? {
        finalScore: rec.finalScore,
        subScores: rec.subScores,
        tasteScore: rec.tasteScore,
        title: rec.title,
        aniListId: rec.aniListId,
        format: rec.format,
        seasonYear: rec.seasonYear,
        offPool: rec.offPool ?? false,
        topTags: (rec.topTags || []).slice(0, 12),
        topAntiTags: rec.topAntiTags || [],
        archetypeBreakdown: rec.archetypeBreakdown,
        showArchetypeFit: rec.showArchetypeFit,
        averageScore: rec.averageScore,
        meanScore: rec.meanScore,
        userWatchShape: rec.userWatchShape,
        userWatchlist: rec.userWatchlist,
        crCFRank: rec.crCFRank,
        // Description-walker diagnostics — surfaces whether the
        // root-description walker completed for this entry. If
        // `_descriptionFromRoot` is false/missing AND descPrefix
        // still starts with "The Nth season of…", the walker
        // either stopped mid-chain or never ran.
        descSchema: rec._schema,
        descFromRoot: rec._descriptionFromRoot,
        descRootId: rec._descriptionRootId,
        descPrefix: (rec.description || '').slice(0, 100),
      } : null,
    };
    if (shouldLogConsole) console.log('[crsmart] augment diag:', diag);
    // Probe surface (window.__crsmart, see crsmart-probe.js) is the canonical
    // way to ferry engine state out for external dev tools (extension-monitor,
    // chrome-devtools, claude-in-chrome). Fall back to the legacy direct
    // attribute write only if the probe helper hasn't loaded for any reason.
    try {
      if (typeof window !== 'undefined' && window.__crsmart) {
        window.__crsmart.expose('augmentDiag', diag);
      }
      // (Legacy `data-crsmart-diag` fallback removed: it wrote full engine
      // diagnostics to the page-readable DOM unconditionally. The probe path
      // above is privacy-gated; we don't want an ungated fallback.)
    } catch (_) {}
  }

  // Prefer the /seasons filtered count; fall back to raw season_count.
  const crTvSeasons = crSeasons
    ? countCrTvSeasons(crSeasons)
    : (crMeta?.seasonCount ?? null);
  const crTvEps = crSeasons
    ? sumCrTvEps(crSeasons)
    : null;
  const crTotalEps = crMeta?.episodeCount ?? null; // includes OVAs

  if (!crTvSeasons || crTvSeasons < 2) {
    // CR sees a single-season show — whether this matches AniList or
    // not, we defer to AniList's view (movies, cross-linked sequels).
    return f;
  }

  const alSeasons = f?.totalTvSeasons || 0;
  const alEps = f?.totalTvEps || 0;
  const haveFilteredCount = Array.isArray(crSeasons); // /seasons is loaded

  // If AniList's count already matches CR's and eps are in the same
  // ballpark, nothing to override — skip the rebuild.
  if (haveFilteredCount
      ? (alSeasons === crTvSeasons && alEps === (crTvEps ?? alEps))
      : (alSeasons >= crTvSeasons)) {
    return f;
  }

  // When AniList already has a franchise rollup (≥2 TV seasons) and
  // CR's count differs from AL's, decide which side wins:
  //
  // ── AL has MORE seasons than CR ────────────────────────────────────
  // AL is almost always splitting one CR season into multiple entries:
  //   Director's Cut listed as its own TV (Re:Zero S1 D-Cut)
  //   Season 2 Part 1 + Part 2 listed separately (Re:Zero S2)
  //   Cour 1 + Cour 2 listed separately
  // CR's view is the canonical viewer count → trust CR's season count.
  // Eps come from whichever side has more (more complete franchise view) —
  // AL often knows about content CR doesn't license, and vice versa.
  //
  // ── AL and CR have the SAME season count ───────────────────────────
  // Within ep-delta tolerance → trust AL (everything matches).
  // Substantial delta → fall through to override (rare).
  //
  // ── CR has MORE seasons than AL ────────────────────────────────────
  // Eps roughly match → CR's extras are specials AL correctly bucketed
  //   (Mob Psycho Reigen-special as a CR row).
  // CR has substantially more eps → CR knows about a season AL hasn't
  //   indexed yet → fall through to override.
  //   JJK S3: AL 47 vs CR 59 (+12) → trust CR ✓
  //
  // Applies to BOTH CR paths:
  //   - /seasons loaded:  compare crTvEps (filter-sum) to alEps
  //   - crMeta only:       compare crTotalEps (cms/objects) to alEps
  const EP_DELTA_THRESHOLD = 6;
  if (alSeasons >= 2) {
    const effectiveCrEps = haveFilteredCount ? crTvEps : crTotalEps;
    if (effectiveCrEps != null) {
      const epDelta = effectiveCrEps - alEps;

      // AL has more seasons → AL is splitting; collapse to CR's count.
      // Use the larger ep total since either side may know about content
      // the other doesn't (CR may license less; AL may have un-aired splits).
      if (alSeasons > crTvSeasons) {
        return {
          ...f,
          totalTvSeasons: crTvSeasons,
          totalTvEps: Math.max(alEps, effectiveCrEps),
        };
      }

      // Equal seasons within ep-delta tolerance → trust AL.
      if (alSeasons === crTvSeasons && Math.abs(epDelta) < EP_DELTA_THRESHOLD) {
        return f;
      }

      // CR has more seasons + ep-delta NOT substantially higher → CR's
      // extra rows are specials AL correctly handled (Mob Psycho case).
      if (alSeasons < crTvSeasons && epDelta < EP_DELTA_THRESHOLD) {
        return f;
      }

      // Fall through to override path below (CR has real new seasons AL
      // hasn't indexed yet).
    }
  }

  const currentYear = new Date().getFullYear();
  const base = f || {
    canonicalTitle: null,
    totalTvSeasons: 0,
    totalTvEps: 0,
    yearRange: rec?.seasonYear ? [rec.seasonYear] : null,
    movies: null,
    extrasCount: 0,
    studioRuns: [],
    hasStudioChange: false,
  };

  // Year range: extend to current year when CR knows about more
  // seasons than AniList does. The rec.status === 'RELEASING' gate
  // was tied to the rec central's status, which fails for franchises
  // where an old central (S1, FINISHED) has a newly-airing season far
  // out in the chain (Dr. Stone S4 "Science Future" 2026 → AL franchise
  // built off S3 only sees through 2023 → CR knows there's an S4).
  // Drop that gate. The original MHA over-extension concern is now
  // self-mitigated because yearRange spans all formats — if AL has a
  // 2026 entry (any format) the range already includes it without
  // needing CR augmentation. CR extension only fires when AL is
  // genuinely behind on franchise reach.
  const patchedYearRange = (() => {
    const range = base.yearRange;
    if (!range || !haveFilteredCount) return range;
    const start = range[0];
    const existingEnd = range[range.length - 1];
    if (crTvSeasons > alSeasons
        && start && currentYear > start && currentYear > existingEnd) {
      return [start, currentYear];
    }
    return range;
  })();

  // Episode total: prefer /seasons filtered sum when we have it.
  const patchedEps = (() => {
    if (haveFilteredCount && crTvEps != null) return crTvEps;
    if (crTotalEps && crTotalEps > alEps) return crTotalEps;
    return alEps;
  })();

  return {
    ...base,
    totalTvSeasons: crTvSeasons,
    totalTvEps: patchedEps,
    yearRange: patchedYearRange,
  };
}

function pageTitle() {
  const h1 = document.querySelector(TITLE_SEL);
  if (!h1) return null;
  return (h1.textContent || '').trim() || null;
}

function findRec(recs, title) {
  if (!recs || !title) return null;
  const key = norm(title);
  const baseKey = norm(stripSubtitle(title));
  const lists = [];
  if (recs.peak?.ranked) lists.push({ list: recs.peak.ranked, mode: 'peak' });
  if (recs.comfort?.ranked) lists.push({ list: recs.comfort.ranked, mode: 'comfort' });
  for (const { list, mode } of lists) {
    for (const r of list) {
      const t = r.title || {};
      const candidates = [t.english, t.romaji, t.native].filter(Boolean).map(norm);
      if (candidates.includes(key) || candidates.includes(baseKey)) {
        return { rec: r, mode };
      }
    }
  }
  return null;
}

// Fallback to the off-pool scored map when the show isn't in the rec
// pool. Keyed by CR series ID (extracted from the URL) rather than
// title — avoids title-match fuzziness since allShowsScored is
// populated directly from aniListCache which IS keyed by CR ID.
// Returns null if no entry exists yet (worker hasn't enriched this
// show — storage listener will repaint when enrichment lands).
function findRecFromCache(allShowsScored) {
  if (!allShowsScored) return null;
  const id = currentCrSeriesId();
  if (!id) return null;
  const rec = allShowsScored[id];
  if (!rec) return null;
  return { rec, mode: 'off-pool' };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function stripSubtitle(s) {
  return String(s || '')
    .replace(/\s*-[^-]+-\s*$/, '')
    .split(':')[0]
    .trim();
}

// ── Tag filter ──────────────────────────────────────────────────────
// Demographic / structural AniList tags describe *who* a show is for
// rather than what it feels like, so they eat slots in the "Feels like"
// row without telling you anything a friend would say out loud. Filter
// them out before rendering.
const TAG_BLOCKLIST = new Set([
  'male protagonist', 'female protagonist',
  'primarily male cast', 'primarily female cast',
  'primarily adult cast', 'primarily teen cast', 'primarily child cast',
  'ensemble cast', 'anthology', 'episodic',
  'cgi', '2d (cel)', 'rotoscoping', 'cel shading', '3d cg animation',
]);
function isUsefulTag(name) {
  return !TAG_BLOCKLIST.has(String(name || '').toLowerCase().trim());
}

// ── Skip-if heuristic ───────────────────────────────────────────────
// Friend-voice skip-if line. Phase C of the phrase layer. When the
// engine is loaded, delegates to phrase-engine.composeSkipIf which
// pulls from two signal sources:
//   A) Dealbreaker tags (STATE.dealbreakerTags ∩ rec.topTags) —
//      explicit user veto, highest confidence.
//   B) Strong negative anti-tags (rec.topAntiTags below the
//      anti-tag floor) — patterns the user has dropped without
//      explicit veto.
//   E) Franchise-depth (Phase C-future) — defer.
//
// Templates rotate by show-id hash for deterministic-per-show
// selection. Falls back to the legacy SKIP_TAGS dict + hardcoded
// "Skip if X is a dealbreaker." template when the engine isn't
// loaded (extension reload edge case).
const SKIP_TAGS = {
  'ecchi':          'heavy fanservice',
  'fan service':    'heavy fanservice',
  'harem':          'harem dynamics',
  'reverse harem':  'reverse-harem dynamics',
  'gore':           'graphic violence',
  'body horror':    'body horror',
  'isekai':         'isekai setup',
  'reincarnation':  'reincarnation isekai setup',
  'slapstick':      'broad slapstick comedy',
  'parody':         'parody humor',
};
// Median episode count of the user's loved shows (rating ≥ 8). Drives
// the runtime-mismatch skip-if warning so a 12-ep-cours user gets
// warned at 50+ eps while a long-runner fan only gets warned at
// 200+. Returns null when we don't have enough data (< 3 loved shows
// with episode counts) — engine falls back to an absolute threshold.
//
// Computed on-demand. ~600 scored entries × 3 ops per is sub-ms; no
// reason to cache.
function getUserLengthProfile() {
  const ratings = STATE.ratings || {};
  const allShows = STATE.allShowsScored || {};
  const lovedEps = [];
  for (const entry of Object.values(allShows)) {
    const aniListId = entry?.aniListId;
    const eps = entry?.episodes;
    if (!aniListId || !eps || eps < 4) continue;
    const rating = ratings[aniListId];
    if (typeof rating !== 'number' || rating < 8) continue;
    lovedEps.push(eps);
  }
  if (lovedEps.length < 3) return null;
  lovedEps.sort((a, b) => a - b);
  const median = lovedEps[Math.floor(lovedEps.length / 2)];
  return { medianLovedEpisodes: median, sampleSize: lovedEps.length };
}

function skipIfClause(topTags, rec) {
  const engine = window.crsmartPhraseEngine;
  if (engine && engine.composeSkipIf) {
    // Pass the full rec so the engine can read topAntiTags + the
    // user's dealbreakerTags from STATE. userLengthProfile drives
    // the runtime-mismatch warning — falls back to an absolute
    // threshold when we don't have user-length data yet.
    //
    // effectiveEpisodes overrides rec.episodes / franchise.totalTvEps
    // for the runtime warning. AniList's franchise rollup misses
    // currently-airing accumulation (One Piece's franchise object
    // reports totalTvEps≈21 because AL only knows about one entry);
    // augmentFranchiseWithCr combines AL data with CR's per-season
    // metadata to recover the real total (1188 for OP) — that's
    // what the card's commitment line shows, so the skip-if should
    // agree.
    const recForEngine = rec || { topTags };
    const augmented = rec ? augmentFranchiseWithCr(rec.franchise, rec) : null;
    const effectiveEpisodes =
      rec?.episodes || augmented?.totalTvEps || rec?.franchise?.totalTvEps || 0;
    return engine.composeSkipIf(recForEngine, STATE.dealbreakerTags, {
      userLengthProfile: getUserLengthProfile(),
      effectiveEpisodes,
    });
  }
  // Legacy fallback path.
  const hits = [];
  const seen = new Set();
  for (const t of topTags || []) {
    const key = String(t.tag || '').toLowerCase().trim();
    const label = SKIP_TAGS[key];
    if (label && !seen.has(label)) {
      seen.add(label);
      hits.push(label);
      if (hits.length >= 2) break;
    }
  }
  if (!hits.length) return null;
  return hits.length === 2
    ? `Skip if ${hits[0]} or ${hits[1]} is a dealbreaker.`
    : `Skip if ${hits[0]} is a dealbreaker.`;
}

// ── Commitment line ─────────────────────────────────────────────────
// Under the headline — how much of your life this will cost and whether
// it's still airing. Sits in the whitespace that currently reads as
// "the verdict says go, but go where / for how long?".
//
// Franchise-aware: when the rec belongs to a multi-season franchise,
// we roll totals up (seasons, eps, year range) so the commitment you
// see matches what it actually takes to watch the whole thing. Movies
// don't contribute to ep totals (user preference) — shown separately.
// Smart label for the extras bucket: a single shared format collapses
// to its specific name ("+ 2 OVAs"); a mix falls back to the generic
// "+ N extras". Either way the token carries a hover tooltip so the
// user can see the breakdown (and specific titles when we know them).
function extrasTokenHtml(f) {
  const count = f?.extrasCount || 0;
  if (!count) return null;
  const by = f.extrasByFormat || {};
  const formatsPresent = ['OVA', 'SPECIAL', 'ONA'].filter(k => (by[k] || 0) > 0);
  const labelFor = (fmt, n) => {
    if (fmt === 'OVA')     return `${n} OVA${n === 1 ? '' : 's'}`;
    if (fmt === 'SPECIAL') return `${n} special${n === 1 ? '' : 's'}`;
    if (fmt === 'ONA')     return `${n} ONA${n === 1 ? '' : 's'}`;
    return `${n} extras`;
  };
  const label = formatsPresent.length === 1
    ? labelFor(formatsPresent[0], count)
    : `${count} extras`;
  // Tooltip body: breakdown first, then up to 4 titles. Titles get
  // quoted so a mixed run reads ("OVA: Jogo's Origin") rather than
  // colliding into one phrase.
  const breakdownLine = formatsPresent
    .map(k => labelFor(k, by[k]))
    .join(' · ');
  const titleLines = (f.extrasTitles || []).slice(0, 4).map(t => {
    const y = t.year ? ` (${t.year})` : '';
    return `${t.format === 'SPECIAL' ? 'Special' : t.format}: ${t.title}${y}`;
  });
  const moreCount = (f.extrasTitles?.length || 0) - titleLines.length;
  const tipParts = [breakdownLine];
  if (titleLines.length) tipParts.push(titleLines.join('\n'));
  if (moreCount > 0) tipParts.push(`+${moreCount} more`);
  const tip = tipParts.filter(Boolean).join('\n');
  return `<span class="crsmart-extras-token" data-crsmart-tip="${escapeHtml(tip)}">+ ${escapeHtml(label)}</span>`;
}

// Returns HTML (not plain text) so the extras token can carry a
// tooltip affordance. Everything else is escaped and joined with the
// same ` · ` separator the line always used.
function commitmentLine(rec) {
  const parts = [];
  const f = augmentFranchiseWithCr(rec.franchise, rec);
  if (f && (f.totalTvSeasons || 0) > 1) {
    // Split-cour ambiguity: Demon Slayer and similar Arc-named
    // franchises have the shape where CR lists individual arc-seasons
    // but viewer convention groups adjacent short-ep arcs as split
    // cours (Mugen Train Arc + Entertainment District Arc = S2).
    // Can't auto-merge without per-row airing-year data that neither
    // CR nor AniList reliably expose, so surface the ambiguity as a
    // tooltip on the seasons token. User can apply their own mental
    // count without us forcing one interpretation.
    const id = currentCrSeriesId();
    const crSeasons = id ? STATE.crSeasonsCache?.[id]?.seasons : null;
    const splitCourPairs = crSeasons ? detectArcSplitCourPairs(crSeasons) : 0;
    if (splitCourPairs > 0) {
      const tip = `CR lists ${f.totalTvSeasons} individual arcs. Adjacent short-cour arcs (≤13 eps each, ending in "Arc") are sometimes grouped as split-cours — viewer convention may count this franchise as ~${f.totalTvSeasons - splitCourPairs} seasons instead. We show CR's count.`;
      parts.push(`<span class="crsmart-extras-token" data-crsmart-tip="${escapeHtml(tip)}">${escapeHtml(`${f.totalTvSeasons} seasons`)}</span>`);
    } else {
      // Even without split-cour ambiguity, surface a tooltip explaining
      // what the seasons total represents (TV-format only, OVAs/movies
      // counted separately, CR row count after recap/special filtering).
      const seasonsTip = `${f.totalTvSeasons} TV-format seasons in the franchise. Movies and extras (OVAs, Specials, recaps) are counted separately and shown as "+ N movies / + N extras" tokens.`;
      parts.push(`<span class="crsmart-extras-token" data-crsmart-tip="${escapeHtml(seasonsTip)}">${escapeHtml(`${f.totalTvSeasons} seasons`)}</span>`);
    }
    if (f.totalTvEps) {
      // Underlined-on-hover tooltip explains why the eps count is what
      // it is — useful when the number bumps unexpectedly (e.g. a new
      // season landed, or a recap row stopped being filtered out).
      // Names the source (CR /seasons rows, AL franchise totals, or the
      // higher of the two when they disagree per augmentFranchiseWithCr).
      const epsTip = `${f.totalTvEps} TV episodes across ${f.totalTvSeasons} season${f.totalTvSeasons === 1 ? '' : 's'}. ` +
        `Counted from Crunchyroll's per-season episode totals (recaps, "Special Edition" duplicates, and OVAs filtered out) ` +
        `or AniList's franchise rollup, whichever is more complete. Movies and extras counted separately.`;
      parts.push(`<span class="crsmart-extras-token" data-crsmart-tip="${escapeHtml(epsTip)}">${escapeHtml(`${f.totalTvEps} eps`)}</span>`);
    }
    if (rec.status === 'RELEASING') parts.push('airing now');
    else if (rec.status === 'NOT_YET_RELEASED') parts.push('upcoming');
    if (f.yearRange) {
      const yearStr = f.yearRange.length === 2
        ? `${f.yearRange[0]}–${f.yearRange[1]}`
        : String(f.yearRange[0]);
      const yearTip = f.yearRange.length === 2
        ? `Franchise active from ${f.yearRange[0]} to ${f.yearRange[1]} — spans TV, movies, and extras combined. The latest year reflects whatever piece of franchise content released most recently (a movie or special can extend the range past the last TV season).`
        : `${f.yearRange[0]} release year.`;
      parts.push(`<span class="crsmart-extras-token" data-crsmart-tip="${escapeHtml(yearTip)}">${escapeHtml(yearStr)}</span>`);
    }
    if (f.movies?.count) {
      parts.push(escapeHtml(`+ ${f.movies.count} movie${f.movies.count === 1 ? '' : 's'}`));
    }
    const extras = extrasTokenHtml(f);
    if (extras) parts.push(extras);
  } else if (f && (f.totalTvSeasons || 0) === 0 && (f.movies?.count || 0) >= 2) {
    // Movies-only franchise with 2+ members (Heaven's Feel trilogy,
    // Garden of Sinners, Rebuild of Evangelion). The CR series page
    // is the WHOLE multi-film arc, not just one movie — surface the
    // count + year span instead of falling through to "1 ep · YYYY".
    const count = f.movies.count;
    parts.push(`<span class="crsmart-extras-token" data-crsmart-tip="${escapeHtml(`${count} films in this series. CR's series page hosts all installments on the same surface.`)}">${escapeHtml(`${count} movies`)}</span>`);
    const yr = f.movies.yearRange;
    if (Array.isArray(yr) && yr.length === 2) {
      parts.push(escapeHtml(`${yr[0]}–${yr[1]}`));
    } else if (Array.isArray(yr) && yr.length === 1) {
      parts.push(escapeHtml(String(yr[0])));
    }
    if (rec.status === 'RELEASING') parts.push('airing now');
    else if (rec.status === 'NOT_YET_RELEASED') parts.push('upcoming');
    const extras = extrasTokenHtml(f);
    if (extras) parts.push(extras);
  } else {
    if (rec.episodes) parts.push(escapeHtml(`${rec.episodes} ep${rec.episodes === 1 ? '' : 's'}`));
    if (rec.status === 'RELEASING') parts.push('airing now');
    else if (rec.status === 'NOT_YET_RELEASED') parts.push('upcoming');
    // Fall back to startDate.year when seasonYear is null — AL leaves
    // seasonYear unset on some non-seasonal formats (ONAs in particular,
    // e.g. "To Be Hero X") even though startDate.year is populated. The
    // franchise rollup's yearOf() already has this fallback; mirror it
    // here so single-season entries don't drop the year entirely.
    const year = rec.seasonYear || rec.startDate?.year;
    if (year) parts.push(escapeHtml(String(year)));
  }
  return parts.join(' · ');
}

// ── Verdict escalation ──────────────────────────────────────────────
// TRUST ME covers 0.78–1.0, which lumps "strong pick" and "once-a-year
// show" into the same chip. When two+ sub-scores are maxed AND the
// final is very high, we hand the headline a stronger line so the math
// and the prose don't disagree on the pitch.
function isEscalated(rec) {
  const sub = rec.subScores || {};
  const vals = [sub.taste ?? 0, sub.rec ?? 0, sub.qual ?? 0];
  const maxed = vals.filter(v => v >= 0.80).length;
  return (rec.finalScore ?? 0) >= 0.88 && maxed >= 2;
}

// ── Tier chip semantic suffix ───────────────────────────────────────
// The tier alone tells you confidence ("TRUST ME") but not *why*. The
// suffix names the dominant signal so the chip carries both in one read.
function tierSuffixFor(dominant) {
  if (dominant === 'rec')   return 'YOUR CROWD';
  if (dominant === 'taste') return 'YOUR TASTE';
  if (dominant === 'qual')  return 'PEAK QUALITY';
  return null;
}

// G05/G11 audit-trust on the show-page card. When the user has
// rated this show, the calibrated finalScore was clamped (G05)
// — `+1` to a WORTH A SHOT minimum (≥0.75), `-1` to a deep SKIP
// ceiling (≤0.30). The score chip alone doesn't explain that
// clamp; this helper surfaces it so the user sees "score is here
// because I rated it" rather than wondering why the engine seems
// to override its own read. Chip is small enough to sit next to
// the tier chip without crowding.
function ratingOverrideChipFor(rec) {
  const override = rec?.finalScoreOverride;
  if (override !== '+1' && override !== '-1') return '';
  const isPositive = override === '+1';
  const label = isPositive ? '👍 RATED' : '👎 RATED';
  const tip = isPositive
    ? 'You rated this — score floored at WORTH A SHOT minimum.'
    : 'You rated this — score capped in SKIP band.';
  const tone = isPositive
    ? { bg: 'rgba(60,200,120,0.16)', color: '#a5e8be', border: 'rgba(60,200,120,0.42)' }
    : { bg: 'rgba(200,80,80,0.16)', color: '#f0a5a5', border: 'rgba(200,80,80,0.42)' };
  return chip(label, { ...tone, weight: 700, tip });
}

// Audit-trust on the card surface: when the user has marked a tag
// as a dealbreaker AND this show carries that tag/genre, surface
// the veto explicitly. Per north-star Q9b — vetoed shows still
// render on their own series page (we don't pretend they don't
// exist), but we acknowledge the user's stated stance with a
// visible pill instead of letting them wonder why this show is
// silently absent from rec lists.
//
// Returns the chip HTML for the FIRST matching dealbreaker (if any
// tag/genre on this show matches a user dealbreaker). Most shows
// have one matching dealbreaker at most; multi-match cases pick
// the first as the headline veto.
function dealbreakerChipFor(rec) {
  const dealbreakers = STATE.dealbreakerTags;
  if (!Array.isArray(dealbreakers) || dealbreakers.length === 0) return '';
  const dbSet = new Set(dealbreakers);
  // Check tags first (more specific signal), then genres.
  const tags = (rec.topTags || []).map(t => t.tag);
  const genres = rec.genres || [];
  const allTagged = [...tags, ...genres];
  const hit = allTagged.find(name => dbSet.has(name));
  if (!hit) return '';
  return chip(`DEALBREAKER · ${hit}`, {
    bg: 'rgba(200,80,80,0.20)',
    color: '#f0a5a5',
    border: 'rgba(200,80,80,0.55)',
    weight: 700,
    tip: `You marked "${hit}" as a dealbreaker. This show is hidden from rec lists; we're showing you the verdict here because you landed on its page.`,
  });
}

// ── Ring sizing by tier ─────────────────────────────────────────────
// Flat 64px across tiers reads as "same score weight everywhere". Scale
// up for TRUST ME so the visual cue matches the verbal one — the pick
// the user should look at first literally claims more pixels.
//
// SVG viewBox is fixed at 80×80 (REFERENCE_RING_VIEWBOX) and the ring
// circle at r=34 (REFERENCE_RING_R) regardless of tier. The visual
// size comes from the wrapper element's CSS width/height — which CSS
// can transition smoothly between tiers (an SVG attribute width=72→80
// re-renders abruptly; a CSS width transition tweens). Same constants
// drive the dashoffset math so a tier flip doesn't change the ring
// fill calculation.
const REFERENCE_RING_VIEWBOX = 80;
const REFERENCE_RING_R = 34;
const REFERENCE_RING_CIRCUMFERENCE = 2 * Math.PI * REFERENCE_RING_R;
function ringDimsFor(tierName) {
  // Visual hierarchy: TRUST ME largest (the friend wants this loud);
  // WORTH A SHOT slightly smaller but still emphatic (solid pick);
  // STRETCH medium; PROBABLY NOT / SKIP visibly quieter (the friend
  // says no without shouting it).
  if (tierName === 'TRUST ME')     return { size: 80, fontSize: 24, anchorSize: 11 };
  if (tierName === 'WORTH A SHOT') return { size: 76, fontSize: 23, anchorSize: 11 };
  if (tierName === 'STRETCH')      return { size: 72, fontSize: 22, anchorSize: 10 };
  if (tierName === 'PROBABLY NOT') return { size: 66, fontSize: 20, anchorSize: 10 };
  return                                  { size: 64, fontSize: 20, anchorSize: 10 };
}

// ── Affinity lookups (mirror studio-creator-index.js helpers) ───────
const ROLE_BUCKET_PATTERNS = {
  'director':         /\bdirector\b/i,
  'composition':      /\bseries composition\b/i,
  'character-design': /\bcharacter design\b/i,
  'music':            /\bmusic\b/i,
  'original-creator': /\b(original creator|original story|original work)\b/i,
};

// Role-priority filter — reject secondary/sub credits before they
// reach the bucketing step. Without this, "Sub Character Design" on
// Marriagetoxin (Yurika Sako) was promoted past the actual lead
// Character Designer (Kouhei Tokuoka) for the "Designed by" headline,
// because Sako has cross-credits on the user's list and Tokuoka does
// not. Cross-credit affinity should only swap in another person if
// their role is at least as senior as the local lead — and Sub never
// outranks Lead. Same logic for Assistant Director (don't promote
// over Director), 2nd/Action Directors, etc.
const SECONDARY_ROLE_PATTERNS = [
  /\bsub[ -]/i,            // "Sub Character Design", "Sub-Director"
  /\bassistant\b/i,         // "Assistant Director"
  /\b2nd\b/i,               // "2nd Key Animation Director"
  /\bsecondary\b/i,
  /\bsupport(ing)?\b/i,
  /\bin-?between\b/i,       // "In-Between Animation"
];
function isSecondaryRole(role) {
  if (!role) return false;
  return SECONDARY_ROLE_PATTERNS.some(p => p.test(role));
}

function bucketsForRole(role) {
  if (!role) return [];
  // Sub / Assistant / 2nd / Support / In-Between roles are explicitly
  // not eligible to headline a credit row — see comment above.
  if (isSecondaryRole(role)) return [];
  const out = [];
  for (const [b, pat] of Object.entries(ROLE_BUCKET_PATTERNS)) {
    if (pat.test(role)) out.push(b);
  }
  return out;
}

// Studio-lineage canonicalization — must mirror the same map in
// studio-creator-index.js. A divergence here would mean cross-credit
// lookups silently fail to find pooled affinity for one of the
// related studios. Keep the two tables in sync.
const STUDIO_LINEAGE_ALIASES_LOCAL = new Map([
  [7585, 4],   // Bones Film → Bones
  [10, 1],     // Pierrot Films → Pierrot
  [132, 1],    // Pierrot+ → Pierrot
]);
function canonicalStudioId(id) {
  if (id == null) return id;
  return STUDIO_LINEAGE_ALIASES_LOCAL.get(id) ?? id;
}

function studioAffinityFor(animationStudios, studiosIndex) {
  if (!Array.isArray(animationStudios) || animationStudios.length === 0) return null;
  let best = null;
  if (studiosIndex) {
    for (const s of animationStudios) {
      const idx = studiosIndex[canonicalStudioId(s.id)];
      if (!idx) continue;
      if (!best || idx.totalWeight > best.idx.totalWeight) best = { studio: s, idx };
    }
  }
  if (best) {
    return {
      name: best.studio.name,
      familiar: true,
      count: best.idx.count,
      lovedCount: best.idx.lovedCount,
      topSeries: best.idx.contributingSeries.slice(0, 3).map(s => s.title).filter(Boolean),
    };
  }
  return { name: animationStudios[0].name, familiar: false };
}

// Bucket priority — when one person holds multiple credits on the
// same show (Yoshinobu Sena was Director + Original Creator + Script
// on Kimi wa Kanata), pick the most senior bucket as the headline
// and merge sibling roles into the row label. Direction outranks
// adaptation outranks writing outranks aesthetic.
const BUCKET_PRIORITY = ['director', 'original-creator', 'composition', 'character-design', 'music'];

// Within-bucket role tier — used to distinguish primary vs secondary
// credits that fall into the same coarse bucket. The big case today
// is character-design: AniList registers BOTH "Original Character
// Design" (the manga/source designer, 313 shows in the cache) AND
// "Character Design" (the anime adaptation's designer, 585 shows;
// 298 shows have both). The anime designer drives the show's
// on-screen look and should headline "Designed by"; the source
// designer is supporting context. 15 shows have ONLY Original CD
// with no anime CD — we still allow Original to headline there.
//
// Returns 1 (primary) or 2 (secondary). bucketRoleTier defaults to 1
// for buckets without an Original/anime split (director, composition,
// music, original-creator).
function bucketRoleTier(bucket, role) {
  if (bucket !== 'character-design') return 1;
  // Anime-side credits: Character Design, Main Character Design,
  // Animation Character Design (verified against live aniListCache
  // role variants 2026-05-12). Original Character Design is Tier 2.
  // Sub/Assistance/Animal/Supervisor/Credit Removed already filtered
  // by isSecondaryRole upstream.
  if (/Original\s+Character\s+Design/i.test(role || '')) return 2;
  return 1;
}

function creatorAffinitiesFor(keyStaff, creatorsIndex) {
  if (!Array.isArray(keyStaff)) return [];
  // Group by staff.id first so a person with multiple credits on the
  // same show collapses into one entry whose role label spans every
  // qualifying credit. Pre-fix the loop kept the FIRST bucket-matching
  // entry per person and dropped the rest, which silently lost
  // Director credits when an Original Creator entry preceded them in
  // the keyStaff array (auteur films).
  const grouped = new Map(); // id → { name, image, allRoles: [], allBuckets: Set }
  for (const staff of keyStaff) {
    if (staff.id == null) continue;
    const buckets = bucketsForRole(staff.role);
    if (buckets.length === 0) continue;
    let g = grouped.get(staff.id);
    if (!g) {
      g = { id: staff.id, name: staff.name, allRoles: [], allBuckets: new Set() };
      grouped.set(staff.id, g);
    }
    if (staff.role && !g.allRoles.includes(staff.role)) g.allRoles.push(staff.role);
    for (const b of buckets) g.allBuckets.add(b);
  }
  const out = [];
  for (const g of grouped.values()) {
    // Headline bucket = highest-priority match; render label can fold
    // in sibling credits later if needed (kept single-label for now to
    // match existing card layout).
    let primaryBucket = null;
    for (const b of BUCKET_PRIORITY) {
      if (g.allBuckets.has(b)) { primaryBucket = b; break; }
    }
    if (!primaryBucket) continue;
    // Per-bucket tier across this person's roles. Lower (1) wins over
    // higher (2) within the same bucket at dedupe time. Today this only
    // discriminates character-design (anime CD beats Original CD); other
    // buckets always return 1.
    let bestTier = 2;
    for (const role of g.allRoles) {
      const t = bucketRoleTier(primaryBucket, role);
      if (t < bestTier) bestTier = t;
    }
    const idx = creatorsIndex?.[g.id];
    const ix = idx ? idx.byRole[primaryBucket] : null;
    out.push({
      name: g.name,
      role: prettyRole(g.allRoles[0], primaryBucket),
      bucket: primaryBucket,
      roleTier: bestTier,
      // Surface sibling buckets so a future card layout can render
      // "Director · Original Creator" without re-grouping at render time.
      siblingBuckets: [...g.allBuckets].filter(b => b !== primaryBucket),
      familiar: !!ix,
      count: ix?.count ?? 0,
      lovedCount: ix?.lovedCount ?? 0,
      topSeries: (ix?.contributingSeries || []).slice(0, 3).map(s => s.title).filter(Boolean),
    });
  }
  return out;
}

// CR's role strings often have parentheticals ("Director (eps 1-12)") or
// secondary credits joined with commas. Collapse to a clean primary label.
function prettyRole(role, bucket) {
  if (bucket === 'director') return 'Director';
  if (bucket === 'composition') return 'Series Composition';
  if (bucket === 'character-design') return 'Character Design';
  if (bucket === 'music') return 'Music';
  if (bucket === 'original-creator') return 'Original Creator';
  return role || '';
}

// ── Lane classifier (mirror of archetypes.js laneForShow) ──────────
// Content script is a non-module IIFE, so we mirror the primitive
// rather than import it. Keep the gates in sync with archetypes.js —
// if you tune one, tune the other.
//
// Defaults synced 2026-05-04 — the 2026-04-26 archetype expansion
// (8 → 18 bundles) loosened gates in archetypes.js but this mirror
// missed the update, so the on-page card's lane line was going silent
// more often than the rest of the engine. The card matched the side
// panel after the sync.
//
// Two-step: (1) determine the show's own archetype identity from
// showArchetypeFit (un-user-weighted cosine), (2) require that identity
// to be in the user's top-K honest lanes. See archetypes.js for the
// full rationale.
function laneForShow(rec, archetypeBlend, options = {}) {
  const topK = options.topK ?? 3;
  const minUserScore = options.minUserScore ?? 0.01;
  const minFit = options.minFit ?? 0.15;
  const minShare = options.minShare ?? 0.50;
  const minMargin = options.minMargin ?? 0.18;

  if (!rec || !Array.isArray(archetypeBlend)) return null;
  const fit = rec.showArchetypeFit || {};
  const entries = Object.entries(fit);
  if (entries.length === 0) return null;

  let totalFit = 0;
  for (const [, v] of entries) if (v > 0) totalFit += v;
  if (totalFit <= 0) return null;

  entries.sort((a, b) => b[1] - a[1]);
  const [topId, topValue] = entries[0];
  const runnerUp = entries[1]?.[1] ?? 0;
  if (topValue < minFit) return null;
  if (topValue / totalFit < minShare) return null;
  if (topValue - runnerUp < minMargin) return null;

  const userTop = archetypeBlend
    .filter(a => (a?.score ?? 0) >= minUserScore)
    .slice(0, topK);
  const userHit = userTop.find(a => a.id === topId);
  if (!userHit) return null;

  return {
    id: userHit.id,
    name: userHit.name,
    fit: topValue,
    share: topValue / totalFit,
    margin: topValue - runnerUp,
    userRank: userTop.indexOf(userHit) + 1,
  };
}

// ── Pitch line ──────────────────────────────────────────────────────
// Identify which sub-score is carrying this rec, phrase the pitch
// around it, and append the "your shows" credit when we have sources
// AND that credit isn't already the lead (avoids the awkward
// "Loved by viewers of X. Closest to: X." duplication). Reads as the
// engine's one-liner argument for the show — replaces the standalone
// "because you watched" line entirely.
function pitchLineFor(rec, opts = {}) {
  const sub = rec.subScores || {};
  // dominant is computed in dominantSignal(rec); accept it as an opt
  // so the caller (verdictColumnHtml) can share one read across pitch
  // + headline. Fall back to computing internally for any future
  // caller that doesn't have it pre-computed.
  const dominant = opts.dominant ?? dominantSignal(rec);

  const topTag = (rec.topTags || [])[0]?.tag || null;
  const topAntiTag = (rec.topAntiTags || [])[0]?.tag || null;
  const sourceTitles = (rec.sources || [])
    .slice(0, 2)
    .map(s => canonicalizeRawTitle(s.title))
    .filter(Boolean);

  let lead;
  let appendSources = sourceTitles.length > 0;

  // Tier-aware pitch register (north-star Q12 + G01/G02). Low-tier
  // bands need refusal-shaped pitches; the same dominant-axis logic
  // would otherwise produce yes-voice leads on SKIP shows ("Strong
  // taste match…" on a show calibrated to SKIP because its negative
  // tag mass dragged it). Pitch should match the tier's verdict.
  const tier = tierFor(rec.finalScore || 0);
  const tierName = tier.name;

  // Identity fallback for low-score shows that lack a strong anti-tag.
  // Many SKIP/PROBABLY-NOT picks aren't blocked by a single dealbreaker
  // — they just have no positive overlap with the user's vector. Without
  // a frame, the pitch reads abstract ("Nothing in your taste shape
  // says yes"). Pulling the show's first genre gives a domain-shaped
  // refusal: "Romance shows don't usually land for you. Skip."
  // Lower-cased + singular-ish; we trust the genre list to be short and
  // canonical from AniList.
  const _identityGenre = (rec?.genres || []).find(g => typeof g === 'string') || null;
  const _identityFrame = _identityGenre ? _identityGenre.toLowerCase() : null;

  if (tierName === 'SKIP') {
    appendSources = false;
    if (topAntiTag) {
      lead = `${topAntiTag} doesn't land for you. Skip this one.`;
    } else if (_identityFrame) {
      lead = `${_identityFrame.charAt(0).toUpperCase() + _identityFrame.slice(1)} shows don't land for you. Skip.`;
    } else if (dominant === 'qual') {
      lead = `It's well-made, but the shape isn't yours. Skip.`;
    } else if (dominant === 'rec') {
      lead = `Other people love it — you wouldn't.`;
    } else {
      lead = `Nothing in your taste shape says yes. Skip.`;
    }
  } else if (tierName === 'PROBABLY NOT') {
    appendSources = false;
    if (topAntiTag) {
      lead = `${topAntiTag} usually doesn't work for you. Probably skip.`;
    } else if (_identityFrame) {
      lead = `${_identityFrame.charAt(0).toUpperCase() + _identityFrame.slice(1)} shows usually don't connect. Probably skip.`;
    } else if (dominant === 'qual') {
      lead = `Well-made but probably not your kind of show.`;
    } else if (dominant === 'rec') {
      lead = `Buzzy, but I doubt you'd connect.`;
    } else {
      lead = `Lukewarm match — most signals say no.`;
    }
  } else if (dominant === 'rec' && sourceTitles.length) {
    const a = sourceTitles[0];
    const b = sourceTitles[1];
    lead = b ? `Loved by viewers of ${a} and ${b}.` : `Loved by viewers of ${a}.`;
    appendSources = false; // already named
  } else if (dominant === 'taste' && topTag) {
    lead = `Strong taste match — leans into your ${topTag.toLowerCase()} streak.`;
  } else if (dominant === 'qual') {
    const score = rec.averageScore;
    lead = score
      ? `Critical favorite — community average ${score}/100.`
      : `Highly regarded across the board.`;
  } else if (topTag) {
    lead = `Picks up your ${topTag.toLowerCase()} thread.`;
  } else {
    lead = `Worth a look based on your history.`;
  }

  // Lane line — applies the user's top archetype to this show when
  // the lane-classifier gates pass. Rendered as a muted trailing
  // fragment, same visual weight as "Closest to …" so the pitch
  // doesn't turn into a wall. Confidence-gated at the source, so
  // shows that don't honestly live in one of the user's top-2 lanes
  // get no line at all (silence > wrong label).
  const lane = laneForShow(rec, STATE.archetypeBlend);
  let tailParts = [];
  if (appendSources) {
    const a = sourceTitles[0];
    const b = sourceTitles[1];
    const joined = b ? `${a}, ${b}` : a;
    tailParts.push(`Closest to ${escapeHtml(joined)}.`);
  }
  if (lane) {
    tailParts.push(`Lands in your ${escapeHtml(lane.name)} lane.`);
  }
  if (tailParts.length > 0) {
    lead += ` <span style="opacity:0.65;">${tailParts.join(' ')}</span>`;
    return { html: true, content: lead };
  }
  return { html: false, content: lead };
}

// ── Tier ────────────────────────────────────────────────────────────
// 5-band action-threshold tier function per north-star Q5 + the
// philosophy doc's calibration commitment (G01/G02). Thresholds in
// raw [0, 1] space mirror the display 0–10 bands:
//
//   ≥ 0.90  → TRUST ME      (display ≥9.0)  — drop everything tonight
//   ≥ 0.75  → WORTH A SHOT  (display 7.5+)  — solid pick, in your lane
//   ≥ 0.55  → STRETCH       (display 5.5+)  — outside comfort but earned
//   ≥ 0.35  → PROBABLY NOT  (display 3.5+)  — most signals say no
//   else    → SKIP                          — confident this isn't for you
//
// Band populations are guaranteed by the edge-anchored hybrid
// calibration in score-normalizer.js (G01) — top 5% reaches ≥0.9,
// bottom 5% reaches ≤0.35. The friend always has TRUST_ME and SKIP
// shows in their pocket; without calibration, raw distributions
// cluster mid-range and these bands stay empty.
function tierFor(finalScore) {
  if (finalScore >= 0.90) return { name: 'TRUST ME',     bg: COLOR.trust,       color: '#1a0014' };
  if (finalScore >= 0.75) return { name: 'WORTH A SHOT', bg: COLOR.worth,       color: '#0a1a0a' };
  if (finalScore >= 0.55) return { name: 'STRETCH',      bg: COLOR.stretch,     color: '#1a0e00' };
  if (finalScore >= 0.35) return { name: 'PROBABLY NOT', bg: COLOR.probablyNot, color: '#1a1810' };
  return                         { name: 'SKIP',         bg: COLOR.skip,        color: '#1a1010' };
}

// Verdict-line above the pitch — what a friend would actually open with.
// Tier sets the energy; dominant sub-score tunes the angle so the same
// tier doesn't feel copy-pasted across the side panel.
function personalizedHeadline(tier, dominant, escalated = false) {
  if (tier.name === 'TRUST ME') {
    if (escalated) {
      if (dominant === 'rec')  return 'Your people are raving. THE pick.';
      if (dominant === 'qual') return "It's that good — a once-a-year show.";
      return 'All signals green. Skip to it.';
    }
    if (dominant === 'rec')  return 'This is your next favorite.';
    if (dominant === 'qual') return "Trust me, it's that good.";
    return 'Drop everything for this.';
  }
  if (tier.name === 'WORTH A SHOT') {
    // Solid-pick register. Friend says "yes, this works" without
    // the conviction reserved for TRUST ME. Each headline names what
    // earned the pick so the verdict explains itself.
    if (dominant === 'rec')  return "Solid pick — your crowd backs this.";
    if (dominant === 'qual') return "Solid pick — well-made and in your lane.";
    return                          "Solid pick — right in your wheelhouse.";
  }
  if (tier.name === 'STRETCH') {
    if (dominant === 'taste') return 'A bold pick that still fits you.';
    if (dominant === 'rec')   return 'Your crowd is all over this.';
    return                            'A little outside your lane.';
  }
  if (tier.name === 'PROBABLY NOT') {
    // Honest skepticism. "Probably not your thing" without ruling
    // it out — leaves room for the user to disagree and watch anyway.
    if (dominant === 'qual') return 'Well-made, but probably not your thing.';
    if (dominant === 'rec')  return "Buzzy, but I doubt you'd connect.";
    return                          'Most signals say no on this one.';
  }
  // SKIP — clear refusal. Friend says no with a reason; doesn't
  // hedge or apologize for the verdict.
  if (dominant === 'qual') return "It's well-made, but really not for you.";
  if (dominant === 'rec')  return "Other people love it — you wouldn't.";
  return                          "Skip — this isn't for you.";
}

// Cheap dominant-signal probe — same logic as pitchLineFor but without
// also building the prose. Used by the headline so headline + pitch
// pull from the same source-of-truth.
function dominantSignal(rec) {
  const sub = rec.subScores || {};
  return [
    ['taste', sub.taste ?? 0],
    ['rec',   sub.rec   ?? 0],
    ['qual',  sub.qual  ?? 0],
  ].sort((a, b) => b[1] - a[1])[0][0];
}

// ── HTML helpers ────────────────────────────────────────────────────
const chip = (text, opts = {}) => {
  const tipAttr = opts.tip ? ` data-crsmart-tip="${escapeHtml(opts.tip)}"` : '';
  return `
  <span class="crsmart-chip" style="
    display:inline-flex;align-items:center;
    background:${opts.bg || 'rgba(255,255,255,0.08)'};
    color:${opts.color || '#fff'};
    border:1px solid ${opts.border || 'rgba(255,255,255,0.14)'};
    padding:4px 10px;border-radius:999px;
    font-size:12px;line-height:1;white-space:nowrap;
    ${opts.weight ? `font-weight:${opts.weight};letter-spacing:0.4px;` : ''}
    ${opts.tip ? 'cursor:help;' : ''}
  "${tipAttr}>${escapeHtml(text)}</span>`;
};

// Quality axes → conditional chips next to the tier chip. Only fires
// on extremes so the card stays uncluttered for middle-of-the-road
// picks. Tooltip carries the actual axis values so the friend-voice
// label has numeric backing if the user wants to verify.
//
// Thresholds are starting points, tunable after real-card feedback:
//   craftPrior     ≥ 0.80 → PEAK PEDIGREE (green chip, positive signal)
//   adaptationRisk ≥ 0.70 → RUSHED SHAPE  (amber chip, warning)
//   craftPrior     ≤ 0.58 AND consensusQuality < 0.65 → MID CRAFT (subtle)
//
// Not surfacing the anti-craft variant (mid-craft) loudly by default —
// discourages investigation but most shows hit that band and the card
// would feel negative. Might enable later based on a popup setting.
// Chip thresholds — broken out so they're tunable as we see the chips
// fire across the much-larger-than-before show population Tiers 1+2
// opened up. Initial 0.80 / 0.70 were calibrated against the rec pool's
// taste-weighted subset; expect to tighten or loosen once data from
// off-pool + popular-seed shows comes in.
const PEAK_PEDIGREE_THRESHOLD = 0.80;
const RUSHED_SHAPE_THRESHOLD = 0.70;

const QUALITY_CHIP_TONES = {
  peakPedigree: {
    bg: 'rgba(60,200,120,0.18)',
    color: '#a5e8be',
    border: 'rgba(60,200,120,0.45)',
  },
  rushedShape: {
    bg: 'rgba(255,170,60,0.18)',
    color: '#ffcf91',
    border: 'rgba(255,170,60,0.45)',
  },
  // Muted grey for the off-pool marker — not a warning, just a
  // confidence-qualifier. Shouldn't compete visually with tier or
  // quality chips.
  offPool: {
    bg: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.55)',
    border: 'rgba(255,255,255,0.18)',
  },
  // Affinity-orange for the rewatched marker. Reads as "this is a
  // verified favorite" — same color family as the hero rail and the
  // score ring's stretch arc, so the chip visually says "you and this
  // show have history." Slightly stronger border than offPool so it
  // pops next to a muted COLD READ.
  rewatched: {
    bg: 'rgba(255,140,40,0.18)',
    color: '#ffb677',
    border: 'rgba(255,140,40,0.50)',
  },
  // Soft blue-purple for the watchlist marker. Distinct from the
  // affinity-orange family so "user already saved this" doesn't get
  // confused with "user has history with this." Reads as a quiet
  // bookmark cue rather than a strong verdict.
  watchlist: {
    bg: 'rgba(140,160,255,0.16)',
    color: '#b9c5ff',
    border: 'rgba(140,160,255,0.45)',
  },
  // Stronger lavender for explicit favorites (CR's "★ Favorite" flag).
  // User has marked this with the heart, which is a stronger commitment
  // than "saved to watchlist." Distinct from rewatched so the two can
  // co-occur on the same card without one swallowing the other.
  favorite: {
    bg: 'rgba(200,130,255,0.18)',
    color: '#dab6ff',
    border: 'rgba(200,130,255,0.50)',
  },
  // Cool teal for CR's collaborative-filtering pick — distinct from
  // both the user-history (orange) and watchlist (blue-purple)
  // families so the user can read it as "CR's audience signal" rather
  // than "your behavior signal."
  crPick: {
    bg: 'rgba(60,200,200,0.16)',
    color: '#9adcd9',
    border: 'rgba(60,200,200,0.45)',
  },
  // Muted yellow for the audience-disagreement chip — flags shows
  // where CR (Western fans) and AL (broader audience) materially
  // diverge. Doesn't enter the score (we deliberately keep CR
  // ratings out of qual to avoid Western-bias contamination), just
  // surfaces the divergence so the user can read it themselves.
  audienceSplit: {
    bg: 'rgba(255,210,90,0.16)',
    color: '#ffe09a',
    border: 'rgba(255,210,90,0.45)',
  },
  // Soft red for low-confidence picks — "engine is guessing more than
  // usual." Reads as a caveat, not a warning. Pairs with the muted
  // off-pool palette but with a warmer tone so it doesn't get lost.
  lowConfidence: {
    bg: 'rgba(220,140,120,0.14)',
    color: '#e6a896',
    border: 'rgba(220,140,120,0.40)',
  },
};

function qualityChipsFor(rec) {
  const ax = rec?.qualityAxes;
  const chips = [];
  // Off-pool marker: this show isn't in the rec candidate pool so
  // we scored it against taste + quality only, no community-rec
  // signal. Muted chip + tooltip so the user understands the
  // confidence is narrower than an in-pool rec.
  if (rec?.offPool) {
    chips.push(chip('EARLY GUESS', {
      ...QUALITY_CHIP_TONES.offPool,
      weight: 500,
      tip: 'Scored on your taste + this show\'s quality only — no community-recommendation signal yet (this show isn\'t in your top rec pool). The tier is honest but a notch less confident than your ranked picks.',
    }));
  }
  // Rewatched marker: surfaces user-watch behavior the score doesn't
  // see directly. Without this badge, a user who rewatches MHA five
  // times still sees a 7.0 with no indication that the engine knows
  // about the rewatching. The badge makes the "you keep coming back
  // to this" signal legible, and the tooltip names the boost so the
  // math row's tasteN matches the user's expectation.
  const ws = rec?.userWatchShape;
  if (ws?.isRewatched) {
    const boostPct = ws.boostApplied
      ? ` (+${Math.round(ws.boostApplied * 100)}/100 to taste)`
      : '';
    const epsLine = ws.rewatchedCount
      ? ` Detected ${ws.rewatchedCount} episode${ws.rewatchedCount === 1 ? '' : 's'} you went back to in a recent rewatch peak.`
      : '';
    // Cross-audio rewatch (sub→dub or dub→sub) is a stronger commitment
    // than same-track replay — the user actively chose to re-experience
    // the show in a different language. Distinguish in the chip label
    // and tooltip so the boost is legible.
    const isCross = ws.crossAudioRewatch === true;
    const isVerified = ws.verifiedFavorite === true;
    // Label hierarchy: verified favorite > cross-audio > plain rewatch.
    // Verified favorite is the "you've watched essentially everything
    // AND rewatched it" trifecta — pulls confirmed top-tier picks above
    // tag-fit prediction. Tooltip surfaces the threshold so the user
    // knows what triggered it.
    let label;
    if (isVerified && isCross) label = '★ YOUR FAVORITE · SUB↔DUB';
    else if (isVerified) label = '★ YOUR FAVORITE';
    else if (isCross) label = 'REWATCHED · SUB↔DUB';
    else label = 'REWATCHED';
    const verifiedLine = isVerified
      ? ' Verified favorite — you watched ≥90% AND came back, so the engine treats this as a top-tier personal pick (+20/100 on top of the rewatch boost).'
      : '';
    const crossLine = isCross
      ? ' Cross-audio rewatch detected (sub↔dub) — extra +5/100 above the standard rewatch boost.'
      : '';
    chips.push(chip(label, {
      ...QUALITY_CHIP_TONES.rewatched,
      weight: 600,
      tip: `You've rewatched this — that's a costly explicit "I love this" signal so the engine boosts its taste match${boostPct} above generic same-tag matches in your library.${epsLine}${verifiedLine}${crossLine}`,
    }));
  }
  // Watchlist marker: surfaces explicit save-for-later intent. Looked
  // up at render time from STATE.crWatchlist so the lookup table stays
  // in one place and the rec doesn't need a per-card watchlist clone.
  // Renders alongside REWATCHED when both apply — saved-and-rewatched
  // is a distinct (very-engaged) shape worth showing in full.
  const crSeriesId = currentCrSeriesId();
  const wlEntry = crSeriesId
    ? (STATE.crWatchlist?.items || []).find(it => it.seriesId === crSeriesId)
    : null;
  if (wlEntry?.isFavorite) {
    chips.push(chip('★ FAVORITE', {
      ...QUALITY_CHIP_TONES.favorite,
      weight: 600,
      tip: 'You marked this as a favorite on Crunchyroll — an explicit "this one matters to me" signal stronger than just adding to the watchlist.',
    }));
  } else if (wlEntry) {
    chips.push(chip('ON WATCHLIST', {
      ...QUALITY_CHIP_TONES.watchlist,
      weight: 500,
      tip: 'You\'ve saved this to your Crunchyroll watchlist — explicit "I want to watch this" intent. The engine treats it as a positive taste signal.',
    }));
  }
  // CR collaborative-filtering signal — surfaces only when CR ranks
  // this show high enough on the user's personal recommendations
  // (top quartile of the returned list, ~rank ≤ 25 of 100). Below
  // that threshold the signal is too noisy to merit a chip; the
  // crCF sub-score still feeds finalScore quietly. Different signal
  // class from our taste vector — CR sees co-watching patterns we
  // can't, so when the two engines agree on a show it's a higher-
  // confidence pick.
  if (typeof rec?.crCFRank === 'number' && rec.crCFRank <= 25) {
    chips.push(chip(`CR PICKS · #${rec.crCFRank}`, {
      ...QUALITY_CHIP_TONES.crPick,
      weight: 500,
      tip: `Crunchyroll's own personalized engine ranks this #${rec.crCFRank} for you — a collaborative-filtering signal computed from co-watching patterns across their entire user base. When CR and your taste vector both pick a show, that's a higher-confidence match than either alone.`,
    }));
  }
  // Audience-disagreement chip — fires when CR's audience and AL's
  // community materially diverge in their average rating. Threshold
  // |delta| ≥ 15 on the 100-pt scale — anything smaller is noise.
  // Doesn't enter the score; surfaces so the user can interpret the
  // gap themselves. Earlier label "WESTERN FAVORITE" overgeneralized
  // CR users — they're not synonymous with all Western anime fans.
  // "CR FAVORITE" is honest about which platform's cohort spoke up.
  //
  // Sample-size guard (added 2026-05-12 after Marriagetoxin walk):
  // currently-airing shows can show wild deltas based on early-adopter
  // bias before either community's average stabilizes. Require enough
  // popularity AND that the show is no longer mid-air, OR a much
  // higher delta on currently-airing-but-popular shows. AL popularity
  // is the count of users with the show on a list — a defensible
  // proxy for "the average is grounded in many votes."
  const _audAirRel = rec?.status === 'RELEASING';
  const _audPop = typeof rec?.popularity === 'number' ? rec.popularity : 0;
  const _audDeltaAbs = typeof rec?.audienceDelta === 'number' ? Math.abs(rec.audienceDelta) : 0;
  const _audPasses = _audDeltaAbs >= 15
    && (_audAirRel ? (_audPop >= 50000 && _audDeltaAbs >= 20) : (_audPop >= 5000 || !rec?.popularity));
  if (typeof rec?.audienceDelta === 'number' && _audPasses) {
    const crAhead = rec.audienceDelta > 0;
    const label = crAhead ? 'CR FAVORITE' : 'CRITICS’ PICK';
    const tip = crAhead
      ? `Crunchyroll audience rated this ~${rec.crAverageScore}/100 vs AniList community ~${rec.averageScore}/100. CR's user base liked this more than the broader anime audience — useful to know if you trust one cohort's read more than the other.`
      : `AniList community rated this ~${rec.averageScore}/100 vs Crunchyroll audience ~${rec.crAverageScore}/100. The broader / more-critical AL audience liked this more than CR users — often a "critics' favorite" / niche-resonance pattern.`;
    chips.push(chip(label, {
      ...QUALITY_CHIP_TONES.audienceSplit,
      weight: 500,
      tip,
    }));
  }
  // Confidence chip — fires only on the LOW end. Most picks are at
  // medium-or-better confidence; a chip there would be visual noise.
  // Below 0.55 = thin data (sparse tags, no user history, no CR CF,
  // no community ratings). Reads "the score is honest but the data
  // backing it is shallow — could swing more than usual."
  if (typeof rec?.confidence === 'number' && rec.confidence < 0.55) {
    const pct = Math.round(rec.confidence * 100);
    chips.push(chip('LOW CONFIDENCE', {
      ...QUALITY_CHIP_TONES.lowConfidence,
      weight: 500,
      tip: `Score-confidence ${pct}/100. Thinner data: limited tag coverage, no watch history, or sparse cross-source ratings. The score is the engine's best guess — could land ±0.5 from where shown if more data lands.`,
    }));
  }
  if (!ax) return chips;
  if (typeof ax.craftPrior === 'number' && ax.craftPrior >= PEAK_PEDIGREE_THRESHOLD) {
    const pct = Math.round(ax.craftPrior * 100);
    chips.push(chip('PEAK PEDIGREE', {
      ...QUALITY_CHIP_TONES.peakPedigree,
      weight: 600,
      tip: `Director + studio track record in the top quartile of your watched corpus. Craft prior: ${pct}/100.`,
    }));
  }
  // Adaptation-risk suppression via franchise context: Mob Psycho is a
  // manga with 12-ep seasons, which makes the per-season heuristic fire
  // "rushed shape" even though the franchise has 3 full seasons of
  // content. The heuristic is correct for one-and-done 12-ep cours
  // (Promised Neverland S2, Case Study of Vanitas) but wrong for
  // multi-season franchises where 12-ep cours are the intentional
  // cadence. Rule: suppress RUSHED SHAPE when the franchise has ≥2 TV
  // seasons OR total TV eps ≥24 (one cour + change of continuing
  // content is enough evidence the adaptation wasn't rushed).
  if (typeof ax.adaptationRisk === 'number' && ax.adaptationRisk >= RUSHED_SHAPE_THRESHOLD) {
    const f = rec.franchise;
    const multiSeason = (f?.totalTvSeasons || 0) >= 2;
    const longForm = (f?.totalTvEps || 0) >= 24;
    if (!multiSeason && !longForm) {
      const pct = Math.round(ax.adaptationRisk * 100);
      chips.push(chip('ENDS IN A HURRY', {
        ...QUALITY_CHIP_TONES.rushedShape,
        weight: 600,
        tip: `Common rushed-adaptation shape — manga/LN source with a short ep count and no confirmed sequel. Pacing tends to crumple here. Risk: ${pct}/100.`,
      }));
    }
  }
  return chips;
}

const muted = txt => `<span style="font-size:12px;opacity:0.55;">${escapeHtml(txt)}</span>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── Extension-context-invalidated detection ─────────────────────────
// When the user reloads the extension at chrome://extensions, the
// page's existing content.js stays bound to the now-defunct extension
// context. Any chrome.* call from a click handler throws "Extension
// context invalidated." Same thing happens when the extension auto-
// updates from the Chrome Web Store.
//
// The error is silent (just a console message), so the user just sees
// "I clicked, nothing happened" with no clue why. This helper detects
// the invalidated state and surfaces a non-blocking "extension
// updated — refresh this tab" banner the user can act on.
//
// `chrome.runtime?.id` is undefined in the invalidated state — the
// cheapest probe.
function isExtensionContextInvalidated() {
  try {
    return !chrome?.runtime?.id;
  } catch (_) {
    // Some Chrome versions throw on access when invalidated.
    return true;
  }
}

let _contextInvalidatedBannerShown = false;
function showContextInvalidatedBanner() {
  if (_contextInvalidatedBannerShown) return;
  _contextInvalidatedBannerShown = true;
  const banner = document.createElement('div');
  banner.id = 'crsmart-context-invalidated';
  banner.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 99999;
    background: rgba(40, 20, 10, 0.96);
    color: #fff;
    border: 1px solid rgba(255, 140, 40, 0.55);
    border-radius: 10px;
    padding: 12px 16px;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.4;
    max-width: 320px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.40);
    backdrop-filter: blur(12px) saturate(1.2);
  `;
  banner.innerHTML = `
    <div style="font-weight:700;color:${COLOR.affinity};margin-bottom:4px;">
      Smart Scoring updated
    </div>
    <div style="opacity:0.85;margin-bottom:8px;">
      Refresh this tab to keep rating shows.
    </div>
    <div style="display:flex;gap:8px;">
      <button id="crsmart-ctx-reload" style="
        background:${COLOR.affinity};color:#1a0e00;
        border:none;border-radius:6px;
        padding:6px 12px;font-size:12px;font-weight:600;
        cursor:pointer;
      ">Refresh</button>
      <button id="crsmart-ctx-dismiss" style="
        background:transparent;color:rgba(255,255,255,0.55);
        border:1px solid rgba(255,255,255,0.18);border-radius:6px;
        padding:6px 12px;font-size:12px;
        cursor:pointer;
      ">Dismiss</button>
    </div>
  `;
  document.body.appendChild(banner);
  banner.querySelector('#crsmart-ctx-reload')?.addEventListener('click', () => {
    location.reload();
  });
  banner.querySelector('#crsmart-ctx-dismiss')?.addEventListener('click', () => {
    banner.remove();
  });
}

// AniList descriptions ship with <br>, <i>, source credits ("(Source: ...)")
// wiki throat-clearing, and dramatic-pause ellipses. Returns both a
// 40-word preview and the full cleaned synopsis so the What-it-is box
// can show a teaser by default and expand to the full text on click.
// Short "N-film series, YYYY–YYYY" line shown above the synopsis when
// the franchise is purely movies (no TV anchor) and has 2+ members.
// AL ships the franchise-root entry's description, which on multi-
// film series like Heaven's Feel covers only the first installment.
// Returns null when the trilogy treatment doesn't apply.
function trilogyHeaderText(franchise) {
  if (!franchise) return null;
  if ((franchise.totalTvSeasons || 0) > 0) return null;
  const count = franchise.movies?.count || 0;
  if (count < 2) return null;
  const WORDS = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
  const numWord = count < WORDS.length && WORDS[count] ? WORDS[count] : String(count);
  const yr = franchise.movies?.yearRange;
  let yearTail = '';
  if (Array.isArray(yr) && yr.length === 2) yearTail = `, ${yr[0]}–${yr[1]}`;
  else if (Array.isArray(yr) && yr.length === 1) yearTail = `, ${yr[0]}`;
  return `${numWord}-film series${yearTail}. The synopsis below covers the first installment.`;
}

function plainDescription(html) {
  if (!html) return null;
  const full = cleanDescriptionHtml(html);
  if (!full) return null;
  const MAX_WORDS = 40;
  const short = shortenToWordBudget(full, MAX_WORDS);
  return { full, short, truncated: short !== full };
}

function cleanDescriptionHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\(Source:[^)]*\)/gi, '')
    .replace(/\[Written by[^\]]*\]/gi, '')
    .replace(/\(Note:[^)]*\)/gi, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    // Collapse ASCII triple-dots to a single ellipsis char so the
    // sentence splitter below doesn't treat mid-sentence dramatic
    // pauses ("…as a slime monster!") as a full stop.
    .replace(/\.{3,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

// Trim a cleaned description to a whole-sentence budget. Takes full
// sentences until we'd overflow; if the first sentence alone is too
// long, trims at the last comma inside the budget so the line ends
// on a natural pause instead of a mid-clause cut.
function shortenToWordBudget(s, MAX_WORDS) {
  const wc = str => str.split(/\s+/).filter(Boolean).length;
  // Trailing [' " ) ] ”] captures any closing quote/paren that sits
  // after the terminal punctuation so we don't orphan it onto the
  // next sentence ("...the right death." not "...the right death. ").
  const sentences = (s.match(/[^.!?]+[.!?]+["'\)\]”’]*/g) || [s])
    .map(x => x.trim())
    .filter(Boolean);

  let picked = '';
  let used = 0;
  for (const sent of sentences) {
    const w = wc(sent);
    if (!picked) {
      if (w <= MAX_WORDS) { picked = sent; used = w; }
      else               { picked = trimToWordBudget(sent, MAX_WORDS); break; }
    } else if (used + w <= MAX_WORDS) {
      picked = `${picked} ${sent}`;
      used += w;
    } else {
      break;
    }
  }
  return picked || s;
}

// Word-budget trim that prefers the last comma in the truncated slice
// so we end on a natural pause ("...in a fantasy realm") rather than a
// mid-clause cut ("...he awakens to a"). Comma fallback only kicks in
// when it's reasonably far in (past 55% of the trimmed length) so we
// don't lop off most of the sentence to chase a tidy break.
function trimToWordBudget(str, wordBudget) {
  const words = str.split(/\s+/);
  if (words.length <= wordBudget) return str;
  let trimmed = words.slice(0, wordBudget).join(' ');
  const lastComma = trimmed.lastIndexOf(',');
  if (lastComma > trimmed.length * 0.55) {
    trimmed = trimmed.slice(0, lastComma);
  }
  return trimmed.replace(/[,;:.!?…]+\s*$/, '') + '…';
}

// ── Color tokens ────────────────────────────────────────────────────
// Reserve orange exclusively for affinity ("loved" counts) and the
// score ring. Other taxonomies get their own hue so the eye can
// distinguish kinds-of-fact at a glance. This is also the system the
// rest of the card builds out from — tier chip uses these as bg, the
// "hero" affinity row leans on the orange accent, etc.
const COLOR = {
  affinity: '#ff8c28',  // orange — loved counts, score ring
  medium:   '#6aa9ff',  // blue — adapted medium (Manga, LN, Original)
  studio:   '#7ddc8d',  // green — animation studio
  // Per-role creator colors. Each role gets its own pill color so the
  // affinity block reads like a categorized credit list rather than a
  // wall of neutral chips. Saturation kept comparable to studio/medium
  // so no single role visually dominates. Hex picks were tuned for
  // legibility on the dark card panel — saturated enough to be
  // distinguishable, not so much that 5 of them on one card overwhelm.
  director:        '#b78bff',  // lavender — Director
  composition:     '#5dd4c8',  // teal — Series Composition / writer
  characterDesign: '#ff8fbf',  // pink — Character Design
  music:           '#ffd56b',  // gold — Music / composer
  originalCreator: '#e5a070',  // warm sand — Original Creator (distinct
                               // from affinity orange so the OC chip
                               // doesn't read as a loved-count badge)
  trust:        '#b450ff',  // purple — TRUST ME tier
  worth:        '#4caf50',  // green — WORTH A SHOT tier (solid pick, in lane)
  safe:         '#4caf50',  // alias for `worth` — preserved for back-compat
                            //   with any straggler refs in feedback/render code
  stretch:      '#ff8c28',  // orange — STRETCH tier (matches affinity)
  probablyNot:  '#a09a8a',  // muted warm gray — PROBABLY NOT tier (skeptical
                            //   but not loud; reads as "lukewarm")
  skip:         '#a64d4d',  // muted brick red — SKIP tier (confident no, but
                            //   not aggressive; the friend says no without
                            //   shouting it)
};

// Map creator buckets to their pill color. Keep aligned with
// ROLE_LABEL_BY_BUCKET below — when a new bucket lands, add both
// entries together so the row keeps its label-color pairing.
const COLOR_BY_BUCKET = {
  'director':         COLOR.director,
  'composition':      COLOR.composition,
  'character-design': COLOR.characterDesign,
  'music':            COLOR.music,
  'original-creator': COLOR.originalCreator,
};

// ── Pill primitives ─────────────────────────────────────────────────
// Every named entity in the affinity block renders as a pill so the
// row reads as a row of "things" rather than a sentence. Two variants:
//   - 'name' (default): rounded rectangle, regular weight, mixed case.
//     Used for studio names, creator names.
//   - 'tag': compact uppercase chip with letter-spacing. Used for
//     categorical labels like the Manga / Light Novel medium chip.
// Color is optional — when omitted the pill uses neutral white-tinted
// styling, which suits creators (no shared category color) while still
// making the name stand out against the row's prose.
function pill(text, color, opts = {}) {
  const variant = opts.variant || 'name';
  const rgb = color ? hexToRgb(color) : null;
  const bg = rgb ? `rgba(${rgb},0.16)` : 'rgba(255,255,255,0.05)';
  const border = rgb ? `rgba(${rgb},0.45)` : 'rgba(255,255,255,0.18)';
  const fg = color || 'rgba(255,255,255,0.92)';
  const isTag = variant === 'tag';
  const fontSize = isTag ? '10.5px' : '12.5px';
  const weight = isTag ? '700' : '600';
  const transform = isTag ? 'text-transform:uppercase;letter-spacing:0.7px;' : '';
  return `<span style="
    display:inline-flex;align-items:center;
    background:${bg};border:1px solid ${border};color:${fg};
    padding:3px 9px;border-radius:6px;
    font-size:${fontSize};line-height:1.2;font-weight:${weight};
    ${transform}
    white-space:nowrap;
  ">${escapeHtml(text)}</span>`;
}

// Loved-count is the load-bearing affinity stat. Friend-voice copy:
// "5 you've loved" reads as something a person would actually say,
// where "♥ 5" reads as a database column. Slightly smaller font than
// before to absorb the longer phrase without dominating the row.
// When the entity is in your history but nothing reached the loved
// bar, fall back to a quieter "you've seen N" chip so the row still
// discloses familiarity without overclaiming affection.
function lovedBadge(lovedCount, count) {
  if (lovedCount > 0) {
    const rgb = hexToRgb(COLOR.affinity);
    return `<span style="
      display:inline-flex;align-items:center;
      color:${COLOR.affinity};font-size:11.5px;font-weight:700;
      background:rgba(${rgb},0.10);
      border:1px solid rgba(${rgb},0.32);
      padding:2px 9px;border-radius:999px;line-height:1.2;
      white-space:nowrap;
    ">${lovedCount} you've loved</span>`;
  }
  if (count > 0) {
    return `<span style="
      display:inline-flex;align-items:center;
      opacity:0.55;font-size:11px;
      padding:2px 8px;border-radius:999px;
      border:1px solid rgba(255,255,255,0.12);
      line-height:1.2;white-space:nowrap;
    ">you've seen ${count}</span>`;
  }
  return '';
}

// ── Affinity-row builder ────────────────────────────────────────────
// Conversational single-line row. Reads left-to-right as a sentence:
//   `Made by [MAPPA] · 5 you've loved via Attack on Titan Final`
//   `Written by [Hiroshi Seko] · 8 you've loved via DAN DA DAN`
//   `Adapted from manga by [Gege Akutami] · 2 you've loved from prior seasons`
//   `Designed by [Tadashi Hiramatsu] · new to you`
//
// The pill color does the categorical work (green = studio, blue =
// medium, neutral = creator) so we don't need a left-gutter label
// column. The lead phrase ("Made by", "Written by", "Adapted from
// manga by") carries role meaning in plain English; hovering it
// reveals the full role definition for casual-fan users.
//
// `hero: true` adds an orange left-bar accent so the strongest familiar
// row in the block pops without needing a header.
function affinityRow({
  lead, leadHover,
  name, nameColor,
  prefixChip, prefixChipColor,
  midText,
  seasonTag,
  lovedCount = 0, count = 0, topSeries = [],
  noveltyText,
  hover,
  dim = false, hero = false,
  subRow = false,
}) {
  // Lead phrase — small low-contrast prose, hover-explained role.
  const leadAttr = leadHover ? ` data-crsmart-tip="${escapeHtml(leadHover)}"` : '';
  const leadCursor = leadHover ? 'text-decoration:underline dotted rgba(255,255,255,0.20);text-underline-offset:3px;' : '';
  const leadHtml = lead
    ? `<span${leadAttr} style="opacity:0.55;font-size:12.5px;${leadCursor}">${escapeHtml(lead)}</span>`
    : '';

  // Name + optional prefix chip. Most rows just show one name pill;
  // source-only rows put the medium in the name slot (carries the row).
  const chipParts = [];
  if (prefixChip) chipParts.push(pill(prefixChip, prefixChipColor, { variant: 'tag' }));
  // midText sits as a muted connector between the medium pill and the
  // author name ("[Light Novel] by [Fuse]"). Wider gap than the pill-to-
  // pill 4px spacer so the word has room to breathe.
  if (midText) chipParts.push(`<span style="opacity:0.55;font-size:12.5px;padding:0 4px;">${escapeHtml(midText)}</span>`);
  if (name) chipParts.push(pill(name, nameColor, { variant: 'name' }));
  // Optional season-range tag (franchise studio-run rows only). Sits
  // right after the name pill as a muted "· S1–S3" parenthetical so it
  // reads as scope ("this studio made *these* seasons") without
  // competing visually with the studio name itself.
  if (seasonTag) {
    chipParts.push(`<span style="font-size:11.5px;opacity:0.55;margin-left:2px;">· ${escapeHtml(seasonTag)}</span>`);
  }
  const chipHtml = chipParts.join('<span style="display:inline-block;width:4px;"></span>');

  // Proof — contributing title or quiet novelty note. The familiarity
  // count ("10 you've loved") used to render as an inline orange pill
  // here, but it crowded the row when titles were long and duplicated
  // the hero rail's signal. The chip's hover tooltip carries the same
  // "N in your history, M loved · incl. ..." breakdown now (via the
  // affinityHover-built `hover` attr below), so the inline pill is gone
  // — the row reads as cleaner prose and long titles get more room.
  const dot = `<span style="opacity:0.35;margin:0 2px;">·</span>`;
  const hasFamiliarSignal = lovedCount > 0 || count > 0;
  let proofHtml = '';
  if (hasFamiliarSignal && topSeries.length) {
    // Truncate the via-title to a hard character cap so a long title
    // (e.g. "The Irregular at Magic High School: Visitor Arc",
    // "The Devil is a Part-Timer") can't push the row to wrap or
    // ellipsize mid-word with no visual cue that there's more. Append
    // an explicit "…" when truncated and surface the full title via
    // tooltip (data-crsmart-tip + native title=) so hover reveals
    // exactly what got compressed.
    const fullTitle = canonicalizeRawTitle(topSeries[0]);
    const VIA_MAX_CHARS = 28;
    const truncated = fullTitle.length > VIA_MAX_CHARS
      ? fullTitle.slice(0, VIA_MAX_CHARS - 1).trimEnd() + '…'
      : fullTitle;
    const titleAttr = fullTitle.length > VIA_MAX_CHARS
      ? ` data-crsmart-tip="${escapeHtml(fullTitle)}" title="${escapeHtml(fullTitle)}"`
      : '';
    proofHtml = `
      ${dot}
      <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;flex:0 1 auto;overflow:hidden;">
        <span style="opacity:0.5;font-size:12px;white-space:nowrap;flex:0 0 auto;">via</span>
        <span${titleAttr} style="font-size:12.5px;opacity:0.78;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;${fullTitle.length > VIA_MAX_CHARS ? 'border-bottom:1px dotted rgba(255,255,255,0.20);cursor:help;' : ''}">${escapeHtml(truncated)}</span>
      </span>
    `;
  } else if (noveltyText) {
    proofHtml = `
      ${dot}
      <span style="font-size:12px;opacity:0.5;font-style:italic;">${escapeHtml(noveltyText)}</span>
    `;
  }

  // Hero accent — pulled left into the panel padding so the orange
  // bar lines up with the panel's natural edge while the row content
  // visually anchors at the same X as non-hero rows.
  // Hero accent OR studio-continuation indent. Hero wins when both are
  // set — a heroed continuation row gets the orange bar and ignores the
  // muted continuation rule. Continuation rows (subRow + no lead) get
  // both a faint left rail (visual continuation cue) AND a left indent
  // that pushes the chip to line up with the first row's chip column
  // (past the "Made by " label). Reads as a clearly-subordinated
  // sub-row instead of an independent row that just happens to be
  // missing its prefix.
  let containerStyle = '';
  if (hero && subRow) {
    // Hero on a sub-row (e.g. MAPPA more-familiar than chrono-first
    // WIT) keeps the chip-column indent so all studio chips line up,
    // plus swaps the muted rail for the orange affinity rail so the
    // strong-signal credit still pops.
    containerStyle = `border-left:3px solid ${COLOR.affinity};padding-left:55px;margin-left:-2px;`;
  } else if (hero) {
    containerStyle = `border-left:3px solid ${COLOR.affinity};padding-left:11px;margin-left:-14px;`;
  } else if (subRow) {
    // 58px ≈ pixel width of "Made by " in the 12.5px lead font; rail
    // sits at the panel's content edge so all sub-rows visually line
    // up under the same "Made by" header.
    containerStyle = `border-left:2px solid rgba(255,255,255,0.10);padding-left:58px;margin-left:-2px;`;
  }
  const titleAttr = hover ? ` data-crsmart-tip="${escapeHtml(hover)}"` : '';

  return `
    <div${titleAttr} style="
      display:flex;align-items:center;flex-wrap:wrap;gap:6px;
      ${dim ? 'opacity:0.55;' : ''}
      ${containerStyle}
      line-height:1.7;
    ">
      ${leadHtml}
      ${chipHtml}
      ${proofHtml}
    </div>`;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function prettySource(source) {
  if (!source) return null;
  return String(source).replace(/_/g, ' ').toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Native title= tooltip text for a row — shown on hover. Keeps the
// "incl. X, Y, Z" detail off-screen so the visible row stays
// single-line, but still discoverable. Uses ` · ` separators (newlines
// in title attrs render inconsistently across browsers).
function affinityHover(label, name, lovedCount, count, topSeries) {
  const entity = name ? `${label}: ${name}` : label;
  const stats = [];
  if (count > 0) stats.push(`${count} in your history`);
  if (lovedCount > 0) stats.push(`${lovedCount} loved`);
  const incl = topSeries.length
    ? ` · incl. ${topSeries.slice(0, 3).map(canonicalizeRawTitle).join(', ')}`
    : '';
  return stats.length ? `${entity} — ${stats.join(', ')}${incl}` : '';
}

// Plain-language tooltip for each role bucket so a casual fan hovering
// "Written by" / "Adapted from manga by" learns what the role actually
// is instead of bouncing off industry jargon. Keyed by canonical role
// name, looked up via ROLE_LABEL_BY_BUCKET.
const ROLE_DEFINITIONS = {
  'Studio':             'The animation studio that produced this series.',
  'Series Composition': 'The writer who plans the season’s arc structure and pacing across episodes.',
  'Character Design':   'The artist who turns the source’s characters into the show’s on-screen look.',
  'Original Creator':   'The author of the source material this anime is adapted from.',
  'Director':           'The lead creative voice steering the show overall.',
  'Music':              'The composer behind the show’s score.',
  'Source':             'The medium this anime was adapted from (manga, light novel, etc.).',
};

const ROLE_LABEL_BY_BUCKET = {
  'director':         'Director',
  'composition':      'Series Composition',
  'character-design': 'Character Design',
  'music':            'Music',
  'original-creator': 'Original Creator',
};

// Friend-voice lead phrase per role. The pill color carries the
// category signal (green = studio, blue = medium, neutral = creator);
// the verb here makes the row read as something a person would say.
// "Made by MAPPA" not "STUDIO: MAPPA"; "Adapted from manga by Gege
// Akutami" inlines both the medium and the credit in one breath.
function leadPhraseFor(bucket, role, sourceLabel) {
  switch (bucket) {
    case 'studio':          return 'Made by';
    case 'director':        return 'Directed by';
    case 'composition':     return 'Written by';
    case 'character-design':return 'Designed by';
    case 'music':           return 'Music by';
    case 'original-creator':
      // When we know the source medium, render it as its own pill
      // ("Adapted from [Light Novel] by [Fuse]") — keeps the medium
      // visually categorical alongside the other colored pills. The
      // lead phrase collapses to just "Adapted from".
      return sourceLabel ? 'Adapted from' : 'Original story by';
    case 'source':          return 'Adapted from';
    default:                return role ? `${role} —` : '';
  }
}

// Self-reference filter — when the rec is "Re:ZERO Season 4" and the
// only thing in White Fox's contributing-series list is "Re:ZERO
// -Starting Life in Another World-", showing it as proof reads as
// circular ("you'll like this because you watched this"). Strip
// titles that fuzzy-match the rec's own title so the visible proof
// is always *other* shows from the user's history.
//
// Normalization: lowercase, strip punctuation, drop sequel/movie
// markers ("Season 2", "Part 1", "the Movie", "OVA"), drop digits.
// Two titles match when one normalizes to a substring of the other.
function normalizeForMatch(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(season|part|cour|movie|ova|ona|special|specials|sp|final|the)\b/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topSeriesExcludingSelf(topSeries, recTitle) {
  if (!topSeries || !topSeries.length) return [];
  const recNorm = normalizeForMatch(recTitle);
  if (!recNorm) return topSeries;
  return topSeries.filter(t => {
    const tn = normalizeForMatch(t);
    if (!tn) return true;
    return !(tn === recNorm || tn.includes(recNorm) || recNorm.includes(tn));
  });
}

// Build the affinity entries (studio + key creators, with source folded
// into the original-creator row when both are present) and sort them by
// signal strength. The strongest familiar entry is flagged hero=true so
// the row gets the orange accent bar — the eye lands on the most
// resonant fact about the show before scanning the rest.
function buildAffinityEntries(rec) {
  const entries = [];
  const sourceLabel = prettySource(rec.source);
  const recTitle = rec.title?.english || rec.title?.romaji || rec.title?.native || '';

  // Helper: filter topSeries against the rec itself, and choose the
  // right "novelty" copy depending on whether the user IS familiar
  // (just via prior seasons of *this* show) vs. genuinely new to the
  // entity.
  const buildAffinityFields = (familiar, lovedCount, count, topSeries) => {
    const filtered = topSeriesExcludingSelf(topSeries || [], recTitle);
    const onlyViaThisShow = familiar && filtered.length === 0;
    return {
      familiar,
      lovedCount,
      count,
      topSeries: filtered,
      noveltyText: !familiar
        ? 'new to you'
        : (onlyViaThisShow ? 'from prior seasons' : null),
    };
  };

  // Studio row(s). When the franchise changed hands across seasons
  // (AoT: Wit S1–S3 → MAPPA S4) we emit one row per studio run so the
  // handoff is visible. Otherwise fall back to the single-studio row
  // built from the current entry's studios.
  const franchise = rec.franchise;
  if (franchise?.hasStudioChange && franchise.studioRuns?.length) {
    for (const run of franchise.studioRuns) {
      const studio = studioAffinityFor(run.studios, STATE.studioCreator?.studios);
      if (!studio) continue;
      const fields = buildAffinityFields(
        studio.familiar, studio.lovedCount ?? 0, studio.count ?? 0, studio.topSeries);
      entries.push({
        kind: 'studio',
        lead: leadPhraseFor('studio', null, null),
        leadHover: ROLE_DEFINITIONS['Studio'],
        name: studio.name,
        nameColor: COLOR.studio,
        seasonTag: run.seasonLabel || null,
        ...fields,
        hover: studio.familiar
          ? affinityHover('Studio', studio.name, studio.lovedCount, studio.count, studio.topSeries)
          : null,
        dim: !studio.familiar,
      });
    }
  } else {
    const studio = studioAffinityFor(rec.animationStudios, STATE.studioCreator?.studios);
    if (studio) {
      const fields = buildAffinityFields(
        studio.familiar, studio.lovedCount ?? 0, studio.count ?? 0, studio.topSeries);
      entries.push({
        kind: 'studio',
        lead: leadPhraseFor('studio', null, null),
        leadHover: ROLE_DEFINITIONS['Studio'],
        name: studio.name,
        nameColor: COLOR.studio,
        ...fields,
        hover: studio.familiar
          ? affinityHover('Studio', studio.name, studio.lovedCount, studio.count, studio.topSeries)
          : null,
        dim: !studio.familiar,
      });
    }
  }

  // Dedupe creators by role bucket — when AniList lists multiple
  // people in the same role (e.g. an LN author + manga adapter both
  // credited as Original Creator), two near-identical rows just
  // clutter the card. Keep the one with the strongest user signal
  // per bucket; ties broken by name presence.
  //
  // Role tier wins over affinity score within a bucket. Today this
  // matters for character-design: a Tier-1 anime Character Designer
  // (whose work IS the show's on-screen look) beats a Tier-2 Original
  // Character Designer (the source-material designer) even if the
  // Original CD has more cross-credits on the user's history.
  // Pre-fix Marriagetoxin headlined Mizuki Yoda (Original CD, has
  // cross-credits) over Kouhei Tokuoka (anime CD, none). For shows
  // where ONLY Original CD exists (~15 in the cache), Tier-2 still
  // wins by default.
  const creators = creatorAffinitiesFor(rec.keyStaff, STATE.studioCreator?.creators);
  const bestPerBucket = new Map();
  for (const c of creators) {
    const key = c.bucket || `__${c.role || 'staff'}`;
    const score = (c.lovedCount ?? 0) * 2 + (c.count ?? 0);
    const tier = c.roleTier ?? 1;
    const existing = bestPerBucket.get(key);
    if (!existing) {
      bestPerBucket.set(key, { c, score, tier });
      continue;
    }
    // Tier wins over score; same tier falls back to score.
    if (tier < existing.tier || (tier === existing.tier && score > existing.score)) {
      bestPerBucket.set(key, { c, score, tier });
    }
  }
  const dedupedCreators = [...bestPerBucket.values()].map(v => v.c);

  let originalCreatorRendered = false;
  for (const c of dedupedCreators) {
    const isOriginalCreator = c.bucket === 'original-creator';
    if (isOriginalCreator) originalCreatorRendered = true;
    const role = c.role || 'Staff';
    const canonicalRole = ROLE_LABEL_BY_BUCKET[c.bucket] || role;
    const fields = buildAffinityFields(
      c.familiar, c.lovedCount ?? 0, c.count ?? 0, c.topSeries);
    // For unfamiliar creators, override the generic novelty copy with
    // the role-aware version ("first credit on your list" reads better
    // than "new to you" for a person).
    if (!c.familiar) fields.noveltyText = 'first credit on your list';
    entries.push({
      kind: c.bucket || 'staff',
      lead: leadPhraseFor(c.bucket, role, isOriginalCreator ? sourceLabel : null),
      leadHover: ROLE_DEFINITIONS[canonicalRole] || null,
      name: c.name || '',
      // Per-role color (lavender Director, teal Composition, pink
      // Character Design, gold Music, warm Original Creator). Falls
      // back to neutral for ad-hoc/staff buckets without a registered
      // color.
      nameColor: COLOR_BY_BUCKET[c.bucket] ?? null,
      // For OC rows with a known source medium, surface the medium as
      // its own blue pill and glue it to the author name with "by".
      // ("Adapted from [Light Novel] by [Fuse]")
      prefixChip: isOriginalCreator && sourceLabel ? sourceLabel : null,
      prefixChipColor: isOriginalCreator && sourceLabel ? COLOR.medium : null,
      midText: isOriginalCreator && sourceLabel ? 'by' : null,
      ...fields,
      hover: c.familiar
        ? affinityHover(canonicalRole, c.name, c.lovedCount, c.count, c.topSeries)
        : null,
      dim: !c.familiar,
    });
  }

  // No Original Creator credit but we know the source — surface medium
  // as a standalone row so anime-original / unknown-author shows still
  // disclose what the show is adapted from. Reads as "Adapted from
  // [Manga]" with the medium carrying the row in the name slot.
  if (!originalCreatorRendered && sourceLabel) {
    entries.push({
      kind: 'source',
      lead: leadPhraseFor('source', null, null),
      leadHover: ROLE_DEFINITIONS['Source'],
      name: sourceLabel,
      nameColor: COLOR.medium,
      familiar: false,
      lovedCount: 0,
      count: 0,
      topSeries: [],
    });
  }

  // Studio-row grouping: when a franchise has changed hands across
  // seasons (AoT WIT→MAPPA), the franchise builder emits one entry per
  // run. The default sort interleaves them with creator rows by
  // familiarity, which (a) breaks chronological reading order and (b)
  // duplicates the "Made by" lead phrase on every studio row. Snapshot
  // the studio entries in chronological order BEFORE the familiarity
  // sort scrambles them, then re-insert the block as a unit after the
  // creator sort below. Lead phrase is dropped from non-first studio
  // rows in the final render so the section reads as one labeled
  // "Made by" with sub-rows underneath. Single-studio franchises are
  // unaffected (one entry means nothing to group).
  const studiosChrono = entries.filter(e => e.kind === 'studio');

  // Sort: familiar first, then by signal strength (weight loved 2x). The
  // strongest familiar entry gets hero accent. Source-only rows sink to
  // the bottom (no affinity context, no signal).
  entries.sort((a, b) => {
    if (a.kind === 'source' && b.kind !== 'source') return 1;
    if (b.kind === 'source' && a.kind !== 'source') return -1;
    if (a.familiar !== b.familiar) return Number(b.familiar) - Number(a.familiar);
    const sa = a.lovedCount * 2 + a.count;
    const sb = b.lovedCount * 2 + b.count;
    return sb - sa;
  });

  const studios = studiosChrono;
  if (studios.length >= 2) {
    const others = entries.filter(e => e.kind !== 'studio');
    let studiosScore = 0;
    let studiosFamiliar = false;
    for (const s of studios) {
      if (s.familiar) studiosFamiliar = true;
      studiosScore = Math.max(studiosScore, (s.lovedCount || 0) * 2 + (s.count || 0));
    }
    const merged = [];
    let inserted = false;
    for (const o of others) {
      if (!inserted) {
        const oScore = (o.lovedCount || 0) * 2 + (o.count || 0);
        const blockBeatsThis = studiosFamiliar !== o.familiar
          ? studiosFamiliar
          : studiosScore >= oScore;
        if (blockBeatsThis && o.kind !== 'source') {
          merged.push(...studios);
          inserted = true;
        }
      }
      merged.push(o);
    }
    if (!inserted) {
      // All creator rows ranked above the studio block (e.g. studios
      // unfamiliar, creators all familiar). Append studios before any
      // source row, otherwise at end.
      const sourceIdx = merged.findIndex(e => e.kind === 'source');
      if (sourceIdx >= 0) merged.splice(sourceIdx, 0, ...studios);
      else merged.push(...studios);
    }
    entries.length = 0;
    entries.push(...merged);
  }

  // Cap at 4 (studio + 3 strongest creators). Beyond that the card gets
  // tall and the marginal signal is low. When a multi-studio block
  // exists, allow the cap to flex up to 5 so AoT-style WIT+MAPPA both
  // survive alongside the top creators (the block is one logical row
  // visually — just rendered as a stack — so the extra height is the
  // cost of legitimately changed hands).
  const cap = studios.length >= 2 ? Math.min(4 + (studios.length - 1), 6) : 4;
  const trimmed = entries.slice(0, cap);

  // Strip "Made by" lead from every studio row except the first one
  // present in the final order — produces a single labeled "Made by"
  // section with sub-rows. Continuation rows are marked subRow:true
  // so affinityRow gives them a faint left rail (visual cue that they
  // belong to the row above), the hero accent still wins when set.
  let firstStudioSeen = false;
  for (const e of trimmed) {
    if (e.kind !== 'studio') continue;
    if (firstStudioSeen) {
      e.lead = null;
      e.subRow = true;
    } else {
      firstStudioSeen = true;
    }
  }

  // Tag the top familiar entry as the hero. If the top is unfamiliar
  // (no signal at all), no hero accent — nothing to highlight. For
  // multi-studio franchises we still hero whichever studio row has the
  // strongest signal even if it's not the first chronologically — the
  // orange bar marks "this is the credit you've vibed with" and that
  // signal trumps reading order.
  const topFamiliar = trimmed.find(e => e.familiar);
  if (topFamiliar) topFamiliar.hero = true;

  return trimmed;
}

function renderAffinityBlock(rec) {
  const entries = buildAffinityEntries(rec);
  if (!entries.length) return '';

  // Sequel collapse — when 2+ rows would each tail with "from prior
  // seasons" (studio + director + writer all familiar only via the
  // previous season), repeating the phrase reads as the card belaboring
  // the point. Strip the novelty tail from every such row and prepend
  // one clean franchise-familiarity line so the fact is stated once.
  const priorSeasonEntries = entries.filter(e => e.noveltyText === 'from prior seasons');
  let franchiseHeader = '';
  if (priorSeasonEntries.length >= 2) {
    for (const e of priorSeasonEntries) e.noveltyText = null;
    franchiseHeader = `
      <div style="display:flex;align-items:center;gap:8px;padding-bottom:2px;">
        <span style="opacity:0.55;font-size:12.5px;">You're already invested</span>
        <span style="opacity:0.35;">·</span>
        <span style="font-size:12px;opacity:0.65;font-style:italic;">these credits are all from earlier in the franchise</span>
      </div>`;
  }

  return franchiseHeader + entries.map(e => affinityRow(e)).join('');
}

// ── [moved to content-feedback.js: RATING_BUTTONS through wireReactionPalette] ──


// ── Card ────────────────────────────────────────────────────────────
// One-time stylesheet for stuff we can't easily express inline:
//   - chevron rotation when <details> opens
//   - hides the default summary disclosure triangle on Firefox
//     (Chrome already respects list-style:none inline)
// Idempotent: checks for the marker id before re-injecting.
function ensureStylesheet() {
  if (document.getElementById('crsmart-styles')) return;
  const style = document.createElement('style');
  style.id = 'crsmart-styles';
  style.textContent = `
    .crsmart-details > summary::-webkit-details-marker { display: none; }
    .crsmart-details > summary::marker { content: ''; }
    .crsmart-details[open] > summary .crsmart-chevron { transform: rotate(90deg); }

    /* Score ring fill animation. Per-rec --ring-from / --ring-to set
       inline so the same keyframe works across every card. Long-ish
       duration + gentle ease so the eye tracks the sweep into place. */
    @keyframes crsmart-ring-fill {
      from { stroke-dashoffset: var(--ring-from); }
      to   { stroke-dashoffset: var(--ring-to); }
    }
    .crsmart-ring-anim {
      animation: crsmart-ring-fill 0.85s cubic-bezier(0.22, 1, 0.36, 1) 0.1s forwards;
    }

    /* Cursor affordance for tip-bearing elements. Underline-dotted
       decoration is still inline so we don't decorate every tip target
       (some are whole rows where an underline would look wrong). */
    [data-crsmart-tip] { cursor: help; }

    /* Click-to-expand What-it-is box: subtle hover warmth so the
       clickability is discoverable without a big CTA. */
    .crsmart-desc-toggle:hover {
      background: rgba(255, 255, 255, 0.04) !important;
      border-left-color: rgba(255, 255, 255, 0.22) !important;
    }
    .crsmart-desc-toggle:focus-visible {
      outline: 2px solid rgba(255, 140, 40, 0.55);
      outline-offset: 2px;
    }

    /* Score-ring tier transitions. The SVG inside has a fixed viewBox
       (REFERENCE_RING_VIEWBOX) and a fixed circle radius (REFERENCE_
       RING_R) regardless of tier — visual size lives on the wrapper's
       CSS width/height, which CSS can transition smoothly. Without
       this, a score crossing a tier boundary (TRUST ME ↔ STRETCH ↔
       WORTH A SHOT) would snap from 80px → 72px → 64px in a single
       frame. The transition tweens it. Score text + anchor font-size
       transition alongside so the inner numbers scale with the ring. */
    [data-crsmart-zone="score-ring-wrapper"] {
      transition: width 0.45s cubic-bezier(0.22, 1, 0.36, 1),
                  height 0.45s cubic-bezier(0.22, 1, 0.36, 1),
                  transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
    }
    [data-crsmart-zone="score-text"],
    [data-crsmart-zone="score-anchor"] {
      transition: font-size 0.45s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* Rating-pending UX: rate-button click → ~1.4s recompute window
       before the score updates. During that window:
         - Score-ring wrapper "breathes" via a subtle scale pulse —
           reads as "the engine is thinking" without the harsher
           opacity flicker of the previous pulse animation
         - Rate buttons disabled + cursor:wait so rapid clicks can't
           thrash the debounce or confuse the user
       Cleared by the storage onChanged listener once allShowsScored
       lands with the new score. The transform: scale composes with
       the wrapper's tier-driven width/height transition above, so a
       tier change DURING a pending state still tweens cleanly. */
    @keyframes crsmart-breathing {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.05); }
    }
    [data-crsmart-rating-pending="1"] [data-crsmart-zone="score-ring-wrapper"] {
      animation: crsmart-breathing 1.6s ease-in-out infinite;
    }
    [data-crsmart-rating-pending="1"] button[data-rate] {
      cursor: wait;
      opacity: 0.55;
      pointer-events: none;
    }

    /* Custom tooltip popover. Reused single host element positioned
       via transform so layout stays cheap. Pointer-events:none so it
       never blocks the click underneath. */
    #crsmart-tip-host {
      position: fixed; top: 0; left: 0;
      max-width: 280px;
      padding: 8px 10px;
      background: rgba(20, 14, 10, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #fff;
      font-family: inherit;
      font-size: 12px;
      line-height: 1.45;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(12px) saturate(1.2);
      -webkit-backdrop-filter: blur(12px) saturate(1.2);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.12s ease-out;
      z-index: 2147483647;
    }
    #crsmart-tip-host.shown { opacity: 1; }
    /* Preserve newlines in tooltip content so a breakdown + per-title
       list reads as rows, not one run-on line. */
    #crsmart-tip-host { white-space: pre-line; }

    /* Extras token in the commitment line — dotted underline reads as
       "more info on hover" without competing with the tier chip or
       score ring for accent attention. Cursor:help reinforces it. */
    .crsmart-extras-token {
      text-decoration: underline dotted rgba(255, 255, 255, 0.35);
      text-underline-offset: 2px;
      cursor: help;
    }
    .crsmart-extras-token:hover {
      text-decoration-color: rgba(255, 255, 255, 0.7);
    }
  `;
  document.head.appendChild(style);
}

// Custom tooltip — replaces native title= for content tooltips because
// the OS tooltip's ~700ms delay and ugly chrome break the friend-voice
// feel of the card. Single delegated host element, positioned via
// transform. Idempotent boot — installs once per page.
function ensureTooltipSystem() {
  if (document.getElementById('crsmart-tip-host')) return;
  const tip = document.createElement('div');
  tip.id = 'crsmart-tip-host';
  document.body.appendChild(tip);

  let activeEl = null;
  let showTimer = null;

  const hide = () => {
    activeEl = null;
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    tip.classList.remove('shown');
  };

  const show = el => {
    const text = el.dataset.crsmartTip;
    if (!text) return;
    tip.textContent = text;
    // Stage offscreen to measure the rendered size, then place.
    tip.style.transform = 'translate(-9999px, -9999px)';
    tip.classList.add('shown');
    const tipRect = tip.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2 - tipRect.width / 2;
    let y = r.top - tipRect.height - 8;
    // Flip below if no room above.
    if (y < 8) y = r.bottom + 8;
    if (x < 8) x = 8;
    if (x + tipRect.width > window.innerWidth - 8) {
      x = window.innerWidth - tipRect.width - 8;
    }
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };

  document.addEventListener('mouseover', ev => {
    const el = ev.target.closest && ev.target.closest('[data-crsmart-tip]');
    if (!el || el === activeEl) return;
    if (showTimer) clearTimeout(showTimer);
    activeEl = el;
    showTimer = setTimeout(() => show(el), 220);
  }, true);

  document.addEventListener('mouseout', ev => {
    const el = ev.target.closest && ev.target.closest('[data-crsmart-tip]');
    if (el && el === activeEl) hide();
  }, true);

  // Hide on scroll/click so a stale tooltip doesn't follow the user
  // into the next interaction.
  window.addEventListener('scroll', hide, true);
  document.addEventListener('click', hide);
}

// ── Signed rationale chips ──────────────────────────────────────────
// Layered card rationale. Two parallel surfaces:
//
//   1. "Genre" row (neutral, lane info) — sourced from AniList's
//      ~19 broad genres + the 5 demographic tags. Toggleable via
//      surfaceSettings.genreRow. Tells you what kind of show this
//      is at a glance.
//   2. Signed rows ("Why you're in" / "What might bug you") — sourced
//      from rec.topTags / rec.topAntiTags MINUS the broad-genre
//      vocabulary, so chips here surface DIFFERENTIATING signal
//      (Magic, Tragedy, Battle, Body Swapping) instead of repeating
//      the lane the genre row already states.
//
// Magnitude floor: |userWeight × rank/100| ≥ 0.3. Below that, a tag's
// pull on the score is weak enough that surfacing it as a verdict
// would overclaim. Implied tags (projected onto the show via the
// co-occurrence map) are excluded — they aren't actually present on
// the show, only on the user's vector, and chipping them would mislead.
const SIGNED_TAG_FLOOR = 0.3;

// Broad-genre / demographic vocabulary. AniList exposes 19 named
// genres and 5 demographic tags; together these are the "lane"
// vocabulary a show announces about itself. They dominate signed-
// product sort because rank=100 (genres) or near-100 (demographics)
// AND the user's userWeight on them is high. When the genre row is
// shown, we exclude these from the signed rows so the chips can
// surface tag-level differentiating signal (Magic, Tragedy, Battle,
// Body Swapping) instead of repeating lane info.
//
// Spellings include both "Shounen" (AniList canonical) and "Shonen"
// (CR's spelling that sometimes leaks through tenantCategories).
const BROAD_GENRE_LIST = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Hentai',
  'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological',
  'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
  'Shounen', 'Shonen', 'Seinen', 'Shoujo', 'Josei', 'Kids',
];
const BROAD_GENRE_SET = new Set(BROAD_GENRE_LIST.map(s => s.toLowerCase()));
function isBroadGenre(name) {
  return BROAD_GENRE_SET.has(String(name || '').toLowerCase().trim());
}

function leanPhraseFor(userWeight) {
  const m = Math.abs(userWeight);
  if (userWeight >= 0) {
    if (m >= 5) return 'one of your strongest pulls';
    if (m >= 2) return 'you reach for this often';
    if (m >= 0.5) return 'a modest pull';
    return 'a mild lean';
  }
  if (m >= 5) return "you've consistently dropped this";
  if (m >= 2) return "you've cooled on this often";
  if (m >= 0.5) return 'a modest avoid';
  return 'a mild miss';
}

function pickSignedTags(source, polarity, opts = {}) {
  // Phase A: delegate to phrase-engine when available, falling back to
  // the legacy in-place filter. The engine's selectChips drops unmapped
  // tags + backfills + safety-net so the friend-voice register stays
  // consistent. Falls back to the legacy filter when the engine global
  // isn't loaded (extension reload edge case, or when phrase-map.js
  // hasn't initialised yet).
  const want = polarity === 'positive' ? 6 : 3;
  const engine = window.crsmartPhraseEngine;
  if (engine && engine.selectChips) {
    return engine.selectChips(source, polarity, {
      isUsefulTag,
      isBroadGenre,
      excludeBroadGenres: opts.excludeBroadGenres,
      floor: SIGNED_TAG_FLOOR,
      budget: want,
    });
  }
  // Legacy fallback path — same logic as before phrase-engine landed.
  const sign = polarity === 'positive' ? 1 : -1;
  const excludeBroad = opts.excludeBroadGenres !== false;
  return (source || [])
    .filter(t => t && !t.implied)
    .filter(t => isUsefulTag(t.tag))
    .filter(t => excludeBroad ? !isBroadGenre(t.tag) : true)
    .filter(t => sign > 0 ? t.userWeight > 0 : t.userWeight < 0)
    .filter(t => Math.abs((t.userWeight || 0) * (t.rank || 0) / 100) >= SIGNED_TAG_FLOOR)
    .slice(0, want);
}

function positiveLeadFor(tier) {
  // TRUST ME confidently claims "you're in"; weaker tiers soften to
  // "what's pulling for it" so the chip row doesn't overclaim a verdict
  // the tier has already hedged. Negative-row label is constant — it
  // never overclaims regardless of tier.
  return tier?.name === 'TRUST ME' ? "Why you're in" : "What's pulling for it";
}

function renderSignedChip(entry, rec, polarity) {
  // entry can be either a legacy tag entry (from Phase A's selectChips)
  // or a Phase B ChipSpec ({text, source, tag?, isMediaSpoiler?, ...}).
  // Both paths converge on the same chip styling — only the spoiler
  // lock and tooltip differ.
  const aniListId = rec?.aniListId ?? 'na';
  const isTagSource = !entry.source || entry.source === 'tag';
  const tagName = entry.tag;
  // Tint resolved via the chip-tint registry — single source of truth
  // for affinity-orange (positive) and warning-red (negative).
  const source = entry.source || 'tag';
  const baseStyle = window.crsmartChipTint
    ? window.crsmartChipTint.chipStyleCss(source, polarity)
    : (function () {
        // Legacy fallback if chip-tint module didn't load — preserves
        // the prior inline values byte-for-byte.
        const accent = polarity === 'positive'
          ? 'rgba(255,140,40,' : 'rgba(220,80,80,';
        return `
          display:inline-flex;align-items:center;gap:5px;
          background:${accent}0.10);
          border:1px solid ${accent}0.30);
          color:${accent}0.92);
          padding:2px 9px;border-radius:999px;
          font-size:11px;line-height:1.2;
        `;
      })();

  // Phase B ChipSpec carries pre-computed text + tooltip. Legacy tag
  // entries fall through to the phrase-map lookup, then to raw tag
  // name as last resort.
  const engine = window.crsmartPhraseEngine;
  let displayText = entry.text;
  if (!displayText && isTagSource && engine) {
    displayText = engine.tagPhrase(entry, polarity).text;
  }
  if (!displayText) displayText = tagName || '';

  // Tooltip: ChipSpec.tooltip wins; tag-source falls back to
  // "{tagName} — {leanPhrase}"; non-tag-source defaults to source label.
  let tip;
  if (entry.tooltip) {
    tip = entry.tooltip;
  } else if (isTagSource) {
    const leanPhrase = leanPhraseFor(entry.userWeight);
    tip = `${tagName} — ${leanPhrase}`;
  } else {
    tip = `${displayText} (${entry.source})`;
  }

  // Spoiler lock only applies to tag-source chips. Studio / creator /
  // adaptation / genre-tag chips are never spoilers.
  if (isTagSource && entry.isMediaSpoiler && !STATE.showSpoilers) {
    const key = `${aniListId}:${tagName}`;
    const revealed = STATE.spoilersRevealed.has(key);
    if (!revealed) {
      return `<button type="button"
        data-crsmart-spoiler-chip="${escapeHtml(key)}"
        data-crsmart-tip="Tap to reveal — this contributor is a tagged spoiler."
        style="${baseStyle}cursor:pointer;font:inherit;letter-spacing:0;">
        <span style="opacity:0.85;">🔒</span><span style="opacity:0.85;">spoiler</span>
      </button>`;
    }
  }

  return `<span data-crsmart-tip="${escapeHtml(tip)}" style="${baseStyle}">${escapeHtml(displayText)}</span>`;
}

function renderSignedRow(label, tip, chips) {
  if (!chips.length) return '';
  return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;line-height:1.7;padding-top:2px;">
    <span data-crsmart-tip="${escapeHtml(tip)}" style="opacity:0.55;font-size:12.5px;text-decoration:underline dotted rgba(255,255,255,0.20);text-underline-offset:3px;">${escapeHtml(label)}</span>
    <span style="opacity:0.35;margin:0 2px;">·</span>
    ${chips.join('')}
  </div>`;
}

// Neutral genre row: lane info only, no polarity tint, no per-chip
// tooltip. Sourced from rec.genres (AniList's small fixed genre list)
// — we don't pull from rec.topTags here because we want canonical
// genre membership, not "tags that happen to be named like genres."
// Capped at 5 to keep the row to a single line on most viewports.
function renderGenreRow(rec) {
  const genres = (rec?.genres || []).filter(Boolean).slice(0, 5);
  if (!genres.length) return '';
  // Genre chips use the 'factual' palette via the chip-tint registry.
  const chipStyle = window.crsmartChipTint
    ? window.crsmartChipTint.chipStyleCss('genre', 'positive')
    : `
      display:inline-flex;align-items:center;
      background:rgba(255,255,255,0.03);
      border:1px solid rgba(255,255,255,0.10);
      color:rgba(255,255,255,0.70);
      padding:2px 9px;border-radius:999px;
      font-size:11px;line-height:1.2;
    `;
  const chips = genres.map(g => `<span style="${chipStyle}">${escapeHtml(g)}</span>`);
  return renderSignedRow(
    'Genre',
    'The show\'s lane — broad-strokes categories from AniList.',
    chips,
  );
}

// Vibe row — descriptive tonal-mood band. Sits between Genre (factual
// lane) and Positive (personalized affinity). Up to 2 chips, composed
// by chip-composer (which delegates to vibe-tags.composeVibeChips).
// Soft lavender tint distinguishes it from polarity-coded rows
// (orange = affinity, red = warning, grey = factual genre).
//
// This function is render-only — it consumes pre-composed chips from
// the composer. Composition lives in chip-composer.js + vibe-tags.js.
//
// Tooltip detail (Tier B #7, 2026-05-12): when window.VIBE_TAGS exposes
// explainVibeFiring, we extend the tooltip from "Vibe: dark + edgy" to
// "Vibe: dark + edgy — Fires because: dark: Tragedy (rank 100), Gore
// (rank 85); edgy: Anti-Hero (rank 90)". Falls back to the headline
// alone if the helper isn't available (defensive — vibe-tags.js may not
// have loaded yet during early init).
function renderVibeRowFromChips(chips, rec) {
  if (!chips || !chips.length) return '';
  const chipStyle = window.crsmartChipTint
    ? window.crsmartChipTint.chipStyleCss('vibe-composite', 'positive')
    : `
      display:inline-flex;align-items:center;
      background:rgba(168,140,232,0.10);
      border:1px solid rgba(168,140,232,0.28);
      color:rgba(220,205,250,0.92);
      padding:2px 9px;border-radius:999px;
      font-size:11px;line-height:1.2;
    `;
  const explainer = window.VIBE_TAGS?.explainVibeFiring;
  const buildTip = (chip) => {
    const headline = chip.source === 'vibe-composite'
      ? `Vibe: ${chip.vibes.join(' + ')}`
      : `Vibe: ${chip.vibes[0]}`;
    if (!explainer || !rec) return headline;
    const perVibe = chip.vibes.map(v => {
      const { hits } = explainer(rec, v) || { hits: [] };
      const firing = hits.filter(h => !h.skipped);
      if (!firing.length) return null;
      // Top 3 firing tags by rank desc; genres have null rank, sort to end.
      const sorted = [...firing].sort((a, b) => (b.tagRank ?? -1) - (a.tagRank ?? -1)).slice(0, 3);
      const tagList = sorted.map(h => h.tagRank != null
        ? `${h.matchedTag} (rank ${h.tagRank})`
        : h.matchedTag).join(', ');
      return chip.vibes.length > 1 ? `${v}: ${tagList}` : tagList;
    }).filter(Boolean).join('; ');
    return perVibe ? `${headline} — Fires because: ${perVibe}` : headline;
  };

  // Native `title` attribute alongside the project-specific data-attr.
  // Previously only data-crsmart-tip was set, but no custom tooltip
  // renderer reads it — so the explainVibeFiring detail never reached
  // users. Setting title gives the chip the browser's native hover
  // tooltip for free; cursor:help nudges users to discover it.
  const chipHtml = chips.map(c => {
    const tip = buildTip(c);
    const tipEsc = escapeHtml(tip);
    return `<span data-crsmart-tip="${tipEsc}" title="${tipEsc}" style="${chipStyle};cursor:help">${escapeHtml(c.text)}</span>`;
  });

  return renderSignedRow(
    'Vibe',
    "The show's tonal mood — what you're walking into. Not about taste matching, just an honest heads-up on the gestalt.",
    chipHtml,
  );
}

function renderSignedRationale(rec, tier) {
  const showGenreRow = STATE.genreRow !== false;
  // The chip-composer module owns coordination: Phase B positive pool,
  // burnout-aware negative pool, vibe row, and skip-if line. content.js
  // is render-only — we hand the composer the rec + a ctx of STATE +
  // tag filters, and consume the structured ChipRow it returns.
  const composer = window.crsmartChipComposer;
  const row = composer
    ? composer.composeChipRow(rec, {
        studioCreatorIndex: STATE.studioCreator,
        tagBurnoutIndex: STATE.tagBurnoutIndex,
        isUsefulTag,
        isBroadGenre,
        excludeBroadGenres: showGenreRow,
        floor: SIGNED_TAG_FLOOR,
        positiveBudget: 4,
        negativeBudget: 3,
        // Negative-chip collection still goes through content.js's
        // pickSignedTags (it depends on STATE-scoped filter knobs the
        // composer can't see). Pass it as a callback so the composer's
        // burnout-swallow rule still applies.
        collectNegatives: r => pickSignedTags(r?.topAntiTags, 'negative', {
          excludeBroadGenres: showGenreRow,
        }),
      })
    : { positive: [], negative: [], vibe: [], skipIf: null };
  const positives = row.positive;
  const negatives = row.negative;

  const genreRowHtml = showGenreRow ? renderGenreRow(rec) : '';
  const vibeRowHtml = renderVibeRowFromChips(row.vibe, rec);

  // Cold-start: nothing in either signed row AND the genre/vibe rows would
  // also be empty (or hidden). Caller falls back to the legacy "Feels
  // like" row in that case so the card never has zero chip rows.
  if (!positives.length && !negatives.length && !genreRowHtml && !vibeRowHtml) return null;

  const posChips = positives.map(t => renderSignedChip(t, rec, 'positive'));
  const negChips = negatives.map(t => renderSignedChip(t, rec, 'negative'));

  const posRow = renderSignedRow(
    positiveLeadFor(tier),
    'Tags that pulled this show toward your taste — beyond the broad genre lane.',
    posChips,
  );
  const negRow = renderSignedRow(
    'What might bug you',
    "Tags you've consistently dropped — a heads-up before you commit.",
    negChips,
  );

  return [genreRowHtml, vibeRowHtml, posRow, negRow].filter(Boolean).join('');
}

function wireSpoilerChips(card, rec) {
  const buttons = card.querySelectorAll('button[data-crsmart-spoiler-chip]');
  buttons.forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      // Extension-context guard — when the user reloads the extension
      // at chrome://extensions while the page still has the old content
      // script bound, any downstream chrome.* call from this handler
      // (renderSignedChip → engine lookup → indirect chrome access)
      // throws "Extension context invalidated" as an uncaught error.
      // Detect early, surface the existing refresh banner, and bail
      // cleanly so the user sees an explanation instead of a crash.
      if (isExtensionContextInvalidated()) {
        showContextInvalidatedBanner();
        return;
      }
      try {
        const key = btn.dataset.crsmartSpoilerChip;
        if (!key) return;
        STATE.spoilersRevealed.add(key);
        // Find which tag this is and which polarity by walking either list.
        const tagName = key.split(':').slice(1).join(':');
        const fromPos = (rec.topTags || []).find(t => t?.tag === tagName);
        const fromNeg = (rec.topAntiTags || []).find(t => t?.tag === tagName);
        const entry = fromPos || fromNeg;
        if (!entry) return;
        const polarity = fromPos ? 'positive' : 'negative';
        const fresh = renderSignedChip(entry, rec, polarity);
        const tmp = document.createElement('div');
        tmp.innerHTML = fresh;
        const replacement = tmp.firstElementChild;
        if (replacement) btn.replaceWith(replacement);
      } catch (err) {
        // Belt-and-suspenders for context invalidation that slips
        // past the early probe (some Chrome builds throw lazily on
        // first chrome.* call, not on chrome.runtime.id access).
        if (/Extension context invalidated/.test(err?.message || '')) {
          showContextInvalidatedBanner();
          return;
        }
        throw err;
      }
    });
  });
}

// Single source of truth for the verdict column's HTML — the row of
// chips (tier + dealbreaker + rating-override + quality) plus the
// headline + commitment line + pitch line. Both buildCard (full
// mount) and cardModule._patch (verdict-zone patch) call this so a
// rating click can't make a chip disappear by skipping it from the
// patch path.
//
// Why this seam exists: the duplicated HTML lived in two places
// (buildCard's row 1 + _patch's column.innerHTML rebuild). The patch
// path only included quality chips, so rating-override and
// dealbreaker chips silently disappeared after every 👍/👎 click
// until the next deep-zone change forced a remount. Moving the row
// into one helper makes "this is what the verdict column renders"
// inspectable in one read.
function verdictColumnHtml(rec, tier) {
  // One read of the rec's presentation facts. Headline, tier suffix,
  // and pitch all consume the same `dominant` so they can't disagree
  // about which sub-score is carrying the rec — the previous shape
  // had three independent sorts of subScores (one per consumer).
  const dominant = dominantSignal(rec);
  const escalated = isEscalated(rec);
  const headline = personalizedHeadline(tier, dominant, escalated);
  const tierSuffix = tierSuffixFor(dominant);
  const tierLabel = tierSuffix ? `${tier.name} · ${tierSuffix}` : tier.name;
  const commitText = commitmentLine(rec);
  const pitch = pitchLineFor(rec, { dominant });
  const pitchContent = pitch.html ? pitch.content : escapeHtml(pitch.content);
  // Deep-link help icon. Routed through the service worker
  // (crsmart:open-help-tab) rather than a direct chrome-extension://
  // anchor because http → chrome-extension navigation from a CR page
  // gets ERR_BLOCKED_BY_CLIENT under common ad-blockers. The SW opens
  // the tab in extension-origin context, sidestepping the block.
  // The click is wired by wireHelpDot() after the card mounts.
  return `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      ${chip(tierLabel, { bg: tier.bg, color: tier.color, border: 'transparent', weight: 700 })}
      ${dealbreakerChipFor(rec)}
      ${ratingOverrideChipFor(rec)}
      ${qualityChipsFor(rec).join('')}
      <button type="button"
              class="crsmart-help-dot"
              data-crsmart-help-section="smart-score"
              data-crsmart-tip="What is this card? Opens help in a new tab."
              style="margin-left:auto;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.22);border-radius:50%;background:transparent;color:rgba(255,255,255,0.55);font-size:11px;font-weight:600;cursor:help;line-height:1;flex-shrink:0;padding:0;font-family:inherit;"
              aria-label="What is the Smart Score card? Opens help.">?</button>
    </div>
    <!-- Friend-voice verdict in 4-6 words. Sets the energy before
         the engine prose lays out the proof. -->
    <div style="margin-top:6px;font-size:15px;font-weight:700;letter-spacing:-0.1px;color:#fff;line-height:1.3;">
      ${escapeHtml(headline)}
    </div>
    ${commitText ? `<div style="margin-top:4px;font-size:11.5px;opacity:0.55;letter-spacing:0.3px;">${commitText}</div>` : ''}
    <div style="margin-top:3px;font-size:12.5px;line-height:1.45;opacity:0.78;">
      ${pitchContent}
    </div>`;
}

function buildCard(rec, mode) {
  ensureStylesheet();
  ensureTooltipSystem();
  const finalScore = rec.finalScore ?? 0;
  const score10 = (finalScore * 10).toFixed(1);
  const score100 = Math.round(finalScore * 100);
  const tier = tierFor(finalScore);

  // Ring scales with tier — larger ring = louder visual verdict.
  // Wrapper width/height drive the visual size (CSS-transitionable);
  // the SVG itself stays at the reference viewBox so dashoffset math
  // is tier-invariant.
  const ringDims = ringDimsFor(tier.name);
  const r = REFERENCE_RING_R;
  const c = REFERENCE_RING_CIRCUMFERENCE;
  const offset = c * (1 - score100 / 100);

  // Skip the ring animation if we've already played it for this series
  // this page load — CR's hero re-mount would otherwise replay it 2-3
  // times in quick succession. Keyed by aniListId, not title — title
  // can be undefined during cold-start before page loads, and two
  // different series sharing a title (rare but possible across
  // franchises) would have collided under the old title-keyed gate.
  const recId = rec.aniListId || null;
  const shouldAnimateRing = recId && STATE.animatedFor !== recId;
  if (recId) STATE.animatedFor = recId;

  const filteredTopTags = (rec.topTags || []).filter(t => isUsefulTag(t.tag));
  const tags = filteredTopTags.slice(0, 5).map(t => t.tag).filter(Boolean);
  const sub = rec.subScores || {};
  // Verdict column (tier chip row + chips + headline + commit line +
  // pitch) lives in verdictColumnHtml so the patch path uses the same
  // source. See that function for why.
  const skipIfText = skipIfClause(rec.topTags, rec);
  const descObj = plainDescription(rec.description);
  // For movie-only franchises with 2+ members (the Heaven's Feel
  // trilogy, the Garden of Sinners movies, the Rebuild of Evangelion
  // tetralogy), the franchise-root description AL ships covers just
  // the FIRST film — but the CR page is the whole series. Prepend a
  // small "Three-film series, 2017–2020" header above the synopsis
  // so the framing is honest: this card describes a multi-film
  // arc, and the prose below is the opening one's plot.
  const filmSeriesHeader = trilogyHeaderText(rec.franchise);
  const descExpanded = descObj && recId
    ? STATE.descriptionExpanded.has(recId)
    : false;
  const descShownText = descObj ? (descExpanded ? descObj.full : descObj.short) : null;

  // Per-rec gradient id so each card's score ring fills in with a
  // tier-aware sweep (tier color → orange affinity). Using aniListId
  // keeps it stable across re-renders and unique across stacked cards
  // if we ever render multiple on one page.
  const ringGradId = `crsmart-ring-grad-${rec.aniListId || 'na'}`;

  // Rationale chip rows: prefer the signed "why you're in / what might
  // bug you" pair sourced from per-show matched contributors. Falls
  // back to the legacy neutral "Feels like" row only when both signed
  // rows are empty (cold-start: thin taste vector with nothing above
  // the magnitude floor on either side). Neutral descriptors are still
  // better than no chip row at all when we have no opinion to offer.
  const signedChipsHtml = renderSignedRationale(rec, tier);
  const tagsHtml = signedChipsHtml || (tags.length
    ? `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;line-height:1.7;padding-top:2px;">
         <span data-crsmart-tip="The show's mood and themes from AniList — not tied to your history." style="opacity:0.55;font-size:12.5px;text-decoration:underline dotted rgba(255,255,255,0.20);text-underline-offset:3px;">Feels like</span>
         <span style="opacity:0.35;margin:0 2px;">·</span>
         ${tags.map(t => `
           <span style="
             display:inline-flex;align-items:center;
             background:rgba(255,255,255,0.03);
             border:1px solid rgba(255,255,255,0.10);
             color:rgba(255,255,255,0.70);
             padding:2px 9px;border-radius:999px;
             font-size:11px;line-height:1.2;
           ">${escapeHtml(t)}</span>`).join('')}
       </div>`
    : '');

  const subBar = (key, val) => `
    <div style="display:grid;grid-template-columns:100px 1fr 30px;gap:8px;align-items:center;font-size:11px;opacity:0.75;">
      <span>${key}</span>
      <span style="height:4px;background:rgba(255,255,255,0.10);border-radius:2px;overflow:hidden;">
        <span style="display:block;height:100%;width:${(val * 100).toFixed(0)}%;background:${COLOR.affinity};"></span>
      </span>
      <span style="text-align:right;font-variant-numeric:tabular-nums;">${val.toFixed(2)}</span>
    </div>`;

  const affinityRowsHtml = renderAffinityBlock(rec);
  const rationalePanel = (affinityRowsHtml || tagsHtml)
    ? `<div style="display:flex;flex-direction:column;gap:10px;padding:14px 16px;background:rgba(255,255,255,0.04);border-radius:10px;">
         ${affinityRowsHtml}
         ${tagsHtml}
       </div>`
    : '';

  const card = document.createElement('div');
  card.id = CARD_ID;
  // position:relative anchors the absolute tier-aura overlay inside
  // the card. Layout is now done by an inner wrapper so the aura can
  // sit underneath all content as a sibling.
  card.style.cssText = `
    position: relative;
    margin: 0 0 14px 0;
    padding: 16px 20px;
    border-radius: 12px;
    background: rgba(20, 14, 10, 0.35);
    backdrop-filter: blur(18px) saturate(1.2);
    -webkit-backdrop-filter: blur(18px) saturate(1.2);
    border: 1px solid rgba(255,255,255,0.10);
    font-family: inherit;
    color: #fff;
    max-width: ${STATE.cardMaxWidth}px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.30);
    overflow: hidden;
  `;

  // Tier aura — radial gradient in the tier color seeping in from the
  // top-left corner where the score ring lives. TRUST ME washes the
  // card faintly purple, STRETCH faintly orange, WORTH A SHOT faintly
  // green. Peripheral signal of stakes before reading any text.
  const tierRgb = hexToRgb(tier.bg);
  const auraHtml = `
    <div aria-hidden="true" style="
      position:absolute;inset:0;
      background:
        radial-gradient(520px circle at 0% 0%, rgba(${tierRgb},0.14), transparent 55%),
        radial-gradient(360px circle at 100% 100%, rgba(${tierRgb},0.05), transparent 60%);
      pointer-events:none;border-radius:12px;z-index:0;
    "></div>
  `;

  // Ghost cover bleed — faint right-edge wash of the rec's own cover
  // art so the card feels themed to *this* show, not generic chrome.
  // Off by default (the translucent blurred panel reads cleaner over
  // CR's hero); user opts in from the popup. STATE.coverBleed gates
  // the render so toggling it off rebuilds the card cleanly.
  const coverUrl = rec.coverImage?.large || rec.coverImage?.medium || null;
  const coverBleedHtml = (STATE.coverBleed && coverUrl)
    ? `<div aria-hidden="true" style="
        position:absolute;top:0;right:0;bottom:0;width:280px;
        background-image:url('${escapeHtml(coverUrl)}');
        background-size:cover;background-position:center;
        opacity:0.10;
        -webkit-mask-image:linear-gradient(to left, rgba(0,0,0,0.95) 0%, transparent 92%);
        mask-image:linear-gradient(to left, rgba(0,0,0,0.95) 0%, transparent 92%);
        pointer-events:none;border-radius:12px;z-index:0;
      "></div>`
    : '';

  card.innerHTML = `
    ${auraHtml}
    ${coverBleedHtml}
    <div style="position:relative;z-index:1;display:flex;flex-direction:column;gap:14px;">

      <!-- Row 1: score + tier + headline + pitch -->
      <div style="display:flex;align-items:center;gap:16px;">
        <div data-crsmart-zone="score-ring-wrapper" style="position:relative;width:${ringDims.size}px;height:${ringDims.size}px;flex:0 0 auto;">
          <svg width="100%" height="100%" viewBox="0 0 ${REFERENCE_RING_VIEWBOX} ${REFERENCE_RING_VIEWBOX}" style="display:block;">
            <defs>
              <!-- Per-rec gradient: tier color → orange affinity. The
                   sweep from cool/intense (purple/green) into the
                   "you'll like this" orange visually completes the
                   verdict the tier label asserts. -->
              <linearGradient id="${ringGradId}" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="${tier.bg}" />
                <stop offset="100%" stop-color="${COLOR.affinity}" />
              </linearGradient>
            </defs>
            <circle cx="${REFERENCE_RING_VIEWBOX/2}" cy="${REFERENCE_RING_VIEWBOX/2}" r="${r}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="5"/>
            <!-- When animating: stroke-dashoffset starts at the full
                 circumference (empty ring) and CSS sweeps it to the
                 target. When skipping (re-injection on the same series),
                 render straight to the final position so the card just
                 reappears without a sweep. -->
            <circle ${shouldAnimateRing ? 'class="crsmart-ring-anim"' : ''}
              data-crsmart-zone="score-ring-fill"
              cx="${REFERENCE_RING_VIEWBOX/2}" cy="${REFERENCE_RING_VIEWBOX/2}" r="${r}" fill="none"
              stroke="url(#${ringGradId})" stroke-width="5"
              stroke-dasharray="${c.toFixed(2)}"
              stroke-dashoffset="${shouldAnimateRing ? c.toFixed(2) : offset.toFixed(2)}"
              stroke-linecap="round" transform="rotate(-90 ${REFERENCE_RING_VIEWBOX/2} ${REFERENCE_RING_VIEWBOX/2})"
              style="--ring-from: ${c.toFixed(2)}; --ring-to: ${offset.toFixed(2)};"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;">
            <span data-crsmart-zone="score-text" style="font-size:${ringDims.fontSize}px;font-weight:700;letter-spacing:-0.5px;">${score10}</span>
            <span data-crsmart-zone="score-anchor" style="font-size:${ringDims.anchorSize}px;font-weight:600;opacity:0.45;margin-top:2px;letter-spacing:0.3px;">/ 10</span>
          </div>
        </div>
        <div data-crsmart-zone="verdict-column" style="flex:1;min-width:0;">
          ${verdictColumnHtml(rec, tier)}
        </div>
      </div>

      ${descObj ? `
      <!-- What-it-is: per the user's critique, the card verdicts loudly
           but never tells a cold visitor what the show is about. Small
           section between the pitch line and the affinity panel so the
           plot hook lands before the "loved by / made by" proof.
           Box is click-to-expand when the synopsis exceeds the 40-word
           preview — lets curious users read the full description
           without a separate modal or navigation. -->
      <div data-crsmart-desc-toggle="${descObj.truncated ? '1' : '0'}"
           ${descObj.truncated ? 'role="button" tabindex="0"' : ''}
           class="${descObj.truncated ? 'crsmart-desc-toggle' : ''}"
           style="padding:12px 16px;background:rgba(255,255,255,0.02);border-left:2px solid rgba(255,255,255,0.12);border-radius:4px;${descObj.truncated ? 'cursor:pointer;transition:background 0.15s, border-left-color 0.15s;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="opacity:0.45;font-size:10.5px;text-transform:uppercase;letter-spacing:0.9px;font-weight:700;">What it is</span>
          ${descObj.truncated ? `<span data-crsmart-desc-label style="opacity:0.4;font-size:10.5px;letter-spacing:0.3px;font-weight:600;">${descExpanded ? '▾ less' : '▸ more'}</span>` : ''}
        </div>
        ${filmSeriesHeader ? `<div style="font-size:12px;opacity:0.78;font-style:italic;margin-bottom:10px;padding:6px 10px;line-height:1.45;background:rgba(255,140,40,0.05);border-left:2px solid rgba(255,140,40,0.35);border-radius:3px;">${escapeHtml(filmSeriesHeader)}</div>` : ''}
        <div data-crsmart-desc-text style="font-size:13px;line-height:1.55;opacity:0.88;">${escapeHtml(descShownText)}</div>
      </div>` : ''}

      ${rationalePanel}

      ${skipIfText ? `
      <!-- Skip-if: honesty beat before the rate prompt. Muted tone so
           it reads as a quiet heads-up, not a warning label. -->
      <div style="font-size:12px;opacity:0.55;font-style:italic;padding:0 4px;">
        ${escapeHtml(skipIfText)}
      </div>` : ''}

      <!-- Rate banner — the only feedback channel into the engine.
           Friend-voice headline ("You in?") + friend-voice helper
           ("not for me / more like this") so the section reads as
           a verdict prompt, not a survey. Below the banner, a
           collapsible reaction-tag palette reveals once the user has
           rated — lets them explain *why* so the engine can demote or
           boost the specific dimensions that drove the call. -->
      <div style="display:flex;flex-direction:column;gap:10px;padding:12px 16px;background:rgba(255,140,40,0.06);border:1px solid rgba(255,140,40,0.18);border-radius:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
          <div>
            <div style="font-size:13px;font-weight:700;letter-spacing:0.2px;color:${COLOR.affinity};">You in?</div>
            <div style="font-size:12px;opacity:0.65;margin-top:2px;">👎 not for me · 👍 more like this</div>
          </div>
          ${renderRateButtons(rec)}
        </div>
        ${renderReactionPalette(rec)}
      </div>

      <details class="crsmart-details" style="font-size:12px;color:rgba(255,255,255,0.75);">
        <summary style="cursor:pointer;outline:none;user-select:none;opacity:0.6;font-size:11px;text-transform:uppercase;letter-spacing:1px;list-style:none;display:inline-flex;align-items:center;gap:6px;">
          <span class="crsmart-chevron" style="display:inline-block;transition:transform 0.15s;font-size:9px;opacity:0.7;">▶</span>
          Show me the math
        </summary>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px;">
          ${subBar('Taste match', sub.taste ?? 0)}
          ${typeof rec.tasteNInLane === 'number'
            ? subBar(`Match in your ${(STATE.archetypeBlend?.find(a => a.id === rec.primaryArchetype)?.name) || 'lane'}`, rec.tasteNInLane)
            : ''}
          ${subBar('Community recs', sub.rec ?? 0)}
          ${subBar('Quality', sub.qual ?? 0)}
          ${sub.crCF != null ? subBar('CR audience pick', sub.crCF) : ''}
          ${typeof sub.creator === 'number' ? subBar('Team you trust', sub.creator) : ''}
        </div>
      </details>

    </div>
  `;

  wireRateButtons(card, rec);
  wireReactionPalette(card, rec);
  wireSpoilerChips(card, rec);
  wireHelpDots(card);
  if (descObj && descObj.truncated) wireDescriptionToggle(card, descObj, recId);
  return card;
}

// Click handlers for the "?" help dots. Routes through the SW's
// crsmart:open-help-tab message because direct chrome-extension://
// navigation from a CR page gets ERR_BLOCKED_BY_CLIENT under common
// ad-blockers (uBlock-style). The SW opens the tab in extension-
// origin context, which the blocker treats as legitimate. Section
// anchor read from data-crsmart-help-section so multiple dots can
// deep-link to different sections of help.html.
//
// Uses event delegation on the card root rather than per-button
// listeners. The verdict column gets innerHTML-replaced on every
// patch (rating click, score update) — per-button listeners would
// be lost on the first patch. A delegated handler on the card root
// survives every patch.
function wireHelpDots(card) {
  card.addEventListener('click', ev => {
    const btn = ev.target.closest('button.crsmart-help-dot[data-crsmart-help-section]');
    if (!btn || !card.contains(btn)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (isExtensionContextInvalidated()) {
      showContextInvalidatedBanner();
      return;
    }
    const section = btn.dataset.crsmartHelpSection || '';
    try {
      chrome.runtime.sendMessage({ type: 'crsmart:open-help-tab', section });
    } catch (err) {
      if (/Extension context invalidated/.test(err?.message || '')) {
        showContextInvalidatedBanner();
        return;
      }
      throw err;
    }
  });
}

// Click / Enter / Space on the What-it-is box toggles between the
// 40-word preview and the full synopsis. Updates the text node and
// label in place rather than rebuilding the card so the ring doesn't
// re-animate and the card doesn't flash.
function wireDescriptionToggle(card, descObj, recId) {
  const box = card.querySelector('[data-crsmart-desc-toggle="1"]');
  if (!box) return;
  const textEl = box.querySelector('[data-crsmart-desc-text]');
  const labelEl = box.querySelector('[data-crsmart-desc-label]');
  // Description-expanded state is keyed by aniListId — the rec's
  // stable identity. Title-keyed state could collide across same-
  // titled franchises and would be lost during cold-start when
  // pageTitle() hasn't resolved yet.
  const apply = () => {
    const expanded = recId && STATE.descriptionExpanded.has(recId);
    if (textEl) textEl.textContent = expanded ? descObj.full : descObj.short;
    if (labelEl) labelEl.textContent = expanded ? '▾ less' : '▸ more';
  };
  const toggle = () => {
    if (!recId) return;
    if (STATE.descriptionExpanded.has(recId)) STATE.descriptionExpanded.delete(recId);
    else STATE.descriptionExpanded.add(recId);
    apply();
  };
  box.addEventListener('click', toggle);
  box.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      toggle();
    }
  });
}

// ── Inject / remove ─────────────────────────────────────────────────
function findInsertionPoint() {
  const body = document.querySelector(HERO_BODY);
  if (!body) return null;
  const meta = [...body.children].find(el =>
    typeof el.className === 'string' && el.className.includes(META_WRAPPER_PREFIX));
  return { parent: body, before: meta || null };
}

// CR's key-art lives in [data-t="series-hero-background"], absolutely
// positioned inside the series grid with z-index:-1 (set by CR). We
// promote it to position:fixed so it stays locked behind the page as
// the user scrolls — the key-art becomes a persistent backdrop.
//
// Crucially we do NOT touch z-index: CR's z:-1 keeps it behind all
// in-flow page content (episode list, description rows). Earlier
// attempts that set z-index:0 pushed it above the series logo.
//
// The grid's height is unaffected because the bg was already absolutely-
// positioned (out of flow) — only the in-flow hero-body determines the
// grid's natural height. The series logo and our card live in hero-body,
// so they stay at the right position.
function lockHeroBackgroundHeight() {
  const bg = document.querySelector('[data-t="series-hero-background"]');
  if (!bg) return;
  if (bg.dataset.crsmartHeroLocked === '1') return;
  // Pin to full viewport, fixed. No z-index override — CR's existing
  // z-index:-1 puts it behind all page content automatically.
  bg.style.setProperty('position', 'fixed', 'important');
  bg.style.setProperty('top', '0', 'important');
  bg.style.setProperty('left', '0', 'important');
  bg.style.setProperty('width', '100vw', 'important');
  bg.style.setProperty('height', '100vh', 'important');
  bg.style.setProperty('min-height', '0', 'important');
  bg.style.setProperty('max-height', 'none', 'important');
  bg.style.setProperty('overflow', 'hidden', 'important');
  // Scale ALL <img>s inside the bg. CR uses a two-layer treatment:
  // a blurred low-res backdrop behind a sharp foreground image.
  // Styling only the first img (the blurred one) left the visible
  // sharp layer unscaled — the Image-scale slider appeared to do
  // nothing. Iterate both.
  const imgs = bg.querySelectorAll('img');
  imgs.forEach(img => {
    img.style.setProperty('object-position', '50% 50%', 'important');
    img.style.setProperty('transform', _heroImgTransform(), 'important');
    img.style.setProperty('transform-origin', 'center center', 'important');
  });
  bg.dataset.crsmartHeroLocked = '1';
}

// ── [moved to content-cr-integration.js: hero gradient + CR overlay + meta refresh + context-invalidation] ──


function tryInject() {
  removeCardIfStale();
  if (!STATE.enabled) return;
  const title = pageTitle();
  if (!title) return;
  STATE.currentSeriesTitle = title;
  // Fire CR-meta + AniList enrichment refresh unconditionally on every
  // series-page visit — BEFORE the rec-lookup checks. Cold-start shows
  // (never-cached, never-in-rec-pool) need this to trigger the lazy
  // enrichment path that populates aniListCache + allShowsScored; the
  // storage listener then repaints and renders the card when data
  // lands. Previously this ran AFTER the `if (!hit) return` early
  // exit, which meant a genuinely cold show would silently drop the
  // card with no enrichment trigger — bug caught by Warrior Princess
  // (popular-seed missed it, no prior visit, no card).
  // _requestCrMetaRefresh dedup'd per session on the worker side so
  // firing unconditionally is cheap.
  _requestCrMetaRefresh();
  // CR-seriesId lookup FIRST. The user's CR series ID maps to ONE
  // AniList entry in the cache (whichever season got matched first
  // / most-recently); that entry is the authoritative score for
  // *this* page and carries the off-pool boosts (rewatch / favorite
  // / watchlist / franchise loyalty) that the rec-pool path doesn't.
  //
  // Earlier order (findRec → fallback) was wrong when the rec pool
  // happened to contain a DIFFERENT AL entry whose english title
  // exactly normalized to the page title. Concrete failure: page
  // title "My Hero Academia" matched MHA Season 1 (id 21459, eng
  // "My Hero Academia") in the rec pool — but the user's CR-MHA entry
  // mapped to a later season with averageScore 82, and the off-pool
  // entry would have applied his +0.20 rewatch + ★ favorite boosts.
  // The rec-pool version (S1, avg 77, no boosts) showed 4.9; the
  // off-pool version with boosts shows ~7.9. The mapping by CR id
  // is more authoritative than fuzzy title matching.
  const hit = findRecFromCache(STATE.allShowsScored) || findRec(STATE.recs, title);
  if (!hit) {
    // Zero-data state: user has no taste signal yet (no CR sync, no
    // survey taps, no rec pool). Render a stub card with a CTA that
    // opens Quick Taste Check. Card shows universal info (community
    // avg, franchise meta if available) so the page isn't bare.
    if (hasZeroTasteData()) {
      if (document.getElementById(CARD_ID)) return;
      const slot = findInsertionPoint();
      if (!slot) return;
      if (STATE.heroBgLock) {
        lockHeroBackgroundHeight();
        installHeroGradient();
      }
      const stub = buildZeroDataStubCard(title);
      slot.parent.insertBefore(stub, slot.before);
      return;
    }
    // Cold-start state: user has taste data but this series isn't in
    // the cache yet. _requestCrMetaRefresh fired above; the chain takes
    // ~10–25s on niche shows (AniList title-search + verify + score).
    // Render a loading stub so the page doesn't appear bare during the
    // wait. cardModule._mount removes any card with CARD_ID before
    // inserting the real one, so the stub auto-replaces when data
    // lands. Idempotent: don't reinsert if a loading stub is already
    // mounted for this seriesId.
    const seriesId = currentCrSeriesId();
    const existing = document.getElementById(CARD_ID);
    if (existing?.dataset?.crsmartLoadingFor === seriesId) return;
    if (existing) existing.remove();
    const slot = findInsertionPoint();
    if (!slot) return;
    if (STATE.heroBgLock) {
      lockHeroBackgroundHeight();
      installHeroGradient();
    }
    const stub = buildLoadingStubCard(title, seriesId);
    slot.parent.insertBefore(stub, slot.before);
    _scheduleColdStartRetry(seriesId);
    return;
  }
  // We have a real hit — abort any cold-start retry chain that was
  // running for this page.
  _clearColdStartRetry();
  // Route through the card module — single entry point for mount /
  // patch / rebuild based on aniListId match. The module owns the
  // existence check and slot lookup internally.
  cardModule.update(hit.rec, hit.mode);
}

// True iff the user has neither a real taste vector nor any survey
// taps yet. Drives the zero-data card stub on series pages so a brand-
// new install (no CR sync, no survey) doesn't render an empty card —
// instead it gets a CTA to take the Quick Taste Check.
function hasZeroTasteData() {
  const hasAllShows = STATE.allShowsScored
    && Object.keys(STATE.allShowsScored).length > 0;
  const hasRecs = STATE.recs?.peak?.ranked?.length > 0
    || STATE.recs?.comfort?.ranked?.length > 0;
  return !hasAllShows && !hasRecs;
}

// Stub card for the zero-data state. Renders a dotted-placeholder
// score, a friendly CTA pitch, a "Take 3-min taste check" button, and
// — when AL data is available for the franchise — the universal meta
// line (seasons / eps / years) so the page still has useful context
// while we don't know the user's taste.
function buildZeroDataStubCard(seriesTitle) {
  const card = document.createElement('div');
  card.id = CARD_ID;
  card.className = 'crsmart-card crsmart-card-stub';
  const surveyUrl = chrome.runtime.getURL('survey.html');
  card.innerHTML = `
    <div style="
      display:flex;align-items:center;gap:18px;
      padding:20px 22px;
      background:linear-gradient(180deg, rgba(28,23,20,0.96), rgba(20,16,13,0.96));
      border:1px solid rgba(255,140,40,0.30);
      border-radius:14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.35);
      max-width:${STATE.cardMaxWidth || 760}px;
      margin: 14px 0;
      color:#f5efe8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    ">
      <div style="
        flex:0 0 auto;
        width:64px;height:64px;
        border-radius:50%;
        border:2px dashed rgba(255,140,40,0.55);
        display:flex;align-items:center;justify-content:center;
        font-size:24px;font-weight:700;
        color:rgba(255,140,40,0.85);
      ">?</div>
      <div style="flex:1 1 auto;min-width:0;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
          <span style="
            display:inline-flex;align-items:center;
            padding:4px 12px;
            background:rgba(255,255,255,0.06);
            border:1px solid rgba(255,255,255,0.18);
            color:rgba(245,239,232,0.65);
            border-radius:999px;
            font-size:11.5px;font-weight:600;letter-spacing:0.5px;
          ">NO TASTE DATA YET</span>
          <span style="
            display:inline-flex;align-items:center;
            padding:4px 12px;
            background:rgba(60,200,120,0.12);
            border:1px solid rgba(60,200,120,0.35);
            color:#a5e8be;
            border-radius:999px;
            font-size:11.5px;font-weight:600;letter-spacing:0.5px;
          ">UNIVERSAL INFO ONLY</span>
        </div>
        <div style="font-size:16px;font-weight:600;margin-bottom:4px;color:#fff;">
          We don't know your taste yet.
        </div>
        <div style="font-size:13.5px;color:rgba(245,239,232,0.75);margin-bottom:12px;line-height:1.5;">
          Take a 3-min Quick Taste Check to bootstrap your Smart Scores
          before your CR history fully syncs. Your taps shape what shows
          up here when you visit any series page.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <a href="${surveyUrl}" target="_blank" rel="noopener" style="
            display:inline-flex;align-items:center;gap:6px;
            padding:10px 18px;
            background:#ff8c28;color:#14100d;
            border-radius:8px;
            text-decoration:none;
            font-size:13px;font-weight:600;
            transition: background 120ms ease;
          " onmouseover="this.style.background='#ffa14e'" onmouseout="this.style.background='#ff8c28'">
            Take 3-min taste check →
          </a>
          <span style="
            display:inline-flex;align-items:center;
            padding:10px 14px;
            color:rgba(245,239,232,0.55);
            font-size:12.5px;
            font-style:italic;
          ">or keep watching on Crunchyroll — your history will sync automatically</span>
        </div>
      </div>
    </div>
  `;
  return card;
}

// Cold-start loading stub. User has taste data, but this series isn't
// in the cache yet — _requestCrMetaRefresh is in flight, takes 10–25s
// on niche shows. Without this, the page appears card-less during the
// wait and users assume the extension didn't fire. Auto-replaced by
// cardModule._mount when the real card lands. Marked with a data attr
// so subsequent tryInject calls don't reinsert / flicker.
function buildLoadingStubCard(seriesTitle, seriesId) {
  const card = document.createElement('div');
  card.id = CARD_ID;
  card.className = 'crsmart-card crsmart-card-loading';
  card.dataset.crsmartLoadingFor = seriesId || '';
  card.innerHTML = `
    <div style="
      display:flex;align-items:center;gap:18px;
      padding:18px 22px;
      background:linear-gradient(180deg, rgba(28,23,20,0.92), rgba(20,16,13,0.92));
      border:1px solid rgba(255,140,40,0.20);
      border-radius:14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.30);
      max-width:${STATE.cardMaxWidth || 760}px;
      margin: 14px 0;
      color:#f5efe8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    ">
      <div style="
        flex:0 0 auto;
        width:56px;height:56px;
        border-radius:50%;
        border:2px solid rgba(255,140,40,0.25);
        border-top-color: rgba(255,140,40,0.85);
        animation: crsmart-spin 900ms linear infinite;
      "></div>
      <div style="flex:1 1 auto;min-width:0;">
        <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:4px;">
          Looking up your Smart Score…
        </div>
        <div style="font-size:12.5px;color:rgba(245,239,232,0.65);line-height:1.4;">
          First visit on a niche show — fetching from AniList. Takes ~15s.
        </div>
      </div>
    </div>
    <style>
      @keyframes crsmart-spin { to { transform: rotate(360deg); } }
    </style>
  `;
  return card;
}

function removeCardIfStale() {
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  const title = pageTitle();
  if (title && title !== STATE.currentSeriesTitle) {
    card.remove();
    removeHeroGradient();
    cardModule.currentRec = null;
  }
}

function removeCard() {
  const card = document.getElementById(CARD_ID);
  if (card) card.remove();
  removeHeroGradient();
  cardModule.currentRec = null;
}

// ── Card module ─────────────────────────────────────────────────────
// Stateful seam owning the on-page card's lifecycle: mount, patch,
// rebuild, remove. The render seam.
//
// Lifecycle:
//   update(rec, mode) — single entry point. Dispatches:
//     - no card mounted → mount (full build + insert)
//     - same aniListId → patch (in-place updates per zone)
//     - different aniListId → tear down + remount (new show)
//   remove() — explicit teardown.
//
// Why stateful: the card IS a stateful thing on the page (mounted DOM
// + active listeners on rate buttons / reaction palette / spoiler
// chips / description toggle). Stateless render functions would push
// `prevRec` tracking onto every callsite; concentrating it here is
// what the seam is for.
//
// Migration shape (rolling out across multiple commits):
//   C1 (this commit): stateful seam wired in; patch path just
//     rebuilds. Zero behavior change. Foundation only.
//   C2: convert score-ring / tier / headline / pitch zones to
//     in-place patches. Rating clicks become flicker-free.
//   C3: convert rationale-chips / affinity-rows / math-row zones.
//     Recompute waves become coherent single renders.
// First-time coach mark on the Smart Score card. Mirrors the logic
// in coach-marks.js (used by sidepanel.js as an ES module). Inlined
// here because content.js is a classic content script and can't
// easily import modules. Keyed under chrome.storage.local.coachMarksSeen
// so the side-panel marks and this one share state — once dismissed
// anywhere, all surfaces stay quiet.
//
// In-memory short-circuit: once we've shown OR confirmed-seen this
// session, skip the storage round-trip on subsequent card mounts.
// SPA navigation re-fires _mount frequently; without this we'd hit
// storage every series-page change.
let _smartScoreCoachMarkResolved = false;
const SMART_SCORE_COACH_CLASS = 'crsmart-coach-mark--card';
function showSmartScoreCardCoachMarkOnce(cardEl) {
  if (!cardEl) return;
  // Slot-claim: take the resolved flag SYNCHRONOUSLY at the top so a
  // second concurrent _mount call (SPA can fire mount twice in quick
  // succession on series-page navigation) sees the flag and bails
  // before its async storage read returns. Without this, both mounts
  // pass the seen-check and append a duplicate coach mark — that's
  // the "two box" bug. If storage later says "already seen," the
  // claim is harmless: the flag was true anyway. If storage hasn't
  // been written yet, the mark below is the one that gets shown and
  // it writes the flag on dismiss.
  if (_smartScoreCoachMarkResolved) {
    // Idempotent cleanup: remove any stale mark that's still in the
    // DOM from a previous SPA-mount (CR's React unmounts series-page
    // contents, but our coach mark is on document.body and survives).
    // Without this, navigating series→series would leave the old mark
    // floating where the OLD card used to be.
    document.querySelectorAll(`.${SMART_SCORE_COACH_CLASS}`).forEach(n => n.remove());
    return;
  }
  if (!chrome?.runtime?.id) {
    _smartScoreCoachMarkResolved = true;
    return;
  }
  // Defensive: clear any lingering mark from a prior session before
  // we paint a new one.
  document.querySelectorAll(`.${SMART_SCORE_COACH_CLASS}`).forEach(n => n.remove());
  // Claim the slot now — see comment above.
  _smartScoreCoachMarkResolved = true;

  const KEY = 'smart-score-card';
  let storagePromise;
  try {
    storagePromise = chrome.storage.local.get('coachMarksSeen');
  } catch (err) {
    return;
  }
  storagePromise.then(stored => {
    const seen = stored?.coachMarksSeen || {};
    if (seen[KEY]) return;  // user already dismissed in a prior session
    const tip = document.createElement('div');
    tip.className = `crsmart-coach-mark ${SMART_SCORE_COACH_CLASS}`;
    tip.setAttribute('role', 'tooltip');
    Object.assign(tip.style, {
      position: 'absolute',
      maxWidth: '260px',
      padding: '12px 14px',
      background: '#1c1916',
      color: '#f0e8df',
      border: '1px solid rgba(255,140,40,0.4)',
      borderRadius: '10px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '13px',
      lineHeight: '1.45',
      zIndex: '2147483640',
    });
    tip.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">
        <strong style="color:#ff8c28;font-size:12px;letter-spacing:0.4px;">Smart Score</strong>
        <span>This score and tier (TRUST ME / STRETCH / WORTH A SHOT) say whether the show is for you. The chips below are the specific reasons.</span>
      </div>
      <button type="button" style="background:rgba(255,140,40,0.15);color:#ff8c28;border:1px solid rgba(255,140,40,0.4);border-radius:6px;padding:4px 10px;font-family:inherit;font-size:12px;cursor:pointer;">Got it</button>
    `;
    // Append first so the tip has measurable layout, then position.
    // requestAnimationFrame defers the read to after layout has
    // settled — fixes the "tip painted at top-left of viewport"
    // race where the card hadn't laid out when getBoundingClientRect
    // ran on the synchronous append path.
    document.body.appendChild(tip);
    requestAnimationFrame(() => {
      const rect = cardEl.getBoundingClientRect();
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
      const margin = 8;
      const tipWidth = tip.offsetWidth || 260;
      const viewportWidth = document.documentElement.clientWidth;
      // Prefer right side; fall back to below if the right side would
      // overflow the viewport (narrow window or card already at edge).
      const fitsRight = rect.right + margin + tipWidth <= viewportWidth;
      if (fitsRight) {
        tip.style.left = `${rect.right + scrollX + margin}px`;
        tip.style.top = `${rect.top + scrollY}px`;
      } else {
        tip.style.left = `${Math.max(8, rect.left + scrollX)}px`;
        tip.style.top = `${rect.bottom + scrollY + margin}px`;
      }
    });
    const dismiss = () => {
      tip.remove();
      try {
        chrome.storage.local.set({ coachMarksSeen: { ...seen, [KEY]: true } }).catch(() => {});
      } catch {}
      document.removeEventListener('click', onDocClick, true);
    };
    const onDocClick = () => dismiss();
    tip.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });
    setTimeout(() => document.addEventListener('click', onDocClick, true), 80);
  }).catch(() => {});
}

const cardModule = {
  // Last rec we rendered against. Used by the patch path to decide
  // mount-vs-patch-vs-rebuild on the next update().
  currentRec: null,

  update(rec, mode) {
    if (!rec) { this.remove(); return; }
    const existing = document.getElementById(CARD_ID);
    const sameShow = existing
      && this.currentRec
      && this.currentRec.aniListId === rec.aniListId;
    if (sameShow) {
      this._patch(rec, mode, existing);
    } else {
      this._mount(rec, mode);
    }
    this.currentRec = rec;
  },

  remove() {
    const card = document.getElementById(CARD_ID);
    if (card) card.remove();
    removeHeroGradient();
    this.currentRec = null;
  },

  _mount(rec, mode) {
    const stale = document.getElementById(CARD_ID);
    if (stale) stale.remove();
    const slot = findInsertionPoint();
    if (!slot) return;
    if (STATE.heroBgLock) {
      lockHeroBackgroundHeight();
      installHeroGradient();
    }
    const card = buildCard(rec, mode);
    slot.parent.insertBefore(card, slot.before);
    // First-encounter coach mark on the Smart Score card. Inlined
    // (rather than imported from coach-marks.js) because content.js
    // is a classic content script, not an ES module — sidepanel.js
    // uses the module path. Logic is identical.
    showSmartScoreCardCoachMarkOnce(card);
  },

  // C2 patch path: in-place updates for high-frequency zones (score
  // ring + score number + tier chip + headline + pitch). Other zones
  // (rationale chips, affinity rows, math row) still trigger a full
  // rebuild — C3 will convert those.
  //
  // Why this set first: rating-click feedback is the highest-frequency
  // user action and the most visible flicker source. Patching these
  // four zones makes 👍/👎 feel instant; the deeper zones aren't
  // updated by rating clicks anyway (they only change on full
  // recompute).
  _patch(rec, mode, existing) {
    // Detect "deep zone" changes that require a full rebuild — for
    // now any change to topTags / topAntiTags / subScores / genres
    // means the chip rows or math row would need updating, which C3
    // hasn't built yet. Falling back to full rebuild keeps those
    // zones correct until C3 lands.
    const prev = this.currentRec || {};
    const deepZoneChanged =
      !equalShallowArray(prev.topTags, rec.topTags) ||
      !equalShallowArray(prev.topAntiTags, rec.topAntiTags) ||
      !equalShallow(prev.subScores, rec.subScores) ||
      !equalShallowArray(prev.genres, rec.genres);
    if (deepZoneChanged) {
      this._mount(rec, mode);
      return;
    }
    // Verdict-zone-only change (score / tier / headline / pitch).
    // Patch in place, listeners stay attached.
    const finalScore = rec.finalScore ?? 0;
    const score10 = (finalScore * 10).toFixed(1);
    const score100 = Math.round(finalScore * 100);
    const tier = tierFor(finalScore);
    const ringDims = ringDimsFor(tier.name);
    const c = REFERENCE_RING_CIRCUMFERENCE;
    const offset = c * (1 - score100 / 100);

    // Score number text.
    const scoreText = existing.querySelector('[data-crsmart-zone="score-text"]');
    if (scoreText) {
      scoreText.textContent = score10;
      // Tier change → font-size shifts. CSS transition on the element
      // tweens the change instead of snapping.
      scoreText.style.fontSize = `${ringDims.fontSize}px`;
    }
    const scoreAnchor = existing.querySelector('[data-crsmart-zone="score-anchor"]');
    if (scoreAnchor) scoreAnchor.style.fontSize = `${ringDims.anchorSize}px`;
    // Wrapper width/height: tier change tweens these via CSS
    // transition. Same approach as font-size above — the SVG itself
    // stays at the reference viewBox; the wrapper's CSS size scales it.
    const wrapper = existing.querySelector('[data-crsmart-zone="score-ring-wrapper"]');
    if (wrapper) {
      wrapper.style.width = `${ringDims.size}px`;
      wrapper.style.height = `${ringDims.size}px`;
    }

    // Score ring fill — patch the stroke-dashoffset (the ring's
    // visible fraction). Math is tier-invariant now (fixed viewBox).
    // Clear any pending animation class so the ring snaps to the
    // new position rather than animating from the previous offset.
    const ringFill = existing.querySelector('[data-crsmart-zone="score-ring-fill"]');
    if (ringFill) {
      ringFill.classList.remove('crsmart-ring-anim');
      ringFill.setAttribute('stroke-dashoffset', offset.toFixed(2));
      ringFill.style.setProperty('--ring-to', offset.toFixed(2));
    }

    // Verdict column (tier chip + dealbreaker + rating-override +
    // quality chips + headline + commit line + pitch). No wired
    // listeners inside this column, so innerHTML replacement is safe.
    // verdictColumnHtml is the single source of truth — it owns which
    // chip types render, so the patch path can't silently skip
    // dealbreaker / rating-override the way it used to.
    const column = existing.querySelector('[data-crsmart-zone="verdict-column"]');
    if (column) column.innerHTML = verdictColumnHtml(rec, tier);
  },
};

// ── [moved to content-cr-integration.js: shallow-equal helpers + scheduler + cardStaleness + loadInitial + watchStorage + watchSyncBroadcast + async init IIFE] ──
