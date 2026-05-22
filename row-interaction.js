// Shared mechanics for the survey's interactive rows. Both
// enhanceScrollRow (overflow:auto rows) and enhanceLoopRow
// (translate3d-track loop rows) share the same interaction grammar
// — drag with threshold, velocity tracking, momentum decay, idle
// drift after 5s, click-after-drag suppression, motion-direction
// CSS var, isConnected teardown — but the axis-specific physics
// differ (scroll has elastic edges + native scroll events; loop
// has translate3d wrap + manual wheel handling).
//
// Rather than fully unify the two enhancers (which differ on enough
// edge-of-axis behavior that one function would need a thicket of
// "is this scroll mode?" branches), this module extracts the parts
// that are *exactly* the same:
//
//   - Drag-end click suppression (the .dataset.dragJustEnded mechanic
//     that eats the click event after a drag so it doesn't fire on
//     the tile under the pointer)
//   - Motion-direction CSS-var writer that both modes use to drive
//     the row-frame's directional edge glow (auto-resets to 0 after
//     400ms idle so edges return to symmetric)
//   - Idle-then-drift scheduler — the 5s timer pattern with
//     reduce-motion bail
//
// Both enhancers import these helpers and stop maintaining their
// own copies, so a fix to one (e.g., the recent isConnected leak
// guard) applies in one place.

// ── Tunable constants ─────────────────────────────────────────────
// Hoisted here so both enhancers (and any future row variant) read
// from one source of truth.

export const DRAG_THRESHOLD_PX = 5;        // movement past which a tap becomes a drag
export const MOMENTUM_DECAY = 0.93;        // velocity multiplier per frame post-release
export const MIN_VELOCITY = 0.4;           // px/frame: below this, momentum stops
export const ELASTIC_RUBBER_FACTOR = 0.4;  // 1.0 = unrestricted; 0.4 = stiff
export const ELASTIC_BACK_MS = 420;        // snap-back animation duration
export const IDLE_DRIFT_DELAY_MS = 5000;   // ms after last interaction before drift starts
export const DRIFT_PX_PER_FRAME = 0.35;    // ~21px/sec at 60fps
export const MOTION_DIR_RESET_MS = 380;    // edges return to symmetric after this idle

// ── Click-after-drag suppressor ────────────────────────────────
// Both row modes set rowEl.dataset.dragJustEnded='1' on pointerup
// after a confirmed drag, then clear it 50ms later. A capture-phase
// click listener eats the click so the upstream tap-to-cycle handler
// doesn't fire on whichever tile happened to be under the pointer
// when the drag ended.
//
// attachClickSuppressor wires the eater once; markDragEnded is
// called by each mode's pointerup handler.

export function attachClickSuppressor(rowEl) {
  rowEl.addEventListener('click', (e) => {
    if (rowEl.dataset.dragJustEnded === '1') {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

export function markDragEnded(rowEl) {
  rowEl.dataset.dragJustEnded = '1';
  setTimeout(() => { delete rowEl.dataset.dragJustEnded; }, 50);
}

// ── Motion-direction CSS-var ─────────────────────────────────
// Each row sits inside a .tile-grid-rowframe wrapper. The frame's
// edge-fade overlays read --motion-dir (-1 / 0 / +1) so the leading
// edge brightens and the trailing edge dims as content slides
// through the row. This module owns the auto-reset timer so both
// modes share the "fade back to symmetric after the user stops
// driving the row" behavior.
//
// Returns a setter and a teardown — the setter writes to the
// rowframe's CSS var; the teardown clears the timer (called from
// the row's _loopTeardown).

export function createMotionDirSetter(rowEl) {
  let motionResetTimer = 0;
  function setMotionDir(dir) {
    const frame = rowEl.parentElement;
    if (!frame || !frame.classList.contains('tile-grid-rowframe')) return;
    frame.style.setProperty('--motion-dir', String(dir));
    if (motionResetTimer) clearTimeout(motionResetTimer);
    motionResetTimer = setTimeout(() => {
      frame.style.setProperty('--motion-dir', '0');
    }, MOTION_DIR_RESET_MS);
  }
  function teardown() {
    if (motionResetTimer) { clearTimeout(motionResetTimer); motionResetTimer = 0; }
  }
  return { setMotionDir, teardown };
}

// ── Idle-then-drift scheduler ───────────────────────────────
// Resets a debounced timer after each interaction; once
// IDLE_DRIFT_DELAY_MS elapses with no interaction, calls onIdle.
// reduce-motion users get a no-op resetIdle (drift is decorative).
//
// Returns:
//   { resetIdle, stop }
// Caller wires resetIdle into pointer/wheel/mouseenter handlers and
// calls stop() during teardown to cancel any pending fire.

export function createIdleScheduler(reduceMotion, onIdle) {
  let idleTimer = 0;
  function stop() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
  }
  function resetIdle() {
    stop();
    if (reduceMotion) return;
    idleTimer = setTimeout(onIdle, IDLE_DRIFT_DELAY_MS);
  }
  return { resetIdle, stop };
}

// Reduced-motion query convenience — both modes flip behaviour on
// the same `prefers-reduced-motion: reduce` rule.
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
