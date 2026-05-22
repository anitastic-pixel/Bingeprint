// import-state-channel — single seam for observing the cross-source
// `_importState` storage key.
//
// Two consumers today, both formerly hand-rolling their own observer:
//   - popup.js's external-source panel — was polling every 1500ms via
//     setTimeout, paying IPC + render cost ~40×/min during long imports,
//     reflecting completion up to 1.5s stale.
//   - import-mal-xml.html's progress UI — was registering an inline
//     chrome.storage.onChanged listener with its own filter logic.
//
// One subscription path, event-driven, no polling. Returns unsubscribe.
//
// Lives outside external-list-importer.js so importing the subscription
// helper doesn't drag the AniList / MAL clients into the popup's module
// graph — those weigh ~1500 lines of code with side-effecting provider
// registrations at module load.

const IMPORT_STATE_KEY = '_importState';

// subscribeImportState(handler) — handler receives the new _importState
// value (or null when the key was removed) on every storage.local
// change. Returns an unsubscribe function; callers in long-lived
// surfaces (the import page) call it on teardown; the popup doesn't
// have to (the listener dies with the popup's JS context).
export function subscribeImportState(handler) {
  function listener(changes, area) {
    if (area !== 'local') return;
    if (!(IMPORT_STATE_KEY in changes)) return;
    handler(changes[IMPORT_STATE_KEY].newValue ?? null);
  }
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// readImportState() — one-shot read of the current _importState. Useful
// for surfaces that need the value before the first change event lands
// (popup open while an import is mid-flight).
export async function readImportState() {
  const stored = await chrome.storage.local.get(IMPORT_STATE_KEY);
  return stored[IMPORT_STATE_KEY] ?? null;
}
