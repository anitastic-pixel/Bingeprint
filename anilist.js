// AniList enrichment — module imported by background.js (manifest type:module).
//
// Match strategy: search AniList by CR series title with a format filter,
// then verify the result by checking that AniList's externalLinks contain
// a Crunchyroll URL whose series ID matches the one CR gave us. The CR
// ID is the ground truth on both ends, so fuzzy-search ambiguity (which
// would otherwise return spinoffs / mini-anime / wrong-show-with-similar-
// title) becomes a non-issue. Two-pass on format: TV first, then movie/
// OVA/special. If no candidate verifies, fall back to the top result of
// the TV pass with _matchConfidence: 'unverified-best-guess'.
//
// CR groups multiple seasons under one series ID (e.g., Frieren S1 + S2
// both link to GG5H5XQX4). Pick the earliest season as canonical so we
// score against the first-encounter shape of the show.

import * as gateway from './provider-gateway.js';

const ENDPOINT = 'https://graphql.anilist.co';

// Register AniList with the provider gateway. The gateway owns retry,
// Retry-After, in-flight dedup, circuit-breaker state, and pacing —
// anilist.js only knows how to build the GraphQL body and unwrap
// the envelope.
//
// Behavior preserved from the pre-gateway implementation:
//   - 403 (Cloudflare abuse-detect) trips a 15-min breaker immediately
//     so concurrent AL pipelines fail fast instead of compounding the
//     block.
//   - 429 retries up to 3× honoring Retry-After (capped 120s); never
//     trips the breaker (90/min budget recovers fast).
//   - Network errors retry up to 3× with a 3s gap.
//   - 5xx is NOT auto-retried (preserving today's behavior; revisit
//     if AL ever has flaky upstream).
//
// Pacing is adaptive (adaptiveRateLimit): the gateway reads AniList's
// X-RateLimit-Limit header and paces ~10% under it. AniList's limit is not
// stable — it documents 90/min but serves a degraded/penalised 30/min at
// times (confirmed via the header 2026-05-20). A single hardcoded gap is
// therefore wrong half the time: 800ms (75/min) 429-storms a 30/min budget,
// while 2000ms wastes a 90/min one. defaultGapMs=2000 is just the
// conservative STARTING gap until the first response reveals the real
// limit (then it self-tunes: ~733ms at 90/min, ~2200ms at 30/min). Replaces
// the prior caller-side pacing scattered across bulkEnrich / bulkFetchByIds /
// fetchPopularCrShows / franchise-enrich; the gateway's serial queue
// enforces it cross-caller so concurrent paths coordinate.
gateway.registerProvider('anilist', {
  baseUrl: ENDPOINT,
  defaultGapMs: 2000,
  adaptiveRateLimit: true,
  retry: { maxAttempts: 3, on: ['429', 'network'] },
  tripBreakerImmediately: { 403: 15 * 60 * 1000 },
  tripBreakerOnExhaust: {},
});

// Bumped when projectMedia's output shape changes in a way downstream
// consumers care about. background.js checks _schema on cached entries
// and re-fetches by ID (no search/verify needed) when it lags. Currently:
//   v1 — initial projection
//   v2 — added studios[].id, staff[].id, staff[].image (for affinity index)
//   v3 — added description (plot anchor for the show-page card's
//        "what it is" section)
//   v4 — added relations[] (direct prequel/sequel/parent/side_story
//        neighbors with per-node studios) for franchise-aware totals
//        and studio-run clustering on the show-page card.
//   v5 — switched studios from nodes to edges so isMain travels with
//        each studio. AniList lists outsourcing studios alongside the
//        main studio (One Piece: Toei main + Magic Bus + TAP + Mushi
//        as additional animation studios). Without isMain, the
//        show-page card was picking whichever the user had affinity
//        for — Magic Bus won over Toei when the user had watched a
//        Magic Bus isekai. Main-studio preference now wins.
//   v6 — added startDate, endDate (precise air dates beyond seasonYear),
//        nextAiringEpisode (countdown for currently-airing), country
//        OfOrigin (JP / KR / CN — minor demographic signal), banner
//        Image, isAdult (mature filter hook), scoreDistribution (raw
//        community-rating histogram for disagreement chips), trailer
//        (id + site + thumbnail). Powers richer card surfaces and
//        feeds the future "CR-vs-AL audience disagreement" chip
//        without re-fetching. Feeds also the "next ep drops in N
//        days" annotation for actively-airing shows.
//   v7 — `description` is now sourced from the franchise root via a
//        PREQUEL/PARENT walk (see withRootDescription). AniList stores
//        a per-season description on each season's entry — for sequels
//        these read as plot summaries scoped to that season ("The
//        seventh season of Boku no Hero Academia. Following an all-out
//        battle..."). The card renders the franchise as a whole, so we
//        substitute the root entry's description, which is the
//        franchise opener ("What would the world be like if 80% of the
//        population manifested superpowers..."). Adds two diagnostic
//        fields when substitution fires: _descriptionFromRoot:true and
//        _descriptionRootId:<aniListId of the source entry>.
//   v8 — bumped to force a re-walk on entries already migrated under
//        v7 with the original 4-hop cap. Deep TV sequel chains
//        (MHA S7→…→S1 is 6 hops) need the larger cap to actually land
//        on the root; v7-migrated entries with _descriptionFromRoot:true
//        pointing at a mid-chain season need to be redone.
//   v9 — walker now distinguishes complete vs incomplete walks. Only
//        complete walks set _descriptionFromRoot:true. Migration uses
//        that flag to retry incomplete walks on subsequent passes,
//        instead of locking in whichever intermediate season the walker
//        happened to reach when a 429 / cap / cycle aborted it.
//   v10 — walker now allows MOVIE in addition to TV/TV_SHORT for the
//        PREQUEL/PARENT chain. Some franchises chain chronologically
//        through a movie interquel (SAO: Alicization → Ordinal Scale
//        movie → SAO II → SAO). Previously the walker stopped at
//        Alicization and treated it as root. OVA/SPECIAL still
//        excluded (typically side stories regardless of relation tag).
//   v11 — bumped to force re-migration after seeding the root-walk
//        cache with the user's full aniListCache. Entries that
//        previously walked one hop and stopped (because the next AL
//        fetch 429'd) now traverse multi-hop chains using cached
//        entries the user already had — Slime S3 → S2 Part 2 → S2 →
//        S1 with zero new fetches when the user has all four.
//   v12 — v11's seed only included aniListCache (one entry per CR
//        series). Intermediate franchise nodes the user doesn't
//        directly have in CR history (Slime S2 Part 2 lives in
//        aniListBridgeCache, not aniListCache) were missing from
//        the seed, so the walker still tried fetching them and
//        429'd. Migration now seeds from BOTH caches.
//   v13 — ROOT_WALK_FORMATS expanded from {TV, TV_SHORT, MOVIE} to
//        also include OVA, ONA, SPECIAL. Live probe of Slime's
//        chain found S3 → S2 Part 2 → S2 → "Coleus no Yume" (OVA
//        prologue) → S1 — and the walker was stopping at S2
//        because S2's only PREQUEL was an OVA the walker refused
//        to traverse. Most PREQUEL/PARENT-tagged OVAs ARE in the
//        canonical chain (SIDE_STORY is the marker for tangential
//        side content); the format restriction was overly tight.
export const SCHEMA_VERSION = 13;

// Direct neighbors only (1 hop). Two hops would cover more franchises
// in one query but AniList doesn't love nested relations and we can
// always chase missing nodes with a follow-up bulkFetchByIds. Keep each
// node's projection minimal — we only need format/year/episodes +
// animation studios for franchise clustering, not tags/description.
const RELATIONS_FRAGMENT = `relations{
        edges{
          relationType
          node{
            id
            format
            episodes
            seasonYear
            startDate{ year }
            title{ romaji english }
            studios{ edges{ isMain node{ id name isAnimationStudio } } }
          }
        }
      }`;

const SEARCH_QUERY = `query($s:String,$f:[MediaFormat]){
  Page(perPage:6){
    media(search:$s, type:ANIME, format_in:$f){
      id
      title{ romaji english native }
      synonyms
      description(asHtml:false)
      tags{ name rank category isMediaSpoiler }
      genres
      averageScore meanScore popularity favourites
      studios{ edges{ isMain node{ id name isAnimationStudio } } }
      staff(perPage:12, sort:RELEVANCE){ edges{ role node{ id name{ full } image{ medium } } } }
      recommendations(perPage:8, sort:RATING_DESC){
        nodes{ rating mediaRecommendation{ id title{ romaji english } } }
      }
      source season seasonYear episodes status format duration
      startDate{ year month day } endDate{ year month day }
      nextAiringEpisode{ airingAt episode timeUntilAiring }
      countryOfOrigin isAdult bannerImage
      trailer{ id site thumbnail }
      stats{ scoreDistribution{ score amount } }
      externalLinks{ site url }
      ${RELATIONS_FRAGMENT}
    }
  }
}`;

const TV_FORMATS = ['TV', 'TV_SHORT'];
const FILM_FORMATS = ['MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'];

// Batch-fetch by AniList ID — used by recommendation B2 to pull full
// Media data for already-known candidate IDs (no search/verify pass
// needed; the IDs come from AniList's own `recommendations` edges so
// they're already canonical).
const BY_ID_QUERY = `query($ids:[Int]){
  Page(perPage:50){
    media(id_in:$ids, type:ANIME){
      id
      title{ romaji english native }
      synonyms
      description(asHtml:false)
      tags{ name rank category isMediaSpoiler }
      genres
      averageScore meanScore popularity favourites
      studios{ edges{ isMain node{ id name isAnimationStudio } } }
      staff(perPage:12, sort:RELEVANCE){ edges{ role node{ id name{ full } image{ medium } } } }
      recommendations(perPage:8, sort:RATING_DESC){
        nodes{ rating mediaRecommendation{ id title{ romaji english } } }
      }
      source season seasonYear episodes status format duration
      coverImage{ medium large color }
      siteUrl
      externalLinks{ site url }
      ${RELATIONS_FRAGMENT}
    }
  }
}`;

// Extract the CR series ID from an AniList externalLinks URL.
// CR series URLs look like: https://www.crunchyroll.com/series/GG5H5XQX4/...
// or .../<locale>/series/GG5H5XQX4/... (with regional locale prefix).
function extractCrIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/crunchyroll\.com\/(?:[a-z-]{2,5}\/)?series\/([A-Z0-9]+)/i);
  return m ? m[1].toUpperCase() : null;
}

export function findCrLink(media) {
  if (!media || !Array.isArray(media.externalLinks)) return null;
  for (const link of media.externalLinks) {
    if (link.site === 'Crunchyroll') return link.url;
  }
  return null;
}

// Normalize a Crunchyroll URL to its canonical locale-less form:
//   https://www.crunchyroll.com/<locale>/series/GG5H5XQX4/slug
// → https://www.crunchyroll.com/series/GG5H5XQX4/slug
// CR auto-redirects either form to the user's preferred locale, but
// the locale-less form is what we want to persist (avoids "wrong
// locale" links breaking when CR's region inference changes).
export function normalizeCrUrl(url) {
  if (!url) return null;
  return String(url).replace(
    /^(https:\/\/www\.crunchyroll\.com)\/[a-z-]{2,5}\//i,
    '$1/'
  );
}

// Resolve a CR URL for an entry. Three sources, in priority:
//   1. entry.externalLinks contains a Crunchyroll site → use that URL
//      (locale-stripped). Most authoritative — AniList tracks CR's
//      published links.
//   2. crSeriesId provided → reconstruct from the cache key:
//      https://www.crunchyroll.com/series/<crSeriesId>. CR redirects
//      slug-less URLs to the slugged page.
//   3. Neither → null. Caller decides whether to fall back to
//      AniList URL or skip.
//
// The cache is keyed by CR series ID, so for ANY cached entry we
// always have option (2) as a backstop. Pre-externalLinks-persistence
// cache entries fall through to (2) honestly.
export function crSiteUrlFor(entry, crSeriesId) {
  const fromLinks = findCrLink(entry);
  if (fromLinks) return normalizeCrUrl(fromLinks);
  if (crSeriesId) return `https://www.crunchyroll.com/series/${crSeriesId}`;
  return null;
}

// Among candidates that verified against the same CR ID, prefer the
// earliest season (lowest seasonYear; ties broken by lowest AniList id,
// which roughly tracks oldest entry). Future seasons that lack a CR
// link won't be in the verified set anyway.
function pickCanonicalSeason(verified) {
  return verified.slice().sort((a, b) => {
    const ya = a.seasonYear ?? 9999;
    const yb = b.seasonYear ?? 9999;
    if (ya !== yb) return ya - yb;
    return a.id - b.id;
  })[0];
}

// Breaker-state queries delegate to the gateway, where the actual
// `until` timestamp lives now. Kept as named exports because
// background.js consults them in 6+ places before doing AL work.
export function anilistIsPaused() {
  return gateway.isBreakerOpen('anilist');
}
export function anilistPauseMsLeft() {
  return gateway.getProviderHealth('anilist').breakerMsLeft;
}

// GraphQL envelope adapter on top of the gateway. The gateway owns
// transport (retry, breaker, dedup, telemetry); this function knows
// how to build the body and unwrap data/errors. Throws on failure to
// preserve the contract every existing caller in this module relies on.
//
// opts.accessToken — optional Bearer token. Passed for authenticated
// queries (e.g. fetchUserList — list-collection requires the user's
// own auth context). Anonymous queries (search, byId, popular) leave
// it out and AL serves them under the 90/min anonymous budget.
async function anilistRequest(query, variables, contextLabel, opts = {}) {
  const headers = {};
  if (opts.accessToken) headers['Authorization'] = `Bearer ${opts.accessToken}`;
  const result = await gateway.request('anilist', {
    method: 'POST',
    headers,
    body: { query, variables },
    contextLabel,
    signal: opts.signal,
  });
  if (!result.ok) {
    if (result.kind === 'breaker-open') {
      const secondsLeft = Math.ceil((result.retryAfterMs ?? 0) / 1000);
      throw new Error(`anilist circuit-breaker (${contextLabel}): paused for ${secondsLeft}s after recent 403`);
    }
    throw new Error(result.message);
  }
  const json = result.data;
  if (json?.errors?.length) {
    throw new Error(`anilist gql ${JSON.stringify(json.errors[0])}`);
  }
  return json?.data ?? null;
}

async function runSearch(title, formats) {
  const data = await anilistRequest(SEARCH_QUERY, { s: title, f: formats }, 'search');
  return data?.Page?.media || [];
}

// Lightweight public search for the freeform-import matcher's
// AL-Search fallback. Two-pass on format (TV first, then film/OVA/
// special) matching enrichOne's strategy, but returns only the
// fields the matcher needs to disambiguate — keeps payload small
// when N misses fall through to AL from the page side.
//
// Output shape (matches the matcher's resolveFreeformList searchFn
// contract):
//   [{ aniListId, title: {english, romaji, native}, synonyms,
//      format, seasonYear }]
//
// Top 6 results from each pass, deduped by aniListId; TV results
// come first since `searchTopByTitle` is invoked precisely when the
// caller has no series-id verification path.
export async function searchTopByTitle(title, { limit = 5 } = {}) {
  const term = String(title || '').trim();
  if (!term) return [];
  const seen = new Set();
  const out = [];
  const pushAll = (rows) => {
    for (const m of rows) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({
        aniListId: m.id,
        title: m.title || {},
        synonyms: m.synonyms || [],
        format: m.format || null,
        seasonYear: m.seasonYear || (m.startDate && m.startDate.year) || null,
      });
      if (out.length >= limit) return true;
    }
    return false;
  };
  const tv = await runSearch(term, TV_FORMATS);
  if (pushAll(tv)) return out;
  const film = await runSearch(term, FILM_FORMATS);
  pushAll(film);
  return out.slice(0, limit);
}

// All formats unioned — used by the batched search path so we don't
// double the request count for TV vs film passes. Loses the
// TV-preference bias of the two-pass approach (where TV results
// always rank above movie/OVA when both exist for the same query),
// but for freeform-import's "user typed a title, find what AL has"
// use case the wall-clock win from batching outweighs the polish.
const ALL_FORMATS = [...TV_FORMATS, ...FILM_FORMATS];

// Lite GraphQL query — pulls only the fields the freeform-matcher
// needs (id, title, synonyms, format, seasonYear). Used by the
// batched search path so 10-alias responses are ~20 KB instead of
// ~200 KB for the full SEARCH_QUERY. Server-side parse is cheaper
// too. The full SEARCH_QUERY still exists for enrichOne and other
// callers that need the heavy projection.
const SEARCH_LITE_QUERY_BODY = `media(search:$s, type:ANIME, format_in:$f){
  id
  title{ romaji english native }
  synonyms
  format seasonYear
  startDate{ year }
}`;

// Build a batched GraphQL query body with N aliased Page sub-queries.
// Each alias's search string is bound to its own variable ($s0, $s1, …)
// so we don't have to escape special characters in titles (quotes,
// backslashes, GraphQL syntax). Format variable $f is shared.
function buildBatchedSearchQuery(batchSize) {
  const aliasDecls = [];
  const varDecls = [`$f:[MediaFormat]`];
  for (let i = 0; i < batchSize; i++) {
    varDecls.push(`$s${i}:String`);
    aliasDecls.push(`q${i}: Page(perPage:6){ ${SEARCH_LITE_QUERY_BODY.replace('$s', `$s${i}`)} }`);
  }
  return `query(${varDecls.join(', ')}){\n${aliasDecls.join('\n')}\n}`;
}

// Batched AL Search for freeform-import. Sends one HTTP request with
// up to N aliased sub-queries; demultiplexes the response back to
// per-title result lists. On whole-batch failure (network / 5xx /
// breaker), falls back to per-title searchTopByTitle calls so the
// import doesn't lose those titles.
//
// Output shape: Map<title, SearchResult[]> with one entry per input
// title. Empty array when AL returned nothing for that alias.
//
// titles: string[] — up to 10. Caller (page-side adapter) is
// responsible for not exceeding the cap; we enforce here defensively.
export async function searchTopByTitleBatched(titles, { limit = 5 } = {}) {
  const cleanTitles = (titles || [])
    .map(t => String(t || '').trim())
    .filter(Boolean);
  if (cleanTitles.length === 0) return {};
  // Defensive: cap at 10 — larger batches risk AL complexity rejection.
  const batch = cleanTitles.slice(0, 10);
  const variables = { f: ALL_FORMATS };
  for (let i = 0; i < batch.length; i++) variables[`s${i}`] = batch[i];
  const query = buildBatchedSearchQuery(batch.length);

  let data;
  try {
    data = await anilistRequest(query, variables, 'searchBatched');
  } catch (err) {
    // Whole-batch failure — fall back to per-title individual queries.
    // Cost: N round-trips with gateway 800ms pacing. Slower than
    // batched but degrades gracefully when AL rejects the alias form
    // or the gateway breaker is open.
    console.warn('[crsmart] searchTopByTitleBatched: whole-batch failed, falling back to single queries', err?.message || err);
    const out = {};
    for (const t of batch) {
      try { out[t] = await searchTopByTitle(t, { limit }); }
      catch { out[t] = []; }
    }
    return out;
  }

  // Demultiplex: response has data.q0, data.q1, ... — each a
  // Page object with media[]. Partial failure (some alias null)
  // is treated as empty results per the 2026-05-19 grill (Q2 (b)).
  const out = {};
  for (let i = 0; i < batch.length; i++) {
    const title = batch[i];
    const page = data?.[`q${i}`];
    const media = page?.media || [];
    const seen = new Set();
    const results = [];
    for (const m of media) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      results.push({
        aniListId: m.id,
        title: m.title || {},
        synonyms: m.synonyms || [],
        format: m.format || null,
        seasonYear: m.seasonYear || (m.startDate && m.startDate.year) || null,
      });
      if (results.length >= limit) break;
    }
    out[title] = results;
  }
  return out;
}

// Project an AniList Media into the cache shape we'll consume from
// scoring/UI surfaces. Drops AniList-internal noise (edges/nodes
// indirection, irrelevant link entries) but keeps everything the
// engine + popup need.
function projectMedia(media) {
  return {
    _schema: SCHEMA_VERSION,
    aniListId: media.id,
    title: media.title,
    synonyms: media.synonyms || [],
    description: media.description || null,
    tags: (media.tags || []).map(t => ({
      name: t.name,
      rank: t.rank,
      category: t.category,
      isMediaSpoiler: t.isMediaSpoiler,
    })),
    genres: media.genres || [],
    averageScore: media.averageScore,
    meanScore: media.meanScore,
    popularity: media.popularity,
    favourites: media.favourites,
    // Project studios from edges so isMain travels with each entry.
    // Downstream code (franchise.js studio-run clustering and the card's
    // studioAffinityFor) prefers main studios when set, falling back to
    // all animation studios when no main is flagged (older AniList
    // entries that predate the isMain field convention).
    studios: (media.studios?.edges || []).map(e => ({
      id: e.node?.id,
      name: e.node?.name,
      isAnimationStudio: e.node?.isAnimationStudio,
      isMain: e.isMain === true,
    })).filter(s => s.id != null),
    staff: (media.staff?.edges || []).map(e => ({
      id: e.node?.id ?? null,
      role: e.role,
      name: e.node?.name?.full || null,
      image: e.node?.image?.medium || null,
    })),
    recommendations: (media.recommendations?.nodes || []).map(n => ({
      aniListId: n.mediaRecommendation?.id,
      title: n.mediaRecommendation?.title,
      rating: n.rating,
    })).filter(r => r.aniListId),
    source: media.source,
    season: media.season,
    seasonYear: media.seasonYear,
    episodes: media.episodes,
    status: media.status,
    format: media.format,
    duration: media.duration,
    coverImage: media.coverImage || null,
    bannerImage: media.bannerImage || null,
    siteUrl: media.siteUrl || null,
    // External streaming/info site links (Crunchyroll, MAL, Netflix,
    // etc.). The fetch query has carried this field since v1, but the
    // projection used to drop it — meaning every cached entry was
    // missing the data needed to determine "is this on Crunchyroll?"
    // Restored so `findCrLink(entry)` works against cached entries,
    // not just against in-flight fetched media. Each link is
    // { site: 'Crunchyroll'|'MAL'|... , url: 'https://...' }.
    externalLinks: Array.isArray(media.externalLinks)
      ? media.externalLinks.map(l => ({ site: l.site, url: l.url }))
      : [],
    // Precise air dates supplement seasonYear — useful for the franchise
    // year-range when AL only has month/day on a season but no year, and
    // for "ended N years ago" framing.
    startDate: media.startDate
      ? { year: media.startDate.year, month: media.startDate.month, day: media.startDate.day }
      : null,
    endDate: media.endDate
      ? { year: media.endDate.year, month: media.endDate.month, day: media.endDate.day }
      : null,
    // Currently airing show? AL returns nextAiringEpisode for shows with
    // a known upcoming episode. The card can render "next ep in 4 days"
    // once we plumb this to the UI.
    nextAiringEpisode: media.nextAiringEpisode
      ? {
          airingAt: media.nextAiringEpisode.airingAt,
          episode: media.nextAiringEpisode.episode,
          timeUntilAiring: media.nextAiringEpisode.timeUntilAiring,
        }
      : null,
    // Demographic / origin signal. JP / KR / CN. Most CR titles are JP;
    // this lets a future origin-aware filter / signal surface non-JP
    // titles distinctly when the user has a preference.
    countryOfOrigin: media.countryOfOrigin || null,
    isAdult: media.isAdult === true,
    // Trailer info — for an embedded preview on the card if/when we
    // wire it up. Site is usually 'youtube'; thumbnail is direct URL.
    trailer: media.trailer
      ? { id: media.trailer.id, site: media.trailer.site, thumbnail: media.trailer.thumbnail }
      : null,
    // Raw community-rating histogram. Powers the future "CR-vs-AL
    // audience disagreement" chip without re-fetching, and gives us
    // shape data (bimodal vs unimodal distribution) cheap.
    scoreDistribution: media.stats?.scoreDistribution
      ? media.stats.scoreDistribution.map(d => ({ score: d.score, amount: d.amount }))
      : null,
    // Direct relations, flattened and trimmed. We only keep animation
    // studios here — producer/licensor studios aren't meaningful for
    // "who made it" clustering. buildFranchise() walks this list to
    // compute franchise totals and studio-run splits.
    relations: (media.relations?.edges || []).map(e => ({
      type: e.relationType,
      node: e.node ? {
        aniListId: e.node.id,
        format: e.node.format,
        episodes: e.node.episodes,
        seasonYear: e.node.seasonYear,
        startYear: e.node.startDate?.year || null,
        title: e.node.title || null,
        // Relation-node studios: use edges so isMain rides with each
        // entry. Filter to animation studios only (no licensors). When
        // any studio is flagged main, prefer ONLY mains so franchise-
        // walk clustering doesn't pick up outsourcing studios as the
        // canonical "Made by" credit (One Piece-shaped issue: Toei is
        // main but Magic Bus / TAP / Mushi etc. are also listed as
        // animation studios for outsourcing). Falls back to all anim
        // studios when no main is set (older AL entries).
        studios: (() => {
          const all = (e.node.studios?.edges || [])
            .filter(se => se.node?.isAnimationStudio)
            .map(se => ({ id: se.node.id, name: se.node.name, isMain: se.isMain === true }));
          const mains = all.filter(s => s.isMain);
          return mains.length ? mains : all;
        })(),
      } : null,
    })).filter(r => r.node),
  };
}

// Public — match one CR series to AniList. Returns a cache-shaped object
// with _matchConfidence indicating how much to trust it.
export async function enrichOne({ seriesId, title, slug }, opts = {}) {
  // skipRootDescription: bulk callers (e.g. the CR-catalog rebuild) that
  // only need tags/relations/score skip the per-show root-walk — that walk
  // is several extra serial AL fetches per show, turning a ~20-min job into
  // a multi-hour one. The pool entries never render their own opener text.
  const skipRoot = opts.skipRootDescription === true;
  const searchTerm = title || slug || '';
  if (!searchTerm) {
    return { _matchConfidence: 'no-title', _searchTitle: null, fetchedAt: Date.now() };
  }

  // Pass 1: TV
  let candidates = await runSearch(searchTerm, TV_FORMATS);
  let verified = candidates.filter(m => extractCrIdFromUrl(findCrLink(m)) === seriesId);

  // Pass 2: film/OVA/special if TV verification missed
  if (verified.length === 0) {
    const filmCandidates = await runSearch(searchTerm, FILM_FORMATS);
    candidates = candidates.concat(filmCandidates);
    verified = filmCandidates.filter(m => extractCrIdFromUrl(findCrLink(m)) === seriesId);
  }

  if (verified.length > 0) {
    const canonical = pickCanonicalSeason(verified);
    const base = projectMedia(canonical);
    const projected = skipRoot ? base : await withRootDescription(base);
    return {
      ...projected,
      _matchConfidence: 'verified',
      _searchTitle: searchTerm,
      _verifiedFromCount: verified.length,
      fetchedAt: Date.now(),
    };
  }

  // No CR-link verification anywhere. Fall back to the top TV result if
  // we have one — flagged so callers know to weight it accordingly.
  const fallback = candidates[0];
  if (fallback) {
    const base = projectMedia(fallback);
    const projected = skipRoot ? base : await withRootDescription(base);
    return {
      ...projected,
      _matchConfidence: 'unverified-best-guess',
      _searchTitle: searchTerm,
      fetchedAt: Date.now(),
    };
  }

  return {
    _matchConfidence: 'no-match',
    _searchTitle: searchTerm,
    fetchedAt: Date.now(),
  };
}

async function runByIds(ids) {
  const data = await anilistRequest(BY_ID_QUERY, { ids }, 'byId');
  return data?.Page?.media || [];
}

// Formats eligible to be visited during the root walk. TV/TV_SHORT
// always qualify. MOVIE is included because some franchises chain
// chronologically through a movie interquel (e.g. SAO: Alicization's
// only PREQUEL is to "Ordinal Scale" the movie, which itself PREQUELs
// SAO II — without MOVIE here, the walker stops at Alicization and
// treats it as root). OVA/SPECIAL/ONA included after Slime probe
// 2026-05-16: Slime's PREQUEL chain bridges S2 → "Coleus no Yume"
// OVA → S1, and excluding OVA left the walker stopping at S2 with
// S2's "The second season of..." text. Most OVAs that AL tags as
// PREQUEL/PARENT (not SIDE_STORY) ARE part of the canonical chain.
// MUSIC excluded — short MVs rarely carry canonical franchise links.
const ROOT_WALK_FORMATS = new Set(['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL']);

// Among a projected media's relations[], pick the next-hop candidate
// for a root walk. Prefers PARENT (AniList convention: a PARENT edge
// usually points directly to the franchise root, e.g. all the FMA TV
// runs share a PARENT pointer). Falls back to the earliest-year PREQUEL.
function pickEarlierTvRoot(relations) {
  if (!Array.isArray(relations) || !relations.length) return null;
  const tvCandidates = relations.filter(r =>
    r?.node?.aniListId &&
    ROOT_WALK_FORMATS.has(r.node.format) &&
    (r.type === 'PREQUEL' || r.type === 'PARENT'),
  );
  if (!tvCandidates.length) return null;
  const yearOf = n => n.seasonYear ?? n.startYear ?? 9999;
  const parents = tvCandidates.filter(r => r.type === 'PARENT');
  const pool = parents.length ? parents : tvCandidates;
  return pool.slice().sort((a, b) => yearOf(a.node) - yearOf(b.node))[0].node;
}

// Walk PREQUEL/PARENT relations to find the franchise root TV entry,
// then overlay its description onto the input projection. AniList stores
// per-season descriptions ("The seventh season of X..."), but the card
// renders the franchise as a whole — the root entry's opener is what
// the user expects. Idempotent (returns input unchanged once
// _descriptionFromRoot is set). Capped at 10 hops with cycle detection.
//
// The cap accommodates AniList's per-season chain convention for TV
// sequels: MHA S7 PREQUELs back through S6→S5→S4→S3→S2→S1 (6 hops).
// PARENT-pointing spin-offs/movies hit the root in 1. 10 hops covers
// the deepest seasonal anime that exist with headroom.
//
// `cache` (optional Map<aniListId, projectedMedia>) dedups root fetches
// across a batch — bulkFetchByIds passes a shared map so two seasons
// of the same franchise don't each re-walk the same chain.
async function withRootDescription(projected, cache) {
  if (!projected || projected._descriptionFromRoot === true) return projected;
  if (!Array.isArray(projected.relations) || !projected.relations.length) return projected;

  const visited = new Set([projected.aniListId]);
  let cur = projected;
  // Track whether the walk terminated organically (no more PREQUEL/PARENT
  // pointing to a TV root candidate). A walk that exits due to cap,
  // cycle, or fetch failure is NOT complete — we don't lock the result
  // in via _descriptionFromRoot:true, so a later migration pass can
  // retry. Without this, a single 429 during migration would freeze a
  // mid-chain season in as the "root" and prevent recovery.
  let walkComplete = false;
  for (let hop = 0; hop < 10; hop++) {
    const nextRel = pickEarlierTvRoot(cur.relations);
    if (!nextRel) { walkComplete = true; break; }
    if (visited.has(nextRel.aniListId)) break;
    visited.add(nextRel.aniListId);

    let nextProjected = cache?.get(nextRel.aniListId);
    if (!nextProjected) {
      let arr;
      try { arr = await runByIds([nextRel.aniListId]); }
      catch (_) { break; }
      const fetched = Array.isArray(arr) ? arr[0] : null;
      if (!fetched) break;
      nextProjected = projectMedia(fetched);
      cache?.set(nextRel.aniListId, nextProjected);
    }
    cur = nextProjected;
  }
  if (cur.aniListId === projected.aniListId) return projected;
  if (!cur.description) return projected;
  if (!walkComplete) {
    // Partial walk — overlay the closer-to-root description anyway (better
    // than the original per-season text), but don't mark complete so the
    // entry stays eligible for re-walk on next migration.
    return { ...projected, description: cur.description, _descriptionRootId: cur.aniListId };
  }
  return {
    ...projected,
    description: cur.description,
    _descriptionFromRoot: true,
    _descriptionRootId: cur.aniListId,
  };
}

// Pre-warm `cache` with every node the chunk's root-walks will visit,
// fetching each hop-LEVEL in a single batched runByIds instead of one
// request per hop per chain. withRootDescription (called per media right
// after) then finds every hop already cached and issues zero network — it
// keeps its exact overlay / cycle / completeness semantics; we only move
// the fetches off the serial 800ms-paced single-ID path. This is the same
// alias-batching idea as the freeform search speedup, applied to root walks.
//
// Mirrors withRootDescription's walk exactly: same pickEarlierTvRoot
// next-hop, same 10-hop cap, same per-chain cycle detection. A hop whose
// batched fetch fails is left uncached, so withRootDescription will retry
// it as a single fetch (rare) — correctness never depends on the prewarm.
async function prewarmRootChains(seeds, cache, signal) {
  const chains = [];
  for (const p of seeds) {
    if (!p || p._descriptionFromRoot === true) continue;
    if (!Array.isArray(p.relations) || !p.relations.length) continue;
    chains.push({ cur: p, visited: new Set([p.aniListId]), hops: 0, done: false });
  }
  while (chains.some(c => !c.done)) {
    if (signal?.aborted) return;
    const pending = [];        // { ch, nextId } advancing this hop-level
    const toFetch = new Set();  // uncached next-hop ids to batch-fetch
    for (const ch of chains) {
      if (ch.done) continue;
      if (ch.hops >= 10) { ch.done = true; continue; }
      const nextRel = pickEarlierTvRoot(ch.cur.relations);
      if (!nextRel || ch.visited.has(nextRel.aniListId)) { ch.done = true; continue; }
      pending.push({ ch, nextId: nextRel.aniListId });
      if (!cache.has(nextRel.aniListId)) toFetch.add(nextRel.aniListId);
    }
    if (!pending.length) break;
    if (toFetch.size) {
      const ids = [...toFetch];
      for (let i = 0; i < ids.length; i += 50) {
        let arr;
        try { arr = await runByIds(ids.slice(i, i + 50)); }
        catch (_) { arr = []; }
        for (const m of arr) {
          if (m && !cache.has(m.id)) cache.set(m.id, projectMedia(m));
        }
      }
    }
    for (const { ch, nextId } of pending) {
      const np = cache.get(nextId);
      if (!np) { ch.done = true; continue; } // fetch failed → stop this chain
      ch.visited.add(nextId);
      ch.cur = np;
      ch.hops++;
    }
  }
}

// Predicate: does this projected entry have at least one PREQUEL/PARENT
// edge pointing to a TV root candidate? Used by the migration to decide
// whether an entry whose root-walk previously came up incomplete
// (_descriptionFromRoot !== true) should be retried.
export function hasTvRootCandidate(entry) {
  if (!entry || !Array.isArray(entry.relations)) return false;
  return entry.relations.some(r =>
    (r.type === 'PREQUEL' || r.type === 'PARENT') &&
    r.node?.format && ROOT_WALK_FORMATS.has(r.node.format),
  );
}

// Public — fetch full Media projections for a list of AniList IDs.
// Chunks of 50 (AniList Page max) with the same 1500ms inter-request
// gap as bulkEnrich. Returns { [aniListId]: projectedMedia }.
// Query for the popular-seed scan. Same projection as BY_ID_QUERY so
// projectMedia can handle the result, but sorts by POPULARITY_DESC
// without needing IDs up front. Used by seedPopularShows to widen
// aniListCache coverage beyond the user's watch history — so the card
// renders on popular shows the user browses but hasn't watched.
const POPULAR_QUERY = `query($page:Int,$perPage:Int){
  Page(page:$page, perPage:$perPage){
    pageInfo{ hasNextPage total perPage currentPage lastPage }
    media(sort:POPULARITY_DESC, type:ANIME){
      id
      title{ romaji english native }
      synonyms
      description(asHtml:false)
      tags{ name rank category isMediaSpoiler }
      genres
      averageScore meanScore popularity favourites
      studios{ edges{ isMain node{ id name isAnimationStudio } } }
      staff(perPage:12, sort:RELEVANCE){ edges{ role node{ id name{ full } image{ medium } } } }
      recommendations(perPage:8, sort:RATING_DESC){
        nodes{ rating mediaRecommendation{ id title{ romaji english } } }
      }
      source season seasonYear episodes status format duration
      coverImage{ medium large color }
      siteUrl
      externalLinks{ site url }
      ${RELATIONS_FRAGMENT}
    }
  }
}`;

async function runPopularPage(page, perPage) {
  const data = await anilistRequest(POPULAR_QUERY, { page, perPage }, 'popular');
  return data?.Page || { media: [], pageInfo: {} };
}

// Query: top peak shows by tag, sorted by averageScore. Used by the
// survey "seed from AniList" CTA — when a user taps a tag (e.g.
// "Nudity") and their behavioral history doesn't generate any
// candidates with that tag, the rec pool has nothing to elevate via
// the stated-preference override. This query fetches top-rated shows
// with the tag so they can be injected as candidates.
//
// AniList's `tag` filter operates on tag names; `genre_in` operates on
// the canonical genre enum (a separate, smaller taxonomy). The survey
// surfaces both — Genres section names are AniList genres, Themes /
// Mature / Demographics are tags. fetchTopShowsByTag dispatches to the
// right filter based on which taxonomy the input belongs to. SCORE_DESC
// sorts results so peak-tier shows surface first.
const BY_TAG_TOP_QUERY = `query($tag:String,$perPage:Int){
  Page(perPage:$perPage){
    media(tag:$tag, sort:SCORE_DESC, type:ANIME){
      id
      title{ romaji english native }
      synonyms
      description(asHtml:false)
      tags{ name rank category isMediaSpoiler }
      genres
      averageScore meanScore popularity favourites
      studios{ edges{ isMain node{ id name isAnimationStudio } } }
      staff(perPage:12, sort:RELEVANCE){ edges{ role node{ id name{ full } image{ medium } } } }
      recommendations(perPage:8, sort:RATING_DESC){
        nodes{ rating mediaRecommendation{ id title{ romaji english } } }
      }
      source season seasonYear episodes status format duration
      coverImage{ medium large color }
      siteUrl
      externalLinks{ site url }
      ${RELATIONS_FRAGMENT}
    }
  }
}`;

const BY_GENRE_TOP_QUERY = `query($genre:String,$perPage:Int){
  Page(perPage:$perPage){
    media(genre:$genre, sort:SCORE_DESC, type:ANIME){
      id
      title{ romaji english native }
      synonyms
      description(asHtml:false)
      tags{ name rank category isMediaSpoiler }
      genres
      averageScore meanScore popularity favourites
      studios{ edges{ isMain node{ id name isAnimationStudio } } }
      staff(perPage:12, sort:RELEVANCE){ edges{ role node{ id name{ full } image{ medium } } } }
      recommendations(perPage:8, sort:RATING_DESC){
        nodes{ rating mediaRecommendation{ id title{ romaji english } } }
      }
      source season seasonYear episodes status format duration
      coverImage{ medium large color }
      siteUrl
      externalLinks{ site url }
      ${RELATIONS_FRAGMENT}
    }
  }
}`;

// Canonical AniList genre list (frozen 2026-04-30). Names that match
// here go through media(genre:...) instead of media(tag:...). Note
// some names overlap with AniList tags (Ecchi is both genre AND a
// related tag) — we prefer genre when AniList exposes both, since the
// genre filter has broader coverage on canonical-by-name shows.
const ANILIST_GENRES = new Set([
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Hentai',
  'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological',
  'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
]);

// Public — fetch top peak shows by tag/genre from AniList. Returns
// projected Media keyed by AniList ID, sorted by averageScore desc.
// Default 15 shows per query. Filters out null averageScore so unaired
// / unrated shows don't fill the seed pool with noise.
//
// Dispatches between AniList's tag and genre filters based on the
// input name — survey tiles span both taxonomies and a single
// `tag:` query would silently 0-result for genre-only names like
// "Action" or "Comedy".
export async function fetchTopShowsByTag(tagName, opts = {}) {
  const perPage = opts.perPage ?? 15;
  if (!tagName) return {};
  const useGenre = ANILIST_GENRES.has(tagName);
  const query = useGenre ? BY_GENRE_TOP_QUERY : BY_TAG_TOP_QUERY;
  const variables = useGenre
    ? { genre: tagName, perPage }
    : { tag: tagName, perPage };
  const opName = useGenre ? 'genre-top' : 'tag-top';
  const data = await anilistRequest(query, variables, opName);
  const media = data?.Page?.media || [];
  const out = {};
  const rootCache = new Map();
  for (const m of media) {
    if (!m?.id) continue;
    if (m.averageScore == null || m.averageScore <= 0) continue;
    rootCache.set(m.id, projectMedia(m));
  }
  for (const m of media) {
    const baseProjected = rootCache.get(m.id);
    if (!baseProjected) continue;
    const withRoot = await withRootDescription(baseProjected, rootCache);
    out[m.id] = {
      ...withRoot,
      _matchConfidence: 'tag-seed',
      _seededFromTag: tagName,
      fetchedAt: Date.now(),
    };
  }
  return out;
}

// Public — fetch popular AniList shows that have a Crunchyroll link,
// projected + keyed by CR series ID. Used for the top-N popular seed
// so the Smart Score card renders on shows the user browses but hasn't
// yet watched. Stops when either:
//   - `targetCount` CR-linked shows have been collected, or
//   - `maxPages` has been reached (pagination safety bound)
// Non-CR shows in the result are filtered out silently — the user can't
// watch them on CR, no value in caching.
export async function fetchPopularCrShows(opts = {}) {
  const targetCount = opts.targetCount ?? 500;
  const maxPages = opts.maxPages ?? 25;      // 50/page × 25 = 1250 max scanned
  const out = {};                            // { [crSeriesId]: projectedMedia }
  const rootCache = new Map();               // shared across pages so franchise siblings dedup root fetches
  let page = 1;
  let totalScanned = 0;
  while (Object.keys(out).length < targetCount && page <= maxPages) {
    const pageData = await runPopularPage(page, 50);
    const media = Array.isArray(pageData.media) ? pageData.media : [];
    if (!media.length) break;
    // Seed the root cache with this page's projections first, so a
    // sibling-season root that happens to be on the same page is free.
    const pageProjected = new Map();
    for (const m of media) {
      const projected = projectMedia(m);
      pageProjected.set(m.id, projected);
      rootCache.set(m.id, projected);
    }
    for (const m of media) {
      totalScanned++;
      const crLink = findCrLink(m);
      if (!crLink) continue;
      const crId = extractCrIdFromUrl(crLink);
      if (!crId) continue;
      if (out[crId]) continue;     // dedup if pagination quirks surface same show
      const baseProjected = pageProjected.get(m.id);
      const withRoot = await withRootDescription(baseProjected, rootCache);
      const final = { ...withRoot, _matchConfidence: 'popular-seed', fetchedAt: Date.now() };
      out[crId] = final;
      if (Object.keys(out).length >= targetCount) break;
    }
    if (!pageData.pageInfo?.hasNextPage) break;
    page++;
  }
  return { byCrId: out, totalScanned, pagesFetched: page };
}

// Fast-path enrichment when we already know the AniList ID for a
// given CR series (via manami's CR→AniList map). Skips the search-
// and-verify step of enrichOne — three upsides:
//   (a) ~2-3× faster per on-visit enrichment
//   (b) ~80% fewer AniList requests (no search query)
//   (c) works around AniList's own externalLinks gaps (MHA S1's
//       CR URL isn't in AniList's externalLinks — manami has it
//       from aggregating other sources)
// Caller (worker) should prefer this when `crToAniListId[seriesId]`
// resolves, falling back to the title-search enrichOne otherwise.
export async function enrichOneByMappedId({ seriesId, aniListId }) {
  if (!aniListId) {
    return { _matchConfidence: 'no-id', fetchedAt: Date.now() };
  }
  let mediaArr;
  try {
    mediaArr = await runByIds([aniListId]);
  } catch (err) {
    return {
      _matchConfidence: 'error',
      _error: String(err?.message || err),
      fetchedAt: Date.now(),
    };
  }
  const media = Array.isArray(mediaArr) ? mediaArr[0] : null;
  if (!media) {
    return {
      _matchConfidence: 'no-match',
      _searchTitle: seriesId,
      fetchedAt: Date.now(),
    };
  }
  const projected = await withRootDescription(projectMedia(media));
  return {
    ...projected,
    _matchConfidence: 'manami-mapped',
    _searchTitle: seriesId,
    fetchedAt: Date.now(),
  };
}

// Bulk-fetch AniList Media projections by ID. Runs `runByIds` in
// chunks (default 50 IDs per GraphQL request) with a configurable
// gap between chunks. Default gap reduced from 1500ms → 800ms on
// 2026-05-04 — bulkFetchByIds has no per-show fanout (1 request per
// 50-id chunk), unlike bulkEnrich which can fire 2 search calls per
// show. 800ms = ~75/min, well under the 90/min cap with comfortable
// margin for occasional spikes.
//
// opts:
//   chunkSize — IDs per request; default 50 (AL's documented sweet spot)
//   signal   — optional AbortSignal; checked between chunks. Throws
//              the signal's reason on abort so the caller can branch
//              on AbortError vs other errors.
//   onBatch  — optional callback fired after each chunk lands;
//              receives { done, total, batch: {[id]: media} }. Lets
//              the caller persist progress incrementally without
//              waiting for the full bulk to complete (used by the
//              external-list importer to update _importState).
export async function bulkFetchByIds(ids, opts = {}) {
  const chunkSize = opts.chunkSize ?? 50;
  const signal = opts.signal || null;
  const onBatch = typeof opts.onBatch === 'function' ? opts.onBatch : null;
  // skipRootDescription: callers that only need the relation graph + counts
  // (franchise-bridge enrichment) opt out of the per-node root-description
  // walk. The visited show's opener text comes from its own on-visit
  // enrichOne, so bridge nodes don't each need to walk to their franchise
  // root — that walk was the dominant cost of the "Enriching franchise
  // data" passes.
  const skipRootDescription = opts.skipRootDescription === true;
  const out = {};
  const unique = [...new Set(ids.filter(n => Number.isInteger(n)))];
  // Shared root-walk cache across the whole bulk so multiple seasons of
  // the same franchise (e.g. MHA S2/S3/S4/.../S7 all walking back to S1)
  // hit AniList only once for the root entry. Seeded with each chunk's
  // own results so a sibling-season root fetch is free.
  //
  // opts.seedRootCache: optional Map<aniListId, projectedMedia> the
  // caller can preload. Migration uses this to pass in the full
  // aniListCache so root-walks can traverse the user's existing
  // entries without fetching them again. Without seeding, a multi-
  // hop walk like Slime S3 → S2 Part 2 → S2 → S1 would issue 3 AL
  // fetches even though the user already has all four cached.
  const rootCache = opts.seedRootCache instanceof Map
    ? new Map(opts.seedRootCache)
    : new Map();
  let done = 0;
  for (let i = 0; i < unique.length; i += chunkSize) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const slice = unique.slice(i, i + chunkSize);
    const media = await runByIds(slice);
    const projectedById = new Map();
    for (const m of media) {
      const projected = projectMedia(m);
      projectedById.set(m.id, projected);
      rootCache.set(m.id, projected);
    }
    // Batch the root-walk fetches: pre-warm rootCache hop-by-hop across the
    // whole chunk so the per-media withRootDescription below resolves every
    // hop from cache (zero extra single-ID requests). Skipped entirely when
    // the caller opted out of descriptions.
    if (!skipRootDescription) {
      await prewarmRootChains([...projectedById.values()], rootCache, signal);
    }
    const batch = {};
    for (const m of media) {
      const baseProjected = projectedById.get(m.id);
      const finalProjected = skipRootDescription
        ? baseProjected
        : await withRootDescription(baseProjected, rootCache);
      const final = { ...finalProjected, fetchedAt: Date.now() };
      out[m.id] = final;
      batch[m.id] = final;
    }
    done += slice.length;
    if (onBatch) {
      try { await onBatch({ done, total: unique.length, batch }); }
      catch (err) { console.warn('[anilist] bulkFetchByIds onBatch threw', err); }
    }
  }
  return out;
}

// Public — bulk enrich a list of unique CR series. Rate-limited under
// AniList's 90 req/min anonymous budget. Persists incrementally via the
// onProgress callback so a worker restart only loses the in-flight item.
//
// onProgress({ done, total, current, result }) is called after each
// series — synchronous side-effects (storage writes) belong to the
// caller so this module stays pure.
export async function bulkEnrich(seriesList, onProgress, opts = {}) {
  const total = seriesList.length;
  let done = 0;
  for (const series of seriesList) {
    let result;
    try {
      result = await enrichOne(series);
    } catch (err) {
      result = {
        _matchConfidence: 'error',
        _error: String(err.message || err),
        _searchTitle: series.title,
        fetchedAt: Date.now(),
      };
    }
    done++;
    try { await onProgress({ done, total, current: series, result }); } catch (_) {}
  }
}

// ── MAL → AniList ID cross-walk ─────────────────────────────────
// Used by external-list-importer to convert MAL list entries
// (which come back keyed by MAL id) into AL-keyed records — the
// rest of the engine is aniListId-keyed end-to-end. AL exposes
// `idMal` as a queryable field; Page returns up to 50 per request.
//
// Returns { [malId]: aniListId } for the IDs AL knew about. MAL IDs
// without an AniList counterpart are absent from the result —
// caller filters them out (those entries can't slot into Sentiment
// because the engine has no record of them).
const MAL_ID_LOOKUP_QUERY = `query($malIds:[Int]){
  Page(perPage:50){
    media(idMal_in:$malIds, type:ANIME){
      id
      idMal
    }
  }
}`;

export async function bulkLookupByMalIds(malIds, opts = {}) {
  const signal = opts.signal || null;
  const onBatch = typeof opts.onBatch === 'function' ? opts.onBatch : null;
  const out = {};
  const unique = [...new Set(malIds.filter(n => Number.isInteger(n)))];
  const chunkSize = 50;
  let done = 0;
  for (let i = 0; i < unique.length; i += chunkSize) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const slice = unique.slice(i, i + chunkSize);
    const data = await anilistRequest(MAL_ID_LOOKUP_QUERY, { malIds: slice }, 'malIdLookup');
    const media = data?.Page?.media || [];
    for (const m of media) {
      if (Number.isInteger(m?.idMal) && Number.isInteger(m?.id)) {
        out[m.idMal] = m.id;
      }
    }
    done += slice.length;
    if (onBatch) {
      try { await onBatch({ done, total: unique.length, batchHits: media.length }); }
      catch (err) { console.warn('[anilist] bulkLookupByMalIds onBatch threw', err); }
    }

  }
  return out;
}

// ── User-list fetching for the External-score importer ──────────
// Pulls the authenticated user's anime list from AL's
// MediaListCollection endpoint. Returns lightweight per-Series records
// — score, status, progress, updatedAt — keyed by aniListId. Media
// metadata (tags, studios, etc.) is intentionally NOT fetched here;
// the importer pipes the IDs through bulkFetchByIds for any aniListIds
// not already in aniListBridgeCache.
//
// AL list-status values map onto the Sentiment status vocabulary as:
//   CURRENT    → 'watching'
//   COMPLETED  → 'completed'
//   PAUSED     → 'paused'
//   DROPPED    → 'dropped'
//   PLANNING   → 'planning'
//   REPEATING  → 'completed' (rewatching is the *strongest* love signal —
//                a user finishing a show then explicitly going back to
//                rewatch it. Mapping to 'watching' previously meant the
//                synthesis pass skipped these entries entirely; treating
//                them as 'completed' lets them feed Sentiment with high
//                confidence as they should. 2026-05-04 audit fix.)
const AL_STATUS_NORMALIZE = {
  CURRENT:   'watching',
  COMPLETED: 'completed',
  PAUSED:    'paused',
  DROPPED:   'dropped',
  PLANNING:  'planning',
  REPEATING: 'completed',
};

// MediaListCollection returns ALL of a user's lists (Watching,
// Completed, etc.) in one query — much cheaper than paginated
// per-status queries. score(format: POINT_10) requests scores in the
// 0-10 scale that the External score signal-mapping expects. Score 0
// from AL means "no score" (user hasn't rated), kept distinct from
// score 1.
// Public list fetch by username — no OAuth, no token, no client secret.
// AniList serves a user's MediaListCollection by userName unauthenticated
// when their list is public; the same query resolves User{id name} so the
// caller can store the account. Private lists and unknown usernames both
// return HTTP 404, surfaced as a typed error so the UI can tell the user to
// check the name / make their list public. score(format:POINT_10) → 0-10;
// score 0 means "no score".
const USER_LIST_BY_NAME_QUERY = `query($userName:String){
  User(name:$userName){ id name }
  MediaListCollection(userName:$userName, type:ANIME){
    lists{
      entries{
        media{ id }
        score(format: POINT_10)
        status
        progress
        updatedAt
      }
    }
  }
}`;

// Returns { account: { id, name }, list: { [aniListId]: { score, status,
// progress, updatedAt } } }. Throws an Error with code='not-found-or-private'
// when AniList 404s (unknown user OR private list — the body that
// distinguishes them isn't surfaced through the gateway, so we report both).
export async function fetchUserListByName(userName) {
  const name = String(userName || '').trim();
  if (!name) throw new Error('fetchUserListByName requires a username');
  let data;
  try {
    data = await anilistRequest(USER_LIST_BY_NAME_QUERY, { userName: name }, 'userListByName');
  } catch (err) {
    if (/\b404\b/.test(String(err?.message || ''))) {
      const e = new Error(`AniList user "${name}" not found, or their list is private. Check the spelling and make sure the list is set to public.`);
      e.code = 'not-found-or-private';
      throw e;
    }
    throw err;
  }
  const u = data?.User;
  if (!u?.id) {
    const e = new Error(`AniList user "${name}" not found.`);
    e.code = 'not-found-or-private';
    throw e;
  }
  const out = {};
  const lists = data?.MediaListCollection?.lists || [];
  for (const list of lists) {
    for (const entry of (list.entries || [])) {
      const aniListId = entry?.media?.id;
      if (!Number.isInteger(aniListId)) continue;
      const status = AL_STATUS_NORMALIZE[entry.status] || null;
      const score = (typeof entry.score === 'number' && entry.score > 0) ? entry.score : null;
      out[aniListId] = {
        score,
        status,
        progress:  entry.progress ?? null,
        updatedAt: entry.updatedAt ?? null,
      };
    }
  }
  return { account: { id: u.id, name: u.name }, list: out };
}
