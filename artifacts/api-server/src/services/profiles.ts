import { db, gpuProfilesTable, type InsertGpuProfile } from "@workspace/db";
import { eq, notInArray } from "drizzle-orm";

// defaultQuant is used as the model cache subdirectory name under /workspace/models/
// modelRepo        → HuggingFace repo to download (passed as MODEL_REPO env var)
// servedModelName  → vLLM --served-model-name and litellm model alias
// modelDisplayName → human-readable label shown in the dashboard
// llamaCtxSize  → vLLM --max-model-len
// llamaBatchSize → vLLM --max-num-seqs
// llamaExtraArgs → appended to the vllm serve command
// swarmWorkerCap → max concurrent swarm workers; passed as SWARM_MAX_WORKERS to the
//                  container so the Claw Runner can enforce it without model-awareness.
//                  Profiles with swarmWorkerCap ≤ 8 are severely constrained for swarm
//                  workloads — users should prefer a higher tier.
//
// vLLM version-gating note: the Dockerfile pins "vllm==0.19.0" (exact) to satisfy all
// active model profiles:
//   - GLM-5.1 FP8: requires >=0.19.0 for --tool-call-parser glm47,
//     --reasoning-parser glm45, and --speculative-config.method mtp
//   - Qwen3-Coder-Next: requires >=0.8.4 for Qwen3 architecture support
//   - MiniMax M2.5: requires >=0.8.4 for updated MoE kernel support
// onstart.sh performs capability-based flag gating at runtime: it probes the
// installed vLLM's --help output and strips any unrecognised flags rather than
// aborting, so the image remains forward-compatible with future vLLM builds.

// Shared chunked-prefill flags for Pro/Ultra MoE profiles (vLLM ≥ 0.19.0 confirmed).
// These values are conservative starting points pending empirical validation.
const CHUNKED_PREFILL_PRO =
  "--enable-chunked-prefill --max-num-batched-tokens 8192 " +
  "--max-num-partial-prefills 2 --max-long-partial-prefills 0 " +
  "--long-prefill-token-threshold 2048 --scheduling-policy priority";

const DEFAULT_PROFILES: InsertGpuProfile[] = [
  // ── NIM Workspace profile — used for all hosted-inference (NIM) sessions ──
  // No local GPU needed: the workspace container just runs code-server + LiteLLM
  // pointed at the NIM/partner API. We rent the cheapest available CPU instance.
  {
    name: "nim-workspace",
    displayName: "NIM Workspace",
    gpuName: "CPU",
    numGpus: 0,
    totalVram: 0,
    dockerImageTag: "registry.fly.io/mizi-api:deployment-01KS781EKK8FR2JV9FNB4HH6Q4",
    defaultQuant: "nim-hosted",
    quantSizeGb: 0,
    diskSizeGb: 50,
    estimatedSpeedMin: 0,
    estimatedSpeedMax: 0,
    estimatedCostMin: 0.05,
    estimatedCostMax: 0.15,
    llamaCtxSize: 131072,
    llamaBatchSize: 1,
    llamaExtraArgs: "",
    searchParams: { type: "on-demand", num_gpus: 0, min_gpu_ram: 0 },
    startupTimeMin: 2,
    modelRepo: "nim-hosted",
    servedModelName: "nim-hosted",
    modelDisplayName: "NIM Hosted",
    benchmarkCallout: null,
    swarmWorkerCap: 200,
    isNimWorkspace: true,
    nimDefaultProvider: "nvidia",
  },

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
    benchmarkCallout: "65.8% SWE-Bench Verified",
    // Single 4090 — minimal VRAM headroom; swarm is marginal on this tier.
    // Users should prefer Standard or higher for swarm-intensive tasks.
    swarmWorkerCap: 16,
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
    // Raised from 512 → 768 to provide headroom for concurrent swarm workers
    // while preserving KV cache budget for the orchestrator. Empirical validation pending.
    llamaBatchSize: 768,
    llamaExtraArgs: "--enable-expert-parallel",
    searchParams: { gpu_name: "RTX 4090", num_gpus: 4, min_gpu_ram: 24 },
    startupTimeMin: 25,
    modelRepo: "unsloth/Kimi-K2.6-GGUF",
    servedModelName: "kimi-k2-6",
    modelDisplayName: "Kimi K2.6",
    benchmarkCallout: "65.8% SWE-Bench Verified",
    // 4× 4090 — comfortable ceiling for moderate swarm concurrency.
    swarmWorkerCap: 48,
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
    // Chunked prefill and priority scheduling added for swarm workloads (vLLM ≥ 0.6.0).
    // Empirical validation of --max-num-batched-tokens pending.
    llamaExtraArgs: `--enable-expert-parallel --kv-cache-dtype fp8 ${CHUNKED_PREFILL_PRO}`,
    searchParams: { gpu_name: "A100_SXM4", num_gpus: 4, min_gpu_ram: 80 },
    startupTimeMin: 30,
    modelRepo: "unsloth/Kimi-K2.6-GGUF",
    servedModelName: "kimi-k2-6",
    modelDisplayName: "Kimi K2.6",
    benchmarkCallout: "65.8% SWE-Bench Verified",
    // 4× A100 80GB — strong headroom; supports high swarm concurrency.
    swarmWorkerCap: 100,
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
    // GPU memory raised to 0.95 (from onstart.sh default 0.92) — 8× H100 has sufficient
    // VRAM headroom. Empirical validation of peak-load stability required before raising
    // further. Chunked prefill + priority scheduling for swarm (vLLM ≥ 0.6.0).
    llamaExtraArgs: `--enable-expert-parallel --kv-cache-dtype fp8 ${CHUNKED_PREFILL_PRO} --gpu-memory-utilization 0.95`,
    searchParams: { gpu_name: "H100_SXM5", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 35,
    modelRepo: "unsloth/Kimi-K2.6-GGUF",
    servedModelName: "kimi-k2-6",
    modelDisplayName: "Kimi K2.6",
    benchmarkCallout: "65.8% SWE-Bench Verified",
    // 8× H100 — near-full swarm capability.
    swarmWorkerCap: 200,
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
    benchmarkCallout: "63.6% SWE-Bench Verified · legacy",
    // Same architecture as K2.6 Starter — same constraints apply.
    // Swarm is marginal on this tier; prefer a higher tier for swarm-intensive tasks.
    swarmWorkerCap: 16,
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
    // Raised from 512 → 768 — same rationale as K2.6 Standard. Empirical validation pending.
    llamaBatchSize: 768,
    llamaExtraArgs: "--enable-expert-parallel",
    searchParams: { gpu_name: "RTX 4090", num_gpus: 4, min_gpu_ram: 24 },
    startupTimeMin: 25,
    modelRepo: "unsloth/Kimi-K2.5-GGUF",
    servedModelName: "kimi-k2",
    modelDisplayName: "Kimi K2.5",
    benchmarkCallout: "63.6% SWE-Bench Verified · legacy",
    // Same architecture as K2.6 Standard.
    swarmWorkerCap: 48,
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
    // Chunked prefill and priority scheduling added for swarm workloads (vLLM ≥ 0.6.0).
    llamaExtraArgs: `--enable-expert-parallel --kv-cache-dtype fp8 ${CHUNKED_PREFILL_PRO}`,
    searchParams: { gpu_name: "A100_SXM4", num_gpus: 4, min_gpu_ram: 80 },
    startupTimeMin: 30,
    modelRepo: "unsloth/Kimi-K2.5-GGUF",
    servedModelName: "kimi-k2",
    modelDisplayName: "Kimi K2.5",
    benchmarkCallout: "63.6% SWE-Bench Verified · legacy",
    // Same architecture as K2.6 Pro.
    swarmWorkerCap: 100,
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
    // Chunked prefill and priority scheduling added for swarm workloads (vLLM ≥ 0.6.0).
    // NOTE: GPU memory utilisation is NOT raised here (unlike K2.6 Ultra) pending
    // dedicated empirical validation of the K2.5 weight layout on H100.
    llamaExtraArgs: `--enable-expert-parallel --kv-cache-dtype fp8 ${CHUNKED_PREFILL_PRO}`,
    searchParams: { gpu_name: "H100_SXM5", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 35,
    modelRepo: "unsloth/Kimi-K2.5-GGUF",
    servedModelName: "kimi-k2",
    modelDisplayName: "Kimi K2.5",
    benchmarkCallout: "63.6% SWE-Bench Verified · legacy",
    // Same architecture as K2.6 Ultra.
    swarmWorkerCap: 200,
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
    benchmarkCallout: "Highest open-weight SWE-Bench score per dollar",
    // 3B active params — very cheap per worker; 4× A100 supports high concurrency.
    swarmWorkerCap: 120,
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
    // GPU memory raised to 0.95 — 8× A100 with 3B active params has substantial headroom.
    // Empirical validation of stability under peak swarm load required.
    // Chunked prefill + priority scheduling for swarm (vLLM ≥ 0.6.0).
    llamaExtraArgs: `--enable-expert-parallel ${CHUNKED_PREFILL_PRO} --gpu-memory-utilization 0.95`,
    searchParams: { gpu_name: "A100_SXM4", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 15,
    modelRepo: "Qwen/Qwen3-Coder-Next",
    servedModelName: "qwen3-coder-next",
    modelDisplayName: "Qwen3-Coder-Next",
    benchmarkCallout: "Highest open-weight SWE-Bench score per dollar",
    // 3B active params on 8× A100 — tiny active footprint allows extreme concurrency.
    swarmWorkerCap: 250,
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
    // Chunked prefill + priority scheduling for swarm (vLLM ≥ 0.6.0).
    // 10B active params on 8× H100 — compact active layer gives reasonable headroom.
    llamaExtraArgs: `--enable-expert-parallel ${CHUNKED_PREFILL_PRO}`,
    searchParams: { gpu_name: "H100_SXM5", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 25,
    modelRepo: "MiniMaxAI/MiniMax-M2.5",
    servedModelName: "minimax-m2.5",
    modelDisplayName: "MiniMax M2.5",
    benchmarkCallout: "80.2% SWE-Bench Verified",
    // 10B active on 8× H100 — compact active layer gives modest swarm headroom.
    swarmWorkerCap: 80,
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
    // DO NOT modify: already at --gpu-memory-utilization 0.98 — VRAM is fully committed.
    // Raising GPU memory or adding chunked-prefill risks OOM. Swarm is extremely constrained.
    // Users should use glm-5-1-h200 for any swarm workload.
    llamaExtraArgs: "--kv-cache-dtype fp8 --enable-expert-parallel --tool-call-parser glm47 --reasoning-parser glm45 --enable-auto-tool-choice --speculative-config.method mtp --speculative-config.num_speculative_tokens 3 --gpu-memory-utilization 0.98",
    searchParams: { gpu_name: "H100_SXM5", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 45,
    modelRepo: "zai-org/GLM-5.1-FP8",
    servedModelName: "glm-5.1",
    modelDisplayName: "GLM-5.1 (FP8)",
    benchmarkCallout: "58.4% SWE-Bench Pro · open-weight record",
    // CONSTRAINED: already at 0.98 GPU memory utilisation — extremely limited swarm headroom.
    // Swarm is marginal on this tier. Users should strongly prefer glm-5-1-h200 for swarm tasks.
    swarmWorkerCap: 4,
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
    // CHUNKED-PREFILL BLOCKED (vLLM 0.6.x): --enable-chunked-prefill is
    // incompatible with --speculative-config.method mtp on vLLM 0.6.x. vLLM
    // raises a ValueError at engine initialisation when both flags are present,
    // causing the server to fail to boot. This was confirmed via vLLM 0.6.x
    // release notes and issue tracker (vllm-project/vllm #6226 / #7181):
    // speculative decoding (all methods, including MTP) explicitly disables
    // chunked prefill on 0.6.x builds.
    //
    // Compatibility was introduced in vLLM 0.7.0. The Dockerfile uses a
    // lower-bound constraint ("vllm>=0.6.0"), so if the resolved install is
    // already ≥ 0.7.0 this flag can be added immediately. To enable, append
    // CHUNKED_PREFILL_PRO to llamaExtraArgs below and update this comment.
    //
    // H200 provides additional VRAM headroom vs H100 Ultra; swarm is viable but
    // limited by the 40B active parameter footprint.
    llamaExtraArgs: "--kv-cache-dtype fp8 --enable-expert-parallel --tool-call-parser glm47 --reasoning-parser glm45 --enable-auto-tool-choice --speculative-config.method mtp --speculative-config.num_speculative_tokens 3",
    searchParams: { gpu_name: "H200", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 45,
    modelRepo: "zai-org/GLM-5.1-FP8",
    servedModelName: "glm-5.1",
    modelDisplayName: "GLM-5.1 (FP8)",
    benchmarkCallout: "58.4% SWE-Bench Pro · open-weight record",
    // CONSTRAINED: H200 VRAM gives modest headroom over H100 Ultra tier.
    // Swarm is possible but limited; prefer higher-throughput profiles for
    // swarm-intensive tasks.
    swarmWorkerCap: 16,
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
    // Chunked prefill + priority scheduling for swarm (vLLM ≥ 0.6.0).
    // MoE 671B total — large weight footprint limits per-worker headroom despite H200.
    llamaExtraArgs: `--enable-expert-parallel ${CHUNKED_PREFILL_PRO}`,
    searchParams: { gpu_name: "H200", num_gpus: 8, min_gpu_ram: 80 },
    startupTimeMin: 40,
    modelRepo: "deepseek-ai/DeepSeek-V3.2",
    servedModelName: "deepseek-v3.2",
    modelDisplayName: "DeepSeek V3.2",
    benchmarkCallout: "671B MIT-licensed · strong multilingual coding",
    // MoE 671B — large weight footprint constrains per-worker headroom despite H200.
    swarmWorkerCap: 32,
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
          swarmWorkerCap: profile.swarmWorkerCap,
          benchmarkCallout: profile.benchmarkCallout,
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

export async function getProfileByName(name: string) {
  const [profile] = await db.select().from(gpuProfilesTable).where(eq(gpuProfilesTable.name, name));
  return profile || null;
}

export async function getNimWorkspaceProfile() {
  return getProfileByName("nim-workspace");
}
