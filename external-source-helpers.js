// Canonical source list + iteration helpers for the externalScores
// per-AL-ID per-source map.
//
// Pre-this-module, five call sites (taste-pipeline's
// synthesizeExternalShapes, background's explicit-ratings collector,
// computeExternalImportStats, series-sentiment's
// externalScoreContribution + hasExternalSignal) all had their own
// hardcoded `['anilist', 'mal']` allowlist. When the freeform-notes
// import landed, all five silently dropped freeform contributions —
// the data was being written to storage but completely invisible to
// the engine downstream.
//
// Consolidating the source list here means "add a new source" becomes
// one constant edit + a write-path addition. Future Kitsu / Trakt /
// Letterboxd imports won't need a hunt across the codebase.
//
// Order matters for pickDominantSource:
//   1. 'anilist' — user-linked AniList account, canonical
//   2. 'mal'     — user-linked MAL account (API or XML import)
//   3. 'freeform' — user-typed notes matched to AL IDs at variable
//                   title→ID confidence
//
// Within each tier, presence wins. Confidence-based disambiguation
// (per Q8 of the 2026-05-18 grill) is a future refinement; for v1
// the precedence list captures the "AL/MAL are authoritative when
// present" intuition.

export const EXTERNAL_SOURCES = Object.freeze(['anilist', 'mal', 'freeform']);

// Pick the dominant per-source entry for a Series. Returns the entry
// itself (the inner record carrying score/status/etc.) — caller treats
// it as opaque. null when no source is populated.
//
// Generalizes the old `sources?.anilist || sources?.mal` pattern to
// include freeform AND any future source added to EXTERNAL_SOURCES.
export function pickDominantSource(sources) {
  if (!sources || typeof sources !== 'object') return null;
  for (const name of EXTERNAL_SOURCES) {
    if (sources[name]) return sources[name];
  }
  return null;
}

// Iterate every present source for an entry in canonical order.
// Used by aggregation consumers (externalScoreContribution sums all,
// hasExternalSignal checks for any).
//
// Yields { source, entry } pairs so consumers can both read the data
// AND know which source it came from (for audit / debug / future
// per-source weighting).
export function* iterExternalSources(sources) {
  if (!sources || typeof sources !== 'object') return;
  for (const name of EXTERNAL_SOURCES) {
    const entry = sources[name];
    if (entry) yield { source: name, entry };
  }
}

// Count how many sources are present for an entry. Useful for
// confidence-boost heuristics (more sources = more reliable signal).
export function countSources(sources) {
  if (!sources || typeof sources !== 'object') return 0;
  let n = 0;
  for (const name of EXTERNAL_SOURCES) {
    if (sources[name]) n++;
  }
  return n;
}
