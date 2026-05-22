// Chip tint registry. Single source of truth for {source} → {bg, border,
// color, hint} mapping on the Smart Score card. Previously inline RGB
// literals were scattered across renderSignedChip / renderGenreRow /
// renderVibeRow in content.js; centralizing here surfaces the design
// decision (which palette family carries which semantic meaning) and
// makes adding a new chip type a one-row table edit rather than an
// inline-color hunt across the render layer.
//
// The `hint` field documents the semantic intent so future maintainers
// understand WHY a tint was chosen — not just what color it produces.
//
// Wrapped IIFE; exposes window.crsmartChipTint to match phrase-map /
// vibe-tags / phrase-engine conventions. Loaded by both content scripts
// and side-panel surfaces.

(() => {

// Tint palette — three semantic families:
//
//   AFFINITY (orange):     "personalized — you'll like this because…"
//                          fires for tag, genre-tag, multi-axis, studio,
//                          creator, adaptation, burnout (negative variant
//                          uses warning palette instead).
//
//   DESCRIPTIVE (lavender): "the show IS this — heads-up framing"
//                          fires for vibe-composite and vibe-single.
//                          Sits between genre (factual category) and
//                          affinity (personalized).
//
//   FACTUAL (grey):        "broad-strokes category from AniList"
//                          fires for genre row (raw genre names).
//
//   WARNING (red):         "might bug you — heads-up framing"
//                          fires for negative tag chips and burnout
//                          chips on the negative row.
//
// Each entry: { bg, border, color, hint }. bg / border / color are
// template strings — callers append the alpha + closing paren.

const PALETTES = {
  affinity: {
    bgPrefix:     'rgba(255,140,40,',
    borderPrefix: 'rgba(255,140,40,',
    colorPrefix:  'rgba(255,140,40,',
    hint:         'Personalized — why you might like this',
  },
  warning: {
    bgPrefix:     'rgba(220,80,80,',
    borderPrefix: 'rgba(220,80,80,',
    colorPrefix:  'rgba(220,80,80,',
    hint:         'Heads-up — might not land for you',
  },
  descriptive: {
    bgPrefix:     'rgba(168,140,232,',
    borderPrefix: 'rgba(168,140,232,',
    colorPrefix:  'rgba(220,205,250,',
    hint:         'The show IS this — tonal mood, not taste matching',
  },
  factual: {
    bg:     'rgba(255,255,255,0.03)',
    border: 'rgba(255,255,255,0.10)',
    color:  'rgba(255,255,255,0.70)',
    hint:   'Broad-strokes category from AniList',
  },
};

// Map ChipSpec.source + sign → palette name.
// sign defaults to 'positive' when absent.
function paletteFor(source, sign) {
  if (source === 'vibe-composite' || source === 'vibe-single') return 'descriptive';
  if (source === 'genre') return 'factual';
  if (sign === 'negative') return 'warning';
  return 'affinity';
}

// Build a chip's inline style string. Returns CSS suitable for the
// existing inline-style render path. alpha control:
//   - affinity / warning / descriptive use scaling alphas (bg 0.10,
//     border 0.30, color 0.92 — matches the previous inline values
//     exactly for visual continuity).
//   - factual uses fixed alphas embedded in the palette.
function tintStyleFor(source, sign) {
  const name = paletteFor(source, sign);
  const p = PALETTES[name];
  if (p.bg && p.border && p.color) {
    return {
      bg: p.bg, border: p.border, color: p.color, hint: p.hint, palette: name,
    };
  }
  // Descriptive uses a slightly stronger text color (0.92 of a lighter
  // RGB) for legibility against lavender background; matches the
  // previous renderVibeRow inline.
  const colorAlpha = name === 'descriptive' ? '0.92)' : '0.92)';
  const bgAlpha = name === 'descriptive' ? '0.10)' : '0.10)';
  const borderAlpha = name === 'descriptive' ? '0.28)' : '0.30)';
  return {
    bg:     p.bgPrefix + bgAlpha,
    border: p.borderPrefix + borderAlpha,
    color:  p.colorPrefix + colorAlpha,
    hint:   p.hint,
    palette: name,
  };
}

// Convenience: full inline CSS string for a chip element.
function chipStyleCss(source, sign) {
  const t = tintStyleFor(source, sign);
  return `
    display:inline-flex;align-items:center;gap:5px;
    background:${t.bg};
    border:1px solid ${t.border};
    color:${t.color};
    padding:2px 9px;border-radius:999px;
    font-size:11px;line-height:1.2;
  `;
}

if (typeof window !== 'undefined') {
  window.crsmartChipTint = { PALETTES, paletteFor, tintStyleFor, chipStyleCss };
}
if (typeof globalThis !== 'undefined') {
  globalThis.crsmartChipTint = window?.crsmartChipTint || { PALETTES, paletteFor, tintStyleFor, chipStyleCss };
}

})();
