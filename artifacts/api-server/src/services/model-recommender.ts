/**
 * model-recommender.ts
 *
 * Maps HardwareProfile → ranked model recommendations with suitability scores
 * and plain-language explanations.
 *
 * Tiers:
 *   <4 GB RAM   → 1–3B quants (phi3-mini, qwen2.5:1.5b)
 *   4–8 GB      → 3–7B (llama3.2:3b, qwen2.5:7b)
 *   8–16 GB     → 7–13B (llama3.1:8b, qwen2.5:14b)
 *   16–32 GB    → 13–32B (qwen2.5:32b, codestral:22b)
 *   32–64 GB    → 32–70B (llama3.1:70b, qwen2.5:72b)
 *   64 GB+ / high-end GPU → 70B+ or largest available
 *   Apple Silicon unified memory: treated as VRAM (same tier as RAM)
 *   Hailo-16L: embedding specialist + paired Ollama model for generation
 */

import type { HardwareProfile } from "./hardware-probe.js";

export type Suitability = "recommended" | "compatible" | "too_large";

export interface ModelRecommendation {
  modelId: string;
  displayName: string;
  source: "ollama" | "huggingface";
  hfRepo?: string;
  hfFile?: string;
  paramCount: string;
  quantization: string;
  estimatedVramGb: number;
  suitability: Suitability;
  score: number;
  rationale: string;
  tags: string[];
}

const OLLAMA_CATALOG: ModelRecommendation[] = [
  {
    modelId: "phi3.5",
    displayName: "Phi-3.5 Mini",
    source: "ollama",
    paramCount: "3.8B",
    quantization: "Q4_K_M",
    estimatedVramGb: 2.6,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["fast", "cpu-friendly", "coding"],
  },
  {
    modelId: "qwen2.5:1.5b",
    displayName: "Qwen2.5 1.5B",
    source: "ollama",
    paramCount: "1.5B",
    quantization: "Q4_K_M",
    estimatedVramGb: 1.1,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["ultra-light", "cpu-friendly"],
  },
  {
    modelId: "qwen2.5-coder:3b",
    displayName: "Qwen2.5-Coder 3B",
    source: "ollama",
    paramCount: "3B",
    quantization: "Q4_K_M",
    estimatedVramGb: 2.0,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["coding", "fast"],
  },
  {
    modelId: "llama3.2:3b",
    displayName: "Llama 3.2 3B",
    source: "ollama",
    paramCount: "3B",
    quantization: "Q4_K_M",
    estimatedVramGb: 2.0,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["general", "fast"],
  },
  {
    modelId: "qwen2.5-coder:7b",
    displayName: "Qwen2.5-Coder 7B",
    source: "ollama",
    paramCount: "7B",
    quantization: "Q4_K_M",
    estimatedVramGb: 4.5,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["coding", "balanced"],
  },
  {
    modelId: "llama3.1:8b",
    displayName: "Llama 3.1 8B",
    source: "ollama",
    paramCount: "8B",
    quantization: "Q4_K_M",
    estimatedVramGb: 5.0,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["general", "balanced"],
  },
  {
    modelId: "deepseek-coder-v2:16b",
    displayName: "DeepSeek-Coder-V2 16B",
    source: "ollama",
    paramCount: "16B",
    quantization: "Q4_K_M",
    estimatedVramGb: 9.5,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["coding", "quality"],
  },
  {
    modelId: "qwen2.5-coder:14b",
    displayName: "Qwen2.5-Coder 14B",
    source: "ollama",
    paramCount: "14B",
    quantization: "Q4_K_M",
    estimatedVramGb: 9.0,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["coding", "quality"],
  },
  {
    modelId: "qwen2.5-coder:32b",
    displayName: "Qwen2.5-Coder 32B",
    source: "ollama",
    paramCount: "32B",
    quantization: "Q4_K_M",
    estimatedVramGb: 20.0,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["coding", "high-quality"],
  },
  {
    modelId: "codestral:22b",
    displayName: "Codestral 22B",
    source: "ollama",
    paramCount: "22B",
    quantization: "Q4_K_M",
    estimatedVramGb: 13.5,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["coding", "quality"],
  },
  {
    modelId: "llama3.1:70b",
    displayName: "Llama 3.1 70B",
    source: "ollama",
    paramCount: "70B",
    quantization: "Q4_K_M",
    estimatedVramGb: 42.0,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["high-quality", "large"],
  },
  {
    modelId: "qwen2.5-coder:72b",
    displayName: "Qwen2.5-Coder 72B",
    source: "ollama",
    paramCount: "72B",
    quantization: "Q4_K_M",
    estimatedVramGb: 44.0,
    suitability: "compatible",
    score: 0,
    rationale: "",
    tags: ["coding", "flagship"],
  },
];

function effectiveMemoryGb(hw: HardwareProfile): number {
  if (hw.isAppleSilicon && hw.unifiedMemoryGb) return hw.unifiedMemoryGb;
  if (hw.gpus.length > 0) return hw.gpus.reduce((acc, g) => acc + g.vramGb, 0);
  return hw.totalRamGb;
}

function buildRationale(
  model: ModelRecommendation,
  hw: HardwareProfile,
  effectiveGb: number,
): string {
  const fits = model.estimatedVramGb <= effectiveGb * 0.85;
  const backend = hw.primaryBackend;

  if (hw.hasHailo && hw.hailoTops) {
    return `Hailo-16L NPU (${hw.hailoTops} TOPS) handles embeddings; ${model.displayName} runs on CPU for generation. Best balance for your Hailo device.`;
  }
  if (hw.isAppleSilicon) {
    return `Runs via Ollama Metal on your ${hw.cpuModel} (${hw.unifiedMemoryGb} GB unified memory). ${fits ? "Fits comfortably in unified memory." : "May require memory swapping."}`;
  }
  if (backend === "cuda") {
    const totalVram = hw.gpus.reduce((a, g) => a + g.vramGb, 0);
    return `Runs via Ollama CUDA on ${hw.gpus.map((g) => g.name).join(" + ")} (${totalVram} GB VRAM total). ${fits ? "Fits in VRAM — fast inference." : "May need CPU offloading."}`;
  }
  return `Runs on CPU (${hw.cpuCores} cores, ${effectiveGb} GB RAM available). ${fits ? "Fits in RAM — expect moderate speed." : "Too large for comfortable CPU inference."}`;
}

export function getRecommendations(hw: HardwareProfile): ModelRecommendation[] {
  const effectiveGb = effectiveMemoryGb(hw);

  const catalog = OLLAMA_CATALOG.map((model) => {
    const fitRatio = model.estimatedVramGb / (effectiveGb * 0.85);
    let suitability: Suitability;
    let score: number;

    if (fitRatio <= 0.6) {
      suitability = "compatible";
      score = 60;
    } else if (fitRatio <= 1.0) {
      suitability = "recommended";
      score = 100 - Math.round(fitRatio * 40);
    } else {
      suitability = "too_large";
      score = 0;
    }

    // Boost coding models
    const isCodingModel = model.tags.includes("coding");
    if (isCodingModel) score = Math.min(100, score + 10);

    // Prefer closest fit to memory budget without going over (sweet spot is 40–80%)
    const sweetSpotBonus = fitRatio >= 0.4 && fitRatio <= 0.8 ? 15 : 0;
    score = Math.min(100, score + sweetSpotBonus);

    // Hailo: prefer smaller models (NPU handles embeddings only)
    if (hw.hasHailo && model.estimatedVramGb > 4) score = Math.max(0, score - 20);

    return {
      ...model,
      suitability,
      score,
      rationale: buildRationale(model, hw, effectiveGb),
    };
  });

  return catalog.sort((a, b) => b.score - a.score);
}

export function getTopRecommendation(hw: HardwareProfile): ModelRecommendation | null {
  const recs = getRecommendations(hw);
  return recs.find((r) => r.suitability === "recommended") ?? recs[0] ?? null;
}
