// Smart Score chip composer. The single seam that owns "what chips
// render on the Smart Score card and in what order?" Wraps the
// multi-source composition (Phase B), Phase E multi-axis composites,
// burnout chip + its swallow rule, and the vibe row into one entry
// point so the render layer doesn't have to orchestrate four
// different chip producers.
//
// Architecturally: this module is a facade over phrase-engine.js +
// vibe-tags.js. They still own the math (composeChipsPhaseB,
// rankCandidates, composeMultiAxisChips, burnoutChipFor,
// composeVibeChips); this module owns the COORDINATION — which gets
// called, in what order, with what swallow rules between them.
//
// The render layer (content.js renderSignedRationale) should call
// composeChipRow(rec, ctx) and consume the structured result. Direct
// calls to engine.composeChipsPhaseB / engine.burnoutChipFor /
// vibeTags.composeVibeChips become composer-internal details.
//
// ChipRow contract (see phrase-engine.js for ChipSpec):
//
//   composeChipRow(rec, ctx) → {
//     positive: ChipSpec[],   // Phase B multi-source pool, ranked + capped
//     negative: ChipSpec[],   // anti-tags + burnout chip, swallow-resolved
//     vibe:     ChipSpec[],   // vibe-row composites + fallback (max 2)
//     skipIf:   string|null,  // "Skip if X is a dealbreaker." line
//   }
//
// ctx fields (all optional — composer gracefully degrades):
//   studioCreatorIndex   — studio/creator affinity map
//   tagBurnoutIndex      — { [tag]: { delta, sampleSize, ... } } burnout map
//   isUsefulTag          — function: tag → bool (filter out broad genres)
//   isBroadGenre         — function: tag → bool (broad genres excluded if
//                          excludeBroadGenres is set)
//   excludeBroadGenres   — bool, default true
//   floor                — minimum signed-tag weight floor
//   positiveBudget       — max positive chips, default 4
//   negativeBudget       — max negative chips, default 3
//   dealbreakerTags      — Set<tagName> for skip-if line composition
//   userLengthProfile    — { medianLovedEpisodes } for runtime-mismatch
//                          skip-if firing
//   effectiveEpisodes    — number, override rec.episodes for skip-if
//
// Why a facade and not a full rewrite? phrase-engine.js + vibe-tags.js
// already encapsulate their composer logic well; the friction was in
// the COORDINATION (burnout-swallow living in content.js, vibe row
// rendered on a parallel path with no shared seam, three separate
// content.js call sites for chip producers). A facade fixes that with
// minimal blast radius and zero behavioral change.

(() => {

function composeChipRow(rec, ctx = {}) {
  const engine = (typeof window !== 'undefined' && window.crsmartPhraseEngine) || null;
  const vibeTags = (typeof window !== 'undefined' && window.VIBE_TAGS) || null;
  if (!engine) {
    return { positive: [], negative: [], vibe: [], skipIf: null };
  }

  // 1. Positive row — Phase B multi-source pool (already ranked + capped).
  const positive = engine.composeChipsPhaseB
    ? engine.composeChipsPhaseB(rec, {
        studioCreatorIndex: ctx.studioCreatorIndex,
        isUsefulTag: ctx.isUsefulTag,
        isBroadGenre: ctx.isBroadGenre,
        excludeBroadGenres: ctx.excludeBroadGenres !== false,
        floor: ctx.floor,
        budget: ctx.positiveBudget || 4,
      })
    : [];

  // 2. Negative row — anti-tags + burnout chip with swallow rule.
  //    Burnout takes priority: when fired, it prepends to the row AND
  //    suppresses any plain-tag chip on the same underlying tag. The
  //    swallow used to live in content.js renderSignedRationale; lives
  //    here so the negative-row contract is self-contained.
  const negativeBudget = ctx.negativeBudget || 3;
  let negative = collectNegativeChips(rec, ctx, engine);
  const burnoutChip = engine.burnoutChipFor
    ? engine.burnoutChipFor(rec, { tagBurnoutIndex: ctx.tagBurnoutIndex })
    : null;
  if (burnoutChip) {
    const burnoutTagLower = String(burnoutChip.tag || '').toLowerCase();
    negative = negative.filter(t =>
      String(t.tag || '').toLowerCase() !== burnoutTagLower
    );
    negative = [burnoutChip, ...negative].slice(0, negativeBudget);
  } else {
    negative = negative.slice(0, negativeBudget);
  }

  // 3. Vibe row — descriptive tonal-mood band (max 2 chips, axis-aware).
  const vibe = vibeTags && vibeTags.composeVibeChips
    ? vibeTags.composeVibeChips(rec)
    : [];

  // 4. Skip-if line — single sentence (or null). Only composed when
  //    the caller supplies dealbreakerTags + length profile. Today
  //    content.js composes skip-if separately (different call site
  //    for verdict-column rendering); composer exposes it for
  //    completeness so a future single-call refactor can collapse the
  //    two paths.
  const skipIf = engine.composeSkipIf && ctx.dealbreakerTags
    ? engine.composeSkipIf(rec, ctx.dealbreakerTags, {
        userLengthProfile: ctx.userLengthProfile,
        effectiveEpisodes: ctx.effectiveEpisodes,
      })
    : null;

  return { positive, negative, vibe, skipIf };
}

// Wraps the legacy pickSignedTags path so the composer doesn't depend
// on it being a content.js-scoped function. content.js still hosts the
// actual pickSignedTags (it depends on STATE for tag-filtering knobs);
// composer just gets a callback via ctx.collectNegativeChips when one
// is provided. When absent (or the engine lacks the entry), returns
// an empty list — the burnout chip alone still surfaces.
function collectNegativeChips(rec, ctx, engine) {
  if (typeof ctx.collectNegatives === 'function') {
    return ctx.collectNegatives(rec) || [];
  }
  // Fallback: try the engine's selectChips with negative polarity.
  if (engine.selectChips) {
    return engine.selectChips(rec?.topAntiTags || [], 'negative', {
      excludeBroadGenres: ctx.excludeBroadGenres !== false,
      isUsefulTag: ctx.isUsefulTag,
      isBroadGenre: ctx.isBroadGenre,
      floor: ctx.floor,
    });
  }
  return [];
}

if (typeof window !== 'undefined') {
  window.crsmartChipComposer = { composeChipRow };
}
if (typeof globalThis !== 'undefined') {
  globalThis.crsmartChipComposer = window?.crsmartChipComposer || { composeChipRow };
}

})();
