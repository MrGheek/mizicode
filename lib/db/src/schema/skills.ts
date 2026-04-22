import { pgTable, serial, text, integer, boolean, timestamp, jsonb, uniqueIndex, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const skillSourcesTable = pgTable("skill_sources", {
  id: serial("id").primaryKey(),
  repoUrl: text("repo_url").notNull(),
  sourceType: text("source_type").notNull().default("github"),
  defaultBranch: text("default_branch").notNull().default("main"),
  pinnedCommitSha: text("pinned_commit_sha"),
  license: text("license"),
  trustLevel: text("trust_level").notNull().default("user_approved"),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});

export const skillsTable = pgTable("skills", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  class: text("class").notNull(),
  description: text("description").notNull().default(""),
  sourceId: integer("source_id").references(() => skillSourcesTable.id),
  trustTier: text("trust_tier").notNull().default("user_approved"),
  installRisk: text("install_risk").notNull().default("virtual"),
  tokenOverheadEstimate: integer("token_overhead_estimate").notNull().default(0),
  enabled: boolean("enabled").notNull().default(false),
  reviewStatus: text("review_status").notNull().default("pending"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const skillVersionsTable = pgTable("skill_versions", {
  id: serial("id").primaryKey(),
  skillId: integer("skill_id").notNull().references(() => skillsTable.id),
  manifestJson: jsonb("manifest_json").notNull(),
  extractedRulesJson: jsonb("extracted_rules_json"),
  sourceFilesJson: jsonb("source_files_json"),
  versionHash: text("version_hash").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const skillBundlesTable = pgTable("skill_bundles", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  bundleJson: jsonb("bundle_json").notNull(),
  sessionMode: text("session_mode"),
  taskMode: text("task_mode"),
  repoKind: text("repo_kind"),
  modelFamily: text("model_family"),
  tokenMode: text("token_mode").notNull().default("core"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessionSkillsTable = pgTable("session_skills", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  bundleId: integer("bundle_id").references(() => skillBundlesTable.id),
  activatedSkillsJson: jsonb("activated_skills_json").notNull(),
  rationaleJson: jsonb("rationale_json"),
  tokenMode: text("token_mode").notNull().default("core"),
  activationMode: text("activation_mode").notNull().default("boot"),
  activatedAt: timestamp("activated_at").notNull().defaultNow(),
});

export const skillFeedbackTable = pgTable("skill_feedback", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  skillId: integer("skill_id").notNull().references(() => skillsTable.id),
  helpful: boolean("helpful").notNull(),
  notes: text("notes"),
  tokenDelta: integer("token_delta"),
  taskSuccessScore: integer("task_success_score"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  sessionSkillUnique: uniqueIndex("skill_feedback_session_skill_unique")
    .on(table.sessionId, table.skillId),
}));

export const repoGraphJobsTable = pgTable("repo_graph_jobs", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  repoPath: text("repo_path"),
  status: text("status").notNull().default("queued"),
  graphPath: text("graph_path"),
  indexedSymbols: integer("indexed_symbols"),
  edgeCount: integer("edge_count"),
  retrievalStatus: text("retrieval_status"),
  indexVersion: integer("index_version").notNull().default(1),
  embeddingsStatus: text("embeddings_status"),
  errorDetails: text("error_details"),
  contentHashSeed: text("content_hash_seed"),
  durationMs: integer("duration_ms"),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sessionRepoContextTable = pgTable("session_repo_context", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  repoPath: text("repo_path").notNull(),
  repoUrl: text("repo_url"),
  fingerprintJson: jsonb("fingerprint_json"),
  fingerprintHash: text("fingerprint_hash"),
  summaryJson: jsonb("summary_json"),
  symbolsJson: jsonb("symbols_json"),
  filesJson: jsonb("files_json"),
  edgesJson: jsonb("edges_json"),
  chunksJson: jsonb("chunks_json"),
  indexStatus: text("index_status").notNull().default("queued"),
  isStale: boolean("is_stale").notNull().default(false),
  confidenceLevel: text("confidence_level").notNull().default("none"),
  indexedAt: timestamp("indexed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Eval run — top-level record for a scheduled evaluation job.
 * Status progression: queued → preparing → running → scoring → completed | error
 * Priority: eval jobs always use priority ≤ 3 (lower than interactive work at 5–10).
 */
export const evalRunsTable = pgTable("eval_runs", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("queued"),
  runType: text("run_type").notNull().default("bundle"),
  targetSkillId: integer("target_skill_id").references(() => skillsTable.id),
  targetBundleId: integer("target_bundle_id").references(() => skillBundlesTable.id),
  taskMode: text("task_mode").notNull().default("build"),
  sessionType: text("session_type").notNull().default("solo"),
  tokenMode: text("token_mode").notNull().default("core"),
  modelProfile: text("model_profile").notNull().default("kimi"),
  repoKind: text("repo_kind"),
  repoLangsJson: jsonb("repo_langs_json"),
  repoCommitSha: text("repo_commit_sha"),
  skillVersionIdsJson: jsonb("skill_version_ids_json"),
  bundleVersionHash: text("bundle_version_hash"),
  configVersion: text("config_version").notNull().default("1"),
  scoringWeightsJson: jsonb("scoring_weights_json"),
  priority: integer("priority").notNull().default(3),
  costCapUsd: real("cost_cap_usd"),
  estimatedCostUsd: real("estimated_cost_usd"),
  actualCostUsd: real("actual_cost_usd"),
  errorDetails: text("error_details"),
  notes: text("notes"),
  scheduledAt: timestamp("scheduled_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Eval run variant — one treatment or baseline arm within an eval run.
 * A single run may have a baseline + one or more treatment variants.
 */
export const evalRunVariantsTable = pgTable("eval_run_variants", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => evalRunsTable.id),
  variantType: text("variant_type").notNull().default("treatment"),
  skillIdsIncludedJson: jsonb("skill_ids_included_json"),
  skillIdsExcludedJson: jsonb("skill_ids_excluded_json"),
  timeToFirstAnswerMs: integer("time_to_first_answer_ms"),
  totalElapsedMs: integer("total_elapsed_ms"),
  memoryItemsRetrieved: integer("memory_items_retrieved"),
  contextBytesInjected: integer("context_bytes_injected"),
  shieldedBytesAvoided: integer("shielded_bytes_avoided"),
  repoHitCount: integer("repo_hit_count"),
  repoCacheHit: integer("repo_cache_hit"),
  success: boolean("success"),
  userRating: integer("user_rating"),
  costUsd: real("cost_usd"),
  rawScore: real("raw_score"),
  compositeScore: real("composite_score"),
  scoringWeightsJson: jsonb("scoring_weights_json"),
  metricsJson: jsonb("metrics_json"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Per-skill aggregate eval tracking.
 * Updated whenever a skill appears in a completed eval run.
 */
export const skillEvalsTable = pgTable("skill_evals", {
  id: serial("id").primaryKey(),
  skillId: integer("skill_id").notNull().references(() => skillsTable.id).unique(),
  activationCount: integer("activation_count").notNull().default(0),
  evalAppearances: integer("eval_appearances").notNull().default(0),
  positiveLiftCount: integer("positive_lift_count").notNull().default(0),
  negativeLiftCount: integer("negative_lift_count").notNull().default(0),
  confidenceScore: real("confidence_score").notNull().default(0),
  estimatedContribution: real("estimated_contribution").notNull().default(0),
  lastEvalRunId: integer("last_eval_run_id").references(() => evalRunsTable.id),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Per-bundle aggregate eval tracking.
 * Updated whenever a bundle appears in a completed eval run.
 */
export const bundleEvalsTable = pgTable("bundle_evals", {
  id: serial("id").primaryKey(),
  bundleId: integer("bundle_id").notNull().references(() => skillBundlesTable.id).unique(),
  evalRunCount: integer("eval_run_count").notNull().default(0),
  avgCompositeScore: real("avg_composite_score"),
  avgBaselineScore: real("avg_baseline_score"),
  avgLift: real("avg_lift"),
  confidenceScore: real("confidence_score").notNull().default(0),
  bestTaskMode: text("best_task_mode"),
  bestTokenMode: text("best_token_mode"),
  ablationLiftScoresJson: jsonb("ablation_lift_scores_json"),
  byTaskModeJson: jsonb("by_task_mode_json"),
  lastEvalRunId: integer("last_eval_run_id").references(() => evalRunsTable.id),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Design intelligence entries ingested from curated external repos (e.g. ui-ux-pro-max-skill).
 * SHA-aware idempotence: unique on (source_id, category, name).
 * data_json holds the raw parsed row; tags is a string array for filtering.
 */
export const designIntelligenceEntriesTable = pgTable("design_intelligence_entries", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull().references(() => skillSourcesTable.id),
  category: text("category").notNull(),
  name: text("name").notNull(),
  dataJson: jsonb("data_json").notNull(),
  tags: jsonb("tags").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  sourceCategoryNameUnique: uniqueIndex("design_intel_source_category_name_unique")
    .on(table.sourceId, table.category, table.name),
}));

export const insertSkillSchema = createInsertSchema(skillsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type Skill = typeof skillsTable.$inferSelect;
export type SkillSource = typeof skillSourcesTable.$inferSelect;
export type SkillVersion = typeof skillVersionsTable.$inferSelect;
export type SkillBundle = typeof skillBundlesTable.$inferSelect;
export type SessionSkills = typeof sessionSkillsTable.$inferSelect;
export type RepoGraphJob = typeof repoGraphJobsTable.$inferSelect;
export type SessionRepoContext = typeof sessionRepoContextTable.$inferSelect;
export type EvalRun = typeof evalRunsTable.$inferSelect;
export type EvalRunVariant = typeof evalRunVariantsTable.$inferSelect;
export type SkillEval = typeof skillEvalsTable.$inferSelect;
export type BundleEval = typeof bundleEvalsTable.$inferSelect;
export type DesignIntelligenceEntry = typeof designIntelligenceEntriesTable.$inferSelect;
