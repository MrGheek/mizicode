/**
 * ollama-driver.ts
 *
 * Ollama inference driver for local mode.
 * Targets http://localhost:11434 (default Ollama address).
 * Auto-selects CUDA / Metal / HailoRT / CPU backend based on HardwareProfile.
 * Implements health-check, model-list proxy, and model pull.
 */

import { execSync, spawn } from "child_process";
import { logger } from "../lib/logger.js";
import type { HardwareProfile } from "./hardware-probe.js";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaHealthResult {
  ok: boolean;
  version?: string;
  error?: string;
}

async function ollamaFetch<T = unknown>(
  path: string,
  opts: RequestInit = {},
  timeoutMs = 5000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE}${path}`, {
      ...opts,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama ${path} → HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth(): Promise<OllamaHealthResult> {
  try {
    const data = await ollamaFetch<{ version?: string }>("/api/version", {}, 3000);
    return { ok: true, version: data.version };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listModels(): Promise<OllamaModel[]> {
  const data = await ollamaFetch<{ models?: OllamaModel[] }>("/api/tags");
  return data.models ?? [];
}

export async function pullModel(
  modelId: string,
  onProgress?: (status: string, completed?: number, total?: number) => void,
): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelId, stream: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama pull failed: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as {
          status?: string;
          completed?: number;
          total?: number;
          error?: string;
        };
        if (evt.error) throw new Error(`Ollama pull error: ${evt.error}`);
        if (onProgress) onProgress(evt.status ?? "", evt.completed, evt.total);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Ollama pull error")) throw e;
      }
    }
  }
}

export async function deleteModel(modelId: string): Promise<void> {
  await ollamaFetch("/api/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelId }),
  });
}

export async function createModelFromGGUF(
  modelId: string,
  ggufPath: string,
): Promise<void> {
  const modelfile = `FROM ${ggufPath}\n`;
  await ollamaFetch("/api/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelId, modelfile }),
  });
}

export async function generateCompletion(params: {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: Record<string, unknown>;
}): Promise<{ response: string; done: boolean }> {
  return ollamaFetch<{ response: string; done: boolean }>("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  }, 120_000);
}

export async function chatCompletion(params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  options?: Record<string, unknown>;
}): Promise<{ message: { role: string; content: string }; done: boolean }> {
  return ollamaFetch<{ message: { role: string; content: string }; done: boolean }>(
    "/api/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    },
    120_000,
  );
}

export async function generateEmbedding(
  model: string,
  input: string | string[],
): Promise<number[][]> {
  const data = await ollamaFetch<{ embeddings?: number[][] }>("/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: Array.isArray(input) ? input : [input] }),
  }, 30_000);
  return data.embeddings ?? [];
}

function resolveOllamaEnv(hw: HardwareProfile): Record<string, string> {
  const env: Record<string, string> = {};

  if (hw.primaryBackend === "cuda") {
    env.CUDA_VISIBLE_DEVICES = hw.gpus.map((_, i) => i).join(",");
  } else if (hw.primaryBackend === "metal") {
    // Metal is auto-selected on macOS; no extra env needed
  } else if (hw.primaryBackend === "hailo") {
    // Hailo: run Ollama on CPU; HailoRT handles embeddings separately
    env.OLLAMA_RUNNERS = "cpu";
  }

  return env;
}

export function tryAutoStartOllama(hw: HardwareProfile): boolean {
  try {
    const which = execSync("which ollama 2>/dev/null || command -v ollama 2>/dev/null", {
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();

    if (!which) {
      logger.warn("[ollama-driver] Ollama binary not found — cannot auto-start");
      return false;
    }

    const extraEnv = resolveOllamaEnv(hw);
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...extraEnv },
    });
    child.unref();

    logger.info({ pid: child.pid, backend: hw.primaryBackend }, "[ollama-driver] Ollama auto-started");
    return true;
  } catch (err) {
    logger.warn({ err }, "[ollama-driver] Failed to auto-start Ollama");
    return false;
  }
}
