// Curated vibe taxonomy for the side panel's "vibe today" chip row, plus
// a mapping from each vibe word to AniList tag/genre keywords used for
// filtering / re-ranking. Loaded as a plain script before sidepanel.js;
// exposes window.VIBE_TAGS.
//
// The taxonomy is the same 4-axis × 4-chip curated set the popup ships.
// The popup owns the long-tail vocabulary (search + dice). The side panel
// keeps it tight — 16 chips, no axis labels, no search — because vertical
// space is precious there. If it turns out users want the full pool in the
// side panel too, we can layer search in later.
//
// Tag matching is case-insensitive substring against (rec.topTags[i].tag
// || rec.genres[i]). A rec "matches" a vibe if it has at least one tag/
// genre containing any of the vibe's patterns. A rec's vibe-match score
// is the number of distinct selected vibes it matches.
//
// Wrapped in an IIFE so the top-level identifiers (VIBE_GROUPS, etc.)
// don't leak into the sidepanel.js script's scope and double-declare.

(() => {
const VIBE_GROUPS = [
  // Tier S #3 additions (2026-05-12): 'intense', 'melancholic', 'atmospheric'
  // fill the vocabulary gap for shows the previous 17-vibe taxonomy couldn't
  // describe — Bebop / Mushishi / Mononoke / Texhnolyze / Lain (atmospheric),
  // PSYCHO-PASS / Monster / Death Note (intense), Clannad / Anohana / KimiUso
  // (melancholic). Patterns kept narrow (specific AniList tags only) so they
  // don't shift the chip output of well-labeled action / comedy / romance
  // shows that the existing composites already cover correctly.
  { axis: 'energy',    chips: ['chill', 'hype', 'slow-burn', 'action-packed', 'intense'] },
  { axis: 'tone',      chips: ['wholesome', 'dark', 'romantic', 'bittersweet', 'melancholic'] },
  { axis: 'headspace', chips: ['thinky', 'escapist', 'weird', 'dreamy', 'funny'] },
  { axis: 'texture',   chips: ['cozy', 'edgy', 'hopeful', 'horny', 'atmospheric'] },
];

// Each value: array of substrings to look for in topTag/genre text.
// Multiple patterns => OR. Patterns are matched lowercase + substring,
// so "psycho" hits "Psychological", "iyashik" hits "Iyashikei", etc.
const VIBE_TO_TAG_PATTERNS = {
  // ── ENERGY ────────────────────────────────────
  // 'chill' tightened 2026-05-11: dropped 'slice of life' (too broad —
  // fired on Cowboy Bebop's episodic vignettes and shounen down-episodes
  // alike, producing wrong "Easy warmth" on noir) and 'episodic'
  // (structure, not energy). Iyashikei shows still fire via 'iyashik'.
  'chill':         ['iyashik', 'cute girls', 'cgdct', 'heartwarming'],
  'hype':          ['action', 'shounen', 'battle', 'tournament', 'sports'],
  'slow-burn':     ['slow', 'drama', 'coming of age', 'philosophical'],
  'action-packed': ['action', 'battle', 'martial arts', 'fight', 'mecha', 'gunfight', 'shootout'],

  // ── TONE ──────────────────────────────────────
  // 'wholesome' tightened 2026-05-11: dropped 'family' (every show has
  // family relationships; fired wholesome on dark family dramas) and
  // 'slice of life' (too broad — fired on action shows with one SoL
  // episode). Iyashikei still bridges into wholesome via 'iyashik'.
  'wholesome':     ['heartwarming', 'iyashik', 'wholesome'],
  'dark':          ['tragedy', 'gore', 'psycho', 'dark fantasy', 'dystopi', 'horror', 'survival', 'thriller'],
  'romantic':      ['romance', 'romantic'],
  'bittersweet':   ['tragedy', 'drama', 'coming of age', 'melancholy'],

  // ── HEADSPACE ─────────────────────────────────
  // 'psycho' kept in pattern set — PSYCHO-PASS Providence and other
  // movie-format shows have smaller tag sets where 'mind games' /
  // 'investigation' may not reach rank ≥50, and 'psycho' (matching
  // "Psychological") is their primary thinky signal. The fix for
  // shounen-action overfire (DS / OP / Trigun) is handled separately
  // by ordering Heavy thinker AFTER the funny-anchored composites in
  // the VIBE_COMPOSITES table — so funny+X wins on those shows.
  //
  // 'politics' added 2026-05-12 — Politics tag fires on 10.4% of the
  // library at rank ≥50 (Spice and Wolf, Apothecary, Vinland, Code
  // Geass, Legend of Galactic Heroes, One Piece arcs). Previously
  // it fired no vibe at all; politics IS cognitive engagement in
  // any meaningful sense, so it folds into thinky cleanly.
  'thinky':        ['philosoph', 'psycho', 'mystery', 'cerebral', 'mind games', 'strategy', 'investigation', 'politics'],
  'escapist':      ['isekai', 'fantasy', 'adventure', 'parallel world', 'reincarnat'],
  'weird':         ['surreal', 'avant garde', 'absurd', 'meta'],
  // 'surreal' removed (2026-05-11) — it lived in BOTH dreamy and weird,
  // and "Surreal Comedy" tag fired both vibes, triggering "Dreamlike
  // weirdness" composite on grounded slapstick (Grand Blue). dreamy is
  // about atmosphere/mood; weird keeps 'surreal'.
  'dreamy':        ['atmospheric', 'mood', 'dreamlike'],
  // 'funny' is comedy/parody/gag — distinct from weird (which is
  // surreal/absurd). Konosuba is funny; Bakemonogatari is weird.
  // Note 'satire' moved here from weird — satire reads as comedic
  // mode, not surreal mode.
  'funny':         ['comedy', 'parody', 'satire', 'slapstick', 'gag', 'comedic'],

  // ── TEXTURE ───────────────────────────────────
  // 'cozy' tightened 2026-05-11: dropped 'slice of life' (over-broad,
  // matched action-show vignettes). Genuine cozy shows still fire via
  // iyashik / cgdct / food / heartwarming / cute girls.
  'cozy':          ['iyashik', 'heartwarming', 'cute girls', 'cgdct', 'food'],
  'edgy':          ['anti-hero', 'gore', 'crime', 'noir', 'gang', 'delinquent'],
  // 'found family' added 2026-05-12 — the Found Family AniList tag is
  // a curated emotional-uplift signal (chosen-family-is-the-theme).
  // Previously fired no vibe at all, leaving shows like SxF, Dr. STONE,
  // One Piece, Solo Leveling with single-chip vibe rows after Dark
  // comedy / Sharp edge composites consumed their primary vibes.
  // Adding to hopeful (rather than wholesome) — Found Family signals
  // emotional resilience and bond-building, not warmth per se.
  'hopeful':       ['heartwarming', 'coming of age', 'sports', 'redemption', 'found family'],
  // Conservative — pattern 'sexual' was too broad (caught 'Asexual',
  // 'Sexual Abuse' content warnings on otherwise-tame shows). Stick to
  // tags that are genuinely about lust/fanservice content. Per-vibe
  // rank floor (see VIBE_MIN_RANK below) lifts horny's threshold so
  // a low-rank Harem mention on a dark-fantasy show (Shield Hero) no
  // longer fires it as a sole vibe.
  'horny':         ['ecchi', 'fanservice', 'fan service', 'erotica', 'hentai', 'harem'],

  // ── Tier S #3 additions (2026-05-12) ─────────────────────────
  // Narrow patterns so each fires only on shows with the specific
  // AniList tag, not on collateral matches against broad genre words.
  //
  // 'intense' lives on the ENERGY axis — stakes/pressure intensity,
  // not necessarily fast pacing. 'thriller' deliberately overlaps
  // with 'dark' (rank-weighted firing handles dual-fires cleanly).
  'intense':       ['thriller', 'tense', 'high-stakes', 'death game', 'cold war'],
  // 'melancholic' lives on the TONE axis — wistful/somber register
  // distinct from 'bittersweet' (closure-with-loss) and 'dark'
  // (literal violence/tragedy). Patterns avoid the broad 'drama'
  // and 'tragedy' words, which already fire dark+bittersweet.
  'melancholic':   ['melancholy', 'wistful', 'somber', 'rueful', 'mono no aware'],
  // 'atmospheric' lives on the TEXTURE axis — surface-mood quality
  // foregrounded over plot. 'atmospheric' substring already fires
  // 'dreamy'; that co-fire is intentional ('dreamy' = ethereal feel,
  // 'atmospheric' = mood-is-the-point) — composite resolution sorts.
  'atmospheric':   ['atmospheric', 'ambient', 'contemplative', 'ethereal'],
};

const ALL_VIBE_CHIPS = VIBE_GROUPS.flatMap(g => g.chips);

// ── Search-bar lexicon (2026-05-14) ──────────────────────────
// User-facing synonyms for each vibe. Powers the "vibe today" search
// input: typing "bloody" surfaces dark + edgy because they both list
// 'bloody'. Curated, not auto-derived — pattern stems like 'iyashik' or
// 'psycho' aren't user words, and the patterns we DO want exposed
// ('comedy', 'horror', 'tragedy') are written here deliberately so the
// dropdown vocabulary is predictable.
//
// A word can intentionally appear under multiple vibes — that's the
// multi-mapping case ('sad' → bittersweet + dark; 'cute' → cozy +
// wholesome). The search dropdown shows the union as one row and
// committing that row adds all constituents.
const VIBE_SYNONYMS = Object.freeze({
  // ── ENERGY ────────────────────────────────────
  'chill':         ['mellow', 'lowkey', 'low-key', 'relaxing', 'calm', 'easy', 'lazy', 'soothing', 'gentle', 'iyashikei', 'cgdct'],
  'hype':          ['pumped', 'energetic', 'energy', 'amped', 'banger', 'exciting', 'thrilling', 'epic', 'loud', 'shounen', 'tournament'],
  'slow-burn':     ['slowburn', 'slow burn', 'slow', 'gradual', 'patient', 'deliberate', 'methodical', 'drama'],
  'action-packed': ['action', 'fights', 'fighting', 'combat', 'kinetic', 'fast-paced', 'fast', 'battles', 'martial arts', 'mecha'],
  'intense':       ['tense', 'thriller', 'gripping', 'suspense', 'suspenseful', 'edge of seat', 'nail-biting', 'high-stakes', 'stakes', 'pressure', 'death game'],

  // ── TONE ──────────────────────────────────────
  'wholesome':     ['sweet', 'kind', 'warm', 'heartwarming', 'feel-good', 'feelgood', 'nice', 'pure', 'fluffy', 'family-friendly', 'cute', 'happy'],
  'dark':          ['grim', 'bloody', 'gore', 'gory', 'brutal', 'gritty', 'heavy', 'bleak', 'dystopian', 'horror', 'scary', 'tragic', 'sad', 'twisted', 'tragedy', 'psychological'],
  'romantic':      ['romance', 'love', 'lovey', 'swoony', 'dating', 'couple'],
  'bittersweet':   ['sad', 'emotional', 'tearjerker', 'cry', 'crying', 'heartbreak', 'heartbreaking', 'poignant', 'sentimental'],
  'melancholic':   ['melancholy', 'wistful', 'somber', 'mournful', 'rueful', 'longing', 'yearning', 'nostalgic', 'mono no aware'],

  // ── HEADSPACE ─────────────────────────────────
  'thinky':        ['smart', 'cerebral', 'brainy', 'complex', 'intellectual', 'philosophical', 'philosophy', 'thoughtful', 'deep', 'mystery', 'puzzle', 'mind games', 'strategy', 'politics'],
  'escapist':      ['escape', 'fantasy', 'isekai', 'adventure', 'magic', 'magical', 'otherworldly', 'fantastical', 'parallel world', 'reincarnation'],
  'weird':         ['odd', 'strange', 'bizarre', 'surreal', 'trippy', 'avant-garde', 'experimental', 'absurd', 'eccentric', 'wacky'],
  'dreamy':        ['dream', 'dreamlike', 'ethereal', 'hazy', 'floaty', 'hypnotic', 'mystical', 'painterly'],
  'funny':         ['comedy', 'comedic', 'hilarious', 'laughs', 'lol', 'jokes', 'gag', 'humor', 'humorous', 'silly', 'slapstick', 'parody', 'satire', 'goofy'],

  // ── TEXTURE ───────────────────────────────────
  'cozy':          ['cosy', 'comfy', 'snug', 'comfort', 'soft', 'slice of life', 'slice-of-life', 'sol', 'food', 'tea', 'cute girls', 'cute'],
  'edgy':          ['violent', 'crime', 'gangster', 'mafia', 'noir', 'anti-hero', 'delinquent', 'rough', 'bloody', 'gore', 'badass', 'cool'],
  'hopeful':       ['hope', 'uplifting', 'inspiring', 'inspirational', 'encouraging', 'optimistic', 'redemption', 'growth', 'found family', 'found-family', 'sports', 'happy'],
  'horny':         ['spicy', 'sexy', 'ecchi', 'fanservice', 'fan service', 'lewd', 'smutty', 'naughty', 'raunchy', 'harem', 'hentai', 'erotica'],
  'atmospheric':   ['mood', 'moody', 'vibes', 'vibey', 'ambient', 'contemplative', 'lush', 'cinematic'],
});

// Inverted lexicon: lowercased word → Array<{ vibe, source }>.
// Built once at module load. Used by the search dropdown for live
// prefix/substring matching. 'source' encodes priority:
//   name (exact vibe-name)   → tier 1
//   synonym (curated)        → tier 2
const VIBE_LEXICON = (() => {
  const map = new Map();
  const PRIORITY = { name: 3, synonym: 2 };
  const add = (word, vibe, source) => {
    const w = String(word || '').toLowerCase().trim();
    if (!w) return;
    let entry = map.get(w);
    if (!entry) { entry = []; map.set(w, entry); }
    const existing = entry.find(e => e.vibe === vibe);
    if (existing) {
      if (PRIORITY[source] > PRIORITY[existing.source]) existing.source = source;
      return;
    }
    entry.push({ vibe, source });
  };
  for (const vibe of ALL_VIBE_CHIPS) add(vibe, vibe, 'name');
  for (const [vibe, words] of Object.entries(VIBE_SYNONYMS)) {
    for (const w of words) add(w, vibe, 'synonym');
  }
  return map;
})();

const VIBE_LEXICON_WORDS = Array.from(VIBE_LEXICON.keys()).sort();

// Search the vibe lexicon for live-filter dropdown rendering. Returns
//   Array<{ word, vibes: [vibeName, ...], tier }>
// tier: 'exact' | 'name-prefix' | 'synonym-prefix' | 'substring'
// Caller renders each entry as one dropdown row.
function searchVibeLexicon(query, opts = {}) {
  const MAX_RESULTS = opts.maxResults || 8;
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];

  const exact = [];
  const namePrefix = [];
  const synonymPrefix = [];
  const substring = [];

  for (const word of VIBE_LEXICON_WORDS) {
    const entries = VIBE_LEXICON.get(word);
    const isName = entries.some(e => e.source === 'name');
    if (word === q) exact.push(word);
    else if (word.startsWith(q)) (isName ? namePrefix : synonymPrefix).push(word);
    else if (word.includes(q)) substring.push(word);
  }

  const tiered = [
    ...exact.map(w => ({ word: w, tier: 'exact' })),
    ...namePrefix.map(w => ({ word: w, tier: 'name-prefix' })),
    ...synonymPrefix.map(w => ({ word: w, tier: 'synonym-prefix' })),
    ...substring.map(w => ({ word: w, tier: 'substring' })),
  ].slice(0, MAX_RESULTS);

  return tiered.map(({ word, tier }) => {
    const entries = VIBE_LEXICON.get(word);
    const seen = new Set();
    const vibes = [];
    for (const e of entries) {
      if (seen.has(e.vibe)) continue;
      seen.add(e.vibe);
      vibes.push(e.vibe);
    }
    // Cap constituents at 3 (grilling Q4): long rows hurt readability.
    return { word, vibes: vibes.slice(0, 3), tier, truncated: vibes.length > 3 };
  });
}

// Single-edit Levenshtein fallback for the no-match path. Returns a
// suggested lexicon word when typo distance ≤1, else null.
function suggestVibeWord(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q || q.length < 3) return null;
  if (VIBE_LEXICON.has(q)) return null;
  let best = null;
  let bestDist = 2;
  for (const word of VIBE_LEXICON_WORDS) {
    if (Math.abs(word.length - q.length) > 1) continue;
    const d = levenshteinAtMost(q, word, 1);
    if (d !== null && d < bestDist) { bestDist = d; best = word; }
  }
  return best;
}

function levenshteinAtMost(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const curr = new Array(lb + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return null;
    prev = curr;
  }
  return prev[lb] <= max ? prev[lb] : null;
}

// ── Tier S #2 (2026-05-12): category-aware pattern matching ──
//
// AniList tags carry a `category` field (Theme-Drama, Cast-Traits,
// Cast-Main Cast, Setting-Scene, Technical, Demographic, ...). Until
// this pass the matcher was category-blind, so a substring like
// 'anti-hero' fired 'edgy' whether it matched the Theme-Other tag
// "Anti-Hero-Driven" (narrative spine, legitimate edgy) or the
// Cast-Main Cast tag "Anti-Hero" (one character marker, NOT a mood
// signal).
//
// DEFAULT_CATEGORY_EXCLUDES applies to every vibe: character markers
// (Cast-Traits, Cast-Main Cast) describe people not mood; Technical
// describes animation/structure not feel. Demographic (Shounen,
// Shoujo) is deliberately NOT excluded — 'hype' patterns include
// 'shounen' which substring-matches the Demographic tag, and stripping
// it would regress hype firing across every shounen show.
//
// Per-pattern overrides via the object form
//   { pattern: 'foo', excludeCategories: ['Setting-Time'] }
// are additive to the default exclude set.
const DEFAULT_CATEGORY_EXCLUDES = Object.freeze(new Set([
  'Cast-Traits',
  'Cast-Main Cast',
  'Technical',
]));

// Axis lookup, used by the on-card vibe row to enforce axis diversity
// when picking single-vibe fallback chips.
const AXIS_OF = (() => {
  const m = {};
  for (const g of VIBE_GROUPS) for (const v of g.chips) m[v] = g.axis;
  return m;
})();

// Vibes that fire on >70% of the user's library (per scripts/vibe-probe.js
// against allShowsScored, 2026-05-10 snapshot). These are too universal
// to carry distinctive on-card signal — they'd render on nearly every
// show and duplicate the Genre row. Excluded from single-vibe fallback
// rendering only; they're still allowed as composite constituents when
// paired with a distinctive partner that makes the composite specific.
const UNIVERSAL_VIBES = new Set([
  'hype', 'action-packed', 'escapist', 'bittersweet', 'slow-burn',
]);

// Per-vibe rank floors. Layered on top of the global minRank floor that
// scoreVibeMatch / vibeMatchDetail pass into firedVibesFor. Some vibes
// carry such strong semantic claims that a low-rank tag mention isn't
// honest evidence — a passing Harem mention on a dark-fantasy show
// shouldn't fire "horny" the way Ecchi as a primary genre does. Lift
// those vibes' floors specifically without dragging up the global
// noise threshold. Empty fallback means use the caller's global floor.
const VIBE_MIN_RANK = {
  horny: 70, // walk 3: Shield Hero (rank ~50 Harem) was firing horny as sole vibe
};

// Single-vibe fallback phrases (W4 in the design grilling). Promotes
// the bare vibe word ("Chill") to a small editorial phrase ("Easy
// watch") so single-vibe fallback reads with similar register as the
// composite chips. Keyed by the same vibe names used in VIBE_GROUPS.
const VIBE_FALLBACK_PHRASES = {
  chill:           'Easy watch',
  hype:            'High-octane',
  'slow-burn':     'Slow build',
  'action-packed': 'Constant motion',
  wholesome:       'Wholesome heart',
  dark:            'Dark register',
  romantic:        'Romance front and center',
  bittersweet:     'Bittersweet',
  thinky:          'Cerebral one',
  escapist:        'Escapist trip',
  weird:           'Off-kilter',
  dreamy:          'Dreamlike',
  cozy:            'Soft watch',
  edgy:            'Has a bite',
  hopeful:         'Hopeful streak',
  horny:           'Spicy',
  funny:           'Big laughs',
  // Tier S #3 additions (2026-05-12)
  intense:         'Tightly wound',
  melancholic:     'Melancholy register',
  atmospheric:     'Atmospheric',
};

// Multi-vibe composite phrases. Hand-curated table of (vibe_A, vibe_B)
// → editorial phrase. Fires when BOTH constituent vibes fire on a show
// per VIBE_TO_TAG_PATTERNS. Composite "consumes" both constituent
// vibes — they won't also render as single-vibe fallback chips on the
// same card. Same architecture as Phase E MULTI_AXIS_IDIOMS.
//
// Table order is the editorial tiebreak: when multiple composites fire,
// the one declared earliest wins.
const VIBE_COMPOSITES = Object.freeze([
  // Ordering = priority. Composites earlier in the list win when multiple
  // fire on the same show (greedy + table-order tiebreak). We anchor the
  // distinctive vibes (weird / dreamy / thinky / hopeful — all <22% firing)
  // at the top so they dominate when present, then mid-distinctive
  // (edgy / horny / dark / romantic), then broad tone+comfort pairs as
  // last-resort defaults so "Wholesome warmth" doesn't carpet half the
  // library when richer composites exist.

  // ── Weird-anchored (weird fires on ~10% of library) ──
  { vibes: ['weird', 'dreamy'],      phrase: 'Dreamlike weirdness' },
  { vibes: ['weird', 'thinky'],      phrase: 'Cerebral weirdness' },
  { vibes: ['weird', 'wholesome'],   phrase: 'Sweet weirdness' },
  { vibes: ['dark', 'weird'],        phrase: 'Eerie weirdness' },
  // ── Dreamy-anchored (dreamy fires on ~10% of library) ──
  { vibes: ['dreamy', 'thinky'],     phrase: 'Quietly meditative' },
  { vibes: ['dreamy', 'romantic'],   phrase: 'Soft daydream' },
  { vibes: ['dreamy', 'chill'],      phrase: 'Drifting calm' },
  // ── Atmospheric-anchored (Tier S #3, 2026-05-12) ──
  // 'atmospheric' fires on a narrow tag set (atmospheric / ambient /
  // contemplative / ethereal) — the rarest vocabulary slot. Placed
  // high in the table so Bebop / Mushishi / Mononoke get Wistful noir
  // / Quiet drift / Contemplative depth before falling back to Sharp
  // edge / Heavy thinker / etc.
  { vibes: ['atmospheric', 'dark'],     phrase: 'Wistful noir' },
  { vibes: ['atmospheric', 'thinky'],   phrase: 'Contemplative depth' },
  { vibes: ['atmospheric', 'chill'],    phrase: 'Quiet drift' },
  { vibes: ['atmospheric', 'bittersweet'], phrase: 'Quiet ache' },
  // ── Intense-anchored (Tier S #3) ──
  // 'intense' (thriller/tense/high-stakes/death-game) — stakes-pressure
  // distinct from 'dark' (literal violence/horror) and 'action-packed'
  // (combat density). Slow-build dread wins over Heavy thinker on
  // PSYCHO-PASS / Monster / Death Note where thriller-grade tension
  // is the central register, not philosophical contemplation alone.
  { vibes: ['intense', 'thinky'],    phrase: 'Slow-build dread' },
  { vibes: ['intense', 'dark'],      phrase: 'Cold-blooded thriller' },
  // ── Melancholic-anchored (Tier S #3) ──
  // 'melancholic' (melancholy/wistful/somber/rueful/mono-no-aware) is
  // narrower than 'bittersweet' — it's the prevailing register, not
  // a closing emotional beat. Tragic romance wins over Doomed romance
  // on Clannad / Anohana / KimiUso where the relationship's emotional
  // weight is grief-coded rather than violence-coded.
  { vibes: ['melancholic', 'romantic'], phrase: 'Tragic romance' },
  { vibes: ['melancholic', 'chill'],    phrase: 'Wistful cool' },
  // ── Thinky-anchored (thinky fires on ~22% of library) ──
  // Heavy thinker (dark+thinky) deliberately demoted to the bottom
  // of distinctive composites — it over-fired on shounen action
  // (DS / OP / Trigun) which all carry Tragedy + Psychological tags
  // at rank ≥50 but read as action-comedy, not philosophical. Sharp
  // edge (dark+edgy) and the funny-anchored composites need to fire
  // first on those shows. Heavy thinker is reserved for shows with
  // genuine cerebral weight where action/comedy signals are absent
  // (PSYCHO-PASS, Bebop, etc.).
  { vibes: ['thinky', 'hopeful'],    phrase: 'Hopeful thinker' },
  { vibes: ['thinky', 'cozy'],       phrase: 'Thoughtful comfort' },
  // ── Funny-anchored (comedy/parody/satire/slapstick) ──
  // Romcom energy demoted to broad-defaults (2026-05-12 rank-weighted
  // pass): Comedy + Romance tags both fire at genre-strength 100 on
  // ~25% of the library (any show with a Comedy genre + Romance tag),
  // so without demotion Romcom energy dominated Mashle, Berserk of
  // Gluttony, Apothecary, Spice and Wolf — none of which are romcoms.
  // Now it only wins when no rarer composite fires (e.g., Tonikawa).
  { vibes: ['funny', 'weird'],       phrase: 'Absurd comedy' },
  { vibes: ['funny', 'thinky'],      phrase: 'Witty comedy' },
  { vibes: ['funny', 'edgy'],        phrase: 'Sharp comedy' },
  { vibes: ['funny', 'dark'],        phrase: 'Dark comedy' },
  { vibes: ['funny', 'cozy'],        phrase: 'Cozy comedy' },
  { vibes: ['funny', 'wholesome'],   phrase: 'Wholesome comedy' },
  { vibes: ['chill', 'funny'],       phrase: 'Easy laughs' },
  // ── Hopeful-anchored (hopeful fires on ~20% of library) ──
  // Tier A #4 (2026-05-12): sports / competition anime gap.
  // 'hype' is universal-filtered (can't single-fire) but pairs well
  // with hopeful/wholesome here. Captures Haikyuu / Kuroko / Free /
  // Yuri on Ice / Run with the Wind / Megalo Box / etc. where the
  // central register is competitive energy + character bond growth.
  { vibes: ['hype', 'hopeful'],      phrase: 'Underdog hustle' },
  { vibes: ['hype', 'wholesome'],    phrase: 'Heartfelt energy' },
  { vibes: ['hopeful', 'cozy'],      phrase: 'Hopeful warmth' },
  { vibes: ['hopeful', 'wholesome'], phrase: 'Hopeful heart' },
  // ── Mid-distinctive (rarer textures / charged tones) ──
  // Doomed romance demoted to broad-defaults (2026-05-12 user-judgment
  // pass): the dark+romantic composite fires whenever a show has any
  // Romance tag + any Tragedy/Gore/etc tag, which includes shows where
  // the romance isn't doomed at all (Hyouka's Chitanda/Oreki dynamic).
  // The phrase makes a strong editorial claim that fits Re:Zero, CSM
  // Reze Arc, but overstates Hyouka. Demoting means it only fires when
  // no rarer composite applies.
  { vibes: ['edgy', 'horny'],        phrase: 'Sharp heat' },
  { vibes: ['edgy', 'romantic'],     phrase: 'Edged romance' },
  { vibes: ['romantic', 'thinky'],   phrase: 'Thoughtful romance' },
  // Tier A #4 (2026-05-12): mature/measured romance pacing gap.
  // 'slow-burn' is universal-filtered but pairs distinctively here
  // for Spice and Wolf / Tsuki ga Kirei / Maquia / Eve no Jikan
  // where deliberate pacing is the romantic register itself.
  { vibes: ['slow-burn', 'romantic'], phrase: 'Slow-burn romance' },
  { vibes: ['dark', 'edgy'],         phrase: 'Sharp edge' },
  { vibes: ['horny', 'romantic'],    phrase: 'Spicy romance' },
  { vibes: ['dark', 'hopeful'],      phrase: 'Bitter hope' },
  // Heavy thinker — lowest distinctive priority (see comment above).
  { vibes: ['dark', 'thinky'],       phrase: 'Heavy thinker' },
  // ── Broad defaults (only fire when nothing rarer applies) ──
  // Romcom energy renamed → "Light romance" (2026-05-12): "Romcom
  // energy" implies sitcom-comedy register, overstated Spice and Wolf
  // and Apothecary which are slow-burn / mystery with romance subplot,
  // not energetic romcoms. "Light romance" reads as soft, mild — fits
  // a wider range of romance-with-comedy shows accurately.
  { vibes: ['cozy', 'romantic'],     phrase: 'Cozy romance' },
  { vibes: ['chill', 'romantic'],    phrase: 'Lowkey romance' },
  { vibes: ['romantic', 'wholesome'], phrase: 'Sweet romance' },
  { vibes: ['dark', 'romantic'],     phrase: 'Doomed romance' },
  { vibes: ['funny', 'romantic'],    phrase: 'Light romance' },
  { vibes: ['chill', 'cozy'],        phrase: 'Comfort watch' },
  { vibes: ['chill', 'wholesome'],   phrase: 'Easy warmth' },
  { vibes: ['cozy', 'wholesome'],    phrase: 'Wholesome warmth' },
]);

// O(1) lookup: sorted-pair key → composite entry.
const VIBE_COMPOSITE_INDEX = (() => {
  const m = new Map();
  for (const entry of VIBE_COMPOSITES) {
    const [a, b] = [...entry.vibes].sort();
    m.set(`${a}||${b}`, entry);
  }
  return m;
})();

// PUBLIC vibe-firing surface. Single source of truth for "which vibes
// fire on this rec?" — used by the on-card composer (composeVibeChips),
// the side-panel filter (scoreVibeMatch composes from this implicitly),
// and probe scripts (scripts/vibe-probe.js imports rather than
// reimplements). Any change to vibe-firing semantics goes here; callers
// don't pattern-match independently.
//
// Contract (Tier S #1, 2026-05-12):
//   firedVibesFor(rec, opts?) → Map<vibeName, strength>
//   strength = max rank of any firing tag/genre. Genres score 100.
//   opts.minRank optional hard cutoff for noise floor.
//
// Returns Map<vibeName, strength> (Tier S #1, 2026-05-12). strength =
// max rank of any firing tag/genre on the rec. Genres always score
// 100 (canonical category). Backward compat: Map.has(vibe) gives the
// same "did this fire?" boolean as the prior Set return; .keys()
// iterates the same vibe names.
//
// Why strength weighting (replacing the prior binary Set):
//   Substring-coupling produced misfires (Bebop "Easy warmth" from a
//   low-rank Slice-of-Life tag; Demon Slayer Heavy thinker from a
//   rank-50 Psychological tag despite the show being action-spectacle).
//   The old fix was rank-≥50 strict floor for composite-pass + loose
//   for fallback — two passes, sharp threshold, surprising sparseness.
//   Strength weighting subsumes both: weak signals score weakly and
//   naturally lose to strong signals; no threshold cliff.
//
// opts.minRank is an optional HARD cutoff (drop tags below this rank
// entirely). Strength weighting is the primary mechanism; minRank is
// a noise-floor for callers that want to drop rounding-noise signals.
// Genres ignore minRank — they're canonical.
function firedVibesFor(rec, opts = {}) {
  const result = new Map();
  const minRank = opts.minRank || 0;
  // Per-vibe rank floor takes the max of (caller's global floor, the
  // vibe-specific floor in VIBE_MIN_RANK). Genres still bypass the
  // floor entirely inside collectTagSources — they're canonical, so a
  // Hentai or Ecchi genre still fires horny regardless of this lift.
  const sources = collectTagSources(rec, { minRank });
  if (!sources.length) return result;
  for (const vibe of ALL_VIBE_CHIPS) {
    const patterns = VIBE_TO_TAG_PATTERNS[vibe];
    if (!patterns) continue;
    const vibeFloor = Math.max(minRank, VIBE_MIN_RANK[vibe] || 0);
    let bestStrength = 0;
    for (const src of sources) {
      const matchedPattern = matchPattern(src, patterns);
      if (!matchedPattern) continue;
      // Genres always pass (strength=100, canonical). Tag-sourced fires
      // must meet the per-vibe floor.
      if (src.category !== 'Genre' && src.strength < vibeFloor) continue;
      if (src.strength > bestStrength) bestStrength = src.strength;
    }
    if (bestStrength > 0) result.set(vibe, bestStrength);
  }
  return result;
}

// Returns the matching pattern entry (or null). Patterns may be bare
// strings or { pattern, excludeCategories } objects. A source matches
// if (a) its lowercased text contains the pattern AND (b) its category
// is not in the default exclude set AND (c) its category is not in
// the per-pattern override exclude list.
//
// Sources with no category (null/undefined) bypass exclude checks —
// they're either legacy data from before Tier S #2 plumbing or a tag
// AniList didn't categorize. Treat as fireable; the substring match
// is the only evidence we have.
function matchPattern(src, patterns) {
  for (const p of patterns) {
    const pat = typeof p === 'string' ? p : p?.pattern;
    if (!pat || !src.text.includes(pat)) continue;
    if (src.category) {
      if (DEFAULT_CATEGORY_EXCLUDES.has(src.category)) continue;
      const overrides = (typeof p === 'object' && p.excludeCategories) || null;
      if (overrides && overrides.includes(src.category)) continue;
    }
    return p;
  }
  return null;
}

// Debug helper: returns explanation of WHY a specific vibe fired (or
// didn't) on a rec. For overlays, "explain this vibe" tooltips, and
// regression testing. Returns:
//   { fired, patterns: [{ pattern, matchedTag, tagRank }], skipped: [{ pattern, reason }] }
function explainVibeFiring(rec, vibe, opts = {}) {
  const patterns = VIBE_TO_TAG_PATTERNS[vibe] || [];
  const minRank = opts.minRank || 0;
  const tagEntries = (rec?.topTags || [])
    .filter(t => t?.tag)
    .map(t => ({ tag: String(t.tag).toLowerCase(), originalTag: t.tag, rank: t.rank || 0, category: t.category || null }));
  const genreEntries = (rec?.genres || [])
    .filter(Boolean)
    .map(g => ({ tag: String(g).toLowerCase(), originalTag: g, rank: null, category: 'Genre' }));
  const hits = [];
  for (const p of patterns) {
    const pat = typeof p === 'string' ? p : p?.pattern;
    const overrides = (typeof p === 'object' && p.excludeCategories) || null;
    if (!pat) continue;
    for (const entry of [...tagEntries, ...genreEntries]) {
      if (!entry.tag.includes(pat)) continue;
      if (minRank > 0 && entry.rank !== null && entry.rank < minRank) {
        hits.push({ pattern: pat, matchedTag: entry.originalTag, tagRank: entry.rank, category: entry.category, skipped: 'below-rank' });
        continue;
      }
      if (entry.category && DEFAULT_CATEGORY_EXCLUDES.has(entry.category)) {
        hits.push({ pattern: pat, matchedTag: entry.originalTag, tagRank: entry.rank, category: entry.category, skipped: 'category-default-exclude' });
        continue;
      }
      if (entry.category && overrides && overrides.includes(entry.category)) {
        hits.push({ pattern: pat, matchedTag: entry.originalTag, tagRank: entry.rank, category: entry.category, skipped: 'category-pattern-override' });
        continue;
      }
      hits.push({ pattern: pat, matchedTag: entry.originalTag, tagRank: entry.rank, category: entry.category });
    }
  }
  const fired = hits.some(h => !h.skipped);
  return { fired, vibe, hits };
}

// On-card vibe-row composer. Returns up to 2 chips:
//   1. composite pass — score each viable composite by sum of
//      constituent vibe strengths; greedy pick highest, table-order
//      tiebreak when scores match.
//   2. single-vibe fallback — sort remaining firing non-universal
//      vibes by strength desc; greedy pick top 2 with axis-diversity
//      (second chip from a different axis than the first, within the
//      fallback row).
//
// Each chip is { text, source: 'vibe-composite' | 'vibe-single',
// vibes: [name, ...], score? }. Caller renders them as descriptive
// chips (lavender tint).
function composeVibeChips(rec) {
  const fired = firedVibesFor(rec);  // Map<vibe, strength>
  if (!fired.size) return [];

  const used = new Set();
  const chips = [];

  // 1. Composite pass — score every matching composite, sort by
  //    score desc, greedy consume.
  //
  //    Score = strength_sum + position_bonus. The position bonus
  //    encodes editorial priority: VIBE_COMPOSITES is ordered from
  //    rarest-anchor (weird/dreamy at the top) to broadest defaults
  //    (cozy×wholesome at the bottom). Without a position term, a
  //    broad high-strength composite like Romcom energy (funny=100 +
  //    romantic=100 = 200) would dominate every romance-adjacent
  //    show, drowning out rarer, more distinctive composites. The
  //    bonus = ((LEN - tableIndex) / LEN) × POSITION_WEIGHT keeps
  //    strength as the primary signal while letting editorial order
  //    break near-ties in favor of the distinctive composite.
  const POSITION_WEIGHT = 60;
  const LEN = VIBE_COMPOSITES.length;
  const matches = [];
  for (let i = 0; i < LEN; i++) {
    const entry = VIBE_COMPOSITES[i];
    const [a, b] = entry.vibes;
    const sa = fired.get(a) || 0;
    const sb = fired.get(b) || 0;
    if (sa === 0 || sb === 0) continue;
    const positionBonus = ((LEN - i) / LEN) * POSITION_WEIGHT;
    matches.push({ entry, score: sa + sb + positionBonus, tableIndex: i });
  }
  matches.sort((x, y) => y.score - x.score || x.tableIndex - y.tableIndex);

  for (const m of matches) {
    if (chips.length >= 2) break;
    const [a, b] = m.entry.vibes;
    if (used.has(a) || used.has(b)) continue;
    chips.push({
      text: m.entry.phrase,
      source: 'vibe-composite',
      vibes: [a, b],
      score: m.score,
    });
    used.add(a); used.add(b);
  }

  // 2. Single-vibe fallback. Two passes:
  //    Pass A — strength desc with axis-diversity (one pick per axis).
  //    Pass B — if we still have <2 chips and any non-universal vibes
  //             remain unused, take the next strongest regardless of
  //             axis. Memory walks (2 and 3) flagged Konosuba / Mashle /
  //             Vivy rendering single-chip rows because their two
  //             distinctive fires landed in the same axis (funny +
  //             thinky on headspace, weird + dreamy on headspace, etc.).
  //             Axis diversity correctly suppresses near-duplicates
  //             within other axes (chill+slow-burn would feel samey),
  //             but headspace's vibes are conceptually distinct enough
  //             that funny+thinky as a pair reads richer than funny
  //             alone. Pass B unlocks that without weakening pass A.
  if (chips.length < 2) {
    const fallbackCandidates = [];
    for (const [vibe, strength] of fired) {
      if (used.has(vibe)) continue;
      if (UNIVERSAL_VIBES.has(vibe)) continue;
      fallbackCandidates.push({ vibe, strength, axis: AXIS_OF[vibe] });
    }
    fallbackCandidates.sort((a, b) => b.strength - a.strength);

    // Pass A — axis-diverse picks.
    const fallbackAxesUsed = new Set();
    for (const cand of fallbackCandidates) {
      if (chips.length >= 2) break;
      if (fallbackAxesUsed.has(cand.axis)) continue;
      chips.push({
        text: VIBE_FALLBACK_PHRASES[cand.vibe] || capitalize(cand.vibe),
        source: 'vibe-single',
        vibes: [cand.vibe],
        score: cand.strength,
      });
      used.add(cand.vibe);
      fallbackAxesUsed.add(cand.axis);
    }

    // Pass B — same-axis recovery for the second slot. Only kicks in
    // when pass A returned exactly one chip AND a stronger same-axis
    // alternative exists. Prevents single-chip rows on shows where
    // two equally-distinctive fires land on the same conceptual axis.
    if (chips.length === 1) {
      for (const cand of fallbackCandidates) {
        if (used.has(cand.vibe)) continue;
        chips.push({
          text: VIBE_FALLBACK_PHRASES[cand.vibe] || capitalize(cand.vibe),
          source: 'vibe-single',
          vibes: [cand.vibe],
          score: cand.strength,
        });
        used.add(cand.vibe);
        break;
      }
    }
  }

  return chips;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }


// Score a single rec against a list of selected vibes. Returns an integer
// 0..N where N = selected.length. Backward-compat with the side panel
// filter — count semantics preserved (a vibe either matched or didn't).
// Internally now derived from firedVibesFor's strength Map, but the
// caller sees the same integer count behavior as before strength
// weighting shipped.
function scoreVibeMatch(rec, selectedVibes) {
  if (!selectedVibes || !selectedVibes.length) return 0;
  const fired = firedVibesFor(rec);
  if (!fired.size) return 0;
  let score = 0;
  for (const vibe of selectedVibes) {
    if (fired.has(vibe)) score++;
  }
  return score;
}

// Strength-aware variant. Returns { count, weighted, perVibe } where
// count is the same integer scoreVibeMatch returns, weighted is the
// sum of per-vibe strengths (0..100 each — rank from topTags or 100
// for canonical genre matches), and perVibe is a Map<vibe, strength>
// of just the selected vibes that fired (subset of firedVibesFor's
// output). The side-panel filter uses `weighted` for ranking so
// strong-fire matches outrank weak-fire matches even when count ties.
//
// Options:
//   minRank — drop tag-source fires below this rank (genres always
//     pass; they're canonical). Defaults to 50: empirical sweep with
//     8 vibes selected showed that broad shounen were firing 4 vibes
//     via weak Tragedy/Psychological hits (rank 30-40) overlapping
//     across multiple "sad" vibes (bittersweet + melancholic both
//     map to Tragedy). The floor cuts the noise without touching
//     genuine high-rank matches.
function vibeMatchDetail(rec, selectedVibes, opts = {}) {
  if (!selectedVibes || !selectedVibes.length) {
    return { count: 0, weighted: 0, perVibe: new Map() };
  }
  const minRank = opts.minRank ?? 50;
  const fired = firedVibesFor(rec, { minRank });
  if (!fired.size) return { count: 0, weighted: 0, perVibe: new Map() };
  let count = 0;
  let weighted = 0;
  const perVibe = new Map();
  for (const vibe of selectedVibes) {
    const strength = fired.get(vibe);
    if (strength === undefined) continue;
    count++;
    weighted += strength;
    perVibe.set(vibe, strength);
  }
  return { count, weighted, perVibe };
}

// Returns Array<{text, strength}> for matching. text is the lowercased
// tag/genre name; strength is the rank (0-100) for topTags or 100 for
// genres (canonical category, see Tier S #1 grilling Q2b).
function collectTagSources(rec, opts = {}) {
  const out = [];
  const minRank = opts.minRank || 0;
  if (Array.isArray(rec?.topTags)) {
    for (const t of rec.topTags) {
      if (!t?.tag) continue;
      const rank = t.rank || 0;
      if (minRank > 0 && rank < minRank) continue;
      out.push({
        text: String(t.tag).toLowerCase(),
        strength: rank,
        category: t.category || null,
      });
    }
  }
  if (Array.isArray(rec?.genres)) {
    for (const g of rec.genres) {
      if (!g) continue;
      out.push({
        text: String(g).toLowerCase(),
        strength: 100,
        category: 'Genre',
      });
    }
  }
  return out;
}

// Legacy text-only haystack used by scoreVibeMatch (kept for stable
// side-panel filter behavior — count semantics, not strength).
function collectTagText(rec, opts = {}) {
  return collectTagSources(rec, opts).map(s => s.text);
}
window.VIBE_TAGS = {
  VIBE_GROUPS,
  VIBE_TO_TAG_PATTERNS,
  ALL_VIBE_CHIPS,
  AXIS_OF,
  UNIVERSAL_VIBES,
  VIBE_FALLBACK_PHRASES,
  VIBE_COMPOSITES,
  DEFAULT_CATEGORY_EXCLUDES,
  VIBE_SYNONYMS,
  VIBE_LEXICON,
  scoreVibeMatch,
  vibeMatchDetail,
  firedVibesFor,
  collectTagSources,
  explainVibeFiring,
  composeVibeChips,
  searchVibeLexicon,
  suggestVibeWord,
};
})();
