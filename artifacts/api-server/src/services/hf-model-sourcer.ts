/**
 * hf-model-sourcer.ts
 *
 * HuggingFace Hub model sourcing for Mizi-Local.
 * Searches HF Hub for GGUF files matching the current hardware tier,
 * and provides a pull action that downloads a selected GGUF and imports
 * it into Ollama via `ollama create`.
 *
 * Security:
 *   - All user-controlled inputs (modelId, ggufFile) are strictly validated
 *     against a safe-path allowlist before use.
 *   - Shell execution uses spawnSync with argv arrays (no shell: true) to
 *     prevent command injection.
 *   - destPath is resolved and verified to be inside DOWNLOAD_DIR (path traversal guard).
 */

import { spawnSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "../lib/logger.js";
import { createModelFromGGUF } from "./ollama-driver.js";

const HF_API_BASE = "https://huggingface.co/api";
const HF_HUB_BASE = "https://huggingface.co";

// ── Input validation ──────────────────────────────────────────────────────────

// Allow only safe HF model IDs: "author/model-name" with alphanumerics, hyphens, dots, underscores.
const SAFE_MODEL_ID_RE = /^[a-zA-Z0-9_.\-]{1,100}\/[a-zA-Z0-9_.\-]{1,200}$/;

// Allow only safe GGUF file names: no path separators, no shell metacharacters.
const SAFE_GGUF_FILE_RE = /^[a-zA-Z0-9_.\-]{1,200}\.gguf$/i;

function assertSafeModelId(modelId: string): void {
  if (!SAFE_MODEL_ID_RE.test(modelId)) {
    throw new Error(`Invalid modelId format: "${modelId}". Expected "author/model-name" with safe characters only.`);
  }
}

function assertSafeGgufFile(ggufFile: string): void {
  const base = path.basename(ggufFile); // strip any path prefix
  if (!SAFE_GGUF_FILE_RE.test(base)) {
    throw new Error(`Invalid ggufFile name: "${ggufFile}". Must be a .gguf filename with safe characters only.`);
  }
}

function assertPathInsideDir(filePath: string, dir: string): void {
  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(dir);
  if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
    throw new Error(`Path traversal attempt detected: ${filePath} is outside ${dir}`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HFModelFile {
  rfilename: string;
  size?: number;
  oid?: string;
}

export interface HFModelSearchResult {
  modelId: string;
  author: string;
  gated?: string | boolean;
  downloads?: number;
  likes?: number;
  tags?: string[];
  /** HF API v2 returns GGUF entries under `siblings`. `files` kept for compatibility with test fixtures. */
  siblings?: HFModelFile[];
  files?: HFModelFile[];
}

export interface HFGGUFModel {
  modelId: string;
  displayName: string;
  author: string;
  ggufFile: string;
  fileSizeGb: number;
  downloads: number;
  likes: number;
  downloadUrl: string;
  tags: string[];
}

// ── HF API helpers ────────────────────────────────────────────────────────────

async function hfFetch<T>(apiPath: string): Promise<T> {
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${HF_API_BASE}${apiPath}`, { headers });
  if (!res.ok) {
    throw new Error(`HuggingFace API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Search HuggingFace Hub for GGUF files matching a parameter count range.
 * paramBudgetGb: max estimated VRAM/RAM in GB to filter file sizes.
 */
export async function searchHFGGUFModels(options: {
  query?: string;
  paramBudgetGb: number;
  limit?: number;
}): Promise<HFGGUFModel[]> {
  const limit = options.limit ?? 20;
  const query = options.query || "GGUF coding assistant";

  const params = new URLSearchParams({
    search: query,
    filter: "gguf",
    sort: "downloads",
    direction: "-1",
    limit: String(limit),
    full: "true",
  });

  let models: HFModelSearchResult[];
  try {
    models = await hfFetch<HFModelSearchResult[]>(`/models?${params}`);
  } catch (err) {
    logger.warn({ err }, "[hf-sourcer] Failed to search HF Hub — returning empty list");
    return [];
  }

  const results: HFGGUFModel[] = [];

  for (const model of models) {
    // HF API returns file listings under `siblings`; fall back to `files` for
    // test fixtures and any legacy API response shape.
    const allFiles = model.siblings ?? model.files ?? [];
    if (!allFiles.length) continue;

    const ggufFiles = allFiles.filter(
      (f) => f.rfilename.toLowerCase().endsWith(".gguf") && !f.rfilename.includes("mmproj"),
    );

    if (ggufFiles.length === 0) continue;

    // Pick the Q4_K_M or best quant file
    const preferredFile =
      ggufFiles.find((f) => f.rfilename.toLowerCase().includes("q4_k_m")) ??
      ggufFiles.find((f) => f.rfilename.toLowerCase().includes("q4")) ??
      ggufFiles[0];

    if (!preferredFile) continue;

    const fileSizeGb = preferredFile.size ? preferredFile.size / (1024 ** 3) : 0;

    // Filter by budget (allow up to 85% of budget)
    if (fileSizeGb > options.paramBudgetGb * 0.85 && fileSizeGb > 0) continue;

    const downloadUrl = `${HF_HUB_BASE}/${model.modelId}/resolve/main/${preferredFile.rfilename}`;

    results.push({
      modelId: model.modelId,
      displayName: model.modelId.split("/").pop() ?? model.modelId,
      author: model.author || model.modelId.split("/")[0] || "unknown",
      ggufFile: preferredFile.rfilename,
      fileSizeGb: Math.round(fileSizeGb * 10) / 10,
      downloads: model.downloads ?? 0,
      likes: model.likes ?? 0,
      downloadUrl,
      tags: model.tags ?? [],
    });
  }

  return results.sort((a, b) => b.downloads - a.downloads);
}

const DOWNLOAD_DIR =
  process.env.MIZI_LOCAL_MODELS_DIR ||
  path.join(os.homedir(), ".mizi", "models");

/**
 * Download a HuggingFace GGUF file and import it into Ollama.
 * Returns the ollama model id (sanitized from the HF path).
 *
 * Inputs are validated against strict allowlists before use.
 * No shell string interpolation — subprocess calls use argv arrays only.
 */
export async function pullHFGGUFIntoOllama(
  modelId: string,
  ggufFile: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<string> {
  // Strict input validation before any filesystem or subprocess operations
  assertSafeModelId(modelId);
  assertSafeGgufFile(ggufFile);

  const safeModelId = modelId.toLowerCase().replace(/\//g, "--");
  const safeFile = path.basename(ggufFile); // already validated by assertSafeGgufFile
  const destDir = path.join(DOWNLOAD_DIR, safeModelId);
  const destPath = path.join(destDir, safeFile);

  // Verify resolved paths stay inside DOWNLOAD_DIR (defence-in-depth against path traversal)
  assertPathInsideDir(destDir, DOWNLOAD_DIR);
  assertPathInsideDir(destPath, DOWNLOAD_DIR);

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  if (!fs.existsSync(destPath)) {
    const downloadUrl = `${HF_HUB_BASE}/${modelId}/resolve/main/${ggufFile}`;
    logger.info({ modelId, ggufFile, destPath }, "[hf-sourcer] Downloading GGUF");

    const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;

    const hfCliPath = tryWhich("huggingface-cli");
    if (hfCliPath) {
      // Use huggingface-cli with argv array — non-blocking spawn + progress
      const args = ["download", modelId, ggufFile, "--local-dir", destDir];
      if (token) args.push("--token", token);
      await spawnAsync(hfCliPath, args, onProgress);
    } else {
      // Use curl with argv array — non-blocking spawn + progress via stderr
      const curlPath = tryWhich("curl") ?? "curl";
      const args = ["-L", "--progress-bar", "-o", destPath, downloadUrl];
      if (token) args.push("-H", `Authorization: Bearer ${token}`);
      await spawnAsync(curlPath, args, onProgress);
    }
  } else {
    logger.info({ destPath }, "[hf-sourcer] GGUF already cached locally");
  }

  const ollamaModelId = `${safeModelId}:hf-local`;
  logger.info({ ollamaModelId, destPath }, "[hf-sourcer] Importing GGUF into Ollama");
  await createModelFromGGUF(ollamaModelId, destPath);

  return ollamaModelId;
}

function tryWhich(cmd: string): string | null {
  const result = spawnSync("which", [cmd], { timeout: 2000 });
  if (result.status !== 0 || !result.stdout) return null;
  const out = result.stdout.toString().trim();
  return out || null;
}

/**
 * Non-blocking subprocess runner with optional progress reporting.
 *
 * Parses curl/huggingface-cli progress lines to extract byte counts and
 * fires `onProgress(downloaded, total)` when parseable values are found.
 * The event loop is never blocked — stdout/stderr are piped and consumed
 * incrementally as data arrives.
 */
function spawnAsync(
  cmd: string,
  args: string[],
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    // curl writes progress to stderr; huggingface-cli writes to stdout.
    const handleChunk = (data: Buffer) => {
      if (!onProgress) return;
      const text = data.toString();
      // curl --progress-bar: " 35%  123M  456M  0:01:23"
      const curlMatch = text.match(/(\d+)\s+(\d+[KMG]?)\s+(\d+[KMG]?)/);
      if (curlMatch) {
        const downloaded = parseHumanBytes(curlMatch[2] ?? "0");
        const total      = parseHumanBytes(curlMatch[3] ?? "0");
        if (downloaded > 0) onProgress(downloaded, total);
      }
    };
    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with status ${code ?? "signal"}`));
      }
    });
  });
}

/** Parse human-readable byte strings like "123M", "456K", "789G" → bytes. */
function parseHumanBytes(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)([KMG]?)$/i);
  if (!match) return 0;
  const n = parseFloat(match[1] ?? "0");
  switch ((match[2] ?? "").toUpperCase()) {
    case "K": return Math.round(n * 1024);
    case "M": return Math.round(n * 1024 * 1024);
    case "G": return Math.round(n * 1024 * 1024 * 1024);
    default:  return Math.round(n);
  }
}
