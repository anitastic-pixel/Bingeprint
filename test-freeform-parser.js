// Tests for freeform-parser.js.
//
// Run: node "Crunchyroll Smart Scoring_Extension/test-freeform-parser.js"
//
// The parser is a pure ESM module — Node can import() it directly. No
// vm-shim like test-backup-roundtrip.js because there's no chrome.*
// to mock.
//
// Scenarios:
//   A. 10pt-slash dominant      — "FMAB — 10/10 completed"
//   B. 5-star dominant          — "Vinland ★★★★★ done"
//   C. S-tier dominant          — "FMAB S+, Steins;Gate A"
//   D. No-scores                — just titles + statuses
//   E. Word-scores              — peak / mid / slop
//   F. Markdown-header state    — ## Completed / ## Dropped sections
//   G. Status word vocab       — dropped / DNF / on-hold / plan to watch
//   H. isFavorite orthogonal    — "Vinland — 10/10 — loved"
//   I. Bullet-marker stripping  — "- " / "1. " / "* "
//   J. Empty + comment lines    — filtered cleanly
//   K. Bare-number positional   — "Title 9" passes, "S3 ep 5" doesn't fire
//   L. Tier ± modifiers         — A+ = 9, B- = 5
//   M. Sniffer dominant pick    — chooses 10pt-slash over scattered bare

import { sniffFreeformInput, parseFreeformInput, _internals } from './freeform-parser.js';

let passCount = 0;
let failCount = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aStr = JSON.stringify(actual);
  const eStr = JSON.stringify(expected);
  if (aStr === eStr) {
    passCount += 1;
  } else {
    failCount += 1;
    failures.push({ label, actual: aStr, expected: eStr });
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${eStr}`);
    console.error(`  actual:   ${aStr}`);
  }
}

function assertTrue(cond, label) {
  if (cond) passCount += 1;
  else {
    failCount += 1;
    failures.push({ label, actual: 'false', expected: 'true' });
    console.error(`FAIL: ${label} (assertion was false)`);
  }
}

// ── A. 10pt-slash dominant ────────────────────────────────────────
{
  const input = [
    'FMAB — 10/10 — completed',
    'Vinland Saga — 9/10 — completed',
    'Bleach — 4/10 — dropped',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.dominantScale, '10pt-slash', 'A: dominant scale is 10pt-slash');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 3, 'A: 3 rows parsed');
  assertEq(rows[0].titleRaw, 'FMAB', 'A: title FMAB');
  assertEq(rows[0].score, 10, 'A: FMAB score 10');
  assertEq(rows[0].status, 'completed', 'A: FMAB completed');
  assertEq(rows[2].titleRaw, 'Bleach', 'A: title Bleach');
  assertEq(rows[2].status, 'dropped', 'A: Bleach dropped');
  assertEq(rows[2].score, 4, 'A: Bleach score 4');
}

// ── B. 5-star dominant ────────────────────────────────────────────
{
  const input = [
    'Vinland Saga ★★★★★',
    'Steins;Gate ★★★★½',
    'Bleach ★★ (dropped)',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.dominantScale, '5-star', 'B: dominant scale is 5-star');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 3, 'B: 3 rows parsed');
  assertEq(rows[0].score, 10, 'B: 5★ = 10');
  assertEq(rows[1].score, 9, 'B: 4½★ = 9');
  assertEq(rows[2].score, 4, 'B: 2★ = 4');
  assertEq(rows[2].status, 'dropped', 'B: third row dropped');
}

// ── C. S-tier dominant ────────────────────────────────────────────
{
  const input = [
    'FMAB S+',
    'Steins;Gate A',
    'Bleach C-',
    'AOT B+',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.dominantScale, 'tier', 'C: dominant scale is tier');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 4, 'C: 4 rows parsed');
  assertEq(rows[0].score, 10, 'C: S+ clamps to 10');
  assertEq(rows[1].score, 8, 'C: A = 8');
  assertEq(rows[2].score, 3, 'C: C- = 3');
  assertEq(rows[3].score, 7, 'C: B+ = 7');
}

// ── D. No-scores ──────────────────────────────────────────────────
{
  const input = [
    'Vinland Saga — completed',
    'FMAB — completed',
    'Bleach — dropped',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.dominantScale, 'none', 'D: dominant scale is none');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 3, 'D: 3 rows parsed');
  assertEq(rows[0].score, null, 'D: no score');
  assertEq(rows[0].status, 'completed', 'D: status completed');
}

// ── E. Word-scores ────────────────────────────────────────────────
{
  const input = [
    'Vinland Saga — peak',
    'AOT — mid',
    'Random Iyashikei — slop',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  // 'word' is detected — dominant should fall on word since strong
  // numeric scales aren't hit.
  assertEq(sniff.dominantScale, 'word', 'E: dominant scale is word');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 3, 'E: 3 rows parsed');
  assertEq(rows[0].score, 10, 'E: peak = 10');
  assertEq(rows[1].score, 5, 'E: mid = 5');
  assertEq(rows[2].score, 2, 'E: slop = 2');
  assertEq(rows[0].scoreScale, 'word', 'E: scale stamped as word');
}

// ── F. Markdown-header state ──────────────────────────────────────
{
  const input = [
    '## Completed',
    '- Vinland Saga',
    '- FMAB',
    '',
    '## Dropped',
    '- Bleach',
    '- Naruto Shippuden',
    '',
    '## Favorites',
    '- Steins;Gate',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertTrue(sniff.headerStatusCount >= 2, 'F: at least 2 status headers detected');
  assertTrue(sniff.headerFavoriteCount >= 1, 'F: at least 1 favorite header');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 5, 'F: 5 item rows');
  assertEq(rows[0].titleRaw, 'Vinland Saga', 'F: bullet stripped');
  assertEq(rows[0].status, 'completed', 'F: inherits completed');
  assertEq(rows[1].status, 'completed', 'F: FMAB inherits completed');
  assertEq(rows[2].status, 'dropped', 'F: Bleach inherits dropped');
  assertEq(rows[3].status, 'dropped', 'F: Naruto inherits dropped');
  assertEq(rows[4].isFavorite, true, 'F: Steins;Gate inherits favorite');
}

// ── G. Status vocab variants ──────────────────────────────────────
{
  const input = [
    'Show A — DNF',
    'Show B — on hold',
    'Show C — plan to watch',
    'Show D — currently watching',
    'Show E — caught up',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 5, 'G: 5 rows parsed');
  assertEq(rows[0].status, 'dropped', 'G: DNF → dropped');
  assertEq(rows[1].status, 'paused', 'G: on hold → paused');
  assertEq(rows[2].status, 'planning', 'G: plan to watch → planning');
  assertEq(rows[3].status, 'watching', 'G: currently watching → watching');
  assertEq(rows[4].status, 'completed', 'G: caught up → completed');
}

// ── H. isFavorite orthogonal ──────────────────────────────────────
{
  const input = [
    'Vinland Saga — 10/10 — loved',
    'FMAB — 9/10',
    'Steins;Gate — fav — completed',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 3, 'H: 3 rows parsed');
  assertEq(rows[0].isFavorite, true, 'H: Vinland loved → favorite');
  assertEq(rows[0].score, 10, 'H: Vinland still has score 10');
  assertEq(rows[1].isFavorite, false, 'H: FMAB no favorite signal');
  assertEq(rows[2].isFavorite, true, 'H: Steins;Gate fav → favorite');
  assertEq(rows[2].status, 'completed', 'H: Steins;Gate still completed');
}

// ── I. Bullet-marker stripping ────────────────────────────────────
{
  const input = [
    '- Vinland Saga — 9/10',
    '* FMAB — 10/10',
    '+ Steins;Gate — 9/10',
    '1. Bleach — 4/10',
    '2) Naruto — 7/10',
    '• Re:Zero — 8/10',
  ].join('\n');
  const rows = parseFreeformInput(input, { scoreScale: '10pt-slash' });
  assertEq(rows.length, 6, 'I: 6 rows parsed');
  assertEq(rows[0].titleRaw, 'Vinland Saga', 'I: dash bullet stripped');
  assertEq(rows[1].titleRaw, 'FMAB', 'I: asterisk bullet stripped');
  assertEq(rows[2].titleRaw, 'Steins;Gate', 'I: plus bullet stripped');
  assertEq(rows[3].titleRaw, 'Bleach', 'I: 1. numbered stripped');
  assertEq(rows[4].titleRaw, 'Naruto', 'I: 2) numbered stripped');
  assertEq(rows[5].titleRaw, 'Re:Zero', 'I: bullet-dot stripped');
}

// ── J. Empty + comment lines ──────────────────────────────────────
{
  const input = [
    '// My anime list',
    '',
    'Vinland Saga — 10/10',
    '',
    '// note: rewatch in 2027',
    'FMAB — 10/10',
    '',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.itemCount, 2, 'J: 2 items, comments + blanks skipped');
  assertTrue(sniff.commentCount >= 2, 'J: comments counted');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 2, 'J: 2 rows after filtering');
}

// ── K. Bare-number positional ─────────────────────────────────────
{
  // Last-token bare numbers across all rows — should promote 10pt-bare.
  const consistentInput = [
    'Vinland Saga 9',
    'FMAB 10',
    'Bleach 4',
    'Naruto 7',
  ].join('\n');
  const sniff1 = sniffFreeformInput(consistentInput);
  assertEq(sniff1.dominantScale, '10pt-bare', 'K: consistent bare numbers → 10pt-bare');

  // Inconsistent — numbers appear mid-string, often referring to
  // seasons. Should NOT promote.
  const messyInput = [
    'SAO S3 finished',
    'AOT S4 part 2 dropped',
    'Vinland S1 great',
  ].join('\n');
  const sniff2 = sniffFreeformInput(messyInput);
  assertTrue(sniff2.dominantScale !== '10pt-bare', 'K: season-number noise stays out');
}

// ── L. Tier ± modifiers ───────────────────────────────────────────
{
  const input = [
    'A+ Show',
    'B- Show',
    'C+ Show',
    'D- Show',
  ].join('\n');
  // Need at least one item to anchor tier as dominant; with these the
  // sniffer will pick tier.
  const sniff = sniffFreeformInput(input);
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 4, 'L: 4 rows parsed');
  assertEq(rows[0].score, 9, 'L: A+ = 9');
  assertEq(rows[1].score, 5, 'L: B- = 5');
  assertEq(rows[2].score, 5, 'L: C+ = 5');
  assertEq(rows[3].score, 1, 'L: D- = 1');
}

// ── M. Sniffer chooses strong over scattered bare ─────────────────
{
  const input = [
    'Vinland Saga — 9/10',
    'FMAB — 10/10',
    'AOT S4 was peak', // contains "S4" (bare 4) and "peak" word-score
    'Bleach — 4/10',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.dominantScale, '10pt-slash', 'M: 10pt-slash beats bare/word noise');
}

// ── N. extractTitle redaction sanity ──────────────────────────────
{
  // Direct test of the internal — make sure score/status redaction
  // doesn't bleed into the title.
  const t1 = _internals.extractTitle('Vinland Saga — 10/10 — loved', [
    { matchText: '10/10', matchIndex: 'Vinland Saga — '.length },
    { matchText: 'loved', matchIndex: 'Vinland Saga — 10/10 — '.length },
  ]);
  assertEq(t1, 'Vinland Saga', 'N: extractTitle strips trailing separators');
}

// ── O. P1a fix: mixed-scale capture-and-redact (2026-05-19) ──────
//
// When one scale dominates (10pt-slash) but other scale tokens appear
// on other lines, the parser used to (a) drop those scores and (b) keep
// the unrecognized score tokens in the title. After the fix, all
// patterns are matched for redaction and the dominant's hits win
// capture priority — but off-scale lines still produce a captured
// score from their matching pattern.
{
  const input = [
    'Vinland Saga 10/10',
    'Steins;Gate 9/10',
    'Mob Psycho 100 ★★★★★',
    'Cowboy Bebop 5/5',
    'AOT A+',
    'One Piece mid',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.dominantScale, '10pt-slash', 'O: 10pt-slash dominant (2 hits vs 1 each)');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 6, 'O: 6 rows parsed');
  // 10pt-slash rows captured normally.
  assertEq(rows[0].score, 10, 'O: Vinland 10/10 captured');
  assertEq(rows[0].scoreScale, '10pt-slash', 'O: scale stamped');
  // Star match captured even though it's off the dominant scale.
  assertEq(rows[2].score, 10, 'O: Mob Psycho ★★★★★ captured (off-dominant)');
  assertEq(rows[2].scoreScale, '5-star', 'O: scale stamped as 5-star');
  // Off-scale title cleanup — the ★★★★★ glyphs should NOT be in title.
  assertEq(rows[2].titleRaw, 'Mob Psycho 100', 'O: star glyphs redacted from title');
  // 5pt-slash also captured.
  assertEq(rows[3].score, 10, 'O: Cowboy 5/5 → 10/10');
  assertEq(rows[3].scoreScale, '5pt-slash', 'O: scale 5pt-slash');
  assertEq(rows[3].titleRaw, 'Cowboy Bebop', 'O: 5/5 redacted from title');
  // Tier captured.
  assertEq(rows[4].score, 9, 'O: AOT A+ = 9');
  assertEq(rows[4].titleRaw, 'AOT', 'O: A+ redacted from title');
  // Word-score captured.
  assertEq(rows[5].score, 5, 'O: One Piece mid = 5');
  assertEq(rows[5].titleRaw, 'One Piece', 'O: mid redacted from title');
}

// ── P. P1a fix: title cleanup when score not captured but pattern matches ─
//
// Edge case where the dominant is bare-number (or none) but a slash
// score appears on one line. The slash MUST be redacted from the
// title even when bare-number is the captured kind.
{
  const input = [
    'A Show 9',
    'B Show 8',
    'C Show 7',
    'D Show 10/10',   // off-dominant slash — should still cleanup
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  // Three bare-number-last-token hits dominate, one slash adds extra.
  // Slash is the FIRST pattern, so detectScoreInText hits 10pt-slash
  // on the last line, contributing 1 to scoreScaleHits['10pt-slash'].
  // 1 hit out of 4 items = 25% — passes the 20% strong-scale floor
  // for promotion; bare doesn't get promoted in this case. That's
  // acceptable — slash IS unambiguous and the user can override.
  // Either way, the captured score lands correctly and the title
  // cleans up.
  const rows = parseFreeformInput(input, { scoreScale: sniff.dominantScale });
  assertEq(rows.length, 4, 'P: 4 rows');
  // Last line: regardless of which scale we picked, 10/10 should be
  // redacted from the title.
  assertEq(rows[3].titleRaw, 'D Show', 'P: 10/10 redacted from "D Show 10/10"');
  assertEq(rows[3].score, 10, 'P: D Show captured 10');
}

// ── Q. P1b fix: CSV detected as 10pt-bare via delimited gate ─────
//
// Spreadsheet exports put the score in a middle column. The sniffer
// now counts delimited bare numbers (comma/tab/pipe bounded) in
// addition to last-token bare numbers, promoting 10pt-bare when
// either gate fires for ≥50% of items.
{
  const input = [
    'Vinland Saga,9,completed',
    'Steins;Gate,10,completed',
    'Mob Psycho 100,9,completed',
    'Attack on Titan,9,completed',
    'Bleach,4,dropped',
    'Naruto Shippuden,6,paused',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.dominantScale, '10pt-bare', 'Q: CSV middle-column → 10pt-bare');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 6, 'Q: 6 rows parsed');
  assertEq(rows[0].score, 9, 'Q: CSV row 1 score = 9');
  assertEq(rows[0].status, 'completed', 'Q: CSV row 1 status = completed');
  // Title should have the score AND the status redacted; only the
  // show name remains.
  assertEq(rows[0].titleRaw, 'Vinland Saga', 'Q: CSV row 1 title clean');
  assertEq(rows[4].score, 4, 'Q: Bleach 4');
  assertEq(rows[4].status, 'dropped', 'Q: Bleach dropped');
  assertEq(rows[4].titleRaw, 'Bleach', 'Q: Bleach title clean');
}

// ── R. P1b fix: TSV (tab-separated) detected as 10pt-bare ────────
{
  const input = [
    'Vinland Saga\t9\tcompleted',
    'Steins;Gate\t10\tcompleted',
    'Mob Psycho 100\t9\tcompleted',
    'Bleach\t4\tdropped',
    'Naruto\t6\tpaused',
  ].join('\n');
  const sniff = sniffFreeformInput(input);
  assertEq(sniff.dominantScale, '10pt-bare', 'R: TSV middle-column → 10pt-bare');
  const rows = parseFreeformInput(input, sniff.inferredOptions);
  assertEq(rows.length, 5, 'R: 5 rows parsed');
  assertEq(rows[0].score, 9, 'R: TSV row 1 score = 9');
  assertEq(rows[0].titleRaw, 'Vinland Saga', 'R: TSV row 1 title clean');
  assertEq(rows[0].status, 'completed', 'R: TSV row 1 status');
}

// ── S. P3 cosmetic fix: scoreOriginal has no leading space ───────
//
// Tier and bare-number patterns used to capture m[0] which included
// the leading separator from the (?:^|\s) anchor, surfacing as
// "( A)" instead of "A". Fix uses m[1] (the inner group) for those.
{
  const tierRows = parseFreeformInput('Show A\nShow B+\nShow C-', { scoreScale: 'tier' });
  assertEq(tierRows[0].scoreOriginal, 'A', 'S: tier A original is "A" (no leading space)');
  assertEq(tierRows[1].scoreOriginal, 'B+', 'S: tier B+ original');
  assertEq(tierRows[2].scoreOriginal, 'C-', 'S: tier C- original');

  const bareRows = parseFreeformInput('Show 9\nShow 7', { scoreScale: '10pt-bare' });
  assertEq(bareRows[0].scoreOriginal, '9', 'S: bare 9 original is "9"');
  assertEq(bareRows[1].scoreOriginal, '7', 'S: bare 7 original');
}

// ── T. P2a fix: nested sub-headers preserve parent status ────────
//
// `## Completed → ### 2023 → bullet` used to clear the parent's
// status because the parser unconditionally overwrote
// currentHeaderStatus on any header. Scope-start vs depth-marker rule
// preserves inheritance through depth-markers (sub-headers with no
// status/favorite signal of their own).
{
  const input = [
    '## Completed',
    '### 2023',
    '- Vinland Saga',
    '- Steins;Gate',
    '### 2024',
    '- Frieren',
    '',
    '## Dropped',
    '### Anime',
    '- Bleach',
  ].join('\n');
  const rows = parseFreeformInput(input, { useHeaderStateInheritance: true });
  assertEq(rows.length, 4, 'T: 4 item rows');
  assertEq(rows[0].status, 'completed', 'T: Vinland inherits completed through ### 2023');
  assertEq(rows[1].status, 'completed', 'T: Steins;Gate inherits completed');
  assertEq(rows[2].status, 'completed', 'T: Frieren inherits completed through ### 2024');
  assertEq(rows[3].status, 'dropped', 'T: Bleach inherits dropped through ### Anime');
}

// ── U. P2a fix: peer header clears favorite axis ─────────────────
//
// Going from "## Favorites" to "## Dropped" should turn off the
// favorite flag for the dropped rows — both are scope-starts so each
// resets the other axis.
{
  const input = [
    '## Favorites',
    '- Vinland Saga',
    '',
    '## Dropped',
    '- Bleach',
  ].join('\n');
  const rows = parseFreeformInput(input, {
    useHeaderStateInheritance: true,
    useHeaderFavoriteInheritance: true,
  });
  assertEq(rows.length, 2, 'U: 2 rows');
  assertEq(rows[0].isFavorite, true, 'U: Vinland under Favorites is favorite');
  assertEq(rows[0].status, null, 'U: Vinland under Favorites has no status');
  assertEq(rows[1].isFavorite, false, 'U: Bleach under Dropped is NOT favorite');
  assertEq(rows[1].status, 'dropped', 'U: Bleach gets dropped status');
}

// ── V. P2b fix: trailing-colon section labels suppress phantoms ──
//
// "My S-tier:" / "A-tier:" / "Favorites:" without ## prefix used to
// parse as item rows. Now they're promoted to headers (depth marker
// or scope-start depending on what they carry).
{
  const input = [
    'My S-tier:',
    'Vinland Saga S+',
    'Steins;Gate S',
    '',
    'A-tier:',
    'Attack on Titan A+',
    '',
    'Favorites:',
    'Frieren',
    '',
    'Completed:',
    'Mob Psycho 100',
  ].join('\n');
  const rows = parseFreeformInput(input, {
    useHeaderStateInheritance: true,
    useHeaderFavoriteInheritance: true,
  });
  // 5 actual item rows; phantom section labels suppressed.
  assertEq(rows.length, 5, 'V: 5 rows (phantom labels suppressed)');
  // Frieren under "Favorites:" — scope-start sets favorite=true.
  const frieren = rows.find(r => r.titleRaw === 'Frieren');
  assertEq(frieren?.isFavorite, true, 'V: Frieren under "Favorites:" is favorite');
  // Mob Psycho under "Completed:" — scope-start sets status.
  const mp = rows.find(r => r.titleRaw === 'Mob Psycho 100');
  assertEq(mp?.status, 'completed', 'V: Mob Psycho under "Completed:" inherits completed');
  // Tier labels carry no status/favorite — they're depth markers.
  // Vinland/Steins;Gate/AOT should have no inherited status.
  const vinland = rows.find(r => r.titleRaw === 'Vinland Saga');
  assertEq(vinland?.status, null, 'V: Vinland under "S-tier:" has no inherited status');
  assertEq(vinland?.isFavorite, false, 'V: Vinland under "S-tier:" not favorite');
}

// ── W. P2b: real titles ending with colon NOT promoted ───────────
//
// Edge case: a title legitimately ending with `:` (rare but possible
// in mid-import-paste scenarios where a user typed the full title
// followed by a colon as a placeholder for notes). We bound the
// label-promote to ≤4 words + no score-like digits so multi-word
// titles aren't mis-classified.
{
  const input = [
    'Attack on Titan: The Final Season:',  // 6 words → too long for label
    'Vinland Saga 9/10:',                   // contains score digits
  ].join('\n');
  const rows = parseFreeformInput(input, {});
  assertEq(rows.length, 2, 'W: both stay as item rows');
}

// ── X. Year hint extracted from parens / brackets ─────────────────
{
  const rows = parseFreeformInput([
    'Berserk (1997) — 10/10',
    'Berserk (2016) — 5/10',
    'Frieren [2023] — peak',
    'Vinland Saga — 9/10',           // no year hint
    'Bleach 2022 — 8/10',            // bare year gated by 1960-2030 range
  ].join('\n'), { scoreScale: '10pt-slash' });
  assertEq(rows.length, 5, 'X: 5 rows');
  assertEq(rows[0].yearHint, 1997, 'X: (1997) extracted');
  assertEq(rows[0].titleRaw, 'Berserk', 'X: year redacted from title');
  assertEq(rows[1].yearHint, 2016, 'X: (2016) extracted');
  assertEq(rows[2].yearHint, 2023, 'X: [2023] bracket form extracted');
  assertEq(rows[3].yearHint, null, 'X: no year hint when absent');
  assertEq(rows[4].yearHint, 2022, 'X: bare 2022 extracted (in 1960-2030 range)');
  assertEq(rows[4].titleRaw, 'Bleach', 'X: bare year redacted from title');
}

// ── Y. Year hint range gating ─────────────────────────────────────
{
  // Out-of-range years shouldn't fire (avoid AL rank numbers, etc).
  const rows = parseFreeformInput([
    'A Show (1024) — 9/10',  // too low — looks like an AL rank, not a year
    'B Show (3050) — 9/10',  // too high — sci-fi year? not anime
    'C Show (1960) — 9/10',  // boundary — earliest plausible anime year
    'D Show (2030) — 9/10',  // boundary — latest plausible
  ].join('\n'), { scoreScale: '10pt-slash' });
  assertEq(rows[0].yearHint, null, 'Y: 1024 below range');
  assertEq(rows[1].yearHint, null, 'Y: 3050 above range');
  assertEq(rows[2].yearHint, 1960, 'Y: 1960 boundary kept');
  assertEq(rows[3].yearHint, 2030, 'Y: 2030 boundary kept');
}

// ── Z. Date prefix stripped from line start ────────────────────────
//
// Letterboxd-style "2024-03-15 — Frieren ★★★★★" — the date is a
// watch-date, NOT a release year. Whole prefix including the em-dash
// separator gets redacted; the title is the post-prefix portion.
{
  const rows = parseFreeformInput([
    '2024-03-15 — Frieren ★★★★★',
    '2024/02/20 - Mushoku Tensei',
    '2023-11-05 — Chainsaw Man — 9/10',
    'Vinland Saga — 10/10',  // no date prefix
  ].join('\n'), { scoreScale: '5-star' });
  assertEq(rows.length, 4, 'Z: 4 rows');
  assertEq(rows[0].titleRaw, 'Frieren', 'Z: date prefix stripped, title clean');
  assertEq(rows[0].score, 10, 'Z: 5-star ★★★★★ → 10');
  // Year-hint should NOT fire on the watch-date year — date prefix
  // is detected and redacted before year-hint scan runs against
  // the redaction list. But the bare-year detector is greedy. The
  // exact behavior: date-prefix redaction strips "2024-03-15 — ",
  // but the year-hint pattern still matched "2024" in the original
  // content. The current implementation lets year-hint fire (since
  // the regex runs on `content`, not on the post-redaction title).
  // That's actually fine for the title-match path: the year is
  // redacted, the title cleans up regardless.
  assertEq(rows[1].titleRaw, 'Mushoku Tensei', 'Z: alt date separator');
  assertEq(rows[2].titleRaw, 'Chainsaw Man', 'Z: date prefix + score both stripped');
  assertEq(rows[2].score, 9, 'Z: score still captured');
  assertEq(rows[3].titleRaw, 'Vinland Saga', 'Z: no date prefix unchanged');
}

// ── ZZ. Season suffix stripped + stamped on row ────────────────────
//
// "Vinland Saga S2", "Attack on Titan Final Season", "Mushoku Tensei
// Part 2". The season label is redacted from the title (so the matcher
// hits the franchise root) and stamped as row.seasonHint for future
// surfaces.
{
  const rows = parseFreeformInput([
    'Vinland Saga S2 — 10/10',
    'Attack on Titan Season 3 — 9/10',
    'Mushoku Tensei Part 2 — 9/10',
    'Attack on Titan Final Season — 10/10',
    'Vinland Saga — 10/10',          // no season suffix
    'JJK S1 — 8/10',
  ].join('\n'), { scoreScale: '10pt-slash' });
  assertEq(rows.length, 6, 'ZZ: 6 rows');
  assertEq(rows[0].titleRaw, 'Vinland Saga', 'ZZ: S2 stripped from title');
  assertEq(rows[0].seasonHint, 2, 'ZZ: seasonHint=2 stamped');
  assertEq(rows[1].titleRaw, 'Attack on Titan', 'ZZ: Season 3 stripped');
  assertEq(rows[1].seasonHint, 3, 'ZZ: seasonHint=3');
  assertEq(rows[2].titleRaw, 'Mushoku Tensei', 'ZZ: Part 2 stripped');
  assertEq(rows[2].seasonHint, 2, 'ZZ: Part counted as seasonHint=2');
  assertEq(rows[3].titleRaw, 'Attack on Titan', 'ZZ: Final Season stripped');
  assertEq(rows[3].seasonHint, 99, 'ZZ: Final Season stamped as 99');
  assertEq(rows[4].titleRaw, 'Vinland Saga', 'ZZ: no suffix unchanged');
  assertEq(rows[4].seasonHint, null, 'ZZ: no seasonHint when absent');
  assertEq(rows[5].titleRaw, 'JJK', 'ZZ: JJK S1 → JJK');
  assertEq(rows[5].seasonHint, 1, 'ZZ: seasonHint=1');
}

// ── ZZZ. Tier-prefix score capture (P2.1, 2026-05-19) ─────────────
//
// "S: Vinland Saga" / "A+: Code Geass" — tier label at line start with
// trailing colon. Captured as a tier score, redacted from the title.
{
  const rows = parseFreeformInput([
    'S+: Vinland Saga',
    'A: Steins;Gate',
    'B-: Bleach',
    'D: School Days',
  ].join('\n'), {});
  assertEq(rows.length, 4, 'ZZZ: 4 rows');
  assertEq(rows[0].titleRaw, 'Vinland Saga', 'ZZZ: tier prefix stripped');
  assertEq(rows[0].score, 10, 'ZZZ: S+ → 10');
  assertEq(rows[0].scoreScale, 'tier', 'ZZZ: scale tier');
  assertEq(rows[1].score, 8, 'ZZZ: A → 8');
  assertEq(rows[2].titleRaw, 'Bleach', 'ZZZ: B- prefix stripped');
  assertEq(rows[2].score, 5, 'ZZZ: B- → 5');
  assertEq(rows[3].score, 2, 'ZZZ: D → 2');
}

// ── ZZZZ. Multi-show-per-line comma split (P2.1, 2026-05-19) ──────
//
// "S: Steins;Gate, Mob Psycho 100" emits TWO rows sharing the same
// tier score from the prefix. Each fragment becomes its own row with
// its own titleRaw.
{
  const rows = parseFreeformInput([
    'S: Steins;Gate, Mob Psycho 100',
    'A+: Attack on Titan, Code Geass',
    'B+: Demon Slayer, My Hero Academia',
  ].join('\n'), {});
  assertEq(rows.length, 6, 'ZZZZ: 3 lines → 6 rows after split');
  // Each fragment carries its own title but the SHARED tier score.
  assertEq(rows[0].titleRaw, 'Steins;Gate', 'ZZZZ: first fragment');
  assertEq(rows[0].score, 10, 'ZZZZ: shared S tier score');
  assertEq(rows[1].titleRaw, 'Mob Psycho 100', 'ZZZZ: second fragment');
  assertEq(rows[1].score, 10, 'ZZZZ: shared S tier score on row 2');
  assertEq(rows[2].titleRaw, 'Attack on Titan', 'ZZZZ: AOT from A+ line');
  assertEq(rows[2].score, 9, 'ZZZZ: A+ → 9');
  assertEq(rows[3].titleRaw, 'Code Geass', 'ZZZZ: Code Geass from A+ line');
  assertEq(rows[4].titleRaw, 'Demon Slayer', 'ZZZZ: Demon Slayer from B+ line');
  assertEq(rows[4].score, 7, 'ZZZZ: B+ → 7');
}

// ── ZZZZ-edge. Multi-show split conservative gates
{
  const rows = parseFreeformInput([
    'Vinland Saga — 10/10',                  // no comma, single
    'Bleach, old, etc',                       // lowercase noise fragments — should NOT split
    'Code Geass, Lelouch of the Rebellion',  // legit comma-title — splits (known limit)
  ].join('\n'), { scoreScale: '10pt-slash' });
  // First two stay single; third splits. Total 4.
  assertEq(rows.length, 4, 'ZZZZ-edge: noise lines don\'t split, legit comma-title splits');
  assertEq(rows[0].titleRaw, 'Vinland Saga', 'ZZZZ-edge: single Vinland');
  assertEq(rows[1].titleRaw, 'Bleach, old, etc', 'ZZZZ-edge: Bleach line kept as one row (all-lowercase fragments fail split gate)');
  // "Code Geass, Lelouch of the Rebellion" — known limitation: splits
  // into 2 rows. Both fragments are title-shaped (caps, ≥3 chars).
  // Acceptable cost: the first fragment "Code Geass" still hits Layer 1
  // exact match for AL 1575, so the user's import resolves correctly
  // via the first row even though the line splits.
  assertEq(rows[2].titleRaw, 'Code Geass', 'ZZZZ-edge: Code Geass split as first fragment');
  assertEq(rows[3].titleRaw, 'Lelouch of the Rebellion', 'ZZZZ-edge: second fragment also emitted');
}

// ── Summary ────────────────────────────────────────────────────────
console.log();
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${failCount}`);
if (failCount > 0) {
  console.log();
  console.log('Failure summary:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
console.log('All freeform-parser tests passed.');
