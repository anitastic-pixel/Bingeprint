// Isolated-world content script. Listens for token/profile captures from
// inject.js (which runs in the page world and wraps fetch). Persists the
// token to chrome.storage.session (cleared on browser restart) and the
// profileId to chrome.storage.local (stable per profile).
//
// The popup reads from these stores to show connection status, and Stage 1
// will use them to call CR's /watch-history endpoint directly.

// Track the last token we wrote so repeated captures of the same value
// (CR sends dozens of /content/v2/ calls per page load, all with the
// same Bearer) become one storage write and one log line, not thirty.
let lastTokenWritten = null;
let lastProfileWritten = null;

// When the extension is reloaded, this content script becomes orphaned
// — the chrome.runtime/.storage references go dead and any call throws
// "Extension context invalidated". Detect once, detach the listener,
// and stop firing so we don't spam errors on every CR API call.
function extensionContextAlive() {
  try { return Boolean(chrome?.runtime?.id); } catch { return false; }
}

function handleAuthMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__crsmart !== true || data.kind !== 'cr-auth') return;

  if (!extensionContextAlive()) {
    window.removeEventListener('message', handleAuthMessage);
    return;
  }

  let wroteToken = false;
  let wroteProfile = false;

  try {
    if (data.profileId && data.profileId !== lastProfileWritten) {
      chrome.storage.local.set({ profileId: data.profileId, lastSeenAt: data.ts });
      lastProfileWritten = data.profileId;
      wroteProfile = true;
    } else {
      // Touch lastSeenAt without churning profileId
      chrome.storage.local.set({ lastSeenAt: data.ts });
    }

    if (data.token && data.token !== lastTokenWritten) {
      chrome.storage.session.set({ crToken: data.token, crTokenAt: data.ts });
      lastTokenWritten = data.token;
      wroteToken = true;
    }
  } catch (err) {
    // Almost certainly "Extension context invalidated" between the
    // alive-check and the .set call. Detach and go silent.
    window.removeEventListener('message', handleAuthMessage);
    return;
  }

  // Only log on actual writes — duplicate captures are silent. Token
  // value never logged.
  if (wroteToken || wroteProfile) {
    console.log('[crsmart] bridge: wrote', {
      token: wroteToken,
      profileId: wroteProfile,
    });
  }
}

window.addEventListener('message', handleAuthMessage);
