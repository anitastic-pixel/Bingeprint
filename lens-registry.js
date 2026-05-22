// G13: rec-lens registry. Documents the contract that future
// recommendation lenses follow. Currently descriptive only —
// existing peak/comfort lenses are still hardcoded in
// background.js's persistDualModeRecommendations and in the side
// panel's mode-bar. Migration to this registry is deferred until
// the FIRST new lens ships (e.g., "From people you trust",
// "Currently airing"). At that point, callers will iterate this
// list instead of hardcoding peak/comfort, and the new lens
// plugs in via a single LENSES entry.
//
// WHY DESCRIPTIVE-FIRST: existing 2-lens code works. Refactoring
// without a third lens to test the API is premature abstraction
// — we'd be designing the registry's contract against hypothetical
// needs. Better to commit to the SHAPE here so the next implementer
// can read what to add, then do the actual migration in the same
// PR that adds the new lens. See PRD-GAP-AUDIT G13 for the full
// reasoning.
//
// THE CONTRACT (each lens definition):
//
//   id            — stable identifier (kebab-case, used as storage key)
//   displayName   — friend-voice label shown in the UI tab
//   tasteVectorKey — which mode vector this lens scores against
//                    ('peak', 'comfort', or future 'all')
//   diversify     — whether the diversify-recs MMR pass applies
//                   (true for most lenses; false for concentration
//                    lenses like "From people you trust" where the
//                    point IS to show 5 MAPPA shows)
//   description   — one-line "why this lens exists" for the docs
//
// FUTURE EXPANSION fields (planned but not yet wired):
//
//   selectFn(state) → candidates  — per-lens candidate selection
//                                    (current peak/comfort use the
//                                     dual-mode rec pool; future lenses
//                                     might filter on currently-airing,
//                                     creator-affinity, etc.)
//   sortFn(candidates, state)     — per-lens sorting after diversification
//   minScore                       — floor below which the lens stops
//                                    surfacing recs (avoids weak picks)
//
// Add a new lens by appending an entry here AND adding the matching
// rec-pipeline branch (one-time migration from hardcoded peak/comfort).
// Per PRD-NORTH-STAR Q8 demand-pull rule: each new lens earns its way
// in by answering a specific "feels off" complaint the existing
// lenses can't fix.

export const LENSES = [
  {
    id: 'peak',
    displayName: 'Your Lane',
    tasteVectorKey: 'peak',
    diversify: true,
    description: 'Aligned with you when discerning — taste-vector match against peak-tier signals',
    source: 'rec-pool', // legacy dual-mode pipeline; uses rankRecommendations
  },
  {
    id: 'comfort',
    displayName: 'Easy Watch',
    tasteVectorKey: 'comfort',
    diversify: true,
    description: 'Brain-off picks — taste-vector match against comfort-tier signals',
    source: 'rec-pool',
  },
  {
    id: 'in-the-air',
    displayName: 'In the Air',
    tasteVectorKey: 'all',
    diversify: true,
    description: 'Currently-airing shows in your wheelhouse',
    source: 'all-shows-scored', // filter+sort over allShowsScored
  },
  {
    id: 'from-people-you-trust',
    displayName: 'People You Trust',
    tasteVectorKey: 'all',
    diversify: false, // concentration is the point
    description: 'Picks by studios/creators you have consistently loved',
    source: 'all-shows-scored',
  },
  {
    id: 'take-a-chance',
    displayName: 'Take a Chance',
    tasteVectorKey: 'all',
    diversify: true,
    // Wider diversify than the default 6 — stretch picks come from a
    // narrower candidate pool (STRETCH-band, outside top archetypes),
    // so adjacent picks tend to clump.
    diversifyDepth: 9,
    description: 'Stretch picks outside your usual lanes — earned bold choices',
    source: 'all-shows-scored',
  },
  {
    id: 'canon',
    displayName: "You've Missed",
    tasteVectorKey: 'all',
    diversify: true,
    description: "Foundational high-quality shows you haven't watched yet",
    source: 'all-shows-scored',
  },
  {
    id: 'try-again',
    displayName: 'Try Again',
    tasteVectorKey: 'all',
    diversify: true,
    description: 'Shows you dropped where current taste-fit suggests another shot',
    source: 'all-shows-scored',
    group: 'history',
  },
  {
    id: 'rewatched',
    displayName: 'Rewatched',
    tasteVectorKey: 'all',
    // Concentration is fine here — the user's rewatched canon is the
    // whole point of the lens. Diversification across a small set
    // (typically <30 shows) just shuffles obvious top entries away.
    diversify: false,
    description: "Shows you completed and came back to — your personal-history canon",
    source: 'all-shows-scored',
    group: 'history',
  },
];

// Helper: get a lens by id. Returns null when no match.
export function lensById(id) {
  return LENSES.find(l => l.id === id) || null;
}
