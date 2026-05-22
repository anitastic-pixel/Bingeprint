// MAL XML export parsing — pure helpers, no provider-gateway dependency.
//
// Split out of mal.js so the import-mal-xml page can import the parser
// without dragging the API client + provider-gateway registration into
// the page's module graph. mal.js itself imports * from
// provider-gateway and calls gateway.registerProvider('mal', ...) at
// module top level — useful in the SW (where actual HTTP requests
// happen) but pointless in an extension page that only ever parses a
// file the user dropped.
//
// Status mapping mirrors MAL_STATUS_NORMALIZE in mal.js (the API path)
// but with the XML-export status casing ("Watching" / "On-Hold" /
// "Plan to Watch" vs API's "watching" / "on_hold" / "plan_to_watch").
// Both paths produce the same downstream Sentiment vocabulary; the
// importer doesn't need to know which path created an entry.

const MAL_XML_STATUS_NORMALIZE = {
  'Watching':       'watching',
  'Completed':      'completed',
  'On-Hold':        'paused',
  'Dropped':        'dropped',
  'Plan to Watch':  'planning',
};

// Parse a MAL XML list export — the file produced by Profile → List →
// Export → Anime on MyAnimeList.
//
// Format (legacy XML; MAL still emits this even though the API has
// moved on to JSON):
//   <myanimelist>
//     <myinfo>...</myinfo>
//     <anime>
//       <series_animedb_id>21</series_animedb_id>
//       <my_score>9</my_score>
//       <my_status>Watching</my_status>
//       <my_watched_episodes>1116</my_watched_episodes>
//       <my_finish_date>0000-00-00</my_finish_date>
//       ...
//     </anime>
//     ...
//   </myanimelist>
//
// Returns { [malId]: { score, status, progress, updatedAt, _source: 'xml' } }.
//   - score: null when XML has 0/empty (MAL stores 0 for unscored)
//   - status: normalized to Sentiment vocabulary; null on unrecognized value
//   - progress: episode count from my_watched_episodes; null when 0/unset
//   - updatedAt: my_finish_date when present and valid, else my_start_date,
//     else null. MAL XML uses "0000-00-00" for unset dates — treated as
//     null. Less precise than the API's updated_at, but it's all the
//     export carries.
//   - _source: 'xml' so downstream code can tell apart API vs XML entries
//     if it ever needs to (e.g. confidence weighting). API path doesn't
//     stamp this field.
export function parseMalXmlExport(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.length) {
    throw new Error('parseMalXmlExport: empty or non-string input');
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  // DOMParser returns a <parsererror> element on malformed XML rather
  // than throwing. Detect and surface a clear error.
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error(`parseMalXmlExport: malformed XML — ${parseErr.textContent?.slice(0, 200) || 'unknown parser error'}`);
  }
  const root = doc.querySelector('myanimelist');
  if (!root) {
    throw new Error('parseMalXmlExport: no <myanimelist> root — not a MAL anime list export?');
  }
  const animeEls = doc.querySelectorAll('myanimelist > anime');
  const out = {};
  let skipped = 0;
  for (const el of animeEls) {
    const idText = el.querySelector('series_animedb_id')?.textContent?.trim();
    const malId = idText ? parseInt(idText, 10) : NaN;
    if (!Number.isInteger(malId) || malId <= 0) {
      skipped++;
      continue;
    }
    const scoreText = el.querySelector('my_score')?.textContent?.trim();
    const scoreNum = scoreText ? parseInt(scoreText, 10) : 0;
    const score = Number.isInteger(scoreNum) && scoreNum > 0 ? scoreNum : null;

    const statusText = el.querySelector('my_status')?.textContent?.trim();
    const status = statusText ? (MAL_XML_STATUS_NORMALIZE[statusText] || null) : null;

    const progressText = el.querySelector('my_watched_episodes')?.textContent?.trim();
    const progressNum = progressText ? parseInt(progressText, 10) : 0;
    const progress = Number.isInteger(progressNum) && progressNum > 0 ? progressNum : null;

    const finish = el.querySelector('my_finish_date')?.textContent?.trim();
    const start = el.querySelector('my_start_date')?.textContent?.trim();
    const updatedAt = (finish && finish !== '0000-00-00')
      ? finish
      : (start && start !== '0000-00-00' ? start : null);

    out[malId] = { score, status, progress, updatedAt, _source: 'xml' };
  }
  if (skipped > 0) {
    console.warn(`[mal-xml] parseMalXmlExport: skipped ${skipped} <anime> entries with invalid series_animedb_id`);
  }
  return out;
}

// Best-effort decompression for the .xml.gz file MAL actually serves.
// Most users extract before importing, but accepting .gz directly is
// a meaningful UX win. Returns a UTF-8 string. Requires Chrome's
// DecompressionStream (shipped since Chrome 80; well within the MV3
// baseline).
export async function decompressMalGzip(arrayBuffer) {
  if (!('DecompressionStream' in globalThis)) {
    throw new Error('decompressMalGzip: DecompressionStream not available in this environment');
  }
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8').decode(buf);
}
