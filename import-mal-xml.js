// MAL XML import — front-end controller.
//
// Stage flow mirrors import.html (backup restore):
//   pick → preview → working → done | error
//
// Why parsing happens in the page rather than the SW:
//   - The SW would need the file's bytes; sending a multi-MB ArrayBuffer
//     via chrome.runtime.sendMessage works but is awkward.
//   - DOMParser is available in extension pages but NOT in MV3 service
//     workers. Parsing here is the natural seam.
//   - The page only forwards a small JSON object ({ [malId]: {score,
//     status, progress, updatedAt} }) to the SW once parsing succeeds.
//
// Progress polling: runImport in external-list-importer.js writes the
// active phase + progress to chrome.storage.local._importState on each
// stage transition + on every batch within enrichment / cross-walk. We
// subscribe via storage.onChanged to get live updates without polling.

import { parseMalXmlExport, decompressMalGzip } from './mal-xml.js';
import { subscribeImportState } from './import-state-channel.js';

const stageEls = {
  pick:    document.querySelector('[data-stage="pick"]'),
  preview: document.querySelector('[data-stage="preview"]'),
  working: document.querySelector('[data-stage="working"]'),
  done:    document.querySelector('[data-stage="done"]'),
  error:   document.querySelector('[data-stage="error"]'),
};

const ui = {
  dropzone:      document.getElementById('dropzone'),
  fileInput:     document.getElementById('file-input'),
  pickStatus:    document.getElementById('pick-status'),
  metaEntries:   document.getElementById('meta-entries'),
  metaRated:     document.getElementById('meta-rated'),
  metaStatusMix: document.getElementById('meta-status-mix'),
  metaFilename:  document.getElementById('meta-filename'),
  importBtn:     document.getElementById('import-btn'),
  cancelBtn:     document.getElementById('cancel-btn'),
  workingStatus: document.getElementById('working-status'),
  workingSub:    document.getElementById('working-substatus'),
  doneSummary:   document.getElementById('done-summary'),
  errorMessage:  document.getElementById('error-message'),
  closeBtn:      document.getElementById('close-tab-btn'),
  retryBtn:      document.getElementById('error-retry-btn'),
};

let parsedEntries = null;

function showStage(name) {
  for (const [k, el] of Object.entries(stageEls)) {
    el.classList.toggle('hidden', k !== name);
  }
}

function statusMixLabel(entries) {
  const counts = {};
  for (const e of Object.values(entries)) {
    const s = e.status || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  const order = ['watching', 'completed', 'paused', 'dropped', 'planning', 'unknown'];
  return order
    .filter(k => counts[k])
    .map(k => `${k}=${counts[k]}`)
    .join(' · ');
}

async function readFileText(file) {
  // .gz files arrive as binary; everything else as text. Detect by
  // filename suffix since browser File.type is unreliable for .gz.
  if (file.name.toLowerCase().endsWith('.gz')) {
    const buf = await file.arrayBuffer();
    return await decompressMalGzip(buf);
  }
  return await file.text();
}

async function ingestFile(file) {
  ui.pickStatus.textContent = `Reading ${file.name}…`;
  let text;
  try {
    text = await readFileText(file);
  } catch (err) {
    ui.pickStatus.textContent = `Couldn't read file: ${err.message}`;
    return;
  }
  let entries;
  try {
    entries = parseMalXmlExport(text);
  } catch (err) {
    ui.pickStatus.textContent = `Couldn't parse XML: ${err.message}`;
    return;
  }
  const count = Object.keys(entries).length;
  if (count === 0) {
    ui.pickStatus.textContent = 'XML parsed but contained no <anime> entries — is this an anime list export?';
    return;
  }
  parsedEntries = entries;

  const rated = Object.values(entries).filter(e => e.score != null).length;
  ui.metaEntries.textContent = String(count);
  ui.metaRated.textContent = `${rated} (${((rated / count) * 100).toFixed(0)}%)`;
  ui.metaStatusMix.textContent = statusMixLabel(entries);
  ui.metaFilename.textContent = file.name;
  showStage('preview');
}

ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files?.[0];
  if (file) ingestFile(file);
});

ui.dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  ui.dropzone.classList.add('dragover');
});
ui.dropzone.addEventListener('dragleave', () => {
  ui.dropzone.classList.remove('dragover');
});
ui.dropzone.addEventListener('drop', e => {
  e.preventDefault();
  ui.dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) ingestFile(file);
});

ui.cancelBtn.addEventListener('click', () => {
  parsedEntries = null;
  ui.fileInput.value = '';
  ui.pickStatus.textContent = '';
  showStage('pick');
});

ui.closeBtn.addEventListener('click', () => window.close());

ui.retryBtn.addEventListener('click', () => {
  parsedEntries = null;
  ui.fileInput.value = '';
  ui.pickStatus.textContent = '';
  showStage('pick');
});

// Subscribe to _importState changes so the working stage reflects
// runImport's stage transitions (crosswalk N/M → enrich N/M → flush).
function describePhase(state) {
  if (!state) return { primary: 'Starting…', sub: '' };
  const p = state.progress || {};
  const done = p.done ?? 0;
  const total = p.total ?? 0;
  const ratio = total > 0 ? ` (${done}/${total})` : '';
  switch (state.phase) {
    case 'fetch-list':
      return { primary: 'Reading list…', sub: '' };
    case 'crosswalk':
      return { primary: 'Matching MAL IDs to AniList…', sub: ratio };
    case 'enrich':
      return { primary: 'Fetching show metadata…', sub: ratio };
    case 'flush':
      return { primary: 'Saving + recomputing taste vector…', sub: '' };
    case 'error':
      return { primary: 'Error', sub: state.error || '' };
    default:
      return { primary: state.phase || 'Working…', sub: ratio };
  }
}

subscribeImportState(state => {
  if (!state) return;
  const { primary, sub } = describePhase(state);
  ui.workingStatus.textContent = primary;
  ui.workingSub.textContent = sub;
});

ui.importBtn.addEventListener('click', async () => {
  if (!parsedEntries) {
    showStage('error');
    ui.errorMessage.textContent = 'No parsed entries — pick a file first.';
    return;
  }
  showStage('working');
  ui.workingStatus.textContent = 'Starting import…';
  ui.workingSub.textContent = '';

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'crsmart:external:start-mal-xml-import',
      entries: parsedEntries,
    });
  } catch (err) {
    showStage('error');
    ui.errorMessage.textContent = `Couldn't reach background worker: ${err.message || err}`;
    return;
  }
  if (!response?.ok) {
    showStage('error');
    ui.errorMessage.textContent = response?.message || 'Import failed for an unknown reason.';
    return;
  }
  const result = response.result || {};
  const imported = result.imported ?? 0;
  const duration = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '';
  ui.doneSummary.innerHTML = `
    <p><strong>${imported}</strong> entries imported${duration ? ` in ${duration}` : ''}.</p>
    <p class="muted">Your taste vector is recomputing in the background — the new scores
    will land in your Smart Score card on next page load (usually within ~10 seconds).</p>
  `;
  showStage('done');
});

showStage('pick');
