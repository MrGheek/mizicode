import { db, gpuProfilesTable, type InsertGpuProfile } from "@workspace/db";
import { eq } from "drizzle-orm";

const DEFAULT_PROFILES: InsertGpuProfile[] = [
  {
    name: "starter",
    displayName: "Starter",
    gpuName: "RTX 4090",
    numGpus: 1,
    totalVram: 24,
    dockerImageTag: "omniqlabs/coding-env:cuda12.4",
    defaultQuant: "UD-TQ1_0",
    quantSizeGb: 245,
    diskSizeGb: 400,
    estimatedSpeedMin: 5,
    estimatedSpeedMax: 10,
    estimatedCostMin: 0.13,
    estimatedCostMax: 0.20,
    llamaCtxSize: 8192,
    llamaBatchSize: 512,
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
    dockerImageTag: "omniqlabs/coding-env:cuda12.4",
    defaultQuant: "UD-TQ1_0",
    quantSizeGb: 245,
    diskSizeGb: 800,
    estimatedSpeedMin: 20,
    estimatedSpeedMax: 35,
    estimatedCostMin: 0.50,
    estimatedCostMax: 0.80,
    llamaCtxSize: 32768,
    llamaBatchSize: 1024,
    llamaExtraArgs: "",
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
    dockerImageTag: "omniqlabs/coding-env:a100",
    defaultQuant: "Q3_K_M",
    quantSizeGb: 490,
    diskSizeGb: 1000,
    estimatedSpeedMin: 40,
    estimatedSpeedMax: 65,
    estimatedCostMin: 2.0,
    estimatedCostMax: 4.0,
    llamaCtxSize: 65536,
    llamaBatchSize: 2048,
    llamaExtraArgs: "--flash-attn",
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
    dockerImageTag: "omniqlabs/coding-env:h100",
    defaultQuant: "IQ4_XS",
    quantSizeGb: 547,
    diskSizeGb: 1200,
    estimatedSpeedMin: 80,
    estimatedSpeedMax: 130,
    estimatedCostMin: 8.0,
    estimatedCostMax: 16.0,
    llamaCtxSize: 131072,
    llamaBatchSize: 4096,
    llamaExtraArgs: "--flash-attn",
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
  if (existing.length > 0) return existing;

  const inserted = [];
  for (const profile of DEFAULT_PROFILES) {
    const [row] = await db.insert(gpuProfilesTable).values(profile).returning();
    inserted.push(row);
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
