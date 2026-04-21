import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
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
});

export const repoGraphJobsTable = pgTable("repo_graph_jobs", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  status: text("status").notNull().default("pending"),
  graphPath: text("graph_path"),
  indexedSymbols: integer("indexed_symbols"),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSkillSchema = createInsertSchema(skillsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type Skill = typeof skillsTable.$inferSelect;
export type SkillSource = typeof skillSourcesTable.$inferSelect;
export type SkillVersion = typeof skillVersionsTable.$inferSelect;
export type SkillBundle = typeof skillBundlesTable.$inferSelect;
export type SessionSkills = typeof sessionSkillsTable.$inferSelect;
