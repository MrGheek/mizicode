import { db, gpuProfilesTable, type InsertGpuProfile } from "@workspace/db";
import { eq } from "drizzle-orm";

// defaultQuant is used as the model cache subdirectory name under /workspace/models/
// llamaCtxSize  → vLLM --max-model-len
// llamaBatchSize → vLLM --max-num-seqs
// llamaExtraArgs → appended to the vllm serve command

const DEFAULT_PROFILES: InsertGpuProfile[] = [
  {
    name: "starter",
    displayName: "Starter",
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
    searchParams: {
      gpu_name: "RTX 4090",
      num_gpus: 1,
      min_gpu_ram: 24,
    },
    startupTimeMin: 25,
    startupTimeVolume: 3,
  },
  {
    name: "standard",
    displayName: "Standard",
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
    searchParams: {
      gpu_name: "RTX 4090",
      num_gpus: 4,
      min_gpu_ram: 24,
    },
    startupTimeMin: 25,
    startupTimeVolume: 3,
  },
  {
    name: "pro",
    displayName: "Pro",
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
    searchParams: {
      gpu_name: "A100_SXM4",
      num_gpus: 4,
      min_gpu_ram: 80,
    },
    startupTimeMin: 30,
    startupTimeVolume: 5,
  },
  {
    name: "ultra",
    displayName: "Ultra",
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
    searchParams: {
      gpu_name: "H100_SXM5",
      num_gpus: 8,
      min_gpu_ram: 80,
    },
    startupTimeMin: 35,
    startupTimeVolume: 5,
  },
];

export async function seedProfiles() {
  const existing = await db.select().from(gpuProfilesTable);

  // Upsert: insert new profiles, update fields that changed (e.g. switching llama → vLLM config)
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
          startupTimeVolume: profile.startupTimeVolume,
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
