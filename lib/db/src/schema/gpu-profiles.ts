import { pgTable, serial, text, integer, real, jsonb } from "drizzle-orm/pg-core";
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
});

export const insertGpuProfileSchema = createInsertSchema(gpuProfilesTable).omit({ id: true });
export type InsertGpuProfile = z.infer<typeof insertGpuProfileSchema>;
export type GpuProfile = typeof gpuProfilesTable.$inferSelect;
