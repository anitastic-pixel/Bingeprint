// Taste archetypes + cosine-sim scoring. Pure, no chrome.* APIs.
//
// 18 archetypes span the likely taste-space. Each is a hand-curated
// bundle of AniList tags/genres with subjective weights; scoring projects
// the user's taste vector onto these bundles so we can ask "how
// Magic-Academy is the user?" with a single number per archetype.
//
// Scores are cosine similarities in tag-space. They're NOT probabilities
// — they'll be small in absolute terms (user vector has hundreds of tags,
// bundles have ~6) but rank correctly against each other. Read them as
// "archetype A is 2× more you-shaped than archetype B", not "you are 15%
// isekai".
//
// Tag names follow AniList's canonical labels. A tag that scores 0 across
// all users probably means the name is wrong — grep the aniListCache for
// the real one.
//
// PER-ARCHETYPE GATES (added 2026-05-12 after 25-show walk):
//   Some archetypes carry common-but-non-defining tags ('Magic', 'School',
//   'Action', 'Sci-Fi') with high weight. Without a gate, the cosine
//   inflates for any show that ranks high on the supporting tags even
//   when it lacks the archetype's IDENTITY. Magic-academy fired on
//   Mob Psycho 100 (school + super-power, no academia), Frieren (magic +
//   medieval, no school), and Kimi wa Kanata (an indie movie about a
//   schoolgirl in the afterlife). Mecha fired on AoT, MHA, Inuyashiki,
//   Psycho-Pass.
//
// Each gate is a pure function (realTagRanks) => boolean. Returning
// false zeroes the archetype's per-show fit AND per-show user-weighted
// breakdown. Gates are run AFTER cosine, so a show that passes the
// cosine bar but fails the gate is silently demoted; one that the
// cosine doesn't even reach isn't penalized further.
//
// Tag-rank threshold of 50 (= median rank floor) is the "this tag is
// genuinely about the show" cut. Sub-50 ranks are AniList community-
// vote noise.
const GATE_RANK_FLOOR = 50;
function hasAny(realTagRanks, tags, floor = GATE_RANK_FLOOR) {
  for (const t of tags) if ((realTagRanks[t] || 0) >= floor) return true;
  return false;
}
//
// Bar for adding a new archetype (locked 2026-04-26):
//   (A) Cultural recognition — fans self-identify with the label
//   (B) Tag fingerprint — pairwise cosine vs every existing bundle <0.5
// Quality/vibe-only categories (e.g. "Trash Isekai") fail (B) and become
// flavor pills, not archetypes. See BRAINSTORM.md for the full grilling.
//
// Pairwise cosine verification (high-risk pairs, all <0.5):
//   Auteur ↔ Mind-Game Thriller .................. 0.24
//   Mainstream Shounen ↔ Battle Seinen ........... 0.22
//   Magic-Academy ↔ Mahou Shoujo ................. 0.23
//   Romance-Open ↔ Josei ......................... 0.46  (tightest)
//   CGDCT ↔ Comfort-Isekai ....................... 0.40
//   Hard Sci-Fi ↔ Mecha .......................... 0.22
//   Battle Seinen ↔ Mecha ........................ 0.16
//   Sports ↔ Mainstream Shounen .................. 0.13
//   Mahou Shoujo ↔ Mainstream Shounen ............ 0.05
//   Otome-Villainess ↔ Romance-Open .............. 0.32
// If you add or re-weight a bundle, re-run the sweep — any pair >0.5
// means the new bundle is a sub-flavor, not an archetype, and should
// fold into the closest existing one instead of shipping standalone.

export const ARCHETYPES = [
  {
    id: 'serious-isekai',
    name: 'Serious-Craft Isekai',
    blurb: 'Isekai with weight — Re:Zero, Mushoku Tensei, Frieren-shaped. Absorbs the Power-Trip Isekai (Shield Hero / Overlord / Slime-as-OP) sub-flavor via Anti-Hero + Revenge.',
    tags: {
      'Isekai': 3,
      'Reincarnation': 2,
      'Tragedy': 1.5,
      'Time Loop': 1.5,
      'Time Manipulation': 1,
      'Psychological': 1,
      'Anti-Hero': 1,
      'Revenge': 0.5,
      'Post-Apocalyptic': 0.5,
    },
  },
  {
    id: 'comfort-isekai',
    name: 'Comfort/Junk Isekai',
    blurb: 'Low-stakes power fantasy — slow paced, harem, healing.',
    tags: {
      'Isekai': 2,
      'Reincarnation': 1,
      'Slice of Life': 1.5,
      'Iyashikei': 1.5,
      'Agriculture': 1,
      'Female Harem': 1,
      'Maids': 0.5,
    },
  },
  {
    id: 'romance-open',
    name: 'Romance-Open',
    blurb: 'Romance as the main axis — any pairing, any register.',
    tags: {
      'Romance': 3,
      'Love Triangle': 1,
      'Drama': 1,
      'Shoujo': 1.5,
      'Slice of Life': 0.5,
      'Found Family': 0.5,
    },
  },
  {
    id: 'mainstream-shounen',
    name: 'Mainstream Shounen',
    blurb: 'Long-runner battle/power shounen — JJK, MHA, HxH, OP.',
    tags: {
      'Shounen': 2.5,
      'Action': 2,
      'Super Power': 2.5,
      'Martial Arts': 1.5,
      'Ensemble Cast': 0.5,
      'Henshin': 0.5,
      'Tournament': 0.5,
    },
  },
  {
    id: 'magic-academy',
    name: 'Magic-Academy',
    blurb: 'Magic schools, wizard apprentices, mage training.',
    tags: {
      'Magic': 2.5,
      'School': 2,
      'School Club': 0.5,
      'Witch': 1.5,
      'Fantasy': 1,
      'Chuunibyou': 0.5,
      'Mythology': 0.5,
    },
    // Requires evidence of BOTH magic-system AND school-setting at
    // meaningful rank. Magic alone (Frieren) or school alone (Mob
    // Psycho) doesn't make a magic academy — both must be on the show.
    gate: (r) => hasAny(r, ['Magic', 'Witch', 'Sorcery']) && hasAny(r, ['School', 'School Club']),
  },
  {
    id: 'auteur',
    name: 'Auteur Curiosity',
    blurb: 'Arthouse / stylistic weirdness — Yuasa, Ikuhara, Watanabe.',
    tags: {
      'Psychological': 2,
      'Surreal Comedy': 2,
      'Achronological Order': 2,
      'Avant Garde': 2.5,
      'Tragedy': 1,
      'Drama': 0.5,
      'Historical': 0.5,
      'Dystopian': 1,
    },
  },
  {
    id: 'otome-villainess',
    name: 'Otome/Villainess',
    blurb: 'Otome-game reincarnation, villainess route, shoujo isekai.',
    tags: {
      'Villainess': 3,
      'Female Protagonist': 1.5,
      'Reincarnation': 1,
      'Isekai': 1,
      'Romance': 1.5,
      'Royal Affairs': 1.5,
      'Arranged Marriage': 1,
      'Ojou-sama': 1,
      'Shoujo': 0.5,
    },
  },
  {
    id: 'fujoshi-yuri',
    name: 'Fujoshi/Yuri-Lover',
    blurb: 'BL, yuri, queer romance as primary axis.',
    tags: {
      'Boys\' Love': 3,
      'Yuri': 3,
      'LGBTQ+ Themes': 2,
      'Romance': 1,
      'Femboy': 0.5,
      'Crossdressing': 0.5,
      'Bisexual': 0.5,
      'Gender Bending': 0.5,
    },
    // Requires an explicit queer-romance identity tag. Romance + the
    // secondary identity tags (Crossdressing/Gender Bending/Femboy/
    // Bisexual) appear on plenty of non-BL/yuri shows (gender-bender
    // comedies, ensemble harem casts), so without this gate Romance
    // alone was inflating fujoshi-yuri on hetero-romance shows like
    // Marriagetoxin (top fit 0.35 post-walk recompute). Tag names
    // verified against the live aniListCache: Boys' Love (21 shows),
    // Yuri (50), LGBTQ+ Themes (101); Yaoi/Shounen Ai/Shoujo Ai are
    // NOT real AniList tags so they're omitted.
    gate: (r) => hasAny(r, ['Boys\' Love', 'Yuri', 'LGBTQ+ Themes']),
  },
  {
    id: 'cgdct',
    name: 'Cute Girls Doing Cute Things',
    blurb: 'Slice-of-life with a cute-girl ensemble — K-On!, Yuru Camp, Bocchi.',
    tags: {
      'Slice of Life': 2.5,
      'School Club': 2,
      'Female Protagonist': 1.5,
      'Ensemble Cast': 1,
      'Iyashikei': 1,
      'Comedy': 0.5,
      'Music': 0.5,
    },
    // Requires Slice of Life + (cute-girl ensemble OR iyashikei). The
    // Female Protagonist tag alone fired CGDCT on Grandpa & Grandma
    // (an OLDER couple) and Ameku M.D. (a medical mystery procedural).
    gate: (r) => hasAny(r, ['Slice of Life', 'Iyashikei']) && hasAny(r, ['School Club', 'Iyashikei', 'Ensemble Cast']),
  },
  {
    id: 'sports',
    name: 'Sports',
    blurb: 'Team sports + training arcs — Haikyuu, Yuri on Ice, Run with the Wind.',
    tags: {
      'Sports': 3,
      'Team Sports': 2,
      'Coming of Age': 1.5,
      'Tournament': 1.5,
      'Ensemble Cast': 1,
      'Shounen': 0.5,
    },
  },
  {
    id: 'mecha',
    name: 'Mecha',
    blurb: 'Giant robots, war, pilots — Gundam, Eva, Code Geass, 86.',
    tags: {
      'Mecha': 3,
      'Military': 2,
      'War': 1.5,
      'Sci-Fi': 1.5,
      'Tragedy': 0.5,
      'Action': 0.5,
    },
    // Requires explicit Mecha-family tag. Action+Sci-Fi+Military
    // combinations were promoting Mecha on Attack on Titan (Titans
    // aren't mecha), MHA (no mecha), Inuyashiki (cybernetic ≠ mecha),
    // Psycho-Pass (sidearms ≠ mecha).
    gate: (r) => hasAny(r, ['Mecha', 'Real Robot', 'Super Robot', 'Power Suit']),
  },
  {
    id: 'horror',
    name: 'Horror / Dark',
    blurb: 'Visceral horror, survival, dread — Higurashi, Another, Made in Abyss.',
    tags: {
      'Horror': 3,
      'Gore': 1.5,
      'Survival': 1.5,
      'Tragedy': 1.5,
      'Suspense': 1,
      'Body Horror': 1,
      'Death Game': 0.5,
    },
  },
  {
    id: 'mahou-shoujo',
    name: 'Mahou Shoujo',
    blurb: 'Transformation magical girls — Madoka, Sailor Moon, Cardcaptor.',
    tags: {
      'Mahou Shoujo': 3,
      'Henshin': 2,
      'Magic': 1.5,
      'Female Protagonist': 1.5,
      'Ensemble Cast': 1,
      'Tragedy': 0.5,
    },
    // Requires the explicit Mahou Shoujo tag or Henshin (transformation).
    // Magic + Female Protagonist combos were promoting this on Frieren
    // and JJK; neither is a magical-girl show.
    gate: (r) => hasAny(r, ['Mahou Shoujo', 'Henshin']),
  },
  {
    id: 'mind-game-thriller',
    name: 'Mind-Game Thriller',
    blurb: 'Gritty psychological strategy — Death Note, Monster, Liar Game.',
    tags: {
      'Psychological': 2.5,
      'Mind Games': 2.5,
      'Crime': 2,
      'Suspense': 1.5,
      'Seinen': 1,
      'Anti-Hero': 1,
      'Death Game': 0.5,
    },
  },
  {
    id: 'hard-scifi',
    name: 'Hard Sci-Fi / Cyberpunk',
    blurb: 'Cybernetics, time, dystopia — Steins;Gate, GitS, Psycho-Pass, Lain.',
    tags: {
      'Sci-Fi': 2.5,
      'Cyberpunk': 2,
      'Time Manipulation': 1.5,
      'Dystopian': 1.5,
      'Philosophical': 1,
      'Cyborg': 1,
    },
  },
  {
    id: 'battle-seinen',
    name: 'Battle Seinen',
    blurb: 'Grim historical action, lone heroes — Berserk, Vinland Saga, Vagabond.',
    tags: {
      'Seinen': 2,
      'Action': 2,
      'Tragedy': 2,
      'Historical': 1.5,
      'Anti-Hero': 1,
      'Revenge': 1,
      'War': 0.5,
    },
    // Requires the demographic-defining Seinen tag. Action + Tragedy
    // alone fired this on isekai assassin shows and shounen battlers
    // that have nothing to do with the genre's mature/historical feel.
    gate: (r) => hasAny(r, ['Seinen']),
  },
  {
    id: 'xianxia',
    name: 'Xianxia / Cultivation',
    blurb: 'Cultivators, sects, immortality — Mo Dao Zu Shi, Soul Land, Heaven Official\'s Blessing.',
    tags: {
      'Cultivation': 3,
      'Wuxia': 2.5,
      'Martial Arts': 1.5,
      'Mythology': 1.5,
      'Reincarnation': 1,
      'Magic': 0.5,
    },
    // Requires the explicit Chinese-tradition tag. Martial Arts +
    // Mythology + Magic alone bridged shows like Naruto into Xianxia.
    gate: (r) => hasAny(r, ['Cultivation', 'Wuxia']),
  },
  {
    id: 'josei',
    name: 'Josei / Adult Romance',
    blurb: 'Grown-up romance + drama — Nana, Honey & Clover, March Comes In Like a Lion.',
    tags: {
      'Josei': 2.5,
      'Drama': 2,
      'Romance': 1.5,
      'Adult Cast': 1.5,
      'Coming of Age': 1,
      'Slice of Life': 1,
      'Music': 0.5,
    },
  },
];

function l2Norm(weights) {
  let sum = 0;
  for (const v of Object.values(weights)) sum += v * v;
  return Math.sqrt(sum);
}

// Archetype bundle L2 norms are constants — precompute once at module
// load so scoreArchetypes doesn't recompute the same 18 values on
// every taste-vector recompute. Same for the bundle-tag-keyed lookup
// used by scoreShow's archetype attribution: the per-archetype tags
// dictionary is always indexed by tag name, but giving callers a
// shared "tag → archetypeIds" inverted index lets per-show archetype
// breakdown skip the outer 18-archetype loop and read the index in
// O(matched_tags).
const ARCH_NORMS = new Map();
const TAG_TO_ARCH_WEIGHTS = new Map();
for (const arch of ARCHETYPES) {
  ARCH_NORMS.set(arch.id, l2Norm(arch.tags));
  for (const [tag, weight] of Object.entries(arch.tags)) {
    let entry = TAG_TO_ARCH_WEIGHTS.get(tag);
    if (!entry) {
      entry = [];
      TAG_TO_ARCH_WEIGHTS.set(tag, entry);
    }
    entry.push({ archId: arch.id, weight });
  }
}
export function archetypeNorm(archId) { return ARCH_NORMS.get(archId) ?? 0; }
export function archetypeWeightsForTag(tag) {
  return TAG_TO_ARCH_WEIGHTS.get(tag) || null;
}

// Full-vector cosine: dot / (L2(entire user vector) × L2(bundle)).
// Using the entire user L2 in the denominator means a heavy romance
// watcher scores higher on Romance-Open than a light one, even if both
// have the same *proportional* romance mix. That's the right behavior —
// we want absolute alignment, not subspace alignment.
//
// Since the taste vector now carries negative weights (drops / samples),
// build a positive-only view for both the norm *and* the dot product.
// An archetype is identity — "what you ARE like" — not anti-identity;
// negative Isekai pulls you *out* of Comfort-Isekai but shouldn't count
// toward Magic-Academy via a random tag overlap. Penalties are surfaced
// separately via tasteVector.bottom for the UI layer to explain.
// Per-show lane classification — "is this show an honest fit for the
// user's top lanes?" Returns the single strongest match, or null. Every
// user-facing archetype surface (card pitch, picks badge, future
// sidebar drill-in) calls through here so a single confidence gate
// and top-K policy controls every surface at once.
//
// The classifier runs in two steps:
//
//   (1) SHOW IDENTITY — find the archetype that best fits the show's
//       own tag vector, independent of user taste. Uses showArchetypeFit
//       (un-user-weighted cosine similarity) from scoreShow. Answers
//       "what kind of show is this?" — a property of the show, not the
//       viewer. Prevents "everything bridges to Mainstream Shounen for
//       a shounen watcher" misattribution: a heavy-shounen viewer's
//       userWeight can dominate tag-overlap math for any action-flavored
//       show, so using the un-weighted fit is what makes the label
//       about the show rather than the user's history.
//
//   (2) USER OVERLAP — require the show's identity archetype to also
//       be in the user's top-K honest lanes. If the show's identity is
//       Auteur but the user's top lanes are Mainstream Shounen +
//       Magic-Academy, the show is off-profile and we stay silent.
//
// Gates (all must pass):
//   - show's top fit must clear minFit (absolute floor — sparse tag
//     overlap produces low cosines that aren't reliable signal)
//   - top fit must be ≥ minShare of the sum of all archetype fits
//     (relative dominance — the identity must carry the show, not
//     just edge out a crowded field)
//   - top fit must beat the runner-up by at least minMargin (gap —
//     a 0.35 vs 0.32 win shouldn't decide the label)
//   - identity archetype must be in user's top-K lanes (topK)
//   - user's archetype score must clear minUserScore (cold-start guard)
//
// Tune the gates, not the surfaces — that's the whole point of funneling
// every surface through one function.
export function laneForShow({ scoredShow, archetypeBlend, options = {} } = {}) {
  // Gates tuned for 18 archetypes (2026-04-26). When the bundle space grew
  // 8→18, every show picks up trace fits across the new bundles, inflating
  // totalFit and pushing winners below the old 0.55 share gate even when
  // they're still honest identity matches. Loosened proportionally.
  // If lane labels go silent post-ship, drop minShare to 0.45 and observe.
  const topK = options.topK ?? 3;
  const minUserScore = options.minUserScore ?? 0.01;
  const minFit = options.minFit ?? 0.15;
  const minShare = options.minShare ?? 0.50;
  const minMargin = options.minMargin ?? 0.18;

  if (!scoredShow || !Array.isArray(archetypeBlend)) return null;
  const fit = scoredShow.showArchetypeFit || {};
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
    blurb: userHit.blurb,
    fit: +topValue.toFixed(3),
    share: +(topValue / totalFit).toFixed(2),
    margin: +(topValue - runnerUp).toFixed(3),
    userRank: userTop.indexOf(userHit) + 1,
  };
}

// Returns the ranked archetype blend.
//
// Sortedness contract: output is sorted descending by `.score`.
// Consumers can `.slice(0, N)` to read the top-N without resorting.
// Pinned 2026-05-19 ("artifact ordering is part of the producer's
// contract, not a consumer responsibility") — the function already
// sorted internally, but several call sites were re-sorting
// defensively because the contract wasn't documented.
export function scoreArchetypes(tasteVector, options = {}) {
  const raw = tasteVector?.raw || {};
  const positiveRaw = {};
  for (const [tag, w] of Object.entries(raw)) if (w > 0) positiveRaw[tag] = w;
  const bundles = options.archetypes || ARCHETYPES;
  const userNorm = l2Norm(positiveRaw);
  // Use the precomputed per-archetype norms when the caller didn't
  // override the bundle list — saves recomputing constant data on
  // every recompute. Custom bundle lists fall back to live l2Norm.
  const useDefaultNorms = bundles === ARCHETYPES;
  const results = [];
  for (const arch of bundles) {
    const archNorm = useDefaultNorms ? ARCH_NORMS.get(arch.id) : l2Norm(arch.tags);
    const matched = [];
    let dot = 0;
    for (const [tag, archWeight] of Object.entries(arch.tags)) {
      const userWeight = positiveRaw[tag] || 0;
      if (userWeight > 0) {
        matched.push({ tag, userWeight: +userWeight.toFixed(2), archWeight });
        dot += userWeight * archWeight;
      }
    }
    const cosine = userNorm > 0 && archNorm > 0 ? dot / (userNorm * archNorm) : 0;
    results.push({
      id: arch.id,
      name: arch.name,
      blurb: arch.blurb,
      score: +cosine.toFixed(4),
      coverage: +(matched.length / Object.keys(arch.tags).length).toFixed(2),
      matched: matched.sort((a, b) => b.userWeight - a.userWeight),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}
