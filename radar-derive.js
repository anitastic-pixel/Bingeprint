// Taste Shape radar — 8-axis derivation per PRD-NORTH-STAR Q17 +
// PRD-SCORING-PHILOSOPHY. Pure module, no chrome.* APIs.
//
// PURPOSE
//
// The radar is the user-facing "what kind of viewer are you?" surface
// (a sibling to the engine-internal genre archetypes). 8 axes derived
// from existing taste-vector tag mass — no new tracking required.
// DESCRIPTIVE only: this output doesn't drive scoring math. It's a
// summary of what came out the other end.
//
// AXES
//
// 1. Spectacle Drive          — animation, action, visual energy
// 2. Narrative Depth          — story structure, lore, mystery
// 3. Character Attachment     — arcs, relationships, ensembles
// 4. Emotional Intensity      — drama, tragedy, dark themes
// 5. Comfort Seeking          — slice of life, healing, low stakes
// 6. Comedy / Chaos Appetite  — gags, absurdism, chaotic pacing
// 7. Romance & Spice          — chemistry, intimacy, ecchi tolerance
// 8. Curiosity Streak         — auteur, prestige, niche, exploratory
//
// EACH AXIS is a weighted sum of relevant positive tag masses from
// the user's taste vector. Tags appearing in multiple axes are fine
// (and intentional — "Drama" contributes to both Emotional Intensity
// and Character Attachment). Output is per-user-normalized: the
// strongest axis maps to 1.0, others scale relatively. The radar
// is a SHAPE; the absolute magnitude doesn't carry meaning.
//
// TAG WEIGHTS reflect how strongly each tag is a signal for that
// axis. Higher = more discriminating. A tag with weight 1.5 contributes
// 50% more than a weight-1.0 tag at the same user-mass.

// Exported so the sidepanel's dev axis-sandbox can build a synthetic
// radar with the same axis IDs / names without duplicating the
// constant. Read-only from outside; not mutated.
export const AXIS_DEFS = [
  {
    id: 'spectacle',
    name: 'Spectacle Drive',
    shortName: 'Spectacle',
    description: 'animation, action, visual energy',
    tags: {
      'Action': 1.0, 'Battle': 1.0, 'Fight Scenes': 1.5, 'Tournament': 1.2,
      'Super Power': 1.0, 'Martial Arts': 1.0, 'Mecha': 0.8,
      'Magic': 0.6, 'Sword Fighting': 1.0, 'Gun Action': 1.0, 'Chase': 0.8,
    },
  },
  {
    id: 'narrative-depth',
    name: 'Narrative Depth',
    shortName: 'Narrative',
    description: 'story structure, lore, mystery',
    tags: {
      'Mystery': 1.5, 'Conspiracy': 1.5, 'Investigation': 1.0, 'Mind Games': 1.5,
      'Detective': 1.0, 'Politics': 1.0, 'War': 0.8, 'Time Loop': 1.0,
      'Time Manipulation': 1.0, 'Philosophy': 1.0, 'Memory Manipulation': 0.8,
      'Psychological': 1.2,
    },
  },
  {
    id: 'character-attachment',
    name: 'Character Attachment',
    shortName: 'Character',
    description: 'arcs, relationships, ensembles',
    tags: {
      'Drama': 1.0, 'Coming of Age': 1.2, 'Found Family': 1.5, 'Ensemble Cast': 1.2,
      'Friendship': 1.0, 'Family Life': 1.0, 'Mentor': 0.8, 'Anti-Hero': 0.8,
      'Female Protagonist': 0.5, 'Male Protagonist': 0.5, 'Tsundere': 0.5,
      'Estranged Family': 1.0,
    },
  },
  {
    id: 'emotional-intensity',
    name: 'Emotional Intensity',
    shortName: 'Emotion',
    description: 'drama, tragedy, dark themes',
    tags: {
      'Tragedy': 1.5, 'Drama': 1.0, 'Death': 1.2, 'Gore': 1.0, 'Violence': 0.8,
      'Survival': 1.0, 'Horror': 1.2, 'Psychological': 1.2, 'Mature Themes': 1.0,
      'Suffering': 1.5, 'War': 0.8, 'Trauma': 1.5, 'Existentialism': 1.0,
      'Post-Apocalyptic': 1.0,
    },
  },
  {
    id: 'comfort-seeking',
    name: 'Comfort Seeking',
    shortName: 'Comfort',
    description: 'slice of life, healing, low stakes',
    tags: {
      'Slice of Life': 1.5, 'Iyashikei': 2.0, 'Cute Girls Doing Cute Things': 1.5,
      'School Club': 1.0, 'Cooking': 1.0, 'Food': 1.0, 'Daily Life': 1.5,
      'Rural': 0.8, 'Hot Springs': 0.8, 'Camping': 1.0, 'Music': 0.5,
      'CGDCT': 1.5, 'Iyashikei (Healing)': 2.0,
    },
  },
  {
    id: 'comedy-chaos',
    name: 'Comedy / Chaos Appetite',
    shortName: 'Comedy',
    description: 'gags, absurdism, chaotic pacing',
    tags: {
      'Comedy': 1.5, 'Parody': 1.2, 'Satire': 1.0, 'Slapstick': 1.0,
      'Surreal Comedy': 1.5, 'Absurdist Humor': 1.5, 'Gag Manga': 1.2,
      'Wholesome': 0.5, 'Self-Aware': 1.0, 'Random Comedy': 1.5,
    },
  },
  {
    id: 'romance-spice',
    name: 'Romance & Spice',
    shortName: 'Romance',
    description: 'chemistry, intimacy, ecchi tolerance',
    tags: {
      'Romance': 1.0, 'Romcom': 1.0, 'Love Triangle': 1.0, 'Female Harem': 0.8,
      'Male Harem': 0.8, 'Heterosexual': 0.4, 'Boys\' Love': 0.8, 'Yuri': 0.8,
      'Ecchi': 1.5, 'Nudity': 1.5, 'Fanservice': 1.2,
      'Sexual Tension': 1.0, 'Slow Burn Romance': 1.0, 'Confession': 0.8,
      'Marriage': 0.5,
    },
  },
  {
    id: 'curiosity-streak',
    name: 'Curiosity Streak',
    shortName: 'Curiosity',
    description: 'auteur, prestige, niche, exploratory',
    tags: {
      'Avant Garde': 2.0, 'Surreal': 1.5, 'Experimental': 2.0, 'Arthouse': 2.0,
      'Philosophical': 1.5, 'Cyberpunk': 1.0, 'Noir': 1.0, 'Historical': 0.8,
      'Mythology': 0.8, 'Anthology': 1.2, 'Found Footage': 1.5, 'Surrealism': 1.5,
      'Hard Sci-Fi': 1.2, 'Folklore': 1.0, 'Dystopia': 1.0,
    },
  },
];

// Title can come through as either a string (legacy contributions) or
// AniList's { english, romaji, native } object. Prefer english → romaji
// → native → fallback.
function pickTitle(t) {
  if (!t) return '(untitled)';
  if (typeof t === 'string') return t;
  return t.english || t.romaji || t.native || '(untitled)';
}

// Compute the raw aggregated mass for one axis given a user's tag map.
function rawAxisValue(axisDef, tagMass) {
  let sum = 0;
  for (const [tag, weight] of Object.entries(axisDef.tags)) {
    const userMass = tagMass[tag] || 0;
    if (userMass > 0) sum += userMass * weight;
  }
  return sum;
}

// Derive the 8-axis radar from a taste vector.
//
// Inputs:
//   tasteVector — the 'all' mode taste vector. Uses .raw (tag → mass)
//                 and .contributions (tag → list of contributing shows)
//                 for G11-deep show-level audit drilldown.
//   opts.signalSeriesCount — count of completed + in-progress series
//                            (the signal-bearing slice). Feeds the
//                            confidence-level computation. Dropped /
//                            sampled don't count — they're noise here.
//
// Output: extended radar object with axes (each axis carries
// contributingTags, contributingShows). Plus top-level fields:
//   - confidenceLevel: 'cold' | 'thin' | 'calibrated' (Q7)
//
// Returns null if tasteVector is missing or empty.
export function deriveRadar(tasteVector, opts = {}) {
  if (!tasteVector || !tasteVector.raw) return null;
  const raw = tasteVector.raw;
  // Use only positive tag mass (negative is anti-tag; doesn't shape the
  // "what kind of viewer are you" picture — radar is what you LIKE, not
  // what you reject. Negative tags would surface differently if/when
  // we add a "what doesn't work for you" panel).
  const positive = {};
  for (const [tag, w] of Object.entries(raw)) {
    if (w > 0) positive[tag] = w;
  }

  // G11-deep: per-axis contributing shows. Walks the user's
  // tasteVector.contributions map (which records {seriesId,
  // seriesTitle, weight} per tag) so each axis can surface the
  // shows that drove its value. Aggregates per-show contribution
  // = sum of (positive show-tag-weight × axis-tag-weight) across
  // tags this axis cares about. Negative contributions (drops)
  // skipped — radar shows what you LIKE, the contributing-shows
  // panel matches the same framing.
  const contribsByTag = tasteVector.contributions || {};

  const rawValues = AXIS_DEFS.map(def => {
    // G11: per-axis contributing tags.
    const tagContribs = [];
    for (const [tag, weight] of Object.entries(def.tags)) {
      const userMass = positive[tag] || 0;
      if (userMass > 0) {
        tagContribs.push({
          tag,
          contribution: +(userMass * weight).toFixed(2),
          userMass: +userMass.toFixed(2),
        });
      }
    }
    tagContribs.sort((a, b) => b.contribution - a.contribution);

    // G11-deep: per-axis contributing shows. Aggregate per-series
    // contribution across this axis's tags. A show contributes to
    // Spectacle if its Action / Battle / Fight Scenes etc. tags
    // each contributed to the user's tag mass; sum those up.
    const showAgg = new Map(); // seriesId -> { seriesId, title, contribution }
    for (const [tag, axisWeight] of Object.entries(def.tags)) {
      const list = contribsByTag[tag];
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (!c || typeof c.weight !== 'number' || c.weight <= 0) continue;
        const id = c.seriesId;
        if (!id) continue;
        const existing = showAgg.get(id);
        const inc = c.weight * axisWeight;
        const title = pickTitle(c.seriesTitle);
        if (existing) {
          existing.contribution += inc;
        } else {
          showAgg.set(id, { seriesId: id, title, contribution: inc });
        }
      }
    }
    const showContribs = Array.from(showAgg.values())
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 8) // top 8 — enough to recognize the pattern, not so many the panel sprawls
      .map(s => ({ ...s, contribution: +s.contribution.toFixed(2) }));

    return {
      id: def.id,
      name: def.name,
      shortName: def.shortName || def.name,
      description: def.description,
      rawValue: +rawAxisValue(def, positive).toFixed(3),
      contributingTags: tagContribs.slice(0, 6),
      contributingShows: showContribs,
    };
  });

  // Per-user normalization: the strongest axis maps to 1.0; others
  // scale relatively. Radar is a relative shape; absolute magnitude
  // doesn't carry meaning across users with different catalog sizes.
  // Falls back to all-zeros if user has no positive tag mass.
  const maxRaw = rawValues.reduce((m, a) => Math.max(m, a.rawValue), 0);
  const axes = rawValues.map(a => ({
    ...a,
    value: maxRaw > 0 ? +(a.rawValue / maxRaw).toFixed(3) : 0,
  }));

  return {
    schema: 1,
    axes,
    maxRaw, // diagnostic: helps tune absolute axis weights if needed
    generatedFrom: 'all',
    generatedAt: Date.now(),
    confidenceLevel: confidenceLevelFor(tasteVector, opts),
    // Surfaces (e.g. Shape tab) need the raw count to render gradient
    // confidence treatments — engine's three-band cold/thin/calibrated
    // is too coarse on its own (calibrated kicks in at 8 shows but the
    // mid-rank archetypes are still noisy until ~80).
    signalSeriesCount: opts.signalSeriesCount ?? 0,
  };
}

// Top N axes by normalized value. Used by the prose summary to lead
// with the user's strongest. N defaults to 3 — friend-voice "you're
// X + Y + Z" reads cleanest at 3.
export function topAxes(radar, n = 3) {
  if (!radar?.axes) return [];
  return radar.axes
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

// Bottom N axes (lowest signal). Used by prose summary for the
// "low priority" line — what you don't watch for. Internal-only;
// the only consumers are proseFor and shapeIdentityFor in this file.
function bottomAxes(radar, n = 1) {
  if (!radar?.axes) return [];
  return radar.axes
    .slice()
    .sort((a, b) => a.value - b.value)
    .slice(0, n);
}

// Templated friend-voice prose summary. Uses top 3 highs + bottom 1 low.
// Each axis has a "high" template and a "low" template; the summary
// concatenates the relevant ones into 2-3 sentences. Per
// PRD-NORTH-STAR Q18 (template-prose primary).
const HIGH_TEMPLATES = {
  'spectacle': "you watch for the big moments — fights, transformations, peak animation",
  'narrative-depth': "you want stories with weight — mystery, lore, payoff",
  'character-attachment': "you get invested in the cast — arcs, relationships, the people",
  'emotional-intensity': "you don't shy from drama or dark themes",
  'comfort-seeking': "you value cozy, low-stress shows that you can sink into",
  'comedy-chaos': "you have a high tolerance for chaos and absurd humor",
  'romance-spice': "romance and spice are part of the appeal",
  'curiosity-streak': "you reach for the experimental and offbeat",
};
// Per-axis variant pools for the low-axis tail. 3–4 phrasings each so
// two archetypes sharing the same low axis don't both wear "spectacle
// isn't the draw" — pickLowVariant hashes (archetype, axis) to a
// stable index. Variant 0 in each list is the legacy phrasing, kept
// so the change is additive rather than a wholesale rewrite.
const LOW_TEMPLATE_VARIANTS = {
  'spectacle': [
    "spectacle isn't the draw",
    "the big set-pieces aren't what pull you in",
    "you don't need the fireworks",
    "scale and flash aren't really the appeal",
  ],
  'narrative-depth': [
    "you don't need a twisty plot",
    "intricate plotting isn't a priority",
    "you'd rather not unpack a thicket of lore",
    "the plot can stay loose",
  ],
  'character-attachment': [
    "character drama isn't a priority",
    "you don't need to fall in love with the cast",
    "deep cast dynamics aren't the hook",
    "the people can stay at arm's length",
  ],
  'emotional-intensity': [
    "you tend to skip the heavy stuff",
    "the dark stuff isn't your speed",
    "you're not chasing the gut-punches",
    "you'd rather skip the rough edges",
  ],
  'comfort-seeking': [
    "comfort viewing isn't your thing",
    "you're not here to wind down",
    "easy-watch isn't what pulls you in",
    "low-stakes cozy shows aren't the lane",
  ],
  'comedy-chaos': [
    "pure comedy doesn't pull you in",
    "the chaos isn't your speed",
    "you can do without the absurd",
    "the gags aren't what bring you back",
  ],
  'romance-spice': [
    "romance isn't a priority",
    "you're not in it for the love story",
    "the romance can stay in the margins",
    "you'd rather skip the swoon",
  ],
  'curiosity-streak': [
    "you stick close to the mainstream",
    "you don't reach for the experimental",
    "you let other people find the weird stuff",
    "the offbeat picks aren't your default",
  ],
};

// Stable pick across (archetype, axis): sum-of-charcodes hash so the
// same identity wearing the same low axis always lands on the same
// variant. Cheap and deterministic — variants is only 4 deep, so
// distribution quality matters less than predictability.
function pickLowVariant(axisId, archetypeName) {
  const variants = LOW_TEMPLATE_VARIANTS[axisId];
  if (!variants || variants.length === 0) return null;
  const seed = (archetypeName || '') + '::' + axisId;
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i);
  return variants[sum % variants.length];
}

// Capitalize the first letter of a fragment without mutating the rest.
const capFirst = s => s.replace(/^./, c => c.toUpperCase());

export function proseFor(radar) {
  if (!radar?.axes) return '';
  // Strong-signal gate: when no axis breaks 0.4 we don't claim an
  // identity, regardless of which archetype shapeIdentityFor happened
  // to match. Cold/thin users land on the Mixed-Taste fallback line.
  const top = topAxes(radar, 3).filter(a => a.value >= 0.4);
  if (top.length === 0) {
    return 'Mixed taste — you sample broadly without one clear lane.';
  }
  // Prefer the matched archetype's custom prose so two users sharing
  // a top-3 axis set but landing on different identities get visibly
  // different voice. Falls back to template-glue when the matched
  // archetype has no prose string (Mixed Taste fallback, older
  // catalog entries).
  const identity = shapeIdentityFor(radar);
  let prose;
  if (identity?.prose) {
    prose = identity.prose;
  } else {
    const parts = [];
    for (const a of top) {
      const t = HIGH_TEMPLATES[a.id];
      if (t) parts.push(capFirst(t));
    }
    prose = parts.join('. ') + '.';
  }
  // Low-axis tail — appended to both paths. Each per-archetype line
  // is written to leave room for this addendum without sounding off.
  // Archetypes whose prose already negates a specific axis (e.g.
  // Wholesome Romance Reader saying "no explosions required" covers
  // low spectacle) declare suppressLow to skip the redundant tail.
  const bot = bottomAxes(radar, 1).filter(a => a.value <= 0.3);
  if (bot.length) {
    const axisId = bot[0].id;
    const suppressed = identity?.suppressLow?.includes(axisId);
    if (!suppressed) {
      const t = pickLowVariant(axisId, identity?.name);
      if (t) prose += ' ' + capFirst(t) + '.';
    }
  }
  return prose;
}

// Per-axis adjective forms used by the tagline generator. Each is
// the friend-voice short descriptor for someone strong on that
// axis. Composes top-3-high adjectives into a single line —
// "character-deep, drama-heavy, mainstream taste" — that sits as
// a byline under the shape name on the identity surface. Tweak
// individual adjectives here without touching the tagline logic.
const AXIS_ADJECTIVES = {
  'spectacle':            'spectacle-loving',
  'narrative-depth':      'story-hungry',
  'character-attachment': 'character-deep',
  'emotional-intensity':  'drama-heavy',
  'comfort-seeking':      'comfort-craving',
  'comedy-chaos':         'chaos-tolerant',
  'romance-spice':        'romance-leaning',
  'curiosity-streak':     'auteur-curious',
};

// Tagline = top 3 axes by value (filtered to ≥0.4 — same threshold
// as proseFor's high cutoff) → joined adjective forms. Returns
// the byline that sits under the shape name. Falls back to a
// neutral "eclectic" line when the user has no strong axes yet
// (cold-start / very thin data).
export function taglineFor(radar) {
  if (!radar?.axes) return '';
  const top = topAxes(radar, 3).filter(a => a.value >= 0.4);
  if (top.length === 0) return 'eclectic — taste still finding its shape';
  const adjs = top.map(a => AXIS_ADJECTIVES[a.id]).filter(Boolean);
  if (adjs.length === 0) return 'eclectic — taste still finding its shape';
  return adjs.join(', ');
}

// Confidence level for the radar overall. Used by the side panel
// to surface a "still calibrating" caveat pill on thin-data users
// (per Q7 in 2026-05-03 grilling). Three states:
//   'cold'        — no taste vector or zero contributing series.
//                   Shape view should fall back to a CTA prompt.
//   'thin'        — vector exists but signal is genuinely light.
//                   Gate on completed + in-progress series only —
//                   dropped/sampled series carry less taste signal,
//                   so they shouldn't lift a user above the threshold.
//                   Threshold is intentionally low (8) because the user's
//                   well-formed opinionated radar at ~20 series proved
//                   30 was over-conservative and surfacing the caveat
//                   on confidently-calibrated taste shapes — which is
//                   worse than no caveat (it undermines the surface).
//   'calibrated'  — solid shape backed by real history. Default state.
const THIN_WATCH_SHAPE_THRESHOLD = 8;
function confidenceLevelFor(tasteVector, opts = {}) {
  const signalSeriesCount = opts.signalSeriesCount ?? 0;
  if (!tasteVector?.raw || Object.keys(tasteVector.raw).length === 0) return 'cold';
  if (signalSeriesCount === 0) return 'cold';
  if (signalSeriesCount < THIN_WATCH_SHAPE_THRESHOLD) return 'thin';
  return 'calibrated';
}

// ── Family palettes (2026-05-03 grilling) ───────────────────
// Eight thematic family palettes, each anchored to a base HSL. Within
// a family, individual archetypes get a small hue offset so two users
// in the same tribe (e.g., both "Drama") still get visibly distinct
// radar colors. Brand orange (Mixed) is preserved for users who don't
// hit any pattern — they keep the existing identity.
//
// Hue choices follow color-theory + psychology conventions: red=drama,
// pink=romance, peach=comfort, gold=spectacle, lime=comedy,
// teal=mystery, violet=auteur. The close warm cluster
// (Comfort/Mixed/Spectacle, all 15°-45°) is differentiated by
// saturation+lightness, not just hue: Comfort is desat+light (dusty),
// Spectacle is high-sat (gold), Mixed is brand-sat (orange).
const FAMILIES = {
  drama:     { name: 'Drama',     base: { h: 355, s: 70,  l: 55 } },
  romance:   { name: 'Romance',   base: { h: 325, s: 70,  l: 65 } },
  comfort:   { name: 'Comfort',   base: { h: 15,  s: 55,  l: 72 } },
  spectacle: { name: 'Spectacle', base: { h: 45,  s: 90,  l: 60 } },
  auteur:    { name: 'Auteur',    base: { h: 265, s: 65,  l: 60 } },
  comedy:    { name: 'Comedy',    base: { h: 80,  s: 75,  l: 60 } },
  mystery:   { name: 'Mystery',   base: { h: 195, s: 60,  l: 50 } },
  mixed:     { name: 'Mixed',     base: { h: 25,  s: 100, l: 58 } }, // exact brand orange
};

// 3-axis "signature" archetypes get a saturation bump on top of the
// hue offset — visible "intensity tier" so distinctive identities
// feel punchier than generic fallbacks.
const SIGNATURE_SAT_BUMP = 10;

// ── Vertex glyph + line-treatment vocabulary (Phase 1, 2026-05) ──
// Five vertex glyph silhouettes that read at r=5 (10px diameter).
// Index is the carrier for the algorithmic fallback below.
const GLYPHS = ['circle', 'diamond', 'triangle', 'square', 'ring'];

// Three polygon-stroke treatments, tuned for legibility at the radar's
// sub-300px viewBox. 'solid' is the baseline (today); 'double' adds an
// inner-darker outer-lighter parallel stroke; 'halo' extends the outer
// glow filter for a "lit-from-within" feel.
const LINE_TREATMENTS = ['solid', 'double', 'halo'];

// Algorithmic visual-trait fallback for non-sig archetypes.
//   glyph: |hueOffset| mod 5  → cycles cleanly through the 5 silhouettes
//   line:  sign(hueOffset)    → +ve=double, 0=solid, -ve=halo
// This means siblings within a family (similar hue offsets) can still
// land on different visuals: e.g., Romance Devotee (-4) → diamond+halo,
// Period Romance Reader (-8) → triangle+halo, Cozy Romantic (+9) →
// triangle+double. Keeps within-family discriminability high without
// hand-curating all 31 non-sig entries.
function resolveArchetypeVisual(candidate) {
  if (candidate.glyph && candidate.line) {
    return { glyph: candidate.glyph, line: candidate.line };
  }
  const offset = candidate.hueOffset || 0;
  const glyphIdx = Math.abs(offset) % GLYPHS.length;
  const sign = offset > 0 ? 1 : (offset < 0 ? -1 : 0);
  const line = sign > 0 ? 'double' : (sign < 0 ? 'halo' : 'solid');
  return { glyph: GLYPHS[glyphIdx], line };
}

// Curated shape-name library. Each pattern matches when the named
// "high" axes are all in top-3 AND the named "low" axes (if any) are
// all in bottom-2. First match wins. Per PRD-NORTH-STAR Q18b
// (small + curated, not auto-generated).
//
// Match priority (most specific first → least specific):
//   1. 3-high signatures (sig=true) — punchiest archetypes
//   2. 2-high + low constraint — anchored 2-axis identities
//   3. 2-high pure — common pair archetypes
//   4. 1-high + low constraint — anchored single-axis identities
//   5. 1-high pure — single-axis fallbacks (one per axis)
// Mixed Taste is the all-low fallback when nothing matches.
//
// Each entry carries:
//   - family: which palette tribe it belongs to
//   - hueOffset: degrees from family base (±range; cool=intense, warm=soft)
//   - sig: 3-axis signatures get a saturation bump on render
// `prose:` is the friend-voice 1–2 sentence pull-quote for the Shape
// panel. Written per-archetype so two users sharing the same top-3
// axes but landing on different identities (e.g. The Slice-of-Life
// Romantic vs The Cozy Romantic) get distinctly-voiced prose, not the
// same bag-of-axis-clauses. proseFor() prefers this when an archetype
// matched; the low-axis tail ("but spectacle isn't the draw") is
// appended afterward, so each line is written to leave room for it.
const SHAPE_NAMES = [
  // ── Tier 1: 3-high signatures ─────────────────────────────
  { name: 'The Drama Romantic',           highs: ['character-attachment', 'emotional-intensity', 'romance-spice'], family: 'drama',     hueOffset: +15, sig: true, glyph: 'diamond',  line: 'double',
    prose: "Romance that hurts a little — the relationships matter, and you're here for the parts that break your heart." },
  { name: 'The Epic Drama Watcher',       highs: ['spectacle', 'emotional-intensity', 'character-attachment'],     family: 'drama',     hueOffset: +9,  sig: true, glyph: 'triangle', line: 'halo',
    prose: "Sprawling shows with a cast you'd grieve for — the kind where the scale and the people land together." },
  { name: 'The Tournament Devotee',       highs: ['spectacle', 'emotional-intensity', 'comedy-chaos'],             family: 'spectacle', hueOffset: 0,   sig: true, glyph: 'triangle', line: 'halo',
    prose: "Fights, heat, and a cast loose enough to crack a joke between rounds — high stakes that still know how to grin." },
  { name: 'The Hopeless Romantic',        highs: ['spectacle', 'romance-spice', 'comfort-seeking'],                family: 'romance',   hueOffset: +12, sig: true, glyph: 'ring',     line: 'double',
    prose: "Romance with the lights up — sweeping moments, warm endings, the kind of love story you settle into without bracing.",
    suppressLow: ['emotional-intensity'] },
  { name: 'The Curious Romantic',         highs: ['character-attachment', 'romance-spice', 'curiosity-streak'],    family: 'romance',   hueOffset: +6,  sig: true, glyph: 'diamond',  line: 'solid',
    prose: "Love stories that aren't on rails — odd pairings, off-kilter premises, a cast you actually want to know." },
  { name: 'The Slice-of-Life Romantic',   highs: ['character-attachment', 'romance-spice', 'comfort-seeking'],     family: 'comfort',   hueOffset: +15, sig: true, glyph: 'circle',   line: 'double',
    prose: "Quiet romance is your lane — small moments, characters you'd hang out with, the slow kind of love." },
  { name: 'The Comfort Curio',            highs: ['character-attachment', 'comfort-seeking', 'curiosity-streak'],  family: 'comfort',   hueOffset: -12, sig: true, glyph: 'triangle', line: 'solid',
    prose: "Cozy with a little weirdness baked in — characters you'd settle in with for the strange edges as much as the warmth." },
  { name: 'The Heavy Auteur',             highs: ['narrative-depth', 'emotional-intensity', 'curiosity-streak'],   family: 'auteur',    hueOffset: -22, sig: true, glyph: 'diamond',  line: 'double',
    prose: "You read shows like books — dense, demanding, with payoff for the patience. The heavier the swing, the better.",
    suppressLow: ['comfort-seeking'] },
  { name: 'The Cinematic Auteur',         highs: ['spectacle', 'emotional-intensity', 'curiosity-streak'],         family: 'auteur',    hueOffset: +22, sig: true, glyph: 'ring',     line: 'halo',
    prose: "Visually ambitious, emotionally serious — directors with a signature and scenes that earn their runtime." },

  // ── Tier 2: 2-high + low constraint ───────────────────────
  { name: 'The Hype Tragedian',           highs: ['spectacle', 'emotional-intensity'], lows: ['comedy-chaos'],     family: 'drama',     hueOffset: -15,
    prose: "You want the big moments to land hard — no jokes undercutting the weight, no comic relief softening the blow.",
    suppressLow: ['comedy-chaos'] },
  { name: 'The Pure Action Viewer',       highs: ['spectacle', 'emotional-intensity'], lows: ['narrative-depth'],  family: 'spectacle', hueOffset: -8,
    prose: "You're here for the fights — kinetic, loud, emotionally charged. Plot's a runway, not the destination.",
    suppressLow: ['narrative-depth'] },
  { name: 'The Prestige Action Viewer',   highs: ['spectacle', 'curiosity-streak'],    lows: ['comfort-seeking'],  family: 'spectacle', hueOffset: -4,
    prose: "Spectacle with edges — strange premises, swing-for-the-fences direction, zero interest in something easy to fall asleep to.",
    suppressLow: ['comfort-seeking'] },
  { name: 'The Wholesome Romance Reader', highs: ['romance-spice', 'character-attachment'], lows: ['spectacle'],   family: 'comfort',   hueOffset: -6,
    prose: "In it for the people and the pining — no explosions required, just two characters worth following.",
    suppressLow: ['spectacle'] },

  // ── Tier 3: 2-high pure ───────────────────────────────────
  { name: 'The Character Drama Lover',    highs: ['character-attachment', 'emotional-intensity'], family: 'drama',     hueOffset: -3,
    prose: "You watch for the people, and you don't flinch from the heavy stuff — the cast carries the weight, and you stay for every blow." },
  { name: 'The Hype Romantic',            highs: ['spectacle', 'romance-spice'],                  family: 'romance',   hueOffset: -12,
    prose: "Big, broadcast-level romance — the confession on the rooftop, the rain, the orchestra. Love stories scaled up." },
  { name: 'The Romance Devotee',          highs: ['character-attachment', 'romance-spice'],       family: 'romance',   hueOffset: -4,
    prose: "Romance is the whole point — the chemistry, the longing, the cast you'd watch fall in love every season." },
  { name: 'The Period Romance Reader',    highs: ['narrative-depth', 'romance-spice'],            family: 'romance',   hueOffset: -8,
    prose: "Love stories with a setting — court politics, slow-burn longing, romance that needs three episodes of context first." },
  { name: 'The Cozy Romantic',            highs: ['comfort-seeking', 'romance-spice'],            family: 'comfort',   hueOffset: +9,
    prose: "Easy, warm romance — the kind you put on when you want to feel good and don't want anyone to die.",
    suppressLow: ['emotional-intensity'] },
  { name: 'The Slice-of-Life Devotee',    highs: ['character-attachment', 'comfort-seeking'],     family: 'comfort',   hueOffset: +3,
    prose: "Quiet shows with people you'd want to know — no plot in particular, just hanging out with a cast you've grown attached to.",
    suppressLow: ['narrative-depth'] },
  { name: 'The Sitcom Cozy',              highs: ['comfort-seeking', 'comedy-chaos'],             family: 'comfort',   hueOffset: -3,
    prose: "You watch to laugh and unwind — light, repeatable, comfort-food TV that doesn't ask too much of you.",
    suppressLow: ['emotional-intensity'] },
  { name: 'The Action Comedian',          highs: ['spectacle', 'comedy-chaos'],                   family: 'spectacle', hueOffset: +12,
    prose: "Big fights with the jokes turned up — chaos with choreography, and a cast that refuses to take itself too seriously.",
    suppressLow: ['emotional-intensity'] },
  { name: 'The Auteur',                   highs: ['curiosity-streak', 'narrative-depth'],         family: 'auteur',    hueOffset: -10,
    prose: "You hunt for the weird and the well-written — the shows other people skip, the directors with a thumbprint." },
  { name: 'The Indie Cast Devotee',       highs: ['character-attachment', 'curiosity-streak'],    family: 'auteur',    hueOffset: +6,
    prose: "You follow casts into strange territory — quirky premises, niche genres, as long as the people on screen are worth the trip." },
  { name: 'The Cathartic Comedy Fan',     highs: ['emotional-intensity', 'comedy-chaos'],         family: 'comedy',    hueOffset: +4,
    prose: "Funny shows that hit hard — laughs that earn the gut-punch, tears that earn the joke right after." },
  { name: 'The Rom-Com Fan',              highs: ['romance-spice', 'comedy-chaos'],               family: 'comedy',    hueOffset: +12,
    prose: "Romance with the laugh track on — warm, fast, occasionally absurd. Rooting for them AND for the bit." },
  { name: 'The Heavy Lit Reader',         highs: ['narrative-depth', 'emotional-intensity'],      family: 'mystery',   hueOffset: -6,
    prose: "You watch shows like novels — dense plotting, real weight, payoff at the end of the tunnel. Light entertainment isn't the brief.",
    suppressLow: ['comfort-seeking'] },
  { name: 'The Character Study',          highs: ['narrative-depth', 'character-attachment'],     family: 'mystery',   hueOffset: +10,
    prose: "You want the cast and the plot to be the same thing — slow shows where the story is who these people become." },
  { name: 'The Hard Sci-Fi Watcher',      highs: ['spectacle', 'narrative-depth'],                family: 'mystery',   hueOffset: -14,
    prose: "Concepts at scale — shows that swing hard at the idea and have the production to land it." },

  // ── Tier 4: 1-high + low constraint ───────────────────────
  { name: 'The Cozy Lantern',             highs: ['comfort-seeking'],   lows: ['emotional-intensity'], family: 'comfort',   hueOffset: -15,
    prose: "Shows that warm the room — no dread, no doom, just something pleasant to come home to.",
    suppressLow: ['emotional-intensity'] },
  { name: 'The Spectacle Watcher',        highs: ['spectacle'],         lows: ['romance-spice'],       family: 'spectacle', hueOffset: -12,
    prose: "You're here for scale — fights, set pieces, big animation moments." },
  { name: 'The Mystery Aficionado',       highs: ['narrative-depth'],   lows: ['comfort-seeking'],     family: 'mystery',   hueOffset: -22,
    prose: "Shows that demand attention — twists, lore, careful reveals. Comfort-watching is for other people.",
    suppressLow: ['comfort-seeking'] },
  { name: 'The Comedy Connoisseur',       highs: ['comedy-chaos'],      lows: ['emotional-intensity'], family: 'comedy',    hueOffset: -12,
    prose: "Pure comedy is the brief — you skip the heavy stuff and stay for the shows that just want to be funny.",
    suppressLow: ['emotional-intensity'] },

  // ── Tier 5: 1-high pure ───────────────────────────────────
  // The 1-axis-pure entries are FIRST-MATCH-WINS-UNREACHABLE from
  // the dev sandbox's structured presets (where all suppressed axes
  // sit at 0.05 ties, so bottom-2 + top-3 fillers always end up
  // forming some known 2-axis pair that matches earlier in the
  // ladder). They're kept because in REAL production usage with
  // continuous values from real watch history, distributions can
  // genuinely lack any 2-axis pair in top-3, letting these
  // single-axis fallbacks fire. The dev sandbox warns when a
  // preset can't be reached; the matched archetype shown is what
  // the engine would also produce for that input shape.
  { name: 'The Spectacle Hunter',         highs: ['spectacle'],            family: 'spectacle', hueOffset: +4,
    prose: "Big visuals are the draw — peak animation, fight choreography, the moments that make you sit up." },
  { name: 'The Narrative Diver',          highs: ['narrative-depth'],      family: 'mystery',   hueOffset: +22,
    prose: "You watch for the plot — mysteries, lore, structure. Story-first, everything else second." },
  { name: 'The Character Devotee',        highs: ['character-attachment'], family: 'drama',     hueOffset: +3,
    prose: "You watch for the cast — relationships, arcs, the people you carry around in your head after." },
  { name: 'The Emotional Seeker',         highs: ['emotional-intensity'],  family: 'drama',     hueOffset: -9,
    prose: "You want shows that make you feel something heavy — drama, weight, the kind of episode you sit with." },
  { name: 'The Cozy Soul',                highs: ['comfort-seeking'],      family: 'comfort',   hueOffset: -9,
    prose: "You watch to unwind — quiet, easy, low-stakes shows that meet you where you are." },
  { name: 'The Comedy Fan',               highs: ['comedy-chaos'],         family: 'comedy',    hueOffset: -4,
    prose: "You watch to laugh — fast, weird, irreverent. Heaviness can wait.",
    suppressLow: ['emotional-intensity'] },
  { name: 'The Romance Reader',           highs: ['romance-spice'],        family: 'romance',   hueOffset: +4,
    prose: "Love stories are the draw — the longing, the chemistry, the will-they-won't-they." },
  { name: 'The Curious Wanderer',         highs: ['curiosity-streak'],     family: 'auteur',    hueOffset: +14,
    prose: "You poke into the corners — experimental shows, weird premises, the stuff your friends haven't heard of." },
];

// Resolve archetype HSL from family base + offset + signature bump.
// Wraps hue in [0, 360) so a family near 0° (Drama) can have positive
// or negative offsets without producing negative hues.
function resolveArchetypeHsl(familyId, hueOffset, isSignature) {
  const fam = FAMILIES[familyId] || FAMILIES.mixed;
  const h = ((fam.base.h + (hueOffset || 0)) % 360 + 360) % 360;
  const s = Math.min(100, fam.base.s + (isSignature ? SIGNATURE_SAT_BUMP : 0));
  const l = fam.base.l;
  return { h, s, l };
}

// Returns the full identity record: name + family + resolved colors +
// signature flag. Background persists this onto tasteShapeRadar so
// the side panel can theme without re-running the lookup.
export function shapeIdentityFor(radar) {
  if (!radar?.axes) return null;
  const top = new Set(topAxes(radar, 3).map(a => a.id));
  const bottom = new Set(bottomAxes(radar, 2).map(a => a.id));
  for (const candidate of SHAPE_NAMES) {
    const highsMatch = candidate.highs.every(id => top.has(id));
    const lowsMatch = !candidate.lows || candidate.lows.every(id => bottom.has(id));
    if (highsMatch && lowsMatch) {
      const visual = resolveArchetypeVisual(candidate);
      return {
        name: candidate.name,
        family: candidate.family,
        familyName: FAMILIES[candidate.family]?.name || 'Mixed',
        familyBaseHsl: { ...(FAMILIES[candidate.family]?.base || FAMILIES.mixed.base) },
        archetypeHsl: resolveArchetypeHsl(candidate.family, candidate.hueOffset, candidate.sig),
        isSignature: !!candidate.sig,
        glyph: visual.glyph,
        lineTreatment: visual.line,
        prose: candidate.prose || null,
        suppressLow: candidate.suppressLow || null,
      };
    }
  }
  // No match — Mixed Taste fallback. Brand orange is preserved as the
  // identity for users without strong patterns.
  return {
    name: 'Mixed Taste',
    family: 'mixed',
    familyName: 'Mixed',
    familyBaseHsl: { ...FAMILIES.mixed.base },
    archetypeHsl: { ...FAMILIES.mixed.base },
    isSignature: false,
    glyph: 'circle',
    lineTreatment: 'solid',
  };
}

// Back-compat thin wrapper. Existing callers that only need the name
// keep working; new identity-aware callers (background, side panel)
// use shapeIdentityFor directly.
export function shapeNameFor(radar) {
  return shapeIdentityFor(radar)?.name ?? null;
}

// Build the full set of dev-sandbox preset archetypes from
// SHAPE_NAMES. Each entry produces axis values that will MATCH that
// specific archetype when fed through shapeIdentityFor.
//
// Uses brute-force search rather than a static collision-suppression
// algorithm — the priority ladder has too many cross-tier interactions
// (e.g., "Comedy Fan with N+C fillers" matches "Character Study" first
// because N+C is a 2-axis pure pair). For each target, try every
// combination of (3 − numHighs) "filler" axes; pick the first whose
// distribution actually resolves to the target name via the same
// shapeIdentityFor function the engine uses. ~500 calls total at
// module load (~5ms); guarantees correctness.
//
// Returns: { [archetypeName]: { family, familyName, isSignature, axes, signalSeriesCount } }
//
// Falls back to a simple distribution + console warning if no clean
// match is found (some archetypes might be unreachable due to the
// priority-ladder shape; flagging surfaces a real ambiguity in
// SHAPE_NAMES rather than silently picking the wrong target).
function* combinationsOf(arr, k) {
  if (k === 0) { yield []; return; }
  if (k > arr.length) return;
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combinationsOf(arr.slice(i + 1), k - 1)) {
      yield [arr[i], ...rest];
    }
  }
}

function findAxesForArchetype(entry, onFallback) {
  const HIGH = 0.95;
  const LOW = 0.01;          // clearly lowest → guarantees bottom-2 inclusion
  const FILLER = 0.30;       // medium → enters top-3
  const SUPPRESSED = 0.05;   // mid-low → not in top-3, not lowest
  const ourHighs = entry.highs || [];
  const ourLows = entry.lows || [];
  const otherAxes = AXIS_DEFS
    .map(d => d.id)
    .filter(id => !ourHighs.includes(id) && !ourLows.includes(id));
  const numFillers = Math.max(0, 3 - ourHighs.length);

  for (const fillerSet of combinationsOf(otherAxes, numFillers)) {
    const axes = {};
    for (const def of AXIS_DEFS) {
      if (ourHighs.includes(def.id)) axes[def.id] = HIGH;
      else if (ourLows.includes(def.id)) axes[def.id] = LOW;
      else if (fillerSet.includes(def.id)) axes[def.id] = FILLER;
      else axes[def.id] = SUPPRESSED;
    }
    const stub = {
      axes: AXIS_DEFS.map(d => ({
        id: d.id,
        name: d.name,
        shortName: d.shortName,
        value: axes[d.id],
      })),
    };
    const identity = shapeIdentityFor(stub);
    if (identity?.name === entry.name) return axes;
  }
  // Fallback: didn't find a clean match. Some archetypes are
  // structurally unreachable from any axis distribution (priority
  // ladder shadows them — tier-5 1-axis-pure entries are caught by
  // earlier tier-3 pairs; some tier-3/4 entries are caught by
  // earlier sigs / 2-high+low entries with the same prefix). The
  // dev sandbox renders these via the visual override on the preset
  // entry, so the picked archetype's palette/name still appear in
  // the card. The grouped notice in getDevSandboxPresets surfaces
  // the list once per session.
  if (typeof onFallback === 'function') onFallback(entry.name);
  const axes = {};
  for (const def of AXIS_DEFS) {
    if (ourHighs.includes(def.id)) axes[def.id] = HIGH;
    else if (ourLows.includes(def.id)) axes[def.id] = LOW;
    else axes[def.id] = 0.20;
  }
  return axes;
}

let _unreachableNoticeLogged = false;

export function getDevSandboxPresets() {
  const unreachable = [];
  const onFallback = name => unreachable.push(name);
  const presets = {};
  for (const entry of SHAPE_NAMES) {
    const fam = FAMILIES[entry.family] || FAMILIES.mixed;
    const visual = resolveArchetypeVisual(entry);
    presets[entry.name] = {
      family: entry.family,
      familyName: fam.name,
      isSignature: !!entry.sig,
      axes: findAxesForArchetype(entry, onFallback),
      signalSeriesCount: 30,
      // Resolved palette directly from the entry's metadata. The dev
      // sandbox uses these to override shapeIdentityFor's matching
      // result so the rendered card shows the picked archetype's
      // palette even when the priority ladder shadows it (e.g., a
      // 1-axis fallback whose preset distribution forces an earlier
      // 2-axis pair to match — without this override, picking
      // "Comedy Fan" would render as the matched Action Comedian).
      familyBaseHsl: { ...fam.base },
      archetypeHsl: resolveArchetypeHsl(entry.family, entry.hueOffset, entry.sig),
      glyph: visual.glyph,
      lineTreatment: visual.line,
    };
  }
  // Mixed Taste — fallback. Flat middle values that won't match any
  // pattern (no axis enters the top-3 with enough margin to anchor a
  // 1-high-pure entry).
  presets['Mixed Taste'] = {
    family: 'mixed',
    familyName: 'Mixed',
    isSignature: false,
    axes: Object.fromEntries(AXIS_DEFS.map(d => [d.id, 0.45])),
    signalSeriesCount: 30,
    familyBaseHsl: { ...FAMILIES.mixed.base },
    archetypeHsl: { ...FAMILIES.mixed.base },
    glyph: 'circle',
    lineTreatment: 'solid',
  };
  // One grouped notice per session for archetypes the priority
  // ladder structurally shadows. The visual override on each preset
  // ensures the picked archetype still renders correctly; this is
  // a dev-awareness signal, not a runtime bug.
  if (unreachable.length > 0 && !_unreachableNoticeLogged) {
    _unreachableNoticeLogged = true;
    console.info(
      `[crsmart] dev sandbox: ${unreachable.length} archetype(s) ` +
      `unreachable via structured presets (priority-ladder shadowing); ` +
      `visual override preserves the picked palette/name. ` +
      `Affected: ${unreachable.join(', ')}.`
    );
  }
  return presets;
}

// Build a synthetic radar from axis-slider values + a simulated
// signalSeriesCount. Used by the side panel's dev axis-sandbox to
// preview what the Shape view looks like under arbitrary inputs
// without touching the real engine output. Runs through the SAME
// pipeline functions as the worker (shapeIdentityFor, proseFor,
// taglineFor, confidenceLevelFor) so the dev tool tests the actual
// rendering chain rather than a parallel mock.
//
// Inputs:
//   axisValues — { [axisId]: number }, values clamped to [0, 1]
//   signalSeriesCount — number, drives confidenceLevel cold/thin/calibrated
//
// Returns a radar object shaped exactly like the real one — caller
// can assign to STATE.radar and call renderShape().
export function buildRadarFromAxisValues({ axisValues = {}, signalSeriesCount = 30 } = {}) {
  const axes = AXIS_DEFS.map(def => {
    const raw = axisValues[def.id];
    const v = typeof raw === 'number' ? Math.max(0, Math.min(1, raw)) : 0;
    return {
      id: def.id,
      name: def.name,
      shortName: def.shortName,
      description: def.description,
      value: v,
      // contributingTags / contributingShows are only used by the
      // legend's audit drilldown; populate empty so the row renders
      // ("no signal — your watch history doesn't touch this axis yet"
      // for zero values, or just an empty drilldown otherwise).
      contributingTags: [],
      contributingShows: [],
      magnitude: v * 100, // arbitrary; just needs to exist for the SVG
    };
  });
  const hasAxisSignal = axes.some(a => a.value > 0);
  // confidenceLevelFor's first arg checks tasteVector.raw existence
  // for the cold-start branch. Build a minimal stand-in so the
  // function reads as "has signal" iff any axis is non-zero.
  const fakeTasteVector = hasAxisSignal ? { raw: { _devSandbox: 1 } } : null;
  const confidenceLevel = confidenceLevelFor(fakeTasteVector, { signalSeriesCount });
  const radarStub = { axes, confidenceLevel, signalSeriesCount };
  // Run through the identity / prose / tagline pipeline using the
  // real functions — these are the production code paths.
  const identity = shapeIdentityFor(radarStub);
  return {
    ...radarStub,
    shapeName: identity?.name || 'Mixed Taste',
    family: identity?.family || 'mixed',
    familyName: identity?.familyName || 'Mixed',
    familyBaseHsl: identity?.familyBaseHsl,
    archetypeHsl: identity?.archetypeHsl,
    isSignature: !!identity?.isSignature,
    glyph: identity?.glyph || 'circle',
    lineTreatment: identity?.lineTreatment || 'solid',
    proseSummary: proseFor(radarStub),
    tagline: taglineFor(radarStub),
    _isDevSandbox: true, // marker so the sidepanel can render the SANDBOX badge
  };
}
