// Freeform-notes parser — pure, no IPC/no network.
//
// Locked in the 2026-05-18 design grill (see BRAINSTORM-iterations.md):
// users without MAL/AL accounts who keep a watch list in plain text,
// a Notes-app file, or a spreadsheet paste their list into the
// import-freeform surface; this module:
//
//   1. sniffFreeformInput(rawText) → SnifferReport
//      Histogram-style analysis of the input. Detects dominant
//      delimiter, score scale (10pt / 5pt / 5-star / S-tier / word /
//      none), status-word frequency, markdown-header-as-state pattern.
//      Returns a report the UI's confirmation step renders as pre-filled
//      answers (user clicks Continue or overrides).
//
//   2. parseFreeformInput(rawText, options) → ParsedRow[]
//      Given the user-confirmed options, parse to structured rows:
//        { titleRaw, status, score, scoreOriginal, scoreScale,
//          isFavorite, userTagsFromImport, lineNumber, lineRaw }
//      Status is one of watching/completed/paused/dropped/planning (the
//      same vocab mal-xml.js produces). Score normalized to 0–10
//      internally; scoreOriginal preserves the user-visible token.
//      isFavorite is orthogonal to status — "loved" can co-occur with
//      any status.
//
// Out of scope per Q12 of the grill:
//   - photos/OCR, voice memos, prose paragraphs, cloud-doc URLs, PDFs
//   - per-episode granularity (per-season is fine)
//
// Module shape (ESM) mirrors mal-xml.js — the eventual UI page loads
// via <script type="module">. No chrome.* calls. Easily unit-testable
// from Node via dynamic import.

// ── Output vocab (mirrors mal-xml.js MAL_XML_STATUS_NORMALIZE) ───────
//
// Status names are the canonical 5 the rest of the pipeline already
// consumes; engines downstream don't need to learn a new vocabulary.
const STATUS_VOCAB = Object.freeze(['watching', 'completed', 'paused', 'dropped', 'planning']);

// ── Status word-pattern table ──────────────────────────────────────
//
// Each status maps to a regex matching any of its common written forms.
// Order matters for ambiguous tokens — checked top to bottom, first
// hit wins.
//
// "dropped" comes before "completed" because "dropped after completing
// season 1" should classify as dropped (the dropped token is the
// load-bearing signal). Same logic for "paused" — a "completed S1,
// paused S2" line is paused-leaning if read as a single show.
//
// "backlog"/"wishlist"/"queue" land in `planning` even though they
// sometimes get used loosely; "stalled"/"on-hold" stay in `paused`.
const FREEFORM_STATUS_VOCAB = Object.freeze({
  dropped:   /\b(dropped?|drop|quit|abandoned?|dnf|did[\s-]?not[\s-]?finish|nope|gave[\s-]?up|hated|noped\s+out)\b/i,
  paused:    /\b(paused?|on[\s-]?hold|on[\s-]?break|stalled?|hiatus|shelved)\b/i,
  planning:  /\b(plan(ning)?(\s+to\s+watch)?|ptw|to[\s-]?watch|want\s+to\s+watch|backlog(ged)?|wishlist|queue|will\s+watch)\b/i,
  watching:  /\b(watching|currently\s+watching|in\s+progress|in[\s-]?progress|ongoing|on[\s-]?going|airing\s+for\s+me)\b/i,
  completed: /\b(completed?|complete|done|finished|watched|seen|caught\s+up)\b/i,
});

// ── Favorite-signal table ──────────────────────────────────────────
//
// Orthogonal to status — "loved" + "completed" coexist on the same row.
// ♥ and ❤️ shapes covered; the bare ⭐ emoji is intentionally NOT here
// because it overlaps with 5-star scoring and would double-fire.
const FREEFORM_FAVORITE_PATTERNS = /\b(loved?|loving|fav(orite|ourite)?|favs?|🐐|goat\b)\b|❤️?|♥|💖|💯/i;

// ── Word-score table (minimal — Q10 of the grill) ──────────────────
//
// Universal anime-community tokens whose mapping is stable. The
// rejected-but-tempting set (fire/🔥, bad/trash, etc.) lives in the
// BRAINSTORM entry — don't add here without measuring real-input
// frequency first.
const FREEFORM_SCORE_VOCAB = Object.freeze([
  { token: /\bpeak(\s+fiction|\s+story)?\b/i, score: 10, label: 'peak' },
  { token: /\bmid\b/i,                         score: 5,  label: 'mid' },
  { token: /\bslop\b/i,                        score: 2,  label: 'slop' },
]);

// ── Tier-letter score map ──────────────────────────────────────────
//
// Activated only when the dominant scale is 'tier' (sniffer decides).
// + and - modifiers shift by 1 within the band, capped at [0, 10].
const TIER_SCORE_MAP = Object.freeze({ S: 10, A: 8, B: 6, C: 4, D: 2, F: 0 });

// ── Score-detection patterns ───────────────────────────────────────
//
// Ordered specific → general. detectScoreInLine returns the FIRST match,
// so the slash-form (10pt-slash) wins over bare-number when both could
// apply. Bare-number is last-resort and gated by sniffer positional
// consistency (parseFreeformInput won't even try it unless
// options.scoreScale === '10pt-bare' or similar).
const SCORE_PATTERNS = Object.freeze([
  {
    scale: '10pt-slash',
    regex: /\b(\d{1,2}(?:\.\d)?)\s*\/\s*10\b/,
    parse: (m) => clampScore(parseFloat(m[1])),
  },
  {
    scale: '5pt-slash',
    regex: /\b(\d(?:\.\d)?)\s*\/\s*5\b/,
    parse: (m) => clampScore(parseFloat(m[1]) * 2),
  },
  {
    scale: '5-star',
    regex: /(★+(?:½)?|⭐+)/,
    parse: (m) => {
      const stars = (m[1].match(/[★⭐]/g) || []).length;
      const half = /½/.test(m[1]) ? 0.5 : 0;
      return clampScore((stars + half) * 2);
    },
  },
  {
    // Two valid tier forms:
    //   (a) letter + +/- anywhere on the line (with delimiter context)
    //       — e.g. "A+ Show — best", "Show — A+"
    //   (b) bare letter only at end-of-line — e.g. "Show A", "Show A;"
    // Bare letters at line-start are NOT tier (would match title
    // initials: "A Show — 9" would incorrectly score 8). The
    // alternation enforces this asymmetry.
    scale: 'tier',
    regex: /(?:^|\s)([SABCDF])([+\-])(?=\s|$|[,;:|])|(?:^|\s)([SABCDF])(?=[,;:|]?\s*$)/,
    parse: (m) => {
      const letter = (m[1] || m[3] || '').toUpperCase();
      const mod = m[2] || '';
      const base = TIER_SCORE_MAP[letter];
      if (base === undefined) return null;
      const modAdjust = mod === '+' ? 1 : mod === '-' ? -1 : 0;
      return clampScore(base + modAdjust);
    },
  },
  // Bare number — gated; see parseFreeformInput.
  {
    scale: '10pt-bare',
    regex: /(?:^|[\s—\-:,|])(\d{1,2}(?:\.\d)?)(?=$|[\s,;|])/,
    parse: (m) => {
      const n = parseFloat(m[1]);
      if (!isFinite(n) || n < 0 || n > 10) return null;
      return clampScore(n);
    },
  },
]);

function clampScore(n) {
  if (!isFinite(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

// ── Line classification ────────────────────────────────────────────
//
// Splits raw text into typed lines:
//   - 'blank'   — empty / whitespace-only
//   - 'comment' — // or # at start (single-line comments)
//   - 'header'  — markdown heading (# / ## / ###) — may carry status
//                 inheritance for following lines
//   - 'item'    — content line (post bullet-marker strip)
//
// Returns array of { type, lineNumber, lineRaw, content?, headerStatus?,
// headerFavorite? } in source order.
function classifyLines(rawText) {
  const out = [];
  const lines = String(rawText || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineRaw = lines[i];
    const lineNumber = i + 1;
    const trimmed = lineRaw.trim();
    if (!trimmed) {
      out.push({ type: 'blank', lineNumber, lineRaw });
      continue;
    }
    if (/^(\/\/|#\s|#$)/.test(trimmed) && !/^#{1,6}\s+\S/.test(trimmed)) {
      // Bare `#` or `// foo` comments. A markdown header (`## Completed`)
      // has at least one non-space char after the #-run and falls through.
      if (trimmed.startsWith('//')) {
        out.push({ type: 'comment', lineNumber, lineRaw });
        continue;
      }
    }
    const headerMatch = /^(#{1,6})\s+(.*?)\s*$/.exec(trimmed);
    if (headerMatch) {
      const headerText = headerMatch[2];
      const headerStatus = detectStatusInText(headerText);
      const headerFavorite = FREEFORM_FAVORITE_PATTERNS.test(headerText)
        || /\b(favorites?|favourites?|favs?|loved)\b/i.test(headerText);
      out.push({
        type: 'header',
        lineNumber,
        lineRaw,
        headerText,
        headerStatus: headerStatus ? headerStatus.status : null,
        headerFavorite,
      });
      continue;
    }
    // Trailing-colon section label (no `##` prefix) — promote to
    // header. Catches "Completed:", "My S-tier:", "Favorites:",
    // "Best of 2024:" — section markers users write without markdown
    // syntax. P2b fix from the 2026-05-19 walkthrough: these used to
    // parse as item rows, producing 5 phantom unmatched entries in the
    // tier walkthrough. Bounded by `≤ 4 words` and `no digit-score
    // pattern` to avoid swallowing real titles that happen to end with
    // colon (rare — most anime use internal colons like "Re:Zero",
    // not trailing).
    const labelMatch = /^(.+?):\s*$/.exec(trimmed);
    if (labelMatch && stripBulletMarker(trimmed) === trimmed) {
      const labelText = labelMatch[1].trim();
      const wordCount = labelText.split(/\s+/).filter(Boolean).length;
      const hasScoreLikeDigits = /\b\d{1,2}\/(?:10|5)\b|\d{1,2}\s*$/.test(labelText);
      if (wordCount > 0 && wordCount <= 4 && !hasScoreLikeDigits) {
        const labelStatus = detectStatusInText(labelText);
        const labelFavorite = FREEFORM_FAVORITE_PATTERNS.test(labelText)
          || /\b(favorites?|favourites?|favs?|loved)\b/i.test(labelText);
        // Tier labels ("S-tier:", "A-tier:") carry no status and no
        // favorite — they become depth markers under the scope-start /
        // depth-marker rule, suppressing the phantom row without
        // affecting inheritance.
        out.push({
          type: 'header',
          lineNumber,
          lineRaw,
          headerText: labelText,
          headerStatus: labelStatus ? labelStatus.status : null,
          headerFavorite: labelFavorite,
        });
        continue;
      }
    }
    out.push({
      type: 'item',
      lineNumber,
      lineRaw,
      content: stripBulletMarker(trimmed),
    });
  }
  return out;
}

// Strip leading bullet markers / list numbering. Conservative — only
// removes well-known markers, never a hyphen that's part of the title.
function stripBulletMarker(s) {
  // - foo / * foo / + foo / • foo
  const bullet = /^[-*+•]\s+/.exec(s);
  if (bullet) return s.slice(bullet[0].length).trim();
  // 1. foo / 1) foo / 12. foo
  const numbered = /^\d{1,3}[.)]\s+/.exec(s);
  if (numbered) return s.slice(numbered[0].length).trim();
  return s;
}

// ── Per-line classifiers (return-or-null) ──────────────────────────

function detectStatusInText(text) {
  // Ordered iteration over STATUS_VOCAB keys — dropped/paused/planning
  // tried before completed/watching so "dropped after completing s1"
  // doesn't get mis-tagged. See vocab table comment.
  for (const status of ['dropped', 'paused', 'planning', 'watching', 'completed']) {
    const re = FREEFORM_STATUS_VOCAB[status];
    const m = re.exec(text);
    if (m) return { status, matchText: m[0], matchIndex: m.index };
  }
  return null;
}

function detectFavoriteInText(text) {
  const m = FREEFORM_FAVORITE_PATTERNS.exec(text);
  return m ? { matchText: m[0], matchIndex: m.index } : null;
}

// Find a single score match. Optionally restrict to one scale family —
// used by sniffFreeformInput's histogram pass where we want one
// canonical hit per line. Returns the first matching pattern in
// SCORE_PATTERNS order (specific → general).
function detectScoreInText(text, allowedScales = null) {
  for (const pat of SCORE_PATTERNS) {
    if (allowedScales && !allowedScales.includes(pat.scale)) continue;
    const m = pat.regex.exec(text);
    if (!m) continue;
    const score = pat.parse(m);
    if (score === null) continue;
    return {
      scale: pat.scale,
      score,
      scoreOriginal: extractScoreOriginal(pat, m),
      matchText: m[0],
      matchIndex: m.index,
    };
  }
  return null;
}

// Find EVERY score-pattern hit on a line. Used by parseFreeformInput
// so the title-redaction step can clear ALL recognized score tokens
// from the title — including ones from scales other than the dominant.
// Capture-vs-redaction are different problems (see 2026-05-19 grill);
// this function answers redaction, the caller picks capture.
//
// `allowBare` gates the 10pt-bare pattern only — bare numbers
// conflict with season numbers ("S3" / "ep 5") and require the user's
// dominant-scale confirmation. Other scales (slash/star/tier) are
// unambiguous; their patterns can't fire on incidental text.
function detectAllScoresInText(text, { allowBare = false } = {}) {
  const out = [];
  for (const pat of SCORE_PATTERNS) {
    if (pat.scale === '10pt-bare' && !allowBare) continue;
    // Use a fresh exec so each pattern starts from index 0 — regexes
    // here aren't /g so this is just a clean call.
    const m = pat.regex.exec(text);
    if (!m) continue;
    const score = pat.parse(m);
    if (score === null) continue;
    out.push({
      scale: pat.scale,
      score,
      scoreOriginal: extractScoreOriginal(pat, m),
      matchText: m[0],
      matchIndex: m.index,
    });
  }
  return out;
}

// Pull a clean display token for the user-facing "you wrote X" column.
// The slash + star regexes capture the meaningful chars in m[0]
// directly. The tier + bare-number patterns anchor on
// `(?:^|\s)` / `(?:^|[\s—\-:,|])`, so m[0] carries a leading separator
// that looks ugly when surfaced. Reconstruct from the inner groups for
// those two — keep things in m[0] for slash/star/word where m[0] is
// already clean. (P3 fix from the 2026-05-19 walkthrough.)
function extractScoreOriginal(pat, m) {
  if (pat.scale === 'tier') {
    // Dual-form regex: m[1]+m[2] for "letter+modifier" branch,
    // m[3] alone for "bare letter at end" branch.
    const letter = (m[1] || m[3] || '');
    const mod = m[2] || '';
    return `${letter}${mod}`;
  }
  if (pat.scale === '10pt-bare') {
    return m[1] || m[0].trim();
  }
  return m[0];
}

// Detect a leading tier-label prefix like "S+:", "A:", "B-:" — common
// in tier-list notes where the user prefixes each line/section with
// the tier and a colon. Example: "S: Steins;Gate, Mob Psycho 100".
// The bare-letter form of the main tier regex requires end-of-line,
// so this case slipped through. Captured as a tier score with the
// matching letter+modifier.
const TIER_PREFIX_RE = /^([SABCDF])([+\-]?)\s*:\s*/i;
function detectTierPrefixInText(text) {
  const m = TIER_PREFIX_RE.exec(text);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const mod = m[2] || '';
  const base = TIER_SCORE_MAP[letter];
  if (base === undefined) return null;
  const modAdjust = mod === '+' ? 1 : mod === '-' ? -1 : 0;
  return {
    scale: 'tier',
    score: clampScore(base + modAdjust),
    scoreOriginal: `${letter}${mod}`,
    matchText: m[0],
    matchIndex: 0,
  };
}

// Detect a leading date prefix like "2024-03-15 — " or "2024/03/15 - ".
// Common in Letterboxd-style logs and journal-style notes. The date
// itself is noise (the year ISN'T a year hint — it's a watch date, not
// a release year), so we redact the whole prefix including the trailing
// separator.
const DATE_PREFIX_RE = /^\d{4}[-\/]\d{2}[-\/]\d{2}\s*[—–\-:]?\s*/;
function detectDatePrefixInText(text) {
  const m = DATE_PREFIX_RE.exec(text);
  if (!m) return null;
  return { matchText: m[0], matchIndex: 0 };
}

// Detect a season suffix like "S2", "Season 3", "Final Season", "Part 1",
// "Cour 2". Common when users distinguish between seasons of the same
// franchise. The matcher generally indexes the franchise root, so
// stripping the season label exposes the bare title for matching;
// we keep the parsed season number on row.seasonHint so future
// surfaces can disambiguate if needed.
//
// Conservative match — must be at line END (after any score/status/
// favorite redaction, the title is what's left, and the season suffix
// is usually the last token). Avoids false-positives on titles that
// happen to contain "Part" or "Season" in the middle.
const SEASON_SUFFIX_RES = [
  { re: /\s+S(\d{1,2})\b\s*$/i, kind: 'sn' },
  { re: /\s+Season\s+(\d{1,2})\b\s*$/i, kind: 'season-n' },
  { re: /\s+Part\s+(\d{1,2})\b\s*$/i, kind: 'part-n' },
  { re: /\s+Cour\s+(\d{1,2})\b\s*$/i, kind: 'cour-n' },
  { re: /\s+Final\s+Season\s*$/i, kind: 'final', value: 99 },
];
function detectSeasonSuffixInText(text) {
  for (const { re, kind, value } of SEASON_SUFFIX_RES) {
    const m = re.exec(text);
    if (!m) continue;
    const season = typeof value === 'number' ? value : parseInt(m[1], 10);
    if (!Number.isInteger(season)) continue;
    return { season, kind, matchText: m[0], matchIndex: m.index };
  }
  return null;
}

// Detect a year hint in the line content — "Bleach (2022)", "Berserk
// [1997]", "Frieren 2023". Used as a tiebreaker by the matcher when
// multiple candidates fit equally well. Only counts years in the
// plausible anime range (1960–2030) so we don't false-positive on
// score-like 4-digit numbers (e.g., AL rank "1024").
//
// Returns { year: number, matchText, matchIndex } or null. The match
// includes any surrounding parens/brackets so title redaction strips
// the whole token, leaving the bare title behind.
// Two-pattern year-hint detection: parens/brackets first (high
// confidence — user explicitly framed a year), then bare-token form
// gated by the 1960-2030 range so anime-rating bare numbers (0-10)
// and AL-rank-style bare numbers can't false-positive.
const YEAR_HINT_PAREN_RE = /[\(\[](\d{4})[\)\]]/;
const YEAR_HINT_BARE_RE = /(?<=^|\s)(\d{4})(?=$|\s)/;
function detectYearHintInText(text) {
  // Prefer paren/bracket form when present — it redacts as a single
  // token including the brackets.
  const paren = YEAR_HINT_PAREN_RE.exec(text);
  if (paren) {
    const year = parseInt(paren[1], 10);
    if (Number.isInteger(year) && year >= 1960 && year <= 2030) {
      return { year, matchText: paren[0], matchIndex: paren.index };
    }
  }
  // Bare form: "Bleach 2022 - 9/10" → year=2022. The lookbehind /
  // lookahead don't consume surrounding chars so matchText is just
  // the digits — cleaner redaction.
  const bare = YEAR_HINT_BARE_RE.exec(text);
  if (bare) {
    const year = parseInt(bare[1], 10);
    if (Number.isInteger(year) && year >= 1960 && year <= 2030) {
      return { year, matchText: bare[1], matchIndex: bare.index };
    }
  }
  return null;
}

// Word-score scan — separate from numeric SCORE_PATTERNS because a
// word match is also a *status-adjacent* signal (peak/mid/slop tell us
// the user finished and felt strongly), but we don't want to fire
// status='completed' implicitly. The sniffer reports word-score
// frequency; the parser surfaces it as `score` + `scoreOriginal`.
function detectWordScoreInText(text) {
  for (const entry of FREEFORM_SCORE_VOCAB) {
    const m = entry.token.exec(text);
    if (m) {
      return {
        scale: 'word',
        score: entry.score,
        scoreOriginal: m[0],
        matchText: m[0],
        matchIndex: m.index,
        label: entry.label,
      };
    }
  }
  return null;
}

// ── Title extraction ────────────────────────────────────────────────
//
// Once score/status/favorite tokens are detected, anything left after
// removing them is the title candidate. Conservative: we replace each
// matched span with a single space, then collapse and trim.
function extractTitle(content, matches) {
  if (!content) return '';
  // Build an array of [start, end) ranges to redact, sorted desc by
  // start so splicing doesn't shift later indices.
  const ranges = matches
    .filter((m) => m && typeof m.matchIndex === 'number' && m.matchText)
    .map((m) => [m.matchIndex, m.matchIndex + m.matchText.length])
    .sort((a, b) => b[0] - a[0]);
  let out = content;
  for (const [start, end] of ranges) {
    out = out.slice(0, start) + ' ' + out.slice(end);
  }
  // Strip common separators left dangling at edges: — - : | , (and
  // adjacent whitespace).
  out = out.replace(/[\s\-—–:|,;]+$/g, '');
  out = out.replace(/^[\s\-—–:|,;]+/g, '');
  // Collapse internal whitespace runs.
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

// ── Sniffer ────────────────────────────────────────────────────────
//
// Public entry #1. Histogram pass that returns the dominant
// characteristics of the input so the UI can pre-fill the
// confirmation step.

export function sniffFreeformInput(rawText) {
  const classified = classifyLines(rawText);
  const items = classified.filter((l) => l.type === 'item');
  const headers = classified.filter((l) => l.type === 'header');

  const scoreScaleHits = { '10pt-slash': 0, '5pt-slash': 0, '5-star': 0, 'tier': 0, 'word': 0, '10pt-bare': 0 };
  const statusHits = { dropped: 0, paused: 0, planning: 0, watching: 0, completed: 0 };
  let favoriteHits = 0;
  // Bare-number positional gates — see promotion rules below. We
  // count two cases separately:
  //   - lastTokenHits: bare number is the last token on the line
  //                    (classic "Vinland Saga 9" pattern)
  //   - delimitedHits: bare number is bounded by a strong delimiter
  //                    (tab/comma/pipe) on both sides — this catches
  //                    column-structured input like CSV/TSV exports
  //                    where the score sits in a middle field. P1b
  //                    fix from the 2026-05-19 walkthrough.
  let bareNumberLastTokenHits = 0;
  let bareNumberDelimitedHits = 0;

  // Bare-number "anywhere a delimiter or whitespace bounds it" regex,
  // matching the parser's 10pt-bare pattern. We re-scan with this in
  // the sniffer (rather than reusing detectScoreInText) because we need
  // positional context (last-token? delimited?) that the single-match
  // helper drops.
  const BARE_NUM_RE = /(?:^|[\s—\-:,|\t])(\d{1,2}(?:\.\d)?)(?=$|[\s,;|\t])/;
  const STRONG_DELIM_RE = /[\t,|]/; // tab / comma / pipe — column markers

  for (const line of items) {
    const score = detectScoreInText(line.content);
    if (score) scoreScaleHits[score.scale] = (scoreScaleHits[score.scale] || 0) + 1;
    const word = detectWordScoreInText(line.content);
    if (word) scoreScaleHits.word += 1;
    const status = detectStatusInText(line.content);
    if (status) statusHits[status.status] = (statusHits[status.status] || 0) + 1;
    if (detectFavoriteInText(line.content)) favoriteHits += 1;

    // Bare-number positional check — for the 10pt-bare gate.
    const bareMatch = BARE_NUM_RE.exec(line.content);
    if (bareMatch) {
      const n = parseFloat(bareMatch[1]);
      if (isFinite(n) && n >= 0 && n <= 10) {
        // The bare-number regex's leading anchor `(?:^|[\s—\-:,|\t])`
        // consumes the delimiter character INTO matchText (m[0]) when
        // not at line start. So the digit's true start is one past
        // matchIndex unless matchText begins with the digit itself
        // (i.e., the line started with the number).
        const digitsAt = /^\d/.test(bareMatch[0])
          ? bareMatch.index
          : bareMatch.index + 1;
        const digitsEnd = digitsAt + bareMatch[1].length;
        const charBefore = digitsAt > 0 ? line.content[digitsAt - 1] : null;
        const charAfter = digitsEnd < line.content.length ? line.content[digitsEnd] : null;
        const tail = line.content.slice(digitsEnd).trim();
        if (!tail) {
          // Last-token: "Vinland Saga 9"
          bareNumberLastTokenHits += 1;
        } else if (
          charBefore && STRONG_DELIM_RE.test(charBefore) &&
          charAfter && STRONG_DELIM_RE.test(charAfter)
        ) {
          // Delimiter-bounded on both sides — looks like a middle
          // column in CSV/TSV: "Vinland Saga,9,completed".
          bareNumberDelimitedHits += 1;
        }
      }
    }
  }

  // Pick dominant non-bare scale (slash/star/tier/word). Bare is only
  // accepted if it's positionally consistent AND no stronger signal
  // dominates.
  const strongScales = ['10pt-slash', '5pt-slash', '5-star', 'tier', 'word'];
  let dominantScale = 'none';
  let dominantScaleHits = 0;
  for (const s of strongScales) {
    if (scoreScaleHits[s] > dominantScaleHits) {
      dominantScale = s;
      dominantScaleHits = scoreScaleHits[s];
    }
  }
  const itemCount = items.length;
  // Promote 10pt-bare when no strong scale dominates AND bare numbers
  // are positionally consistent — either at line-end (classic "Title 9")
  // OR delimiter-bounded in a middle column (CSV/TSV). The two cases
  // are unioned: a file with mixed last-token and delimited rows still
  // promotes correctly.
  const bareEvidence = bareNumberLastTokenHits + bareNumberDelimitedHits;
  if (
    dominantScaleHits / Math.max(1, itemCount) < 0.20 &&
    bareEvidence / Math.max(1, itemCount) >= 0.50
  ) {
    dominantScale = '10pt-bare';
    dominantScaleHits = bareEvidence;
  }
  // If nothing meaningful matched, scale is 'none'.
  if (dominantScaleHits === 0) dominantScale = 'none';

  // Header-state inheritance — count how many headers carry a status.
  const headerStatusCount = headers.filter((h) => h.headerStatus).length;
  const headerFavoriteCount = headers.filter((h) => h.headerFavorite).length;

  return {
    lineCount: classified.length,
    itemCount,
    headerCount: headers.length,
    blankCount: classified.filter((l) => l.type === 'blank').length,
    commentCount: classified.filter((l) => l.type === 'comment').length,
    scoreScaleHits,
    statusHits,
    favoriteHits,
    headerStatusCount,
    headerFavoriteCount,
    dominantScale,
    dominantScaleHits,
    // The UI uses this to pre-fill the confirmation:
    inferredOptions: {
      scoreScale: dominantScale,
      useHeaderStateInheritance: headerStatusCount > 0,
      useHeaderFavoriteInheritance: headerFavoriteCount > 0,
    },
  };
}

// ── Parser ──────────────────────────────────────────────────────────
//
// Public entry #2. Given options confirmed by the user (typically the
// sniffer's `inferredOptions` passed through), produce structured rows.

export function parseFreeformInput(rawText, options = {}) {
  const opts = {
    scoreScale: 'none',
    useHeaderStateInheritance: true,
    useHeaderFavoriteInheritance: true,
    ...options,
  };

  const classified = classifyLines(rawText);
  const rows = [];

  // Bare-number detection is GATED on the user's confirmed scale —
  // bare numbers conflict with season numbers ("S3" / "ep 5") so we
  // only capture them when the sniffer found positional consistency
  // AND the user confirmed it. All OTHER scales (slash/star/tier/word)
  // are unambiguous patterns and always allowed — see 2026-05-19
  // BRAINSTORM entry's "sniffer should bias, not gate" principle.
  const allowBare = opts.scoreScale === '10pt-bare';

  // The user-confirmed dominant scale wins ties when multiple patterns
  // match the same line. Falls through to "first match in SCORE_PATTERNS
  // order" when the dominant has no hit on a given line.
  const dominantScale = opts.scoreScale;

  // Header-state context that flows across lines until the next header.
  let currentHeaderStatus = null;
  let currentHeaderFavorite = false;

  for (const line of classified) {
    if (line.type === 'blank' || line.type === 'comment') continue;
    if (line.type === 'header') {
      // Header inheritance rule (P2a fix, 2026-05-19 walkthrough):
      //
      // A header is treated as either a SCOPE-START or a DEPTH-MARKER:
      //
      //   - SCOPE-START: carries a status keyword OR a favorite
      //     signal. Resets BOTH axes to whatever the header specifies
      //     (status=its-status-or-null, favorite=its-favorite-or-false).
      //     Going "## Favorites → ## Dropped" correctly turns favorite
      //     off and status to dropped.
      //
      //   - DEPTH-MARKER: carries neither (e.g. "### 2023" under
      //     "## Completed"). Preserves both axes from the parent
      //     scope-start. This is the fix for the original walkthrough
      //     bug — bullets under sub-headers keep their inherited
      //     status instead of losing it.
      const isScopeStart = !!line.headerStatus || !!line.headerFavorite;
      if (isScopeStart) {
        if (opts.useHeaderStateInheritance) {
          currentHeaderStatus = line.headerStatus || null;
        }
        if (opts.useHeaderFavoriteInheritance) {
          currentHeaderFavorite = !!line.headerFavorite;
        }
      }
      // Depth-marker: no-op — preserve both axes from the most recent
      // scope-start above.
      continue;
    }
    // line.type === 'item'
    const content = line.content;

    // Detect ALL score-pattern hits on this line. Title cleanup
    // redacts every span found, even when only one (or none) is
    // captured for the score field.
    const allScoreMatches = detectAllScoresInText(content, { allowBare });
    const wordScore = detectWordScoreInText(content);
    const status = detectStatusInText(content);
    const favorite = detectFavoriteInText(content);
    const yearHint = detectYearHintInText(content);
    // P1 walkthrough fix (2026-05-19): strip leading date prefixes
    // ("2024-03-15 — ") in the same pass as score/status/etc. Season
    // suffix detection is deferred to AFTER initial title extraction
    // (its regex anchors at end-of-line, which only holds once score
    // tokens have been redacted out).
    const datePrefix = detectDatePrefixInText(content);
    // Tier-label prefix ("S:", "A+:") at line start — capture as
    // tier score and redact the prefix. Walkthrough #2 had ~6 rows
    // landing unmatched because "S: Steins;Gate, Mob Psycho 100"
    // didn't fire the tier regex (which requires +/- modifier or
    // end-of-line for bare letters).
    const tierPrefix = detectTierPrefixInText(content);

    // Capture priority: dominant-scale hit > first numeric match >
    // word-score. The point is to honor the user's confirmation when
    // it's relevant (e.g. dominant=star + the line has both `9/10`
    // and `★★★★★` → take the star match) but still capture the
    // unambiguous score when the line has only an off-scale match.
    let numericScore = null;
    if (dominantScale && allScoreMatches.length > 0) {
      numericScore = allScoreMatches.find((s) => s.scale === dominantScale)
        || allScoreMatches[0];
    } else if (allScoreMatches.length > 0) {
      numericScore = allScoreMatches[0];
    }
    // Tier-prefix takes priority over other numeric matches when
    // present (it's an explicit user signal at the most salient
    // position — the start of the line). Falls back to other captures
    // when not.
    const effectiveScore = tierPrefix || numericScore || wordScore;

    // Redaction is the union of every detected pattern, not just the
    // captured one. Without this, "Mob Psycho 100 ★★★★★" with
    // dominant=10pt-slash keeps the stars in the title and breaks
    // fuzzy match downstream. (P1a fix from the 2026-05-19 walkthrough.)
    // When tierPrefix matched, the regular tier pattern in
    // allScoreMatches matched the same letter at the same index but
    // with a shorter span. Including both in redactionMatches causes
    // extractTitle's range-merging to over-cut. Filter out tier matches
    // from allScoreMatches when tierPrefix is the canonical capture.
    const scoreMatchesForRedaction = tierPrefix
      ? allScoreMatches.filter((s) => s.scale !== 'tier')
      : allScoreMatches;
    const redactionMatches = [...scoreMatchesForRedaction];
    if (wordScore) redactionMatches.push(wordScore);
    if (status) redactionMatches.push(status);
    if (favorite) redactionMatches.push(favorite);
    if (yearHint) redactionMatches.push(yearHint);
    if (datePrefix) redactionMatches.push(datePrefix);
    if (tierPrefix) redactionMatches.push(tierPrefix);
    let titleRaw = extractTitle(content, redactionMatches);

    // Season-suffix post-pass — runs on the already-cleaned title so
    // its end-of-line anchor sees an honest end. "Vinland Saga S2"
    // detects after "— 10/10" has been redacted from the original
    // content. Strips from titleRaw and stamps seasonHint on the row.
    let seasonHint = null;
    if (titleRaw) {
      const ss = detectSeasonSuffixInText(titleRaw);
      if (ss) {
        seasonHint = ss.season;
        titleRaw = (titleRaw.slice(0, ss.matchIndex) + titleRaw.slice(ss.matchIndex + ss.matchText.length)).trim();
      }
    }

    // Multi-show comma-split (P2.1, 2026-05-19 walkthrough). When the
    // cleaned title contains comma-separated fragments that each look
    // title-shaped, emit one row per fragment sharing the same metadata
    // (status, score, favorite, etc.). Walkthrough #2: "S: Steins;Gate,
    // Mob Psycho 100" after tier-prefix redaction yields title
    // "Steins;Gate, Mob Psycho 100" — should be 2 rows, not 1.
    //
    // Gates designed to avoid false splits:
    //   - ≥2 comma-separated fragments
    //   - each fragment has ≥2 chars after trim
    //   - each fragment contains at least one letter (alpha)
    //   - no fragment is just a status word, score token, or modifier
    //     (would indicate the comma is part of a tail comment, not a
    //     show list)
    const titles = splitMultiShowTitle(titleRaw);

    // Empty title after redaction → likely a "completed!" or "loved!"
    // line with no title. Skip rather than emit a titleless row.
    if (titles.length === 0) continue;

    const isFavorite = !!favorite || currentHeaderFavorite;
    const finalStatus = status ? status.status : (currentHeaderStatus || null);

    for (const oneTitle of titles) {
      rows.push({
        titleRaw: oneTitle,
        status: finalStatus,
        score: effectiveScore ? effectiveScore.score : null,
        scoreOriginal: effectiveScore ? effectiveScore.scoreOriginal : null,
        scoreScale: effectiveScore ? effectiveScore.scale : null,
        isFavorite,
        // yearHint helps the matcher disambiguate franchise siblings —
        // "Bleach (2022)" should land on AL ID for the reboot, not the
        // 2004 original. null when the user didn't write a year.
        yearHint: yearHint ? yearHint.year : null,
        // seasonHint captures "S2", "Season 3", "Final Season" etc.
        // Currently informational — the matcher resolves the franchise
        // root (which is correct for taste-vector purposes; per-season
        // taste differences are usually noise). Future surfaces could
        // use this to disambiguate franchise-sibling AL IDs.
        seasonHint,
        userTagsFromImport: [], // v1 placeholder — extension hook for tag capture
        lineNumber: line.lineNumber,
        lineRaw: line.lineRaw,
      });
    }
  }

  return rows;
}

// Decide whether a cleaned-up title is one show or a comma-list of
// shows. Returns an array of 1+ title strings. Empty input → empty
// array. Single show → [title]. Multi-show pattern detected → split
// into individual titles.
//
// Conservative gates (avoid false splits):
//   - input must contain at least one comma followed by whitespace OR
//     immediately followed by a letter (so "Re:Zero, Vol 2" with the
//     space-comma-Vol pattern can still match if Vol looks title-like)
//   - splitting yields ≥2 non-empty fragments
//   - every fragment is ≥2 chars after trim
//   - every fragment contains at least one letter
//   - no fragment is purely a known status / score token (would
//     indicate the comma was inside a tail comment, not separating
//     titles)
function splitMultiShowTitle(title) {
  if (!title) return [];
  if (!/,/.test(title)) return [title];
  const parts = title.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return [title];
  // Every fragment must look title-shaped:
  //   - ≥3 chars (avoid splitting on noise like "old", "etc")
  //   - contains at least one uppercase letter (title-case signal —
  //     rejects all-lowercase comment fragments like "old", "filler",
  //     "after aincrad" while keeping "JJK", "Steins;Gate", "Mob Psycho")
  //   - not a status/score word
  for (const p of parts) {
    if (p.length < 3) return [title];
    if (!/[A-Z]/.test(p)) return [title];
    if (/^(completed?|dropped?|paused?|watching|planning|loved|fav|favorite|peak|mid|slop)$/i.test(p)) {
      return [title];
    }
  }
  return parts;
}

// ── Internal exports for tests ──────────────────────────────────────
//
// Pure helpers exposed so tests can pin specific behaviors without
// going through the full parse flow.
export const _internals = Object.freeze({
  classifyLines,
  stripBulletMarker,
  detectStatusInText,
  detectFavoriteInText,
  detectScoreInText,
  detectAllScoresInText,
  detectWordScoreInText,
  detectYearHintInText,
  detectDatePrefixInText,
  detectSeasonSuffixInText,
  extractTitle,
  clampScore,
  STATUS_VOCAB,
  FREEFORM_STATUS_VOCAB,
  FREEFORM_FAVORITE_PATTERNS,
  FREEFORM_SCORE_VOCAB,
  TIER_SCORE_MAP,
  SCORE_PATTERNS,
});
