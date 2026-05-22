// Freeform-notes import — front-end controller.
//
// Stage flow:
//   pick → preview → review → working → done | error
//
// Why local in-page parsing + matching:
//   - Parser is pure JS (no chrome.*) and is intentionally kept on the
//     page-side so the user can iterate on the confirmation step
//     without a SW round-trip per keystroke.
//   - Matcher reads aniListCache + aniListBridgeCache from
//     chrome.storage.local — both are extension-pages-readable. The
//     index is built in-page; matching is pure once the index exists.
//   - The page POSTs only the FINAL resolved entry list to the SW (via
//     chrome.runtime.sendMessage) — that's the trigger for the
//     enrich+flush stages downstream.
//
// v1 caveat — AL Search fallback is deferred:
//   The matcher's resolveFreeformList supports a searchFn for the
//   "miss locally → search AL" path. The page-side controller passes
//   searchFn=null in v1, so deep-cuts that aren't in the local cache
//   land in the unmatched pile. Per the BRAINSTORM entry, this is
//   acceptable for v1; phase 2 adds a background bridge for the
//   AL search call.

import { sniffFreeformInput, parseFreeformInput } from './freeform-parser.js';
import { buildTitleIndex, resolveFreeformList } from './freeform-matcher.js';
import { createBatchedSearchAdapter } from './freeform-search-adapter.js';
import { subscribeImportState } from './import-state-channel.js';
import { STORAGE_KEYS } from './storage-schema.js';

// ── Limits (per 2026-05-18 tuning recommendations) ───────────────
const MAX_BYTES_HARD = 1 * 1024 * 1024;       // 1 MB
const MAX_BYTES_SOFT = 256 * 1024;            // 256 KB
const MAX_LINES_HARD = 5000;
const MAX_LINES_SOFT = 1000;

// ── DOM refs ─────────────────────────────────────────────────────
const stageEls = {
  pick:      document.querySelector('[data-stage="pick"]'),
  preview:   document.querySelector('[data-stage="preview"]'),
  analyzing: document.querySelector('[data-stage="analyzing"]'),
  review:    document.querySelector('[data-stage="review"]'),
  working:   document.querySelector('[data-stage="working"]'),
  done:      document.querySelector('[data-stage="done"]'),
  error:     document.querySelector('[data-stage="error"]'),
};

const ui = {
  pasteArea:        document.getElementById('paste-area'),
  dropzone:         document.getElementById('dropzone'),
  fileInput:        document.getElementById('file-input'),
  pickStatus:       document.getElementById('pick-status'),
  continueBtn:      document.getElementById('continue-btn'),

  previewStats:     document.getElementById('preview-stats'),
  scoreScaleSelect: document.getElementById('score-scale-select'),
  useHeaderState:   document.getElementById('use-header-state'),
  useHeaderFav:     document.getElementById('use-header-favorite'),
  previewBackBtn:   document.getElementById('preview-back-btn'),
  parseBtn:         document.getElementById('parse-btn'),

  analyzingStatus:  document.getElementById('analyzing-status'),
  analyzingSub:     document.getElementById('analyzing-substatus'),
  analyzingCancel:  document.getElementById('analyzing-cancel-btn'),

  reviewSummary:    document.getElementById('review-summary'),
  lowConfPile:      document.getElementById('low-confidence-pile'),
  lowConfRows:      document.getElementById('low-conf-rows'),
  lowConfCount:     document.getElementById('low-conf-count'),
  unmatchedPile:    document.getElementById('unmatched-pile'),
  unmatchedRows:    document.getElementById('unmatched-rows'),
  unmatchedCount:   document.getElementById('unmatched-count'),
  reviewBackBtn:    document.getElementById('review-back-btn'),
  applyBtn:         document.getElementById('apply-btn'),

  workingStatus:    document.getElementById('working-status'),
  workingSub:       document.getElementById('working-substatus'),

  doneSummary:      document.getElementById('done-summary'),
  closeBtn:         document.getElementById('close-tab-btn'),

  errorMessage:     document.getElementById('error-message'),
  retryBtn:         document.getElementById('error-retry-btn'),
};

// ── Page-side SW message bridge for the batched-search adapter ────
//
// The createBatchedSearchAdapter (freeform-search-adapter.js) takes
// a sendBatch function as DI. This wires it to the SW's batched
// search handler. Pure-JS-with-DI shape means the adapter itself
// stays Node-testable; the chrome.runtime.sendMessage call lives
// here, in the browser-bound file where it belongs.
//
// Math for a 50-miss import:
//   - Per-title: 50 × 800ms gateway pacing ≈ 40s wall-clock
//   - Batched: 5 × 1300ms (gateway + AL latency) ≈ 6.5s
async function sendBatchedSearch(titles) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'crsmart:external:freeform-al-search-batched',
      titles,
    });
    return (response?.ok && response.results) || {};
  } catch {
    // SW unreachable / extension context invalidated. Empty map → the
    // adapter resolves all queued titles to []. The matcher routes
    // them to unmatched.
    return {};
  }
}

// ── Module-level state (single-flight; reload to start over) ─────
const state = {
  rawText: '',
  sniffReport: null,
  parsedRows: null,           // ParsedRow[] from parseFreeformInput
  matchResult: null,          // { matched, lowConfidence, unmatched } from resolveFreeformList
  userPicks: new Map(),       // lineNumber → { aniListId, candidate } | { skip: true }
  analyzingAbort: null,       // AbortController for the resolveFreeformList run
};

// ── Stage helpers ────────────────────────────────────────────────
function showStage(name) {
  for (const [k, el] of Object.entries(stageEls)) {
    if (el) el.classList.toggle('hidden', k !== name);
  }
}

function setPickStatus(text, isError = false) {
  ui.pickStatus.textContent = text || '';
  ui.pickStatus.classList.toggle('is-error', !!isError);
}

// ── Stage 1: pick ────────────────────────────────────────────────
function checkPickValid() {
  const text = ui.pasteArea.value;
  ui.continueBtn.disabled = !text || text.trim().length === 0;
}

function validateInputSize(text, sourceLabel = 'pasted text') {
  const bytes = new Blob([text]).size;
  if (bytes > MAX_BYTES_HARD) {
    return { ok: false, message: `${sourceLabel} is too large (${(bytes / 1024 / 1024).toFixed(2)} MB). Hard cap is 1 MB — split your list into chunks and import them one at a time.` };
  }
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > MAX_LINES_HARD) {
    return { ok: false, message: `${sourceLabel} has ${lineCount.toLocaleString()} lines. Hard cap is 5,000 — split into chunks.` };
  }
  let warning = null;
  if (bytes > MAX_BYTES_SOFT) {
    warning = `That's ${(bytes / 1024).toFixed(0)} KB — make sure each line is one show. Continue?`;
  } else if (lineCount > MAX_LINES_SOFT) {
    warning = `That's ${lineCount.toLocaleString()} lines — make sure each line is one show. Continue?`;
  }
  return { ok: true, warning };
}

ui.pasteArea.addEventListener('input', checkPickValid);

ui.fileInput.addEventListener('change', async () => {
  const file = ui.fileInput.files?.[0];
  if (!file) return;
  setPickStatus(`Reading ${file.name}…`);
  try {
    const text = await file.text();
    const v = validateInputSize(text, file.name);
    if (!v.ok) {
      setPickStatus(v.message, true);
      return;
    }
    ui.pasteArea.value = text;
    setPickStatus(v.warning || `Loaded ${file.name}.`, !!v.warning);
    checkPickValid();
  } catch (err) {
    setPickStatus(`Couldn't read file: ${err.message || err}`, true);
  }
});

ui.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  ui.dropzone.classList.add('dragover');
});
ui.dropzone.addEventListener('dragleave', () => ui.dropzone.classList.remove('dragover'));
ui.dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  ui.dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  // Mirror the file-input change handler.
  ui.fileInput.files = e.dataTransfer.files;
  ui.fileInput.dispatchEvent(new Event('change'));
});

ui.continueBtn.addEventListener('click', () => {
  const text = ui.pasteArea.value;
  const v = validateInputSize(text);
  if (!v.ok) {
    setPickStatus(v.message, true);
    return;
  }
  state.rawText = text;
  state.sniffReport = sniffFreeformInput(text);
  populatePreview(state.sniffReport);
  showStage('preview');
});

// ── Stage 2: preview (sniffer confirm) ──────────────────────────
function populatePreview(report) {
  ui.previewStats.innerHTML = '';
  const chips = [];
  chips.push(`<span><strong>${report.itemCount}</strong> shows</span>`);
  if (report.headerCount > 0) chips.push(`<span><strong>${report.headerCount}</strong> headers</span>`);
  if (report.favoriteHits > 0) chips.push(`<span><strong>${report.favoriteHits}</strong> favorites</span>`);
  const statusBreakdown = Object.entries(report.statusHits)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}=${n}`)
    .join(' · ');
  if (statusBreakdown) chips.push(`<span>${statusBreakdown}</span>`);
  ui.previewStats.innerHTML = chips.join('');

  // Pre-fill the score-scale select with the inferred dominant scale.
  ui.scoreScaleSelect.value = report.inferredOptions.scoreScale || 'none';
  ui.useHeaderState.checked = !!report.inferredOptions.useHeaderStateInheritance;
  ui.useHeaderFav.checked = !!report.inferredOptions.useHeaderFavoriteInheritance;
}

ui.previewBackBtn.addEventListener('click', () => {
  showStage('pick');
  setPickStatus('');
});

ui.parseBtn.addEventListener('click', async () => {
  const options = {
    scoreScale: ui.scoreScaleSelect.value,
    useHeaderStateInheritance: ui.useHeaderState.checked,
    useHeaderFavoriteInheritance: ui.useHeaderFav.checked,
  };
  state.parsedRows = parseFreeformInput(state.rawText, options);
  if (state.parsedRows.length === 0) {
    showError('After parsing, we found 0 shows. Go back and check the format — each line should be one show.');
    return;
  }

  // Build title index from the local caches. Both keys are
  // page-readable (extension pages share chrome.storage.local with
  // the SW), so we just fetch the snapshot here. Cache contents are
  // populated by background.js's bootstrap + ongoing CR sync.
  let aniListCache, aniListBridgeCache;
  try {
    const wrap = await chrome.storage.local.get([
      STORAGE_KEYS.aniListCache,
      STORAGE_KEYS.aniListBridgeCache,
    ]);
    aniListCache = wrap[STORAGE_KEYS.aniListCache] || {};
    aniListBridgeCache = wrap[STORAGE_KEYS.aniListBridgeCache] || {};
  } catch (err) {
    showError(`Couldn't read local cache: ${err.message || err}`);
    return;
  }
  const titleCount =
    Object.keys(aniListCache).length + Object.keys(aniListBridgeCache).length;
  if (titleCount === 0) {
    showError(
      'Your local title cache is empty — Smart Scoring hasn\'t seen any shows yet. ' +
      'Open Crunchyroll once so the extension can populate its catalog, then try importing again.'
    );
    return;
  }
  const index = buildTitleIndex(aniListCache, aniListBridgeCache);

  // AL Search fallback — the matcher's DI hook. Routes through the SW
  // so all AL traffic stays on the paced gateway (rate limit + breaker
  // shared across the extension). Per Q11 of the 2026-05-18 grill,
  // only titles leave the device; scores/status/favorites stay here.
  //
  // Batched adapter (2026-05-19 grill #3): the matcher's pass-1 fires
  // searchFn for every unmatched row synchronously. The adapter
  // accumulates calls and flushes batched on the next microtask (or
  // immediately when the batch reaches 10). One SW message →
  // one HTTP request to AL → up to 10 titles resolved. Math: a
  // 50-miss import drops from ~40s (50 × 800ms gateway pacing)
  // down to ~6.5s (5 × 1300ms).
  //
  // Per-analyze lifetime: fresh adapter every run, so cancelled
  // batches can't leak into the next analyze.
  const searchFn = createBatchedSearchAdapter({ sendBatch: sendBatchedSearch });

  // Transition to the analyzing stage — local match + AL Search
  // fallback can take 30s–2min for large lists with many cache
  // misses (the user's 120-show paste being the canonical example).
  // Without progress feedback this looks dead.
  state.analyzingAbort = new AbortController();
  const totalRows = state.parsedRows.length;
  ui.analyzingStatus.textContent = `Finding your shows… 0 of ${totalRows}`;
  ui.analyzingSub.textContent = 'Matching against your local catalog and AniList…';
  showStage('analyzing');

  // Track the "run ID" of THIS analysis pass. The promise below races
  // against a possible cancel click — cancel sets state.analyzingAbort
  // to null and transitions to preview immediately, but the underlying
  // resolveFreeformList may still be awaiting an in-flight AL Search
  // (chrome.runtime.sendMessage doesn't honor AbortSignal natively).
  // When the dangling promise eventually resolves, this token check
  // ensures the late result is dropped instead of jamming the UI back
  // to the review stage after the user has already moved on.
  const runToken = Symbol('analyzing-run');
  state.analyzingRunToken = runToken;

  let matchResult;
  try {
    matchResult = await resolveFreeformList({
      rows: state.parsedRows,
      index,
      searchFn,
      signal: state.analyzingAbort.signal,
      onProgress: ({ i, total }) => {
        ui.analyzingStatus.textContent = `Finding your shows… ${i + 1} of ${total}`;
      },
    });
  } catch (err) {
    if (state.analyzingRunToken === runToken) {
      showError(`Couldn't analyze your list: ${err.message || err}`);
    }
    return;
  }

  // Late-result guard: if cancel preempted us, the user is already on
  // the preview stage. Drop this result silently.
  if (state.analyzingRunToken !== runToken) return;

  // resolveFreeformList honors AbortSignal by `break`ing the loop and
  // returning whatever was processed so far. Check the signal state
  // here as well — covers the race where cancel fires after the loop
  // exits but before this branch runs.
  if (state.analyzingAbort?.signal.aborted) {
    state.analyzingAbort = null;
    showStage('preview');
    return;
  }
  state.analyzingAbort = null;
  state.matchResult = matchResult;
  state.userPicks = new Map();
  populateReview(state.matchResult);
  showStage('review');
});

ui.analyzingCancel.addEventListener('click', () => {
  // Preempt-on-cancel: drop straight back to preview without waiting
  // for the in-flight AL Search to resolve. chrome.runtime.sendMessage
  // doesn't honor AbortSignal so we can't cut the network call, but
  // we CAN unjam the UI — the dangling resolveFreeformList still runs
  // to completion in the background, and the late-result guard at the
  // top of the parse-btn handler drops its result by checking
  // state.analyzingRunToken. Found 2026-05-19 during button audit:
  // cancel was technically "signal sent" but visually frozen until
  // the AL Search round-trip finished, which can be 10+ seconds when
  // the gateway is in backoff.
  if (state.analyzingAbort) state.analyzingAbort.abort();
  state.analyzingAbort = null;
  state.analyzingRunToken = null;
  showStage('preview');
});

// ── Stage 3: review ──────────────────────────────────────────────
function populateReview({ matched, lowConfidence, unmatched }) {
  ui.reviewSummary.innerHTML = [
    `<span><strong>${matched.length}</strong> auto-matched</span>`,
    lowConfidence.length > 0 ? `<span><strong>${lowConfidence.length}</strong> need a pick</span>` : '',
    unmatched.length > 0 ? `<span><strong>${unmatched.length}</strong> not found</span>` : '',
  ].filter(Boolean).join('');

  ui.lowConfPile.classList.toggle('hidden', lowConfidence.length === 0);
  ui.unmatchedPile.classList.toggle('hidden', unmatched.length === 0);
  ui.lowConfCount.textContent = lowConfidence.length ? `(${lowConfidence.length})` : '';
  ui.unmatchedCount.textContent = unmatched.length ? `(${unmatched.length})` : '';

  ui.lowConfRows.innerHTML = '';
  for (const item of lowConfidence) {
    ui.lowConfRows.appendChild(buildLowConfRow(item));
  }
  ui.unmatchedRows.innerHTML = '';
  for (const item of unmatched) {
    ui.unmatchedRows.appendChild(buildUnmatchedRow(item));
  }
}

function buildLowConfRow({ row, candidates }) {
  const wrap = document.createElement('div');
  wrap.className = 'review-row';
  const titleCol = document.createElement('div');
  titleCol.innerHTML = `
    <div class="review-row-title">${escapeHtml(row.titleRaw)}</div>
    <div class="review-row-meta">${describeRowMeta(row)}</div>
  `;
  wrap.appendChild(titleCol);

  const actions = document.createElement('div');
  actions.className = 'review-row-actions';
  for (const cand of (candidates || []).slice(0, 3)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'candidate-btn';
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `
      <span>${escapeHtml(cand.title || '(unknown)')}</span>
      <span class="candidate-year-format">${describeCandidateMeta(cand)}</span>
    `;
    btn.addEventListener('click', () => {
      // Single-select within the row: toggle this on, clear siblings.
      for (const sib of actions.querySelectorAll('button')) {
        sib.setAttribute('aria-pressed', 'false');
      }
      btn.setAttribute('aria-pressed', 'true');
      state.userPicks.set(row.lineNumber, { aniListId: cand.aniListId, candidate: cand });
    });
    actions.appendChild(btn);
  }
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'skip-btn';
  skip.textContent = 'Skip this one';
  skip.setAttribute('aria-pressed', 'false');
  skip.addEventListener('click', () => {
    for (const sib of actions.querySelectorAll('button')) {
      sib.setAttribute('aria-pressed', 'false');
    }
    skip.setAttribute('aria-pressed', 'true');
    state.userPicks.set(row.lineNumber, { skip: true });
  });
  actions.appendChild(skip);
  wrap.appendChild(actions);
  return wrap;
}

function buildUnmatchedRow({ row }) {
  const wrap = document.createElement('div');
  wrap.className = 'review-row';
  const titleCol = document.createElement('div');
  titleCol.innerHTML = `
    <div class="review-row-title">${escapeHtml(row.titleRaw)}</div>
    <div class="review-row-meta">${describeRowMeta(row)} · not in local catalog</div>
  `;
  wrap.appendChild(titleCol);
  const actions = document.createElement('div');
  actions.className = 'review-row-actions';
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'skip-btn';
  skip.textContent = 'Skip this one';
  skip.setAttribute('aria-pressed', 'true'); // unmatched rows are skip-by-default
  state.userPicks.set(row.lineNumber, { skip: true });
  skip.addEventListener('click', () => {
    // Toggle is a no-op in v1 (no candidates to pick from). Keep skip
    // as a visible affordance so the user understands what's happening.
  });
  actions.appendChild(skip);
  wrap.appendChild(actions);
  return wrap;
}

function describeRowMeta(row) {
  const bits = [];
  if (row.status) bits.push(row.status);
  if (row.score != null) bits.push(`${row.score}/10`);
  if (row.scoreOriginal && row.scoreOriginal !== `${row.score}/10`) {
    bits.push(`(${row.scoreOriginal})`);
  }
  if (row.isFavorite) bits.push('★ favorite');
  return bits.join(' · ') || '(no status, no score)';
}

function describeCandidateMeta(cand) {
  const bits = [];
  if (cand.format) bits.push(cand.format);
  if (cand.seasonYear) bits.push(cand.seasonYear);
  if (typeof cand.confidence === 'number') {
    bits.push(`~${Math.round(cand.confidence * 100)}%`);
  }
  return bits.join(' · ');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

ui.reviewBackBtn.addEventListener('click', () => {
  showStage('preview');
});

ui.applyBtn.addEventListener('click', async () => {
  const entries = buildFinalEntries();
  if (entries.length === 0) {
    showError('No shows left to import after the review. Go back and pick at least one.');
    return;
  }

  showStage('working');
  ui.workingStatus.textContent = 'Starting import…';
  ui.workingSub.textContent = '';

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'crsmart:external:start-freeform-import',
      entries,
    });
  } catch (err) {
    showError(`Couldn't reach background worker: ${err.message || err}`);
    return;
  }
  if (!response?.ok) {
    showError(response?.message || 'Import failed for an unknown reason.');
    return;
  }
  const result = response.result || {};
  const imported = result.imported ?? 0;
  const preserved = result.preserved ?? 0;
  const duration = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '';
  ui.doneSummary.innerHTML = `
    <p><strong>${imported}</strong> entries imported${duration ? ` in ${duration}` : ''}.</p>
    ${preserved > 0 ? `<p class="muted">${preserved} previously-locked entries preserved across this re-import.</p>` : ''}
    <p class="muted">Your taste vector is recomputing in the background — the new scores
    will land in your Smart Score card on next page load (usually within ~10 seconds).</p>
  `;
  showStage('done');
});

// Walk matched + user-picked low-confidence rows, assemble the final
// entry payload. Skipped rows are filtered out. lockedByUser stamps
// true on any row the user explicitly touched in the review screen.
function buildFinalEntries() {
  const { matched, lowConfidence } = state.matchResult;
  const out = [];

  for (const m of matched) {
    out.push(rowToEntry(m.row, {
      aniListId: m.aniListId,
      confidence: m.confidence,
      matchedVia: m.matchedVia,
      lockedByUser: false,
    }));
  }
  for (const item of lowConfidence) {
    const pick = state.userPicks.get(item.row.lineNumber);
    if (!pick || pick.skip) continue;
    out.push(rowToEntry(item.row, {
      aniListId: pick.aniListId,
      confidence: 1.0,
      matchedVia: 'user-confirmed',
      lockedByUser: true,
    }));
  }
  return out;
}

function rowToEntry(row, resolved) {
  return {
    aniListId: resolved.aniListId,
    titleRaw: row.titleRaw,
    status: row.status,
    score: row.score,
    scoreOriginal: row.scoreOriginal,
    scoreScale: row.scoreScale,
    isFavorite: row.isFavorite,
    userTagsFromImport: row.userTagsFromImport,
    matchedVia: resolved.matchedVia,
    confidence: resolved.confidence,
    lockedByUser: resolved.lockedByUser,
  };
}

// ── Working-stage progress subscription ─────────────────────────
function describePhase(state) {
  if (!state) return { primary: 'Starting…', sub: '' };
  const p = state.progress || {};
  const done = p.done ?? 0;
  const total = p.total ?? 0;
  const ratio = total > 0 ? `(${done}/${total})` : '';
  switch (state.phase) {
    case 'build-accumulator': return { primary: 'Building import batch…', sub: ratio };
    case 'enrich':            return { primary: 'Fetching show metadata…', sub: ratio };
    case 'flush':             return { primary: 'Saving + recomputing taste vector…', sub: '' };
    case 'error':             return { primary: 'Error', sub: state.error || '' };
    default:                  return { primary: state.phase || 'Working…', sub: ratio };
  }
}

subscribeImportState((s) => {
  if (!s) return;
  if (s.source !== 'freeform') return;
  const { primary, sub } = describePhase(s);
  ui.workingStatus.textContent = primary;
  ui.workingSub.textContent = sub;
});

// ── Error stage ─────────────────────────────────────────────────
function showError(message) {
  ui.errorMessage.textContent = message || 'Unknown error.';
  showStage('error');
}

ui.retryBtn.addEventListener('click', () => {
  state.rawText = '';
  state.sniffReport = null;
  state.parsedRows = null;
  state.matchResult = null;
  state.userPicks.clear();
  ui.pasteArea.value = '';
  ui.fileInput.value = '';
  setPickStatus('');
  checkPickValid();
  showStage('pick');
});

ui.closeBtn.addEventListener('click', () => window.close());

// ── Initial state ───────────────────────────────────────────────
checkPickValid();
showStage('pick');
