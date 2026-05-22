// External tag enrichment via manami-project's anime-offline-database.
//
// The manami DB is a single JSON dump (~20MB) that joins MAL / AniList /
// Kitsu / AniDB / Anime-Planet / Anisearch / LiveChart / Notify.moe /
// Simkl identifiers for every anime entry, merging their tag vocabularies
// into one `tags: string[]` array per entry. One static GitHub download
// replaces dozens of rate-limited per-show API calls against AniDB /
// Anime-Planet directly.
//
// Why this matters for Smart Scoring:
//
// - AniList has sparse coverage of character-archetype tags like Loli /
//   Shota / Chuunibyou / Tsundere — they exist but aren't consistently
//   applied. AniDB has these as first-class metadata. Pulling through
//   manami catches the shows AniList skipped.
// - Anime-Planet carries content-warning tags (Sexual Violence, Underage
//   Content, Graphic Violence) that AniList doesn't tag at all. These
//   feed directly into the Phase 2 dealbreaker pool.
// - Unified vocabulary broadens the dimension-matching surface generally —
//   more tag overlap means fewer zero-magnitude dimensions.
//
// Shape of a manami entry:
//   { sources: ['https://anilist.co/anime/10087', ...],
//     title, type, episodes, status, animeSeason, ...,
//     tags: ['action','fantasy','seinen',...] }
//
// Integration strategy: cross-reference by AniList ID (the primary key of
// our aniListCache), merge manami's `tags[]` into the cache entry's own
// tags[] with a source marker. Consumers (taste-vector, per-show-score,
// dimensions) already iterate `al.tags[]` so no consumer-side changes
// needed.

// manami distributes the JSON via GitHub Releases (weekly tag-name
// like '2026-14'), NOT as a checked-in file in the repo. The
// /releases/latest/download/ path is a redirect alias that always
// points at the current release — saves us from having to track the
// latest tag name ourselves. Chain: github.com → release-assets.
// githubusercontent.com → the actual ~61MB payload.
const DB_URL = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
const STALE_MS = 7 * 24 * 60 * 60 * 1000; // manami refreshes weekly

// Bumped when the merge filter changes meaningfully — forces a fresh
// sync on the next boot so old (too-greedy, too-much-bloat) merged
// data gets replaced with the new filtered version. Persisted
// alongside externalTagsFetchedAt as externalTagsSchema.
export const EXTERNAL_TAGS_SCHEMA = 'v2-filtered';

// Allowlist: manami's tag vocabulary is huge (everything from every
// source merged). Merging all of it bloats aniListCache fast and
// introduces aesthetic/descriptor tags we don't use ('heart-warming',
// 'artistic animation', 'outside the box', etc.) alongside the
// genuinely-valuable character-archetype and content-warning tags.
// Keep the signal, skip the noise.
//
// Two ways a tag gets in:
//   1) Substring match against INTEREST_KEYWORDS — covers families
//      like 'tsundere' / 'yandere' / 'sexual violence'.
//   2) Exact match against INTEREST_EXACT — canonical tags whose
//      text doesn't carry their own category-keyword (e.g. "Bondage").
// Everything else is skipped at merge time.
const INTEREST_KEYWORDS = [
  // character archetypes — the Phase 1 dimensions that scored zero on AniList alone
  'loli', 'shota', 'tsundere', 'yandere', 'kuudere', 'dandere', 'deredere',
  'chuuni', 'ojou', 'imouto', 'onee', 'senpai', 'kouhai', 'kemonomimi',
  'nekomimi', 'maid', 'catgirl', 'bishounen', 'bishoujo', 'yamato nadeshiko',
  'megane', 'delinquent', 'yankee', 'ikemen', 'femboy', 'trap', 'otokonoko',
  'genki', 'wallflower',
  // content-warning and mature-content axes — Phase 2 dealbreaker fodder
  'rape', 'sexual', 'sex ', 'incest', 'pedoph', 'underage', 'violence',
  'gore', 'graphic', 'cannibal', 'torture', 'suicide', 'self-harm',
  'abuse', 'drug', 'nudity',
  // relationship dynamics the §6 section flags as dealbreaker territory
  'age gap', 'age-gap', 'student-teacher', 'teacher-student',
  'sibling', 'step-sibling', 'forbidden', 'harem', 'polyamory',
  'master-servant',
  // niche genre / setting markers that are dealbreaker or strong-lean signal
  'isekai', 'ecchi', 'hentai',
];
const INTEREST_EXACT = new Set([
  'bondage', 'bdsm', 'fetish', 'yaoi', 'yuri', 'bara',
  'cgdct', 'slice of life', 'iyashikei',
]);

function tagIsInteresting(lowerName) {
  if (!lowerName) return false;
  if (INTEREST_EXACT.has(lowerName)) return true;
  for (const kw of INTEREST_KEYWORDS) {
    if (lowerName.includes(kw)) return true;
  }
  return false;
}

function aniListIdFromSources(sources) {
  for (const src of sources || []) {
    if (typeof src !== 'string') continue;
    const m = src.match(/anilist\.co\/anime\/(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// Title-case a lowercase manami tag so it matches AniList's convention
// when we merge. AniList tags are Title Case ("Cute Girls Doing Cute
// Things"); manami tags are lowercase ("cute girls doing cute things").
// Apostrophes / hyphens preserved. Won't convert every manami tag to the
// exact AniList canonical form (AniList's "Boys' Love" has an apostrophe
// manami's "boys love" lacks), but the dedup check is case-insensitive
// so duplicates still collapse.
function titleCase(s) {
  if (!s || typeof s !== 'string') return s;
  return s.split(/(\s+)/).map(part => {
    if (!part || /^\s+$/.test(part)) return part;
    // Title-case each word, preserving internal punctuation.
    return part[0].toUpperCase() + part.slice(1);
  }).join('');
}

// Normalize a tag name for dedup comparison — lowercase, collapse
// whitespace, strip apostrophes (so "Boys' Love" and "boys love" are
// considered the same tag).
function normalizeForDedup(s) {
  return (s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetch and parse the manami JSON dump. Returns an index keyed by
// AniList ID so merge() can look up by cache primary key in O(1).
// Entries without an anilist.co source are skipped — they can't be
// cross-referenced to our cache.
// Extract CR series ID from manami's sources[] — first sources[] entry
// that matches CR URL shape wins. Most shows have at most one CR link
// per manami entry; when present it's the canonical one.
function crSeriesIdFromSources(sources) {
  for (const src of sources || []) {
    if (typeof src !== 'string') continue;
    const m = src.match(/crunchyroll\.com\/(?:[a-z-]{2,5}\/)?series\/([A-Z0-9]+)/i);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

export async function fetchAnimeOfflineDatabase() {
  const res = await fetch(DB_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`anime-offline-database fetch failed: ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new Error('anime-offline-database: unexpected shape');
  const byAniListId = new Map();
  // CR→AniList ID map: lets enrichOne skip the title-search step when
  // we already know which AniList entry corresponds to a given CR
  // series ID. Covers ~20k shows via manami's aggregate of CR URLs
  // across all indexed sources — often catches pairings that
  // AniList's own externalLinks miss (MHA S1's CR URL is the
  // reference case we expect this to rescue).
  const crToAniListId = {};
  let withoutAniList = 0;
  for (const entry of json.data) {
    const id = aniListIdFromSources(entry.sources);
    if (id == null) { withoutAniList++; continue; }
    byAniListId.set(id, {
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    });
    const crId = crSeriesIdFromSources(entry.sources);
    // Prefer the lowest AniList ID per CR series — lower IDs correspond
    // to earlier-added entries, so this reliably picks S1 over S6 when
    // manami lists a later season first.
    if (crId && (!crToAniListId[crId] || id < crToAniListId[crId])) {
      crToAniListId[crId] = id;
    }
  }
  return {
    byAniListId,
    crToAniListId,
    totalEntries: json.data.length,
    withAniList: byAniListId.size,
    withoutAniList,
    withCrMapping: Object.keys(crToAniListId).length,
    lastUpdate: json.lastUpdate || null,
  };
}

// Merge manami tags into each cache entry's tags[] array, in place.
// Idempotent: running twice adds nothing the second time, because the
// dedup check is case/apostrophe-insensitive against the already-present
// (possibly externally-added) tags. Caller persists the mutated cache.
export function mergeExternalTags(aniListCache, externalIndex) {
  let seriesTouched = 0;
  let tagsAdded = 0;
  let seriesMatched = 0;
  let candidatesSkipped = 0;
  const addedPerTag = {};

  // First, STRIP any previously-merged manami tags from the cache so
  // repeated runs are clean (previous greedy-merge runs left behind
  // tags the new filter would reject). Only strips tags carrying our
  // source:'manami' marker — AniList's own tags are untouched.
  for (const entry of Object.values(aniListCache || {})) {
    if (Array.isArray(entry?.tags)) {
      const before = entry.tags.length;
      entry.tags = entry.tags.filter(t => t?.source !== 'manami');
      if (entry.tags.length !== before) {
        // Mark that this entry had prior external tags so diagnostic
        // can report "replaced" vs "first time."
      }
    }
  }

  for (const entry of Object.values(aniListCache || {})) {
    const aniId = entry?.aniListId;
    if (aniId == null) continue;
    const ext = externalIndex.byAniListId.get(aniId);
    if (!ext) continue;
    seriesMatched++;
    const existingNormalized = new Set(
      (entry.tags || []).map(t => normalizeForDedup(t?.name)));
    const additions = [];
    for (const raw of ext.tags) {
      if (!raw || typeof raw !== 'string') continue;
      const norm = normalizeForDedup(raw);
      if (!norm || existingNormalized.has(norm)) continue;
      // Filter: only merge tags our allowlist cares about. Manami's
      // full tag vocab is too broad and wastes storage on
      // aesthetic/descriptor tags we don't use.
      if (!tagIsInteresting(norm)) { candidatesSkipped++; continue; }
      existingNormalized.add(norm);
      const canonical = titleCase(raw);
      additions.push({
        name: canonical,
        // No rank — manami's merged vocabulary doesn't carry the
        // per-show relevance AniList's rank field provides. Downstream
        // falls back to 0.5 for rank-less tags, which is the right
        // middle weight (present but not a core theme).
        rank: null,
        category: 'External',
        isMediaSpoiler: false,
        source: 'manami',
      });
      addedPerTag[canonical] = (addedPerTag[canonical] || 0) + 1;
    }
    if (additions.length) {
      entry.tags = [...(entry.tags || []), ...additions];
      seriesTouched++;
      tagsAdded += additions.length;
    }
  }
  return {
    seriesMatched,
    seriesTouched,
    tagsAdded,
    candidatesSkipped,
    topAddedTags: Object.entries(addedPerTag)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tag, count]) => ({ tag, count })),
  };
}

// Wrapper that fetches + merges with a staleness gate. Caller passes the
// current cache; receives the mutated cache to persist, plus diagnostics.
// Returns null if the cache is fresh enough to skip.
export async function syncExternalTags(aniListCache, lastSyncedAt) {
  if (lastSyncedAt && Date.now() - lastSyncedAt < STALE_MS) return null;
  const index = await fetchAnimeOfflineDatabase();
  const stats = mergeExternalTags(aniListCache, index);
  return {
    cache: aniListCache,
    crToAniListId: index.crToAniListId,
    stats,
    indexStats: {
      totalEntries: index.totalEntries,
      withAniList: index.withAniList,
      withCrMapping: index.withCrMapping,
      lastUpdate: index.lastUpdate,
    },
  };
}
