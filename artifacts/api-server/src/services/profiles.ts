import { db, gpuProfilesTable, type InsertGpuProfile } from "@workspace/db";
import { eq, notInArray } from "drizzle-orm";

// defaultQuant is used as the model cache subdirectory name under /workspace/models/
// modelRepo        → HuggingFace repo to download (passed as MODEL_REPO env var)
// servedModelName  → vLLM --served-model-name and litellm model alias
// modelDisplayName → human-readable label shown in the dashboard
// llamaCtxSize  → vLLM --max-model-len
// llamaBatchSize → vLLM --max-num-seqs
// llamaExtraArgs → appended to the vllm serve command

const DEFAULT_PROFILES: InsertGpuProfile[] = [
  // ── Kimi K2.6 profiles (default / recommended) ───────────────────────────
  // modelRepo → unsloth/Kimi-K2.6-GGUF (passed as MODEL_REPO to huggingface-cli download)
  {
    name: "kimi-k2-6-starter",
    displayName: "Starter · K2.6",
    gpuName: "RTX 4090",
    numGpus: 1,
    totalVram: 24,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "kimi-k2.6",
    quantSizeGb: 245,
    diskSizeGb: 400,
    estimatedSpeedMin: 5,
    estimatedSpeedMax: 10,
    estimatedCostMin: 0.13,
    estimatedCostMax: 0.20,
    llamaCtxSize: 8192,
    llamaBatchSize: 256,
    llamaExtraArgs: "",
    searchParams: { gpu_name: "RTX 4090", num_gpus: 1, min_gpu_ram: 24 },
    startupTimeMin: 25,
    modelRepo: "unsloth/Kimi-K2.6-GGUF",
    servedModelName: "kimi-k2-6",
    modelDisplayName: "Kimi K2.6",
  },
  {
    name: "kimi-k2-6-standard",
    displayName: "Standard · K2.6",
    gpuName: "RTX 4090",
    numGpus: 4,
    totalVram: 96,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "kimi-k2.6",
    quantSizeGb: 245,
    diskSizeGb: 800,
    estimatedSpeedMin: 20,
    estimatedSpeedMax: 35,
    estimatedCostMin: 0.50,
    estimatedCostMax: 0.80,
    llamaCtxSize: 32768,
    llamaBatchSize: 512,
    llamaExtraArgs: "--enable-expert-parallel",
    searchParams: { gpu_name: "RTX 4090", num_gpus: 4, min_gpu_ram: 24 },
    startupTimeMin: 25,
    modelRepo: "unsloth/Kimi-K2.6-GGUF",
    servedModelName: "kimi-k2-6",
    modelDisplayName: "Kimi K2.6",
  },
  {
    name: "kimi-k2-6-pro",
    displayName: "Pro · K2.6",
    gpuName: "A100 80GB",
    numGpus: 4,
    totalVram: 320,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "kimi-k2.6",
    quantSizeGb: 490,
    diskSizeGb: 1000,
    estimatedSpeedMin: 40,
    estimatedSpeedMax: 65,
    estimatedCostMin: 2.0,
    estimatedCostMax: 4.0,
    llamaCtxSize: 65536,
    llamaBatchSize: 1024,
    llamaExtraArgs: "--enable-expert-parallel --kv-cache-dtype fp8",
    searchParams: { gpu_name: "A100_SXM4", num_gpus: 4, min_gpu_ram: 80 },
    startupTimeMin: 30,
    modelRepo: "unsloth/Kimi-K2.6-GGUF",
    servedModelName: "kimi-k2-6",
    modelDisplayName: "Kimi K2.6",
  },
  {
    name: "kimi-k2-6-ultra",
    displayName: "Ultra · K2.6",
    gpuName: "H100 80GB",
    numGpus: 8,
    totalVram: 640,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "kimi-k2.6",
    quantSizeGb: 547,
    diskSizeGb: 1200,
    estimatedSpeedMin: 80,
    estimatedSpeedMax: 130,
    estimatedCostMin: 8.0,
    estimatedCostMax: 16.0,
    llamaCtxSize: 131072,
    llamaBatchSize: 2048,
    llamaExtraArgs: "--enable-expert-parallel --kv-cache-dtype fp8",
    searchParams: { gpu_name: "H100_SXM5", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 35,
    modelRepo: "unsloth/Kimi-K2.6-GGUF",
    servedModelName: "kimi-k2-6",
    modelDisplayName: "Kimi K2.6",
  },

  // ── Kimi K2.5 profiles (legacy — kept for existing sessions) ──────────────
  // modelRepo fixed to GGUF repo (was incorrectly set to base model)
  {
    name: "starter",
    displayName: "Starter · K2.5",
    gpuName: "RTX 4090",
    numGpus: 1,
    totalVram: 24,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "kimi-k2.5",
    quantSizeGb: 245,
    diskSizeGb: 400,
    estimatedSpeedMin: 5,
    estimatedSpeedMax: 10,
    estimatedCostMin: 0.13,
    estimatedCostMax: 0.20,
    llamaCtxSize: 8192,
    llamaBatchSize: 256,
    llamaExtraArgs: "",
    searchParams: { gpu_name: "RTX 4090", num_gpus: 1, min_gpu_ram: 24 },
    startupTimeMin: 25,
    modelRepo: "unsloth/Kimi-K2.5-GGUF",
    servedModelName: "kimi-k2",
    modelDisplayName: "Kimi K2.5",
  },
  {
    name: "standard",
    displayName: "Standard · K2.5",
    gpuName: "RTX 4090",
    numGpus: 4,
    totalVram: 96,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "kimi-k2.5",
    quantSizeGb: 245,
    diskSizeGb: 800,
    estimatedSpeedMin: 20,
    estimatedSpeedMax: 35,
    estimatedCostMin: 0.50,
    estimatedCostMax: 0.80,
    llamaCtxSize: 32768,
    llamaBatchSize: 512,
    llamaExtraArgs: "--enable-expert-parallel",
    searchParams: { gpu_name: "RTX 4090", num_gpus: 4, min_gpu_ram: 24 },
    startupTimeMin: 25,
    modelRepo: "unsloth/Kimi-K2.5-GGUF",
    servedModelName: "kimi-k2",
    modelDisplayName: "Kimi K2.5",
  },
  {
    name: "pro",
    displayName: "Pro · K2.5",
    gpuName: "A100 80GB",
    numGpus: 4,
    totalVram: 320,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "kimi-k2.5",
    quantSizeGb: 490,
    diskSizeGb: 1000,
    estimatedSpeedMin: 40,
    estimatedSpeedMax: 65,
    estimatedCostMin: 2.0,
    estimatedCostMax: 4.0,
    llamaCtxSize: 65536,
    llamaBatchSize: 1024,
    llamaExtraArgs: "--enable-expert-parallel --kv-cache-dtype fp8",
    searchParams: { gpu_name: "A100_SXM4", num_gpus: 4, min_gpu_ram: 80 },
    startupTimeMin: 30,
    modelRepo: "unsloth/Kimi-K2.5-GGUF",
    servedModelName: "kimi-k2",
    modelDisplayName: "Kimi K2.5",
  },
  {
    name: "ultra",
    displayName: "Ultra · K2.5",
    gpuName: "H100 80GB",
    numGpus: 8,
    totalVram: 640,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "kimi-k2.5",
    quantSizeGb: 547,
    diskSizeGb: 1200,
    estimatedSpeedMin: 80,
    estimatedSpeedMax: 130,
    estimatedCostMin: 8.0,
    estimatedCostMax: 16.0,
    llamaCtxSize: 131072,
    llamaBatchSize: 2048,
    llamaExtraArgs: "--enable-expert-parallel --kv-cache-dtype fp8",
    searchParams: { gpu_name: "H100_SXM5", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 35,
    modelRepo: "unsloth/Kimi-K2.5-GGUF",
    servedModelName: "kimi-k2",
    modelDisplayName: "Kimi K2.5",
  },

  // ── Qwen3-Coder-Next (80B total / 3B active) ──────────────────────────────
  // Standard: 4× A100 80GB — affordable, fast
  {
    name: "qwen3-coder-standard",
    displayName: "Qwen3 Standard",
    gpuName: "A100 80GB",
    numGpus: 4,
    totalVram: 320,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "qwen3-coder-next",
    quantSizeGb: 85,
    diskSizeGb: 250,
    estimatedSpeedMin: 55,
    estimatedSpeedMax: 90,
    estimatedCostMin: 2.0,
    estimatedCostMax: 4.0,
    llamaCtxSize: 65536,
    llamaBatchSize: 1024,
    llamaExtraArgs: "--enable-expert-parallel",
    searchParams: { gpu_name: "A100_SXM4", num_gpus: 4, min_gpu_ram: 80 },
    startupTimeMin: 15,
    modelRepo: "Qwen/Qwen3-Coder-Next",
    servedModelName: "qwen3-coder-next",
    modelDisplayName: "Qwen3-Coder-Next",
  },
  // Pro: 8× A100 80GB — higher throughput, longer context
  {
    name: "qwen3-coder-pro",
    displayName: "Qwen3 Pro",
    gpuName: "A100 80GB",
    numGpus: 8,
    totalVram: 640,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "qwen3-coder-next",
    quantSizeGb: 85,
    diskSizeGb: 250,
    estimatedSpeedMin: 120,
    estimatedSpeedMax: 200,
    estimatedCostMin: 4.0,
    estimatedCostMax: 8.0,
    llamaCtxSize: 131072,
    llamaBatchSize: 2048,
    llamaExtraArgs: "--enable-expert-parallel",
    searchParams: { gpu_name: "A100_SXM4", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 15,
    modelRepo: "Qwen/Qwen3-Coder-Next",
    servedModelName: "qwen3-coder-next",
    modelDisplayName: "Qwen3-Coder-Next",
  },

  // ── MiniMax M2.5 (229B total / 10B active — fits Ultra H100 tier) ─────────
  {
    name: "minimax-m2-ultra",
    displayName: "MiniMax Ultra",
    gpuName: "H100 80GB",
    numGpus: 8,
    totalVram: 640,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "minimax-m2.5",
    quantSizeGb: 235,
    diskSizeGb: 600,
    estimatedSpeedMin: 60,
    estimatedSpeedMax: 100,
    estimatedCostMin: 8.0,
    estimatedCostMax: 16.0,
    llamaCtxSize: 131072,
    llamaBatchSize: 1024,
    llamaExtraArgs: "--enable-expert-parallel",
    searchParams: { gpu_name: "H100_SXM5", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 25,
    modelRepo: "MiniMaxAI/MiniMax-M2.5",
    servedModelName: "minimax-m2.5",
    modelDisplayName: "MiniMax M2.5",
  },

  // ── GLM-5.1 FP8 (754B total / 40B active) ────────────────────────────────
  // Ultra: 8× H100 SXM5 — tight VRAM, reduced context window
  {
    name: "glm-5-1-ultra",
    displayName: "GLM-5.1 Ultra",
    gpuName: "H100 80GB",
    numGpus: 8,
    totalVram: 640,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "glm-5.1-fp8",
    quantSizeGb: 760,
    diskSizeGb: 1500,
    estimatedSpeedMin: 25,
    estimatedSpeedMax: 45,
    estimatedCostMin: 8.0,
    estimatedCostMax: 16.0,
    llamaCtxSize: 32768,
    llamaBatchSize: 512,
    llamaExtraArgs: "--kv-cache-dtype fp8 --enable-expert-parallel --tool-call-parser glm47 --reasoning-parser glm45 --enable-auto-tool-choice --speculative-config.method mtp --speculative-config.num_speculative_tokens 3 --gpu-memory-utilization 0.98",
    searchParams: { gpu_name: "H100_SXM5", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 45,
    modelRepo: "zai-org/GLM-5.1-FP8",
    servedModelName: "glm-5.1",
    modelDisplayName: "GLM-5.1 (FP8)",
  },
  // H200: 8× H200 — full context, recommended
  {
    name: "glm-5-1-h200",
    displayName: "GLM-5.1 H200",
    gpuName: "H200 141GB",
    numGpus: 8,
    totalVram: 1128,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "glm-5.1-fp8",
    quantSizeGb: 760,
    diskSizeGb: 1500,
    estimatedSpeedMin: 40,
    estimatedSpeedMax: 70,
    estimatedCostMin: 15.0,
    estimatedCostMax: 25.0,
    llamaCtxSize: 131072,
    llamaBatchSize: 1024,
    llamaExtraArgs: "--kv-cache-dtype fp8 --enable-expert-parallel --tool-call-parser glm47 --reasoning-parser glm45 --enable-auto-tool-choice --speculative-config.method mtp --speculative-config.num_speculative_tokens 3",
    searchParams: { gpu_name: "H200", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 45,
    modelRepo: "zai-org/GLM-5.1-FP8",
    servedModelName: "glm-5.1",
    modelDisplayName: "GLM-5.1 (FP8)",
  },

  // ── DeepSeek V3.2 (671B total / MIT) ─────────────────────────────────────
  {
    name: "deepseek-v3-2-h200",
    displayName: "DeepSeek V3.2",
    gpuName: "H200 141GB",
    numGpus: 8,
    totalVram: 1128,
    dockerImageTag: "gheeklabs/coding-env:latest",
    defaultQuant: "deepseek-v3.2",
    quantSizeGb: 680,
    diskSizeGb: 1400,
    estimatedSpeedMin: 45,
    estimatedSpeedMax: 75,
    estimatedCostMin: 15.0,
    estimatedCostMax: 25.0,
    llamaCtxSize: 131072,
    llamaBatchSize: 1024,
    llamaExtraArgs: "--enable-expert-parallel",
    searchParams: { gpu_name: "H200", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 40,
    modelRepo: "deepseek-ai/DeepSeek-V3.2",
    servedModelName: "deepseek-v3.2",
    modelDisplayName: "DeepSeek V3.2",
  },
];

export async function seedProfiles() {
  const existing = await db.select().from(gpuProfilesTable);
  const canonicalNames = DEFAULT_PROFILES.map(p => p.name);

  // Remove any profiles that are no longer in DEFAULT_PROFILES (e.g. renamed entries)
  const staleNames = existing
    .map(p => p.name)
    .filter(n => !canonicalNames.includes(n));
  if (staleNames.length > 0) {
    await db
      .delete(gpuProfilesTable)
      .where(notInArray(gpuProfilesTable.name, canonicalNames));
  }

  // Upsert: insert new profiles, update fields that changed
  const inserted = [];
  for (const profile of DEFAULT_PROFILES) {
    const existingProfile = existing.find(p => p.name === profile.name);
    if (existingProfile) {
      const [updated] = await db
        .update(gpuProfilesTable)
        .set({
          displayName: profile.displayName,
          gpuName: profile.gpuName,
          numGpus: profile.numGpus,
          totalVram: profile.totalVram,
          dockerImageTag: profile.dockerImageTag,
          defaultQuant: profile.defaultQuant,
          quantSizeGb: profile.quantSizeGb,
          diskSizeGb: profile.diskSizeGb,
          estimatedSpeedMin: profile.estimatedSpeedMin,
          estimatedSpeedMax: profile.estimatedSpeedMax,
          estimatedCostMin: profile.estimatedCostMin,
          estimatedCostMax: profile.estimatedCostMax,
          llamaCtxSize: profile.llamaCtxSize,
          llamaBatchSize: profile.llamaBatchSize,
          llamaExtraArgs: profile.llamaExtraArgs,
          searchParams: profile.searchParams,
          startupTimeMin: profile.startupTimeMin,
          modelRepo: profile.modelRepo,
          servedModelName: profile.servedModelName,
          modelDisplayName: profile.modelDisplayName,
        })
        .where(eq(gpuProfilesTable.name, profile.name))
        .returning();
      inserted.push(updated);
    } else {
      const [row] = await db.insert(gpuProfilesTable).values(profile).returning();
      inserted.push(row);
    }
  }
  return inserted;
}

export async function getAllProfiles() {
  return db.select().from(gpuProfilesTable);
}

export async function getProfileById(id: number) {
  const [profile] = await db.select().from(gpuProfilesTable).where(eq(gpuProfilesTable.id, id));
  return profile || null;
}
