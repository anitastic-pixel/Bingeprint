// content-feedback.js
// ───────────────────────────────────────────────────────────────────
// Feedback UI: reactions palette + vibe chip interactions +
// rate-buttons + reactions data tables (one of three split content
// scripts). Sibling files: content-card.js, content-cr-integration.js.
//
// Cross-file references (e.g. escapeHtml, pill, STATE) resolve at
// runtime via shared realm scope — see content-card.js header for
// the full mechanism. No top-level code here invokes functions
// from the other two split files.
//
// Reaction-tag taxonomy is loaded from reaction-data.js (single source
// shared with the engine in reactions.js). reaction-data.js must be
// listed before this file in the manifest so __REACTION_DATA exists
// by the time we read it.
// ───────────────────────────────────────────────────────────────────

// Reaction-tag taxonomy comes from reaction-data.js, loaded as a
// classic content script ahead of this one (see manifest). The data
// file sets globalThis.__REACTION_DATA — that's the single source of
// truth shared with reactions.js (engine side, ESM import). Subgroup
// is a property of each chip; no parallel mapping table here anymore.
const _RD = globalThis.__REACTION_DATA;
if (!_RD) {
  console.error('[crsmart] reaction-data.js not loaded — check manifest content_scripts order');
}
const CURATED_REACTIONS = _RD?.CURATED_REACTIONS || [];
const EXTRA_REACTIONS   = _RD?.EXTRA_REACTIONS   || [];
const REACTION_TAGS     = _RD?.REACTION_TAGS     || [];
const REACTION_GROUPS   = _RD?.REACTION_GROUPS   || [];
const REACTION_SUBGROUPS = _RD?.REACTION_SUBGROUPS || {};
const MOOD_COMBOS       = _RD?.MOOD_COMBOS       || { pos: [], neg: [], neu: [] };
const REACTION_AXES     = _RD?.REACTION_AXES     || [];
const REACTION_BY_KEY   = Object.fromEntries(REACTION_TAGS.map(t => [t.key, t]));

// ── Precomputed render indexes ──────────────────────────────────────
// Renders run on every chip click, combo click, slider click, and
// (when search is active) every keystroke. The renderer originally
// did 6+ `REACTION_TAGS.filter(...)` scans per render and `hexToRgb`
// per chip — cheap individually, but a held key in the smart-search
// triggered enough renders that the cumulative cost was real. Compute
// the answers once at module load and look them up by key.
const CHIPS_BY_GROUP_POLARITY = (() => {
  const m = Object.create(null);
  for (const c of REACTION_TAGS) {
    const k = c.group + ':' + c.polarity;
    (m[k] || (m[k] = [])).push(c);
  }
  return m;
})();
const POLARITY_TOTALS = (() => {
  const m = Object.create(null);
  for (const [k, arr] of Object.entries(CHIPS_BY_GROUP_POLARITY)) m[k] = arr.length;
  return m;
})();
// Subgroup counts: group:polarity:subgroup → count. Saves the per-
// expanded-group tally loop in expandedGroupHtml.
const SUBGROUP_COUNTS_BY_POLARITY = (() => {
  const m = Object.create(null);
  for (const c of REACTION_TAGS) {
    const k = c.group + ':' + c.polarity + ':' + (c.subgroup || '_');
    m[k] = (m[k] || 0) + 1;
  }
  return m;
})();

// Per-group glyph + accent color. The emoji is the primary scanning cue
// (works for colorblind users, self-documenting before the palette
// becomes familiar) and appears both in group headers and as a leading
// prefix on every chip — crucial for the Suggested row, where chips from
// different groups are mixed and positional context can't tell you which
// residue a chip addresses. Color is used on the chip border at low
// opacity so the group read is visible without fighting the rating
// accent that takes over on selection. Picked for dark-theme legibility
// and intentionally desaturated.
const REACTION_GROUP_VISUALS = {
  feeling:  { emoji: '💗', color: '#e58aa3' }, // rose    — emotional residue
  pacing:   { emoji: '⏱',  color: '#d9a66c' }, // amber   — rhythm/time
  craft:    { emoji: '🎨', color: '#b18ce8' }, // violet  — visuals/sound
  cast:     { emoji: '🎭', color: '#6bc9bf' }, // teal    — performance
  story:    { emoji: '📖', color: '#7fa3e0' }, // slate   — narrative
  takeaway: { emoji: '🎯', color: '#a3d07a' }, // lime    — outcome
};

// Precompute the "r,g,b" string for each group color so the renderer
// doesn't re-parse a hex string per chip per render. Saves ~50
// parseInt calls per render when the chip palette is expanded.
// Fallback string matches the inline default used by chipHtml's `|| ...`.
const GROUP_RGB = (() => {
  const m = Object.create(null);
  for (const [gid, v] of Object.entries(REACTION_GROUP_VISUALS)) {
    m[gid] = hexToRgb(v.color);
  }
  m._fallback = hexToRgb('#8a8a8a');
  return m;
})();

// Subgroup is baked into each chip by the data generator. Fallback to
// the first subgroup of the chip's group keeps render safe if the data
// file ever ships a chip without one — but the generator's validation
// step exits non-zero in that case, so it shouldn't reach prod.
function getReactionSubgroup(chip) {
  return chip.subgroup || REACTION_SUBGROUPS[chip.group]?.[0]?.id || null;
}

// ── Reaction search lexicon ─────────────────────────────────────────
// Mirrors the Vibe Today search bar (sidepanel.js + vibe-tags.js): an
// inverted word→chips index used by the search dropdown to surface
// reasons by synonym, not just literal label substring. Lets the user
// type "cry" and find {wrecked-me, cathartic, sweet-sorrow} even though
// none of those labels contain "cry" — each chip's keywords:[] list
// already names the synonyms we want.
//
// Each lexicon entry: word (lowercased) → [{ chipKey, source }]
//   source = 'label'   (word came from a chip's display label)
//          | 'keyword' (word came from the chip's keywords:[] field)
// Labels beat keywords on tie because matching what the user can SEE
// on the chip is the higher-confidence signal.
// Function words that shouldn't seed lexicon entries on their own — they
// appear in many labels but carry no search intent. Without this filter,
// typing "the" or "me" returns a meaningless 15-chip cloud. Keywords
// stay verbatim regardless (they're curated, so 'mean spirited' stays
// one entry rather than 'mean' + 'spirited').
const REACTION_LABEL_STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'so', 'as', 'at', 'by',
  'for', 'in', 'of', 'on', 'to', 'up', 'with',
  'is', 'it', 'its', 'be', 'was', 'were', 'are',
  'i', 'me', 'my', 'we', 'us', 'our',
  'you', 'your', 'he', 'she', 'they', 'them', 'their',
  'the', 'this', 'that', 'these', 'those',
  'too', 'very', 'just', 'felt', 'feel',
  'into', 'over', 'than', 'then', 'when', 'where', 'how',
  'made', 'make', 'makes', 'making',
  'did', 'do', 'does', 'done', 'didnt', 'wasnt', 'isnt',
  'not', 'no',
]);

const REACTION_LEXICON = (() => {
  const map = new Map();
  const PRIORITY = { label: 3, keyword: 2 };
  const add = (rawWord, chipKey, source) => {
    const w = String(rawWord || '').toLowerCase().trim();
    if (!w || w.length < 2) return;
    if (source === 'label' && REACTION_LABEL_STOPWORDS.has(w)) return;
    let entry = map.get(w);
    if (!entry) { entry = []; map.set(w, entry); }
    const existing = entry.find(e => e.chipKey === chipKey);
    if (existing) {
      if (PRIORITY[source] > PRIORITY[existing.source]) existing.source = source;
      return;
    }
    entry.push({ chipKey, source });
  };
  // Split labels on whitespace + slash + dash so multi-word labels like
  // "killer OP/ED" yield {killer, op, ed} entries. Keywords stay verbatim
  // (curated phrasings like "mean spirited" should match as one unit).
  for (const chip of REACTION_TAGS) {
    const labelWords = String(chip.label || '').toLowerCase().split(/[\s/-]+/);
    for (const w of labelWords) add(w, chip.key, 'label');
    for (const kw of (chip.keywords || [])) add(kw, chip.key, 'keyword');
  }
  return map;
})();
const REACTION_LEXICON_WORDS = Array.from(REACTION_LEXICON.keys()).sort();

// Tier-ranked search. Returns:
//   Array<{ word, chips: [chip, ...], tier, truncated }>
// Tier order: exact, label-prefix, keyword-prefix, substring. Each result
// is filtered to chips matching the current polarity so a 👎 query
// doesn't surface "wrecked me" or any other pos chip.
function searchReactionLexicon(query, polarity, opts = {}) {
  const MAX_RESULTS = opts.maxResults || 8;
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];

  const exact = [], labelPrefix = [], keywordPrefix = [], substring = [];
  for (const word of REACTION_LEXICON_WORDS) {
    const entries = REACTION_LEXICON.get(word);
    const isLabel = entries.some(e => e.source === 'label');
    if (word === q) exact.push(word);
    else if (word.startsWith(q)) (isLabel ? labelPrefix : keywordPrefix).push(word);
    else if (word.includes(q)) substring.push(word);
  }

  const tiered = [
    ...exact.map(w => ({ word: w, tier: 'exact' })),
    ...labelPrefix.map(w => ({ word: w, tier: 'label-prefix' })),
    ...keywordPrefix.map(w => ({ word: w, tier: 'keyword-prefix' })),
    ...substring.map(w => ({ word: w, tier: 'substring' })),
  ];

  const out = [];
  for (const { word, tier } of tiered) {
    const entries = REACTION_LEXICON.get(word);
    const seen = new Set();
    const chips = [];
    for (const e of entries) {
      if (seen.has(e.chipKey)) continue;
      seen.add(e.chipKey);
      const chip = REACTION_BY_KEY[e.chipKey];
      if (!chip || chip.polarity !== polarity) continue;
      chips.push(chip);
    }
    if (!chips.length) continue;
    out.push({ word, chips: chips.slice(0, 3), tier, truncated: chips.length > 3 });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// Levenshtein-distance-1 fallback for the no-match path. Returns a word
// from the lexicon if it's within one edit of the query, else null.
// Prevents the "typed a single typo and got zero results" cliff.
function suggestReactionWord(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q || q.length < 3 || REACTION_LEXICON.has(q)) return null;
  let best = null, bestDist = 2;
  for (const word of REACTION_LEXICON_WORDS) {
    if (Math.abs(word.length - q.length) > 1) continue;
    const d = _levAtMost(q, word, 1);
    if (d !== null && d < bestDist) { bestDist = d; best = word; }
  }
  return best;
}

// Levenshtein with an early-exit cap: returns the distance if ≤ max,
// else null. Linear-space DP, sufficient for our short lexicon words.
function _levAtMost(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const curr = new Array(lb + 1);
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return null;
    prev = curr;
  }
  return prev[lb] <= max ? prev[lb] : null;
}

// ── [other functions live in content-card.js — STATE, season helpers, scoring, card builder, etc.] ──

// ── Rate buttons ────────────────────────────────────────────────────
// Persists to chrome.storage.local.userRatings keyed by AniList ID. The
// side panel hides 👎 entries so the engine "learns" to back off from
// rejected recs without us touching the rank pipeline.
//
// Rating values are the persisted storage format — '+1' | '0' | '-1' —
// shared across the whole codebase (sidepanel, taste pipeline, etc.).
// We don't rename them; we just route every reference inside this file
// through these constants + polarityOf() so a typo in one place can't
// silently break the polarity flip on the reactions palette.
const RATING = Object.freeze({ NEG: '-1', NEU: '0', POS: '+1' });

// 'pos' | 'neu' | 'neg' — the key the chip taxonomy is indexed on.
// Returns null for unrated (e.g. when a button is tapped to clear).
function polarityOf(rating) {
  if (rating === RATING.POS) return 'pos';
  if (rating === RATING.NEU) return 'neu';
  if (rating === RATING.NEG) return 'neg';
  return null;
}

const RATING_BUTTONS = [
  { value: RATING.NEG, label: '👎', title: 'Not for me — hide from picks' },
  { value: RATING.NEU, label: '😐', title: 'Meh — keep visible' },
  { value: RATING.POS, label: '👍', title: 'Loved it — boost' },
];

// Returns just the button group — the banner around it (with the
// headline + helper text) lives in buildCard so the rate panel reads
// as a deliberate CTA section, not a labeled inline strip.
function renderRateButtons(rec) {
  const current = STATE.ratings[rec.aniListId] ?? null;
  return `
    <div data-crsmart-rate="${rec.aniListId}" style="display:inline-flex;gap:8px;">
      ${RATING_BUTTONS.map(b => {
        const active = current === b.value;
        const accent = RATING_ACCENT[b.value] || COLOR.affinity;
        const accentRgb = hexToRgb(accent);
        return `
          <button type="button"
            data-rate="${b.value}"
            title="${escapeHtml(b.title)}"
            style="
              cursor:pointer;
              background:${active ? `rgba(${accentRgb},0.22)` : 'rgba(255,255,255,0.06)'};
              border:1px solid ${active ? accent : 'rgba(255,255,255,0.14)'};
              color:${active ? accent : '#fff'};
              border-radius:10px;
              padding:9px 18px;
              font-size:20px;line-height:1;
              transition:background 0.12s, border-color 0.12s, color 0.12s, transform 0.08s;
              box-shadow:${active ? `0 0 0 3px rgba(${accentRgb},0.14)` : 'none'};
            ">${b.label}</button>`;
      }).join('')}
    </div>`;
}

function wireRateButtons(card, rec) {
  const wrap = card.querySelector(`[data-crsmart-rate="${rec.aniListId}"]`);
  if (!wrap) return;
  wrap.addEventListener('click', async ev => {
    const btn = ev.target.closest('button[data-rate]');
    if (!btn) return;
    // Defensive check: if the extension has been reloaded /
    // auto-updated since this content script loaded, chrome.* calls
    // will throw silently. Surface a banner the user can act on
    // before they keep clicking buttons that won't work.
    if (isExtensionContextInvalidated()) {
      showContextInvalidatedBanner();
      return;
    }
    const value = btn.dataset.rate;
    const prev = STATE.ratings[rec.aniListId] ?? null;
    // Tap again to clear — gives the user an undo without a separate button.
    const next = prev === value ? null : value;
    if (next == null) delete STATE.ratings[rec.aniListId];
    else STATE.ratings[rec.aniListId] = next;
    // Polarity flip (👍 → 👎 etc.) — clear UI state that's bound to the
    // old polarity: expanded groups and subgroup filters describe a
    // navigation through the prior chip set. Keep the search query
    // though — words like "music" or "pacing" are user intent that
    // translates across polarities, and forcing the user to retype
    // after every rating tweak felt mean. The dropdown will recompute
    // against the new polarity on the next keystroke.
    if (prev !== next) {
      delete STATE.reactionGroupsExpanded[rec.aniListId];
      delete STATE.reactionSubgroupFilter[rec.aniListId];
      delete STATE.reactionSearchDropdown[rec.aniListId];
      delete STATE.reactionShuffledSuggestions[rec.aniListId];
    }
    try {
      await chrome.storage.local.set({ [RATINGS_KEY]: STATE.ratings });
    } catch (err) {
      // Most common cause: extension reloaded mid-session. Surface
      // the banner so the user knows to refresh instead of guessing
      // why their click didn't work.
      if (String(err).includes('Extension context invalidated')
          || isExtensionContextInvalidated()) {
        showContextInvalidatedBanner();
      } else {
        console.warn('[crsmart] save rating failed', err);
      }
      return;
    }
    // Mark rating-pending so the score-text pulses and rate buttons
    // disable until the worker's debounced recompute lands ~1.4s later.
    // Bypasses the user-confusion gap where the button highlight
    // changes but the score doesn't move.
    STATE.ratingPending = rec.aniListId;
    const cardEl = document.getElementById(CARD_ID);
    if (cardEl) cardEl.dataset.crsmartRatingPending = '1';
    // Safety net: if the worker hangs or storage event never lands,
    // force-clear after 10s so the UI doesn't stay stuck. Storage
    // listener clears earlier in the typical case.
    if (STATE._ratingPendingTimer) clearTimeout(STATE._ratingPendingTimer);
    STATE._ratingPendingTimer = setTimeout(() => {
      if (STATE.ratingPending === rec.aniListId) {
        STATE.ratingPending = null;
        const c = document.getElementById(CARD_ID);
        if (c) delete c.dataset.crsmartRatingPending;
      }
      STATE._ratingPendingTimer = null;
    }, 10000);
    // Re-paint just the button strip in place. `wrap` IS the
    // [data-crsmart-rate] element; its parent is the rate banner,
    // so replace wrap itself — replacing its parent would wipe the
    // banner headline.
    const fresh = renderRateButtons(rec);
    const tmp = document.createElement('div');
    tmp.innerHTML = fresh;
    wrap.replaceWith(tmp.firstElementChild);
    // Re-wire on the new node.
    const activeCard = document.getElementById(CARD_ID) || card;
    wireRateButtons(activeCard, rec);
    // Rating polarity flips the palette (neg chips ↔ pos chips), so
    // repaint that too. Rating cleared → palette hides itself (the
    // render returns '' when no rating exists).
    const palette = activeCard.querySelector(
      `[data-crsmart-reactions="${rec.aniListId}"]`);
    const freshPal = renderReactionPalette(rec);
    if (palette) {
      if (!freshPal) {
        palette.remove();
      } else {
        const pTmp = document.createElement('div');
        pTmp.innerHTML = freshPal;
        const next = pTmp.firstElementChild;
        if (next) {
          palette.replaceWith(next);
          wireReactionPalette(activeCard, rec);
        }
      }
    } else if (freshPal) {
      // No existing palette node (first rating on a fresh card) — inject
      // it into the rate banner so the chips are immediately available.
      const banner = activeCard.querySelector(`[data-crsmart-rate="${rec.aniListId}"]`)
        ?.closest('div[style*="rgba(255,140,40,0.06)"]');
      if (banner) {
        const pTmp = document.createElement('div');
        pTmp.innerHTML = freshPal;
        const next = pTmp.firstElementChild;
        if (next) {
          banner.appendChild(next);
          wireReactionPalette(activeCard, rec);
        }
      }
    }
  });
}

// ── Reaction tags ───────────────────────────────────────────────────
// Collapsed "tell me more ↗" pill under the rate strip — only reveals
// after a rating exists (positive or negative). Polarity of the shown
// palette follows the rating: 👎/😐 get the 5 negative chips ("why
// didn't it land?"), 👍 gets the 5 positive chips ("what made it
// click?"). Multi-select; tap a chip to toggle.
//
// Ring and rank updates ride the existing storage.onChanged pipeline
// — content.js doesn't need to recompute anything itself.

function reactionsForRating(rating) {
  const p = polarityOf(rating);
  return p ? REACTION_TAGS.filter(t => t.polarity === p) : [];
}

function reactionPrompt(rating) {
  if (rating === RATING.POS) return 'what stuck with you?';
  if (rating === RATING.NEG) return "what didn't work?";
  if (rating === RATING.NEU) return 'what kept it from landing?';
  return null;
}

// Accent color for each rating — drives both the rate-button styling
// and the reaction-palette chips so the two read as one feedback pipe.
// Red/amber/green is the universally-legible valence triad; muted so
// they don't compete with the card's orange affinity accent.
const RATING_ACCENT = {
  [RATING.NEG]: '#e85d6b', // muted red
  [RATING.NEU]: '#f0b74d', // muted amber
  [RATING.POS]: '#56c270', // muted green
};

// Short human-readable reminder shown next to the "tell me more" pill
// when this show already has reactions saved — so the user knows the
// engine already has feedback for this title without opening the panel.
function reactionsSavedSummary(rec) {
  const entry = STATE.reactions[rec.aniListId];
  const tags = entry?.tags || [];
  if (!tags.length) return null;
  const n = tags.length;
  return `${n} reaction${n === 1 ? '' : 's'} saved`;
}

// Tokenize a string into lowercase word tokens, dropping punctuation
// and very short words that would match everything ("of", "a"). Kept
// local because the context-suggestion scorer is the only caller.
function tokenizeContext(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3);
}

// Memoized facade around getContextSuggestions. The underlying result
// is deterministic per (show, polarity) — same genres + topTags +
// stable hash tie-break → same chips, every render. The renderer used
// to call this fresh on every chip click / combo tap / slider drag,
// scanning 284 chips + tokenizing genres + tags each time. Cache the
// top-8 result keyed by aniListId+polarity and let callers slice to
// their needed n. Polarity flip generates a new key, so flipping
// 👍→👎 naturally recomputes without explicit invalidation.
function getContextSuggestionsCached(rec, polarity, n) {
  if (!rec || !polarity) return [];
  const key = rec.aniListId + ':' + polarity;
  let cached = STATE.reactionContextCache[key];
  if (!cached) {
    cached = getContextSuggestions(rec, polarity, 8);
    STATE.reactionContextCache[key] = cached;
  }
  return cached.slice(0, n);
}

// Context suggestion: chips whose keywords/label overlap with the show's
// genres + top matched tags. Only pulls from EXTRA_REACTIONS — curated
// chips are always visible, so surfacing them again adds no value.
// Score: +2 per exact keyword match, +1 per label substring match.
// Ties break by a stable per-chip hash, NOT by Math.random() — random
// tie-break caused the Suggested row to visibly reshuffle on every
// repaint (every keystroke, every selection, every hover). The hash
// gives stable order within a session while different shows still
// see different orderings.
function getContextSuggestions(rec, polarity, n) {
  if (!rec) return [];
  const tokens = new Set([
    ...(rec.genres || []).flatMap(tokenizeContext),
    ...((rec.topTags || []).flatMap(t => tokenizeContext(t.tag))),
  ]);
  if (!tokens.size) return [];
  const scored = [];
  for (const chip of EXTRA_REACTIONS) {
    if (chip.polarity !== polarity) continue;
    let score = 0;
    const label = chip.label.toLowerCase();
    const keywords = (chip.keywords || []).map(k => k.toLowerCase());
    for (const tok of tokens) {
      if (keywords.includes(tok)) score += 2;
      else if (label.includes(tok)) score += 1;
    }
    if (score > 0) scored.push({ key: chip.key, score, tieBreak: _stableHash(chip.key) });
  }
  scored.sort((a, b) => b.score - a.score || a.tieBreak - b.tieBreak);
  return scored.slice(0, n).map(x => x.key);
}

// djb2 — stable per-key tie-breaker for Suggested ordering. Output is
// signed-int and only used for relative comparison, so we don't care
// about overflow.
function _stableHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

// Recency/frequency: top chips the user has selected across all shows,
// filtered to the current polarity so pos/neg histories don't bleed into
// each other. Sort by count desc, lastUsed desc. Excludes keys already
// surfaced by context so the row doesn't duplicate itself.
function getRecencyPins(polarity, n, excludeKeys) {
  const stats = STATE.reactionStats || {};
  const excl = excludeKeys instanceof Set ? excludeKeys : new Set(excludeKeys || []);
  const entries = [];
  for (const [key, s] of Object.entries(stats)) {
    if (excl.has(key)) continue;
    const chip = REACTION_BY_KEY[key];
    if (!chip || chip.polarity !== polarity) continue;
    entries.push({ key, count: s?.count || 0, lastUsed: s?.lastUsed || 0 });
  }
  entries.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
  return entries.slice(0, n).map(e => e.key);
}

// Build the chip set rendered in the inline body — only for groups the
// user has actively expanded via the group-pills row. The smart-search
// dropdown is the discovery surface; this just shows what the user has
// asked to browse. Selected chips in *unexpanded* groups still appear,
// pinned into their group's bucket so the user always has a path to
// deselect them (the pill renders a "N selected" badge to point them
// there).
function buildReactionPalette(rec, rating) {
  const polarity = polarityOf(rating);
  const selected = new Set(STATE.reactions[rec.aniListId]?.tags || []);
  const expandedGroups = STATE.reactionGroupsExpanded[rec.aniListId] || new Set();
  const subgroupFilter = STATE.reactionSubgroupFilter[rec.aniListId] || {};

  const byGroup = {};
  REACTION_GROUPS.forEach(g => { byGroup[g.id] = []; });
  const pushUnique = (groupId, tag) => {
    const bucket = byGroup[groupId];
    if (bucket && !bucket.some(x => x.key === tag.key)) bucket.push(tag);
  };

  expandedGroups.forEach(gid => {
    const activeSub = subgroupFilter[gid] || null;
    const bucket = CHIPS_BY_GROUP_POLARITY[gid + ':' + polarity] || [];
    for (const t of bucket) {
      if (activeSub && getReactionSubgroup(t) !== activeSub) continue;
      pushUnique(gid, t);
    }
  });

  // Pin selected chips so the user can always deselect — even ones in
  // groups they've collapsed (or that don't match the current subgroup
  // filter). They render in their owning group's bucket; if the group
  // isn't expanded, the group's render path won't show the bucket, so
  // we surface them via the pill's "N selected" badge instead.
  selected.forEach(key => {
    const t = REACTION_BY_KEY[key];
    if (t) pushUnique(t.group, t);
  });

  return byGroup;
}

function renderReactionPalette(rec) {
  const rating = STATE.ratings[rec.aniListId] ?? null;
  if (!rating) return ''; // palette is gated on having rated

  const expanded = STATE.reactionsExpanded.has(rec.aniListId);
  const entry = STATE.reactions[rec.aniListId];
  const selected = new Set(entry?.tags || []);
  const savedSummary = reactionsSavedSummary(rec);
  const prompt = reactionPrompt(rating);
  const justSaved = STATE.reactionsJustSaved.has(rec.aniListId);

  // Collapsed pill — small, quiet, discoverable without clamoring.
  const collapsedPill = `
    <button type="button" data-crsmart-reactions-toggle
      style="
        cursor:pointer;background:transparent;
        border:1px dashed rgba(255,255,255,0.18);
        color:rgba(255,255,255,0.70);
        padding:6px 12px;border-radius:999px;
        font-size:11.5px;line-height:1.2;letter-spacing:0.2px;
        display:inline-flex;align-items:center;gap:6px;
        transition:background 0.12s, border-color 0.12s, color 0.12s;
      ">
      <span>${expanded ? '▾' : '▸'}</span>
      <span>tell me more</span>
      ${savedSummary ? `<span style="opacity:0.55;">· ${escapeHtml(savedSummary)}</span>` : ''}
    </button>
  `;

  if (!expanded) {
    return `
      <div data-crsmart-reactions="${rec.aniListId}" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 4px;">
        ${collapsedPill}
        ${justSaved ? `<span style="font-size:11.5px;color:${COLOR.affinity};opacity:0.85;">got it — we'll factor this in</span>` : ''}
      </div>`;
  }

  // Expanded: prompt + smart-search panel + suggested row + group-pills
  // row + inline-expanded groups. Selected chips pick up the rating's
  // accent color (red/amber/green) so the palette inherits the verdict
  // above it. Groups are HIDDEN by default and only render their chip
  // grid when the user clicks their pill — keeps the panel compact.
  const accent = RATING_ACCENT[rating] || COLOR.affinity;
  const accentRgb = hexToRgb(accent);
  const chipBg = sel => sel
    ? `rgba(${accentRgb},0.20)`
    : 'rgba(255,255,255,0.04)';
  const chipFg = sel => sel
    ? accent
    : 'rgba(255,255,255,0.78)';

  // Per-chip visual treatment:
  //   - leading group emoji (scan by shape before reading)
  //   - unselected border uses the GROUP color at 0.45 opacity so the
  //     chip carries its residue visually even out of group context
  //     (critical for the Suggested row, which mixes groups)
  //   - selected chip swaps border to the RATING accent and adds an
  //     outer glow halo — reinforces "picked" state on touch without
  //     needing a full color wash
  const chipHtml = t => {
    const sel = selected.has(t.key);
    const tipAttr = t.desc ? ` data-crsmart-tip="${escapeHtml(t.desc)}"` : '';
    const gv = REACTION_GROUP_VISUALS[t.group] || { emoji: '', color: '#8a8a8a' };
    const groupRgb = GROUP_RGB[t.group] || GROUP_RGB._fallback;
    const border = sel ? accent : `rgba(${groupRgb},0.45)`;
    const shadow = sel
      ? `box-shadow:0 0 0 1px ${accent}, 0 0 8px rgba(${accentRgb},0.35);`
      : '';
    const glyph = gv.emoji
      ? `<span aria-hidden="true" style="margin-right:5px;font-size:12px;line-height:1;">${gv.emoji}</span>`
      : '';
    return `
      <button type="button" data-crsmart-reaction-chip data-key="${escapeHtml(t.key)}"
        aria-pressed="${sel ? 'true' : 'false'}"${tipAttr}
        style="
          cursor:pointer;
          background:${chipBg(sel)};
          border:1px solid ${border};
          color:${chipFg(sel)};
          padding:6px 12px;border-radius:999px;
          font-size:12px;line-height:1.2;
          font-weight:${sel ? '600' : '500'};
          display:inline-flex;align-items:center;
          ${shadow}
          transition:background 0.12s, border-color 0.12s, color 0.12s, box-shadow 0.12s;
        ">${glyph}<span>${escapeHtml(t.label)}</span></button>`;
  };

  const polarityForGroup = polarityOf(rating);
  // Most of the chip-palette work below is consumed only by the
  // advancedPanel HTML — when the user hasn't expanded "pick by
  // specific reason", that work is wasted. Gate each compute block
  // on advExpanded so the typical render (mood-combo click, slider
  // drag, rating flip with chips collapsed) skips the chip palette
  // entirely. The gated locals default to empty strings; the final
  // template inlines them and produces an empty advancedPanel.
  const advExpanded = STATE.reactionAdvancedExpanded.has(rec.aniListId);
  const byGroup = advExpanded ? buildReactionPalette(rec, rating) : null;

  // Suggested row: either the user-triggered shuffle sample (when set)
  // or the default context + recency mix. Up to 4 + 4 chips. Suppressed
  // during active search so the suggestions don't compete with the
  // dropdown's filtered results.
  const suggestedQuery = (STATE.reactionSearch[rec.aniListId] || '').trim();
  let suggestedRow = '';
  if (advExpanded && !suggestedQuery) {
    const shuffled = STATE.reactionShuffledSuggestions[rec.aniListId];
    const ctxKeys = shuffled
      ? shuffled.filter(k => {
          const c = REACTION_BY_KEY[k];
          return c && c.polarity === polarityForGroup;
        }).slice(0, 4)
      : getContextSuggestionsCached(rec, polarityForGroup, 4);
    const recentKeys = getRecencyPins(polarityForGroup, 4, new Set(ctxKeys));
    const suggestedKeys = [...ctxKeys, ...recentKeys];
    if (suggestedKeys.length > 0) {
      const chips = suggestedKeys
        .map(k => REACTION_BY_KEY[k])
        .filter(Boolean)
        .map(chipHtml)
        .join('');
      const label = shuffled ? 'Shuffled' : 'Suggested';
      suggestedRow = `
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="font-size:10px;letter-spacing:1.4px;font-weight:700;opacity:0.45;text-transform:uppercase;">${label}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>
        </div>`;
    }
  }
  const expandedGroups = advExpanded
    ? (STATE.reactionGroupsExpanded[rec.aniListId] || new Set())
    : new Set();
  const subgroupFilter = advExpanded
    ? (STATE.reactionSubgroupFilter[rec.aniListId] || {})
    : {};
  const query = STATE.reactionSearch[rec.aniListId] || '';

  // Subgroup pill used inside an expanded group to narrow by dimension.
  // Active pill adopts the rating accent; "all" is a pseudo-subgroup
  // (data-subgroup="") meaning "clear the filter".
  const subgroupPillHtml = (gid, subId, label, isActive) => `
    <button type="button" data-crsmart-reaction-subgroup
      data-group="${escapeHtml(gid)}" data-subgroup="${escapeHtml(subId || '')}"
      style="
        cursor:pointer;
        background:${isActive ? `rgba(${accentRgb},0.14)` : 'transparent'};
        border:1px solid ${isActive ? accent : 'rgba(255,255,255,0.10)'};
        color:${isActive ? accent : 'rgba(255,255,255,0.55)'};
        padding:3px 10px;border-radius:999px;
        font-size:10.5px;line-height:1.2;font-weight:${isActive ? '600' : '500'};
        letter-spacing:0.3px;font-family:inherit;
        transition:background 0.12s, border-color 0.12s, color 0.12s;
      ">${escapeHtml(label)}</button>`;

  // ── Group-pills row ──────────────────────────────────────────────
  // Six compact pills replace the always-visible group sections from
  // the prior design. Each pill carries the group emoji + label +
  // chip count for the current polarity, plus a "N selected" badge if
  // the user has tagged chips in this group. Clicking expands the
  // group's chip grid inline below; clicking again collapses. Multiple
  // groups can be open at once. The pill row alone keeps the panel
  // ~280px tall when nothing is expanded, down from ~1100px in the
  // old "every group always visible" layout.
  const groupSelectedCounts = {};
  if (advExpanded) {
    for (const key of selected) {
      const c = REACTION_BY_KEY[key];
      if (!c) continue;
      groupSelectedCounts[c.group] = (groupSelectedCounts[c.group] || 0) + 1;
    }
  }
  const groupPillHtml = (g) => {
    const gv = REACTION_GROUP_VISUALS[g.id] || { emoji: '', color: '#8a8a8a' };
    const groupRgb = GROUP_RGB[g.id] || GROUP_RGB._fallback;
    const isOpen = expandedGroups.has(g.id);
    const total = POLARITY_TOTALS[g.id + ':' + polarityForGroup] || 0;
    const selCount = groupSelectedCounts[g.id] || 0;
    const bg = isOpen
      ? `rgba(${groupRgb},0.18)`
      : 'rgba(255,255,255,0.03)';
    const border = isOpen
      ? gv.color
      : `rgba(${groupRgb},0.30)`;
    const labelColor = isOpen ? gv.color : 'rgba(255,255,255,0.78)';
    const countColor = isOpen
      ? `rgba(${groupRgb},0.85)`
      : 'rgba(255,255,255,0.40)';
    const selBadge = selCount > 0
      ? `<span style="margin-left:5px;font-size:9.5px;font-weight:700;letter-spacing:0.4px;color:${accent};background:rgba(${accentRgb},0.18);border-radius:999px;padding:1px 6px;">${selCount}</span>`
      : '';
    return `
      <button type="button" data-crsmart-reaction-group-toggle data-group="${escapeHtml(g.id)}"
        aria-pressed="${isOpen ? 'true' : 'false'}"
        data-crsmart-tip="${isOpen ? 'collapse' : `show all ${total} ${g.label.toLowerCase()} reasons`}"
        style="
          cursor:pointer;
          background:${bg};
          border:1px solid ${border};
          color:${labelColor};
          padding:5px 10px 5px 9px;border-radius:999px;
          font-size:11.5px;line-height:1.2;font-weight:${isOpen ? '600' : '500'};
          display:inline-flex;align-items:center;
          transition:background 0.12s, border-color 0.12s, color 0.12s;
          font-family:inherit;
        ">
        <span aria-hidden="true" style="margin-right:5px;font-size:12px;line-height:1;">${gv.emoji}</span>
        <span>${escapeHtml(g.label)}</span>
        <span style="margin-left:5px;font-size:10.5px;color:${countColor};font-variant-numeric:tabular-nums;">${total}</span>
        ${selBadge}
      </button>`;
  };
  const groupPillsRow = advExpanded
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px;">
         ${REACTION_GROUPS.map(groupPillHtml).join('')}
       </div>`
    : '';

  // ── Inline expanded groups ───────────────────────────────────────
  // Only renders the groups the user has actively toggled open via the
  // pill row. Each open group shows: subgroup filter pills (when ≥2
  // subgroups have chips), the chip grid, and an empty-state note if
  // the active subgroup happens to be empty under the current polarity.
  const expandedGroupHtml = (g) => {
    const chipsInGroup = byGroup[g.id] || [];
    const activeSub = subgroupFilter[g.id] || null;
    const headerGv = REACTION_GROUP_VISUALS[g.id] || { emoji: '', color: '#8a8a8a' };
    const headerRgb = GROUP_RGB[g.id] || GROUP_RGB._fallback;

    // Subgroup counts come from the precomputed
    // SUBGROUP_COUNTS_BY_POLARITY index (built once at module load)
    // instead of a fresh group×polarity filter per render. Saves a
    // 311-chip scan per expanded group.
    const visibleSubs = (REACTION_SUBGROUPS[g.id] || [])
      .filter(s => (SUBGROUP_COUNTS_BY_POLARITY[g.id + ':' + polarityForGroup + ':' + s.id] || 0) > 0);
    const subgroupRow = visibleSubs.length >= 2
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px;">
           ${subgroupPillHtml(g.id, null, 'all', !activeSub)}
           ${visibleSubs.map(s => subgroupPillHtml(g.id, s.id, s.label, activeSub === s.id)).join('')}
         </div>`
      : '';

    const emptyNote = !chipsInGroup.length
      ? `<div style="font-size:11.5px;opacity:0.5;padding:2px 2px;">no ${escapeHtml(activeSub || 'matching')} reasons here — try another filter.</div>`
      : '';

    return `
      <div data-crsmart-reaction-group="${escapeHtml(g.id)}" style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:rgba(255,255,255,0.02);border:1px solid rgba(${headerRgb},0.18);border-radius:8px;">
        <div style="display:flex;align-items:baseline;gap:8px;">
          <div style="font-size:10px;letter-spacing:1.4px;font-weight:700;color:${headerGv.color};opacity:0.85;text-transform:uppercase;">
            <span aria-hidden="true" style="margin-right:5px;font-size:11px;">${headerGv.emoji}</span>${escapeHtml(g.label)}
          </div>
        </div>
        ${subgroupRow}
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${chipsInGroup.map(chipHtml).join('')}</div>
        ${emptyNote}
      </div>`;
  };
  const inlineExpandedGroups = REACTION_GROUPS
    .filter(g => expandedGroups.has(g.id))
    .map(expandedGroupHtml)
    .join('');

  // ── Smart-search dropdown ────────────────────────────────────────
  // Mirrors the Vibe Today search bar pattern. STATE.reactionSearchDropdown
  // is the render-time projection of the lexicon search (computed in the
  // input handler, not here, so typing doesn't re-run the search through
  // a render cycle). Skipped when adv panel is collapsed — the user
  // can't see the search input to type into.
  const dropdownState = advExpanded ? (STATE.reactionSearchDropdown[rec.aniListId] || null) : null;
  let dropdownHtml = '';
  if (dropdownState && dropdownState.open) {
    if (dropdownState.results && dropdownState.results.length) {
      // Each row: bold word label + one inline button per constituent
      // chip. Click a chip to toggle just that one; Enter on the row's
      // keyboard-highlighted state still commits ALL chips at once
      // (keyboard fast-path). Hovering anywhere in the row sets the
      // keyboard highlight to that row so the visual stays consistent.
      const dropChipHtml = (c) => {
        const sel = selected.has(c.key);
        const gv = REACTION_GROUP_VISUALS[c.group] || { emoji: '', color: '#8a8a8a' };
        const groupRgb = GROUP_RGB[c.group] || GROUP_RGB._fallback;
        const bg = sel ? `rgba(${accentRgb},0.20)` : 'rgba(255,255,255,0.04)';
        const fg = sel ? accent : 'rgba(255,255,255,0.82)';
        const border = sel ? accent : `rgba(${groupRgb},0.35)`;
        const check = sel
          ? `<span aria-hidden="true" style="margin-right:3px;font-weight:700;">✓</span>`
          : '';
        return `<button type="button" data-crsmart-reaction-search-chip data-key="${escapeHtml(c.key)}"
          aria-pressed="${sel ? 'true' : 'false'}"
          ${c.desc ? `data-crsmart-tip="${escapeHtml(c.desc)}"` : ''}
          style="
            cursor:pointer;
            background:${bg};
            border:1px solid ${border};
            color:${fg};
            padding:3px 9px;border-radius:999px;
            font-size:11.5px;line-height:1.2;font-weight:${sel ? '600' : '500'};
            display:inline-flex;align-items:center;font-family:inherit;
            transition:background 0.1s, border-color 0.1s, color 0.1s;
          ">
          ${check}<span aria-hidden="true" style="margin-right:4px;font-size:11px;">${gv.emoji}</span>${escapeHtml(c.label)}
        </button>`;
      };
      const rows = dropdownState.results.map((row, i) => {
        const allAdded = row.chips.every(c => selected.has(c.key));
        const chipBtns = row.chips.map(dropChipHtml).join('');
        const truncatedHint = row.truncated
          ? ` <span style="opacity:0.45;font-size:11px;">+more</span>`
          : '';
        const isHi = i === (dropdownState.highlight || 0);
        const bg = isHi ? `rgba(${accentRgb},0.08)` : 'transparent';
        const hint = allAdded
          ? `<span style="margin-left:auto;font-size:10px;color:rgba(255,255,255,0.40);text-transform:lowercase;">all added</span>`
          : '';
        return `<div data-crsmart-reaction-search-row data-row="${i}" role="option" aria-selected="${isHi}"
          style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:12px;line-height:1.3;background:${bg};flex-wrap:wrap;transition:background 0.08s;">
          <span style="font-weight:600;white-space:nowrap;color:rgba(255,255,255,0.92);min-width:0;">${escapeHtml(row.word)}</span>
          <span style="color:rgba(255,255,255,0.25);">·</span>
          <span style="display:inline-flex;flex-wrap:wrap;gap:4px;flex:1;min-width:0;">${chipBtns}${truncatedHint}</span>
          ${hint}
        </div>`;
      }).join('');
      dropdownHtml = `
        <div data-crsmart-reaction-search-dropdown role="listbox"
          style="position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:20;
            background:#1a1714;border:1px solid rgba(255,255,255,0.14);border-radius:8px;
            box-shadow:0 8px 24px rgba(0,0,0,0.45);max-height:280px;overflow-y:auto;padding:4px;">
          ${rows}
        </div>`;
    } else {
      const sug = dropdownState.suggestion;
      const sugHtml = sug
        ? `<div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.65);">did you mean
             <button type="button" data-crsmart-reaction-search-suggest data-word="${escapeHtml(sug)}"
               style="background:none;border:0;color:${accent};font-family:inherit;font-size:11px;cursor:pointer;padding:0;text-decoration:underline;">${escapeHtml(sug)}</button>?
           </div>`
        : '';
      dropdownHtml = `
        <div data-crsmart-reaction-search-dropdown role="listbox"
          style="position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:20;
            background:#1a1714;border:1px solid rgba(255,255,255,0.14);border-radius:8px;
            box-shadow:0 8px 24px rgba(0,0,0,0.45);padding:8px 10px;">
          <div style="font-size:11px;color:rgba(255,255,255,0.55);font-style:italic;">
            no matches for "${escapeHtml(dropdownState.query || query)}"
          </div>
          ${sugHtml}
        </div>`;
    }
  }

  // Search panel — relative positioning so the dropdown can absolute
  // beneath. Shuffle button has been removed: in the new compact layout
  // groups don't render chip grids unless explicitly expanded, so the
  // pre-rolled dice picks had nowhere to display anyway.
  const searchPanel = advExpanded
    ? `<div style="position:relative;">
         <input type="search" data-crsmart-reaction-search
           placeholder="search reasons — try cry, music, pacing"
           value="${escapeHtml(query)}"
           autocomplete="off" spellcheck="false"
           style="
             width:100%;box-sizing:border-box;
             background:rgba(255,255,255,0.04);
             border:1px solid rgba(255,255,255,0.14);
             border-radius:999px;
             color:rgba(255,255,255,0.88);
             padding:7px 14px;
             font-size:12.5px;line-height:1.2;font-family:inherit;
             outline:none;
           "/>
         ${dropdownHtml}
       </div>`
    : '';

  // Action buttons: shuffle (replace context suggestions with a random
  // sample) + clear (deselect every chip on this show). Both right-
  // aligned in the header. Clear hides when nothing is selected so the
  // panel doesn't show a dead button in the cold-start state.
  const selectedCount = selected.size;
  const clearBtn = selectedCount > 0
    ? `<button type="button" data-crsmart-reaction-clear
        data-crsmart-tip="deselect every reason on this show"
        style="
          cursor:pointer;background:rgba(${accentRgb},0.10);
          border:1px solid rgba(${accentRgb},0.45);
          color:${accent};
          padding:4px 10px;border-radius:999px;
          font-size:11px;line-height:1.2;font-weight:600;
          display:inline-flex;align-items:center;gap:4px;font-family:inherit;
          transition:background 0.12s, border-color 0.12s;
        ">
        <span>clear (${selectedCount})</span>
      </button>`
    : '';
  const headerActions = `
    <div style="display:inline-flex;gap:6px;margin-left:auto;align-items:center;">
      ${justSaved ? `<span style="font-size:11.5px;color:${COLOR.affinity};opacity:0.85;">got it — we'll factor this in</span>` : ''}
      ${clearBtn}
    </div>`;

  // ── Mood combos ──────────────────────────────────────────────────
  // Primary input now — one tap commits a curated 3-5-chip bundle.
  // Combo is "active" when ALL its constituent chips are currently
  // selected; tapping an active combo removes them all. Tint pulls
  // from the group of the combo's primary domain (so a craft-tinted
  // combo carries that color even though it might touch other groups).
  const combosForPolarity = (MOOD_COMBOS[polarityForGroup] || []);
  const comboCardHtml = (combo) => {
    const gv = REACTION_GROUP_VISUALS[combo.tint] || { color: '#8a8a8a' };
    const tintRgb = GROUP_RGB[combo.tint] || GROUP_RGB._fallback;
    const allSelected = combo.chips.length > 0 && combo.chips.every(k => selected.has(k));
    const someSelected = !allSelected && combo.chips.some(k => selected.has(k));
    const bg = allSelected
      ? `rgba(${accentRgb},0.22)`
      : someSelected
        ? `rgba(${tintRgb},0.10)`
        : `rgba(${tintRgb},0.05)`;
    const border = allSelected
      ? accent
      : someSelected
        ? `rgba(${tintRgb},0.55)`
        : `rgba(${tintRgb},0.30)`;
    const labelColor = allSelected ? accent : 'rgba(255,255,255,0.92)';
    const descColor = allSelected
      ? `rgba(${accentRgb},0.78)`
      : 'rgba(255,255,255,0.50)';
    const shadow = allSelected
      ? `box-shadow:0 0 0 1px ${accent}, 0 0 12px rgba(${accentRgb},0.30);`
      : '';
    const partialBadge = someSelected && !allSelected
      ? `<span style="position:absolute;top:6px;right:8px;font-size:9px;font-weight:700;letter-spacing:0.4px;color:${accent};background:rgba(${accentRgb},0.18);border-radius:999px;padding:1px 6px;">partial</span>`
      : '';
    return `
      <button type="button" data-crsmart-mood-combo data-id="${escapeHtml(combo.id)}"
        aria-pressed="${allSelected ? 'true' : 'false'}"
        data-crsmart-tip="${escapeHtml(combo.desc || '')}"
        style="
          position:relative;cursor:pointer;
          background:${bg};
          border:1px solid ${border};
          ${shadow}
          padding:10px 12px;border-radius:10px;
          display:flex;flex-direction:column;align-items:flex-start;gap:2px;
          font-family:inherit;text-align:left;
          transition:background 0.14s, border-color 0.14s, box-shadow 0.14s;
        ">
        ${partialBadge}
        <div style="display:inline-flex;align-items:center;gap:7px;">
          <span aria-hidden="true" style="font-size:17px;line-height:1;">${combo.emoji}</span>
          <span style="font-size:12.5px;font-weight:600;color:${labelColor};">${escapeHtml(combo.label)}</span>
        </div>
        <span style="font-size:10.5px;color:${descColor};line-height:1.3;">${escapeHtml(combo.desc || '')}</span>
      </button>`;
  };
  const moodCombosGrid = combosForPolarity.length > 0
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:8px;">
         ${combosForPolarity.map(comboCardHtml).join('')}
       </div>`
    : '';

  // ── Report-card sliders ──────────────────────────────────────────
  // Five axes (pacing / feeling / craft / cast / story), five
  // positions each (-2 / -1 / 0 / +1 / +2). Position is derived from
  // chip state, not stored separately — moving the slider just
  // adds/removes the chip at the target position. Sliders are
  // universal: a 👍 user can mark `craft: -1` (looked rough but I
  // liked it). The chip pinning in buildReactionPalette keeps that
  // chip visible/deselectable even though it doesn't match the
  // rating's polarity filter.
  const POS_ORDER = ['-2', '-1', '0', '+1', '+2'];
  const sliderRowHtml = (axis) => {
    const gv = REACTION_GROUP_VISUALS[axis.tint] || { emoji: '', color: '#8a8a8a' };
    const tintRgb = GROUP_RGB[axis.tint] || GROUP_RGB._fallback;
    const currentPos = axisPositionFromChips(axis, selected);
    const dots = POS_ORDER.map(pos => {
      const isActive = pos === currentPos;
      const isCenter = pos === '0';
      const chipKey = axis.chips[pos];
      const chipLabel = chipKey ? (REACTION_BY_KEY[chipKey]?.label || '') : '';
      const tip = isCenter
        ? 'reset — no axis signal'
        : chipLabel;
      // Active dot at non-center uses the rating accent (so the
      // commitment color reads through). Active center dot is a
      // subtle neutral. Inactive dots show as tinted outlines.
      const bg = isActive
        ? (isCenter ? 'rgba(255,255,255,0.18)' : `rgba(${accentRgb},0.30)`)
        : `rgba(${tintRgb},0.06)`;
      const border = isActive
        ? (isCenter ? 'rgba(255,255,255,0.40)' : accent)
        : `rgba(${tintRgb},0.30)`;
      const size = isActive ? 12 : 8;
      const ring = isActive && !isCenter
        ? `box-shadow:0 0 0 3px rgba(${accentRgb},0.18);`
        : '';
      return `<button type="button" data-crsmart-reaction-axis-dot
        data-axis="${escapeHtml(axis.id)}" data-pos="${pos}"
        aria-label="${escapeHtml(tip)}" data-crsmart-tip="${escapeHtml(tip)}"
        style="
          cursor:pointer;background:${bg};border:1px solid ${border};
          ${ring}
          width:${size}px;height:${size}px;border-radius:50%;
          padding:0;margin:0;font-family:inherit;
          transition:background 0.12s, border-color 0.12s, width 0.12s, height 0.12s, box-shadow 0.12s;
        "></button>`;
    }).join('');
    const labelColor = currentPos === '0' ? 'rgba(255,255,255,0.55)' : accent;
    return `
      <div style="display:flex;align-items:center;gap:10px;font-size:11px;line-height:1.2;">
        <div style="min-width:62px;display:inline-flex;align-items:center;gap:5px;">
          <span aria-hidden="true" style="font-size:13px;">${gv.emoji}</span>
          <span style="font-weight:600;color:${labelColor};letter-spacing:0.2px;text-transform:lowercase;">${escapeHtml(axis.label)}</span>
        </div>
        <span style="color:rgba(255,255,255,0.40);min-width:64px;text-align:right;">${escapeHtml(axis.leftLabel)}</span>
        <div style="display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;">${dots}</div>
        <span style="color:rgba(255,255,255,0.40);min-width:84px;">${escapeHtml(axis.rightLabel)}</span>
      </div>`;
  };
  const slidersBlock = REACTION_AXES.length > 0
    ? `<div style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
         <div style="display:flex;align-items:center;gap:8px;">
           <span style="font-size:10px;letter-spacing:1.4px;font-weight:700;opacity:0.45;text-transform:uppercase;">Report card</span>
           <span style="font-size:10.5px;opacity:0.40;">click a dot to mark how it landed; click again to reset</span>
         </div>
         ${REACTION_AXES.map(sliderRowHtml).join('')}
       </div>`
    : '';

  // ── "Tell me more" advanced expander ─────────────────────────────
  // advExpanded was lifted to the top of the function so the heavy
  // chip-palette compute can be gated on it; the toggle button is
  // always rendered so the user can flip the state.
  const advToggleBtn = `
    <button type="button" data-crsmart-reaction-advanced-toggle
      data-crsmart-tip="${advExpanded ? 'hide the chip palette' : 'pick specific reasons via search + categories'}"
      style="
        cursor:pointer;background:transparent;
        border:1px dashed rgba(255,255,255,0.16);
        color:rgba(255,255,255,0.62);
        padding:5px 12px;border-radius:999px;
        font-size:11px;line-height:1.2;
        display:inline-flex;align-items:center;gap:5px;font-family:inherit;
        transition:background 0.12s, border-color 0.12s, color 0.12s;
      ">
      <span>${advExpanded ? '▾' : '▸'}</span>
      <span>${advExpanded ? 'hide chip palette' : 'pick by specific reason'}</span>
    </button>`;

  const shuffleBtn = advExpanded
    ? `<button type="button" data-crsmart-reaction-shuffle
         data-crsmart-tip="shuffle the Suggested row with a random sample of reasons"
         style="
           cursor:pointer;background:rgba(255,255,255,0.04);
           border:1px solid rgba(255,255,255,0.14);
           color:rgba(255,255,255,0.72);
           padding:4px 10px;border-radius:999px;
           font-size:11px;line-height:1.2;
           display:inline-flex;align-items:center;gap:4px;font-family:inherit;
           transition:background 0.12s, color 0.12s;
         ">
         <span aria-hidden="true">🎲</span><span>shuffle</span>
       </button>`
    : '';

  const advancedPanel = advExpanded
    ? `<div style="display:flex;flex-direction:column;gap:10px;padding:10px 4px 2px;border-top:1px dashed rgba(255,255,255,0.10);margin-top:4px;">
         <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
           <span style="font-size:11px;letter-spacing:0.3px;color:rgba(255,255,255,0.55);">refine — pick specific reasons:</span>
           <div style="margin-left:auto;display:inline-flex;gap:6px;">${shuffleBtn}</div>
         </div>
         ${searchPanel}
         <div style="display:flex;flex-direction:column;gap:10px;padding:2px 2px 2px;">
           ${suggestedRow}
           ${groupPillsRow}
           ${inlineExpandedGroups}
         </div>
       </div>`
    : '';

  return `
    <div data-crsmart-reactions="${rec.aniListId}" style="display:flex;flex-direction:column;gap:10px;padding:0 4px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${collapsedPill}
        ${prompt ? `<span style="font-size:12px;opacity:0.55;">${escapeHtml(prompt)}</span>` : ''}
        ${headerActions}
      </div>
      ${moodCombosGrid}
      ${slidersBlock}
      <div style="display:flex;align-items:center;gap:8px;padding:2px 2px 0;">
        ${advToggleBtn}
      </div>
      ${advancedPanel}
    </div>
  `;
}

// Per-card-per-rec pending-repaint registry. Multiple repaint() calls
// in the same frame coalesce into one DOM swap + re-wire. Without this,
// holding a key in the search input or rapid clicks would tear down and
// rebuild the entire palette dozens of times per second.
const _pendingRepaints = new Map(); // key: aniListId → { card, rec, after }

function repaintReactionPaletteNow(card, rec) {
  const wrap = card.querySelector(`[data-crsmart-reactions="${rec.aniListId}"]`);
  if (!wrap) return false;
  const fresh = renderReactionPalette(rec);
  const tmp = document.createElement('div');
  tmp.innerHTML = fresh;
  const next = tmp.firstElementChild;
  if (!next) return false;
  wrap.replaceWith(next);
  wireReactionPalette(card, rec);
  return true;
}

function scheduleReactionPaletteRepaint(card, rec, after) {
  const key = String(rec.aniListId);
  const existing = _pendingRepaints.get(key);
  if (existing) {
    // Repaint already queued for this frame. Update the after-callback
    // so the last caller's restoration logic (focus/caret) wins —
    // they're all reacting to the same final STATE anyway.
    if (after) existing.after = after;
    return;
  }
  const entry = { card, rec, after: after || null };
  _pendingRepaints.set(key, entry);
  requestAnimationFrame(() => {
    _pendingRepaints.delete(key);
    if (!repaintReactionPaletteNow(entry.card, entry.rec)) return;
    if (entry.after) entry.after();
  });
}

// Toggle a single chip on the current show: add it if absent, remove it
// if present. Side effects: bumps/decrements reactionStats so the
// Suggested row's recency pins stay honest, flashes the justSaved
// microcopy on first add of the session, persists to chrome.storage.
// Returns `true` if the chip ended up selected (post-toggle), else
// `false`. Shared by the in-panel chip click and the dropdown's
// per-chip click; both need the exact same side-effect pipeline.
async function toggleReactionChip(card, rec, key) {
  const current = STATE.reactions[rec.aniListId] || { tags: [] };
  const nextSet = new Set(current.tags || []);
  const wasSelected = nextSet.has(key);
  if (wasSelected) nextSet.delete(key);
  else nextSet.add(key);
  const nextTags = [...nextSet];
  if (!wasSelected) {
    const prior = STATE.reactionStats[key] || { count: 0, lastUsed: 0 };
    STATE.reactionStats[key] = {
      count: (prior.count || 0) + 1,
      lastUsed: Date.now(),
    };
  } else {
    const prior = STATE.reactionStats[key];
    if (prior) {
      const nextCount = (prior.count || 0) - 1;
      if (nextCount <= 0) delete STATE.reactionStats[key];
      else STATE.reactionStats[key] = { count: nextCount, lastUsed: prior.lastUsed };
    }
  }
  if (nextTags.length === 0) {
    delete STATE.reactions[rec.aniListId];
  } else {
    STATE.reactions[rec.aniListId] = { tags: nextTags, updatedAt: Date.now() };
  }
  if (nextTags.length > (current.tags?.length || 0)) {
    STATE.reactionsJustSaved.add(rec.aniListId);
    setTimeout(() => {
      STATE.reactionsJustSaved.delete(rec.aniListId);
      repaintReactionPaletteNow(card, rec);
    }, 2800);
  }
  try {
    await chrome.storage.local.set({
      [REACTIONS_KEY]: STATE.reactions,
      [REACTION_STATS_KEY]: STATE.reactionStats,
    });
  } catch (err) {
    if (String(err).includes('Extension context invalidated')
        || isExtensionContextInvalidated()) {
      showContextInvalidatedBanner();
      return !wasSelected;
    }
    console.warn('[crsmart] save reactions failed', err);
  }
  return !wasSelected;
}

// Wipe every reaction for this show. Each removal decrements stats
// (and prunes at zero) using the same path the per-chip toggle uses,
// so the Suggested-row recency pins stay honest. Persists once at the
// end, repaints once. No-op when nothing is selected.
async function clearAllReactions(card, rec) {
  const tags = STATE.reactions[rec.aniListId]?.tags || [];
  if (!tags.length) return;
  for (const key of tags) {
    const prior = STATE.reactionStats[key];
    if (prior) {
      const nextCount = (prior.count || 0) - 1;
      if (nextCount <= 0) delete STATE.reactionStats[key];
      else STATE.reactionStats[key] = { count: nextCount, lastUsed: prior.lastUsed };
    }
  }
  delete STATE.reactions[rec.aniListId];
  try {
    await chrome.storage.local.set({
      [REACTIONS_KEY]: STATE.reactions,
      [REACTION_STATS_KEY]: STATE.reactionStats,
    });
  } catch (err) {
    if (String(err).includes('Extension context invalidated')
        || isExtensionContextInvalidated()) {
      showContextInvalidatedBanner();
      return;
    }
    console.warn('[crsmart] clear reactions failed', err);
  }
  repaintReactionPaletteNow(card, rec);
}

// Position is derived from chip state — no separate storage. The slider
// shows the position of whichever of its four chips is currently
// selected, preferring the most extreme if more than one is set (rare
// edge case, only happens if the user manually picked multiple chips
// from the same axis via the chip palette). Returns '0' when none are
// selected.
function axisPositionFromChips(axis, selectedSet) {
  // Most-extreme-first priority: +2 > -2 > +1 > -1.
  const order = ['+2', '-2', '+1', '-1'];
  for (const pos of order) {
    const k = axis.chips[pos];
    if (k && selectedSet.has(k)) return pos;
  }
  return '0';
}

// Snap an axis to a specific position. Removes every chip in the axis's
// chip-set that's currently selected, then adds the chip at the target
// position (if non-zero). One storage write at the end — avoids the
// N+1-writes problem you'd get from looping toggleReactionChip per
// chip. Stats bump/decrement per chip the same way toggleReactionChip
// does, so the engine sees the axis-set as N individual chip-events.
async function setReactionAxis(card, rec, axisId, position) {
  const axis = REACTION_AXES.find(a => a.id === axisId);
  if (!axis) return;
  const current = STATE.reactions[rec.aniListId] || { tags: [] };
  const set = new Set(current.tags || []);
  const beforeSize = set.size;

  // Remove every axis-owned chip currently selected.
  for (const chipKey of Object.values(axis.chips)) {
    if (!chipKey || !set.has(chipKey)) continue;
    set.delete(chipKey);
    const prior = STATE.reactionStats[chipKey];
    if (prior) {
      const next = (prior.count || 0) - 1;
      if (next <= 0) delete STATE.reactionStats[chipKey];
      else STATE.reactionStats[chipKey] = { count: next, lastUsed: prior.lastUsed };
    }
  }

  // Add the chip at the new position (unless 0 → no chip).
  const newChip = axis.chips[position];
  if (newChip) {
    set.add(newChip);
    const prior = STATE.reactionStats[newChip] || { count: 0, lastUsed: 0 };
    STATE.reactionStats[newChip] = { count: (prior.count || 0) + 1, lastUsed: Date.now() };
  }

  const tags = [...set];
  if (tags.length === 0) {
    delete STATE.reactions[rec.aniListId];
  } else {
    STATE.reactions[rec.aniListId] = { tags, updatedAt: Date.now() };
  }
  if (tags.length > beforeSize) {
    STATE.reactionsJustSaved.add(rec.aniListId);
    setTimeout(() => {
      STATE.reactionsJustSaved.delete(rec.aniListId);
      repaintReactionPaletteNow(card, rec);
    }, 2800);
  }
  try {
    await chrome.storage.local.set({
      [REACTIONS_KEY]: STATE.reactions,
      [REACTION_STATS_KEY]: STATE.reactionStats,
    });
  } catch (err) {
    if (String(err).includes('Extension context invalidated')
        || isExtensionContextInvalidated()) {
      showContextInvalidatedBanner();
      return;
    }
    console.warn('[crsmart] save axis failed', err);
  }
}

// Toggle every chip in a mood-combo bundle at once. If the combo is
// already fully active (all chips selected), remove them all. Otherwise
// add the ones that aren't already in. Stats bump/decrement per chip
// the same way toggleReactionChip does — so a combo click is exactly
// equivalent to clicking each chip individually, just batched.
async function toggleMoodCombo(card, rec, comboId) {
  const polarity = polarityOf(STATE.ratings[rec.aniListId]);
  if (!polarity) return;
  const combo = (MOOD_COMBOS[polarity] || []).find(c => c.id === comboId);
  if (!combo) return;
  const current = STATE.reactions[rec.aniListId] || { tags: [] };
  const set = new Set(current.tags || []);
  const allSelected = combo.chips.every(k => set.has(k));
  const beforeSize = set.size;
  let bumpedAny = false;
  if (allSelected) {
    // Combo was fully on → flip every chip off (decrement stats).
    for (const key of combo.chips) {
      set.delete(key);
      const prior = STATE.reactionStats[key];
      if (prior) {
        const nextCount = (prior.count || 0) - 1;
        if (nextCount <= 0) delete STATE.reactionStats[key];
        else STATE.reactionStats[key] = { count: nextCount, lastUsed: prior.lastUsed };
        bumpedAny = true;
      }
    }
  } else {
    // Combo not fully on → add only the chips that aren't already
    // selected. Bumps stats for genuine adds; pre-existing chips stay
    // at their current count.
    for (const key of combo.chips) {
      if (set.has(key)) continue;
      set.add(key);
      const prior = STATE.reactionStats[key] || { count: 0, lastUsed: 0 };
      STATE.reactionStats[key] = {
        count: (prior.count || 0) + 1,
        lastUsed: Date.now(),
      };
      bumpedAny = true;
    }
  }
  const nextTags = [...set];
  if (nextTags.length === 0) {
    delete STATE.reactions[rec.aniListId];
  } else {
    STATE.reactions[rec.aniListId] = { tags: nextTags, updatedAt: Date.now() };
  }
  if (nextTags.length > beforeSize) {
    STATE.reactionsJustSaved.add(rec.aniListId);
    setTimeout(() => {
      STATE.reactionsJustSaved.delete(rec.aniListId);
      repaintReactionPaletteNow(card, rec);
    }, 2800);
  }
  try {
    await chrome.storage.local.set({
      [REACTIONS_KEY]: STATE.reactions,
      [REACTION_STATS_KEY]: STATE.reactionStats,
    });
  } catch (err) {
    if (String(err).includes('Extension context invalidated')
        || isExtensionContextInvalidated()) {
      showContextInvalidatedBanner();
      return;
    }
    console.warn('[crsmart] save mood combo failed', err);
  }
}

// Replace the Suggested row's context-suggestion chips with a fresh
// random sample. Pulls from EXTRA_REACTIONS matching the current
// polarity. Session-only — polarity flip clears it, so the next user
// rating gets the deterministic context-suggested defaults again.
function shuffleReactionSuggestions(rec, polarity) {
  if (!polarity) return;
  const pool = EXTRA_REACTIONS.filter(c => c.polarity === polarity);
  if (!pool.length) return;
  // Fisher-Yates partial shuffle — only need top 4 chips, not a full
  // permutation. Reduces work on a 100+-chip polarity bucket.
  const arr = pool.slice();
  const N = Math.min(4, arr.length);
  for (let i = 0; i < N; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  STATE.reactionShuffledSuggestions[rec.aniListId] = arr.slice(0, N).map(c => c.key);
}

// Commit a dropdown row — adds every constituent chip in that row to the
// user's selections in one shot. Same persistence path the chip-click
// handler uses, just batched. After the write, the search input clears
// + dropdown closes so the user can either type another query or move
// on to the group pills. The justSaved microcopy flashes once if any
// chips were genuinely added (no flash on a row where everything was
// already selected).
async function commitReactionSearchRow(card, rec, idx) {
  const state = STATE.reactionSearchDropdown[rec.aniListId];
  if (!state || !state.results || !state.results[idx]) return;
  const row = state.results[idx];
  const current = STATE.reactions[rec.aniListId] || { tags: [] };
  const nextSet = new Set(current.tags || []);
  const beforeSize = nextSet.size;
  for (const chip of row.chips) {
    if (!nextSet.has(chip.key)) {
      nextSet.add(chip.key);
      const prior = STATE.reactionStats[chip.key] || { count: 0, lastUsed: 0 };
      STATE.reactionStats[chip.key] = {
        count: (prior.count || 0) + 1,
        lastUsed: Date.now(),
      };
    }
  }
  const addedAny = nextSet.size > beforeSize;
  const nextTags = [...nextSet];
  if (nextTags.length === 0) {
    delete STATE.reactions[rec.aniListId];
  } else {
    STATE.reactions[rec.aniListId] = { tags: nextTags, updatedAt: Date.now() };
  }
  delete STATE.reactionSearch[rec.aniListId];
  delete STATE.reactionSearchDropdown[rec.aniListId];
  if (addedAny) {
    STATE.reactionsJustSaved.add(rec.aniListId);
    setTimeout(() => {
      STATE.reactionsJustSaved.delete(rec.aniListId);
      repaintReactionPaletteNow(card, rec);
    }, 2800);
  }
  try {
    const payload = { [REACTIONS_KEY]: STATE.reactions };
    if (addedAny) payload[REACTION_STATS_KEY] = STATE.reactionStats;
    await chrome.storage.local.set(payload);
  } catch (err) {
    if (String(err).includes('Extension context invalidated')
        || isExtensionContextInvalidated()) {
      showContextInvalidatedBanner();
      return;
    }
    console.warn('[crsmart] save reactions failed', err);
  }
  repaintReactionPaletteNow(card, rec);
}

function wireReactionPalette(card, rec) {
  const repaint = (after) => scheduleReactionPaletteRepaint(card, rec, after);

  const toggleBtn = card.querySelector(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reactions-toggle]`);
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (STATE.reactionsExpanded.has(rec.aniListId)) {
        STATE.reactionsExpanded.delete(rec.aniListId);
      } else {
        STATE.reactionsExpanded.add(rec.aniListId);
      }
      repaint();
    });
  }

  // Restore focus + caret after the rAF DOM swap. Used by every input
  // path (typing, Esc-clear, "did you mean" suggestion accept) so the
  // user never has to re-click into the field to keep typing.
  const restoreFocus = (caret) => {
    const fresh = card.querySelector(
      `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-search]`);
    if (!fresh) return;
    fresh.focus();
    if (caret != null) {
      try { fresh.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
    }
  };

  const closeDropdown = () => {
    if (!STATE.reactionSearchDropdown[rec.aniListId]) return;
    delete STATE.reactionSearchDropdown[rec.aniListId];
    repaint();
  };

  // Recompute the dropdown results from the live query, save into STATE,
  // and trigger a repaint. Polarity-aware: chips that don't match the
  // current rating are filtered out of every result row.
  const refreshDropdown = (rawQuery) => {
    const rating = STATE.ratings[rec.aniListId];
    const polarity = polarityOf(rating);
    const q = String(rawQuery || '').trim();
    if (!polarity || !q) {
      delete STATE.reactionSearchDropdown[rec.aniListId];
      return;
    }
    const results = searchReactionLexicon(q, polarity, { maxResults: 8 });
    STATE.reactionSearchDropdown[rec.aniListId] = {
      open: true,
      query: q,
      results,
      highlight: 0,
      suggestion: results.length ? null : suggestReactionWord(q),
    };
  };

  const searchInput = card.querySelector(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-search]`);
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const raw = searchInput.value || '';
      if (raw) STATE.reactionSearch[rec.aniListId] = raw;
      else delete STATE.reactionSearch[rec.aniListId];
      refreshDropdown(raw);
      const caret = searchInput.selectionStart;
      repaint(() => restoreFocus(caret));
    });

    // Keyboard nav: ArrowUp/Down move the dropdown highlight; Enter/Tab
    // commits the highlighted row (adds all constituent chips at once);
    // Escape clears the dropdown (and the search if it's already empty).
    searchInput.addEventListener('keydown', (e) => {
      const state = STATE.reactionSearchDropdown[rec.aniListId];
      const hasResults = state && state.open && state.results && state.results.length;
      if (e.key === 'ArrowDown' && hasResults) {
        e.preventDefault();
        state.highlight = (state.highlight + 1) % state.results.length;
        repaint(() => restoreFocus(searchInput.selectionStart));
      } else if (e.key === 'ArrowUp' && hasResults) {
        e.preventDefault();
        state.highlight = (state.highlight - 1 + state.results.length) % state.results.length;
        repaint(() => restoreFocus(searchInput.selectionStart));
      } else if ((e.key === 'Enter' || e.key === 'Tab') && hasResults) {
        e.preventDefault();
        commitReactionSearchRow(card, rec, state.highlight);
      } else if (e.key === 'Escape') {
        if (state && state.open) {
          e.preventDefault();
          closeDropdown();
        } else if (searchInput.value) {
          e.preventDefault();
          searchInput.value = '';
          delete STATE.reactionSearch[rec.aniListId];
          repaint(() => restoreFocus(0));
        }
      }
    });

    // Blur closes the dropdown. Delay so a dropdown row's mousedown can
    // fire commitReactionSearchRow first — without the delay, blur runs
    // before mousedown and the row click never happens.
    //
    // The activeElement check is load-bearing: every keystroke triggers
    // a rAF repaint, which detaches the OLD input and fires a synthetic
    // blur on it. Without this guard, that blur would queue a close
    // timeout that fires ~120ms later — after restoreFocus has already
    // moved focus to the NEW input — and would yank the user out of
    // the field one frame into typing.
    searchInput.addEventListener('blur', () => {
      setTimeout(() => {
        const fresh = card.querySelector(
          `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-search]`);
        if (fresh && document.activeElement === fresh) return; // DOM-swap blur, not a real one
        const state = STATE.reactionSearchDropdown[rec.aniListId];
        if (state && state.open) closeDropdown();
      }, 120);
    });
  }

  // Dropdown row: mouse hover sets the keyboard highlight so arrow keys
  // and mouse pointer stay in sync. The row itself is no longer
  // clickable for commit — each constituent chip button inside has its
  // own click handler that toggles just that chip. Enter on the
  // highlighted row still commits all chips at once (keyboard fast path).
  const dropdownRows = card.querySelectorAll(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-search-row]`);
  dropdownRows.forEach(row => {
    row.addEventListener('mouseenter', () => {
      const state = STATE.reactionSearchDropdown[rec.aniListId];
      if (!state || !state.open) return;
      const newHi = Number(row.dataset.row);
      if (state.highlight === newHi) return;
      state.highlight = newHi;
      repaint(() => restoreFocus(searchInput?.selectionStart ?? null));
    });
  });

  const suggestBtn = card.querySelector(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-search-suggest]`);
  if (suggestBtn) {
    suggestBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const word = suggestBtn.dataset.word || '';
      if (!word) return;
      STATE.reactionSearch[rec.aniListId] = word;
      refreshDropdown(word);
      repaint(() => {
        restoreFocus(word.length);
        const fresh = card.querySelector(
          `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-search]`);
        if (fresh) fresh.value = word;
      });
    });
  }

  const groupToggleBtns = card.querySelectorAll(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-group-toggle]`);
  groupToggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const gid = btn.dataset.group;
      if (!gid) return;
      const set = STATE.reactionGroupsExpanded[rec.aniListId] || new Set();
      const wasExpanded = set.has(gid);
      if (wasExpanded) set.delete(gid);
      else set.add(gid);
      if (set.size === 0) delete STATE.reactionGroupsExpanded[rec.aniListId];
      else STATE.reactionGroupsExpanded[rec.aniListId] = set;
      // Collapsing a group clears its subgroup filter so re-expanding
      // later starts from "all" rather than resuming a forgotten narrow.
      if (wasExpanded && STATE.reactionSubgroupFilter[rec.aniListId]) {
        delete STATE.reactionSubgroupFilter[rec.aniListId][gid];
        if (Object.keys(STATE.reactionSubgroupFilter[rec.aniListId]).length === 0) {
          delete STATE.reactionSubgroupFilter[rec.aniListId];
        }
      }
      repaint();
    });
  });

  const subgroupBtns = card.querySelectorAll(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-subgroup]`);
  subgroupBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const gid = btn.dataset.group;
      const sid = btn.dataset.subgroup || null;
      if (!gid) return;
      const filter = STATE.reactionSubgroupFilter[rec.aniListId] || {};
      // Empty data-subgroup means the "all" pill — clear the filter.
      // Clicking the already-active pill also clears (toggle off).
      if (!sid || filter[gid] === sid) delete filter[gid];
      else filter[gid] = sid;
      if (Object.keys(filter).length === 0) {
        delete STATE.reactionSubgroupFilter[rec.aniListId];
      } else {
        STATE.reactionSubgroupFilter[rec.aniListId] = filter;
      }
      repaint();
    });
  });

  const chipBtns = card.querySelectorAll(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-chip]`);
  chipBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      await toggleReactionChip(card, rec, btn.dataset.key);
      repaint();
    });
  });

  const clearBtn = card.querySelector(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-clear]`);
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await clearAllReactions(card, rec);
    });
  }

  const shuffleBtn = card.querySelector(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-shuffle]`);
  if (shuffleBtn) {
    shuffleBtn.addEventListener('click', () => {
      const rating = STATE.ratings[rec.aniListId];
      const polarity = polarityOf(rating);
      shuffleReactionSuggestions(rec, polarity);
      repaint();
    });
  }

  // Mood combo cards — primary input. Click toggles every chip in the
  // bundle on/off via toggleMoodCombo. Repaint reflects the new
  // selection state across both the combo grid (active highlight) and
  // the chip palette below (each chip's selected styling updates).
  const comboBtns = card.querySelectorAll(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-mood-combo]`);
  comboBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!id) return;
      await toggleMoodCombo(card, rec, id);
      repaint();
    });
  });

  // Report-card slider dots. Clicking a dot snaps the axis to that
  // position; clicking the currently-active dot resets to 0 (so the
  // user can untoggle an accidental click without scrolling for a
  // separate reset control).
  const axisDotBtns = card.querySelectorAll(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-axis-dot]`);
  axisDotBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const axisId = btn.dataset.axis;
      const targetPos = btn.dataset.pos;
      const axis = REACTION_AXES.find(a => a.id === axisId);
      if (!axis) return;
      const sel = new Set(STATE.reactions[rec.aniListId]?.tags || []);
      const currentPos = axisPositionFromChips(axis, sel);
      // Click-active-dot-to-reset shortcut: clicking the position the
      // axis is already at jumps to 0 (clears the axis chip).
      const finalPos = (targetPos === currentPos) ? '0' : targetPos;
      await setReactionAxis(card, rec, axisId, finalPos);
      repaint();
    });
  });

  // "Pick by specific reason" — toggles the advanced chip palette.
  const advToggle = card.querySelector(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-advanced-toggle]`);
  if (advToggle) {
    advToggle.addEventListener('click', () => {
      if (STATE.reactionAdvancedExpanded.has(rec.aniListId)) {
        STATE.reactionAdvancedExpanded.delete(rec.aniListId);
      } else {
        STATE.reactionAdvancedExpanded.add(rec.aniListId);
      }
      repaint();
    });
  }

  // Per-chip click inside a dropdown row. Same toggle semantics as the
  // in-panel chip button — pre-empts the row-level mousedown via
  // stopPropagation so clicking a single chip doesn't also fire the
  // "commit whole row" handler.
  const dropdownChipBtns = card.querySelectorAll(
    `[data-crsmart-reactions="${rec.aniListId}"] [data-crsmart-reaction-search-chip]`);
  dropdownChipBtns.forEach(btn => {
    btn.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.dataset.key;
      if (!key) return;
      await toggleReactionChip(card, rec, key);
      // Keep the dropdown open so users can pick another chip from the
      // same row without retyping; refresh against the same query so
      // checkmarks update for the chip they just toggled.
      const stillQuery = STATE.reactionSearch[rec.aniListId] || '';
      if (stillQuery) refreshDropdown(stillQuery);
      repaint(() => restoreFocus(searchInput?.value?.length ?? null));
    });
  });
}
