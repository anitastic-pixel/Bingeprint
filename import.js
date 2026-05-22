// Restore-from-backup flow. Lives in its own tab (opened from the
// popup) because Chrome MV3 popups close on focus loss to the OS file
// picker, which makes inline import unreliable. Stages:
//
//   1. pick        — drop zone + file picker. Read file, parse + validate.
//   2. preview     — show envelope metadata, per-bucket counts, override
//                    checkboxes. Run the smart-conditional rule against
//                    the device's current source state to decide whether
//                    the file's engineOutput is trustworthy.
//   3. working     — single chrome.storage.local.set (atomic) plus an
//                    optional recompute-trigger broadcast.
//   4. done        — summary of what was written, close-tab button.
//   5. error       — typed error from parseBackupEnvelope, or a write
//                    failure that triggered rollback.
//
// All staging is via show/hide on .stage sections — no SPA framework,
// no animations beyond the simple CSS spinner. Page is one-shot:
// reloading goes back to stage 1.

(function () {
  'use strict';

  if (!window.crsmartBackupSchema) {
    console.error('[crsmart-import] backup-schema.js failed to load');
    return;
  }
  const Schema = window.crsmartBackupSchema;

  // ── DOM refs ─────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const stages = {
    pick:    document.querySelector('[data-stage="pick"]'),
    preview: document.querySelector('[data-stage="preview"]'),
    working: document.querySelector('[data-stage="working"]'),
    done:    document.querySelector('[data-stage="done"]'),
    error:   document.querySelector('[data-stage="error"]'),
  };

  // Module-level state. Single-flight — reloading the page is the way
  // to start over. parsedEnvelope holds the validated file; deviceState
  // holds the pre-import device snapshot used by the smart-conditional
  // rule and the post-restore summary.
  let parsedEnvelope = null;
  let deviceState = null;
  let fileSizeBytes = 0;

  // ── Stage helpers ────────────────────────────────────────────
  function showStage(name) {
    for (const [k, el] of Object.entries(stages)) {
      if (el) el.classList.toggle('hidden', k !== name);
    }
  }
  function setPickStatus(text, isError = false) {
    const el = $('pick-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }
  function setWorkingStatus(text) {
    const el = $('working-status');
    if (el) el.textContent = text;
  }
  function showError(message) {
    const el = $('error-message');
    if (el) el.textContent = message || 'Unknown error.';
    showStage('error');
  }

  // ── Stage 1: file pick + parse ───────────────────────────────
  function wireFilePick() {
    const input = $('file-input');
    const drop = $('dropzone');
    if (input) {
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) handleFile(file);
      });
    }
    if (drop) {
      drop.addEventListener('dragover', e => {
        e.preventDefault();
        drop.classList.add('is-dragging');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-dragging'));
      drop.addEventListener('drop', e => {
        e.preventDefault();
        drop.classList.remove('is-dragging');
        const file = e.dataTransfer?.files?.[0];
        if (file) handleFile(file);
      });
    }
  }

  async function handleFile(file) {
    setPickStatus(`Reading ${file.name}…`);
    fileSizeBytes = file.size;
    let text;
    try { text = await file.text(); }
    catch (err) {
      setPickStatus(`Couldn't read file: ${err?.message || err}`, true);
      return;
    }
    let envelope;
    try { envelope = Schema.parseBackupEnvelope(text); }
    catch (err) {
      // Typed error from backup-schema; show user-readable message.
      // We stay on the pick stage so the user can try a different file.
      setPickStatus(err?.message || 'Couldn\'t parse this file.', true);
      return;
    }
    parsedEnvelope = envelope;
    setPickStatus('');
    await renderPreview(file.name);
  }

  // ── Stage 2: preview ─────────────────────────────────────────
  async function renderPreview(filename) {
    // Detect device source-bucket coverage now so the smart-conditional
    // rule can run as the user toggles per-bucket overrides.
    deviceState = {
      sourceBucketsWithData: await Schema.detectDeviceSourceBuckets(),
    };

    // Metadata strip.
    $('meta-schema').textContent = `v${parsedEnvelope.schemaVersion}`;
    $('meta-exported').textContent = parsedEnvelope.exportedAt
      ? formatDateRelative(parsedEnvelope.exportedAt)
      : '—';
    $('meta-extension').textContent = parsedEnvelope.extensionVersion
      ? `Extension ${parsedEnvelope.extensionVersion} · ${filename}`
      : filename;
    $('meta-size').textContent = `${(fileSizeBytes / 1024).toFixed(1)} KB`;

    // Per-bucket override rows. We render a row for every bucket the
    // FILE contains, in canonical order (cr → anilist → survey →
    // settings → engineOutput). Each row carries a count if the bucket
    // has any countable signal (e.g. number of watch entries, AL imports).
    const overridesEl = $('bucket-overrides');
    overridesEl.innerHTML = '';
    const renderOrder = ['cr', 'anilist', 'survey', 'settings', 'engineOutput'];
    for (const bucket of renderOrder) {
      const bucketData = parsedEnvelope.buckets[bucket];
      if (!bucketData) continue;
      const row = renderBucketRow(bucket, bucketData);
      overridesEl.appendChild(row);
    }
    // Forward-compat: surface unknown buckets so the user knows they're
    // present + ignored. Doesn't add a checkbox (we can't restore an
    // unknown bucket — wouldn't know which keys to write).
    if (parsedEnvelope.unknownBuckets?.length > 0) {
      const note = document.createElement('div');
      note.className = 'unknown-buckets';
      note.textContent =
        `Note: file also contains unknown bucket(s) (${parsedEnvelope.unknownBuckets.join(', ')}) — ` +
        `these will be ignored. They may be from a newer extension version.`;
      overridesEl.appendChild(note);
    }

    // OAuth-note shows when the file ships AniList tokens. Surface this
    // up-front so the user understands the restore will auto-sign-in.
    const aniListBucket = parsedEnvelope.buckets.anilist;
    const fileHasOAuth = !!(aniListBucket && aniListBucket.oauthTokens);
    $('oauth-note').hidden = !fileHasOAuth;

    updateRecomputeNote();
    showStage('preview');
  }

  // Build one bucket-override row. Returns the <label> element to append.
  function renderBucketRow(bucket, bucketData) {
    const meta = BUCKET_META[bucket] || { label: bucket, hint: '' };
    const count = countableValueFor(bucket, bucketData);
    const wrap = document.createElement('label');
    wrap.className = 'bucket-row';
    wrap.dataset.bucket = bucket;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.bucket = bucket;
    cb.addEventListener('change', updateRecomputeNote);

    const body = document.createElement('div');
    body.className = 'bucket-row-body';

    const head = document.createElement('div');
    head.className = 'bucket-row-head';
    const name = document.createElement('span');
    name.className = 'bucket-row-name';
    name.textContent = meta.label;
    const countEl = document.createElement('span');
    countEl.className = 'bucket-row-count';
    countEl.textContent = count;
    head.appendChild(name);
    head.appendChild(countEl);

    const hint = document.createElement('div');
    hint.className = 'bucket-row-hint';
    hint.textContent = meta.hint;

    body.appendChild(head);
    body.appendChild(hint);
    wrap.appendChild(cb);
    wrap.appendChild(body);
    return wrap;
  }

  const BUCKET_META = {
    cr:           { label: 'CR data',           hint: 'watch history + per-show meta' },
    anilist:      { label: 'AniList data',      hint: 'imported scores + linking state' },
    survey:       { label: 'Survey + reactions', hint: 'Quick Taste Check taps, ratings, reactions' },
    settings:     { label: 'Settings',          hint: 'dealbreakers, panel toggles, slider tunings' },
    engineOutput: { label: 'Engine output',     hint: 'taste vector + scored shows + caches (skips recompute on restore)' },
  };

  // Compute a one-line "what's in here" summary for a bucket. Different
  // buckets have different obvious counts — CR's "615 shows" maps to
  // watchShapes entries; AniList's "230 entries" maps to externalScores.
  function countableValueFor(bucket, data) {
    if (!data || typeof data !== 'object') return '';
    if (bucket === 'cr') {
      const ws = data.watchShapes;
      const count = ws && typeof ws === 'object' ? Object.keys(ws).length : 0;
      return count > 0 ? `${count} watched` : '';
    }
    if (bucket === 'anilist') {
      // externalScores shape: { [aniListId]: { anilist: {...}, mal: {...} } }
      // Count entries with an 'anilist' sub-key specifically — gives
      // an accurate "from AniList" tally even when MAL is also in the
      // file (we'd overcount if we counted top-level keys).
      const es = data.externalScores;
      let count = 0;
      if (es && typeof es === 'object') {
        for (const id of Object.keys(es)) {
          if (es[id]?.anilist) count++;
        }
      }
      return count > 0 ? `${count} entries` : '';
    }
    if (bucket === 'survey') {
      const taps = data.surveyShapes ? Object.keys(data.surveyShapes).length : 0;
      const tagTaps = data.surveyTagShapes ? Object.keys(data.surveyTagShapes).length : 0;
      const ratings = data.userRatings ? Object.keys(data.userRatings).length : 0;
      const reactions = data.userReactions ? Object.keys(data.userReactions).length : 0;
      const total = taps + tagTaps + ratings + reactions;
      return total > 0 ? `${total} signals` : '';
    }
    if (bucket === 'settings') {
      const tags = data.surfaceSettings?.dealbreakerTags?.length || 0;
      return tags > 0 ? `${tags} dealbreakers` : 'configured';
    }
    if (bucket === 'engineOutput') {
      const scored = data.allShowsScored;
      let count = 0;
      if (Array.isArray(scored)) count = scored.length;
      else if (scored && typeof scored === 'object') count = Object.keys(scored).length;
      return count > 0 ? `${count} scored` : '';
    }
    return '';
  }

  // The smart-conditional note is shown when we'll need to recompute
  // (file's engineOutput won't be trusted). Updates as the user toggles
  // per-bucket overrides because removing a source bucket from the
  // selection can flip the rule from "trust file" to "recompute".
  function updateRecomputeNote() {
    if (!parsedEnvelope || !deviceState) return;
    const selectedBuckets = [...document.querySelectorAll('.bucket-row input[type=checkbox]:checked')]
      .map(cb => cb.dataset.bucket);
    const useFileOutput = Schema.shouldUseBackedUpEngineOutput(
      deviceState, parsedEnvelope, selectedBuckets
    );
    const note = $('recompute-note');
    // Only show the recompute-note when engineOutput is in the file but
    // we won't trust it. If the file lacks engineOutput entirely, no
    // recompute is implied (no source data to recompute from).
    const fileHasEngineOutput = !!parsedEnvelope.buckets.engineOutput;
    note.hidden = !(fileHasEngineOutput && !useFileOutput);
  }

  // Friendly relative date for the metadata strip. Falls back to the
  // raw ISO if parsing fails.
  function formatDateRelative(iso) {
    try {
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return iso;
      const ms = Date.now() - t;
      const day = 24 * 60 * 60 * 1000;
      if (ms < day) return 'today · ' + iso.slice(0, 10);
      if (ms < 2 * day) return 'yesterday · ' + iso.slice(0, 10);
      if (ms < 30 * day) return `${Math.floor(ms / day)} days ago · ${iso.slice(0, 10)}`;
      return iso.slice(0, 10);
    } catch (_) { return iso; }
  }

  // ── Stage 3: restore ─────────────────────────────────────────
  function wireRestoreButton() {
    $('restore-btn').addEventListener('click', () => doRestore());
    $('cancel-btn').addEventListener('click', () => {
      parsedEnvelope = null;
      deviceState = null;
      const input = $('file-input');
      if (input) input.value = '';
      showStage('pick');
    });
  }

  async function doRestore() {
    const selectedBuckets = [...document.querySelectorAll('.bucket-row input[type=checkbox]:checked')]
      .map(cb => cb.dataset.bucket);
    if (selectedBuckets.length === 0) {
      showError('Pick at least one bucket to restore.');
      return;
    }

    // Filter the envelope's buckets down to the user's selection.
    const filteredBuckets = {};
    for (const b of selectedBuckets) {
      if (parsedEnvelope.buckets[b]) filteredBuckets[b] = parsedEnvelope.buckets[b];
    }
    // engineOutput is special: rides along iff smart-conditional says yes.
    const useFileEngineOutput = Schema.shouldUseBackedUpEngineOutput(
      deviceState, parsedEnvelope, selectedBuckets
    );
    if (useFileEngineOutput && parsedEnvelope.buckets.engineOutput) {
      filteredBuckets.engineOutput = parsedEnvelope.buckets.engineOutput;
    }

    showStage('working');
    setWorkingStatus('Writing data…');

    const result = await Schema.restoreBackup({
      buckets: filteredBuckets,
      useFileEngineOutput,
    });
    if (!result.ok) {
      showError(`The backup couldn't be applied: ${result.error || 'unknown error'}. ` +
                `Your existing data is unchanged.`);
      return;
    }

    // Tell the service worker that source data may have changed so it
    // can broadcast a refresh to open CR tabs / sidebar / popup. The
    // background handler also kicks off a recompute when needed.
    try {
      await chrome.runtime.sendMessage({
        type: 'crsmart:backup-restored',
        useFileEngineOutput,
        restoredBuckets: selectedBuckets,
      });
    } catch (_) {
      // SW unavailable? Restore still happened — surfaces will pick it
      // up via storage onChanged on next paint.
    }

    renderDone(selectedBuckets, result.wroteKeys, useFileEngineOutput);
  }

  // ── Stage 4: done ─────────────────────────────────────────────
  function renderDone(restoredBuckets, wroteKeys, useFileEngineOutput) {
    const summary = $('restore-summary');
    summary.innerHTML = '';
    const list = document.createElement('ul');
    for (const bucket of restoredBuckets) {
      const meta = BUCKET_META[bucket] || { label: bucket };
      const li = document.createElement('li');
      li.textContent = meta.label;
      list.appendChild(li);
    }
    if (useFileEngineOutput) {
      const li = document.createElement('li');
      li.textContent = 'Engine output (taste vector, scored shows, caches) — restored from file';
      list.appendChild(li);
    } else if (parsedEnvelope.buckets.engineOutput) {
      const li = document.createElement('li');
      li.className = 'note';
      li.textContent = 'Engine state will recompute in the background (~10s).';
      list.appendChild(li);
    }
    const meta = document.createElement('div');
    meta.className = 'restore-meta';
    meta.textContent = `${wroteKeys.length} keys written.`;
    summary.appendChild(list);
    summary.appendChild(meta);

    showStage('done');
  }

  function wireCloseTab() {
    $('close-tab-btn').addEventListener('click', () => {
      try { window.close(); } catch (_) {}
    });
    $('error-retry-btn').addEventListener('click', () => {
      const input = $('file-input');
      if (input) input.value = '';
      parsedEnvelope = null;
      deviceState = null;
      showStage('pick');
      setPickStatus('');
    });
  }

  // ── Boot ─────────────────────────────────────────────────────
  wireFilePick();
  wireRestoreButton();
  wireCloseTab();
  showStage('pick');
})();
