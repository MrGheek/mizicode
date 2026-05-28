/**
 * hailo-backend.ts
 *
 * Hailo-16L inference and embedding backend.
 * Activated only when hardware probe detects a Hailo device.
 *
 * On Hailo-16L hardware:
 *  - Embeddings (memory recall, skill scoring, goal matching) run via HailoRT
 *    using a pre-compiled sentence-transformer HEF model.
 *  - Generation inference runs via Ollama on CPU (Hailo is not suited for
 *    autoregressive LLM generation at consumer scale).
 *
 * HailoRT Python SDK usage:
 *   pip install hailort   # installs hailo_platform bindings
 *   The HEF model is obtained from Hailo Model Zoo:
 *   https://github.com/hailo-ai/hailo_model_zoo/blob/master/docs/public_models/HAILO8L/
 *
 * All operations are strictly gated behind hasHailo detection.
 * If no Hailo device is present, all functions are no-ops or return null.
 */

import { execSync, spawnSync } from "child_process";
import path from "path";
import os from "os";
import { logger } from "../lib/logger.js";
import type { HardwareProfile } from "./hardware-probe.js";

const HAILO_HEF_DIR =
  process.env.MIZI_HAILO_HEF_DIR ||
  path.join(os.homedir(), ".mizi", "hailo-models");

const EMBEDDING_HEF =
  process.env.MIZI_HAILO_EMBEDDING_HEF ||
  path.join(HAILO_HEF_DIR, "sentence-transformer.hef");

const EMBEDDING_DIM = parseInt(process.env.MIZI_HAILO_EMBEDDING_DIM || "384", 10);

let hailoAvailable: boolean | null = null;

function checkHailoRuntime(): boolean {
  if (hailoAvailable !== null) return hailoAvailable;
  try {
    const result = spawnSync(
      "python3",
      ["-c", "import hailo_platform; print(hailo_platform.__version__)"],
      { timeout: 5000, encoding: "utf8" },
    );
    hailoAvailable = result.status === 0;
    if (hailoAvailable) {
      logger.info({ version: (result.stdout ?? "").trim() }, "[hailo] HailoRT Python SDK found");
    }
  } catch {
    hailoAvailable = false;
  }
  return hailoAvailable;
}

export function isHailoAvailable(): boolean {
  return checkHailoRuntime();
}

/**
 * Run sentence embedding via HailoRT Python SDK.
 *
 * Uses hailo_platform.VDevice + InferModel API to run a pre-compiled
 * sentence-transformer HEF on the Hailo-16L accelerator.
 *
 * Input texts are tokenized with the Hugging Face fast tokenizer
 * (max_length=128, padding="max_length") before being passed to the HEF.
 *
 * Returns null (falling back to CPU) if:
 *  - The HailoRT SDK is not installed
 *  - The HEF file is missing
 *  - Any runtime error occurs
 */
export async function embedViaHailo(texts: string[]): Promise<number[][] | null> {
  if (!isHailoAvailable()) return null;

  const fs = await import("fs");
  if (!fs.existsSync(EMBEDDING_HEF)) {
    logger.warn({ hef: EMBEDDING_HEF }, "[hailo] Embedding HEF not found — falling back to CPU");
    return null;
  }

  // Write the inference script to a temp file — avoids shell quoting issues with
  // large or unicode-heavy input batches.
  const scriptPath = path.join(os.tmpdir(), "mizi-hailo-embed.py");
  const script = `
import json, sys, numpy as np

hef_path = sys.argv[1]
input_file = sys.argv[2]
with open(input_file, "r") as f:
    texts = json.load(f)

try:
    from hailo_platform import (
        VDevice, HailoStreamInterface,
        ConfigureParams, HailoSchedulingAlgorithm,
        HailoRTException,
    )
    from transformers import AutoTokenizer

    # Tokenize — must match the sequence length the HEF was compiled for.
    tokenizer = AutoTokenizer.from_pretrained("sentence-transformers/all-MiniLM-L6-v2")
    encoded = tokenizer(
        texts,
        padding="max_length",
        truncation=True,
        max_length=128,
        return_tensors="np",
    )
    input_ids      = encoded["input_ids"].astype(np.int32)
    attention_mask = encoded["attention_mask"].astype(np.int32)

    target = VDevice()
    infer_model = target.create_infer_model(hef_path)

    with infer_model.configure() as configured_model:
        bindings_list = []
        for i in range(len(texts)):
            bindings = configured_model.create_bindings()
            bindings.input("input_ids").set_buffer(input_ids[i])
            bindings.input("attention_mask").set_buffer(attention_mask[i])
            shape = configured_model.output().shape
            out_buf = np.empty(shape, dtype=np.float32)
            bindings.output().set_buffer(out_buf)
            bindings_list.append((bindings, out_buf))

        configured_model.run([b for b, _ in bindings_list], timeout_ms=10000)

    # Mean-pool the last hidden state token embeddings (sentence-transformer style)
    embeddings = []
    for i, (bindings, raw) in enumerate(bindings_list):
        # raw shape is (seq_len, hidden) — mean pool over seq dimension
        mask = attention_mask[i]
        expanded = mask[:raw.shape[0]].reshape(-1, 1).astype(np.float32)
        pooled = (raw * expanded).sum(axis=0) / expanded.sum().clip(min=1e-9)
        # L2-normalise
        norm = np.linalg.norm(pooled)
        pooled = pooled / norm if norm > 0 else pooled
        embeddings.append(pooled.tolist())

    print(json.dumps(embeddings))

except Exception as e:
    # Let the caller fall back to CPU embedding
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`;

  try {
    const fsSync = await import("fs");
    fsSync.writeFileSync(scriptPath, script, "utf8");

    // Write batch input to a temp JSON file to avoid shell-quoting problems
    const inputPath = path.join(os.tmpdir(), "mizi-hailo-input.json");
    fsSync.writeFileSync(inputPath, JSON.stringify(texts), "utf8");

    const result = spawnSync(
      "python3",
      [scriptPath, EMBEDDING_HEF, inputPath],
      { timeout: 30000, encoding: "utf8" },
    );

    if (result.status !== 0) {
      logger.warn({ stderr: result.stderr }, "[hailo] HailoRT embedding failed — falling back to CPU");
      return null;
    }

    const parsed = JSON.parse(result.stdout) as number[][] | { error: string };
    if ("error" in parsed) {
      logger.warn({ err: (parsed as { error: string }).error }, "[hailo] HailoRT embedding error — falling back to CPU");
      return null;
    }
    return parsed as number[][];
  } catch (err) {
    logger.warn({ err }, "[hailo] HailoRT embedding exception — falling back to CPU");
    return null;
  }
}

export function configureOllamaForHailo(hw: HardwareProfile): Record<string, string> {
  if (!hw.hasHailo) return {};
  // Hailo is for embeddings only; Ollama runs generation on CPU
  logger.info("[hailo] Configuring Ollama for CPU-only generation (Hailo handles embeddings)");
  return {
    OLLAMA_RUNNERS: "cpu",
    MIZI_HAILO_EMBEDDING: "true",
    MIZI_HAILO_TOPS: String(hw.hailoTops ?? 16),
  };
}

export function getHailoStatus(hw: HardwareProfile): {
  detected: boolean;
  runtimeAvailable: boolean;
  hefPath: string;
  embeddingDim: number;
  tops: number | null;
} {
  return {
    detected: hw.hasHailo,
    runtimeAvailable: hw.hasHailo ? isHailoAvailable() : false,
    hefPath: EMBEDDING_HEF,
    embeddingDim: EMBEDDING_DIM,
    tops: hw.hailoTops,
  };
}
