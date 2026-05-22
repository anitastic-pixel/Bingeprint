// Recommendation candidate aggregation. Pure, no chrome.* APIs.
//
// Phase B1 (this module): aggregate AniList "fans-also-liked" rec data
// already in the cache into a ranked candidate list. Zero new API calls.
// Phase B2 (separate): batch-fetch full Media data for top candidates,
// score each via per-show-score, blend with averageScore + recRating
// for final ranking.
//
// Per candidate (AniList ID):
//
//   candidateScore = Σ over watched series that recommended it of:
//     perSeriesWeight × labelBoost × log(1 + recRating)
//
//   perSeriesWeight  — from tasteVector.perSeriesWeights (already
//                      reflects completion + label + rewatches)
//   labelBoost       — 1.0 completed/in-progress, 0.5 paused, 0.3
//                      dropped-mid, 0 dropped-early/sampled. Don't
//                      recommend based on shows you bounced off.
//   log(1 + recRating) — AniList's per-rec community vote count, log-
//                      scaled so a rec with 1000 votes doesn't dominate
//                      one with 100 by 10x — more like 3x.
//
// De-dupes against the user's watch history (any AniList ID we've
// already enriched is "watched", regardless of completion).

const LABEL_BOOST = {
  'completed':     1.0,
  'in-progress':   1.0,
  'paused':        0.5,
  'dropped-mid':   0.3,
  'dropped-early': 0,
  'sampled':       0,
  'unknown':       0,
};

export function aggregateRecommendations(watchShapes, aniListCache, tasteVector, options = {}) {
  const topN = options.topN ?? 100;
  const seriesShapes = watchShapes?.series || {};
  const perSeriesWeights = tasteVector?.perSeriesWeights || {};

  // Watched-AniList-ID set for dedup. Includes every enriched entry,
  // not just ones the user finished — we don't want to recommend a
  // show they sampled and bounced off either.
  const watchedAniListIds = new Set();
  for (const crId of Object.keys(seriesShapes)) {
    const al = aniListCache[crId];
    if (al?.aniListId) watchedAniListIds.add(al.aniListId);
  }
  // Franchise-sibling expansion: a CR series maps to ONE AL node, but
  // AniList recommends sibling franchise nodes by their own AL IDs.
  // Without expansion, "watched Mushoku Tensei S1 Cour 1 (108465)"
  // still lets Mushoku Tensei S1 Cour 2 (127720) or S2 (146065)
  // surface as if unwatched. Walk PREQUEL/PARENT/SEQUEL/SIDE_STORY
  // relations on every watched entry and fold sibling IDs into the
  // dedup set. The relations[] projection lives on aniListCache
  // entries (v3+ schema).
  for (const crId of Object.keys(seriesShapes)) {
    const al = aniListCache[crId];
    if (!al?.aniListId || !watchedAniListIds.has(al.aniListId)) continue;
    for (const rel of (al.relations || [])) {
      const sibId = rel?.node?.aniListId;
      if (!sibId) continue;
      const t = rel.type;
      if (t === 'PREQUEL' || t === 'PARENT' || t === 'SEQUEL' || t === 'SIDE_STORY') {
        watchedAniListIds.add(sibId);
      }
    }
  }

  const agg = {};
  let totalRecsConsidered = 0;
  let recsFromBoostedSources = 0;

  for (const [crId, shape] of Object.entries(seriesShapes)) {
    const labelBoost = LABEL_BOOST[shape.label] ?? 0;
    if (labelBoost === 0) continue;
    const al = aniListCache[crId];
    if (!al?.recommendations?.length) continue;
    const seriesWeight = perSeriesWeights[crId] ?? 0;
    if (seriesWeight === 0) continue;

    const sourceTitle = al.title?.english || al.title?.romaji || al.title?.native || null;

    for (const rec of al.recommendations) {
      totalRecsConsidered++;
      if (!rec.aniListId) continue;
      if (watchedAniListIds.has(rec.aniListId)) continue;
      const recRating = Math.max(rec.rating || 0, 0);
      const contrib = seriesWeight * labelBoost * Math.log(1 + recRating);
      if (contrib <= 0) continue;
      recsFromBoostedSources++;

      let entry = agg[rec.aniListId];
      if (!entry) {
        entry = agg[rec.aniListId] = {
          aniListId: rec.aniListId,
          title: rec.title,
          score: 0,
          sources: [],
        };
      }
      entry.score += contrib;
      entry.sources.push({
        crSeriesId: crId,
        title: sourceTitle,
        contribution: contrib,
        userWeight: seriesWeight,
        label: shape.label,
        recRating,
      });
    }
  }

  // Trim source lists to top 5 per candidate so the persisted blob
  // doesn't bloat — most candidates are recommended by 1-3 shows
  // anyway, but a few genre-defining titles can show up 20+ times.
  for (const id of Object.keys(agg)) {
    agg[id].sources.sort((a, b) => b.contribution - a.contribution);
    agg[id].sources = agg[id].sources.slice(0, 5).map(s => ({
      ...s,
      contribution: +s.contribution.toFixed(2),
      userWeight: +s.userWeight.toFixed(2),
    }));
    agg[id].score = +agg[id].score.toFixed(2);
  }

  const ranked = Object.values(agg).sort((a, b) => b.score - a.score);

  return {
    candidates: ranked.slice(0, topN),
    summary: {
      uniqueCandidates: ranked.length,
      totalRecsConsidered,
      recsFromBoostedSources,
      watchedDeduped: watchedAniListIds.size,
    },
  };
}
