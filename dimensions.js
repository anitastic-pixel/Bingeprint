// Taste dimensions — 16 human-readable axes scored continuously against
// the user's taste vector. Sits BETWEEN the raw 342-tag taste vector
// (too granular to label) and the 8 archetype blends (too broad to
// explain). Answers "on a per-axis scale, how much does this user lean
// toward Fantasy / Romance / Darkness / Sports / ..." so UI surfaces
// ("you overlap with viewers who like fast-paced action with moral
// complexity") can be composed from axis-shaped pieces.
//
// Differences from archetypes:
//   - Dimensions use SIGNED cosine — a dimension can score negative,
//     meaning the user's vector leans AWAY from that axis. Archetypes
//     are identity labels ("you ARE a Magic-Academy watcher") so
//     negative doesn't mean anything there.
//   - Dimensions are meant to be roughly orthogonal axes. Archetypes
//     are allowed to overlap (Serious-Craft Isekai + Comfort-Isekai
//     both hit "Isekai"). A well-tuned dimension set has minimal
//     tag reuse — if Fantasy and Worldbuilding both pulled the same
//     tags, they'd produce redundant scores.
//   - Dimension tag bundles are smaller (3-8 tags each). More tags
//     per bundle means more catalog coverage but less crisp meaning.
//
// Tag names follow AniList's canonical labels — grep aniListCache
// if a dimension scores 0 everywhere, the name is likely wrong.

export const DIMENSIONS = [
  {
    id: 'action',
    name: 'Action',
    blurb: 'how much you reach for fights, intensity, physical stakes',
    tags: {
      'Action': 2,
      'Shounen': 1.5,
      'Martial Arts': 1.5,
      'Super Power': 1.5,
      'Fight Choreography': 1,
      'Battle': 1,
    },
  },
  {
    id: 'romance',
    name: 'Romance',
    blurb: 'central-pairing chemistry, pining, love as primary axis',
    tags: {
      'Romance': 3,
      'Love Triangle': 1.5,
      'Shoujo': 1,
    },
  },
  {
    id: 'slice-of-life',
    name: 'Slice of Life',
    blurb: 'low-stakes, everyday-rhythm, cozy',
    tags: {
      'Slice of Life': 2.5,
      'Iyashikei': 2,
      'Cute Girls Doing Cute Things': 1.5,
    },
  },
  {
    id: 'darkness',
    name: 'Darkness',
    blurb: 'psychological weight, cruelty, moral bleakness',
    tags: {
      'Psychological': 2.5,
      'Gore': 1.5,
      'Tragedy': 1.5,
      'Horror': 1.5,
      'Dark Fantasy': 1,
    },
  },
  {
    id: 'fantasy',
    name: 'Fantasy',
    blurb: 'magic, kingdoms, other-world rules',
    tags: {
      'Fantasy': 2,
      'Magic': 2,
      'High Fantasy': 1.5,
      'Isekai': 1.5,
      'Reincarnation': 1,
      'Sword & Sorcery': 1,
    },
  },
  {
    id: 'scifi',
    name: 'Sci-Fi',
    blurb: 'tech, future, systems, mecha',
    tags: {
      'Sci-Fi': 2.5,
      'Mecha': 2,
      'Cyberpunk': 1.5,
      'Space': 1,
      'Real Robot': 1,
    },
  },
  {
    id: 'school',
    name: 'School',
    blurb: 'school-aged, coming-of-age, youth drama',
    tags: {
      'School': 2,
      'High School': 1,
      'Coming of Age': 1.5,
      'Youth': 1,
      'School Club': 1,
    },
  },
  {
    id: 'supernatural',
    name: 'Supernatural',
    blurb: 'ghosts, demons, myth, hidden-world',
    tags: {
      'Supernatural': 2,
      'Demons': 1.5,
      'Gods': 1.5,
      'Yokai': 1.5,
      'Urban Fantasy': 1,
    },
  },
  {
    id: 'comedy',
    name: 'Comedy',
    blurb: 'jokes, bits, goofiness as primary mode',
    tags: {
      'Comedy': 2.5,
      'Parody': 1.5,
      'Gag Humor': 1.5,
      'Satire': 1,
    },
  },
  {
    id: 'emotional',
    name: 'Emotional heaviness',
    blurb: 'willingness to cry, be devastated, feel a lot',
    tags: {
      'Tragedy': 2,
      'Drama': 1.5,
      'Tearjerker': 2,
      'Heartbreak': 1,
    },
  },
  {
    id: 'mystery',
    name: 'Mystery / Thriller',
    blurb: 'puzzle-solving, twists, suspense',
    tags: {
      'Mystery': 2.5,
      'Thriller': 2,
      'Detective': 1.5,
      'Crime': 1.5,
      'Conspiracy': 1,
    },
  },
  {
    id: 'sports',
    name: 'Sports',
    blurb: 'athletic competition, team dynamics, training',
    tags: {
      'Sports': 3,
      'Team Sports': 2,
      'Athletics': 1,
    },
  },
  {
    id: 'music-idol',
    name: 'Music / Idol',
    blurb: 'performance, music culture, idol worlds',
    tags: {
      'Idol': 3,
      'Music': 2,
      'Band': 1.5,
      'Performing Arts': 1,
    },
  },
  {
    id: 'queer',
    name: 'Queer / Yuri / BL',
    blurb: 'same-gender romance as primary axis',
    tags: {
      'Yuri': 3,
      'Boys\' Love': 3,
      'Shoujo Ai': 2,
      'Shounen Ai': 2,
      'LGBTQ+ Themes': 1.5,
    },
  },
  {
    id: 'fanservice',
    name: 'Fanservice',
    blurb: 'ecchi, nudity, harem-flavored attention',
    tags: {
      'Ecchi': 2.5,
      'Fanservice': 2,
      'Nudity': 1.5,
      'Female Harem': 1.5,
      'Harem': 1.5,
    },
  },
  {
    id: 'slow-burn',
    name: 'Slow burn',
    blurb: 'patient pacing, layered buildup, rewards attention',
    tags: {
      'Slow Paced': 2,
      'Slow-Paced': 2, // variant form some cache entries carry
      'Iyashikei': 1,  // iyashikei overlaps with slow-burn tolerance
      'Episodic': 1,
    },
  },

  // ── Character archetype dimensions ────────────────────────────────
  // These score whether the user leans toward/away from specific
  // character types. Four of them (Loli, Shota, OP-protagonist, Harem-
  // adjacent) are also the auto-surface source for dealbreaker
  // suggestions — a strong negative score with decent magnitude promotes
  // to a "treat as dealbreaker?" prompt in settings.
  //
  // Character-archetype dimensions intentionally DON'T render in the
  // popup's visible dimension blend (they'd bury the tone/theme axes
  // the user actually cares about reading). They live internally as
  // signal + dealbreaker-trigger source.
  {
    id: 'tsundere',
    name: 'Tsundere',
    blurb: 'cold-to-warm affection arcs, classic rom-com dynamic',
    tags: {
      'Tsundere': 3,
    },
    hiddenInBlend: true,
  },
  {
    id: 'yandere',
    name: 'Yandere',
    blurb: 'possessive, obsessive-love dynamics',
    tags: {
      'Yandere': 3,
      'Stalking': 1,
    },
    hiddenInBlend: true,
  },
  {
    id: 'chuunibyou',
    name: 'Chuunibyou',
    blurb: '8th-grade-syndrome delusion energy',
    tags: {
      'Chuunibyou': 3,
      'Delusions': 1.5,
    },
    hiddenInBlend: true,
  },
  {
    id: 'loli',
    name: 'Loli content',
    blurb: 'childlike female characters — dealbreaker for many viewers',
    tags: {
      'Loli': 3,
    },
    hiddenInBlend: true,
  },
  {
    id: 'shota',
    name: 'Shota content',
    blurb: 'childlike male characters — dealbreaker for many viewers',
    tags: {
      'Shota': 3,
    },
    hiddenInBlend: true,
  },
  {
    id: 'ojou-sama',
    name: 'Ojou-sama',
    blurb: 'rich-girl archetypes, nobility, high society',
    tags: {
      'Ojou-sama': 2.5,
      'Royal Affairs': 1.5,
      'Nobility': 1,
    },
    hiddenInBlend: true,
  },
  {
    id: 'kemonomimi',
    name: 'Kemonomimi / Maid',
    blurb: 'animal-eared characters, maids — moe-adjacent archetype cluster',
    tags: {
      'Kemonomimi': 2.5,
      'Animal Ears': 2,
      'Maids': 1.5,
      'Nekomimi': 1.5,
    },
    hiddenInBlend: true,
  },
  {
    id: 'op-protagonist',
    name: 'Overpowered protagonist',
    blurb: 'god-mode lead, cheat skills, never-loses power fantasy',
    tags: {
      'Overpowered Main Characters': 2.5,
      'Overpowered Protagonist': 2.5,
      'Cheat Skills': 1.5,
      'Super Power': 1,
    },
    hiddenInBlend: true,
  },
  {
    id: 'antihero',
    name: 'Antihero',
    blurb: 'morally grey, villain-leaning, or outright monstrous leads',
    tags: {
      'Anti-Hero': 3,
      'Villainess': 1.5,
      'Dark Past': 1,
    },
    hiddenInBlend: true,
  },

  // ── Theme dimensions ──────────────────────────────────────────────
  // What the show is *about* underneath. Themes are what pulls a
  // viewer across genres — someone who loves Grief will follow that
  // through Tragedy-tagged SoL and Tragedy-tagged fantasy alike.
  {
    id: 'coming-of-age',
    name: 'Coming of age',
    blurb: 'growing-up arcs, self-discovery through youth',
    tags: {
      'Coming of Age': 3,
      'Youth': 1.5,
    },
  },
  {
    id: 'grief',
    name: 'Grief / loss',
    blurb: 'mourning, death, the weight of absence',
    tags: {
      'Tragedy': 1.5,
      'Heartbreak': 2,
      'Tearjerker': 2,
      'Death': 1.5,
      'Mourning': 1.5,
    },
  },
  {
    id: 'found-family',
    name: 'Found family',
    blurb: 'chosen kinship, orphan-rescuer bonds, made-not-born',
    tags: {
      'Found Family': 3,
      'Orphan': 1,
    },
  },
  {
    id: 'survival',
    name: 'Survival',
    blurb: 'resource scarcity, end-times, living against the world',
    tags: {
      'Survival': 2.5,
      'Post-Apocalyptic': 2,
      'Dystopian': 1.5,
      'Battle Royale': 1,
    },
  },
  {
    id: 'revenge',
    name: 'Revenge',
    blurb: 'vendetta arcs, cycles of violence, justice-as-vengeance',
    tags: {
      'Revenge': 3,
      'Vigilantism': 1.5,
    },
  },
  {
    id: 'philosophy',
    name: 'Philosophy',
    blurb: 'existential weight, metaphysics, what-does-it-mean',
    tags: {
      'Philosophy': 2.5,
      'Existentialism': 2,
      'Philosophical': 2,
    },
  },
  {
    id: 'political-war',
    name: 'Political / war',
    blurb: 'statecraft, war as subject, realpolitik',
    tags: {
      'War': 2.5,
      'Politics': 2,
      'Military': 1.5,
      'Strategy': 1,
    },
  },

  // ── Tone-trait dimensions ─────────────────────────────────────────
  // Stable taste traits (distinct from mood-of-the-moment vibe chips).
  // A user who never watches ironic shows leans negative on ironic-parody
  // permanently; a user in a chaotic mood today is mood-chip work.
  {
    id: 'ironic-parody',
    name: 'Ironic / parody',
    blurb: 'meta-commentary, fourth-wall play, genre satire',
    tags: {
      'Parody': 2.5,
      'Satire': 2,
      'Fourth Wall': 2,
      'Meta': 1.5,
    },
  },
  {
    id: 'episodic-vignette',
    name: 'Episodic / vignette',
    blurb: 'self-contained episodes, anthology structure',
    tags: {
      'Episodic': 3,
      'Anthology': 1.5,
      'Vignette': 1.5,
    },
  },
  {
    id: 'nihilistic-bleak',
    name: 'Nihilistic / bleak',
    blurb: 'meaning-is-absent, cynicism-as-worldview, bleak endings',
    tags: {
      // AniList doesn't carry "Nihilism" / "Bleak" as tags directly —
      // proxy with Dystopian + Existentialism + Tragedy + Dark-Fantasy.
      // Overlaps with darkness/survival/philosophy dimensions, which is
      // fine: a nihilistic-watcher IS adjacent to all three.
      'Dystopian': 2,
      'Existentialism': 1.5,
      'Tragedy': 1.5,
      'Dark Fantasy': 1,
    },
  },
];

function l2Norm(weights) {
  let sum = 0;
  for (const v of Object.values(weights)) sum += v * v;
  return Math.sqrt(sum);
}

// Signed cosine with SUBSPACE normalization — the user's L2 is
// computed only over the tags that appear in *this* dimension's
// bundle, not the full 342-tag vector. Why: dimensions model
// directional lean ("toward Fantasy / away from Sports"), not absolute
// taste mass. Full-vector normalization squashes anti-leans to near
// zero (the negative contributions from 3 Sports tags vanish when
// divided by positive mass across 300+ other tags), which defeats the
// entire point of having a bidirectional score.
//
// Absolute mass question ("are you a heavy Fantasy watcher or a light
// one") is surfaced separately as `magnitude` = sum of |user weight|
// on tags in this dimension, *before* normalization. A score near +1
// with high magnitude = strong, confident Fantasy lean; score near +1
// with low magnitude = directional lean but thin evidence.
// Returns the ranked dimension list.
//
// Sortedness contract: output is sorted descending by `.score`.
// Consumers can `.slice(0, N)` to read the top-N without resorting.
// Pinned 2026-05-19 — same principle as scoreArchetypes.
export function scoreDimensions(tasteVector, options = {}) {
  const raw = tasteVector?.raw || {};
  const bundles = options.dimensions || DIMENSIONS;
  const results = [];
  for (const dim of bundles) {
    const dimNorm = l2Norm(dim.tags);
    let dot = 0;
    let subNormSq = 0;
    let magnitude = 0;
    const matched = [];
    for (const [tag, dimWeight] of Object.entries(dim.tags)) {
      const userWeight = raw[tag] || 0;
      if (userWeight !== 0) {
        matched.push({ tag, userWeight: +userWeight.toFixed(2), dimWeight });
        dot += userWeight * dimWeight;
        subNormSq += userWeight * userWeight;
        magnitude += Math.abs(userWeight);
      }
    }
    const subNorm = Math.sqrt(subNormSq);
    const cosine = subNorm > 0 && dimNorm > 0 ? dot / (subNorm * dimNorm) : 0;
    results.push({
      id: dim.id,
      name: dim.name,
      blurb: dim.blurb,
      score: +cosine.toFixed(4),
      magnitude: +magnitude.toFixed(2),
      coverage: +(matched.length / Object.keys(dim.tags).length).toFixed(2),
      hiddenInBlend: !!dim.hiddenInBlend,
      matched: matched.sort((a, b) => Math.abs(b.userWeight) - Math.abs(a.userWeight)),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

// Surface dimensions that never matched a single user tag — either the
// user's corpus genuinely doesn't touch that axis, or the bundle used a
// tag name AniList doesn't have. Returns an array of { name, tags }
// so the console diagnostic can show which tag names were attempted,
// letting us tell "corpus doesn't support" from "bad tag name".
export function dimensionsWithZeroMagnitude(scoredDims, bundles) {
  const bundleById = Object.fromEntries(
    (bundles || DIMENSIONS).map(d => [d.id, d]));
  return (scoredDims || [])
    .filter(d => d.magnitude === 0)
    .map(d => ({
      name: d.name,
      tags: Object.keys(bundleById[d.id]?.tags || {}),
    }));
}

// Dealbreaker-candidate heuristic: ANY dimension with strongly-negative
// score AND non-trivial magnitude suggests the user actively avoids that
// content type. Genre-level (Sports, Mecha, Idol-music) can surface
// alongside character-level (Loli, Shota, Harem-adjacent) — the doc's
// §14 dealbreaker list mixes both, and a strong anti-lean is a strong
// anti-lean regardless of which dim carries it.
//
// Thresholds are starting points — tunable after more profile data.
// Caller should surface these as SUGGESTIONS in the popup, never
// auto-apply: mistaking a dropout pattern for a categorical no silently
// hides whole categories of good recs.
export function dealbreakerCandidates(scoredDims, options = {}) {
  const scoreThreshold = options.scoreThreshold ?? -0.5;
  const magnitudeThreshold = options.magnitudeThreshold ?? 2.0;
  return (scoredDims || [])
    .filter(d => d.score <= scoreThreshold && d.magnitude >= magnitudeThreshold)
    .sort((a, b) => a.score - b.score);
}
