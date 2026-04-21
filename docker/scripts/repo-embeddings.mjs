/**
 * repo-embeddings.mjs — Semantic embedding provider for Repo Intelligence
 *
 * Strategy (in priority order):
 *   1. Local ONNX CPU inference — @xenova/transformers all-MiniLM-L6-v2 (quantized int8)
 *      Activated when FLOATR_EMBEDDINGS=local (default if not set)
 *   2. Remote HTTP fallback — POST to FLOATR_REMOTE_EMBEDDINGS_URL with Bearer token
 *      Activated when FLOATR_EMBEDDINGS=remote
 *   3. Character n-gram TF-IDF (NGRAM_DIM=512) — always available, no dependencies
 *      Activated when FLOATR_EMBEDDINGS=ngram, or when local/remote fail
 *
 * CPU limits:
 *   ONNX runtime is constrained to FLOATR_EMBED_THREADS (default: 2) threads.
 *   Model cache is at /workspace/.floatr/models (configurable via FLOATR_MODEL_CACHE).
 *
 * Usage:
 *   import { embed, embedBatch, EMBEDDING_DIM } from './repo-embeddings.mjs';
 *   const vec = await embed("function handleRequest(req, res)");
 *   const vecs = await embedBatch(["text1", "text2", ...], { maxBatch: 32 });
 */

const STRATEGY = process.env.FLOATR_EMBEDDINGS || 'local'; // local | remote | ngram
const REMOTE_URL = process.env.FLOATR_REMOTE_EMBEDDINGS_URL || '';
const REMOTE_TOKEN = process.env.FLOATR_REMOTE_EMBEDDINGS_TOKEN || process.env.OMNIQL_MEM_AUTH_TOKEN || '';
const MODEL_CACHE = process.env.FLOATR_MODEL_CACHE || '/workspace/.floatr/models';
const EMBED_THREADS = parseInt(process.env.FLOATR_EMBED_THREADS || '2', 10);
const MODEL_NAME = process.env.FLOATR_EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2';

export const NGRAM_DIM = 512;
export const MINILM_DIM = 384; // all-MiniLM-L6-v2 output dimension
export const EMBEDDING_DIM = STRATEGY === 'ngram' ? NGRAM_DIM : MINILM_DIM;

// ─── N-gram fallback (no deps) ────────────────────────────────────────────────

function charNgramVec(text) {
  const t = text.toLowerCase().replace(/[^a-z0-9_]/g, ' ').trim();
  const vec = new Array(NGRAM_DIM).fill(0);
  for (let i = 0; i <= t.length - 3; i++) {
    const g = t.slice(i, i + 3);
    let h = 0;
    for (let k = 0; k < g.length; k++) h = (Math.imul(31, h) + g.charCodeAt(k)) | 0;
    vec[Math.abs(h) % NGRAM_DIM] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

// ─── Local ONNX inference via @xenova/transformers ───────────────────────────

let _pipeline = null;
let _pipelineError = null;

async function loadLocalPipeline() {
  if (_pipeline) return _pipeline;
  if (_pipelineError) throw _pipelineError;

  try {
    const { env, pipeline } = await import('@xenova/transformers');

    // Point cache to workspace dir so model is persisted across restarts
    env.cacheDir = MODEL_CACHE;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    // Constrain ONNX Runtime threading
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = EMBED_THREADS;
    }

    console.log(`[repo-embeddings] Loading ${MODEL_NAME} (quantized=true, threads=${EMBED_THREADS})...`);
    _pipeline = await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
    console.log(`[repo-embeddings] Model loaded`);
    return _pipeline;
  } catch (err) {
    _pipelineError = err;
    throw err;
  }
}

async function embedLocal(text) {
  const pipe = await loadLocalPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  // output.data is Float32Array of length 384
  return Array.from(output.data);
}

// ─── Remote HTTP embedding ────────────────────────────────────────────────────

async function embedRemote(text) {
  if (!REMOTE_URL) throw new Error('FLOATR_REMOTE_EMBEDDINGS_URL not set');
  const res = await fetch(REMOTE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(REMOTE_TOKEN ? { 'Authorization': `Bearer ${REMOTE_TOKEN}` } : {}),
    },
    body: JSON.stringify({ input: text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Remote embeddings error: HTTP ${res.status}`);
  const data = await res.json();
  // Support OpenAI-compatible format ({ data: [{ embedding: [...] }] }) and raw array
  const vec = data?.data?.[0]?.embedding || data?.embedding || data;
  if (!Array.isArray(vec)) throw new Error('Remote embeddings: unexpected response shape');
  return vec;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute a single embedding vector for `text`.
 * Falls back through: local → remote → ngram.
 * Always returns a number[] — never throws.
 */
export async function embed(text) {
  if (!text || text.trim().length === 0) return new Array(EMBEDDING_DIM).fill(0);

  if (STRATEGY === 'ngram') return charNgramVec(text);

  if (STRATEGY === 'remote') {
    try { return await embedRemote(text); } catch (err) {
      console.warn(`[repo-embeddings] Remote failed: ${err.message} — falling back to ngram`);
      return charNgramVec(text);
    }
  }

  // Default: local ONNX with remote → ngram fallback chain
  try { return await embedLocal(text); } catch (localErr) {
    console.warn(`[repo-embeddings] Local ONNX failed: ${localErr.message}`);
    if (REMOTE_URL) {
      try { return await embedRemote(text); } catch (remoteErr) {
        console.warn(`[repo-embeddings] Remote fallback failed: ${remoteErr.message} — using ngram`);
      }
    }
    return charNgramVec(text);
  }
}

/**
 * Compute embeddings for a batch of texts.
 * Processes in chunks of maxBatch to avoid OOM.
 * Silently falls back per-item on failure.
 */
export async function embedBatch(texts, { maxBatch = 32, onProgress } = {}) {
  const results = [];
  for (let i = 0; i < texts.length; i += maxBatch) {
    const slice = texts.slice(i, i + maxBatch);
    for (const text of slice) {
      results.push(await embed(text));
    }
    if (onProgress) onProgress(Math.min(i + maxBatch, texts.length), texts.length);
  }
  return results;
}

export { charNgramVec };
