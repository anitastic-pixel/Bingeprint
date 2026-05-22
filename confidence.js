// Confidence module — owns the SVG ring + label that tracks the
// user's tap count. A small, cohesive surface (one tier ladder
// + one ring updater) that's used by both survey.js's tap
// handlers and apply-flow.js's summary readout.
//
// 25 taps = "rich signal" full ring; below that, fill is
// proportional; color shifts low → mid → high. Empty state shows
// a center dot + breathing animation (the dot is the empty cue,
// the CSS handles the animation via [data-empty="true"]).

import { totalTapCount } from './survey-state.js';

const CONFIDENCE_RING_FULL_TAPS = 25;
const CONFIDENCE_RING_CIRCUMFERENCE = 2 * Math.PI * 16;

// Friendly progress label per tap range. Tier classes map to the
// same three color buckets the CSS knows about.
export function confidenceLevelFor(taps) {
  if (taps >= 25) return { level: 'high', label: 'rich signal',    cls: 'confidence-high' };
  if (taps >= 15) return { level: 'high', label: 'sharp signal',   cls: 'confidence-high' };
  if (taps >= 10) return { level: 'mid',  label: 'solid signal',   cls: 'confidence-mid' };
  if (taps >= 5)  return { level: 'mid',  label: 'decent signal',  cls: 'confidence-mid' };
  if (taps >= 3)  return { level: 'low',  label: 'shape forming',  cls: 'confidence-low' };
  if (taps >= 1)  return { level: 'low',  label: 'warming up',     cls: 'confidence-low' };
  return                 { level: 'low',  label: 'tap to start',   cls: 'confidence-low' };
}

export function updateConfidenceBadge() {
  const taps = totalTapCount();
  const conf = confidenceLevelFor(taps);
  const ring = document.getElementById('confidence-badge');
  const countEl = document.getElementById('confidence-count');
  const labelEl = document.getElementById('confidence-label');
  const fillEl = document.getElementById('ring-fill');
  if (!ring || !countEl || !labelEl || !fillEl) return;

  ring.dataset.level = conf.level;
  ring.dataset.empty = taps === 0 ? 'true' : 'false';
  ring.title = taps === 0
    ? `${conf.label} — tap a tile to start`
    : `${taps} tap${taps === 1 ? '' : 's'} · ${conf.label}`;

  countEl.textContent = taps === 0 ? '·' : String(taps);
  labelEl.textContent = conf.label;

  const ratio = Math.min(1, taps / CONFIDENCE_RING_FULL_TAPS);
  const offset = CONFIDENCE_RING_CIRCUMFERENCE * (1 - ratio);
  fillEl.style.strokeDashoffset = String(offset);
}
