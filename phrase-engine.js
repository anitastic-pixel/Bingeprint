// Friend-voice phrase engine. Phase A scope:
//
//   1. tagPhrase(entry, polarity) — looks up a tag's friendly phrase
//      from window.crsmartPhraseMap. Returns {text, fromMap} so the
//      caller can decide whether to render or filter.
//   2. selectChips(source, polarity, opts) — replacement for the
//      legacy pickSignedTags. Drops unmapped tags + backfills from
//      further down the user-weighted list. Safety net: if survivors
//      < 2, allow a single raw-tag fallback so the card never goes
//      empty on a niche show.
//   3. composeSkipIf(rec, dealbreakerTags) — replacement for
//      skipIfClause. 4 friend-voice templates rotated by show-id
//      hash (deterministic per show). Phase A covers two categories:
//      dealbreaker tags (A) and strong anti-tags (B). Franchise-depth
//      (E) is deferred to Phase C-future.
//   4. logUnmappedTag(name) — debounced storage write to
//      chrome.storage.local._unmappedTagCounts so authoring backlog
//      can be derived from real usage. Brother-playtest readout
//      surfaces top-50 unmapped names for next authoring batch.
//
// Phase B (multi-source pool: studio/creator/genre×tag/adaptation)
// will land in this file as additional composeChips* helpers; the
// Phase A export shape is designed to extend without breaking
// content.js's call site.
//
// Non-module script, exposed as `window.crsmartPhraseEngine` to match
// phrase-map.js + backup-schema.js conventions. content.js consumes
// via the global; the manifest loads phrase-map.js → phrase-engine.js
// → content.js so order is guaranteed.

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────

  const STORAGE_KEY_UNMAPPED = '_unmappedTagCounts';
  const DEFAULT_BUDGET = { positive: 6, negative: 3 };
  const SAFETY_NET_MIN = 2;  // below this, allow a raw-tag fallback

  // Friend-voice skip-if templates. Indexed by show-id hash for
  // deterministic-per-show selection (same show always shows same
  // skip-if line — avoids the "different chip text on every visit"
  // weirdness). Each {N}-template takes one or two phrase fragments
  // from the matched dealbreaker / anti-tag categories.
  const SKIP_TEMPLATES_ONE = [
    'Skip if {0} is a dealbreaker.',
    'Pass if {0} isn\'t your speed.',
    'Probably not if {0} loses you.',
    'Maybe sit out if {0} grates.',
  ];
  const SKIP_TEMPLATES_TWO = [
    'Skip if {0} or {1} is a dealbreaker.',
    'Pass if {0} or {1} isn\'t your speed.',
    'Probably not if {0} or {1} loses you.',
    'Maybe sit out if {0} or {1} grates.',
  ];

  // ── Core lookups ───────────────────────────────────────────────

  // Look up a tag entry's friendly phrase. polarity is 'positive'
  // (use entry.pos) or 'negative' (use entry.neg if present, else
  // entry.pos — sign carried by chip color/prefix only).
  // Returns { text, fromMap, phrase } where:
  //   - text: the string to display in the chip
  //   - fromMap: true if the tag had a map entry, false if we fell
  //     back to the raw tag name
  //   - phrase: the canonical map entry (or null) — useful for
  //     debugging / tooltip-source attribution
  function tagPhrase(tagEntry, polarity) {
    const map = (typeof window !== 'undefined' && window.crsmartPhraseMap) || {};
    const tagName = tagEntry?.tag || '';
    const entry = map[tagName];
    if (!entry) {
      return { text: tagName, fromMap: false, phrase: null };
    }
    let text;
    if (polarity === 'negative' && entry.neg) text = entry.neg;
    else if (polarity === 'positive' && entry.pos) text = entry.pos;
    else text = entry.pos || entry.neg || tagName;
    return { text, fromMap: true, phrase: entry };
  }

  // ── Chip selection (Phase A) ───────────────────────────────────

  // Replacement for pickSignedTags. Same input shape (raw topTags /
  // topAntiTags arrays from the rec), same output shape (an array of
  // tag-like entries the caller renders), with two changes:
  //
  //   - Unmapped tags are dropped from the primary selection.
  //   - The pool keeps walking down the user-weighted list to backfill
  //     dropped slots with the next mapped tag.
  //   - If the final list has < SAFETY_NET_MIN entries, allow ONE
  //     raw-tag fallback so the card never goes near-empty on a niche
  //     show with mostly unmapped tags.
  //
  // Caller semantics from pickSignedTags are preserved:
  //   - filter out implied tags
  //   - filter out blocklisted tags via opts.isUsefulTag
  //   - filter out broad genres if opts.excludeBroadGenres + isBroadGenre
  //   - sign filter (positive: userWeight > 0, negative: userWeight < 0)
  //   - magnitude floor (Math.abs(userWeight * rank / 100) >= floor)
  //
  // opts: {
  //   isUsefulTag: fn(name)→bool,            // required (passes through)
  //   isBroadGenre: fn(name)→bool,           // required for genre exclusion
  //   excludeBroadGenres: bool,              // default true
  //   floor: number,                         // SIGNED_TAG_FLOOR
  //   budget: number,                        // overrides DEFAULT_BUDGET
  // }
  function selectChips(source, polarity, opts = {}) {
    const sign = polarity === 'positive' ? 1 : -1;
    const want = opts.budget || DEFAULT_BUDGET[polarity] || 5;
    const floor = opts.floor || 0;
    const excludeBroad = opts.excludeBroadGenres !== false;
    const isUseful = opts.isUsefulTag || (() => true);
    const isBroad = opts.isBroadGenre || (() => false);

    // First pass: every tag that passes the legacy filters AND is in
    // the phrase map. We walk the FULL source list (not slice(0,N))
    // so backfill has runway.
    const candidates = (source || [])
      .filter(t => t && !t.implied)
      .filter(t => isUseful(t.tag))
      .filter(t => excludeBroad ? !isBroad(t.tag) : true)
      .filter(t => sign > 0 ? t.userWeight > 0 : t.userWeight < 0)
      .filter(t => Math.abs((t.userWeight || 0) * (t.rank || 0) / 100) >= floor);

    const map = (typeof window !== 'undefined' && window.crsmartPhraseMap) || {};
    const mapped = [];
    const unmapped = [];
    for (const t of candidates) {
      if (map[t.tag]) {
        mapped.push(t);
      } else {
        unmapped.push(t);
        // Fire-and-forget log for authoring backlog. Debounced
        // internally so we don't hammer chrome.storage.
        logUnmappedTag(t.tag);
      }
    }

    // Take up to `want` from mapped. If we have fewer than the safety
    // net minimum, top up with one raw-tag chip so the row isn't empty.
    const out = mapped.slice(0, want);
    if (out.length < SAFETY_NET_MIN && unmapped.length > 0) {
      out.push(unmapped[0]);  // single raw-tag rescue
    }
    return out;
  }

  // ── Skip-if (Phase A scope: A + B) ─────────────────────────────

  // Build the "Skip if X is a dealbreaker" line. Two signal sources:
  //   A) Dealbreaker tags — entries from rec.topTags whose name
  //      matches any of the user's configured dealbreakerTags. These
  //      are the highest-confidence skip signal (user explicitly
  //      vetoed the tag).
  //   B) Strong negative anti-tags — entries from rec.topAntiTags
  //      with userWeight < SKIP_ANTITAG_FLOOR. These reflect taste
  //      patterns the user has consistently dropped without explicit
  //      veto. Soft signal; phrasing is gentler.
  //
  // Phase C-future: E (franchise-depth warning) — when the show is
  // S2+ of a series the user hasn't watched, warn about prior
  // seasons. Needs relations + watch history walk; defer.
  //
  // Templates rotate by show-id hash so the same show always shows
  // the same line — no nondeterminism between page loads.
  //
  // Returns null if no signals fire.
  const SKIP_ANTITAG_FLOOR = -0.3;
  function composeSkipIf(rec, dealbreakerTags, opts) {
    // E1) Movie continuation — anime fans need the heads-up that this
    // is a theatrical sequel, not a standalone film. CR's series page
    // doesn't make this obvious for movies the way it does for TV
    // seasons (which already have season selectors right above the
    // card). Highest priority because miss-watching a continuation
    // movie without context is the worst-case onboarding failure.
    const movieSkip = movieContinuationSkipIf(rec);
    if (movieSkip) return movieSkip;

    // E2) Runtime mismatch — when the show is significantly longer
    // than the user's typical loved-show length, surface a heads-up.
    // Falls back to absolute-threshold mode when no user profile is
    // passed in (warns above ~100 eps regardless of user).
    const runtimeSkip = runtimeMismatchSkipIf(
      rec, opts?.userLengthProfile, opts?.effectiveEpisodes
    );
    if (runtimeSkip) return runtimeSkip;

    const dbSet = new Set((dealbreakerTags || []).map(s => String(s).toLowerCase().trim()));
    const dbHits = [];
    const seen = new Set();

    // A) Dealbreaker matches against topTags.
    for (const t of rec?.topTags || []) {
      const lower = String(t.tag || '').toLowerCase().trim();
      if (!dbSet.has(lower)) continue;
      const phrase = tagPhrase(t, 'negative').text;
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      dbHits.push(phrase);
      if (dbHits.length >= 2) break;
    }

    // B) Strong anti-tags. Only consider if dealbreakers haven't
    // already filled the slots.
    if (dbHits.length < 2) {
      for (const t of rec?.topAntiTags || []) {
        if ((t.userWeight || 0) > SKIP_ANTITAG_FLOOR) continue;
        const phrase = tagPhrase(t, 'negative').text;
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        dbHits.push(phrase);
        if (dbHits.length >= 2) break;
      }
    }

    if (!dbHits.length) return null;

    const idx = showIdHash(rec) % SKIP_TEMPLATES_ONE.length;
    const tpl = dbHits.length === 2 ? SKIP_TEMPLATES_TWO[idx] : SKIP_TEMPLATES_ONE[idx];
    return tpl.replace('{0}', dbHits[0]).replace('{1}', dbHits[1] || '');
  }

  // ── Movie-continuation skip-if (Phase C: E1) ─────────────────────
  //
  // Catches theatrical continuations like Mugen Train, Reze Arc, and
  // other movies that pick up from an existing TV series. CR's series
  // page already surfaces season selectors for multi-season TV (so a
  // "you're on S2" warning is redundant), but for movies the link to
  // the prerequisite series isn't always obvious in the page chrome.
  //
  // Trigger: format === 'MOVIE' AND franchise has at least one prior
  // TV season AND the movie's year is later than the franchise start.
  function movieContinuationSkipIf(rec) {
    if (rec?.format !== 'MOVIE') return null;
    const franchise = rec?.franchise;
    if (!franchise) return null;
    const recYear = rec?.seasonYear || 0;
    const startYear = (franchise.yearRange && franchise.yearRange[0]) || 0;
    const totalSeasons = franchise.totalTvSeasons || 0;
    if (totalSeasons < 1 || !recYear || !startYear || recYear <= startYear) return null;
    return 'Skip if you haven\'t seen the series this picks up from.';
  }

  // ── Runtime-mismatch skip-if (Phase C: E2) ───────────────────────
  //
  // When the show is significantly longer than the user's typical
  // loved-show length, surface a "heads up — this is a long
  // commitment" line. Useful for One Piece / Bleach / Naruto / Conan
  // -tier franchises where 200+ eps is a real time investment.
  //
  // Two modes:
  //   - With profile: tolerance = max(medianLovedEpisodes × 2, 50).
  //     Warns when rec.episodes ≥ tolerance. So a 12-ep-cours user
  //     gets warned at 50+ eps; a long-runner fan only gets warned
  //     at 200+ eps (their median × 2).
  //   - Without profile: absolute threshold of 100 eps. Conservative
  //     fallback — warns on objectively long shows even when we
  //     can't profile the user yet.
  //
  // Phrase scales with show length so the warning matches the
  // commitment magnitude.
  const RUNTIME_FLOOR_EPS = 50;            // absolute floor below which no warning fires
  const RUNTIME_NO_PROFILE_THRESHOLD = 100; // fallback when no userLengthProfile
  function runtimeMismatchSkipIf(rec, userLengthProfile, effectiveEpisodes) {
    // Resolution chain:
    //   1. effectiveEpisodes (caller-provided, augments AL franchise
    //      with CR per-season totals — the only reliable count for
    //      currently-airing franchises like One Piece)
    //   2. rec.episodes (single-entry shows where AL has the total)
    //   3. rec.franchise.totalTvEps (AL-only franchise rollup)
    const eps = effectiveEpisodes || rec?.episodes || rec?.franchise?.totalTvEps || 0;
    if (eps < RUNTIME_FLOOR_EPS) return null;
    let threshold;
    if (userLengthProfile?.medianLovedEpisodes != null) {
      threshold = Math.max(userLengthProfile.medianLovedEpisodes * 2, RUNTIME_FLOOR_EPS);
    } else {
      threshold = RUNTIME_NO_PROFILE_THRESHOLD;
    }
    if (eps < threshold) return null;
    if (eps >= 500) return 'Skip if 500+ episodes is too much commitment.';
    if (eps >= 200) return 'Skip if a 200-episode run is too much.';
    if (eps >= 100) return 'Skip if 100+ episodes feels like a project.';
    return 'Skip if you bounce off long-runners.';
  }

  // Deterministic-per-show template index. Hash the aniListId or
  // title so the same show always picks the same template across
  // page loads (no flicker on revisit).
  function showIdHash(rec) {
    const src = String(rec?.aniListId || rec?.title || '');
    let h = 0;
    for (let i = 0; i < src.length; i++) {
      h = ((h << 5) - h) + src.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  // ── Unmapped-tag logging ──────────────────────────────────────

  // Debounced batch write to chrome.storage.local._unmappedTagCounts.
  // Multiple unmapped fires within a 1s window collapse into one
  // storage round-trip. Used for authoring backlog: after a week of
  // brother playtesting, read back via popup or
  //   chrome.storage.local.get('_unmappedTagCounts')
  // and use the top entries to drive next phrase-map authoring batch.
  let _pendingUnmapped = new Map();
  let _flushTimer = null;
  function logUnmappedTag(name) {
    if (!name) return;
    if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
    _pendingUnmapped.set(name, (_pendingUnmapped.get(name) || 0) + 1);
    if (_flushTimer) return;
    _flushTimer = setTimeout(flushUnmapped, 1000);
  }
  async function flushUnmapped() {
    _flushTimer = null;
    const batch = _pendingUnmapped;
    _pendingUnmapped = new Map();
    if (batch.size === 0) return;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_UNMAPPED);
      const counts = stored?.[STORAGE_KEY_UNMAPPED] || {};
      for (const [name, n] of batch) {
        counts[name] = (counts[name] || 0) + n;
      }
      await chrome.storage.local.set({ [STORAGE_KEY_UNMAPPED]: counts });
    } catch (_) {
      // Extension context invalidated during dev reload — drop the
      // batch silently. Next reload starts fresh.
    }
  }

  // ── ChipSpec: canonical chip-output contract ────────────────────
  //
  // Every chip that flows to the Smart Score card's render layer is a
  // ChipSpec. Producers across phrase-engine, vibe-tags, and (legacy)
  // selectChips MUST return this shape. The render layer
  // (content.js:renderSignedChip) reads only ChipSpec fields and
  // looks up tint/style by ChipSpec.source. Adding a new chip type =
  // adding a new `source` value + a tint-registry entry, nothing else.
  //
  // Required fields:
  //   text     string  display phrase (already friend-voiced)
  //   source   string  one of: 'tag' | 'genre-tag' | 'multi-axis' |
  //                    'studio' | 'creator' | 'adaptation' | 'burnout' |
  //                    'vibe-composite' | 'vibe-single'
  //
  // Always-present optional fields:
  //   sign     string  'positive' | 'negative' (positive when absent)
  //   tooltip  string  hover/aria tip (auto-derived if absent)
  //   score    number  raw composer score (used only by rankCandidates;
  //                    render layer ignores it)
  //
  // Source-specific fields (only present when source matches):
  //   tag-source:        tag, userWeight, rank, isMediaSpoiler, implied
  //   genre-tag-source:  underlyingTag (string — composite consumes this)
  //   multi-axis-source: underlyingTags (string[] — composite consumes these)
  //   studio-source:     studioId
  //   creator-source:    creatorId
  //   burnout-source:    tag (the burnout-flagged tag)
  //   vibe-*-source:     vibes (string[] — vibe names from VIBE_GROUPS)
  //
  // Legacy note: selectChips() still returns raw tag entries (not
  // wrapped to ChipSpec) for the negative-row path that bypasses
  // composeChipsPhaseB. renderSignedChip handles both via an
  // isTagSource dispatch. New code should produce ChipSpecs; the
  // chip-composer refactor will remove the legacy branch.
  //
  // ── Phase B: composite chip pool (positive row only) ────────────
  //
  // composeChipsPhaseB returns up to 4 ChipSpecs drawn from 5 sources:
  //   - tag          : Phase A's tag chips (selectChips wrapper)
  //   - genre-tag    : "Slice-of-life fantasy" idiom composites
  //   - studio       : "MAPPA signature" / "MAPPA track record"
  //   - creator      : "Saitou signature" / "Saitou track record"
  //   - adaptation   : "Light-novel adaptation" / "Manga adaptation"
  //
  // Selection (locked in design grilling Q7):
  //   Caps: tag ≤3, genre-tag ≤1, multi-axis ≤2, studio ≤1, creator ≤1, adaptation ≤1
  //   Multipliers: tag ×1.0, genre-tag ×1.3, multi-axis ×1.4, studio ×1.5,
  //                creator ×1.5, adaptation ×0.7
  //   Sort by score × multiplier desc, take top 4. If <4 candidates,
  //   render fewer — sparse-but-honest beats dense-and-dilute.
  //
  // ctx = { studioCreatorIndex, isUsefulTag, isBroadGenre, floor, budget }

  const PHASE_B_CAPS = { tag: 3, 'genre-tag': 1, 'multi-axis': 2, studio: 1, creator: 1, adaptation: 1 };
  const PHASE_B_MULTS = { tag: 1.0, 'genre-tag': 1.3, 'multi-axis': 1.4, studio: 1.5, creator: 1.5, adaptation: 0.7 };
  const STUDIO_AFFINITY_FLOOR = 1.5;
  const STUDIO_PEAK_FLOOR = 3.0;
  // Quality threshold for "{studio} standout" — fires when EITHER:
  //   - rec.averageScore ≥ STUDIO_QUALITY_AVG_FLOOR (raw AniList community
  //     score, 0–100 scale; null for un-released or low-rating-count shows)
  //   - rec.qualityAxes.craftPrior ≥ STUDIO_QUALITY_CRAFT_FLOOR (the
  //     engine's pre-computed craft prior; same threshold as PEAK PEDIGREE
  //     so the standout chip fires on the same shows the verdict row
  //     already flags as high-craft)
  // Either-or because newer/movie releases often have null averageScore
  // but solid craftPrior from studio + director priors. The badge already
  // surfaces on those; the studio chip should match.
  const STUDIO_QUALITY_AVG_FLOOR = 80;
  const STUDIO_QUALITY_CRAFT_FLOOR = 0.80;
  const CREATOR_AFFINITY_FLOOR = 1.5;
  const CREATOR_PEAK_FLOOR = 3.0;

  // Co-tag gate for phrase entries that need disambiguation (e.g.
  // 'Super Power' fires "Powered protagonists" only when paired with
  // Magic/Supernatural/Cyborg/etc. — see phrase-map.js Super Power
  // entry). Returns true when the gate passes (or there is no gate).
  // Looks at rec.topTags + rec.allTags + rec.matched as the union
  // tag set; falls back to topTags when the others aren't present.
  function passesPhraseGate(tag, rec) {
    const map = (typeof window !== 'undefined' && window.crsmartPhraseMap) || {};
    const entry = map[tag];
    const requireAny = entry?.requireAny;
    if (!Array.isArray(requireAny) || requireAny.length === 0) return true;
    // Build a name-set from whichever tag-bearing arrays this rec has.
    // realTagRanks (when present on rec) is the canonical set from
    // per-show-score; topTags is user-weighted. Either is sufficient
    // to check co-occurrence; combining is safer for niche shows.
    const names = new Set();
    for (const t of (rec?.topTags || [])) if (t?.tag) names.add(t.tag);
    for (const t of (rec?.matched || [])) if (t?.tag) names.add(t.tag);
    const real = rec?.realTagRanks;
    if (real && typeof real === 'object') for (const k of Object.keys(real)) names.add(k);
    for (const g of (rec?.genres || [])) names.add(g);
    return requireAny.some(t => names.has(t));
  }

  function composeChipsPhaseB(rec, ctx = {}) {
    const candidates = [];

    // 1. Tag chips — Phase A's filter, wrapped as ChipSpec. Each
    //    candidate also passes through passesPhraseGate so phrases
    //    requiring co-occurrence (e.g. Super Power needs Magic/Cyborg/
    //    similar to fire "Powered protagonists") drop out cleanly when
    //    the show is missing the co-tag.
    const tagSelected = selectChips(rec?.topTags, 'positive', ctx)
      .filter(t => passesPhraseGate(t.tag, rec));
    for (const t of tagSelected) {
      const phrased = tagPhrase(t, 'positive');
      candidates.push({
        text: phrased.text,
        source: 'tag',
        sign: 'positive',
        score: Math.abs((t.userWeight || 0) * (t.rank || 0) / 100),
        tag: t.tag,
        userWeight: t.userWeight,
        rank: t.rank,
        isMediaSpoiler: t.isMediaSpoiler,
        implied: t.implied,
      });
    }

    // 2. Multi-axis composites (Phase E) — fire on (tag, tag) pairs
    //    whose constituents are both in topTags. Each composite marks
    //    its two constituent tags as consumed; rankCandidates' swallow
    //    pass drops the corresponding solo tag chips.
    const multiAxis = composeMultiAxisChips(rec);
    for (const c of multiAxis) candidates.push(c);

    // 3. Genre × tag composites — replaces a tag chip when a known
    //    (genre, tag) idiom matches. The composite suppresses the
    //    underlying tag's chip via underlyingTag.
    const composite = genreTagCompositeFor(rec, candidates);
    if (composite) candidates.push(composite);

    // 3. Studio chip — fires when one of the show's main animation
    //    studios has user affinity above the floor.
    const studioChip = studioChipFor(rec, ctx);
    if (studioChip) candidates.push(studioChip);

    // 4. Creator chip — same rule applied to keyStaff via byRole index.
    const creatorChip = creatorChipFor(rec, ctx);
    if (creatorChip) candidates.push(creatorChip);

    // 5. Adaptation chip — flat context label, low multiplier.
    const adaptChip = adaptationChipFor(rec);
    if (adaptChip) candidates.push(adaptChip);

    // Cap-and-rank pass.
    return rankCandidates(candidates, 4);
  }

  function rankCandidates(candidates, want) {
    // STEP A: cross-composite suppression. Both genre-tag composites
    // (one underlyingTag) and multi-axis composites (two underlyingTags)
    // can fire on the same rec using the same underlying tag — e.g.
    // Cowboy Bebop hit both "Found-family ensemble" (multi-axis) and
    // "Found-family adventure" (genre-tag). The chip row would render
    // two near-duplicate phrases. Group composites by each underlying
    // tag; within each tag's group keep only the highest-scoring chip;
    // drop the rest.
    const compositesByTag = new Map();  // tagLower → [{c, score}, ...]
    const isComposite = c => c.source === 'genre-tag' || c.source === 'multi-axis';
    for (const c of candidates) {
      if (!isComposite(c)) continue;
      const tags = c.source === 'multi-axis'
        ? (c.underlyingTags || [])
        : (c.underlyingTag ? [c.underlyingTag] : []);
      for (const t of tags) {
        const k = String(t).toLowerCase();
        if (!compositesByTag.has(k)) compositesByTag.set(k, []);
        compositesByTag.get(k).push(c);
      }
    }
    const compositesDropped = new Set();
    for (const [, group] of compositesByTag) {
      if (group.length < 2) continue;
      // Highest raw-score wins; tie-break by source preference
      // (multi-axis > genre-tag — richer editorial layer).
      const sourceRank = src => src === 'multi-axis' ? 1 : 0;
      const winner = group.reduce((best, c) =>
        (c.score > best.score) ||
        (c.score === best.score && sourceRank(c.source) > sourceRank(best.source))
          ? c : best
      );
      for (const c of group) if (c !== winner) compositesDropped.add(c);
    }

    // STEP B: build swallow set from SURVIVING composites only — we
    // don't want a dropped composite to still suppress its underlying
    // tag chip.
    const swallowed = new Set();
    for (const c of candidates) {
      if (compositesDropped.has(c)) continue;
      if (c.source === 'genre-tag' && c.underlyingTag) {
        swallowed.add(c.underlyingTag.toLowerCase());
      }
      if (c.source === 'multi-axis' && Array.isArray(c.underlyingTags)) {
        for (const t of c.underlyingTags) swallowed.add(String(t).toLowerCase());
      }
    }
    const filtered = candidates.filter(c => {
      if (compositesDropped.has(c)) return false;
      if (c.source !== 'tag') return true;
      return !swallowed.has(String(c.tag || '').toLowerCase());
    });

    // Per-category caps. Within each category, sort by raw score desc
    // and keep up to PHASE_B_CAPS[source].
    const byCat = new Map();
    for (const c of filtered) {
      if (!byCat.has(c.source)) byCat.set(c.source, []);
      byCat.get(c.source).push(c);
    }
    const capped = [];
    for (const [src, list] of byCat) {
      list.sort((a, b) => b.score - a.score);
      const cap = PHASE_B_CAPS[src] ?? 1;
      capped.push(...list.slice(0, cap));
    }

    // Per-category normalization. Tag scores are computed as
    // userWeight × rank / 100 which can be 100+ for deep-affinity
    // tags on highly-tagged shows; studio/creator scores are clamped
    // to 0–1.5. Without normalization, every tag chip outranks every
    // studio chip via raw cross-category comparison. Normalize each
    // category's max to 1.0 so multipliers behave as intended.
    const maxByCat = {};
    for (const c of capped) {
      const cur = maxByCat[c.source] ?? 0;
      if (c.score > cur) maxByCat[c.source] = c.score;
    }
    capped.sort((a, b) => {
      const aNorm = maxByCat[a.source] > 0 ? a.score / maxByCat[a.source] : 0;
      const bNorm = maxByCat[b.source] > 0 ? b.score / maxByCat[b.source] : 0;
      const ax = aNorm * (PHASE_B_MULTS[a.source] || 1);
      const bx = bNorm * (PHASE_B_MULTS[b.source] || 1);
      return bx - ax;
    });

    return capped.slice(0, want);
  }

  // ── Phase B sub-helpers ─────────────────────────────────────────

  // Phase E: multi-axis composite idioms. Hand-curated table of
  // (tagA, tagB) → editorial phrase. Fires when BOTH tags are present
  // in rec.topTags (positive userWeight × rank already passed the
  // selection threshold). Composite consumes both constituents — they
  // get suppressed from the regular tag-chip pool — replacing what
  // would otherwise be 2 separate weaker tag chips with one editorial
  // chip. Cluster taxonomy (Mood / Structure / Cultural / Theme) is
  // editorial framing only; resolver just looks up sorted-pair keys.
  // Idiom set is grounded in actual the user-library co-occurrence
  // counts (scripts/phase-e-probe.js); only pairs with count ≥ 5 and
  // a phrase that reads in friend-voice make the cut.
  const MULTI_AXIS_IDIOMS = Object.freeze([
    // ── Mood × Structure ──
    { tags: ['Episodic', 'Iyashikei'],          phrase: 'Iyashikei vignettes' },
    { tags: ['Episodic', 'Slapstick'],          phrase: 'Slapstick vignettes' },
    { tags: ['Ensemble Cast', 'Iyashikei'],     phrase: 'Iyashikei ensemble' },
    // ── Mood × Cultural ──
    { tags: ['Post-Apocalyptic', 'Tragedy'],    phrase: 'Wasteland tragedy' },
    { tags: ['Isekai', 'Tragedy'],              phrase: 'Tragic isekai' },
    { tags: ['Medieval', 'Tragedy'],            phrase: 'Medieval tragedy' },
    { tags: ['Rural', 'Tragedy'],               phrase: 'Rural tragedy' },
    { tags: ['Philosophy', 'Urban Fantasy'],    phrase: 'Philosophical urban fantasy' },
    // ── Mood × Theme ──
    { tags: ['Coming of Age', 'Tragedy'],       phrase: 'Coming-of-age tragedy' },
    { tags: ['Revenge', 'Tragedy'],             phrase: 'Revenge tragedy' },
    { tags: ['Anti-Hero', 'Tragedy'],           phrase: 'Anti-hero tragedy' },
    { tags: ['Tragedy', 'War'],                 phrase: 'Wartime tragedy' },
    { tags: ['Coming of Age', 'Iyashikei'],     phrase: 'Iyashikei coming-of-age' },
    { tags: ['Mystery', 'Philosophy'],          phrase: 'Philosophical mystery' },
    { tags: ['Time Manipulation', 'Tragedy'],   phrase: 'Time-bent tragedy' },
    // ── Cultural × Structure ──
    { tags: ['Ensemble Cast', 'Isekai'],        phrase: 'Isekai ensemble' },
    // ── Cultural × Theme ──
    { tags: ['Isekai', 'Politics'],             phrase: 'Political isekai' },
    { tags: ['Medieval', 'Politics'],           phrase: 'Medieval politics' },
    { tags: ['Found Family', 'Isekai'],         phrase: 'Found-family isekai' },
    { tags: ['Mystery', 'Urban Fantasy'],       phrase: 'Urban-fantasy mystery' },
    // ── Structure × Theme ──
    { tags: ['Ensemble Cast', 'Found Family'],  phrase: 'Found-family ensemble' },
    { tags: ['Coming of Age', 'Ensemble Cast'], phrase: 'Coming-of-age ensemble' },
  ]);

  // O(1) lookup: sorted-pair key ('TagA||TagB' with TagA < TagB) → idiom.
  // Built once at module load. Tie-break order from the table is preserved
  // by walking MULTI_AXIS_IDIOMS in declaration order downstream — the map
  // is just for membership tests.
  const MULTI_AXIS_INDEX = (() => {
    const m = new Map();
    for (const entry of MULTI_AXIS_IDIOMS) {
      const [a, b] = [...entry.tags].sort();
      m.set(`${a}||${b}`, entry);
    }
    return m;
  })();

  // Multi-axis composer. Walks all 2-tag pairs from rec.topTags where
  // both tags are non-spoiler, non-implied, positive-weight. For each
  // pair, checks MULTI_AXIS_INDEX. Greedy resolution: highest-scoring
  // matched idiom fires first, marks both constituent tags consumed,
  // skips any later idiom that conflicts. Returns ChipSpec[] with
  // underlyingTags (plural) so rankCandidates can suppress the
  // corresponding solo tag chips.
  function composeMultiAxisChips(rec) {
    const tags = (rec?.topTags || []).filter(t =>
      t && t.userWeight > 0 && !t.implied && !t.isMediaSpoiler
    );
    if (tags.length < 2) return [];

    // Build a tag-name → entry lookup for fast pair scoring.
    const byName = new Map();
    for (const t of tags) byName.set(t.tag, t);

    // Score every matched idiom present on this rec.
    const matches = [];
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const a = tags[i].tag, b = tags[j].tag;
        const key = a < b ? `${a}||${b}` : `${b}||${a}`;
        const idiom = MULTI_AXIS_INDEX.get(key);
        if (!idiom) continue;
        const sa = (tags[i].userWeight || 0) * (tags[i].rank || 0) / 100;
        const sb = (tags[j].userWeight || 0) * (tags[j].rank || 0) / 100;
        matches.push({
          idiom,
          score: Math.abs(sa) + Math.abs(sb),
          tableIndex: MULTI_AXIS_IDIOMS.indexOf(idiom),
          tagA: tags[i].tag,
          tagB: tags[j].tag,
        });
      }
    }
    if (!matches.length) return [];

    // Greedy: sort by score desc; tie-break by table order (earlier wins).
    matches.sort((x, y) =>
      y.score - x.score || x.tableIndex - y.tableIndex
    );

    const consumed = new Set();
    const out = [];
    for (const m of matches) {
      const a = m.tagA.toLowerCase(), b = m.tagB.toLowerCase();
      if (consumed.has(a) || consumed.has(b)) continue;
      consumed.add(a); consumed.add(b);
      out.push({
        text: m.idiom.phrase,
        source: 'multi-axis',
        sign: 'positive',
        score: m.score,
        underlyingTags: [m.tagA, m.tagB],
        tooltip: `${m.tagA} × ${m.tagB}`,
      });
    }
    return out;
  }

  // Genre × tag composite idioms. Hand-curated table of (tagName,
  // genreName) → composite phrase. The composite fires when BOTH
  // signals are present on the rec; otherwise the underlying tag
  // gets a regular chip via Phase A. Score = the underlying tag's
  // score (the genre is context, not a discriminating signal).
  const COMPOSITE_IDIOMS = Object.freeze([
    { tag: 'Slice of Life',  genre: 'Fantasy',       phrase: 'Slice-of-life fantasy' },
    { tag: 'Slice of Life',  genre: 'Drama',         phrase: 'Slice-of-life drama' },
    { tag: 'Slice of Life',  genre: 'Romance',       phrase: 'Slice-of-life romance' },
    { tag: 'Slice of Life',  genre: 'Sci-Fi',        phrase: 'Slice-of-life sci-fi' },
    { tag: 'Coming of Age',  genre: 'Drama',         phrase: 'Coming-of-age drama' },
    { tag: 'Coming of Age',  genre: 'Romance',       phrase: 'Coming-of-age romance' },
    { tag: 'Detective',      genre: 'Mystery',       phrase: 'Detective mystery' },
    { tag: 'Magic',          genre: 'Fantasy',       phrase: 'High-fantasy magic' },
    { tag: 'Magic School',   genre: 'Fantasy',       phrase: 'Magic-academy fantasy' },
    { tag: 'War',            genre: 'Drama',         phrase: 'Wartime drama' },
    { tag: 'Politics',       genre: 'Drama',         phrase: 'Political drama' },
    { tag: 'Tournament',     genre: 'Sports',        phrase: 'Tournament sports' },
    { tag: 'Time Travel',    genre: 'Sci-Fi',        phrase: 'Time-travel sci-fi' },
    { tag: 'Cyberpunk',      genre: 'Sci-Fi',        phrase: 'Cyberpunk sci-fi' },
    { tag: 'Found Family',   genre: 'Adventure',     phrase: 'Found-family adventure' },
    { tag: 'Found Family',   genre: 'Drama',         phrase: 'Found-family drama' },
    { tag: 'Survival',       genre: 'Action',        phrase: 'Survival action' },
    { tag: 'Survival',       genre: 'Horror',        phrase: 'Survival horror' },
    { tag: 'Crime',          genre: 'Drama',         phrase: 'Crime drama' },
    { tag: 'Crime',          genre: 'Thriller',      phrase: 'Crime thriller' },
    { tag: 'Espionage',      genre: 'Thriller',      phrase: 'Spy thriller' },
    { tag: 'Psychological',  genre: 'Thriller',      phrase: 'Psychological thriller' },
    { tag: 'Psychological',  genre: 'Drama',         phrase: 'Psychological drama' },
    // Genre-pair shorthands (both treated as "tag" + "genre" for matching;
    // we synthesise a fake tag entry by checking the rec's genres list
    // when neither Slice/Coming/etc. fires).
  ]);

  function genreTagCompositeFor(rec, existingCandidates) {
    const genres = new Set((rec?.genres || []).map(g => String(g)));
    const positiveTags = (rec?.topTags || []).filter(t =>
      t && t.userWeight > 0 && !t.implied
    );
    if (genres.size === 0 || positiveTags.length === 0) return null;

    // Walk idioms; first match wins.
    for (const idiom of COMPOSITE_IDIOMS) {
      if (!genres.has(idiom.genre)) continue;
      const tagHit = positiveTags.find(t =>
        String(t.tag).toLowerCase() === idiom.tag.toLowerCase()
      );
      if (!tagHit) continue;
      return {
        text: idiom.phrase,
        source: 'genre-tag',
        sign: 'positive',
        score: Math.abs((tagHit.userWeight || 0) * (tagHit.rank || 0) / 100),
        underlyingTag: tagHit.tag,
        tooltip: `${idiom.tag} (tag) × ${idiom.genre} (genre)`,
      };
    }
    return null;
  }

  // Studio chip. Walks rec.animationStudios (already filtered to
  // animation-only, main-studio-preferred). Two signal sources fire
  // independently or together:
  //
  //   USER AFFINITY (taste — does the user trust this studio?)
  //     studioCreatorIndex.studios[id].totalWeight
  //   SHOW QUALITY (canon — is this show critically respected?)
  //     rec.averageScore (AniList 0–100 scale)
  //
  // Phrase grid:
  //                    user_aff LOW (<1.5)    user_aff HIGH (≥1.5)
  //   quality LOW         (no chip)            "{name} track record"
  //   quality HIGH (≥80)  "{name} standout"    "Peak {name} craft"
  //
  // The "standout" path lets the chip fire even with no user
  // affinity — gives anime fans an honest editorial signal about
  // the show's standing within the studio's catalog. Weight ≥3.0
  // alone also upgrades to "Peak craft" without quality threshold,
  // because deep user affinity speaks for itself.
  //
  // Picks the best (highest combined score) studio when multiple fire.
  function studioChipFor(rec, ctx) {
    const idx = ctx?.studioCreatorIndex?.studios;
    const studios = rec?.animationStudios || [];
    if (!studios.length) return null;
    const avgScore = rec?.averageScore || 0;
    const craftPrior = rec?.qualityAxes?.craftPrior || 0;
    const qualityHigh =
      avgScore >= STUDIO_QUALITY_AVG_FLOOR ||
      craftPrior >= STUDIO_QUALITY_CRAFT_FLOOR;

    let best = null;
    for (const s of studios) {
      const id = s?.id ?? s?.node?.id;
      const name = s?.name ?? s?.node?.name;
      if (!id || !name) continue;
      const entry = idx?.[id];
      const weight = entry?.totalWeight ?? entry?.weight ?? 0;

      // Determine which fire condition applies, if any.
      let kind = null;   // 'peak' | 'track-record' | 'standout'
      let score = 0;
      if (weight >= STUDIO_PEAK_FLOOR ||
          (weight >= STUDIO_AFFINITY_FLOOR && qualityHigh)) {
        kind = 'peak';
        // Combine user-affinity weight with quality bonus when both fire.
        const qualBonus = qualityHigh ? 0.3 : 0;
        score = Math.min(weight / 3.0 + qualBonus, 1.5);
      } else if (weight >= STUDIO_AFFINITY_FLOOR) {
        kind = 'track-record';
        score = Math.min(weight / 3.0, 1.5);
      } else if (qualityHigh) {
        kind = 'standout';
        // Quality-only path — combine both quality signals into one
        // score in the 0.5–1.0 band. Whichever signal is stronger
        // wins. averageScore 80→0.5, 100→1.0; craftPrior 0.80→0.6,
        // 1.0→1.0. Floor at 0.5 so a marginally-quality show still
        // ranks above zero-affinity tag chips.
        const avgScoreContrib = avgScore >= STUDIO_QUALITY_AVG_FLOOR
          ? Math.min(((avgScore - 80) / 20) + 0.5, 1.0) : 0;
        const craftContrib = craftPrior >= STUDIO_QUALITY_CRAFT_FLOOR
          ? Math.min(((craftPrior - 0.8) / 0.2) * 0.4 + 0.6, 1.0) : 0;
        score = Math.max(avgScoreContrib, craftContrib, 0.5);
      }
      if (!kind) continue;
      if (!best || score > best.score) {
        best = { id, name, kind, score, weight };
      }
    }
    if (!best) return null;

    let text;
    if (best.kind === 'peak')              text = `Peak ${best.name} craft`;
    else if (best.kind === 'track-record') text = `${best.name} track record`;
    else                                   text = `${best.name} standout`;

    let tooltip;
    if (best.kind === 'standout') {
      const parts = [];
      if (avgScore >= STUDIO_QUALITY_AVG_FLOOR) parts.push(`avgScore ${avgScore}`);
      if (craftPrior >= STUDIO_QUALITY_CRAFT_FLOOR) parts.push(`craftPrior ${craftPrior.toFixed(2)}`);
      tooltip = `${best.name} — ${parts.join(' · ')} (top-tier work)`;
    } else {
      tooltip = `${best.name} affinity weight ${best.weight.toFixed(2)}` +
        (best.kind === 'peak' ? ' (peak)' : ' (trusted)');
    }

    return {
      text,
      source: 'studio',
      sign: 'positive',
      score: best.score,
      studioId: best.id,
      tooltip,
    };
  }

  // Creator chip. Walks rec.keyStaff (director, composition, music,
  // character design — pre-filtered in rank-recommendations.js),
  // looks up each in studioCreatorIndex.creators[id].byRole, fires
  // for the highest-affinity (creator, role) pair.
  // Phrase template scales (vocabulary aligned with studio chip — three
  // tiers, one word per tier, no "fingerprints" — the previous chip
  // word read as a synonym for signature without distinct meaning):
  //   weight ≥ CREATOR_PEAK_FLOOR    → "{Last name} signature"
  //   weight ≥ CREATOR_AFFINITY_FLOOR → "{Last name} track record"
  function creatorChipFor(rec, ctx) {
    const idx = ctx?.studioCreatorIndex?.creators;
    if (!idx) return null;
    const staff = rec?.keyStaff || [];
    if (!staff.length) return null;
    let best = null;
    for (const s of staff) {
      const id = s?.id ?? s?.node?.id;
      const name = s?.name ?? s?.node?.name?.full;
      const role = s?.role || '';
      if (!id || !name) continue;
      const entry = idx[id];
      if (!entry) continue;
      // creators[id] = { id, name, image, byRole: { director: {...}, ... } }
      const byRole = entry.byRole || {};
      // Pick the highest-weight role for this creator.
      let topRoleWeight = 0;
      for (const r of Object.values(byRole)) {
        const w = r?.weight ?? r?.totalWeight ?? 0;
        if (w > topRoleWeight) topRoleWeight = w;
      }
      if (topRoleWeight < CREATOR_AFFINITY_FLOOR) continue;
      if (!best || topRoleWeight > best.weight) {
        best = { id, name, role, weight: topRoleWeight };
      }
    }
    if (!best) return null;
    const peak = best.weight >= CREATOR_PEAK_FLOOR;
    // Use last token of the name as the chip surname (avoids long
    // chip text on full names like "Hayao Miyazaki" → "Miyazaki
    // signature").
    const lastToken = best.name.split(/\s+/).pop();
    const text = peak ? `${lastToken} signature` : `${lastToken} track record`;
    return {
      text,
      source: 'creator',
      sign: 'positive',
      score: Math.min(best.weight / 3.0, 1.5),
      creatorId: best.id,
      tooltip: `${best.name} (${best.role}) — affinity ${best.weight.toFixed(2)}`,
    };
  }

  // ── Burnout chip (Phase D — negative row) ────────────────────────
  //
  // Picks the single highest-decline tag from the burnout index that
  // also appears on this show. "Decline × rank" picks the tag that's
  // both burnt out AND central to the show — so a Shōnen burnout
  // fires on a 90-rank Shōnen show, not on a side-tagged one.
  //
  // Returns ChipSpec with source='burnout', sign='negative'. Caller
  // (content.js) is responsible for the swallow rule — when this
  // fires on tag X, drop the matching plain-tag negative chip on X
  // so the row doesn't show "− Shōnen" and "− Shōnen formula
  // fatigue" both.
  function burnoutChipFor(rec, ctx) {
    const idx = ctx?.tagBurnoutIndex;
    if (!idx) return null;
    const topTags = rec?.topTags || [];
    if (topTags.length === 0) return null;
    let best = null;
    for (const t of topTags) {
      const name = t?.tag;
      if (!name) continue;
      const entry = idx[name];
      if (!entry) continue;  // sparse map — only fired tags present
      const score = (entry.delta || 0) * ((t.rank || 0) / 100);
      if (!best || score > best.score) {
        best = { tag: name, score, delta: entry.delta, sample: entry.sampleSize };
      }
    }
    if (!best) return null;
    const phrase = burnoutPhraseFor(best.tag);
    return {
      text: phrase,
      source: 'burnout',
      sign: 'negative',
      score: best.score,
      tag: best.tag,
      tooltip: `${best.tag} — used to like it (older avg ${idx[best.tag].olderAvg.toFixed(2)}), recent decline (Δ${best.delta.toFixed(2)} across ${best.sample} watches)`,
    };
  }

  // Phrase resolution chain for burnout chips:
  //   1. phrase-map[tag].burnout (deferred — empty in v1)
  //   2. phrase-map[tag].neg (primary; covers ~30 tags with burnout-y phrasings already)
  //   3. "Burned out on " + pos.toLowerCase() (when only pos exists)
  //   4. "Burned out on " + tagName (generic last resort)
  function burnoutPhraseFor(tagName) {
    const map = (typeof window !== 'undefined' && window.crsmartPhraseMap) || {};
    const entry = map[tagName];
    if (entry?.burnout) return entry.burnout;
    if (entry?.neg) return entry.neg;
    if (entry?.pos) return 'Burned out on ' + entry.pos.toLowerCase();
    return 'Burned out on ' + (tagName || '').toLowerCase();
  }

  // Adaptation chip. Flat context label keyed off rec.source. Score
  // is constant — adaptation source isn't a per-user discriminating
  // signal, just context the user might find useful. Multiplier 0.7
  // means it only lands when not crowded out by stronger signals.
  const ADAPTATION_PHRASES = Object.freeze({
    LIGHT_NOVEL:  'Light-novel adaptation',
    NOVEL:        'Novel adaptation',
    WEB_NOVEL:    'Web-novel roots',
    MANGA:        'Manga adaptation',
    VISUAL_NOVEL: 'Visual-novel adaptation',
    VIDEO_GAME:   'Game adaptation',
    GAME:         'Game adaptation',
    ORIGINAL:     'Original anime',
    DOUJINSHI:    'Doujinshi roots',
    PICTURE_BOOK: 'Picture-book adaptation',
    COMIC:        'Comic adaptation',
  });
  function adaptationChipFor(rec) {
    const src = rec?.source;
    if (!src) return null;
    const text = ADAPTATION_PHRASES[src];
    if (!text) return null;
    return {
      text,
      source: 'adaptation',
      sign: 'positive',
      score: 0.5,  // flat — multiplier 0.7 gates whether it actually shows
      tooltip: `Source format: ${src}`,
    };
  }

  // Adapter: convert a legacy tag entry (from selectChips / topAntiTags
  // raw output) into a ChipSpec with source: 'tag'. Used by the
  // negative-row path until the chip-composer refactor lands; new code
  // should produce ChipSpecs directly.
  function toChipSpec(tagEntry, polarity) {
    const phrased = tagPhrase(tagEntry, polarity);
    return {
      text: phrased.text || tagEntry.tag || '',
      source: 'tag',
      sign: polarity,
      score: Math.abs((tagEntry.userWeight || 0) * (tagEntry.rank || 0) / 100),
      tag: tagEntry.tag,
      userWeight: tagEntry.userWeight,
      rank: tagEntry.rank,
      isMediaSpoiler: tagEntry.isMediaSpoiler,
      implied: tagEntry.implied,
    };
  }

  // ── Export ─────────────────────────────────────────────────────

  const api = {
    tagPhrase,
    selectChips,
    composeChipsPhaseB,
    composeSkipIf,
    burnoutChipFor,
    burnoutPhraseFor,
    composeMultiAxisChips,
    toChipSpec,
    logUnmappedTag,
    // Internal — exposed for debugging only.
    _showIdHash: showIdHash,
    _flushUnmapped: flushUnmapped,
    _rankCandidates: rankCandidates,
    _multiAxisIdioms: MULTI_AXIS_IDIOMS,
  };
  if (typeof window !== 'undefined') window.crsmartPhraseEngine = api;
  if (typeof globalThis !== 'undefined') globalThis.crsmartPhraseEngine = api;
})();
