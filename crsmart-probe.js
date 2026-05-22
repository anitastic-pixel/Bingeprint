'use strict';

// crsmart-probe — the probe surface external dev tools read to inspect engine
// state without touching chrome.storage.
//
// Why it exists:
//   Before this file, the only way to expose engine state to extension-monitor /
//   chrome-devtools / claude-in-chrome was for individual call sites to write
//   ad-hoc data-crsmart-* attributes onto document.documentElement. Each
//   external tool had to know each attribute name and JSON shape; there was no
//   way to enumerate "what's currently exposed."
//
// What it gives:
//   - One named seam (window.__crsmart) for both writing and reading probes.
//   - Cross-world by design: the implementation shadows every probe into
//     document.documentElement.dataset (which is shared across the content
//     script's isolated world, the page's main world, and any external
//     evaluator), so any tool that can read the DOM can read every probe.
//   - Discoverability: __crsmart.list() returns the names of all live probes
//     so a reader can find what's exposed without grep.
//
// What it doesn't give:
//   - No service-worker probes. SWs have no DOM and no shared world with the
//     pages. Engine state in the SW is still surfaced via chrome.storage and
//     read by extension-monitor's storage-* snapshots.
//   - No reactive pull. A getter() at expose-time fires once at write; the
//     producer must call expose(name, freshValue) again to refresh the
//     snapshot. This is honest — lazy reads across JS worlds aren't free.
//
// Loading:
//   - Content scripts (content.js context): load crsmart-probe.js immediately
//     before the script that produces probes, via manifest content_scripts.
//   - Extension pages (sidepanel.html, popup.html, survey.html): include via
//     <script src="crsmart-probe.js"></script> before any consumer.
//   - Idempotent: subsequent loads detect the existing surface and reuse it.

(function initCrsmartProbe() {
  // The dataset key prefix for the cross-world shadow. Each probe `name`
  // becomes documentElement.dataset.crsmartProbeFoo (camelCased per the
  // dataset API rules: hyphens map to camelCase, so the underlying attribute
  // is data-crsmart-probe-foo).
  const PREFIX_DATASET = 'crsmartProbe';
  const PREFIX_ATTR = 'data-crsmart-probe-';

  function camelToKebab(s) {
    return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  }

  function nameToDatasetKey(name) {
    // Replace any non-identifier characters with empty so dataset assignment
    // works. Probe names should be /[a-zA-Z0-9_]+/.
    const safe = String(name).replace(/[^a-zA-Z0-9_]/g, '');
    return PREFIX_DATASET + safe.charAt(0).toUpperCase() + safe.slice(1);
  }

  function nameToAttrSuffix(name) {
    const safe = String(name).replace(/[^a-zA-Z0-9_]/g, '');
    return PREFIX_ATTR + camelToKebab(safe.charAt(0).toLowerCase() + safe.slice(1));
  }

  // Privacy gate. The dataset shadow (below) lives on document.documentElement,
  // which on a crunchyroll.com page is readable by the page's own scripts and
  // any other installed extension. Engine/taste state must NOT leak there in
  // normal use, so the shadow is written ONLY when dev probes are explicitly
  // enabled. Default OFF → production never exposes anything. The ?dev=1 popup
  // sets `_crsmartDevProbes` so external dev tools (extension-monitor,
  // chrome-devtools) can read probes during debugging.
  let devProbesOn = false;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get('_crsmartDevProbes')
        .then(r => { devProbesOn = r && r._crsmartDevProbes === true; })
        .catch(() => {});
      if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes._crsmartDevProbes) {
            devProbesOn = changes._crsmartDevProbes.newValue === true;
          }
        });
      }
    }
  } catch (_) { /* no chrome.storage (e.g. plain page) — stays OFF */ }

  function makeSurface() {
    function root() {
      // documentElement is always available on extension pages and CR pages
      // alike; throw a helpful error in any context that lacks it.
      if (typeof document === 'undefined' || !document.documentElement) {
        throw new Error('crsmart-probe requires a DOM (document.documentElement). Service-worker contexts are not supported.');
      }
      return document.documentElement;
    }

    function expose(name, value) {
      const key = nameToDatasetKey(name);
      let serialized;
      try {
        serialized = JSON.stringify(value === undefined ? null : value);
      } catch (e) {
        // Cyclic or otherwise non-JSON-serializable value. Fall back to a
        // diagnostic stub so the reader sees the failure instead of a stale
        // snapshot.
        serialized = JSON.stringify({ __crsmartProbeError: e.message });
      }
      // Only shadow into the page-readable DOM when dev probes are enabled
      // (see the privacy gate above). In production this is a no-op, so engine
      // state never reaches the host page. expose() still returns `value` so
      // producers that use the return are unaffected.
      if (devProbesOn) root().dataset[key] = serialized;
      return value;
    }

    function read(name) {
      const key = nameToDatasetKey(name);
      const raw = root().dataset[key];
      if (raw === undefined) return null;
      try { return JSON.parse(raw); }
      catch { return null; }
    }

    function unexpose(name) {
      const key = nameToDatasetKey(name);
      delete root().dataset[key];
    }

    function list() {
      const names = [];
      const r = root();
      for (let i = 0; i < r.attributes.length; i++) {
        const attr = r.attributes[i];
        if (attr.name.startsWith(PREFIX_ATTR)) {
          // Strip the prefix and convert kebab back to camel.
          const suffix = attr.name.slice(PREFIX_ATTR.length);
          const camel = suffix.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          names.push(camel);
        }
      }
      return names;
    }

    return { expose, read, unexpose, list };
  }

  // Idempotent install: if another script already mounted the surface, reuse
  // it. This matters when multiple content scripts pull the helper into the
  // same isolated world.
  const target = (typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null));
  if (!target) return; // worker context with no global — nothing to do.
  if (!target.__crsmart) target.__crsmart = makeSurface();
})();
