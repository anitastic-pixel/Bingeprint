// Preview for the CR-catalog rebuild dev tool. Reads _devCatalogPreview
// (written by the SW job, separate from the committed sidecar) and renders
// a reviewable table of CR title → matched AniList title, flagging matches
// whose titles diverge enough to be worth a human look. Auto-refreshes
// while a run is still in progress.

const PREVIEW_KEY = '_devCatalogPreview';
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Token-overlap similarity (0..1). Used to flag suspect matches: a low
// overlap between the searched CR title and the matched AniList title is a
// likely wrong match worth eyeballing.
function similar(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size); // containment-style: short title inside long counts as 1
}
const isSuspect = (r) =>
  (r.conf === 'verified' || r.conf === 'unverified-best-guess') &&
  r.alTitle && similar(r.crTitle, r.alTitle) < 0.5;

const confClass = (c) =>
  c === 'verified' ? 'verified'
  : c === 'unverified-best-guess' ? 'best'
  : c === 'error' ? 'error' : 'no-match';
const confLabel = (c) =>
  c === 'unverified-best-guess' ? 'best-guess' : c;

let allRows = [];
let filter = 'all';

const FILTERS = [
  ['all', 'All'],
  ['suspect', '⚠ Check these'],
  ['verified', 'Verified'],
  ['unverified-best-guess', 'Best-guess'],
  ['no-match', 'No match'],
  ['error', 'Error'],
];

function applyFilter(rows) {
  if (filter === 'all') return rows;
  if (filter === 'suspect') return rows.filter(isSuspect);
  return rows.filter(r => r.conf === filter);
}

function render() {
  const sum = document.getElementById('summary');
  const tbody = document.getElementById('rows');
  const empty = document.getElementById('empty');
  if (!allRows.length) { empty.hidden = false; sum.textContent = 'no rows yet'; tbody.innerHTML = ''; return; }
  empty.hidden = true;

  const counts = {};
  for (const r of allRows) counts[r.conf] = (counts[r.conf] || 0) + 1;
  const suspectCount = allRows.filter(isSuspect).length;
  const kept = (counts.verified || 0) + (counts['unverified-best-guess'] || 0);
  sum.innerHTML =
    `${allRows.length} resolved · <b>${kept} kept</b> ` +
    `(${counts.verified || 0} verified, ${counts['unverified-best-guess'] || 0} best-guess) · ` +
    `${counts['no-match'] || 0} no-match · ${counts.error || 0} error · ` +
    `<span class="flag">${suspectCount} to check</span>`;

  const view = applyFilter(allRows)
    .slice()
    .sort((a, b) => (isSuspect(b) - isSuspect(a))); // suspects first
  tbody.innerHTML = view.map(r => {
    const suspect = isSuspect(r);
    const al = r.alTitle
      ? `<a href="https://anilist.co/anime/${r.alId}" target="_blank">${escapeHtml(r.alTitle)}</a>`
      : '<span class="muted">—</span>';
    return `<tr class="${suspect ? 'suspect' : ''}">
      <td>${escapeHtml(r.crTitle)} <span class="muted">${r.crId}</span></td>
      <td>${al}</td>
      <td><span class="conf ${confClass(r.conf)}">${confLabel(r.conf)}</span></td>
      <td>${suspect ? '<span class="flag">⚠ check</span>' : ''}</td>
    </tr>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderFilters() {
  const el = document.getElementById('filters');
  el.innerHTML = FILTERS.map(([k, label]) =>
    `<span class="chip ${filter === k ? 'active' : ''}" data-f="${k}">${label}</span>`).join('');
  el.querySelectorAll('.chip').forEach(c =>
    c.addEventListener('click', () => { filter = c.dataset.f; renderFilters(); render(); }));
}

async function load() {
  const { [PREVIEW_KEY]: data } = await chrome.storage.local.get(PREVIEW_KEY);
  allRows = data?.rows || [];
  render();
  return data?.partial === true;
}

(async function init() {
  renderFilters();
  let partial = await load();
  // Live-refresh while a run is still in flight.
  const timer = setInterval(async () => { partial = await load(); if (!partial) clearInterval(timer); }, 4000);
})();
