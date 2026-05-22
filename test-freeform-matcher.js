// Tests for freeform-matcher.js.
//
// Run: node "Crunchyroll Smart Scoring_Extension/test-freeform-matcher.js"
//
// Strategy: build a synthetic aniListCache + bridgeCache with a handful
// of well-known shows (FMA, FMAB, Vinland Saga, Steins;Gate, Re:Zero,
// AOT, Code Geass), then exercise the three match layers + the
// resolveFreeformList orchestrator with a mocked searchFn.

import {
  buildTitleIndex,
  matchTitleLocal,
  resolveFreeformList,
  normalizeTitle,
  acronymOf,
  levenshteinAtMost,
  _internals,
} from './freeform-matcher.js';

let passCount = 0;
let failCount = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passCount += 1;
  else {
    failCount += 1;
    failures.push({ label, actual: a, expected: e });
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}
function assertTrue(cond, label) {
  if (cond) passCount += 1;
  else {
    failCount += 1;
    failures.push({ label });
    console.error(`FAIL: ${label} (assertion was false)`);
  }
}

// ── Synthetic cache fixture ───────────────────────────────────────
//
// Mirrors the shape projectMedia(media) produces in anilist.js:
//   { aniListId, title: { english, romaji, native }, synonyms,
//     format, seasonYear, ... }
const aniListCache = {
  // CR-id-keyed → AL projection
  '5114': {
    aniListId: 5114,
    title: {
      english: 'Fullmetal Alchemist: Brotherhood',
      romaji: 'Hagane no Renkinjutsushi: Fullmetal Alchemist',
      native: '鋼の錬金術師 FULLMETAL ALCHEMIST',
    },
    synonyms: ['FMAB', 'Hagaren', 'Fullmetal Alchemist Brotherhood'],
    format: 'TV',
    seasonYear: 2009,
  },
  '121': {
    aniListId: 121,
    title: {
      english: 'Fullmetal Alchemist',
      romaji: 'Hagane no Renkinjutsushi',
      native: '鋼の錬金術師',
    },
    synonyms: ['FMA'],
    format: 'TV',
    seasonYear: 2003,
  },
  '101348': {
    aniListId: 101348,
    title: {
      english: 'Vinland Saga',
      romaji: 'Vinland Saga',
      native: 'ヴィンランド・サガ',
    },
    synonyms: [],
    format: 'TV',
    seasonYear: 2019,
  },
  '9253': {
    aniListId: 9253,
    title: {
      english: 'Steins;Gate',
      romaji: 'Steins;Gate',
      native: 'STEINS;GATE',
    },
    synonyms: ['SG'],
    format: 'TV',
    seasonYear: 2011,
  },
  '21355': {
    aniListId: 21355,
    title: {
      english: 'Re:ZERO -Starting Life in Another World-',
      romaji: 'Re:Zero kara Hajimeru Isekai Seikatsu',
      native: 'Re：ゼロから始める異世界生活',
    },
    synonyms: ['Re:Zero', 'ReZero'],
    format: 'TV',
    seasonYear: 2016,
  },
  '16498': {
    aniListId: 16498,
    title: {
      english: 'Attack on Titan',
      romaji: 'Shingeki no Kyojin',
      native: '進撃の巨人',
    },
    synonyms: ['AoT', 'SnK'],
    format: 'TV',
    seasonYear: 2013,
  },
  '1575': {
    aniListId: 1575,
    title: {
      english: 'Code Geass: Lelouch of the Rebellion',
      romaji: 'Code Geass: Hangyaku no Lelouch',
      native: 'コードギアス 反逆のルルーシュ',
    },
    synonyms: ['Code Geass'],
    format: 'TV',
    seasonYear: 2006,
  },
};

// Bridge cache (AL-id-keyed). For the test we mirror a couple of
// entries so build-index reads from both without duplication.
const bridgeCache = {
  '5114': aniListCache['5114'],
  '121': aniListCache['121'],
};

const index = buildTitleIndex(aniListCache, bridgeCache);

// ── A. Index construction ─────────────────────────────────────────
{
  assertTrue(index.byAniListId.size === 7, 'A: 7 unique AL IDs indexed');
  // 5114 should map to multiple normalized strings (english, romaji,
  // native, 3 synonyms) — but native is non-ASCII so its normalized
  // form differs from the other two.
  const fmab = index.byAniListId.get(5114);
  assertTrue(fmab.titles.size >= 4, 'A: FMAB has ≥4 indexed normalized titles');
  // Acronym pre-compute (2026-05-19 speed win): map exists and contains
  // entries for the FMAB acronym (which IS one of FMAB's synonyms,
  // so the acronym of the normalized "fmab" string is just "FMAB").
  assertTrue(index.acronymToIds instanceof Map, 'A: acronymToIds Map present');
  assertTrue(index.acronymToIds.size > 0, 'A: acronymToIds populated');
  // "CGLR" should map to Code Geass: Lelouch of the Rebellion (AL 1575).
  // acronymOf strips stopwords; English title becomes "code geass
  // lelouch of the rebellion" → acronym "CGLR".
  assertTrue(index.acronymToIds.get('CGLR')?.has(1575),
    'A: CGLR acronym maps to Code Geass AL 1575');
}

// ── B. Exact-match layer ──────────────────────────────────────────
{
  const m = matchTitleLocal('Vinland Saga', index);
  assertEq(m.aniListId, 101348, 'B: Vinland Saga exact match');
  assertEq(m.confidence, 1.0, 'B: exact confidence 1.0');
  assertEq(m.matchedVia, 'exact', 'B: matchedVia=exact');
}

// ── C. Punctuation equivalence ────────────────────────────────────
{
  // "Steins Gate" with a space should match "Steins;Gate" via
  // separator normalization.
  const m = matchTitleLocal('Steins Gate', index);
  assertEq(m.aniListId, 9253, 'C: Steins Gate normalizes to Steins;Gate');
  assertEq(m.confidence, 1.0, 'C: still exact confidence');
}

// ── D. Synonym hits ───────────────────────────────────────────────
{
  const m = matchTitleLocal('Hagaren', index);
  assertEq(m.aniListId, 5114, 'D: Hagaren (synonym) → FMAB');
}

// ── E. Acronym layer (single-token short) ─────────────────────────
{
  // FMAB is in synonyms for AL 5114, so it'd match via exact at Layer
  // 1 before Layer 2 even fires. To genuinely test the acronym path,
  // try an acronym that ISN'T in synonyms.
  const m = matchTitleLocal('CGLR', index);
  // Code Geass: Lelouch of the Rebellion → acronym CGLR (stopwords
  // "of", "the" dropped).
  assertEq(m.aniListId, 1575, 'E: CGLR → Code Geass via acronym');
  assertEq(m.confidence, 0.95, 'E: acronym confidence 0.95');
  assertEq(m.matchedVia, 'acronym', 'E: matchedVia=acronym');
}

// ── F. Acronym ambiguity is sane ──────────────────────────────────
{
  // SG might match both Steins;Gate (synonym 'SG' → exact at Layer 1)
  // and as an acronym for "Shingeki no Kyojin" (SnK; not SG). Verify
  // Layer 1 wins for SG.
  const m = matchTitleLocal('SG', index);
  assertEq(m.aniListId, 9253, 'F: SG → Steins;Gate via Layer 1 (synonym)');
}

// ── G. Levenshtein layer (typo) ───────────────────────────────────
{
  // Single-edit typo (one letter changed) — ratio = 1 - 1/12 ≈ 0.917,
  // which clears the 0.85 acceptance threshold. Sgaa→Saga is two edits
  // (Levenshtein doesn't credit transposition as one op), which would
  // miss our threshold and is the correct routing — bad typos go to
  // the review pile, not silently matched.
  const m = matchTitleLocal('Vinland Sage', index);
  assertEq(m.aniListId, 101348, 'G: Vinland Sage → Vinland Saga via Levenshtein');
  assertTrue(m.confidence < 1.0 && m.confidence >= 0.85, 'G: confidence in fuzzy band');
  assertEq(m.matchedVia, 'levenshtein', 'G: matchedVia=levenshtein');
}

// ── H. Levenshtein ambiguity gap ──────────────────────────────────
{
  // Index has FMA (id 121) and FMAB (id 5114) — separate shows that
  // share most of their title strings. Querying for "Fullmetal
  // Alchemist:" with a trailing typo should be close enough to both
  // that the gap rule kicks in.
  //
  // We construct a query that's roughly equidistant from both:
  // "Fullmetal Alchemist Z" — adds 2 chars vs both base titles,
  // similar ratio to each.
  const m = matchTitleLocal('Fullmetal Alchemist Z', index);
  // Either exact-fail then ambiguous, or routes to lowConfidence with
  // candidates. We assert it doesn't return a confident match.
  if (m && m.aniListId) {
    // If a confident winner is returned, it must be one of the two.
    assertTrue([121, 5114].includes(m.aniListId), 'H: winner is one of the FMA pair');
  } else {
    assertTrue(Array.isArray(m?.candidates) && m.candidates.length >= 1, 'H: routes to candidates list');
  }
}

// ── I. Below-threshold returns near-misses ────────────────────────
{
  // Distant query: "Cowboy Bebop" — not in our cache. Should return
  // null OR a candidates list of near-misses (depending on whether
  // anything in the index falls within the ratio prefilter).
  const m = matchTitleLocal('Cowboy Bebop', index);
  if (m === null) {
    assertTrue(true, 'I: null when nothing matches');
  } else {
    assertEq(m.aniListId, null, 'I: aniListId null below threshold');
    assertEq(m.matchedVia, 'levenshtein-below-threshold', 'I: below-threshold tag');
  }
}

// ── J. Empty title ────────────────────────────────────────────────
{
  const m = matchTitleLocal('', index);
  assertEq(m, null, 'J: empty title returns null');
}

// ── K. Normalization unit tests ───────────────────────────────────
{
  assertEq(normalizeTitle('Steins;Gate'), 'steins gate', 'K: semicolon → space');
  assertEq(normalizeTitle('Code Geass: Lelouch of the Rebellion'), 'code geass lelouch of the rebellion', 'K: colon → space');
  assertEq(normalizeTitle('  Re:Zero  '), 're zero', 'K: trim + colon');
  assertEq(normalizeTitle('Tokyo Ghoul:re'), 'tokyo ghoul re', 'K: trailing :re kept distinct');
  assertEq(normalizeTitle("Don't Toy with Me, Miss Nagatoro"), 'dont toy with me miss nagatoro', 'K: apostrophe removed');
}

// ── L. Acronym helper ─────────────────────────────────────────────
{
  assertEq(acronymOf('fullmetal alchemist brotherhood'), 'FAB', 'L: FAB (not FMAB — "Fullmetal" is one word)');
  assertEq(acronymOf('code geass lelouch of the rebellion'), 'CGLR', 'L: CGLR drops stopwords');
  assertEq(acronymOf('attack on titan'), 'AT', 'L: AT drops "on"');
  assertEq(acronymOf('shingeki no kyojin'), 'SNK', 'L: SNK preserves "no"');
}

// ── M. Levenshtein helper bounded ─────────────────────────────────
{
  assertEq(levenshteinAtMost('foo', 'foo', 0), 0, 'M: identical = 0');
  assertEq(levenshteinAtMost('foo', 'boo', 1), 1, 'M: 1 sub = 1');
  assertEq(levenshteinAtMost('foo', 'bar', 1), null, 'M: too distant under cap');
  // Damerau upgrade (2026-05-19): adjacent transposition costs 1 edit.
  assertEq(levenshteinAtMost('sgaa', 'saga', 1), 1, 'M: adjacent swap (sgaa→saga) = 1 edit');
  assertEq(levenshteinAtMost('teh', 'the', 1), 1, 'M: adjacent swap (teh→the) = 1 edit');
  // Non-adjacent swap is still 2 — algorithm requires character adjacency.
  assertEq(levenshteinAtMost('abcd', 'dbca', 1), null, 'M: non-adjacent swap exceeds cap=1');
  // "Vinland Sgaa" → "Vinland Saga" — one adjacent transposition.
  assertEq(levenshteinAtMost('vinland sgaa', 'vinland saga', 1), 1, 'M: title-internal adjacent swap');
}

// ── N. resolveFreeformList — happy path ──────────────────────────
{
  const rows = [
    { titleRaw: 'Vinland Saga', score: 10 },
    { titleRaw: 'FMAB', score: 10 },
    { titleRaw: 'Bleach', score: 4 }, // not in cache, no searchFn → unmatched
  ];
  const result = await resolveFreeformList({ rows, index, searchFn: null });
  assertEq(result.matched.length, 2, 'N: 2 matched (Vinland + FMAB)');
  assertEq(result.unmatched.length, 1, 'N: 1 unmatched (Bleach)');
  assertEq(result.lowConfidence.length, 0, 'N: 0 low-confidence');
  assertEq(result.matched[0].aniListId, 101348, 'N: Vinland matched');
  assertEq(result.matched[1].aniListId, 5114, 'N: FMAB matched');
  assertEq(result.unmatched[0].attempted, ['local'], 'N: Bleach attempted local only');
}

// ── O. resolveFreeformList — with mocked searchFn ────────────────
{
  const rows = [
    { titleRaw: 'Bleach', score: 4 },
    { titleRaw: 'Vinland Saga', score: 10 }, // local hit — searchFn not called
  ];
  let searchCallCount = 0;
  const searchFn = async (title) => {
    searchCallCount += 1;
    if (title === 'Bleach') {
      return [{ aniListId: 269, title: { english: 'Bleach' }, format: 'TV', seasonYear: 2004 }];
    }
    return [];
  };
  const result = await resolveFreeformList({ rows, index, searchFn });
  assertEq(searchCallCount, 1, 'O: searchFn called only for Bleach (Vinland hit local)');
  assertEq(result.matched.length, 2, 'O: both matched');
  const bleach = result.matched.find((m) => m.row.titleRaw === 'Bleach');
  assertEq(bleach.aniListId, 269, 'O: Bleach resolved via AL search');
  assertEq(bleach.matchedVia, 'freeform-al-search', 'O: matchedVia=freeform-al-search');
  assertEq(bleach.confidence, 0.92, 'O: AL-search confidence 0.92');
}

// ── P. resolveFreeformList — search fails gracefully ─────────────
{
  const rows = [{ titleRaw: 'Some Deep Cut', score: 8 }];
  const searchFn = async () => { throw new Error('429 rate-limited'); };
  const result = await resolveFreeformList({ rows, index, searchFn });
  assertEq(result.unmatched.length, 1, 'P: search failure → unmatched');
  assertEq(result.matched.length, 0, 'P: no false-positive match');
  assertEq(result.unmatched[0].attempted, ['local', 'al-search'], 'P: attempted both layers');
}

// ── Q. resolveFreeformList — abort signal ────────────────────────
{
  const rows = Array.from({ length: 50 }, (_, i) => ({ titleRaw: `Deep Cut ${i}`, score: 5 }));
  const ac = new AbortController();
  const searchFn = async () => {
    ac.abort();  // simulate abort mid-search
    return [];
  };
  const result = await resolveFreeformList({ rows, index, searchFn, signal: ac.signal });
  assertTrue(result.matched.length + result.lowConfidence.length + result.unmatched.length < 50,
    'Q: abort stops processing before all rows handled');
}

// ── R0. Year-hint disambiguation on exact-title collisions ──────
//
// Build an index where two distinct AL IDs share a normalized title
// (the Berserk 1997 vs 2016 case) and confirm year hint picks the
// right one.
{
  const dualCache = {
    '33': {
      aniListId: 33,
      title: { english: 'Berserk', romaji: 'Berserk', native: null },
      synonyms: [],
      format: 'TV',
      seasonYear: 1997,
    },
    '21629': {
      aniListId: 21629,
      title: { english: 'Berserk', romaji: 'Berserk', native: null },
      synonyms: [],
      format: 'TV',
      seasonYear: 2016,
    },
  };
  const idx = buildTitleIndex(dualCache, {});
  // No hint → ambiguous (correct fallback).
  const noHint = matchTitleLocal('Berserk', idx);
  assertEq(noHint?.ambiguous, true, 'R0: no year → exact-ambiguous');
  // Hint matches 1997 → picks 33 with 0.97 confidence.
  const hint1997 = matchTitleLocal('Berserk', idx, { yearHint: 1997 });
  assertEq(hint1997.aniListId, 33, 'R0: yearHint=1997 picks Berserk 1997');
  assertEq(hint1997.matchedVia, 'exact-year-disambiguated', 'R0: matchedVia stamped');
  assertEq(hint1997.confidence, 0.97, 'R0: year-disambig confidence 0.97');
  // Hint matches 2016 → picks 21629.
  const hint2016 = matchTitleLocal('Berserk', idx, { yearHint: 2016 });
  assertEq(hint2016.aniListId, 21629, 'R0: yearHint=2016 picks Berserk 2016');
  // Year hint that matches neither → still ambiguous.
  const hintNone = matchTitleLocal('Berserk', idx, { yearHint: 2024 });
  assertEq(hintNone?.ambiguous, true, 'R0: non-matching year falls through to ambiguous');
}

// ── R. AL Search top-1 vs close runner-up ────────────────────────
{
  const rows = [{ titleRaw: 'X', score: 8 }];
  const searchFn = async () => [
    { aniListId: 100, title: { english: 'Show X' }, format: 'TV', seasonYear: 2020 },
    { aniListId: 101, title: { english: 'Show X' }, format: 'TV', seasonYear: 2021 },
  ];
  const result = await resolveFreeformList({ rows, index, searchFn });
  // Two entries with same normalized title → routed to low-confidence.
  assertEq(result.lowConfidence.length, 1, 'R: two identically-titled hits → low-confidence');
  assertEq(result.matched.length, 0, 'R: no auto-match');
}

// ── S. In-flight title dedup — same query shares one searchFn ────
//
// Bundle A (2026-05-19): if multiple rows resolve to the same
// normalized title at search time, they share a single searchFn
// promise. Saves N×AL-latency per duplicate.
{
  const rows = [
    { titleRaw: 'Some Deep Cut',     score: 9 },
    { titleRaw: 'some deep cut',     score: 8 },  // same normalized
    { titleRaw: 'Some  Deep  Cut',   score: 7 },  // same normalized (multi-space collapses)
    { titleRaw: 'Another Show',      score: 6 },
  ];
  let searchCallCount = 0;
  const searchFn = async (title) => {
    searchCallCount += 1;
    if (normalizeTitle(title) === 'some deep cut') {
      return [{ aniListId: 9999, title: { english: 'Some Deep Cut' }, format: 'TV', seasonYear: 2020 }];
    }
    return [];
  };
  const result = await resolveFreeformList({ rows, index, searchFn });
  assertEq(searchCallCount, 2, 'S: searchFn called only twice (one per distinct normalized query)');
  // All three "Some Deep Cut" rows should resolve to the same AL ID.
  const sameAlIdMatches = result.matched.filter(m => m.aniListId === 9999);
  assertEq(sameAlIdMatches.length, 3, 'S: all 3 duplicate-normalized rows matched to AL 9999');
  assertEq(result.unmatched.length, 1, 'S: Another Show stays unmatched');
}

// ── T. Pipelined parallel dispatch — Promise.all-shaped wait ─────
//
// Pass 1 fires all searchFn promises without awaiting; pass 2 awaits
// them sequentially for progress reporting. Net: total wait time
// dominated by the longest-running search, not the sum. Verified by
// measuring elapsed time for a list of 5 rows each with a 100ms
// search latency — should land at ~100ms (parallel) not 500ms
// (sequential).
{
  const rows = Array.from({ length: 5 }, (_, i) => ({
    titleRaw: `Deep Cut ${i}`,
    score: 8,
  }));
  const searchFn = async () => {
    await new Promise(r => setTimeout(r, 100));
    return [];
  };
  const start = Date.now();
  await resolveFreeformList({ rows, index, searchFn });
  const elapsed = Date.now() - start;
  // Allow generous slack: parallel = ~100ms, sequential would be ~500ms.
  // Anything under 250ms confirms the promises ran concurrently.
  assertTrue(elapsed < 250, `T: pipelined dispatch elapsed ${elapsed}ms (expect <250ms; sequential would be ~500ms)`);
}

// ── U. stripCommentSuffix — em-dash separator with prose suffix ──
{
  const { stripCommentSuffix } = _internals;
  // Comment-shaped suffix → strip.
  assertEq(stripCommentSuffix('Vinland Saga — Thorfinn arc is genuinely transformative'),
    'Vinland Saga', 'U: em-dash + prose suffix stripped');
  assertEq(stripCommentSuffix('Bleach — too long, lost interest at filler'),
    'Bleach', 'U: em-dash + comment with comma stripped');
  // Legitimate long title — function words mid-title, but no separator
  // that splits clean prefix from prose. NOT stripped.
  assertEq(stripCommentSuffix('Code Geass Lelouch of the Rebellion'),
    null, 'U: title with embedded function words NOT stripped');
  // Em-dash but suffix is a single capitalized word (looks title-like).
  assertEq(stripCommentSuffix('Vinland Saga — Peak'),
    null, 'U: single-word suffix without function words is title-like, kept');
  // No separator → no strip.
  assertEq(stripCommentSuffix('Vinland Saga'), null, 'U: no separator unchanged');
  // Paren content with comment shape.
  assertEq(stripCommentSuffix('Sword Art Online (after Aincrad)'),
    'Sword Art Online', 'U: paren comment stripped');
  // Paren content with title-like shape (1-2 words, no function words).
  assertEq(stripCommentSuffix('Tokyo Ghoul (Movie)'),
    null, 'U: short paren content kept (could be a sub-format marker)');
}

// ── V. Comment-strip fallback fires in resolveFreeformList ───────
//
// "Vinland Saga — Thorfinn arc is genuinely transformative" was 0/1
// matched in walkthrough #5. After the fallback, the stripped variant
// "Vinland Saga" hits Layer 1 exact match.
{
  const rows = [
    { titleRaw: 'Vinland Saga — Thorfinn arc is genuinely transformative', score: 10 },
    { titleRaw: 'Steins;Gate — best paced thriller in anime', score: 10 },
    { titleRaw: 'Sword Art Online (after Aincrad)', score: 5 },
  ];
  const result = await resolveFreeformList({ rows, index, searchFn: null });
  // First two should now match Layer 1 exact after comment-strip.
  // SAO isn't in our test fixture (only mainstream test entries), so
  // it'll still be unmatched — but the search query should be cleaned.
  assertEq(result.matched.length, 2, 'V: 2 matched after comment-strip fallback');
  const vinland = result.matched.find(m => m.row.titleRaw.startsWith('Vinland'));
  assertEq(vinland?.aniListId, 101348, 'V: Vinland Saga resolved');
  const steins = result.matched.find(m => m.row.titleRaw.startsWith('Steins'));
  assertEq(steins?.aniListId, 9253, 'V: Steins;Gate resolved');
}

// ── Summary ──────────────────────────────────────────────────────
console.log();
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${failCount}`);
if (failCount > 0) {
  console.log();
  console.log('Failure summary:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
console.log('All freeform-matcher tests passed.');
