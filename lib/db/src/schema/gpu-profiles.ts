import { pgTable, serial, text, integer, real, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const gpuProfilesTable = pgTable("gpu_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  gpuName: text("gpu_name").notNull(),
  numGpus: integer("num_gpus").notNull(),
  totalVram: integer("total_vram").notNull(),
  dockerImageTag: text("docker_image_tag").notNull(),
  defaultQuant: text("default_quant").notNull(),
  quantSizeGb: integer("quant_size_gb").notNull(),
  diskSizeGb: integer("disk_size_gb").notNull(),
  estimatedSpeedMin: real("estimated_speed_min").notNull(),
  estimatedSpeedMax: real("estimated_speed_max").notNull(),
  estimatedCostMin: real("estimated_cost_min").notNull(),
  estimatedCostMax: real("estimated_cost_max").notNull(),
  llamaCtxSize: integer("llama_ctx_size").notNull().default(32768),
  llamaBatchSize: integer("llama_batch_size").notNull().default(512),
  llamaExtraArgs: text("llama_extra_args").default(""),
  searchParams: jsonb("search_params").notNull(),
  startupTimeMin: integer("startup_time_min").notNull().default(20),
  modelRepo: text("model_repo").notNull().default("moonshotai/Kimi-K2.5"),
  servedModelName: text("served_model_name").notNull().default("kimi-k2"),
  modelDisplayName: text("model_display_name").notNull().default("Kimi K2.5"),
  // Maximum concurrent swarm workers this profile can support without starving
  // the orchestrator's KV cache. Passed to the container as SWARM_MAX_WORKERS
  // so the Claw Runner can enforce it without needing model-awareness.
  // Null means swarm is not supported / not configured for this profile.
  swarmWorkerCap: integer("swarm_worker_cap"),
  // Short benchmark callout shown in the Quick Launch section header
  // (e.g. "65.8% SWE-Bench Verified"). Stored here so the numbers can be
  // updated in one place (profiles.ts seed data) without touching the dashboard.
  benchmarkCallout: text("benchmark_callout"),
  // NIM metadata: marks this as a NIM workspace profile (no GPU rental) and
  // records which hosted-inference provider it targets by default.
  // isNimWorkspace=true profiles are selected when launching a NIM session.
  isNimWorkspace: boolean("is_nim_workspace").notNull().default(false),
  // Default provider key (nvidia | vultr | together | deepinfra). Null for
  // standard Vast.ai GPU profiles that never use the NIM path.
  nimDefaultProvider: text("nim_default_provider"),
  // The NIM catalog model ID this profile launches (e.g. "moonshotai/kimi-k2-instruct").
  // Populated for NIM workspace profiles; null for GPU profiles.
  nimModelId: text("nim_model_id"),
  // Cached NIM type tags from the catalog (nim_type_preview | nim_type_upgrade_available).
  // Stored here so the launch path can validate tier access without re-querying the catalog.
  nimTypes: jsonb("nim_types").$type<string[]>(),
  // Cached partner provider keys that can serve this model (vultr | together | deepinfra).
  // Stored here for profile-level routing decisions and dashboard display.
  nimPartnerProviders: jsonb("nim_partner_providers").$type<string[]>(),
});

export const insertGpuProfileSchema = createInsertSchema(gpuProfilesTable).omit({ id: true });
export type InsertGpuProfile = z.infer<typeof insertGpuProfileSchema>;
export type GpuProfile = typeof gpuProfilesTable.$inferSelect;
