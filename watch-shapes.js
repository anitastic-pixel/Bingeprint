// Watch-shape derivation — implicit-feedback labels from CR watch-history.
//
// CR's /watch-history gives us per-episode { playhead, fully_watched,
// last_played, episode_number, series_id }. That's enough to label each
// series with a behavior shape — much stronger signal for the engine
// than averaging tags across an undifferentiated watched-list.
//
// Two play counts per series:
//   epsWatched — distinct (season, episode) pairs. Feeds completionRatio
//                since it's the honest "how much of the show have they
//                seen" denominator.
//   totalPlays — raw row count. Dub/sub variants + rewatches each count
//                once. Used for the fullPass check since accumulated
//                activity ≥ franchise length implies ≥1 complete pass.
//
// Shapes (in priority order — first match wins):
//   completed     — ≥80% of known eps watched AND last ep fully_watched,
//                   OR epsWatched ≥ franchise total (≥1 full pass logged,
//                   even if the most-recent play event was a partial
//                   rewatch of an earlier ep)
//   in-progress   — partial completion, last play within 6 months
//   paused        — partial completion, last play 6-12 months ago
//   dropped-early — 1-3 eps watched, last play >6 months ago
//   dropped-mid   — 4+ eps but <80%, last play >6 months ago
//   sampled       — 1 ep, partial playhead, never returned
//
// Rewatch detection (best-effort without a play_count field — see open Q
// in BRAINSTORM): for each series, find the gap between the median
// episode-play date and the most-recent. If that gap is >90 days, the
// recent activity is a rewatch — and the episodes with lastPlayedAt
// within 30 days of the recent peak are the user's "kept-coming-back-to"
// episodes. This catches both whole-series rewatches and the
// favorite-scene case (open ep, watch a scene, lastPlayedAt updates
// even though fully_watched stays true).
//
// Pure module — no chrome.* APIs. Caller persists the result.

const SIX_MONTHS_MS  = 1000 * 60 * 60 * 24 * 30 * 6;
const TWELVE_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 12;
const REWATCH_GAP_MS = 1000 * 60 * 60 * 24 * 90;
const REWATCH_CLUSTER_MS = 1000 * 60 * 60 * 24 * 30;
const ONE_DAY_MS = 1000 * 60 * 60 * 24;
const ONE_MONTH_MS = ONE_DAY_MS * 30;
const BINGE_WINDOW_MS = ONE_DAY_MS * 30;
const BINGE_DENSITY_THRESHOLD = 0.70;
const SPORADIC_MEDIAN_GAP_MS = ONE_DAY_MS * 60;

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// Given timestamps sorted ascending, the value at the middle index.
function median(sorted) {
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

// Group items by seriesId, dropping anything without one (movies/specials
// CR couldn't classify, malformed rows). Series-less rows are rare but
// real on the live API.
function groupBySeries(items) {
  const out = new Map();
  for (const it of items) {
    if (!it.seriesId) continue;
    if (!out.has(it.seriesId)) out.set(it.seriesId, []);
    out.get(it.seriesId).push(it);
  }
  return out;
}

// Engagement shape — coarse pacing token. Derived from playTimes
// distribution to distinguish "binge then bounced" from "sampled and
// stalled" from "steady cadence."
//
//   sampled  — only one episode touched
//   binge    — at least 70% of plays cluster in a single 30-day window
//   sporadic — median gap between consecutive plays > 60 days
//   steady   — neither bingey nor sporadic; regular cadence
//   null     — too little data to classify (no playTimes, or single ep
//              already covered by 'sampled')
function deriveEngagementShape(playTimes, epsWatched) {
  if (epsWatched <= 1) return 'sampled';
  if (playTimes.length < 2) return null;

  // Sliding 30-day window over playTimes. Two-pointer sweep finds the
  // window with the most plays; ratio = maxInWindow / total.
  let maxInWindow = 0;
  let left = 0;
  for (let right = 0; right < playTimes.length; right++) {
    while (playTimes[right] - playTimes[left] > BINGE_WINDOW_MS) left++;
    const count = right - left + 1;
    if (count > maxInWindow) maxInWindow = count;
  }
  const density = maxInWindow / playTimes.length;
  if (density >= BINGE_DENSITY_THRESHOLD) return 'binge';

  // Median gap between consecutive plays. A user who watches an ep
  // every 2 months is sporadic regardless of total span.
  const gaps = [];
  for (let i = 1; i < playTimes.length; i++) gaps.push(playTimes[i] - playTimes[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  if (medianGap > SPORADIC_MEDIAN_GAP_MS) return 'sporadic';

  return 'steady';
}

// Drop velocity — episodes-watched per month over the watch span.
// High velocity on a non-completed show = invested then disappointed;
// low velocity = trickling and never invested. Span = first to last
// play. Returns null when span is too short to be meaningful.
function deriveDropVelocity(playTimes, epsWatched) {
  if (playTimes.length < 2 || epsWatched < 1) return null;
  const span = playTimes[playTimes.length - 1] - playTimes[0];
  if (span <= 0) return null;
  const months = span / ONE_MONTH_MS;
  if (months < 0.1) return null; // sub-3-day span — same-day binge, velocity not meaningful
  return +(epsWatched / months).toFixed(2);
}

// Peak episode — the (season, episode) with the most plays. Only
// meaningful when there's per-episode play-count variance, which
// happens for rewatched shows. Returns null otherwise.
function derivePeakEpisode(items, isRewatched) {
  if (!isRewatched) return null;
  const playsByKey = new Map();
  for (const it of items) {
    if (it.seasonNumber == null && it.episodeNumber == null) continue;
    const key = `${it.seasonNumber ?? '?'}|${it.episodeNumber ?? '?'}`;
    const existing = playsByKey.get(key);
    if (existing) existing.plays++;
    else playsByKey.set(key, {
      seasonNumber: it.seasonNumber ?? null,
      episodeNumber: it.episodeNumber ?? null,
      episodeTitle: it.episodeTitle ?? null,
      plays: 1,
    });
  }
  let peak = null;
  for (const entry of playsByKey.values()) {
    if (!peak || entry.plays > peak.plays) peak = entry;
  }
  // Require >1 play to count as a "peak" — single-play episodes have no
  // variance to peak on. The rewatched-shows guard above is necessary
  // but not sufficient: a show flagged as rewatched might have 1 play
  // per episode if the rewatch was a different ep than the original watch.
  if (!peak || peak.plays < 2) return null;
  return peak;
}

function classify(ratio, lastPlayedMs, now, epsWatched, totalPlays, episodesTotal, lastEpFullyWatched) {
  const ageMs = now - lastPlayedMs;
  const recent = ageMs < SIX_MONTHS_MS;
  // fullPass uses raw play count (dub+sub+rewatches all count) because
  // accumulated activity ≥ franchise length is strong evidence of at
  // least one complete pass. completionRatio uses deduped epsWatched so
  // downstream sqrt-weighting isn't inflated by dub/sub double-counts.
  const fullPass = episodesTotal != null && episodesTotal > 0
    && totalPlays >= episodesTotal;

  if (epsWatched === 1 && !lastEpFullyWatched && !recent) return 'sampled';
  if (fullPass) return 'completed';
  if (ratio != null && ratio >= 0.8 && lastEpFullyWatched) return 'completed';
  if (recent) return 'in-progress';
  if (ageMs < TWELVE_MONTHS_MS) return 'paused';
  if (epsWatched <= 3) return 'dropped-early';
  return 'dropped-mid';
}

function deriveSeriesShape(items, episodesTotal, now) {
  // Most recent play across the whole series — anchors freshness checks.
  // Intentionally uses RAW items (not deduped) so dub→sub rewatch plays
  // years apart still move the median vs. max signal rewatch detection
  // relies on.
  const playTimes = items
    .map(it => parseDate(it.lastWatchedAt))
    .filter(t => t != null)
    .sort((a, b) => a - b);
  const lastPlayedMs = playTimes.length ? playTimes[playTimes.length - 1] : null;
  const medianMs = median(playTimes);

  // Dedup dub/sub/re-encode variants into one record per actual episode.
  // Watch-history has a row per (episode_id × audio track), so a user who
  // watched all 138 MHA eps in sub + rewatched a few in dub shows up as
  // 180-ish rows — inflating completionRatio past 100% and drowning taste
  // weighting. Keep the "best" row per (season, episode) pair: prefer a
  // fully-watched play, then the most recent timestamp.
  const byEpisode = new Map();
  for (const it of items) {
    const key = (it.seasonNumber != null || it.episodeNumber != null)
      ? `${it.seasonNumber ?? '?'}|${it.episodeNumber ?? '?'}`
      : `id:${it.episodeId}`;
    const existing = byEpisode.get(key);
    if (!existing) { byEpisode.set(key, it); continue; }
    const itTime = parseDate(it.lastWatchedAt) ?? 0;
    const exTime = parseDate(existing.lastWatchedAt) ?? 0;
    if (it.fullyWatched && !existing.fullyWatched) byEpisode.set(key, it);
    else if ((!!it.fullyWatched === !!existing.fullyWatched) && itTime > exTime) byEpisode.set(key, it);
  }
  const uniqueItems = [...byEpisode.values()];

  // Find the episode the user reached furthest into (highest episode_number
  // that was at least started). Useful for "dropped at ep 3" framing.
  const sortedByEp = uniqueItems.slice().sort((a, b) =>
    (a.seasonNumber ?? 1) - (b.seasonNumber ?? 1)
    || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
  const lastReached = sortedByEp[sortedByEp.length - 1];
  const lastEpFullyWatched = !!lastReached?.fullyWatched;

  const epsWatched = uniqueItems.length;   // distinct-episode count
  const totalPlays = items.length;         // raw row count (rewatches + variants)
  const completionRatio = episodesTotal && episodesTotal > 0
    ? Math.min(1, epsWatched / episodesTotal)
    : null;

  const label = lastPlayedMs == null
    ? 'unknown'
    : classify(completionRatio, lastPlayedMs, now, epsWatched, totalPlays, episodesTotal, lastEpFullyWatched);

  // Rewatch detection: are there plays clustered far after the bulk of
  // viewing? If max - median > 90 days, the recent peak is a rewatch.
  let rewatchedEpisodes = [];
  let rewatchPeakMs = null;
  if (lastPlayedMs != null && medianMs != null && (lastPlayedMs - medianMs) > REWATCH_GAP_MS) {
    rewatchPeakMs = lastPlayedMs;
    // An episode is a "rewatch favorite" if its lastPlayedAt is within
    // 30 days of the peak AND meaningfully later than the median (so
    // we don't flag the original first-watch tail as a rewatch).
    rewatchedEpisodes = items
      .map(it => ({ it, t: parseDate(it.lastWatchedAt) }))
      .filter(({ t }) => t != null
        && (rewatchPeakMs - t) < REWATCH_CLUSTER_MS
        && (t - medianMs) > REWATCH_GAP_MS / 2)
      .map(({ it, t }) => ({
        episodeId: it.episodeId,
        seasonNumber: it.seasonNumber,
        episodeNumber: it.episodeNumber,
        episodeTitle: it.episodeTitle,
        lastWatchedAt: it.lastWatchedAt,
        gapFromMedianDays: Math.round((t - medianMs) / (1000 * 60 * 60 * 24)),
      }))
      .sort((a, b) => (a.seasonNumber ?? 1) - (b.seasonNumber ?? 1)
        || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
  }

  // Cross-audio rewatch detection: did the rewatched episodes show up
  // in a *different* audio track than the user's earlier plays of the
  // same episode? Rewatching MHA E1 in dub after first watching it in
  // sub is a stronger commitment than replaying the same audio — the
  // user reinvested attention deliberately. Boosts the engine's
  // rewatch signal slightly above same-audio replay.
  //
  // Detection: for each rewatched-episode key, scan the raw items for
  // any prior play of the same episode in a different audio track.
  // Sub vs dub flags arrive on each item; we treat null/null as
  // "unknown audio" and skip those — only fire on confirmed cross-track.
  let crossAudioRewatch = false;
  if (rewatchedEpisodes.length > 0) {
    const epKey = (it) =>
      (it.seasonNumber != null || it.episodeNumber != null)
        ? `${it.seasonNumber ?? '?'}|${it.episodeNumber ?? '?'}`
        : `id:${it.episodeId}`;
    const audiosByKey = new Map();
    for (const it of items) {
      const k = epKey(it);
      if (!audiosByKey.has(k)) audiosByKey.set(k, new Set());
      if (it.isDubbed === true) audiosByKey.get(k).add('dub');
      else if (it.isSubbed === true) audiosByKey.get(k).add('sub');
    }
    for (const rew of rewatchedEpisodes) {
      const audios = audiosByKey.get(epKey(rew));
      if (audios && audios.has('dub') && audios.has('sub')) {
        crossAudioRewatch = true;
        break;
      }
    }
  }

  // Engagement-granularity fields. Computed alongside the existing
  // label so consumers (series-sentiment, future surfaces) can read
  // pacing without recomputing from raw timestamps. Whether each is
  // populated depends on the watch shape — see helper docstrings.
  const isRewatched = rewatchedEpisodes.length > 0;
  const engagementShape = deriveEngagementShape(playTimes, epsWatched);
  const dropVelocity = deriveDropVelocity(playTimes, epsWatched);
  const peakEpisode = derivePeakEpisode(items, isRewatched);
  // dropPoint: where the user disengaged. Differs from droppedAtEp
  // (highest-reached) in being scoped to non-completed/non-active
  // labels — completed shows have no drop point.
  const NON_DISENGAGED_LABELS = new Set(['completed', 'in-progress', 'unknown']);
  const dropPoint = NON_DISENGAGED_LABELS.has(label)
    ? null
    : (lastReached?.episodeNumber ?? null);

  return {
    label,
    epsWatched,
    totalPlays,
    epsTotal: episodesTotal ?? null,
    completionRatio,
    lastPlayedAt: lastPlayedMs ? new Date(lastPlayedMs).toISOString() : null,
    monthsSinceLastPlay: lastPlayedMs ? Math.round((now - lastPlayedMs) / ONE_MONTH_MS) : null,
    droppedAtEp: lastReached?.episodeNumber ?? null,
    droppedMidEpisode: lastReached && !lastReached.fullyWatched
      && lastReached.playhead != null && lastReached.durationMs
      ? Math.round((lastReached.playhead * 1000 / lastReached.durationMs) * 100)
      : null, // percent into the final episode they reached, if mid-bail
    isRewatched,
    crossAudioRewatch,
    rewatchedEpisodes,
    // Engagement granularity — feed into series-sentiment Step B.
    engagementShape,
    dropVelocity,
    dropPoint,
    peakEpisode,
  };
}

// Public — derive shapes for every series in `items`.
// `episodeCounts` (if provided) supplies franchise-level episode totals
// keyed by seriesId; caller decides which source (CR's cms/objects,
// AniList, etc.) to trust. Callers that still pass the AniList cache
// directly get graceful degradation — missing keys just yield a null
// completion ratio.
export function deriveWatchShapes(items, episodeCounts = {}, now = Date.now()) {
  const grouped = groupBySeries(items);
  const series = {};
  const summary = {
    total: 0,
    completed: 0,
    inProgress: 0,
    paused: 0,
    droppedEarly: 0,
    droppedMid: 0,
    sampled: 0,
    unknown: 0,
    seriesWithRewatches: 0,
    rewatchedEpisodeCount: 0,
  };

  for (const [seriesId, group] of grouped) {
    const raw = episodeCounts[seriesId];
    // Accept either `{episodes: N}` (legacy AniList-cache shape) or a plain
    // number, so callers can pass either map without adapting.
    const epsTotal = typeof raw === 'number' ? raw
      : typeof raw?.episodes === 'number' ? raw.episodes
      : null;
    const shape = deriveSeriesShape(group, epsTotal, now);
    series[seriesId] = shape;
    summary.total++;
    const labelKey = shape.label.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (labelKey in summary) summary[labelKey]++;
    if (shape.isRewatched) {
      summary.seriesWithRewatches++;
      summary.rewatchedEpisodeCount += shape.rewatchedEpisodes.length;
    }
  }

  return { computedAt: now, series, summary };
}

// Surface raw fields present in API items that the projector throws away.
// Helps us notice when CR adds (or we'd been missing) a useful signal —
// e.g. play_count, watch_count, viewed_at[]. Pass one raw item.
const PROJECTED_KEYS = new Set([
  // panel-level
  'id', 'title', 'parent_id', 'parent_title', 'parent_slug',
  'parentId', 'parentTitle', 'parentSlug',
  'duration_ms', 'durationMs',
  // episode_metadata-level (handled via nested check)
  'episode_metadata', 'episodeMetadata',
  // raw-level
  'panel', 'playhead', 'fully_watched', 'fullyWatched',
  'never_watched', 'neverWatched',
  'date_played', 'datePlayed', 'last_played', 'lastPlayed',
]);
const PROJECTED_META_KEYS = new Set([
  'series_id', 'seriesId', 'series_title', 'seriesTitle',
  'series_slug_title', 'seriesSlugTitle',
  'episode_number', 'episodeNumber', 'episode',
  'season_number', 'seasonNumber', 'season_display_number',
  'season_id', 'seasonId', 'season_title', 'seasonTitle',
  'episode_air_date', 'episodeAirDate',
  'is_dubbed', 'isDubbed', 'is_subbed', 'isSubbed',
  'duration_ms', 'durationMs',
]);

export function unprojectedFields(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return [];
  const unused = [];
  for (const k of Object.keys(rawItem)) {
    if (!PROJECTED_KEYS.has(k)) unused.push(`raw.${k}`);
  }
  const panel = rawItem.panel || rawItem;
  if (panel && typeof panel === 'object' && panel !== rawItem) {
    for (const k of Object.keys(panel)) {
      if (!PROJECTED_KEYS.has(k)) unused.push(`panel.${k}`);
    }
  }
  const meta = panel?.episode_metadata || panel?.episodeMetadata;
  if (meta && typeof meta === 'object') {
    for (const k of Object.keys(meta)) {
      if (!PROJECTED_META_KEYS.has(k)) unused.push(`meta.${k}`);
    }
  }
  return unused;
}
