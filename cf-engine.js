// cf-engine.js — Collaborative-filtering re-ranker engine.
//
// Loads pre-trained 32-dim ALS item embeddings + tag→embedding projection
// on first use, exposes ALS fold-in for the user vector, cosine scoring
// against item embeddings (corpus or projected), and the bounded
// rank-delta the design specifies (`K_MAX·influence·cosine`).
//
// Authorized by ADR-0003 (no-ML principle bounded exception). All ML
// influence is constrained to the internal ranking score — the displayed
// Smart Score on the card is never touched by this module. See
// docs/CF-RERANKER-DESIGN.md for the full design rationale.
//
// Attribution: CF embeddings trained on the User-Animelist-Dataset by
// Ramazan Turan, licensed CC BY-NC 4.0.
// https://www.kaggle.com/datasets/ramazanturann/user-animelist-dataset

// ---- format constants (must match cf-pipeline/05-export-to-extension.py) ----
const MAGIC_EMB = 0x43534243;   // 'CSBC' embeddings file
const MAGIC_PROJ = 0x43534250;  // 'CSBP' projection weights file
const FORMAT_VERSION = 1;
const N_FACTORS = 32;

// ---- training-time hyperparams (must match 03-train-als.py) ----
// Confidence scaling for fold-in: c = 1 + ALPHA * rating
const ALPHA = 0.5;
// L2 regularization on the user-vector solve
const REGULARIZATION = 0.07;

// ---- runtime tunables (design doc §3.8 + §3.9) ----
// Bounded delta cap on the internal ranking score. Set K_MAX = 0 to
// disable CF without removing the engine — the kill-switch path.
const K_MAX = 0.5;
// Multiplier applied to CF delta for cold-show projections (tag-projection
// is noisier than corpus-learned embeddings; halve the influence).
const PROJECTED_MULTIPLIER = 0.5;

// ---- module-level state, populated by init() ----
let itemFactors = null;       // Float32Array of length n_items * N_FACTORS
let aniListIdToRow = null;    // Map<int, int>
let nItems = 0;

let projectionWeights = null; // Float32Array, length (nTags+1) * N_FACTORS
let projectionVocab = null;   // Map<lowercased tag name, col index>
let nTags = 0;

let YtY = null;               // Float32Array(N_FACTORS * N_FACTORS),
                              // precomputed once for fold-in
let initPromise = null;       // de-duplication for concurrent callers


// ----------------------------------------------------------------- loading

async function fetchAsset(path) {
  const url = chrome.runtime.getURL(path);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`[cf-engine] fetch ${path} -> ${resp.status}`);
  return resp;
}

async function loadEmbeddings() {
  const buf = await (await fetchAsset('cf-embeddings.bin')).arrayBuffer();
  const view = new DataView(buf);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC_EMB) {
    throw new Error(`[cf-engine] bad embeddings magic 0x${magic.toString(16)}`);
  }
  const ver = view.getUint32(4, true);
  if (ver !== FORMAT_VERSION) {
    throw new Error(`[cf-engine] embeddings version mismatch: ${ver}`);
  }
  nItems = view.getUint32(8, true);
  const nf = view.getUint32(12, true);
  if (nf !== N_FACTORS) {
    throw new Error(`[cf-engine] embeddings n_factors mismatch: ${nf}`);
  }

  // int32[nItems] aniListIds, immediately after the 16-byte header
  const ids = new Int32Array(buf, 16, nItems);
  aniListIdToRow = new Map();
  for (let i = 0; i < nItems; i++) aniListIdToRow.set(ids[i], i);

  // float16[nItems * N_FACTORS] item_factors, after the ID block
  const factorsOffset = 16 + 4 * nItems;
  const f16View = new Uint16Array(buf, factorsOffset, nItems * N_FACTORS);
  itemFactors = new Float32Array(nItems * N_FACTORS);
  for (let i = 0; i < f16View.length; i++) {
    itemFactors[i] = float16ToFloat32(f16View[i]);
  }
}

async function loadProjection() {
  const [binBuf, meta] = await Promise.all([
    (await fetchAsset('cf-projection.bin')).arrayBuffer(),
    (await fetchAsset('cf-projection.json')).json(),
  ]);
  const view = new DataView(binBuf);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC_PROJ) {
    throw new Error(`[cf-engine] bad projection magic 0x${magic.toString(16)}`);
  }
  const ver = view.getUint32(4, true);
  if (ver !== FORMAT_VERSION) {
    throw new Error(`[cf-engine] projection version mismatch: ${ver}`);
  }
  const nRows = view.getUint32(8, true);
  const nf = view.getUint32(12, true);
  if (nf !== N_FACTORS) {
    throw new Error(`[cf-engine] projection n_factors mismatch: ${nf}`);
  }
  nTags = nRows - 1; // last row is the bias

  const w16 = new Uint16Array(binBuf, 16, nRows * N_FACTORS);
  projectionWeights = new Float32Array(nRows * N_FACTORS);
  for (let i = 0; i < w16.length; i++) {
    projectionWeights[i] = float16ToFloat32(w16[i]);
  }

  projectionVocab = new Map();
  for (let i = 0; i < meta.vocab.length; i++) {
    projectionVocab.set(meta.vocab[i].toLowerCase(), i);
  }
}

function precomputeYtY() {
  // YtY[i*32+j] = sum over all items of item_factors[item][i] * item_factors[item][j].
  // Used in fold-in: A = YtY + Y_R^T (C_R - I) Y_R + reg*I. (See design doc §3.7
  // + the bug from Phase C round 1 — fold-in without the YtY term inverts the gate.)
  YtY = new Float32Array(N_FACTORS * N_FACTORS);
  for (let item = 0; item < nItems; item++) {
    const off = item * N_FACTORS;
    for (let i = 0; i < N_FACTORS; i++) {
      const yi = itemFactors[off + i];
      for (let j = 0; j < N_FACTORS; j++) {
        YtY[i * N_FACTORS + j] += yi * itemFactors[off + j];
      }
    }
  }
}

/** One-shot init. Idempotent — concurrent callers share the same promise. */
export function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const t0 = performance.now();
    await Promise.all([loadEmbeddings(), loadProjection()]);
    precomputeYtY();
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(
      `[cf-engine] initialized in ${elapsed}ms — ` +
      `${nItems} items, ${nTags} tags`
    );
  })().catch((err) => {
    initPromise = null; // allow retry on failure
    throw err;
  });
  return initPromise;
}

export function isReady() {
  return itemFactors !== null && projectionWeights !== null && YtY !== null;
}


// ------------------------------------------------------ float16 conversion

function float16ToFloat32(h) {
  const sign = (h >> 15) & 0x1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  if (exponent === 0) {
    if (mantissa === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * Math.pow(2, -14) * (mantissa / 1024);
  }
  if (exponent === 31) {
    if (mantissa === 0) return sign ? -Infinity : Infinity;
    return NaN;
  }
  return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}


// --------------------------------------------------------- fold-in solver

/**
 * Fold a user's ratings into a 32-dim user vector via one closed-form
 * ALS step against the frozen item factors.
 *
 * @param {object} ratings { aniListId: rating (numeric 0–10) }
 * @returns Float32Array(32) or null if no ratings overlap the model.
 */
export function computeUserVector(ratings) {
  if (!isReady()) throw new Error('[cf-engine] computeUserVector before init()');
  const ratedRows = [];
  const ratedConfs = [];
  for (const [aliStr, rating] of Object.entries(ratings || {})) {
    if (rating == null || rating === 0) continue;
    const r = Number(rating);
    if (!Number.isFinite(r)) continue;
    const ali = parseInt(aliStr, 10);
    const row = aniListIdToRow.get(ali);
    if (row == null) continue;
    ratedRows.push(row);
    ratedConfs.push(1 + ALPHA * r);
  }
  const k = ratedRows.length;
  if (k === 0) return null;

  // A = YtY + Y_R^T (C_R - I) Y_R + reg·I
  const A = new Float32Array(N_FACTORS * N_FACTORS);
  for (let i = 0; i < A.length; i++) A[i] = YtY[i];
  for (let i = 0; i < N_FACTORS; i++) A[i * N_FACTORS + i] += REGULARIZATION;
  for (let r = 0; r < k; r++) {
    const off = ratedRows[r] * N_FACTORS;
    const cMinusOne = ratedConfs[r] - 1.0;
    if (cMinusOne === 0) continue;
    for (let i = 0; i < N_FACTORS; i++) {
      const yi = itemFactors[off + i] * cMinusOne;
      for (let j = 0; j < N_FACTORS; j++) {
        A[i * N_FACTORS + j] += yi * itemFactors[off + j];
      }
    }
  }
  // b = Y_R^T c_R  (preference p=1, so just sum c_R · y_R)
  const b = new Float32Array(N_FACTORS);
  for (let r = 0; r < k; r++) {
    const off = ratedRows[r] * N_FACTORS;
    const c = ratedConfs[r];
    for (let i = 0; i < N_FACTORS; i++) b[i] += itemFactors[off + i] * c;
  }
  return solveLinear(A, b);
}

function solveLinear(A_in, b_in) {
  // Gaussian elimination with partial pivoting on a 32×33 augmented matrix.
  // Naive, but n=32 → trivial cost (~10k mults). Cholesky would be marginal.
  const n = N_FACTORS;
  const M = new Float32Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A_in[i * n + j];
    M[i * (n + 1) + n] = b_in[i];
  }
  for (let i = 0; i < n; i++) {
    let pivotRow = i, pivotMag = Math.abs(M[i * (n + 1) + i]);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(M[r * (n + 1) + i]);
      if (v > pivotMag) { pivotMag = v; pivotRow = r; }
    }
    if (pivotMag < 1e-12) return null; // singular
    if (pivotRow !== i) {
      for (let j = i; j <= n; j++) {
        const tmp = M[i * (n + 1) + j];
        M[i * (n + 1) + j] = M[pivotRow * (n + 1) + j];
        M[pivotRow * (n + 1) + j] = tmp;
      }
    }
    const pivot = M[i * (n + 1) + i];
    for (let r = i + 1; r < n; r++) {
      const factor = M[r * (n + 1) + i] / pivot;
      if (factor === 0) continue;
      for (let j = i; j <= n; j++) M[r * (n + 1) + j] -= factor * M[i * (n + 1) + j];
    }
  }
  const x = new Float32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i * (n + 1) + n];
    for (let j = i + 1; j < n; j++) s -= M[i * (n + 1) + j] * x[j];
    x[i] = s / M[i * (n + 1) + i];
  }
  return x;
}


// ----------------------------------------------------------- item lookup

/**
 * Look up (or project) a show's embedding.
 * @returns {{vector: Float32Array(32), provenance: 'corpus'|'projected'} | {vector: null, provenance: null}}
 */
export function getItemEmbedding(aniListId, tags) {
  if (!isReady()) throw new Error('[cf-engine] getItemEmbedding before init()');
  const row = aniListIdToRow.get(aniListId);
  if (row != null) {
    const off = row * N_FACTORS;
    return {
      vector: itemFactors.subarray(off, off + N_FACTORS),
      provenance: 'corpus',
    };
  }
  // Cold show — try projection from tags.
  if (!tags || tags.length === 0) return { vector: null, provenance: null };

  const v = new Float32Array(N_FACTORS);
  const biasOff = nTags * N_FACTORS;
  for (let i = 0; i < N_FACTORS; i++) v[i] = projectionWeights[biasOff + i];

  let matched = 0;
  for (const t of tags) {
    const name = typeof t === 'string' ? t : t?.name;
    if (!name) continue;
    const col = projectionVocab.get(name.toLowerCase());
    if (col == null) continue;
    const off = col * N_FACTORS;
    for (let i = 0; i < N_FACTORS; i++) v[i] += projectionWeights[off + i];
    matched++;
  }
  if (matched === 0) return { vector: null, provenance: null };
  return { vector: v, provenance: 'projected' };
}


// -------------------------------------------------------- cosine + delta

/**
 * Cosine similarity between user vector and item embedding.
 * @returns {{cosine: number|null, provenance: 'corpus'|'projected'|null}}
 */
export function getCFCosine(aniListId, tags, userVector) {
  if (!userVector || userVector.length !== N_FACTORS) {
    return { cosine: null, provenance: null };
  }
  const { vector, provenance } = getItemEmbedding(aniListId, tags);
  if (!vector) return { cosine: null, provenance: null };
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < N_FACTORS; i++) {
    const a = userVector[i], b = vector[i];
    dot += a * b;
    na += a * a;
    nb += b * b;
  }
  if (na === 0 || nb === 0) return { cosine: 0, provenance };
  return { cosine: dot / Math.sqrt(na * nb), provenance };
}

/** Smooth confidence curve: 1 − exp(−N / 25). Design doc §3.8. */
export function influenceWeight(nRatedShows) {
  if (!Number.isFinite(nRatedShows) || nRatedShows <= 0) return 0;
  return 1 - Math.exp(-nRatedShows / 25);
}

/**
 * Bounded CF delta on the internal ranking score. Returns 0 when CF
 * has nothing to say (no user vector, no item match).
 *
 * Formula (deviates from design doc §3.9 — corrected for ALS factor
 * sign convention): delta = K_MAX · influence · cosine · multiplier
 * where cosine ∈ [−1,+1] is already signed (ALS factors are real-valued,
 * not non-negative). The (cosine·2 − 1) remap in the design doc assumed
 * NMF-style non-negative factors; with vanilla ALS, the cosine is
 * already the right sign and magnitude.
 *
 * @returns {{delta: number, cosine: number|null, provenance: 'corpus'|'projected'|null}}
 */
export function cfRankDelta(aniListId, tags, userVector, nRatedShows) {
  const { cosine, provenance } = getCFCosine(aniListId, tags, userVector);
  if (cosine == null) return { delta: 0, cosine: null, provenance: null };
  const w = influenceWeight(nRatedShows);
  const m = provenance === 'projected' ? PROJECTED_MULTIPLIER : 1.0;
  return { delta: K_MAX * w * cosine * m, cosine, provenance };
}


// --------------------------------------------------------------- exports

export const CF_CONSTANTS = Object.freeze({
  N_FACTORS,
  K_MAX,
  ALPHA,
  REGULARIZATION,
  PROJECTED_MULTIPLIER,
  FORMAT_VERSION,
});
