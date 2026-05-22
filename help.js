// Stamp the help page with the running build version so the documented
// thresholds visibly track a release. The MV3 default CSP (script-src
// 'self') blocks inline scripts, so this one-liner lives in its own file
// rather than a <script> block in help.html. Falls back to the static
// text already in the element if chrome.runtime isn't available (e.g.
// the page opened outside the extension).
(() => {
  const el = document.getElementById('help-version');
  if (!el) return;
  try {
    const v = chrome?.runtime?.getManifest?.().version;
    if (v) el.textContent = `Reflects Bingeprint v${v}`;
  } catch {
    /* keep the static fallback text */
  }
})();
