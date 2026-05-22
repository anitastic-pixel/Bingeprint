// G03: rec-list diversification (Maximum Marginal Relevance-style).
//
// Problem: a user with a sharp peak vector (e.g., heavy Battle Seinen)
// gets a side panel where the first 5 picks are all near-duplicates of
// each other — same archetype, same vibe, same energy. Mathematically
// honest (those ARE the top-N) but friend-metaphor wrong: a real anime
// friend recommending picks would mix the variety in. Same energy as
// "look, you've already seen FMA — try something different even if
// it's a slightly weaker match."
//
// Solution per PRD-SCORING-PHILOSOPHY §List construction: after
// rankRecommendations produces the score-sorted list, apply a
// diversification penalty to near-duplicate picks. Penalty decays
// across the list (strong on first 3-ish picks; zero past pick 5).
// Per-lens opt-out via opts.diversify=false.
//
// The score itself is never modified. Only display order changes.
// Each rec keeps its calibrated finalScore; downstream surfaces
// show that score regardless of rank position.

const SIMILARITY_THRESHOLD = 0.70;

// Penalty decay per pick index. Index 0 is the top pick (no penalty;
// the friend's strongest verdict gets to lead). Index 1-4 face strong
// then waning diversification pressure. Index 5+ is unpressured —
// past that point, the user has seen variety and we let the strongest
// remaining hits surface naturally.
const PENALTY_DECAY = [0, 1.0, 0.6, 0.3, 0.1, 0];

// How many picks to apply diversification to. Past this, original
// score order is preserved.
const DIVERSIFY_DEPTH = 6;

// Build a rank-weighted tag vector from a rec's topTags. Each tag's
// rank (0-100, AniList's "fit-strength" indicator) becomes the
// vector dimension. Show with identical tag-rank profiles will have
// cosine similarity of 1.0; orthogonal tag sets have 0.
function buildTagVector(rec) {
  const v = {};
  const tags = rec?.topTags || [];
  for (const t of tags) {
    if (!t?.tag || typeof t.rank !== 'number') continue;
    v[t.tag] = t.rank / 100; // normalize to [0,1]
  }
  return v;
}

function cosineSimilarity(a, b) {
  let dot = 0, ma = 0, mb = 0;
  for (const k of Object.keys(a)) {
    const va = a[k];
    ma += va * va;
    if (k in b) dot += va * b[k];
  }
  for (const k of Object.keys(b)) {
    mb += b[k] * b[k];
  }
  if (ma === 0 || mb === 0) return 0;
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

// Greedy MMR-style reranking. Pick the highest-effective-score
// candidate at each position, where effective = rawScore - penalty.
// Modifies neither the input array nor the entry objects' finalScore;
// only returns a reordered list.
//
// Returns the input array reordered. Diversification penalties are
// attached as `_diversificationPenalty` on each entry for diagnostic
// visibility (not displayed; engine internal only).
export function diversifyRanked(ranked, opts = {}) {
  if (opts.diversify === false) return ranked;
  if (!Array.isArray(ranked) || ranked.length <= 1) return ranked;

  const depth = Math.min(ranked.length, opts.depth ?? DIVERSIFY_DEPTH);
  // Pre-compute tag vectors for the picks we'll consider — bounded
  // to depth+candidate-pool. Past that, we don't rerank, so no need.
  const candidatePool = Math.min(ranked.length, depth + 6);
  const vectors = new Map();
  for (let i = 0; i < candidatePool; i++) {
    vectors.set(ranked[i], buildTagVector(ranked[i]));
  }

  const selected = [];
  const remaining = ranked.slice(0, candidatePool);
  while (selected.length < depth && remaining.length > 0) {
    const idx = selected.length;
    const decay = PENALTY_DECAY[Math.min(idx, PENALTY_DECAY.length - 1)];
    let best = remaining[0];
    let bestEffective = best.finalScore || 0;
    let bestPenalty = 0;
    if (decay > 0 && selected.length > 0) {
      bestEffective = -Infinity;
      for (const cand of remaining) {
        const candVec = vectors.get(cand);
        let maxSim = 0;
        for (const sel of selected) {
          const sim = cosineSimilarity(candVec, vectors.get(sel));
          if (sim > maxSim) maxSim = sim;
        }
        const penalty = Math.max(0, maxSim - SIMILARITY_THRESHOLD) * decay;
        const effective = (cand.finalScore || 0) - penalty;
        if (effective > bestEffective) {
          bestEffective = effective;
          best = cand;
          bestPenalty = penalty;
        }
      }
    }
    if (bestPenalty > 0) best._diversificationPenalty = +bestPenalty.toFixed(3);
    selected.push(best);
    const rmIdx = remaining.indexOf(best);
    remaining.splice(rmIdx, 1);
  }
  // Append the rest (past the diversification depth) in original
  // score order. Past pick #6, raw rank is honest signal.
  return [...selected, ...remaining, ...ranked.slice(candidatePool)];
}
