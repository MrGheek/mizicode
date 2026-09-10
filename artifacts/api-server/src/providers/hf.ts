/**
 * hf.ts — HuggingFace Hub integration for the provider resolver.
 *
 * Parses a pasted HuggingFace model URL (or bare "author/repo" id), inspects the
 * repo via the HF API, and derives the GPU sizing + runtime requirements needed
 * to serve it on a self-orchestrated instance (Vast/Vultr).
 *
 * Security:
 *   - Repo ids are strictly validated against a safe-path allowlist (same rules
 *     as hf-model-sourcer.ts) before any URL construction or fetch.
 *   - No shell execution here; the resolved values flow into offer search params
 *     and the onstart script via structured fields only.
 */

import { logger } from "../lib/logger";

const HF_API_BASE = "https://huggingface.co/api";

// Allow only safe HF model ids: "author/model-name" with alphanumerics, hyphens, dots, underscores.
const SAFE_MODEL_ID_RE = /^[a-zA-Z0-9_.\-]{1,100}\/[a-zA-Z0-9_.\-]{1,200}$/;

// Full pasted URLs: https://huggingface.co/owner/repo  or  hf.co/owner/repo.
// Optionally allows a trailing path (e.g. /tree/main) that is stripped.
const HF_URL_RE =
  /^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\/([a-zA-Z0-9_.\-]{1,100}\/[a-zA-Z0-9_.\-]{1,200})(?:\/.*)?$/;

export type ModelFormat = "safetensors" | "gguf" | "exl2" | "awq" | "gptq" | "unknown";

export interface HfRepoInfo {
  repoId: string;
  /** Decimal GB of stored weights (usedStorage). */
  sizeGb: number;
  formats: ModelFormat[];
  /** config.architectures[0], e.g. KimiK3ForConditionalGeneration. */
  architecture: string | null;
  /** True when the repo ships custom modeling_*.py (needs --trust-remote-code). */
  needsRemoteCode: boolean;
  /** True for image-text-to-text / multimodal pipelines. */
  multimodal: boolean;
  /** True when the repo requires a gated-access token. */
  gated: boolean;
  /** Files that hint at quantization, e.g. index.json with mxfp4. */
  quantHint: string | null;
  /**
   * Recommended instance sizing derived from sizeGb + format:
   *   diskGb — weights ×1.25 headroom (HF stores shards + index overhead)
   *   vramGb — weights rounded up to a common VRAM step; gated by format
   *   numGpus — vramGb split across 80 GB GPUs (A100/H100 class)
   */
  sizing: {
    diskGb: number;
    vramGb: number;
    numGpus: number;
    estimatedDownloadHoursAt1Gbps: number;
  };
}

function assertSafeModelId(repoId: string): void {
  if (!SAFE_MODEL_ID_RE.test(repoId)) {
    throw new Error(`Invalid model id: "${repoId}". Expected "author/model-name" with safe characters only.`);
  }
}

/**
 * Parse a pasted URL or bare id into a normalized "author/repo" id.
 * Throws on non-HF hosts, unsafe characters, or missing repo.
 */
export function parseHfRepoRef(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Empty model reference");

  // Bare "author/repo" id (also used by the local HF sourcer).
  if (SAFE_MODEL_ID_RE.test(trimmed)) return trimmed;

  const m = trimmed.match(HF_URL_RE);
  if (m) return m[1];

  throw new Error(
    `Unrecognised model reference: "${input}". ` +
    'Paste a HuggingFace URL (https://huggingface.co/author/repo) or a bare "author/repo" id.',
  );
}

export function detectFormats(filenames: string[]): ModelFormat[] {
  const formats = new Set<ModelFormat>();
  for (const f of filenames) {
    const lower = f.toLowerCase();
    if (lower.endsWith(".gguf")) formats.add("gguf");
    else if (lower.endsWith(".safetensors")) formats.add("safetensors");
    else if (lower.endsWith(".exl2") || /\.(?:exl2|bnb)\b/.test(lower)) formats.add("exl2");
    else if (lower.endsWith(".awq")) formats.add("awq");
    else if (lower.endsWith(".gptq")) formats.add("gptq");
  }
  return Array.from(formats);
}

function detectQuantHint(filenames: string[]): string | null {
  const joined = filenames.join("\n");
  if (/mxfp4|fp4|compressed-tensors/.test(joined)) return "mxfp4-compressed-tensors";
  if (/fp8|int8/.test(joined)) return "fp8";
  if (/\bq4_|q5_|q8_|iq4|k_m/.test(joined)) return "gguf-quant";
  if (/\bawq\b/.test(joined)) return "awq";
  if (/\bgptq\b/.test(joined)) return "gptq";
  return null;
}

/** Estimate download hours at a given Mbps. Mirrors vastai.estimateDownloadHours. */
export function estimateDownloadHours(sizeGb: number, mbps: number): number {
  if (!sizeGb || sizeGb <= 0) return 0;
  if (!mbps || mbps <= 0) return Number.POSITIVE_INFINITY;
  return (sizeGb * 8000) / mbps / 3600;
}

function computeSizing(sizeGb: number, formats: ModelFormat[]): HfRepoInfo["sizing"] {
  const diskGb = Math.ceil(sizeGb * 1.25);
  // GGUF is served by llama.cpp/vLLM on CPU or a single GPU; safetensors FP/quant
  // models need VRAM >= weights. Round up to a sane step so offer search finds
  // hosts (e.g. a 22 GB model wants 24/48 GB class GPUs).
  let vramGb = Math.ceil(sizeGb);
  if (vramGb < 8) vramGb = 8;
  else if (vramGb < 16) vramGb = 16;
  else if (vramGb < 24) vramGb = 24;
  else if (vramGb < 48) vramGb = 48;
  else if (vramGb < 80) vramGb = 80;
  // Large models: split across 80 GB GPUs (A100/H100 class). Cap at 8 GPUs to
  // avoid absurd offers; 8×80 GB = 640 GB > any single repo in the wild.
  const numGpus = vramGb > 640 ? 8 : Math.max(1, Math.min(8, Math.ceil(vramGb / 80)));
  // Effective per-GPU VRAM need for offer search (each GPU must hold its shard).
  const perGpuVram = Math.ceil(vramGb / numGpus);

  return {
    diskGb,
    vramGb: perGpuVram,
    numGpus,
    estimatedDownloadHoursAt1Gbps: estimateDownloadHours(sizeGb, 1000),
  };
}

export interface InspectHfRepoOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Fetch repo metadata and derive everything needed to size + gate a GPU boot.
 * Uses fetch with a timeout; throws on network/API errors so callers can surface
 * a clear "model could not be inspected" message.
 */
export async function inspectHfRepo(repoId: string, opts: InspectHfRepoOptions = {}): Promise<HfRepoInfo> {
  assertSafeModelId(repoId);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  let resp: Response;
  try {
    resp = await fetchImpl(`${HF_API_BASE}/models/${repoId}`, { headers, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Model "${repoId}" is gated — set HF_TOKEN to access it.`);
    }
    throw new Error(`HuggingFace API error ${resp.status}: ${await resp.text()}`);
  }

  const meta = (await resp.json()) as Record<string, unknown>;
  const siblings = Array.isArray(meta.siblings) ? (meta.siblings as Array<{ rfilename?: string }>) : [];
  const filenames = siblings.map((s) => s.rfilename || "");

  const formats = detectFormats(filenames);
  if (formats.length === 0) formats.push("unknown");

  const sizeBytes = typeof meta.usedStorage === "number" ? meta.usedStorage : 0;
  const sizeGb = sizeBytes / 1e9;

  const config = (meta.config as Record<string, unknown>) || {};
  const architectures = config.architectures;
  const architecture = Array.isArray(architectures) && architectures.length > 0
    ? String(architectures[0])
    : null;

  const autoMap = config.auto_map;
  const needsRemoteCode = !!autoMap || filenames.some((f) => /^modeling_[a-z0-9_]+\.py$/i.test(f));

  return {
    repoId,
    sizeGb: Math.round(sizeGb * 10) / 10,
    formats,
    architecture,
    needsRemoteCode,
    multimodal: meta.pipeline_tag === "image-text-to-text",
    gated: !!meta.gated && meta.gated !== "false",
    quantHint: detectQuantHint(filenames),
    sizing: computeSizing(sizeGb, formats),
  };
}

/**
 * Best-effort repo inspection with an empty "failed" sentinel instead of throwing.
 * Used where the failure should not abort the request (e.g. offer listing).
 */
export async function tryInspectHfRepo(repoId: string, opts: InspectHfRepoOptions = {}): Promise<HfRepoInfo | null> {
  try {
    return await inspectHfRepo(repoId, opts);
  } catch (err) {
    logger.warn({ err, repoId }, "[hf] model inspection failed");
    return null;
  }
}
