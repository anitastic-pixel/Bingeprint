// Pipeline runner — DAG of registered stages, driven by storage-key
// invalidation. Pure orchestration; stages own the math, the runner
// owns IO and ordering.
//
// Why a runner exists:
//
// `persistTasteVector` was a 196-line orchestrator that re-ran every
// stage on every signal — survey tap, reaction, schema bump, etc.
// Each new feature added another inline stage, growing the function.
// The runner replaces that pattern: stages are independent registered
// units; the runner builds the dep graph from output→input matching
// and re-runs only what's downstream of a changed key.
//
// Stage shape (plain objects exported from their domain modules):
//
//   {
//     name:    'series-sentiment',          // unique
//     inputs:  ['watchShapes', 'userRatings'],   // chrome.storage keys read
//     outputs: ['seriesSentiments'],         // chrome.storage keys written
//     schema:  3,                            // bump to force re-run on math change
//     async run({ watchShapes, userRatings }) {
//       // pure compute. no chrome.* APIs.
//       return { seriesSentiments: { ... } };
//     }
//   }
//
// Dependencies are IMPLICIT from inputs/outputs matching: if Stage B
// reads `seriesSentiments` and Stage A writes it, B depends on A. The
// runner topologically sorts. No explicit `dependsOn` declaration.
//
// Invalidation is PUSH-based at the storage-key level:
//
//   runner.markChanged('userRatings');     // any caller writing this key
//   runner.flush();                         // run all dirty stages in order
//
// The runner does NOT subscribe to chrome.storage.onChanged — that
// would self-trigger on its own writes. Callers are responsible for
// markChanged() after their writes; the runner trusts those signals.
//
// Boot-time schema sweep: on registration, the runner compares each
// stage's declared schema to the persisted schema in storage. If
// mismatched, the stage's outputs are invalidated, cascading
// downstream. This replaces the per-feature `recomputeIfSchemaStale`
// pattern.
//
// Caller usage (sketch — actual stage migration is opportunistic):
//
//   const runner = new PipelineRunner();
//   runner.register(seriesSentimentStage);
//   runner.register(tasteVectorStage);
//   runner.register(allShowsScoredStage);
//
//   await runner.bootSweep();                 // schema-aware initial run
//
//   // ... user takes some action ...
//   chrome.storage.local.set({ userRatings: ... });
//   runner.markChanged('userRatings');
//   await runner.flush();                      // re-runs only affected stages

const STAGE_SCHEMAS_KEY = 'pipelineStageSchemas';

export class PipelineRunner {
  constructor(options = {}) {
    this.stages = new Map();           // name → stage
    this.outputToStage = new Map();     // storage key → stage name (which writes it)
    this.stageDownstream = new Map();   // stage name → Set<stage names that read its outputs>
    this.dirty = new Set();             // storage keys flagged dirty
    this.flushTimer = null;
    // Async batch — coalesce many markChanged calls in a tick into
    // a single flush. Caller can override for tests / explicit control.
    this.autoFlush = options.autoFlush !== false;
    // Override storage IO for tests. In prod, falls through to chrome.storage.local.
    this.storage = options.storage || defaultChromeStorageAdapter();
  }

  register(stage) {
    if (!stage || !stage.name) throw new Error('PipelineRunner.register: stage missing name');
    if (this.stages.has(stage.name)) {
      throw new Error(`PipelineRunner.register: duplicate stage name "${stage.name}"`);
    }
    if (typeof stage.run !== 'function') {
      throw new Error(`PipelineRunner.register: stage "${stage.name}" missing run()`);
    }
    const inputs = Array.isArray(stage.inputs) ? stage.inputs : [];
    const outputs = Array.isArray(stage.outputs) ? stage.outputs : [];
    this.stages.set(stage.name, { ...stage, inputs, outputs });
    for (const out of outputs) {
      const prev = this.outputToStage.get(out);
      if (prev && prev !== stage.name) {
        throw new Error(
          `PipelineRunner.register: storage key "${out}" already written by "${prev}"; ` +
          `two stages can't own the same output`);
      }
      this.outputToStage.set(out, stage.name);
    }
    // Rebuild downstream graph — any stage reading outputs is downstream.
    this._rebuildDownstreamGraph();
  }

  _rebuildDownstreamGraph() {
    this.stageDownstream.clear();
    for (const stage of this.stages.values()) {
      const downstream = new Set();
      for (const out of stage.outputs) {
        // Find every other stage whose inputs include this output
        for (const candidate of this.stages.values()) {
          if (candidate.name === stage.name) continue;
          if (candidate.inputs.includes(out)) downstream.add(candidate.name);
        }
      }
      this.stageDownstream.set(stage.name, downstream);
    }
  }

  // Mark a storage key as changed; any stage reading it will be
  // re-run on next flush, cascading to its downstream stages.
  markChanged(key) {
    if (!key) return;
    this.dirty.add(key);
    if (this.autoFlush) this._scheduleAutoFlush();
  }

  _scheduleAutoFlush() {
    if (this.flushTimer != null) return;
    // setTimeout with 0 for a microtask-equivalent batch in MV3 SW
    // context. Multiple markChanged calls in the same task coalesce
    // into one flush.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(err => console.warn('[pipeline-runner] flush error', err));
    }, 0);
  }

  // Compute the set of stage names that are dirty: every stage whose
  // inputs include a dirty storage key, plus everything downstream
  // of a dirty stage's outputs.
  _computeDirtyStages() {
    const dirtyStages = new Set();
    // Direct: any stage whose inputs were touched
    for (const stage of this.stages.values()) {
      for (const input of stage.inputs) {
        if (this.dirty.has(input)) {
          dirtyStages.add(stage.name);
          break;
        }
      }
    }
    // Cascade: BFS through downstream
    const queue = [...dirtyStages];
    while (queue.length > 0) {
      const name = queue.shift();
      const downstream = this.stageDownstream.get(name);
      if (!downstream) continue;
      for (const next of downstream) {
        if (!dirtyStages.has(next)) {
          dirtyStages.add(next);
          queue.push(next);
        }
      }
    }
    return dirtyStages;
  }

  // Topological sort of stage names. Stages with no inputs from other
  // stage outputs come first; stages reading those come later.
  _topoSort(stageNames) {
    const order = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (name) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`PipelineRunner: cycle detected involving stage "${name}"`);
      }
      visiting.add(name);
      const stage = this.stages.get(name);
      if (stage) {
        for (const input of stage.inputs) {
          const upstream = this.outputToStage.get(input);
          if (upstream && stageNames.has(upstream)) visit(upstream);
        }
      }
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of stageNames) visit(name);
    return order;
  }

  async flush() {
    const dirtyStages = this._computeDirtyStages();
    if (dirtyStages.size === 0) {
      this.dirty.clear();
      return { ran: [], skipped: 0 };
    }
    const order = this._topoSort(dirtyStages);
    const ran = [];
    for (const name of order) {
      const stage = this.stages.get(name);
      if (!stage) continue;
      const inputs = await this.storage.read(stage.inputs);
      const result = await stage.run(inputs);
      if (result && typeof result === 'object') {
        // Only write keys the stage declared as outputs — prevents
        // accidental writes to keys outside its contract.
        const toWrite = {};
        for (const key of stage.outputs) {
          if (key in result) toWrite[key] = result[key];
        }
        if (Object.keys(toWrite).length > 0) await this.storage.write(toWrite);
      }
      // The stage's outputs are NOW dirty for downstream stages, but
      // since downstream stages were already added to dirtyStages by
      // _computeDirtyStages, they'll run in topo order regardless. No
      // need to re-mark.
      ran.push(name);
    }
    this.dirty.clear();
    return { ran, skipped: this.stages.size - ran.length };
  }

  // Boot-time schema sweep. For each registered stage, compare its
  // declared schema to the persisted schema. If mismatched, mark the
  // stage's INPUTS as dirty so the stage re-runs (and cascades).
  // Persists the new schemas after the sweep.
  async bootSweep() {
    const persisted = await this.storage.read([STAGE_SCHEMAS_KEY]);
    const persistedSchemas = persisted[STAGE_SCHEMAS_KEY] || {};
    const newSchemas = {};
    let dirtied = 0;
    for (const stage of this.stages.values()) {
      const expected = stage.schema ?? null;
      newSchemas[stage.name] = expected;
      const stored = persistedSchemas[stage.name] ?? null;
      if (stored !== expected) {
        // Schema bump (or first run) — invalidate this stage's
        // inputs to force re-run. Use the first input as the
        // dirty key; if no inputs, use a synthetic one.
        const dirtyKey = stage.inputs[0] || `__bootsweep_${stage.name}`;
        this.markChanged(dirtyKey);
        // Also directly add the stage as dirty so it runs even if
        // its inputs aren't in any other stage's outputs.
        for (const out of stage.outputs) this.markChanged(out);
        dirtied++;
      }
    }
    if (dirtied > 0) {
      await this.storage.write({ [STAGE_SCHEMAS_KEY]: newSchemas });
    }
    return { dirtied, total: this.stages.size };
  }
}

function defaultChromeStorageAdapter() {
  // Defer the chrome.storage import so the module is testable in
  // contexts that don't have chrome.* (Node tests, etc.).
  return {
    async read(keys) {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) return {};
      return await chrome.storage.local.get(keys);
    },
    async write(obj) {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
      await chrome.storage.local.set(obj);
    },
  };
}
