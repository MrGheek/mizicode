import { pgTable, serial, text, integer, timestamp, jsonb, real, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sessionsTable } from "./sessions";

export type LaneType = "ux" | "debug" | "backend" | "review" | "general";
export type LaneStatus = "active" | "blocked" | "review-needed" | "ready-to-merge";
export type ClaimType = "file" | "module" | "symbol" | "task";
export type ClaimStrength = "watching" | "editing" | "owner";
export type HandoffType = "blocked" | "needs_review" | "safe_to_merge" | "watch_files" | "related_lane";
export type HeavyJobClass = "indexing" | "embedding" | "eval" | "blast_radius" | "compile" | "other";
export type HeavyJobStatus = "queued" | "running" | "deferred" | "completed" | "failed";

export const sessionLanesTable = pgTable("session_lanes", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id),
  memberIdentifier: text("member_identifier").notNull(),
  laneType: text("lane_type").notNull().default("general"),
  taskMode: text("task_mode").notNull().default("build"),
  status: text("status").notNull().default("active"),
  overlayBundleId: integer("overlay_bundle_id"),
  tokenMode: text("token_mode").notNull().default("core"),
  currentTask: text("current_task"),
  handoffData: jsonb("handoff_data"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const laneClaimsTable = pgTable("lane_claims", {
  id: serial("id").primaryKey(),
  laneId: integer("lane_id").notNull().references(() => sessionLanesTable.id),
  claimType: text("claim_type").notNull(),
  pathOrSymbol: text("path_or_symbol").notNull(),
  claimSymbols: jsonb("claim_symbols"),
  claimedAt: timestamp("claimed_at").notNull().defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  claimStrength: text("claim_strength").notNull().default("watching"),
  active: boolean("active").notNull().default(true),
}, (table) => [
  uniqueIndex("lane_claims_active_unique_idx")
    .on(table.laneId, table.pathOrSymbol)
    .where(sql`${table.active} = true`),
]);

export const laneHandoffsTable = pgTable("lane_handoffs", {
  id: serial("id").primaryKey(),
  laneId: integer("lane_id").notNull().references(() => sessionLanesTable.id),
  handoffType: text("handoff_type").notNull(),
  notes: text("notes"),
  relatedLaneId: integer("related_lane_id"),
  watchFiles: jsonb("watch_files"),
  status: text("status").notNull().default("pending"),
  acknowledgedAt: timestamp("acknowledged_at"),
  prUrl: text("pr_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const laneHeavyJobsTable = pgTable("lane_heavy_jobs", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id),
  laneId: integer("lane_id").references(() => sessionLanesTable.id),
  jobClass: text("job_class").notNull(),
  status: text("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(5),
  ageWeight: real("age_weight").notNull().default(0),
  laneWeight: real("lane_weight").notNull().default(1.0),
  effectiveScore: real("effective_score").notNull().default(0),
  payload: jsonb("payload"),
  result: jsonb("result"),
  errorDetails: text("error_details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  deferredUntil: timestamp("deferred_until"),
});

export const claimPurgeLogsTable = pgTable("claim_purge_logs", {
  id: serial("id").primaryKey(),
  purgedAt: timestamp("purged_at").notNull().defaultNow(),
  rowsDeleted: integer("rows_deleted").notNull(),
  retentionDays: integer("retention_days").notNull(),
});

export const customLaneTypesTable = pgTable("custom_lane_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  maxConcurrentClaims: integer("max_concurrent_claims").notNull().default(20),
  heavyJobSlots: integer("heavy_job_slots").notNull().default(2),
  overlaySkillIdsJson: jsonb("overlay_skill_ids_json"),
  retrievalEmphasisJson: jsonb("retrieval_emphasis_json"),
  policyTokenMode: text("policy_token_mode"),
  designCategoriesJson: jsonb("design_categories_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const lanePromptSnapshotsTable = pgTable("lane_prompt_snapshots", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
  laneId: integer("lane_id").notNull().references(() => sessionLanesTable.id, { onDelete: "cascade" }),
  promptHash: text("prompt_hash").notNull(),
  skillIdsJson: jsonb("skill_ids_json").notNull(),
  systemPromptFragment: text("system_prompt_fragment"),
  activatedAt: timestamp("activated_at").notNull().defaultNow(),
});

export type LaneEventType =
  | "claim_created"
  | "claim_released"
  | "claim_expired"
  | "handoff_sent"
  | "handoff_acknowledged"
  | "heavy_job_started"
  | "heavy_job_completed"
  | "lane_created"
  | "lane_destroyed"
  // RFC 0002 Phase 2 — typed intent events (durable engineering context)
  | "intent_decision"
  | "intent_interface_change"
  | "intent_warning"
  | "intent_verification"
  | "conflict_resolved";

export const laneEventsTable = pgTable("lane_events", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id),
  laneId: integer("lane_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ConflictResolutionOutcome = "preserved_both" | "chose_one" | "escalated";

/**
 * RFC 0002 Phase 2 — conflict-resolution notes.
 *
 * Every resolved merge conflict records how it was resolved and the intent
 * that drove it, so the Arbiter and eval harness can learn from past
 * resolutions instead of re-deriving them.
 */
export const laneConflictResolutionsTable = pgTable("lane_conflict_resolutions", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id),
  mergeJobId: integer("merge_job_id").references(() => laneMergeQueueTable.id),
  filePath: text("file_path").notNull(),
  outcome: text("outcome").notNull().default("preserved_both"),
  summary: text("summary").notNull(),
  /** Intent events (ids) that informed the resolution. */
  intentEventIds: jsonb("intent_event_ids"),
  /** True when the resolution was verified by a passing test command. */
  testVerified: boolean("test_verified").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type LaneMergeStatus = "queued" | "merging" | "merged" | "skipped" | "failed";
/**
 * RFC 0002 Phase 1 — risk-sequenced lane merge queue.
 *
 * A lane's `safe_to_merge` handoff enqueues a merge job here. The queue is
 * drained smallest/lowest-risk first; each merge is test-gated and
 * skip-not-abort on conflict, so one conflicting lane never blocks the batch.
 */
export const laneMergeQueueTable = pgTable("lane_merge_queue", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id),
  laneId: integer("lane_id").notNull().references(() => sessionLanesTable.id),
  handoffId: integer("handoff_id").references(() => laneHandoffsTable.id),
  status: text("status").notNull().default("queued"),
  /** Risk score [0, 1] — lower = merge sooner (small/low-risk first). */
  riskScore: real("risk_score").notNull().default(0.5),
  /** Branch names resolved at enqueue time. */
  headBranch: text("head_branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  /** Commit SHA of the lane branch at enqueue time (for resumable resolve). */
  headSha: text("head_sha"),
  /** Result of the last merge attempt. */
  result: jsonb("result"),
  errorDetails: text("error_details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});

export type SessionLane = typeof sessionLanesTable.$inferSelect;
export type LaneClaim = typeof laneClaimsTable.$inferSelect;
export type LaneHandoff = typeof laneHandoffsTable.$inferSelect;
export type LaneHeavyJob = typeof laneHeavyJobsTable.$inferSelect;
export type ClaimPurgeLog = typeof claimPurgeLogsTable.$inferSelect;
export type CustomLaneType = typeof customLaneTypesTable.$inferSelect;
export type LaneEvent = typeof laneEventsTable.$inferSelect;
export type LanePromptSnapshot = typeof lanePromptSnapshotsTable.$inferSelect;
export type LaneMergeJob = typeof laneMergeQueueTable.$inferSelect;
export type LaneConflictResolution = typeof laneConflictResolutionsTable.$inferSelect;
