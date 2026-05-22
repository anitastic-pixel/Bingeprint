// Freeform-notes title → AniList ID resolver.
//
// Locked in the 2026-05-18 design grill (Q4 + tuning recommendation 1
// in BRAINSTORM-iterations.md). Three-layer match against a locally-
// built title index (aniListCache + aniListBridgeCache), AL Search
// fallback for misses, ambiguity routed to a low-confidence pile for
// the review screen.
//
// Public API:
//
//   buildTitleIndex(aniListCache, aniListBridgeCache) → TitleIndex
//     Pure. Walks both caches, normalizes every title/synonym, and
//     produces a Map keyed by normalized string → { aniListId,
//     sourceTitle, sourceField, format, seasonYear }. One AL ID
//     typically has multiple entries (english + romaji + native + each
//     synonym).
//
//   matchTitleLocal(rawTitle, index, opts) → MatchResult | null
//     Pure. Runs the 3-layer gate:
//       Layer 1 — exact normalized match (any synonym/title) → 1.0
//       Layer 2 — acronym (first-letter expansion) for short single-
//                 token queries (≤8 chars) → 0.95
//       Layer 3 — Levenshtein ratio ≥0.85 AND next-best ≥0.05 behind
//                 → confidence = ratio
//     Returns null if no layer accepts. Layer 3 with ambiguity (two
//     candidates within 0.05) returns a MatchResult with
//     `ambiguous: true` and `candidates: [...]` so the orchestrator
//     can route to the low-confidence pile.
//
//   resolveFreeformList({ rows, index, searchFn, signal }) → Promise<{
//     matched, lowConfidence, unmatched
//   }>
//     Async orchestration. For each row, matchTitleLocal; on miss/low-
//     confidence, optionally call searchFn (DI'd by the caller — usually
//     from anilist.js). Returns three arrays the import surface
//     consumes directly.
//
// Levenshtein helper is lifted from vibe-tags.js (bounded-distance
// with row-min early-exit). Copied here rather than imported to keep
// the matcher's dependency graph minimal — same 20 lines, identical
// behavior, easier to test in isolation.

// ── Title normalization ─────────────────────────────────────────────
//
// The goal: two titles that a human would call "the same" should
// produce the same normalized string. Aggressive but not destructive —
// after normalization we still distinguish "Tokyo Ghoul" from "Tokyo
// Ghoul:re", because the suffix carries different alphabetic content.
//
// Steps:
//   1. Lowercase.
//   2. Replace separator runs (`:` `·` `−` `–` `—` `-` `~` `,`)
//      with a single space. Different separators are equivalent for
//      title-matching purposes ("Code Geass: Lelouch" ≡ "Code Geass -
//      Lelouch").
//   3. Strip punctuation that humans don't pronounce (`!?'".()[]…`).
//   4. Collapse whitespace runs to a single space.
//   5. Trim.
//
// We intentionally PRESERVE letters, digits, and the basic alphabet —
// "Re:Zero" and "Re Zero" become "re zero", but "Re:Zero" and "Reizero"
// stay distinct.
const SEP_RUN_RE = /[:;·−–—\-~,]+/g;
const PUNCT_RE = /[!?"'`’“”\.\(\)\[\]\…/\\|]+/g;
const WS_RE = /\s+/g;

export function normalizeTitle(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(SEP_RUN_RE, ' ')
    .replace(PUNCT_RE, '')
    .replace(WS_RE, ' ')
    .trim();
}

// ── Acronym helper ──────────────────────────────────────────────────
//
// "FMAB" → first letters of "Fullmetal Alchemist Brotherhood".
// Implementation tokenizes on whitespace (post-normalization), drops
// stopwords ("the","a","an","of","and","to","in","on"), then takes the
// initial of each remaining word. Returns the uppercase acronym string.
//
// Stopword list is intentionally small — anime titles aren't English
// sentences, so most short words ARE significant ("To Aru Majutsu no
// Index" → TAMNI, not TAMI).
const ACRONYM_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'on']);

export function acronymOf(normalizedTitle) {
  if (!normalizedTitle) return '';
  const words = normalizedTitle.split(' ').filter(Boolean);
  let out = '';
  for (const w of words) {
    if (ACRONYM_STOPWORDS.has(w)) continue;
    out += w[0];
  }
  return out.toUpperCase();
}

// ── Bounded Damerau-Levenshtein ─────────────────────────────────────
//
// Lifted from vibe-tags.js:261 (Levenshtein), then upgraded 2026-05-19
// to Damerau-Levenshtein: counts a single adjacent transposition as
// ONE edit instead of two. The original Levenshtein scored
// "Sgaa" vs "Saga" as distance 2 (two substitutions), giving ratio
// 0.833 — just below the 0.85 accept threshold for "Vinland Sgaa"
// vs "Vinland Saga". With transposition costing 1, the same typo
// scores ratio 0.917, comfortably above threshold. Catches the
// large class of single-char-swap typos people actually make
// without inflating false-positive rate (the algorithm still
// requires character ADJACENCY for the swap discount).
//
// Returns the edit distance if ≤ max, else null. Early-exits via
// row-min check. The transposition branch adds one Math.min term
// per cell when prior cells exist — same O(MN) complexity.
export function levenshteinAtMost(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return null;
  // Need TWO previous rows now so adjacent-transposition can read
  // a[i-2] vs b[j-1] and a[i-1] vs b[j-2]. prev2 = i-2 row, prev = i-1 row.
  let prev2 = null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const curr = new Array(lb + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      // Damerau adjacent-transposition: if the two chars swapped match
      // their counterparts, the transposition costs 1 (not 2 substitutions).
      if (
        i >= 2 && j >= 2 &&
        a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
      ) {
        best = Math.min(best, prev2[j - 2] + 1);
      }
      curr[j] = best;
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return null;
    prev2 = prev;
    prev = curr;
  }
  return prev[lb] <= max ? prev[lb] : null;
}

// Convert a Levenshtein distance + the two compared lengths into a
// similarity ratio in [0, 1]. 1.0 = identical; 0.0 = totally different.
function lvRatio(distance, lenA, lenB) {
  const max = Math.max(lenA, lenB);
  if (max === 0) return 1;
  return 1 - distance / max;
}

// ── Index construction ──────────────────────────────────────────────
//
// Walks both caches in one pass. The bridge cache (AL-id-keyed) is
// authoritative for the AL-side projection; the CR-id-keyed cache is a
// CR↔AL mapping that often holds the same projection under a different
// key. Either source contributes title strings if present.
//
// One AL ID typically yields 3–5+ index entries (english, romaji,
// native, plus each synonym). All map back to the same aniListId so
// downstream collation is trivial.
//
// Index shape:
//   {
//     entries: Map<normalizedString, IndexEntry[]>,
//       // multiple entries per key when distinct AL IDs share a title
//     byAniListId: Map<aniListId, {
//       titles: Set<normalizedString>, format, seasonYear,
//       displayTitle: string
//     }>,
//     all: IndexEntry[],
//       // flat list for Layer 3 scans; deduplicated by
//       // (aniListId, normalizedString) so each title→ID pair appears once
//     acronymToIds: Map<acronym, Set<aniListId>>,
//       // pre-computed Layer-2 lookup table (2026-05-19 speed win):
//       // Layer 2 used to call acronymOf() per index.all entry on every
//       // query — for the user's ~3000-entry cache that's 3000 string ops
//       // per matched row. Stamping acronymOf at index-build time turns
//       // Layer 2 into an O(1) Map.get + Set-iterate.
//   }
//
// IndexEntry = { normalized, aniListId, sourceTitle, sourceField,
//                format, seasonYear }
export function buildTitleIndex(aniListCache, aniListBridgeCache) {
  const entries = new Map();
  const byAniListId = new Map();
  const all = [];
  const acronymToIds = new Map();
  const seen = new Set(); // dedup `${aniListId}|${normalized}`

  function addEntry(aniListId, sourceTitle, sourceField, format, seasonYear) {
    if (!aniListId || !sourceTitle) return;
    const normalized = normalizeTitle(sourceTitle);
    if (!normalized) return;
    const dedupKey = `${aniListId}|${normalized}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    const entry = { normalized, aniListId, sourceTitle, sourceField, format, seasonYear };
    all.push(entry);

    if (!entries.has(normalized)) entries.set(normalized, []);
    entries.get(normalized).push(entry);

    if (!byAniListId.has(aniListId)) {
      byAniListId.set(aniListId, {
        titles: new Set(),
        format,
        seasonYear,
        displayTitle: sourceTitle,
      });
    }
    byAniListId.get(aniListId).titles.add(normalized);

    // Pre-compute acronym for Layer 2 lookup. Same letter → many AL IDs
    // is expected (FMA matches both AL 121 "Fullmetal Alchemist" and any
    // other show whose first-letter-of-each-significant-word is "FMA").
    const acronym = acronymOf(normalized);
    if (acronym && acronym.length >= 2) {
      if (!acronymToIds.has(acronym)) acronymToIds.set(acronym, new Set());
      acronymToIds.get(acronym).add(aniListId);
    }
  }

  function walkCache(cache) {
    if (!cache || typeof cache !== 'object') return;
    for (const v of Object.values(cache)) {
      if (!v || typeof v !== 'object') continue;
      const aniListId = v.aniListId || v.id;
      if (!aniListId) continue;
      const format = v.format || null;
      const seasonYear = v.seasonYear || (v.startDate && v.startDate.year) || null;
      const t = v.title || {};
      addEntry(aniListId, t.english, 'english', format, seasonYear);
      addEntry(aniListId, t.romaji, 'romaji', format, seasonYear);
      addEntry(aniListId, t.native, 'native', format, seasonYear);
      const syns = Array.isArray(v.synonyms) ? v.synonyms : [];
      for (const syn of syns) addEntry(aniListId, syn, 'synonym', format, seasonYear);
    }
  }

  walkCache(aniListCache);
  walkCache(aniListBridgeCache);

  return { entries, byAniListId, all, acronymToIds };
}

// ── Comment-strip fallback (P1.1 + P2.2, 2026-05-19 walkthrough) ───
//
// Real-people note pattern: "Vinland Saga — Thorfinn arc is genuinely
// transformative". The em-dash separates the title from a freeform
// comment. The matcher's local layers see "vinland saga thorfinn arc
// is genuinely transformative" — Levenshtein distance to "vinland saga"
// is huge, no match.
//
// This helper returns a comment-stripped variant of the title when one
// looks plausible, or null when the title appears comment-free.
// Called from resolveFreeformList as a fallback ONLY when the standard
// match fails — never alters the happy path, never strips legitimate
// long titles like "Re:Zero kara Hajimeru Isekai Seikatsu".
//
// Heuristics, ordered:
//   1. " — " / " - " / " : " mid-title with ≥2-word suffix containing
//      a function word → strip the suffix.
//   2. " (...) " or " [...] " with ≥3-word content OR containing a
//      function word → strip the paren content.
//
// Function-word set deliberately small: comments tend to be English
// prose with these connective tokens; anime titles rarely have them
// EXCEPT inside long-form franchise names (which usually have at most
// "of" / "the" / "and" — covered by the ≥3-words gate so "Lelouch of
// the Rebellion" stays).
// Comment-shape lexicon — connectors, adverbs, narrative markers.
// Deliberately excludes score-adjacent words (peak/mid/slop/good/bad/
// best/worst) since those are captured upstream by detectWordScoreInText
// and would redact before the comment-strip fallback ever runs.
const COMMENT_FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were',
  'after', 'before', 'during', 'while',
  'but', 'and', 'or', 'because',
  'genuinely', 'really', 'truly', 'pretty',
  'arc', 'season', 'part',
]);
function looksLikeComment(text) {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // ≥2 words after a separator is overwhelmingly a comment in real
  // notes — titles rarely sit after an em-dash. Loosened from ≥3
  // 2026-05-19 walkthrough re-test which still saw misses like "too
  // edgy" / "peaks in" with the strict gate.
  if (words.length >= 2) return true;
  // Single word: comment ONLY if it's lowercase and not a known
  // score-word (peak/mid/slop are already caught upstream as
  // word-scores, so they shouldn't reach this fallback — but defensive).
  // Capitalized single words like "Brotherhood" or "Peak" stay; the
  // matcher tries them as alt titles.
  const onlyWord = words[0];
  if (onlyWord && /^[a-z]/.test(onlyWord)) return true;
  // Function word fallback for 1-word capitalized cases that still
  // smell comment-y (rare; defensive).
  if (onlyWord && COMMENT_FUNCTION_WORDS.has(onlyWord.toLowerCase())) return true;
  return false;
}

function stripCommentSuffix(title) {
  if (!title) return null;
  // Try mid-line separator splits — em-dash, en-dash, double-hyphen,
  // single hyphen with spaces, colon with spaces.
  const SEP_RE = /\s+[—–]\s+|\s+--\s+|\s+-\s+|\s+:\s+/;
  const sepMatch = SEP_RE.exec(title);
  if (sepMatch) {
    const prefix = title.slice(0, sepMatch.index).trim();
    const suffix = title.slice(sepMatch.index + sepMatch[0].length).trim();
    if (prefix && looksLikeComment(suffix)) {
      return prefix;
    }
  }
  // Try paren-content stripping. Year-hint redaction already handled
  // 4-digit year parens at the parser layer; what's left here is
  // free-text in parens.
  const PAREN_RE = /\s*[\(\[]([^\)\]]+)[\)\]]\s*/g;
  let stripped = title;
  let changed = false;
  let m;
  while ((m = PAREN_RE.exec(title)) !== null) {
    const inner = m[1].trim();
    const words = inner.split(/\s+/).filter(Boolean);
    if (words.length >= 3 || looksLikeComment(inner)) {
      stripped = stripped.replace(m[0], ' ');
      changed = true;
    }
  }
  if (changed) {
    return stripped.replace(/\s+/g, ' ').trim();
  }
  return null;
}

// ── Local match (3-layer gate) ──────────────────────────────────────

const ACCEPT_RATIO = 0.85;
const AMBIGUITY_GAP = 0.05;
const ACRONYM_MAX_LEN = 8;

export function matchTitleLocal(rawTitle, index, opts = {}) {
  const acceptRatio = typeof opts.acceptRatio === 'number' ? opts.acceptRatio : ACCEPT_RATIO;
  const ambiguityGap = typeof opts.ambiguityGap === 'number' ? opts.ambiguityGap : AMBIGUITY_GAP;
  // Year hint from the parser ("Bleach (2022)" → 2022). When provided,
  // it disambiguates exact-title collisions (e.g. Berserk 1997 vs 2016)
  // and tiebreaks the Levenshtein ambiguity-gap branch. null = no hint.
  const yearHint = typeof opts.yearHint === 'number' && opts.yearHint > 0
    ? opts.yearHint
    : null;
  const normalized = normalizeTitle(rawTitle);
  if (!normalized || !index) return null;

  // Layer 1 — exact normalized match.
  if (index.entries.has(normalized)) {
    const hits = index.entries.get(normalized);
    // If multiple AL IDs share this normalized title, it's ambiguous
    // (rare — e.g. "Air" might be the 2005 KyoAni vs. a different
    // entry; or Berserk 1997 vs 2016). Year hint can tiebreak.
    const distinctIds = new Set(hits.map((h) => h.aniListId));
    if (distinctIds.size === 1) {
      const h = hits[0];
      return {
        aniListId: h.aniListId,
        confidence: 1.0,
        matchedVia: 'exact',
        matchedTitle: h.sourceTitle,
        candidates: null,
        ambiguous: false,
      };
    }
    // Multiple distinct AL IDs. Year hint disambiguation: if one
    // candidate's seasonYear matches the user's hint, pick it.
    if (yearHint) {
      const yearMatch = [...new Set(hits.filter(h => h.seasonYear === yearHint).map(h => h.aniListId))];
      if (yearMatch.length === 1) {
        const winner = hits.find(h => h.aniListId === yearMatch[0]);
        return {
          aniListId: winner.aniListId,
          confidence: 0.97,
          matchedVia: 'exact-year-disambiguated',
          matchedTitle: winner.sourceTitle,
          candidates: null,
          ambiguous: false,
        };
      }
    }
    return {
      aniListId: null,
      confidence: 0.7,
      matchedVia: 'exact-ambiguous',
      matchedTitle: null,
      candidates: hits.map((h) => ({
        aniListId: h.aniListId,
        title: h.sourceTitle,
        format: h.format,
        seasonYear: h.seasonYear,
      })),
      ambiguous: true,
    };
  }

  // Layer 2 — acronym match (single-token short query).
  // Uses the pre-computed acronymToIds map (2026-05-19 speed win):
  // O(1) Map.get + Set-iterate instead of scanning index.all and
  // recomputing acronymOf per entry. Falls back gracefully when the
  // map is absent (older index shape, defensive — buildTitleIndex
  // always populates it now).
  const isSingleShort =
    !normalized.includes(' ') && normalized.length >= 2 && normalized.length <= ACRONYM_MAX_LEN;
  if (isSingleShort && index.acronymToIds) {
    const queryAcronym = normalized.toUpperCase();
    const idSet = index.acronymToIds.get(queryAcronym);
    if (idSet && idSet.size > 0) {
      // Resolve back to representative entries via byAniListId.
      const acronymHits = [];
      for (const aniListId of idSet) {
        const byId = index.byAniListId.get(aniListId);
        if (!byId) continue;
        acronymHits.push({
          aniListId,
          sourceTitle: byId.displayTitle,
          format: byId.format,
          seasonYear: byId.seasonYear,
        });
      }
      if (acronymHits.length === 1) {
        const h = acronymHits[0];
        return {
          aniListId: h.aniListId,
          confidence: 0.95,
          matchedVia: 'acronym',
          matchedTitle: h.sourceTitle,
          candidates: null,
          ambiguous: false,
        };
      }
      if (acronymHits.length > 1) {
        return {
          aniListId: null,
          confidence: 0.7,
          matchedVia: 'acronym-ambiguous',
          matchedTitle: null,
          candidates: acronymHits.map((h) => ({
            aniListId: h.aniListId,
            title: h.sourceTitle,
            format: h.format,
            seasonYear: h.seasonYear,
          })),
          ambiguous: true,
        };
      }
    }
  }

  // Layer 3 — Levenshtein ratio, with ambiguity check.
  const queryLen = normalized.length;
  // Compute maxAllowedDist such that lvRatio(d, queryLen, idxLen) >=
  // acceptRatio is possible. d <= (1 - acceptRatio) * max(qLen, iLen).
  // We bound the inner Levenshtein call by this distance for early-exit.
  let best = null;     // { entry, ratio, distance }
  let secondBest = null;
  const seenIds = new Map(); // aniListId → best (entry, ratio) for that ID

  for (const entry of index.all) {
    const idxLen = entry.normalized.length;
    const lenDelta = Math.abs(idxLen - queryLen);
    // Pre-filter: if lengths differ by more than (1-acceptRatio) * max,
    // even a zero-substitution Levenshtein can't reach the ratio.
    const maxLen = Math.max(idxLen, queryLen);
    const maxAllowedDist = Math.floor((1 - acceptRatio) * maxLen);
    if (lenDelta > maxAllowedDist) continue;
    const d = levenshteinAtMost(normalized, entry.normalized, maxAllowedDist);
    if (d === null) continue;
    const ratio = lvRatio(d, queryLen, idxLen);
    // Dedup per aniListId — keep the best ratio across that ID's titles.
    const existing = seenIds.get(entry.aniListId);
    if (existing && existing.ratio >= ratio) continue;
    seenIds.set(entry.aniListId, { entry, ratio, distance: d });
  }

  // Collect best + second-best across distinct AL IDs.
  for (const v of seenIds.values()) {
    if (!best || v.ratio > best.ratio) {
      secondBest = best;
      best = v;
    } else if (!secondBest || v.ratio > secondBest.ratio) {
      secondBest = v;
    }
  }

  if (!best || best.ratio < acceptRatio) {
    // Below acceptance — surface near-misses as candidates for the
    // review screen if any made it past the pre-filter.
    const candidates = [...seenIds.values()]
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 3)
      .map((v) => ({
        aniListId: v.entry.aniListId,
        title: v.entry.sourceTitle,
        format: v.entry.format,
        seasonYear: v.entry.seasonYear,
        confidence: +v.ratio.toFixed(3),
      }));
    if (candidates.length === 0) return null;
    return {
      aniListId: null,
      confidence: candidates[0].confidence,
      matchedVia: 'levenshtein-below-threshold',
      matchedTitle: null,
      candidates,
      ambiguous: false,
    };
  }

  // We have a winner above threshold. Check ambiguity gap.
  if (secondBest && best.ratio - secondBest.ratio < ambiguityGap) {
    // Year-hint tiebreaker: if the user's hint matches exactly one of
    // the two close candidates, that candidate wins outright (don't
    // need the user to pick from the review pile).
    if (yearHint) {
      const bestYearMatches = best.entry.seasonYear === yearHint;
      const secondYearMatches = secondBest.entry.seasonYear === yearHint;
      if (bestYearMatches && !secondYearMatches) {
        return {
          aniListId: best.entry.aniListId,
          confidence: +Math.min(0.95, best.ratio + 0.05).toFixed(3),
          matchedVia: 'levenshtein-year-disambiguated',
          matchedTitle: best.entry.sourceTitle,
          candidates: null,
          ambiguous: false,
        };
      }
      if (secondYearMatches && !bestYearMatches) {
        return {
          aniListId: secondBest.entry.aniListId,
          confidence: +Math.min(0.95, secondBest.ratio + 0.05).toFixed(3),
          matchedVia: 'levenshtein-year-disambiguated',
          matchedTitle: secondBest.entry.sourceTitle,
          candidates: null,
          ambiguous: false,
        };
      }
    }
    return {
      aniListId: null,
      confidence: +best.ratio.toFixed(3),
      matchedVia: 'levenshtein-ambiguous',
      matchedTitle: null,
      candidates: [
        {
          aniListId: best.entry.aniListId,
          title: best.entry.sourceTitle,
          format: best.entry.format,
          seasonYear: best.entry.seasonYear,
          confidence: +best.ratio.toFixed(3),
        },
        {
          aniListId: secondBest.entry.aniListId,
          title: secondBest.entry.sourceTitle,
          format: secondBest.entry.format,
          seasonYear: secondBest.entry.seasonYear,
          confidence: +secondBest.ratio.toFixed(3),
        },
      ],
      ambiguous: true,
    };
  }

  return {
    aniListId: best.entry.aniListId,
    confidence: +best.ratio.toFixed(3),
    matchedVia: 'levenshtein',
    matchedTitle: best.entry.sourceTitle,
    candidates: null,
    ambiguous: false,
  };
}

// ── Orchestration over a parsed list ────────────────────────────────
//
// Public entry for the importer flow. Walks parsed rows, applies
// matchTitleLocal first, and for rows that miss locally OR are
// ambiguous, optionally calls searchFn (DI from the orchestrator —
// typically a thin wrapper around anilist.js's search). Search misses
// also route to unmatched.
//
// searchFn signature:
//   searchFn(titleString, opts) → Promise<SearchResult[]>
//   SearchResult = { aniListId, title, format, seasonYear, synonyms? }
//
// signal: optional AbortSignal — if aborted, the function resolves
// early with whatever has been processed so far. The signal is passed
// through to searchFn so the underlying HTTP request can also bail.
//
// Categorization rules:
//   - confidence === 1.0 → matched
//   - confidence >= 0.85 AND !ambiguous → matched
//   - has candidates but ambiguous OR below threshold → lowConfidence
//   - nothing local + no searchFn match → unmatched
//
// Output shape:
//   {
//     matched:       [{ row, aniListId, confidence, matchedVia, matchedTitle }],
//     lowConfidence: [{ row, candidates, attemptedVia }],
//     unmatched:     [{ row, attempted: ['local', 'al-search'] }]
//   }
export async function resolveFreeformList({ rows, index, searchFn = null, signal = null, onProgress = null } = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError('resolveFreeformList: rows must be an array');
  }
  const matched = [];
  const lowConfidence = [];
  const unmatched = [];
  let progressCount = 0;
  const reportProgress = () => {
    if (typeof onProgress !== 'function') return;
    try { onProgress({ i: progressCount, total: rows.length, phase: 'matching' }); }
    catch { /* UI hook misbehavior shouldn't kill the import */ }
  };

  // In-flight dedup (Bundle A, 2026-05-19): two rows resolving to the
  // same normalized query share a single searchFn call. Map<normalized
  // → Promise<results>>. Saves N×latency when the user pastes the same
  // title twice (rare in raw notes, common in cleaned-up lists where
  // someone copied across seasons).
  const inFlightSearches = new Map();
  const dedupedSearch = (titleRaw) => {
    if (!searchFn) return Promise.resolve([]);
    const key = normalizeTitle(titleRaw) || titleRaw;
    if (inFlightSearches.has(key)) return inFlightSearches.get(key);
    const p = (async () => {
      try {
        return (await searchFn(titleRaw, { signal })) || [];
      } catch {
        return [];
      }
    })();
    inFlightSearches.set(key, p);
    return p;
  };

  // Pass 1: local match per row. Clean hits finalize immediately;
  // misses kick off a dedup'd searchFn promise and queue the row for
  // pass 2. Pipelined parallelism (Bundle A): all searchFn promises
  // fire from this loop without awaiting, so the SW's paced gateway
  // can overlap response latency with the next request's 800ms wait.
  // On a 30-show miss list with ~500ms AL latency, this saves ~15s
  // wall-clock vs the prior sequential-await shape.
  const pendingSearch = [];
  for (let i = 0; i < rows.length; i++) {
    if (signal && signal.aborted) break;
    const row = rows[i];

    let local = matchTitleLocal(row.titleRaw, index, { yearHint: row.yearHint });

    // Comment-strip fallback (P1.1, 2026-05-19): if the standard match
    // fails or yields low confidence, retry with a comment-stripped
    // variant of the title. "Vinland Saga — Thorfinn arc is genuinely
    // transformative" → retry with just "Vinland Saga". Only kicks in
    // when the first attempt didn't get a clean hit, so it can't
    // corrupt happy-path matching.
    const standardWeak = !local || !local.aniListId
      || local.confidence < ACCEPT_RATIO || local.ambiguous;
    if (standardWeak) {
      const stripped = stripCommentSuffix(row.titleRaw);
      if (stripped && stripped !== row.titleRaw) {
        const localRetry = matchTitleLocal(stripped, index, { yearHint: row.yearHint });
        if (localRetry && localRetry.aniListId
            && localRetry.confidence >= ACCEPT_RATIO && !localRetry.ambiguous) {
          local = localRetry; // promote the stripped-variant match
        }
      }
    }

    // Accept clean local hits without round-tripping AL.
    if (local && local.aniListId && local.confidence >= ACCEPT_RATIO && !local.ambiguous) {
      matched.push({
        row,
        aniListId: local.aniListId,
        confidence: local.confidence,
        matchedVia: local.matchedVia === 'exact' ? 'freeform-local-exact'
          : local.matchedVia === 'acronym' ? 'freeform-local-acronym'
          : local.matchedVia === 'exact-year-disambiguated'
            || local.matchedVia === 'levenshtein-year-disambiguated'
            ? 'freeform-local-year'
          : 'freeform-local-fuzz',
        matchedTitle: local.matchedTitle,
      });
      progressCount += 1;
      reportProgress();
      continue;
    }

    // Local miss or ambiguous: schedule an AL Search (deduped) and
    // park the row for pass 2. Use the comment-stripped variant as the
    // search query when available — gives AL a cleaner string to match
    // against and avoids burning quota on "long-title-with-comments"
    // queries that AL's search ranks poorly.
    const searchQuery = stripCommentSuffix(row.titleRaw) || row.titleRaw;
    pendingSearch.push({ row, local, searchPromise: dedupedSearch(searchQuery) });
  }

  // Pass 2: await each pending search and classify. Sequential await
  // preserves the per-row progress signal; promises themselves already
  // executed in parallel during pass 1 so the wait time here is
  // dominated by the longest-running search, not the sum.
  for (const { row, local, searchPromise } of pendingSearch) {
    if (signal && signal.aborted) break;
    const searchResults = await searchPromise;

    // If AL Search returned a confident top hit, prefer it.
    if (Array.isArray(searchResults) && searchResults.length > 0) {
      const top = searchResults[0];
      const second = searchResults[1] || null;
      // Confidence assignment: AL's own search ranking is the signal.
      // If there's a clear top-1 with no near-tie, give 0.92 (below
      // exact/acronym; above the Levenshtein floor). If close, route
      // to low-confidence with the top-3.
      const closeRunnerUp = second &&
        normalizeTitle(top.title?.romaji || top.title?.english || top.title || '') ===
        normalizeTitle(second.title?.romaji || second.title?.english || second.title || '');
      if (top.aniListId && !closeRunnerUp) {
        matched.push({
          row,
          aniListId: top.aniListId,
          confidence: 0.92,
          matchedVia: 'freeform-al-search',
          matchedTitle: top.title?.romaji || top.title?.english || top.title || row.titleRaw,
        });
        progressCount += 1;
        reportProgress();
        continue;
      }
      // Multiple close hits → low-confidence with AL's top-3.
      lowConfidence.push({
        row,
        candidates: searchResults.slice(0, 3).map((s) => ({
          aniListId: s.aniListId,
          title: s.title?.romaji || s.title?.english || s.title || '',
          format: s.format || null,
          seasonYear: s.seasonYear || null,
          confidence: null,
        })),
        attemptedVia: ['local', 'al-search'],
      });
      progressCount += 1;
      reportProgress();
      continue;
    }

    // No AL match. If local had near-misses to show, route to
    // low-confidence; otherwise unmatched.
    if (local && Array.isArray(local.candidates) && local.candidates.length > 0) {
      lowConfidence.push({
        row,
        candidates: local.candidates,
        attemptedVia: searchFn ? ['local', 'al-search'] : ['local'],
      });
    } else {
      unmatched.push({
        row,
        attempted: searchFn ? ['local', 'al-search'] : ['local'],
      });
    }
    progressCount += 1;
    reportProgress();
  }

  return { matched, lowConfidence, unmatched };
}

// ── Internal exports for tests ──────────────────────────────────────
export const _internals = Object.freeze({
  normalizeTitle,
  acronymOf,
  levenshteinAtMost,
  lvRatio,
  stripCommentSuffix,
  looksLikeComment,
  ACCEPT_RATIO,
  AMBIGUITY_GAP,
  ACRONYM_MAX_LEN,
  ACRONYM_STOPWORDS,
});
