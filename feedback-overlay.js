// Feedback-overlay seam — abstracts the "user feedback that adjusts
// scoring" concept so rank-recommendations doesn't need to know
// which feedback channels exist.
//
// Pre-this-module: rank-recommendations accepted both
// options.overlay (a {[tag]: delta} from computeReactionOverlay)
// and options.dealbreakerTags (a string[] from surfaceSettings)
// and applied them inline. Reactions and dealbreakers each lived
// at the call site as their own option fields. Adding a new
// feedback type (mood-driven boost, time-of-day adjustment,
// "boost shows like the one I just finished") meant another
// option field and another inline application.
//
// This module exposes a small interface — adapters that produce
// overlays or filter functions — and a composer that runs them
// all. rank-recommendations consumes a single context and stops
// caring about what the channels are.
//
// Adapter shape:
//   {
//     id: string,                                        // for diag
//     computeOverlay?(ctx) → {[tag]: delta},             // optional
//     filterMedia?(media, ctx) → boolean,                // optional
//   }
//
// Caller composes adapters with composeFeedback([...]) and gets
// back a unified surface.

// ── Built-in adapter: reaction overlay ─────────────────────────
// Wraps an externally-computed reaction overlay (the {[tag]: delta}
// from reactions.js). The compute itself stays in reactions.js
// because the worker has already done the two-pass dance to derive
// it; this adapter just wears the standard interface.
export function reactionOverlayAdapter(overlay) {
  return {
    id: 'reactions',
    computeOverlay: () => overlay || {},
  };
}

// ── Built-in adapter: dealbreaker filter ───────────────────────
// Excludes media where any dealbreaker tag appears at rank ≥ 50
// (centrally present, not background flavor) or as a genre. The
// centrality threshold matches what the previous inline path used.
const DEALBREAKER_CENTRALITY = 50;
export function dealbreakerFilterAdapter(dealbreakerTags) {
  if (!dealbreakerTags || dealbreakerTags.length === 0) {
    return { id: 'dealbreakers', filterMedia: () => true };
  }
  const blockSet = new Set(dealbreakerTags);
  return {
    id: 'dealbreakers',
    filterMedia: (media) => {
      for (const tag of media.tags || []) {
        if (!tag?.name) continue;
        if ((tag.rank || 0) >= DEALBREAKER_CENTRALITY && blockSet.has(tag.name)) return false;
      }
      for (const g of media.genres || []) {
        if (blockSet.has(g)) return false;
      }
      return true;
    },
  };
}

// ── Composer ──────────────────────────────────────────────────
// Combines multiple adapters into one feedback surface:
//
//   const fb = composeFeedback([
//     reactionOverlayAdapter(overlay),
//     dealbreakerFilterAdapter(dealbreakerTags),
//   ]);
//
//   const taste = fb.applyToTasteVector(baseTaste);
//   if (!fb.acceptsMedia(media)) skip();
//
// applyToTasteVector folds every adapter's overlay into a single
// {[tag]: combined} delta, then adds it to tasteVector.raw. Order
// shouldn't matter for additive deltas, but adapters are processed
// in array order so a future non-additive overlay (e.g.,
// multiplicative) could be composed deterministically.
//
// acceptsMedia ANDs every adapter's filterMedia (default true if
// not provided), so adding a new filter never accidentally widens
// the pool.
export function composeFeedback(adapters = []) {
  const list = adapters.filter(Boolean);
  return {
    adapters: list,
    applyToTasteVector(tasteVector) {
      const combined = {};
      for (const a of list) {
        if (typeof a.computeOverlay !== 'function') continue;
        const overlay = a.computeOverlay() || {};
        for (const [tag, delta] of Object.entries(overlay)) {
          combined[tag] = (combined[tag] || 0) + delta;
        }
      }
      if (Object.keys(combined).length === 0) return tasteVector;
      const raw = { ...(tasteVector?.raw || {}) };
      for (const [tag, d] of Object.entries(combined)) {
        raw[tag] = (raw[tag] || 0) + d;
      }
      return { ...tasteVector, raw };
    },
    acceptsMedia(media) {
      for (const a of list) {
        if (typeof a.filterMedia !== 'function') continue;
        if (!a.filterMedia(media)) return false;
      }
      return true;
    },
  };
}
