// Stated-preference override — pure, no chrome.* APIs.
//
// The seam where "I told you what I want" wins over "your history
// says otherwise" on the user's taste vector.
//
// Problem this solves:
//
// The taste vector aggregates behavioral signal (watched/dropped/
// rewatched shows) into per-tag mass. When a user's mass on a tag is
// already strong (the user's Ecchi at +17 from completing/rewatching
// quality ecchi shows), the user's intent in tapping that tag in the
// survey isn't "I want MORE ecchi" — it's "I want more of the GOOD
// ecchi I already loved." The all-vector blends peak-tier love with
// comfort-tier tolerance + drops, producing a single number that
// doesn't reflect the user's quality preference.
//
// Architecture decision (per /improve-codebase-architecture grill):
// the override targets the PEAK vector specifically. The all-vector
// and comfort-vector stay unchanged.
//
//   - Peak vector built from the user's avgScore≥75 contributors only
//   - Tap on Ecchi → peak vector's Ecchi mass floored at a meaningful
//     fraction of the user's TOP peak-tier mass
//   - Side panel rec pool peak bucket reflects the boost; on-page
//     cards (which use all-vector) stay unchanged
//
// User-facing implication: "tap on Ecchi" lifts peak-tier ecchi recs
// in the side panel. On-page cards on already-watched ecchi shows
// (Rosario+Vampire, DxD) don't visibly change — correct, the all-
// vector wasn't touched.
//
// Override magnitudes are CALIBRATED to the user's peak vector:
//   FLOOR_FRACTION × max(positive peak mass) for `loved` taps
//   CEILING_FRACTION × |min(negative peak mass)| for `disliked` taps
//
// Why scale to user's existing mass instead of a fixed magnitude:
// a fixed +8 was invisible against the user's +90 Fantasy / Action /
// Drama. To put Ecchi in the same arena ("secondary primary"), the
// floor needs to be a meaningful fraction of the user's top tag.
// 0.6 × max gives "competitive but not dominant."
//
// Deletion test: removing this module forces the override math to
// re-spread. The concentration is the seam's job.

export const FLOOR_FRACTION = 0.6;
export const CEILING_FRACTION = 0.6;

// Compute floor/ceiling magnitudes from a vector's mass extremes.
// Pure, no IO. Returns { floor, ceiling } in raw-mass units.
//
// Empty / thin vector → both bounds zero. Caller treats as "no
// override possible" (correct: user without peak signal can't
// express peak-tier preferences yet).
export function computeOverrideBounds(vector) {
  if (!vector?.raw) return { floor: 0, ceiling: 0 };
  let maxPos = 0;
  let maxNeg = 0;  // absolute magnitude of the most-negative weight
  for (const w of Object.values(vector.raw)) {
    if (typeof w !== 'number') continue;
    if (w > maxPos) maxPos = w;
    if (w < 0 && -w > maxNeg) maxNeg = -w;
  }
  return {
    floor: +(FLOOR_FRACTION * maxPos).toFixed(3),
    ceiling: -+(CEILING_FRACTION * maxNeg).toFixed(3),
  };
}

// Apply the override to a fully-built taste vector. Returns a new
// vector object with adjusted `raw`, plus re-derived `top`/`bottom`/
// `contributions`/`summary` so downstream consumers see a fully
// consistent state.
//
// `tagShapes` is the { [tag]: { state, tappedAt } } map persisted at
// chrome.storage.local.surveyTagShapes.
//
// Bounds default to computeOverrideBounds(vector) — caller can pass
// `options.bounds` to use a different vector's bounds (e.g., when
// applying override to vectorAll using vectorPeak's bounds, which
// the architecture review didn't choose but the seam supports).
export function applyStatedPreferenceOverride(vector, tagShapes, options = {}) {
  if (!vector || !tagShapes) return vector;
  const tagEntries = Object.entries(tagShapes);
  if (tagEntries.length === 0) return vector;

  const bounds = options.bounds || computeOverrideBounds(vector);
  const { floor, ceiling } = bounds;

  // No bounds → no-op (empty / thin vector). Override returns the
  // vector unchanged but emits a diag entry per tap so the caller's
  // surface can voice "your peak vector is too thin to override."
  const overrideDiag = {};
  if (floor === 0 && ceiling === 0) {
    for (const [tag, shape] of tagEntries) {
      if (!tag || !shape || (shape.state !== 'loved' && shape.state !== 'disliked')) continue;
      overrideDiag[tag] = {
        state: shape.state,
        before: vector.raw?.[tag] || 0,
        after: vector.raw?.[tag] || 0,
        fired: false,
        reason: 'thin-vector',
      };
    }
    return { ...vector, overrideDiag, overrideBounds: bounds };
  }

  // Clone raw so we don't mutate the caller's object. contributions
  // is appended-to (we add StatedOverride entries alongside existing
  // behavioral contributions, not replace).
  const raw = { ...(vector.raw || {}) };
  const contributions = { ...(vector.contributions || {}) };

  for (const [tag, shape] of tagEntries) {
    if (!tag || !shape) continue;
    const state = shape.state;
    if (state !== 'loved' && state !== 'disliked') continue;

    const before = raw[tag] || 0;
    let after;
    if (state === 'loved') {
      after = Math.max(before, floor);
    } else {
      after = Math.min(before, ceiling);
    }

    if (after === before) {
      overrideDiag[tag] = { state, before, after, fired: false, reason: 'behavior-stronger' };
      continue;
    }

    raw[tag] = after;
    overrideDiag[tag] = { state, before, after, fired: true };
    (contributions[tag] ||= []).push({
      seriesId: null,
      seriesTitle: null,
      weight: after - before,
      category: 'StatedOverride',
      state,
    });
  }

  // Re-derive top/bottom from the adjusted raw so consumers reading
  // those slices see consistent state.
  const top = Object.entries(raw)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([tag, weight]) => ({ tag, weight: +weight.toFixed(3) }));
  const bottom = Object.entries(raw)
    .filter(([, w]) => w < 0)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 20)
    .map(([tag, weight]) => ({ tag, weight: +weight.toFixed(3) }));

  const summary = {
    ...(vector.summary || {}),
    uniqueTags: Object.keys(raw).length,
  };

  return {
    ...vector,
    raw,
    top,
    bottom,
    contributions,
    summary,
    overrideDiag,
    overrideBounds: bounds,
  };
}
