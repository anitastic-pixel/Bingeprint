// buildFranchise — given a projected AniList media (as stored in the
// mediaById cache, with `.relations[]` flattened by projectMedia), walk
// 1-hop relations + whatever neighbors are ALSO in mediaById to assemble
// a franchise view. Output is the data the show-page card needs to
// render "5 seasons · 98 eps · 2013–2023 · +1 movie" and a per-studio
// breakdown when the franchise changed hands.
//
// Why this shape: user wants franchise-level totals on the card
// (collapsing "My Hero Academia Season 7" to just "My Hero Academia")
// UNLESS the studio changed across seasons (AoT: Wit S1–S3, MAPPA S4),
// in which case each run gets its own row with a season-range label.
// Movies are shown separately ("+ 2 movies"), never summed into ep
// totals — user preference.
//
// Why 1-hop: AniList only returns direct prequel/sequel/parent edges
// for each media. Multi-hop via nested query is heavy and sometimes
// rejected. To extend reach without extra fetches we also expand
// through any neighbor that's already in mediaById — which happens
// organically when multiple franchise seasons end up as rec candidates
// in the same batch. Deep chains (JJK S1 → S2 → hypothetical S3) where
// only one season is in mediaById will be incomplete. Document, move
// on — a future pass can lazily fetch missing franchise IDs.

const TV_FORMATS = new Set(['TV', 'TV_SHORT']);
const MOVIE_FORMATS = new Set(['MOVIE']);
const EXTRA_FORMATS = new Set(['OVA', 'SPECIAL', 'ONA']);

// Relations that stay inside the franchise for counting purposes.
// SIDE_STORY covers companion shorts/movies (JJK 0, Fate/stay night
// variants). SPIN_OFF / ALTERNATIVE / CHARACTER / OTHER branch into
// separate franchises — excluded. SUMMARY / COMPILATION are recap
// content that shouldn't inflate totals. Tried widening the planner
// to also fetch ALTERNATIVE/COMPILATION (AOT "The Last Attack"
// theatrical compilation) — it pulled in re-cuts like Re:Zero
// Director's Cut as TV nodes that inflated season counts. The
// franchise label is "what new content this franchise has" — recuts
// and theatrical compilations of existing content shouldn't extend it.
const FRANCHISE_RELATION_TYPES = new Set([
  'PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY',
]);

// Studio-name suffix words that signal a sibling/subsidiary of the
// same parent brand rather than a genuinely distinct studio. When AL
// lists both "Bones" and "Bones Film" on the same franchise (Bones
// split a film subsidiary in 2024 and AL credits some recent MHA
// productions to "Bones Film"), the card was rendering two separate
// "Made by" rows for what readers think of as one studio. Stripping a
// trailing safe-suffix word from the clustering key collapses the
// pair without affecting unrelated franchises (the normalization is
// scoped to one franchise's run clustering — cross-franchise studio
// IDs are still distinct in the user-history affinity index).
//
// Conservative choices only: words that almost never appear in a
// genuinely standalone studio name. "Studios"/"Studio" is included
// because "WIT STUDIO" and "WIT" should merge if AL ever lists both.
// Kept "America"/"Japan"/etc. OUT — "Production I.G America" is a
// genuinely distinct entity from "Production I.G".
const SAFE_STUDIO_SUFFIXES = new Set([
  'film', 'films', 'studio', 'studios',
  'inc', 'inc.', 'co', 'co.', 'ltd', 'ltd.',
  'production', 'productions', 'animation', 'pictures',
  'entertainment',
]);

// Dedupe studios. Primary key is normalized name (lowercased, trimmed,
// trailing safe-suffix stripped) because AniList sometimes assigns
// multiple IDs to what readers see as the same studio (e.g. SAO
// seasons credited to A-1 Pictures with different studio IDs across
// years; bones across MHA seasons; "Bones" vs "Bones Film" on MHA
// later seasons). ID-only dedupe leaves three "A-1 Pictures" rows on
// the card. Falls back to id when name is missing. Within a single
// media, same-id duplicates (AoT Final Season lists MAPPA twice) also
// collapse.
function studioNameKey(s) {
  const raw = (s?.name || '').trim().toLowerCase();
  if (!raw) return s?.id != null ? `__id:${s.id}` : '';
  // Strip ONE trailing safe-suffix word so "Bones Film" → "bones",
  // "WIT STUDIO" → "wit". Multi-word names where the last token isn't
  // safe (e.g. "Production I.G America") pass through unchanged.
  const tokens = raw.split(/\s+/);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (SAFE_STUDIO_SUFFIXES.has(last)) {
      return tokens.slice(0, -1).join(' ');
    }
  }
  return raw;
}

function dedupeStudios(studios) {
  if (!studios?.length) return [];
  const seen = new Set();
  const out = [];
  for (const s of studios) {
    const key = studioNameKey(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function studioSetKey(studios) {
  return dedupeStudios(studios).map(studioNameKey).sort().join('|');
}

function yearOf(node) {
  return node.seasonYear ?? node.startYear ?? null;
}

function normalizeRange(values) {
  const filtered = values.filter(v => typeof v === 'number');
  if (!filtered.length) return null;
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  return min === max ? [min] : [min, max];
}

// Collect every node reachable from `central` via franchise-keeping
// relations. A neighbor we've never seen but which exists in mediaById
// gets its OWN relations walked too — this transitively stitches a
// chain of seasons together even though each AniList response is 1-hop.
function collectFranchiseNodes(central, mediaById) {
  const nodes = new Map();

  const record = (obj) => {
    if (!obj?.aniListId) return;
    const existing = nodes.get(obj.aniListId);
    if (!existing) {
      nodes.set(obj.aniListId, { ...obj });
      return;
    }
    // Merge — prefer non-null, richer data from whichever source found it
    for (const k of ['format', 'episodes', 'seasonYear', 'startYear', 'title']) {
      if (existing[k] == null && obj[k] != null) existing[k] = obj[k];
    }
    if ((!existing.studios || !existing.studios.length) && obj.studios?.length) {
      existing.studios = obj.studios;
    }
  };

  const projectCentral = (m) => {
    // Filter to animation studios, then prefer mains when any are
    // flagged (One Piece: Toei main with Magic Bus / TAP / Mushi as
    // additional animation studios for outsourcing — keeping all of
    // them lets the user-affinity selector in the card pick whichever
    // outsourcer the user has watched, mis-attributing One Piece to
    // Magic Bus). Falls back to all animation studios when AL doesn't
    // flag a main (older entries, pre-isMain convention).
    const animStudios = (m.studios || []).filter(s => s.isAnimationStudio !== false);
    const mains = animStudios.filter(s => s.isMain === true);
    const studios = mains.length ? mains : animStudios;
    return {
      aniListId: m.aniListId ?? m.id,
      format: m.format,
      episodes: m.episodes,
      seasonYear: m.seasonYear,
      startYear: m.seasonYear,
      title: m.title,
      studios: studios.map(s => ({ id: s.id, name: s.name })),
    };
  };

  record(projectCentral(central));

  const queue = [central];
  const walked = new Set([central.aniListId ?? central.id]);

  while (queue.length) {
    const cur = queue.shift();
    const curIsNonTv = !TV_FORMATS.has(cur.format);
    const rels = cur.relations || [];
    for (const edge of rels) {
      if (!FRANCHISE_RELATION_TYPES.has(edge.type)) continue;
      const n = edge.node;
      if (!n?.aniListId) continue;
      // SIDE_STORY pointing to a TV series is a sibling spin-off
      // (Vigilantes-shaped) — different show in the same universe,
      // doesn't belong in franchise season counts. Movies / OVAs /
      // specials reached via SIDE_STORY ARE part of the main page
      // (Heroes Rising, You're Next), so those still flow through.
      if (edge.type === 'SIDE_STORY' && TV_FORMATS.has(n.format)) continue;
      // Parallel-route back-door: a TV node reached FROM a non-TV
      // intermediate (a movie, OVA, special) is excluded entirely.
      // Heaven's Feel I (MOVIE) → PREQUEL → Fate/Zero S2 (TV) would
      // otherwise count Fate/Zero S2 as part of the Heaven's Feel
      // franchise rollup, inflating totalTvSeasons. Skip before
      // record so the count stays clean.
      if (curIsNonTv && TV_FORMATS.has(n.format)) continue;
      record(n);
      if (walked.has(n.aniListId)) continue;
      walked.add(n.aniListId);
      // SIDE_STORY targets are treated as leaves — recorded but not
      // walked further. Keeps SIDE_STORY as a one-way inclusion edge:
      // side content (Heroes Rising, You're Next, JJK 0) joins the
      // franchise, but its own onward edges don't get to expand it.
      if (edge.type === 'SIDE_STORY') continue;
      const deeper = mediaById?.[n.aniListId];
      if (deeper) queue.push(deeper);
    }
  }

  // Stitch broken chains: if the CR→AniList mapping landed on a later
  // season (e.g. MHA S6 instead of S1), the sequential SEQUEL walk
  // above can't reach earlier seasons whose intermediate links aren't
  // cached. Scan mediaById for entries whose title shares the central's
  // canonical prefix — exact canonical matches are main seasons; prefix
  // matches like "My Hero Academia: Vigilantes" are siblings whose
  // relations may anchor missing seasons (Vigilantes' PARENT:S1 brings
  // S1's 2016 year into range). The latter are walked as bridges only;
  // we don't count TV-format prefix matches in franchise stats per the
  // user-facing rule "spin-off TV shouldn't inflate the season count."
  const centralRaw = central.title?.english || central.title?.romaji || null;
  const centralCanon = centralRaw ? canonicalizeTitleString(centralRaw) : null;
  if (centralCanon && mediaById) {
    for (const m of Object.values(mediaById)) {
      const aid = m.aniListId ?? m.id;
      if (!aid || nodes.has(aid)) continue;
      const raw = m.title?.english || m.title?.romaji || null;
      if (!raw) continue;
      const mCanon = canonicalizeTitleString(raw);
      const isExact = mCanon === centralCanon;
      // Prefix match against the *raw* title so we catch subtitled
      // siblings ("My Hero Academia: Vigilantes") without false-matching
      // unrelated shows. Both `: ` and ` ` are accepted because AniList
      // titles use either separator inconsistently.
      const isPrefix = !isExact && (
        raw.startsWith(centralCanon + ':') ||
        raw.startsWith(centralCanon + ' ')
      );
      if (!isExact && !isPrefix) continue;

      // Include this entry as a franchise node when:
      //   - exact canonical match (a main season backfill), OR
      //   - prefix match with non-TV format (movies / OVAs / specials
      //     that belong on the main series page).
      // TV-format prefix matches (Vigilantes-shaped spin-offs) are NOT
      // recorded — only used as bridges so their relations can surface
      // earlier main-line seasons.
      if (isExact || !TV_FORMATS.has(m.format)) {
        record(projectCentral(m));
      }

      if (walked.has(aid)) continue;
      walked.add(aid);
      for (const edge of (m.relations || [])) {
        if (!FRANCHISE_RELATION_TYPES.has(edge.type)) continue;
        const n = edge.node;
        if (!n?.aniListId) continue;
        // Same SIDE_STORY+TV guard as the BFS — bridge relations
        // shouldn't drag spin-off TVs into the count either.
        if (edge.type === 'SIDE_STORY' && TV_FORMATS.has(n.format)) continue;
        record(n);
      }
    }
  }

  return [...nodes.values()];
}

// Strip "Season N / Part N / Final Season / The Movie" suffixes so
// "Attack on Titan Final Season Part 2" collapses to "Attack on Titan".
// Deliberately conservative — only strips when the suffix is clearly
// a season/part marker, never touching things like the core title.
// Season/Part/Cour require a following number so "Part-Timer" in
// "The Devil is a Part-Timer" stays intact (the earlier \b form
// stripped at the hyphen and yielded "The Devil is a").
const SEASON_SUFFIX_RE =
  /\s+(?:Season\s+(?:\d+|[IVX]+)|Part\s+(?:\d+|[IVX]+)|Cour\s+(?:\d+|[IVX]+)|Final Season|The Movie|Movie|Special|OVA|OVAs)\b.*$/i;

export function canonicalizeTitleString(raw) {
  if (!raw || typeof raw !== 'string') return raw || null;
  const stripped = raw.replace(SEASON_SUFFIX_RE, '').trim();
  return stripped || raw;
}

function canonicalizeTitle(title) {
  if (!title) return null;
  const raw = title.english || title.romaji || null;
  return canonicalizeTitleString(raw);
}

// Walk the franchise relation graph N hops out from `central`, returning
// the set of aniListIds reachable through PREQUEL/SEQUEL/PARENT/SIDE_STORY
// edges that are NOT present in `mediaById`. Pure, no fetches — used by
// the enrichment planner in background.js to decide which intermediate
// nodes to lazy-fetch before buildFranchise runs.
//
// Skips SIDE_STORY→TV edges to match buildFranchise's spinoff-exclusion
// rule (Vigilantes-shaped TVs aren't part of the franchise stats and
// shouldn't pull bridge fetches either).
//
// maxHops=2 covers the common case (S1 → S2 → S3 chains where S2 isn't
// cached); bump to 3+ for very long franchises (Naruto, One Piece).
export function collectFranchiseNeighborhoodIds(central, mediaById, options = {}) {
  const maxHops = options.maxHops ?? 2;
  const missing = new Set();
  const visited = new Set();
  let frontier = [central];

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = [];
    for (const node of frontier) {
      const id = node?.aniListId ?? node?.id;
      if (!id || visited.has(id)) continue;
      visited.add(id);
      for (const edge of (node.relations || [])) {
        if (!FRANCHISE_RELATION_TYPES.has(edge.type)) continue;
        if (edge.type === 'SIDE_STORY' && TV_FORMATS.has(edge.node?.format)) continue;
        const tid = edge.node?.aniListId;
        if (!tid || visited.has(tid)) continue;
        const cached = mediaById?.[tid];
        if (cached) nextFrontier.push(cached);
        else missing.add(tid);
      }
    }
    frontier = nextFrontier;
  }
  return missing;
}

export function buildFranchise(central, mediaById) {
  if (!central) return null;
  const nodes = collectFranchiseNodes(central, mediaById || {});
  if (nodes.length <= 1 && !(central.relations?.length)) {
    // Nothing to franchise-ify — let caller fall back to single-season meta.
    return null;
  }

  const tv = nodes.filter(n => TV_FORMATS.has(n.format));
  const movies = nodes.filter(n => MOVIE_FORMATS.has(n.format));
  const extras = nodes.filter(n => EXTRA_FORMATS.has(n.format));

  tv.sort((a, b) => {
    const ya = yearOf(a) ?? 9999;
    const yb = yearOf(b) ?? 9999;
    if (ya !== yb) return ya - yb;
    return (a.aniListId || 0) - (b.aniListId || 0);
  });

  // Cluster contiguous TV entries that share the same animation-studio
  // set into "runs". The run is the unit the card renders — when a
  // franchise has one run, we collapse to a single "Made by" row; when
  // it changes hands, each run gets its own row.
  const contiguousRuns = [];
  for (let i = 0; i < tv.length; i++) {
    const n = tv[i];
    const k = studioSetKey(n.studios);
    const last = contiguousRuns[contiguousRuns.length - 1];
    if (!last || last.studioKey !== k) {
      contiguousRuns.push({
        studioKey: k,
        studioNames: (n.studios || []).map(s => s.name),
        spans: [{ startIdx: i, endIdx: i }],
        nodes: [n],
      });
    } else {
      last.spans[last.spans.length - 1].endIdx = i;
      last.nodes.push(n);
    }
  }

  // Second pass: merge non-adjacent runs that share at least one
  // studio (by normalized name) into a single run carrying multiple
  // spans. Earlier exact-key dedupe handled the simple case (every
  // season has the same single studio), but it fails when seasons have
  // overlapping-but-different studio sets — SAO has S5 listed as
  // [A-1 Pictures, EGG FIRM] and S6 as [A-1 Pictures] alone, so the
  // exact-key form left S5 and S6 in separate runs even though the
  // user thinks of both as A-1's work. Overlap merge (transitive
  // closure via union-find) collapses everything sharing at least one
  // studio into one run, and keeps unrelated stretches (3Hz on the
  // SAO Alternative spin-off entry) cleanly separate. Same pattern
  // handles AoT WIT→MAPPA correctly: WIT and MAPPA share nothing, two
  // groups, two rows.
  //
  // Risk: a franchise that went A→[A,B]→[B,C]→C across seasons would
  // collapse to one row, hiding the studio change. Rare enough that
  // we accept it for now — when it bites, refine to "shared-mains"
  // only.
  const runKeySets = contiguousRuns.map(r => {
    const names = r.nodes.flatMap(n => (n.studios || []).map(s => s.name));
    return new Set(names.map(name => studioNameKey({ name })).filter(Boolean));
  });
  // Union-find — small N (typically ≤10 runs/franchise), inline path
  // compression keeps it readable without a separate helper module.
  const parent = contiguousRuns.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let i = 0; i < contiguousRuns.length; i++) {
    for (let j = i + 1; j < contiguousRuns.length; j++) {
      const a = runKeySets[i];
      const b = runKeySets[j];
      let overlap = false;
      for (const k of a) { if (b.has(k)) { overlap = true; break; } }
      if (overlap) {
        const ra = find(i), rb = find(j);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < contiguousRuns.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  const runs = [...groups.values()].map(indices => {
    const first = contiguousRuns[indices[0]];
    return {
      studioKey: first.studioKey,
      studioNames: [...new Set(indices.flatMap(i => contiguousRuns[i].studioNames))],
      spans: indices.flatMap(i => contiguousRuns[i].spans),
      nodes: indices.flatMap(i => contiguousRuns[i].nodes),
    };
  });
  runs.sort((a, b) =>
    Math.min(...a.spans.map(s => s.startIdx)) -
    Math.min(...b.spans.map(s => s.startIdx))
  );

  const totalTvSeasons = tv.length;
  const totalTvEps = tv.reduce((s, n) => s + (n.episodes || 0), 0) || null;
  // Year range spans the whole franchise — TV + movies + extras —
  // because the user-facing label answers "when was this franchise
  // active?", not "when did the TV portion run?". AOT's TV ended at
  // 2022 but the Final Chapters specials + The Last Attack movie
  // pushed releases through 2024; the displayed range should reflect
  // that. Episode/season counts stay TV-only (movies + extras are
  // shown as separate "+ N movies / + N extras" badges).
  const yearRange = normalizeRange([...tv, ...movies, ...extras].map(yearOf));

  const studioRuns = runs.map(r => {
    const eps = r.nodes.reduce((s, n) => s + (n.episodes || 0), 0) || null;
    const sortedSpans = [...r.spans].sort((a, b) => a.startIdx - b.startIdx);
    // Use a YEAR-RANGE label, not the AL-TV-node index. AL's tv.length
    // (used to compute "S1"-"S6") often diverges from CR's franchise
    // season count after augmentFranchiseWithCr collapses split parts
    // (Re:Zero S2 Part 1 + Part 2 = AL idx 1 & 2, CR S2; SAO Alicization
    // + War of Underworld + Part 2 = AL idx 2,3,4, CR S3). When the
    // header shows "3 seasons" but a studio run is labeled "S1–S6", the
    // numbers visibly disagree — confusing. Year ranges sidestep the
    // mismatch entirely and stay meaningful regardless of how AL splits
    // entries (every TV node has a year). Single-studio franchises
    // (one run, totalTvSeasons<=1) skip the tag — the card's main line
    // already shows the franchise year range.
    let seasonLabel;
    if (totalTvSeasons <= 1) {
      seasonLabel = '';
    } else {
      // Collect year extremes across all nodes in the run, then render
      // either "2012" or "2012–2020" depending on the span.
      const years = r.nodes.map(yearOf).filter(y => typeof y === 'number');
      if (years.length === 0) {
        seasonLabel = '';
      } else {
        const minY = Math.min(...years);
        const maxY = Math.max(...years);
        seasonLabel = minY === maxY ? String(minY) : `${minY}–${maxY}`;
      }
    }
    // Carry full studio objects (id + name) so the card can feed them
    // to studioAffinityFor for per-run familiarity lookup. Aggregate
    // across ALL nodes in the (possibly multi-span) merged run, deduped
    // by ID — keeps "Bones" and "Bones Film" both available for the
    // affinity selector even though they collapsed to one row via
    // name-normalized clustering. studioAffinityFor will pick whichever
    // variant has the strongest user history; display name follows.
    const allStudios = r.nodes.flatMap(n => n.studios || []);
    const seenIds = new Set();
    const studios = [];
    for (const s of allStudios) {
      if (s?.id != null && !seenIds.has(s.id)) {
        seenIds.add(s.id);
        studios.push(s);
      }
    }
    return {
      studios,
      studioNames: studios.map(s => s.name),
      seasonLabel,
      seasonCount: r.nodes.length,
      eps,
      yearRange: normalizeRange(r.nodes.map(yearOf)),
    };
  });

  const moviesBucket = movies.length
    ? {
        count: movies.length,
        yearRange: normalizeRange(movies.map(yearOf)),
      }
    : null;

  const earliestTv = tv[0];
  const canonicalTitle = canonicalizeTitle(earliestTv?.title || central.title);

  // Break extras down by format so the card can render "+ 2 OVAs" when
  // they all share one format, and fall back to "+ 3 extras" with a
  // hover tooltip listing the mix when they don't. Titles carried
  // through so the tooltip can enumerate *which* OVAs/specials.
  const extrasByFormat = { OVA: 0, SPECIAL: 0, ONA: 0 };
  const extrasTitles = [];
  for (const n of extras) {
    if (extrasByFormat[n.format] != null) extrasByFormat[n.format] += 1;
    const t = n.title?.english || n.title?.romaji || null;
    if (t) extrasTitles.push({ title: t, format: n.format, year: yearOf(n) });
  }

  return {
    canonicalTitle,
    totalTvSeasons,
    totalTvEps,
    yearRange,
    movies: moviesBucket,
    extrasCount: extras.length,
    extrasByFormat,
    extrasTitles,
    studioRuns,
    hasStudioChange: studioRuns.length > 1,
  };
}
