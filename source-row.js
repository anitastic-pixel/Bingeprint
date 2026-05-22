// source-row — single seam for the external-source row state machine.
//
// Before this module, three render paths in popup.js computed essentially
// the same state (pending/connected, configured/not, has-data/empty,
// importing/not, has-error/not) imperatively, with class composition + DOM
// mutations interleaved. The discipline that kept them in sync (e.g.
// "always call setRowSubtitle, not subtitle.textContent =") was a contract
// no caller had to honor — and one didn't, shipping the 2026-05-16 MAL XML
// has-subtitle regression.
//
// Now:
//   deriveSourceRowState(inputs) → tagged state  (pure, testable)
//   applyRowVisuals(rowEl, state, helpers)       → DOM mutation
//
// The interface is the state shape, documented below. Callers pass inputs,
// receive a uniformly-applied visual. No caller writes a subtitle or a
// CSS class directly; the state-shape captures everything the row can be.
//
// Out of scope: the CR row. Its structure (refresh-button inline inside
// source-content, no impact panel, no action button) differs enough that
// forcing it through this seam would just split the renderer back into
// kind-branches without concentrating anything.

// ── State shape (the interface) ─────────────────────────────────
//
// {
//   iconText:          '+' | '✓'
//   subtitle:          string | null    // null => hide subtitle + drop .has-subtitle
//   classes: {
//     connected:       boolean,
//     pending:         boolean,
//     isComingSoon:    boolean,
//   }
//   action: { label, dataAction, disabled } | null
//   resync:      { visible, disabled } | null   // null => row has no resync button at all
//   signOrClear: { visible, disabled, role: 'signout' | 'clear' } | null
//   impactToggle: { visible: boolean }
//   impact:      <opaque, forwarded to helpers.renderImpact>
//   privacyVisible: boolean
// }

// ── Inputs ──────────────────────────────────────────────────────
//
// OAuth path:
//   { kind: 'oauth', source, configured, linked, account, importState,
//     lastError, stats, impact }
//
// XML path:
//   { kind: 'xml', stats, impact }

export function deriveSourceRowState(inputs) {
  if (inputs.kind === 'xml') return deriveXmlState(inputs);
  return deriveOauthState(inputs);
}

function deriveOauthState({ source, configured, linked, account, importState, lastError, stats, impact }) {
  const isImporting = !!(importState && importState.source === source && importState.phase !== 'error');
  const isError = !!(importState && importState.source === source && importState.phase === 'error');

  // Unconfigured short-circuits everything — the row is "coming soon".
  if (!configured) {
    return {
      iconText: '+',
      subtitle: 'coming soon — under construction',
      classes: { connected: false, pending: true, isComingSoon: true },
      action: { label: 'soon', dataAction: 'soon', disabled: true },
      resync: { visible: false, disabled: true },
      signOrClear: { visible: false, disabled: true, role: 'signout' },
      impactToggle: { visible: false },
      impact: null,
      privacyVisible: false,
    };
  }

  // Configured but not linked — connect button + privacy reassurance.
  if (!linked) {
    return {
      iconText: '+',
      subtitle: lastError ? lastError.message : null,
      classes: { connected: false, pending: true, isComingSoon: false },
      action: { label: 'connect', dataAction: 'connect', disabled: false },
      resync: { visible: false, disabled: true },
      signOrClear: { visible: false, disabled: true, role: 'signout' },
      impactToggle: { visible: false },
      impact: null,
      privacyVisible: true,
    };
  }

  // Linked. Resync + signout surface only when not mid-import.
  const linkedTools = !isImporting;
  const baseLinked = {
    iconText: '✓',
    classes: { connected: true, pending: false, isComingSoon: false },
    privacyVisible: false,
  };

  if (isImporting) {
    return {
      ...baseLinked,
      subtitle: progressLineFor(importState),
      action: { label: '…', dataAction: 'busy', disabled: true },
      resync: { visible: false, disabled: true },
      signOrClear: { visible: false, disabled: true, role: 'signout' },
      impactToggle: { visible: false },
      impact: null,
    };
  }
  if (isError) {
    return {
      ...baseLinked,
      subtitle: progressLineFor(importState),
      action: { label: 'retry', dataAction: 'import', disabled: false },
      resync: { visible: linkedTools, disabled: !linkedTools },
      signOrClear: { visible: linkedTools, disabled: !linkedTools, role: 'signout' },
      impactToggle: { visible: false },
      impact: null,
    };
  }
  if (lastError) {
    return {
      ...baseLinked,
      subtitle: lastError.message,
      action: { label: 'retry', dataAction: 'import', disabled: false },
      resync: { visible: linkedTools, disabled: !linkedTools },
      signOrClear: { visible: linkedTools, disabled: !linkedTools, role: 'signout' },
      impactToggle: { visible: false },
      impact: null,
    };
  }

  // Linked, idle, ready — the common case.
  return {
    ...baseLinked,
    subtitle: buildOauthSubtitle({ account, stats }),
    action: { label: 'import', dataAction: 'import', disabled: false },
    resync: { visible: true, disabled: false },
    signOrClear: { visible: true, disabled: false, role: 'signout' },
    impactToggle: { visible: !!impact },
    impact,
  };
}

function deriveXmlState({ stats, impact }) {
  const hasData = !!(stats && stats.imported > 0);
  if (!hasData) {
    return {
      iconText: '+',
      subtitle: null,
      classes: { connected: false, pending: true, isComingSoon: false },
      action: { label: 'import', dataAction: 'open-import', disabled: false },
      resync: null,                                          // XML row has no resync
      signOrClear: { visible: false, disabled: true, role: 'clear' },
      impactToggle: { visible: false },
      impact: null,
      privacyVisible: false,
    };
  }
  return {
    iconText: '✓',
    subtitle: `${stats.imported} imported · ${breakdownStats(stats)}`,
    classes: { connected: true, pending: false, isComingSoon: false },
    action: { label: 're-import', dataAction: 'open-import', disabled: false },
    resync: null,
    signOrClear: { visible: true, disabled: false, role: 'clear' },
    impactToggle: { visible: !!impact },
    impact,
    privacyVisible: false,
  };
}

// ── Subtitle builders ───────────────────────────────────────────
function buildOauthSubtitle({ account, stats }) {
  const who = account?.name ? `linked as ${account.name}` : 'linked';
  const breakdown = breakdownStats(stats);
  return breakdown ? `${who} · ${breakdown}` : who;
}

function breakdownStats(stats) {
  if (!stats || stats.imported <= 0) return null;
  const parts = [];
  if (stats.viaRealWatch != null) parts.push(`${stats.viaRealWatch} from CR`);
  if (stats.viaSynthesis != null && stats.viaSynthesis > 0) parts.push(`${stats.viaSynthesis} synthesized`);
  if (stats.stranded != null && stats.stranded > 0) parts.push(`${stats.stranded} unrated/planning`);
  if (parts.length === 0) parts.push(`${stats.contributing}/${stats.imported}`);
  return parts.join(' · ');
}

// progressLineFor — formats an in-flight _importState into a one-line
// status string. Exported so other surfaces (the MAL XML import page)
// can use the same vocabulary if they want.
export function progressLineFor(state) {
  if (!state) return '';
  if (state.phase === 'error') return state.error || 'import failed';
  const p = state.progress || {};
  const phaseLabel = {
    'fetch-list': 'fetching list',
    'crosswalk':  'mapping IDs',
    'enrich':     'enriching',
    'flush':      'saving',
  }[state.phase] || state.phase;
  if (p.total) return `${phaseLabel} ${p.done}/${p.total}`;
  return `${phaseLabel}…`;
}

// ── DOM application ─────────────────────────────────────────────
// applyRowVisuals — the only DOM-touching function. Takes the row
// element, a state from deriveSourceRowState, and a small `helpers` bag.
//
// helpers.renderImpact(rowEl, impactData) — popup.js's renderImpactPanel,
//   injected so source-row.js doesn't have to know about the impact
//   panel's HTML shape (that lives in popup.js where the data-shape from
//   computeExternalImportImpact also lives). The toggle button visibility
//   is also managed by renderImpact via the impact data presence.
export function applyRowVisuals(rowEl, state, helpers = {}) {
  if (!rowEl) return;

  rowEl.classList.toggle('connected', state.classes.connected);
  rowEl.classList.toggle('pending', state.classes.pending);
  rowEl.classList.toggle('is-coming-soon', state.classes.isComingSoon);

  const icon = rowEl.querySelector('.source-icon');
  if (icon) icon.textContent = state.iconText;

  applySubtitle(rowEl, state.subtitle);

  const privacy = rowEl.querySelector('[data-role="privacy"]');
  if (privacy) privacy.hidden = !state.privacyVisible;

  const action = rowEl.querySelector('.source-action');
  if (action && state.action) {
    action.textContent = state.action.label;
    action.disabled = state.action.disabled;
    action.dataset.action = state.action.dataAction;
  }

  applyIconButton(rowEl.querySelector('[data-role="resync"]'), state.resync);
  // signOrClear has two possible data-role values — find whichever exists
  // in the row's markup.
  const signOrClearEl = rowEl.querySelector('[data-role="signout"], [data-role="clear"]');
  applyIconButton(signOrClearEl, state.signOrClear);

  if (typeof helpers.renderImpact === 'function') {
    helpers.renderImpact(rowEl, state.impact);
  }
}

function applySubtitle(rowEl, text) {
  const sub = rowEl.querySelector('[data-role="subtitle"]');
  if (!sub) return;
  if (text) {
    sub.textContent = text;
    sub.hidden = false;
    rowEl.classList.add('has-subtitle');
  } else {
    sub.textContent = '';
    sub.hidden = true;
    rowEl.classList.remove('has-subtitle');
  }
}

function applyIconButton(el, slot) {
  if (!el) return;
  if (!slot) {
    el.hidden = true;
    el.disabled = true;
    return;
  }
  el.hidden = !slot.visible;
  el.disabled = slot.disabled;
}
