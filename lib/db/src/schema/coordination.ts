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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SessionLane = typeof sessionLanesTable.$inferSelect;
export type LaneClaim = typeof laneClaimsTable.$inferSelect;
export type LaneHandoff = typeof laneHandoffsTable.$inferSelect;
export type LaneHeavyJob = typeof laneHeavyJobsTable.$inferSelect;
export type ClaimPurgeLog = typeof claimPurgeLogsTable.$inferSelect;
export type CustomLaneType = typeof customLaneTypesTable.$inferSelect;
