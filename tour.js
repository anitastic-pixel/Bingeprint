// Onboarding tour overlay — DOM-injected modal on Crunchyroll showing
// 5 narrative-arc slides about what Smart Scoring is, how it learns,
// what it surfaces, and where to start. Replaces the old welcome.html.
//
// Architecture (locked via /grill-me design pass, see commit history):
//
//   Surface:        DOM-injected fixed-position modal mounted as
//                   document.body.lastChild (sibling of CR's React root,
//                   so React re-renders can't blow it away).
//   Sizing:         min(82vw, 1080px) × min(78vh, 700px), min 640×480.
//                   z-index just below 32-bit max; full-viewport dim backdrop.
//   Trigger:        message 'crsmart:show-tour' from background, OR
//                   chrome.storage.session 'crsmart:auto-open-tour' flag
//                   set by background's install handler.
//   Lifecycle:      one-shot. tourSeen.dismissedAt set on every close;
//                   tourSeen.completedAt set the first time the user
//                   reaches slide 5 (sticky). Re-watch only via popup
//                   menu's "Show me around again."
//   Navigation:     free — slide dots clickable, ←/→ keys, Esc closes,
//                   "Skip to setup →" jumps to slide 5. No backdrop
//                   click-dismiss.
//   Reduced motion: prefers-reduced-motion skips animations entirely
//                   (final state shown immediately). Implemented via
//                   @media wrapping in tour.css — no JS gating needed.
//   Fullscreen:     if CR is in fullscreen-video mode at fire time,
//                   defer mount until exit (one-shot fullscreenchange).

const TOTAL_SLIDES = 6;
const OVERLAY_ID = 'crsmart-tour-overlay';
const STORAGE_KEY = 'tourSeen';
const SESSION_FLAG = 'crsmart:auto-open-tour';

// Module-level state. Single overlay at a time — re-firing while one
// is mounted is a no-op. previouslyFocusedEl lets us return focus to
// whichever element opened the tour (top-bar button or popup CTA) on
// close, so keyboard users land back where they were.
let overlayEl = null;
let currentSlide = 1;
let savedBodyOverflow = null;
let previouslyFocusedEl = null;

// Slide-1 ladder. Cycles every 4s while slide 1 is active to teach the
// full Smart Score vocabulary — score, tier, positive AND negative chips.
// Picking the full tier ladder (not just top-tier examples) so users see
// "the card tells you when NOT to bother" before they ever set up their
// taste profile. Shows are deliberately recognisable mainstream picks
// (Frieren, Mushishi, Demon Slayer, Solo Leveling, Naruto) — concrete
// names the viewer will know, with chip text that lands as opinionated
// rather than pulled from a feature list.
//
// Each entry's `gradients` is the multi-background fallback that renders
// when the cover JPG is missing or 404s; tinted per show so the tour
// still feels visually distinct even before the cover assets are added.
// `score` drives the ring fill via the --ring-end custom property
// (see tour.css @keyframes ring-fill). `tierClass` selects one of the
// .mock-tier-{trust,worth,stretch,probably,skip} colour rules.
const SLIDE1_CARDS = [
  {
    title: "Frieren: Beyond Journey's End",
    sub: 'Drama · Fantasy · 28 episodes',
    cover: 'images/covers/frieren-154587.jpg',
    score: 92,
    tier: 'TRUST ME',
    tierClass: 'mock-tier-trust',
    gradients: 'linear-gradient(135deg, rgba(180, 80, 255, 0.22), rgba(255, 140, 40, 0.12) 70%), linear-gradient(rgba(40, 28, 22, 0.95), rgba(20, 14, 10, 0.95))',
    chips: [
      { sign: '+', text: 'Slice-of-life fantasy' },
      { sign: '+', text: 'Madhouse track record' },
      { sign: '+', text: 'Reflective tone' },
      { sign: '+', text: 'Award-winning craft' },
    ],
  },
  {
    title: 'Mushishi',
    sub: 'Drama · Slice of Life · 26 episodes',
    cover: 'images/covers/mushishi-457.png',
    score: 95,
    tier: 'TRUST ME',
    tierClass: 'mock-tier-trust',
    gradients: 'linear-gradient(135deg, rgba(80, 180, 140, 0.24), rgba(60, 140, 180, 0.14) 70%), linear-gradient(rgba(20, 32, 26, 0.95), rgba(10, 20, 16, 0.95))',
    chips: [
      { sign: '+', text: 'Quiet anthology pacing' },
      { sign: '+', text: 'Folkloric atmosphere' },
      { sign: '+', text: 'Reflective tone' },
      { sign: '+', text: 'Peak Artland craft' },
    ],
  },
  {
    title: 'Demon Slayer',
    sub: 'Action · Supernatural · 26 episodes',
    cover: 'images/covers/demon-slayer-101922.png',
    score: 71,
    tier: 'WORTH A SHOT',
    tierClass: 'mock-tier-worth',
    gradients: 'linear-gradient(135deg, rgba(231, 76, 60, 0.24), rgba(255, 140, 40, 0.16) 70%), linear-gradient(rgba(40, 22, 18, 0.95), rgba(20, 12, 10, 0.95))',
    chips: [
      { sign: '+', text: 'ufotable spectacle' },
      { sign: '+', text: 'Found-family beats' },
      { sign: '−', text: 'Long shōnen arcs' },
      { sign: '−', text: 'Power-up formula' },
    ],
  },
  {
    title: 'Solo Leveling',
    sub: 'Action · Fantasy · 12 episodes',
    cover: 'images/covers/solo-leveling-153406.png',
    score: 54,
    tier: 'STRETCH',
    tierClass: 'mock-tier-stretch',
    gradients: 'linear-gradient(135deg, rgba(80, 120, 220, 0.24), rgba(140, 80, 220, 0.14) 70%), linear-gradient(rgba(18, 22, 38, 0.95), rgba(10, 12, 22, 0.95))',
    chips: [
      { sign: '+', text: 'Slick set pieces' },
      { sign: '−', text: 'Power-fantasy lead' },
      { sign: '−', text: 'Thin worldbuilding' },
      { sign: '−', text: 'Shallow side cast' },
    ],
  },
  {
    title: 'Naruto',
    sub: 'Action · Adventure · 220 episodes',
    cover: 'images/covers/naruto-20.jpg',
    score: 31,
    tier: 'SKIP',
    tierClass: 'mock-tier-skip',
    gradients: 'linear-gradient(135deg, rgba(166, 77, 77, 0.22), rgba(160, 154, 138, 0.12) 70%), linear-gradient(rgba(38, 22, 20, 0.95), rgba(20, 12, 10, 0.95))',
    chips: [
      { sign: '−', text: '50% filler episodes' },
      { sign: '−', text: 'Outdated 2000s pacing' },
      { sign: '−', text: 'Shōnen formula fatigue' },
      { sign: '−', text: 'Not your franchise habit' },
    ],
  },
];
const SLIDE1_CYCLE_MS = 5000;

// Side-panel slide — per-vibe ranked lists. Clicking a vibe chip swaps
// the active chip and re-renders the list with a stagger animation.
// Lists are curated to plausibly fit the vibe label so the demo lands
// as "the engine actually re-ranks for mood" rather than "pretty
// shuffle." Each entry: { rank, title, score }.
const SIDEPANEL_LISTS = {
  'low-key': [
    { rank: 1, title: 'Mushishi',                 score: 93 },
    { rank: 2, title: 'Vinland Saga',             score: 91 },
    { rank: 3, title: 'Frieren',                  score: 90 },
    { rank: 4, title: 'Cyberpunk: Edgerunners',   score: 87 },
    { rank: 5, title: 'Monster',                  score: 85 },
  ],
  'tearjerker': [
    { rank: 1, title: 'Violet Evergarden',        score: 92 },
    { rank: 2, title: 'A Silent Voice',           score: 91 },
    { rank: 3, title: 'Your Lie in April',        score: 89 },
    { rank: 4, title: 'Anohana',                  score: 87 },
    { rank: 5, title: 'Clannad: After Story',     score: 86 },
  ],
  'stylish': [
    { rank: 1, title: 'Cyberpunk: Edgerunners',   score: 93 },
    { rank: 2, title: 'Devilman Crybaby',         score: 90 },
    { rank: 3, title: 'Cowboy Bebop',             score: 89 },
    { rank: 4, title: 'Dorohedoro',               score: 86 },
    { rank: 5, title: 'Mob Psycho 100',           score: 85 },
  ],
  'funny': [
    { rank: 1, title: 'Mob Psycho 100',           score: 91 },
    { rank: 2, title: 'One-Punch Man',            score: 89 },
    { rank: 3, title: 'Konosuba',                 score: 87 },
    { rank: 4, title: 'Saiki K',                  score: 86 },
    { rank: 5, title: 'Gintama',                  score: 84 },
  ],
};
const SIDEPANEL_DEFAULT_VIBE = 'low-key';

// Slide-1 cycle state. setInterval fires every 4s while slide 1 is the
// active slide; clears when leaving slide 1 or closing the overlay.
let slide1CycleTimer = null;
let slide1CycleIndex = 0;

// ── Storage helpers ─────────────────────────────────────────────

async function readTourSeen() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] || null;
  } catch (_) { return null; }
}

async function writeTourSeen(patch) {
  try {
    const cur = (await readTourSeen()) || {};
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (_) { /* best-effort */ }
}

// Marks first-open if not already set. Idempotent.
async function markOpened() {
  const cur = await readTourSeen();
  if (cur?.at) return;
  await writeTourSeen({ at: Date.now() });
}

// Local-only funnel metrics — no telemetry, just a counter the
// author can read from chrome.storage.local._tourMetrics to see
// which slides users actually reach. Per-slide view counts are
// incremented exactly once per mount (a single tour walkthrough
// counts as 1 view per visited slide regardless of back-and-forth).
const SEEN_THIS_MOUNT = new Set();
async function trackSlideView(n) {
  if (SEEN_THIS_MOUNT.has(n)) return;
  SEEN_THIS_MOUNT.add(n);
  try {
    const stored = await chrome.storage.local.get('_tourMetrics');
    const m = stored._tourMetrics || { slidesViewed: {}, mounts: 0, completes: 0 };
    m.slidesViewed[n] = (m.slidesViewed[n] || 0) + 1;
    await chrome.storage.local.set({ _tourMetrics: m });
  } catch (_) {}
}
async function bumpFunnelCounter(field) {
  try {
    const stored = await chrome.storage.local.get('_tourMetrics');
    const m = stored._tourMetrics || { slidesViewed: {}, mounts: 0, completes: 0 };
    m[field] = (m[field] || 0) + 1;
    await chrome.storage.local.set({ _tourMetrics: m });
  } catch (_) {}
}

// Help-link markup for slide 6's actions panel. Button (not anchor) +
// background-message to open help.html in a new tab — direct
// `<a target="_blank" href="chrome-extension://...">` from a
// content-script context on crunchyroll.com gets blocked as a
// cross-origin redirect (ERR_BLOCKED_BY_CLIENT) by some content
// blockers and Chrome configurations. Routing the open through the
// service worker's chrome.tabs.create bypasses that, the same way
// ctaSurvey opens survey.html. Used in both buildSlide5 (cold-start)
// and customizeSlide5State (re-watcher).
function tourHelpLinkHtml() {
  return `<button class="tour-help-link" id="crsmart-tour-cta-help" type="button">How this actually works →</button>`;
}

// Re-render slide 5's title/body/CTAs based on the user's actual
// progress. Cold-start (no signal) keeps the default "Pick how to
// start" view. If the user has already engaged — surveyShapes count
// > 0 OR AniList linked OR tourSeen.completedAt set — we swap to
// re-watcher messaging that matches where they actually are.
async function customizeSlide5State() {
  if (!overlayEl) return;
  const titleEl = overlayEl.querySelector('#slide-5-title');
  const bodyEl = overlayEl.querySelector('#slide-5-body');
  const actionsEl = overlayEl.querySelector('#slide-5-actions');
  if (!titleEl || !bodyEl || !actionsEl) return;

  let surveyTaps = 0;
  let aniListLinked = false;
  let alreadyCompleted = false;
  try {
    const stored = await chrome.storage.local.get([
      'surveyShapes', 'surveyTagShapes', 'tourSeen',
    ]);
    surveyTaps = Object.keys(stored.surveyShapes || {}).length
               + Object.keys(stored.surveyTagShapes || {}).length;
    alreadyCompleted = !!stored.tourSeen?.completedAt;
  } catch (_) {}
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'crsmart:external:status' });
    aniListLinked = !!(resp?.ok && (resp.linked || []).includes('anilist'));
  } catch (_) {}

  const hasAnyProgress = surveyTaps > 0 || aniListLinked || alreadyCompleted;
  if (!hasAnyProgress) return;  // cold-start view stays put

  // Re-watcher view — messaging adapts to what they've already done.
  titleEl.textContent = 'Pick up where you left off';
  if (surveyTaps > 0 && aniListLinked) {
    bodyEl.textContent =
      "You're set up — both the survey and AniList are feeding the engine. " +
      "Open Smart Picks to see what's ranking right now.";
  } else if (surveyTaps > 0) {
    bodyEl.textContent =
      `Your survey has ${surveyTaps} tap${surveyTaps === 1 ? '' : 's'} so far. ` +
      "Refine it or open Smart Picks to see where the engine is.";
  } else if (aniListLinked) {
    bodyEl.textContent =
      "AniList is connected and feeding the engine. " +
      "Open Smart Picks to see your ranked recommendations.";
  } else {
    bodyEl.textContent =
      "Looks like you've poked around before. Pick a path to keep building " +
      "your taste profile, or just dive into Smart Picks.";
  }

  // Build adaptive CTAs.
  const primaryAction = aniListLinked || surveyTaps >= 10
    ? { id: 'crsmart-tour-cta-picks',  title: 'Open Smart Picks',
        meta: 'See your ranked recommendations',
        preview: 'Opens the side panel on this tab' }
    : { id: 'crsmart-tour-cta-survey', title: 'Continue Quick Taste Check',
        meta: `Pick up where you left off · ${surveyTaps} tap${surveyTaps === 1 ? '' : 's'} so far`,
        preview: 'Opens the survey in a new tab' };
  const secondaryAction = aniListLinked
    ? { id: 'crsmart-tour-cta-survey', title: 'Refine your taste',
        meta: 'Open the Quick Taste Check',
        preview: 'Opens the survey in a new tab' }
    : { id: 'crsmart-tour-cta-anilist', title: 'Connect AniList',
        meta: 'Sign in once, we read your scored shows',
        preview: 'Opens AniList sign-in, then imports in the background' };

  actionsEl.innerHTML = `
    <button class="tour-cta tour-cta-primary" id="${primaryAction.id}" type="button">
      <span class="tour-cta-title">${primaryAction.title}</span>
      <span class="tour-cta-meta">${primaryAction.meta}</span>
      <span class="tour-cta-preview">${primaryAction.preview}</span>
    </button>
    <button class="tour-cta tour-cta-secondary" id="${secondaryAction.id}" type="button">
      <span class="tour-cta-title">${secondaryAction.title}</span>
      <span class="tour-cta-meta">${secondaryAction.meta}</span>
      <span class="tour-cta-preview">${secondaryAction.preview}</span>
    </button>
    ${tourHelpLinkHtml()}
    <button class="tour-dismiss-link" id="crsmart-tour-cta-skip" type="button">
      Close — I'm just watching
    </button>`;
}

// ── Slide builders ──────────────────────────────────────────────
// Each slide returns the inner DOM for that slide (excluding the
// outer .crsmart-tour-slide wrapper). The wrapper carries the slide
// index so CSS can target slide-specific animations via :nth-child.

function buildSlide1() {
  const el = document.createElement('div');
  el.className = 'crsmart-slide-content slide-1';
  // Slide 1 also hosts the once-shown keyboard-shortcut hint that
  // teaches power-user navigation. It auto-fades after a few seconds
  // via CSS so it doesn't permanently clutter the slide.
  //
  // The hero box (poster + title + score card) is rendered from
  // SLIDE1_CARDS — initial render uses index 0 (Frieren); the cycle
  // timer swaps everything (cover, title, sub, score, tier, chips)
  // every 4s while slide 1 is the active slide. See cycleSlide1().
  el.innerHTML = `
    <div class="slide-text">
      <h2 class="slide-title">Tells you if a show's for <em>you</em></h2>
      <p class="slide-body">
        On every Crunchyroll series page, a Smart Score card tells you
        whether to invest the next 12 hours of your life. The number is
        yours. The chips below it are the <em>why</em>.
      </p>
      <p class="slide-keyboard-hint" aria-hidden="true">
        Tip: <kbd>←</kbd> <kbd>→</kbd> to navigate · <kbd>Esc</kbd> to close
      </p>
    </div>
    <div class="slide-visual">
      <div class="mock-hero">
        <div class="mock-hero-bg"></div>
        <div class="mock-hero-poster" aria-hidden="true"></div>
        <div class="mock-hero-meta">
          <div class="mock-hero-title"></div>
          <div class="mock-hero-sub"></div>
        </div>
      </div>
    </div>`;
  // Populate first card. Initial render uses NO .is-cycle-card class so
  // the existing slow .is-playing animations apply (matches the original
  // 2.6s narrative reveal). Subsequent cycle cards add .is-cycle-card to
  // pick up the faster timings (see CSS).
  const first = SLIDE1_CARDS[0];
  populateSlide1HeroChrome(el, first);
  el.querySelector('.mock-hero').appendChild(buildSlide1HeroCard(first));
  return el;
}

// Build the inner score-card element for a given card config. Returns a
// fresh DOM node — the cycle calls this on each tick to get an element
// whose CSS animations restart automatically on insertion (vs. trying to
// retrigger animations on the existing element, which is brittle across
// browsers).
function buildSlide1HeroCard(card) {
  const div = document.createElement('div');
  div.className = 'mock-hero-card';
  // Ring fill — stroke-dasharray is the circle's circumference (≈176
  // for r=28). stroke-dashoffset goes from 176 (empty) to --ring-end
  // (proportional to the score: 176 × (1 − score/100)). The keyframe
  // reads var(--ring-end), so each card's ring fills to a different
  // proportion of the circle.
  const ringEnd = (176 * (1 - card.score / 100)).toFixed(1);
  const chipsHtml = card.chips.map(c => {
    const polarity = c.sign === '+' ? 'mock-chip-pos' : 'mock-chip-neg';
    return `<span class="mock-chip ${polarity}">${c.sign} ${c.text}</span>`;
  }).join('');
  div.innerHTML = `
    <div class="mock-card-ring">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="28" class="mock-ring-bg"/>
        <circle cx="32" cy="32" r="28" class="mock-ring-fill"
                stroke-dasharray="176" stroke-dashoffset="176"
                style="--ring-end: ${ringEnd}"/>
      </svg>
      <span class="mock-card-score" data-final="${card.score}">0</span>
    </div>
    <div class="mock-card-body">
      <span class="mock-tier ${card.tierClass}">${card.tier}</span>
      <div class="mock-card-chips">${chipsHtml}</div>
    </div>`;
  return div;
}

// Update the poster cover + title/sub text to match a card config. The
// poster + meta are kept across cycles (only their content swaps); the
// score-card element itself is replaced via DOM. This is so the cover
// fade is a soft opacity transition while the card does a more
// pronounced rise/fall — the two motions read as part of the same
// "next show" moment without competing.
function populateSlide1HeroChrome(slideRoot, card) {
  const poster = slideRoot.querySelector('.mock-hero-poster');
  if (poster) poster.style.backgroundImage = buildSlide1PosterBackground(card);
  const titleEl = slideRoot.querySelector('.mock-hero-title');
  if (titleEl) titleEl.textContent = card.title;
  const subEl = slideRoot.querySelector('.mock-hero-sub');
  if (subEl) subEl.textContent = card.sub;
}

function buildSlide1PosterBackground(card) {
  // Cover-art URL via chrome.runtime.getURL — content-script CSS can't
  // resolve extension-relative URLs, but inline style with the absolute
  // chrome-extension:// URL does. If the JPG is missing (404), browsers
  // fall back to the next layer in the multi-background, which is the
  // per-card gradient defined in SLIDE1_CARDS — keeps each card visually
  // distinct even before cover assets are added.
  let coverUrl = '';
  try { coverUrl = chrome.runtime.getURL(card.cover); } catch (_) {}
  return `url('${coverUrl}'), ${card.gradients}`;
}

function buildSlide2() {
  const el = document.createElement('div');
  el.className = 'crsmart-slide-content slide-2';
  el.innerHTML = `
    <div class="slide-text">
      <h2 class="slide-title">What's for <em>you</em>, not what's popular</h2>
      <p class="slide-body">
        Crunchyroll's homepage shows what's trending across all viewers.
        Smart Picks ranks the same catalog against <em>your</em> taste —
        so what's at the top reflects you, not the broader audience.
      </p>
    </div>
    <div class="slide-visual slide-2-lists">
      <div class="mock-list mock-list-cr">
        <div class="mock-list-head">
          <span>Trending on CR</span>
          <span class="mock-list-tag mock-list-tag-popular">popular</span>
        </div>
        <ol class="mock-list-items">
          <li><span>1</span><span class="mock-list-title">Demon Slayer</span></li>
          <li><span>2</span><span class="mock-list-title">Jujutsu Kaisen</span></li>
          <li><span>3</span><span class="mock-list-title">My Hero Academia</span></li>
          <li><span>4</span><span class="mock-list-title">Chainsaw Man</span></li>
          <li><span>5</span><span class="mock-list-title">Solo Leveling</span></li>
        </ol>
      </div>
      <div class="mock-list mock-list-you">
        <div class="mock-list-head">
          <span>Your Smart Picks</span>
          <span class="mock-list-tag mock-list-tag-yours">yours</span>
        </div>
        <ol class="mock-list-items">
          <li><span>1</span><span class="mock-list-title">Mushishi</span><span class="mock-list-score">93</span></li>
          <li><span>2</span><span class="mock-list-title">Vinland Saga</span><span class="mock-list-score">91</span></li>
          <li><span>3</span><span class="mock-list-title">Frieren</span><span class="mock-list-score">90</span></li>
          <li><span>4</span><span class="mock-list-title">Cyberpunk: Edgerunners</span><span class="mock-list-score">87</span></li>
          <li><span>5</span><span class="mock-list-title">Monster</span><span class="mock-list-score">85</span></li>
        </ol>
      </div>
    </div>`;
  return el;
}

// Side-panel + vibes slide. Inserted at position 3 in SLIDE_BUILDERS
// (between Differentiation and Privacy). Teaches users that a ranked
// list of all picks lives behind the sparkle ✦ in CR's top bar AND
// that the list adapts to today's mood via vibe chips. Without this
// slide a user might never discover the panel — they'd only ever
// see per-show scores via the in-page card.
//
// Class is .slide-side-panel (not .slide-N) so its CSS rules don't
// collide with any of the numbered-slide selectors. The data-slide
// attribute on the wrapper is still numeric (set by the build loop).
function buildSlideSidePanel() {
  const el = document.createElement('div');
  el.className = 'crsmart-slide-content slide-side-panel';
  // Vibe chips are <button> (not <span>) so they're keyboard-focusable
  // and announce as buttons to screen readers — the slide is sold on
  // "tap to filter," and the affordance has to actually work for tab
  // users. CSS resets default button chrome (background, font) back to
  // the chip aesthetic. Click handler lives on the overlay itself
  // (event delegation) — see buildOverlay.
  const vibes = ['low-key', 'tearjerker', 'stylish', 'funny'];
  const chipsHtml = vibes.map(v => {
    const active = v === SIDEPANEL_DEFAULT_VIBE ? ' is-active' : '';
    return `<button type="button" class="mock-vibe-chip${active}" data-vibe="${v}">${v}</button>`;
  }).join('');
  el.innerHTML = `
    <div class="slide-text">
      <h2 class="slide-title">All your picks, <em>ranked</em></h2>
      <p class="slide-body">
        The sparkle <span class="slide-sparkle">✦</span> in
        Crunchyroll's top bar opens a side panel with every show
        ranked against your taste — not just the one you're on.
      </p>
      <p class="slide-body">
        Filter by today's mood with a single tap. Want
        <em>low-key</em> tonight? <em>Tearjerker</em>? <em>Stylish</em>?
        The list re-ranks instantly without retraining your taste.
      </p>
    </div>
    <div class="slide-visual">
      <div class="mock-sidepanel">
        <div class="mock-sidepanel-head">
          <span class="mock-sidepanel-title">Smart Picks</span>
          <span class="mock-sidepanel-mode">Peak</span>
        </div>
        <div class="mock-vibes-row">
          <span class="mock-vibe-label">vibe today:</span>
          ${chipsHtml}
        </div>
        <ol class="mock-sidepanel-list">${renderSidepanelListItems(SIDEPANEL_DEFAULT_VIBE)}</ol>
      </div>
    </div>`;
  return el;
}

function renderSidepanelListItems(vibe) {
  const items = SIDEPANEL_LISTS[vibe] || SIDEPANEL_LISTS[SIDEPANEL_DEFAULT_VIBE];
  return items.map(it =>
    `<li><span class="sp-rank">${it.rank}</span>` +
    `<span class="sp-title">${it.title}</span>` +
    `<span class="sp-score">${it.score}</span></li>`
  ).join('');
}

// Re-rank handler. Two-phase: items fade-out + slide right, then list
// innerHTML swaps and items fade-in + slide from left with a per-row
// stagger. Total ~440ms — fast enough that rapid clicks feel responsive,
// slow enough that the eye can track the change as a list re-rank
// rather than an instant snap. Re-clicking the active chip is a no-op.
function handleVibeChipClick(chip) {
  const vibe = chip.dataset.vibe;
  if (!vibe || !SIDEPANEL_LISTS[vibe]) return;
  if (chip.classList.contains('is-active')) return;

  const sidepanel = chip.closest('.mock-sidepanel');
  const list = sidepanel?.querySelector('.mock-sidepanel-list');
  if (!sidepanel || !list) return;

  // Move .is-active to the clicked chip. The chip-fade-in animation on
  // each chip's nth-child rule still holds its forwards end-state, so
  // toggling .is-active doesn't restart that fade — only the pulse
  // pseudo-element appears/disappears.
  sidepanel.querySelectorAll('.mock-vibe-chip').forEach(c => {
    c.classList.toggle('is-active', c === chip);
  });

  // Swap-out, then swap-in. Force reflow between class toggles so the
  // browser commits the cleared state before applying the new animation
  // (otherwise the swap classes can be coalesced and the animation skips).
  // .is-swapping-in stays on permanently after the first swap — see the
  // comment on the .is-swapping-* CSS rules for why removing it would
  // expose the slide's original 700ms-delayed chip-fade-in animation.
  list.classList.remove('is-swapping-in');
  void list.offsetHeight;
  list.classList.add('is-swapping-out');

  setTimeout(() => {
    list.innerHTML = renderSidepanelListItems(vibe);
    list.classList.remove('is-swapping-out');
    void list.offsetHeight;
    list.classList.add('is-swapping-in');
  }, 160);
}

function buildSlide3() {
  const el = document.createElement('div');
  el.className = 'crsmart-slide-content slide-3';
  el.innerHTML = `
    <div class="slide-text">
      <h2 class="slide-title">All <em>local</em>. No servers, no telemetry.</h2>
      <p class="slide-body">
        Watch counts, ratings, an optional AniList import, a few survey
        taps — that's the whole input list. Everything stays in your
        browser. There's no account to sign up for, and no "us" to leak
        anything.
      </p>
    </div>
    <div class="slide-visual slide-3-graph">
      <!-- SVG layer with 4 dashed lines connecting each signal pill
           to the central lock. Coordinates computed from actual
           measured DOM positions of the pills and lock circle in
           the 380×380 graph:

             Lock circle:      center (251, 238), radius 48
             Watch pill:       center  (63,  42), 125×41 outline
             Rate  pill:       center (326,  41), 109×41 outline
             List  pill:       center  (62, 335), 124×41 outline
             Tap   pill:       center (329, 334), 104×41 outline

           Each line:
             - STARTS at the pill's outer border (where the line from
               pill center to lock center exits the pill rectangle).
             - ENDS on the lock circle's orange ring (48px radius
               from the lock's actual center, not the graph geometric
               center — the lock sits below+right because .engine-node
               also contains the label below the lock).

           Note the lock isn't at the graph's geometric center because
           the .engine-node flex column is centered at (190,190) but
           the lock-big circle sits AT THE TOP of that column with the
           label below, shifting the visible lock circle down+right of
           the geometric midpoint. Anchors below match the live DOM. -->
      <svg class="slide-3-connections" viewBox="0 0 380 380" aria-hidden="true">
        <line x1="90"  y1="67"  x2="160" y2="153"/>
        <line x1="300" y1="67"  x2="222" y2="154"/>
        <line x1="90"  y1="309" x2="159" y2="227"/>
        <line x1="301" y1="310" x2="222" y2="225"/>
      </svg>
      <div class="signal signal-watch">
        <span class="signal-icon">▶</span>
        <span class="signal-text">
          <span class="signal-count">47</span>
          <span class="signal-label">watched</span>
        </span>
      </div>
      <div class="signal signal-rate">
        <span class="signal-icon">★</span>
        <span class="signal-text">
          <span class="signal-count">12</span>
          <span class="signal-label">rated</span>
        </span>
      </div>
      <div class="signal signal-list">
        <span class="signal-icon">≡</span>
        <span class="signal-text">
          <span class="signal-count">230</span>
          <span class="signal-label">AniList</span>
        </span>
      </div>
      <div class="signal signal-tap">
        <span class="signal-icon">♥</span>
        <span class="signal-text">
          <span class="signal-count">30</span>
          <span class="signal-label">taps</span>
        </span>
      </div>
      <div class="engine-node">
        <div class="engine-lock-big" aria-label="Stays in your browser">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2"/>
            <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
          </svg>
        </div>
        <div class="engine-lock-label">stays in your browser</div>
      </div>
    </div>`;
  return el;
}

function buildSlide4() {
  const el = document.createElement('div');
  el.className = 'crsmart-slide-content slide-4';
  // Polygon points are computed from per-axis values [0..1] traced
  // along the actual spoke endpoints (so a spike value of 1.0 reaches
  // the outer ring vertex on that axis). Cycling between three sample
  // profiles teaches the user that the shape varies meaningfully per
  // person.
  //
  // Center: (200, 160). Outer-ring vertices match the spokes:
  //   Spectacle (top, vx,vy=200,60)   — direction (0,-100)
  //   Narrative (NE,    266.5,92.5)   — (66.5, -67.5)
  //   Character (E,     300,160)      — (100, 0)
  //   Emotion   (SE,    266.5,227.5)  — (66.5, 67.5)
  //   Comfort   (S,     200,260)      — (0, 100)
  //   Comedy    (SW,    133.5,227.5)  — (-66.5, 67.5)
  //   Romance   (W,     100,160)      — (-100, 0)
  //   Curiosity (NW,    133.5,92.5)   — (-66.5, -67.5)
  //
  // Per axis, polygon vertex = (cx + value * dx, cy + value * dy).
  // This guarantees the visible shape is a literal trace of the
  // axis values rather than arbitrary numbers.
  const CENTER = [200, 160];
  const AXIS_DIRS = [
    [0, -100],     // Spectacle
    [66.5, -67.5], // Narrative
    [100, 0],      // Character
    [66.5, 67.5],  // Emotion
    [0, 100],      // Comfort
    [-66.5, 67.5], // Comedy
    [-100, 0],     // Romance
    [-66.5, -67.5],// Curiosity
  ];
  const polyFromValues = vals => vals.map((v, i) => {
    const [dx, dy] = AXIS_DIRS[i];
    const x = (CENTER[0] + v * dx).toFixed(1);
    const y = (CENTER[1] + v * dy).toFixed(1);
    return `${x},${y}`;
  }).join(' ');

  // Three sample profiles. Order: [Spectacle, Narrative, Character,
  // Emotion, Comfort, Comedy, Romance, Curiosity].
  //   AUTEUR — narrative + character + curiosity dominant.
  //            Mushishi/Vinland Saga/Frieren shape.
  //   COMFORT — comfort + romance + character dominant.
  //             Slice-of-life + josei + chill romcom shape.
  //   SPECTACLE — spectacle + emotion + comedy dominant.
  //               Demon Slayer/Cyberpunk/Mob Psycho shape.
  const auteurPoly =
    polyFromValues([0.40, 0.85, 0.75, 0.55, 0.40, 0.20, 0.15, 0.80]);
  const comfortPoly =
    polyFromValues([0.20, 0.45, 0.85, 0.30, 0.95, 0.50, 0.85, 0.30]);
  const spectaclePoly =
    polyFromValues([0.95, 0.30, 0.50, 0.85, 0.20, 0.65, 0.30, 0.40]);

  el.innerHTML = `
    <div class="slide-text">
      <h2 class="slide-title">Your taste, as a <em>shape</em></h2>
      <p class="slide-body">
        Eight ways anime can be different — action vs comfort,
        story-driven vs character-driven, mainstream vs niche. The
        longer the spike, the more you gravitate that way.
      </p>
      <p class="slide-body slide-4-caption">
        Shapes vary per person — yours will be unique. Watch it
        sharpen as you tap, watch, and rate.
      </p>
    </div>
    <div class="slide-visual">
      <svg class="mock-radar" viewBox="0 0 400 320" aria-hidden="true">
        <polygon class="mock-radar-ring" points="200,60 266.5,92.5 300,160 266.5,227.5 200,260 133.5,227.5 100,160 133.5,92.5"/>
        <polygon class="mock-radar-ring" points="200,93 244.3,114.7 266.7,160 244.3,205.3 200,227 155.7,205.3 133.3,160 155.7,114.7"/>
        <polygon class="mock-radar-ring" points="200,127 222.1,136.9 233.3,160 222.1,183.1 200,193 177.9,183.1 166.7,160 177.9,136.9"/>

        <line class="mock-radar-spoke" x1="200" y1="160" x2="200" y2="60"/>
        <line class="mock-radar-spoke" x1="200" y1="160" x2="266.5" y2="92.5"/>
        <line class="mock-radar-spoke" x1="200" y1="160" x2="300" y2="160"/>
        <line class="mock-radar-spoke" x1="200" y1="160" x2="266.5" y2="227.5"/>
        <line class="mock-radar-spoke" x1="200" y1="160" x2="200" y2="260"/>
        <line class="mock-radar-spoke" x1="200" y1="160" x2="133.5" y2="227.5"/>
        <line class="mock-radar-spoke" x1="200" y1="160" x2="100" y2="160"/>
        <line class="mock-radar-spoke" x1="200" y1="160" x2="133.5" y2="92.5"/>

        <polygon class="mock-radar-shape shape-auteur"    points="${auteurPoly}"/>
        <polygon class="mock-radar-shape shape-comfort"   points="${comfortPoly}"/>
        <polygon class="mock-radar-shape shape-spectacle" points="${spectaclePoly}"/>

        <text x="200" y="42" text-anchor="middle" class="mock-radar-label">Spectacle</text>
        <text x="282" y="85" text-anchor="start" class="mock-radar-label">Narrative</text>
        <text x="312" y="163" text-anchor="start" class="mock-radar-label">Character</text>
        <text x="282" y="240" text-anchor="start" class="mock-radar-label">Emotion</text>
        <text x="200" y="282" text-anchor="middle" class="mock-radar-label">Comfort</text>
        <text x="118" y="240" text-anchor="end" class="mock-radar-label">Comedy</text>
        <text x="88" y="163" text-anchor="end" class="mock-radar-label">Romance</text>
        <text x="118" y="85" text-anchor="end" class="mock-radar-label">Curiosity</text>
      </svg>
    </div>`;
  return el;
}

function buildSlide5() {
  const el = document.createElement('div');
  el.className = 'crsmart-slide-content slide-5';
  // Default content is the cold-start "fresh user" view: pick how to
  // start. customizeSlide5State() runs at mount time and rewrites the
  // title/body/CTAs if the user already has progress (re-watcher case).
  // Each CTA has a "what happens next" hint so the user isn't surprised
  // when a new tab opens or an OAuth popup appears.
  el.innerHTML = `
    <div class="slide-final">
      <h2 class="slide-title slide-final-title" id="slide-5-title">Pick how to start</h2>
      <p class="slide-body slide-final-body" id="slide-5-body">
        The engine needs a tiny bit of taste signal. Three minutes is plenty.
      </p>
      <div class="slide-final-actions" id="slide-5-actions">
        <button class="tour-cta tour-cta-primary" id="crsmart-tour-cta-survey" type="button">
          <span class="tour-cta-title">Quick Taste Check</span>
          <span class="tour-cta-meta">~3 min · tap shows you've loved or skipped</span>
          <span class="tour-cta-preview">Opens the survey in a new tab</span>
        </button>
        <button class="tour-cta tour-cta-secondary" id="crsmart-tour-cta-anilist" type="button">
          <span class="tour-cta-title">I have an AniList list</span>
          <span class="tour-cta-meta">Sign in once, we read your scored shows</span>
          <span class="tour-cta-preview">Opens AniList sign-in, then imports in the background</span>
        </button>
        ${tourHelpLinkHtml()}
        <button class="tour-dismiss-link" id="crsmart-tour-cta-skip" type="button">
          I'll just browse — close this
        </button>
      </div>
    </div>`;
  return el;
}

const SLIDE_BUILDERS = [
  buildSlide1,           // 1. Hook — score card on a series page
  buildSlide2,           // 2. Differentiation — yours vs popular
  buildSlideSidePanel,   // 3. Side panel + vibes (the ranked-list surface)
  buildSlide3,           // 4. Privacy / local
  buildSlide4,           // 5. Identity / radar shape
  buildSlide5,           // 6. Action — pick how to start (CTAs)
];

// ── Mount / unmount ─────────────────────────────────────────────

function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'crsmart-tour-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Smart Scoring tour');

  const modal = document.createElement('div');
  modal.className = 'crsmart-tour-modal';

  // Stage — fixed-design wrapper (1080×700) that holds everything
  // scalable. Modal centers + container-queries the stage so a single
  // CSS transform: scale() fits the design to whatever modal size the
  // viewport produces. Without this wrapper, internal pixel sizes
  // would feel cramped at narrow viewports and sparse at wide ones.
  const stage = document.createElement('div');
  stage.className = 'crsmart-tour-stage';
  modal.appendChild(stage);

  // Close button — top-right, always visible.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'crsmart-tour-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close tour');
  closeBtn.innerHTML = '✕';
  closeBtn.addEventListener('click', () => closeOverlay('user'));
  stage.appendChild(closeBtn);

  // Track viewport — fixed-position clip box. The track ITSELF translates
  // between slides (transform: translateX(-100% per slide)), so we can't
  // put overflow:hidden on the track — it would clip the slides BEFORE
  // the translate brought them into view, leaving navigation broken.
  // The viewport stays put and clips off-screen slides; the track moves
  // inside it freely.
  const trackViewport = document.createElement('div');
  trackViewport.className = 'crsmart-tour-track-viewport';

  // Slide track — holds all 5 slides side-by-side; transform translates
  // between them. Building all upfront so animations can preload.
  // aria-live="polite" lets screen readers announce slide transitions
  // when the title text changes; aria-atomic ensures the whole slide
  // is read, not just the diff.
  const track = document.createElement('div');
  track.className = 'crsmart-tour-track';
  track.setAttribute('aria-live', 'polite');
  track.setAttribute('aria-atomic', 'true');
  for (let i = 0; i < TOTAL_SLIDES; i++) {
    const wrap = document.createElement('section');
    wrap.className = 'crsmart-tour-slide';
    wrap.dataset.slide = String(i + 1);
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', `Slide ${i + 1} of ${TOTAL_SLIDES}`);
    wrap.appendChild(SLIDE_BUILDERS[i]());
    track.appendChild(wrap);
  }
  trackViewport.appendChild(track);
  stage.appendChild(trackViewport);

  // Footer — slide dots (left/center) + skip-to-setup (left) + prev/next (right).
  const footer = document.createElement('footer');
  footer.className = 'crsmart-tour-footer';

  const skipBtn = document.createElement('button');
  skipBtn.className = 'crsmart-tour-skip';
  skipBtn.type = 'button';
  skipBtn.textContent = 'Skip to setup →';
  skipBtn.addEventListener('click', () => gotoSlide(TOTAL_SLIDES));
  footer.appendChild(skipBtn);

  const dots = document.createElement('div');
  dots.className = 'crsmart-tour-dots';
  for (let i = 0; i < TOTAL_SLIDES; i++) {
    const dot = document.createElement('button');
    dot.className = 'crsmart-tour-dot';
    dot.type = 'button';
    dot.dataset.slide = String(i + 1);
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.addEventListener('click', () => gotoSlide(i + 1));
    dots.appendChild(dot);
  }
  footer.appendChild(dots);

  const nav = document.createElement('div');
  nav.className = 'crsmart-tour-nav';
  const prevBtn = document.createElement('button');
  prevBtn.className = 'crsmart-tour-prev';
  prevBtn.type = 'button';
  prevBtn.textContent = '← Prev';
  prevBtn.addEventListener('click', () => gotoSlide(currentSlide - 1));
  nav.appendChild(prevBtn);
  const nextBtn = document.createElement('button');
  nextBtn.className = 'crsmart-tour-next';
  nextBtn.type = 'button';
  nextBtn.textContent = 'Next →';
  nextBtn.addEventListener('click', () => gotoSlide(currentSlide + 1));
  nav.appendChild(nextBtn);
  footer.appendChild(nav);

  stage.appendChild(footer);
  overlay.appendChild(modal);

  // CTA wiring (slide 5). The state-aware re-watcher view may swap
  // these IDs in via customizeSlide5State (e.g. add 'crsmart-tour-cta-picks').
  // Vibe chips on the side-panel slide also delegate through here.
  overlay.addEventListener('click', e => {
    // Help link — open help.html in a new tab via the service worker,
    // not via a direct chrome-extension:// anchor (those get blocked
    // by some content-blockers as cross-origin redirects). The tour
    // stays open so the user can return after reading.
    if (e.target.closest('.tour-help-link')) {
      bumpFunnelCounter('helpOpened');
      try {
        chrome.runtime.sendMessage({ type: 'crsmart:open-help-tab' });
      } catch (_) { /* extension context invalidated during dev reload */ }
      return;
    }
    // Vibe chip — re-rank slide-3 list. Handled before the CTA branch
    // because chips are buttons too and would otherwise no-op through
    // the id-based switch.
    const chip = e.target.closest('.mock-vibe-chip[data-vibe]');
    if (chip) {
      handleVibeChipClick(chip);
      return;
    }
    const target = e.target.closest('button');
    if (!target) return;
    if (target.id === 'crsmart-tour-cta-survey')      ctaSurvey();
    else if (target.id === 'crsmart-tour-cta-anilist') ctaAnilist();
    else if (target.id === 'crsmart-tour-cta-picks')   ctaOpenPicks();
    else if (target.id === 'crsmart-tour-cta-skip')    ctaSkip();
  });

  // Keyboard. Listen at document level (capture) so CR's own
  // keyboard handlers can't swallow our nav while the modal is open.
  overlay._keyHandler = handleKey;
  document.addEventListener('keydown', overlay._keyHandler, true);

  return overlay;
}

function mountOverlay() {
  if (overlayEl) return;  // already mounted; re-fire is a no-op
  // Defer if CR is in fullscreen-video — otherwise the modal is buried.
  if (document.fullscreenElement) {
    document.addEventListener('fullscreenchange', mountOnExit, { once: true });
    return;
  }
  // Capture currently-focused element so we can return focus on close
  // (a11y: keyboard users shouldn't lose their place).
  previouslyFocusedEl = document.activeElement;
  SEEN_THIS_MOUNT.clear();
  overlayEl = buildOverlay();
  document.body.appendChild(overlayEl);
  // Lock body scroll so the underlying CR page doesn't scroll behind
  // the modal. Saved + restored in closeOverlay's finally block.
  savedBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  // Customize slide 5 based on user state — async, runs in parallel
  // with the initial render. Re-watchers see CTAs that match where
  // they actually are; cold-start users keep the default.
  customizeSlide5State();
  // Initial slide visualization. requestAnimationFrame so the browser
  // commits the initial styles before we kick the slide-1 animation.
  requestAnimationFrame(() => gotoSlide(1, /*initial*/ true));
  markOpened();
  bumpFunnelCounter('mounts');
  // Move focus into the modal so screen readers announce the dialog
  // and keyboard input lands inside our key handler.
  setTimeout(() => {
    const closeBtn = overlayEl?.querySelector('.crsmart-tour-close');
    closeBtn?.focus();
  }, 100);
}

function mountOnExit() {
  if (!document.fullscreenElement) mountOverlay();
}

function closeOverlay(_reason) {
  if (!overlayEl) return;
  stopSlide1Cycle();
  const completed = overlayEl.dataset.reachedFinal === '1';
  const focusToReturn = previouslyFocusedEl;

  // Capture refs and null module state immediately so the rest of the
  // system (gotoSlide, message handlers, the cycle timer) sees the tour
  // as closed even while the fade-out animation is still playing. The
  // captured element is removed from the DOM after the animation
  // completes; click/keypress are disabled via the .is-closing CSS rule
  // so the user can't re-trigger anything during the fade.
  const closingEl = overlayEl;
  const savedOverflow = savedBodyOverflow;
  document.removeEventListener('keydown', closingEl._keyHandler, true);
  overlayEl = null;
  savedBodyOverflow = null;
  previouslyFocusedEl = null;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  closingEl.classList.add('is-closing');
  const finalize = () => {
    closingEl.remove();
    document.body.style.overflow = savedOverflow ?? '';
  };
  if (reduced) finalize();
  else setTimeout(finalize, 240);  // matches modal-out animation length

  // Return focus to whichever element opened the tour so keyboard
  // users land back where they were instead of getting stuck on
  // <body>. Done synchronously — focus moves now even though the
  // overlay is still visibly fading out, so screen readers announce
  // the focus change immediately.
  if (focusToReturn && document.contains(focusToReturn)) {
    try { focusToReturn.focus(); } catch (_) {}
  }
  // Persist dismissal. completedAt only set if we'd reached slide 5
  // at any point — sticky once set, so re-reading later still reflects
  // "user has seen the whole thing."
  const patch = { dismissedAt: Date.now() };
  readTourSeen().then(cur => {
    if (completed && !cur?.completedAt) patch.completedAt = Date.now();
    writeTourSeen(patch);
  });
  if (completed) bumpFunnelCounter('completes');
}

// ── Slide navigation ────────────────────────────────────────────

function gotoSlide(n, initial = false) {
  if (!overlayEl) return;
  const next = Math.max(1, Math.min(TOTAL_SLIDES, n));
  if (!initial && next === currentSlide) return;
  currentSlide = next;
  trackSlideView(next);

  // Track translate. Each slide is 100% wide; translateX moves to it.
  const track = overlayEl.querySelector('.crsmart-tour-track');
  if (track) track.style.transform = `translateX(-${(currentSlide - 1) * 100}%)`;

  // Sync dots.
  overlayEl.querySelectorAll('.crsmart-tour-dot').forEach(d => {
    const slideNum = Number(d.dataset.slide);
    d.classList.toggle('is-active', slideNum === currentSlide);
    d.classList.toggle('is-visited', slideNum < currentSlide);
  });

  // Sync nav buttons.
  const prevBtn = overlayEl.querySelector('.crsmart-tour-prev');
  const nextBtn = overlayEl.querySelector('.crsmart-tour-next');
  if (prevBtn) prevBtn.disabled = currentSlide === 1;
  if (nextBtn) nextBtn.style.visibility = currentSlide === TOTAL_SLIDES ? 'hidden' : 'visible';

  // Skip-to-setup hides on slide 5.
  const skip = overlayEl.querySelector('.crsmart-tour-skip');
  if (skip) skip.style.visibility = currentSlide === TOTAL_SLIDES ? 'hidden' : 'visible';

  // Mark reached-final + write completedAt sticky bit. Used in
  // closeOverlay to decide whether to set tourSeen.completedAt.
  if (currentSlide === TOTAL_SLIDES) overlayEl.dataset.reachedFinal = '1';

  // Trigger per-slide animation. Each slide's CSS animations key off
  // a .is-playing class on the .crsmart-slide-content element (which
  // also carries .slide-1 / .slide-2 / etc.). The class persists so
  // animations don't replay on re-visit; users navigating back-and-forth
  // see the final state, which is fine.
  //
  // IMPORTANT: the class lives on the INNER .crsmart-slide-content
  // element, not the outer .crsmart-tour-slide wrapper. CSS selectors
  // are written as `.slide-N.is-playing .child` (compound on the same
  // element), so adding .is-playing to the wrapper would never match.
  const wrap = overlayEl.querySelector(`.crsmart-tour-slide[data-slide="${currentSlide}"]`);
  const inner = wrap?.querySelector('.crsmart-slide-content');
  if (inner && !inner.classList.contains('is-playing')) {
    inner.classList.add('is-playing');
    if (currentSlide === 1) animateSlide1(inner);
  }

  // Slide-1 card cycle — runs only while slide 1 is the active slide.
  // Index persists across slide transitions so the rotation continues
  // from wherever the user left it (resetting would jump past whatever
  // card is currently in the DOM, since the displayed card and the
  // index would disagree).
  if (currentSlide === 1) startSlide1Cycle();
  else stopSlide1Cycle();
}

// Slide 1 has a numeric counter that has to be JS-driven; the rest
// of the slide animations are pure CSS keyframes and self-trigger
// from the .is-playing class. Reduced-motion users get the final
// number set immediately (the @media gate is in CSS for layout, but
// for the JS counter we read the prefers-reduced-motion media query
// and bail to final state).
//
// Duration param lets the cycle pass a shorter ramp (~900ms) that
// matches the faster .is-cycle-card ring-fill timing; initial reveal
// uses the default 1400ms to match the original .is-playing ring-fill.
function animateSlide1(wrap, durationMs = 1400) {
  const scoreEl = wrap.querySelector('.mock-card-score');
  if (!scoreEl) return;
  const final = Number(scoreEl.dataset.final || 92);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { scoreEl.textContent = String(final); return; }
  const startTs = performance.now();
  function tick(ts) {
    const t = Math.min(1, (ts - startTs) / durationMs);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - t, 3);
    scoreEl.textContent = String(Math.round(final * eased));
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ── Slide-1 cycle ───────────────────────────────────────────────
// Every SLIDE1_CYCLE_MS while slide 1 is active, swap to the next
// card in SLIDE1_CARDS. Skipped under prefers-reduced-motion (the user
// just sees the static Frieren example, no auto-rotation).

function startSlide1Cycle() {
  stopSlide1Cycle();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  slide1CycleTimer = setInterval(cycleSlide1, SLIDE1_CYCLE_MS);
}

function stopSlide1Cycle() {
  if (slide1CycleTimer) {
    clearInterval(slide1CycleTimer);
    slide1CycleTimer = null;
  }
}

// Advance to the next card. Two-phase: leave (280ms fade-down on the
// existing card + 220ms opacity transition on poster/meta), then swap
// content + insert a fresh card element. New element triggers
// .is-cycle-card animations from t=0 — this is why we replace the DOM
// node rather than mutate the existing one (CSS animation restart on
// the same element is brittle; replacement is reliable).
function cycleSlide1() {
  if (!overlayEl || currentSlide !== 1) { stopSlide1Cycle(); return; }
  const inner = overlayEl.querySelector(
    '.crsmart-tour-slide[data-slide="1"] .crsmart-slide-content'
  );
  const oldCard = inner?.querySelector('.mock-hero-card');
  const poster = inner?.querySelector('.mock-hero-poster');
  const meta = inner?.querySelector('.mock-hero-meta');
  if (!inner || !oldCard) return;

  slide1CycleIndex = (slide1CycleIndex + 1) % SLIDE1_CARDS.length;
  const next = SLIDE1_CARDS[slide1CycleIndex];

  // Phase 1 — leave. Card fades down (CSS animation), poster + meta
  // crossfade to opacity 0 (CSS transition).
  oldCard.classList.remove('is-cycle-card');
  oldCard.classList.add('is-leaving');
  poster?.classList.add('is-fading');
  meta?.classList.add('is-fading');

  setTimeout(() => {
    if (!overlayEl || currentSlide !== 1) return;
    // Phase 2 — swap. Update poster/meta content while opacity is 0,
    // then drop .is-fading to fade them back in. Replace the card
    // element with a fresh one carrying .is-cycle-card so its CSS
    // animations run from scratch.
    populateSlide1HeroChrome(inner, next);
    poster?.classList.remove('is-fading');
    meta?.classList.remove('is-fading');

    const newCard = buildSlide1HeroCard(next);
    newCard.classList.add('is-cycle-card');
    oldCard.replaceWith(newCard);

    // Score counter — synced with the .is-cycle-card ring-fill timing
    // (~800ms). 900ms keeps the digits ticking just past ring fill so
    // the final number lands as the ring snaps to full.
    animateSlide1(inner, 900);
  }, 280);
}

// ── Event handlers ──────────────────────────────────────────────

function handleKey(e) {
  if (!overlayEl) return;
  // Only intercept keys that we own. Let typing work in case CR has
  // any text inputs visible behind the modal (unlikely with scroll
  // lock, but defensive).
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeOverlay('keyboard');
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    gotoSlide(currentSlide + 1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    gotoSlide(currentSlide - 1);
  } else if (e.key === 'Enter' && currentSlide < TOTAL_SLIDES) {
    e.preventDefault();
    gotoSlide(currentSlide + 1);
  }
}

// ── Slide-5 CTA handlers ────────────────────────────────────────

function ctaSurvey() {
  // New tab so user's CR session is preserved (locked Q15).
  try {
    chrome.runtime.sendMessage({
      type: 'crsmart:open-survey-tab',
    });
  } catch (_) {}
  writeTourSeen({ choice: 'survey' });
  closeOverlay('cta-survey');
}

function ctaAnilist() {
  // Background owns the OAuth flow. We dispatch and close.
  try {
    chrome.runtime.sendMessage({
      type: 'crsmart:external:link',
      source: 'anilist',
    }).then(resp => {
      if (resp?.ok) {
        chrome.runtime.sendMessage({
          type: 'crsmart:external:start-import',
          source: 'anilist',
        }).catch(() => {});
      }
    }).catch(() => {});
  } catch (_) {}
  writeTourSeen({ choice: 'anilist' });
  closeOverlay('cta-anilist');
}

function ctaSkip() {
  writeTourSeen({ choice: 'skip' });
  closeOverlay('cta-skip');
}

// Re-watcher CTA: open the Smart Picks side panel directly. Sends
// the same message as the topbar sparkle button.
function ctaOpenPicks() {
  try {
    chrome.runtime.sendMessage({ type: 'crsmart:open-side-panel' });
  } catch (_) {}
  writeTourSeen({ choice: 'picks' });
  closeOverlay('cta-picks');
}

// ── Trigger paths ───────────────────────────────────────────────

// Listen for explicit show-tour message (popup menu re-watch, or the
// install handler when CR is already open).
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'crsmart:show-tour') {
      mountOverlay();
    }
  });
} catch (_) { /* extension context invalidated during dev reload */ }

// Auto-fire if the install handler set the session flag and we just
// landed on a CR page.
(async () => {
  try {
    const sess = await chrome.storage.session.get(SESSION_FLAG);
    if (sess?.[SESSION_FLAG]) {
      await chrome.storage.session.remove(SESSION_FLAG);
      // Tiny delay so CR's initial render settles before we mount —
      // avoids flicker if React paints immediately after our fire.
      setTimeout(mountOverlay, 400);
    }
  } catch (_) {}
})();
