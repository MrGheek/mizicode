import { pgTable, serial, text, integer, timestamp, jsonb, real, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type WorkOrderStatus = "queued" | "dispatched" | "in_progress" | "blocked" | "done" | "skipped";
export type WorkOrderPriority = "high" | "normal" | "low";
export type StationRole = "build" | "review" | "debug" | "refactor" | "explore" | "team";
export type ProductPriority = "p0" | "p1" | "p2";

export interface FactoryDefaultPolicy {
  defaultWipLimit: number;
  defaultStationRoles: string[];
  defaultQualityGateConfig: Record<string, unknown> | null;
  lanePool: { idleReleaseAfterMs: number; claimLapseAfterMs: number };
}

export const DEFAULT_FACTORY_POLICY: FactoryDefaultPolicy = {
  defaultWipLimit: 4,
  defaultStationRoles: ["build", "review"],
  defaultQualityGateConfig: null,
  lanePool: { idleReleaseAfterMs: 300_000, claimLapseAfterMs: 900_000 },
};

/**
 * RFC 0006 — Code Factory (fab): the fab is the tenant that owns products, a
 * shared lane pool (sessions), a budget, and default policies. A product is a
 * repo with a roadmap that outlives any single session. Work orders are the
 * unit of factory work — they flow through stations (role definitions), not
 * through sessions directly. WIP limits bound how many work orders a
 * product/station may run concurrently (Little's law).
 */
export const factoriesTable = pgTable("factories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** Max concurrently claimed sessions across ALL products in the fab. */
  lanePoolLimit: integer("lane_pool_limit").notNull().default(8),
  /** Per-period spend budget (connected to the RFC 0001 ledger; null = untracked). */
  budgetUsd: real("budget_usd"),
  /** Fab-level defaults applied at product creation (WIP, station roles, gates). */
  defaultPolicyJson: jsonb("default_policy_json").$type<FactoryDefaultPolicy>().notNull().default(DEFAULT_FACTORY_POLICY),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull().unique(),
  factoryId: integer("factory_id").references(() => factoriesTable.id, { onDelete: "restrict" }),
  /** Standing product priority fed into the dispatch score (RFC 0006). */
  productPriority: text("product_priority").notNull().default("p2").$type<ProductPriority>(),
  /** SLA date; null = none. Feeds dueDatePressure in the dispatch score. */
  dueDate: timestamp("due_date"),
  /** Rolling 30-day spend cap (RFC 0001 ledger); null = untracked. */
  budgetUsd: real("budget_usd"),
  /** Ordered roadmap: array of work-order ids (the product's backlog). */
  roadmapJson: jsonb("roadmap_json").$type<number[]>().notNull().default([]),
  /** Max concurrent work orders the product may run (WIP limit). */
  wipLimit: integer("wip_limit").notNull().default(4),
  /** Quality-gate config (per-station gates, ship gate). */
  qualityGateConfig: jsonb("quality_gate_config"),
  /** Pipeline config (build → test → stage → ship). */
  pipelineConfig: jsonb("pipeline_config"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const workOrdersTable = pgTable("work_orders", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => productsTable.id, { onDelete: "cascade" }),
  goal: text("goal").notNull(),
  priority: text("priority").notNull().default("normal").$type<WorkOrderPriority>(),
  /** DAG of work-order ids this order depends on (must complete first). */
  dependenciesJson: jsonb("dependencies_json").$type<number[]>().notNull().default([]),
  /** Acceptance criteria (free text / structured). */
  acceptanceCriteria: jsonb("acceptance_criteria"),
  /** Station assigned to execute this order (null = not yet dispatched). */
  assignedStationId: integer("assigned_station_id"),
  status: text("status").notNull().default("queued").$type<WorkOrderStatus>(),
  /** Rework counter — increments each time the order is rejected at a gate. */
  reworkCount: integer("rework_count").notNull().default(0),
  /** Defect class of the last rejection (for per-station defect telemetry). */
  lastDefectClass: text("last_defect_class"),
  /** Session that executed this order (set on dispatch). */
  sessionId: integer("session_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});

export const stationsTable = pgTable("stations", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => productsTable.id, { onDelete: "cascade" }),
  /** Session that backs this station (a session becomes a station). */
  sessionId: integer("session_id"),
  role: text("role").notNull().default("build").$type<StationRole>(),
  /** Max concurrent lanes this station may run. */
  capacity: integer("capacity").notNull().default(2),
  /** Max concurrent work orders this station may hold (WIP limit). */
  wipLimit: integer("wip_limit").notNull().default(2),
  /** Cumulative defect count (rework loop telemetry). */
  defectCount: integer("defect_count").notNull().default(0),
  /** Cumulative rework cycles-to-clear (telemetry). */
  reworkCycles: integer("rework_cycles").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * RFC 0006 — station claims: a station CLAIMS a session (box) from the shared
 * fab lane pool at dispatch and RELEASES it when idle. One active claim per
 * session; orders ride the claim via work_orders.session_id (swarm fan-out).
 */
export const stationClaimsTable = pgTable("station_claims", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => productsTable.id, { onDelete: "cascade" }),
  stationId: integer("station_id").notNull().references(() => stationsTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").notNull(),
  /** Current order on the claim — audit only; null while the claim sits idle. */
  workOrderId: integer("work_order_id"),
  claimedAt: timestamp("claimed_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at").notNull().defaultNow(),
  releasedAt: timestamp("released_at"),
  active: boolean("active").notNull().default(true),
}, (table) => [
  uniqueIndex("station_claims_active_session_unique_idx")
    .on(table.sessionId)
    .where(sql`${table.active} = true`),
  uniqueIndex("station_claims_active_station_unique_idx")
    .on(table.stationId)
    .where(sql`${table.active} = true`),
]);

/**
 * RFC 0003 Phase 2 — rework items: one row per rejected deliverable.
 *
 * A work order that fails a station gate (or the deliverable contract) is
 * routed to rework. Each rejection is recorded as a rework item so rework is a
 * first-class, tracked, telemetry-bearing flow (defect class, producing
 * station, cycle number, when it cleared).
 */
export const reworkItemsTable = pgTable("rework_items", {
  id: serial("id").primaryKey(),
  workOrderId: integer("work_order_id").notNull().references(() => workOrdersTable.id, { onDelete: "cascade" }),
  stationId: integer("station_id").notNull().references(() => stationsTable.id, { onDelete: "cascade" }),
  /** Defect class of the rejection (test_failure, lint_failure, forge_failure, ...). */
  defectClass: text("defect_class").notNull(),
  /** 1-based rework cycle this item represents. */
  cycle: integer("cycle").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  /** When the work order cleared the rework loop (reached done). */
  clearedAt: timestamp("cleared_at"),
});

/**
 * RFC 0003 Phase 3 — pipeline runs: one row per stage of a continuous
 * build → test → stage → ship pipeline.
 *
 * The pipeline runs continuously per product (not per session). Each run is
 * triggered by a completed work order. Staged artifacts are the product's
 * shippable state; ship is gated on the product's quality_gate_config.
 */
export type PipelineStage = "build" | "test" | "stage" | "ship";
export type PipelineStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export const pipelineRunsTable = pgTable("pipeline_runs", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => productsTable.id, { onDelete: "cascade" }),
  /** Work order that triggered this pipeline run. */
  triggerWorkOrderId: integer("trigger_work_order_id").references(() => workOrdersTable.id, { onDelete: "set null" }),
  stage: text("stage").notNull().$type<PipelineStage>(),
  status: text("status").notNull().default("pending").$type<PipelineStatus>(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  /** Staged artifacts: array of { name, url, hash } objects. */
  artifactsJson: jsonb("artifacts_json"),
  /** Quality gate result for this stage. */
  gatePassed: boolean("gate_passed").default(false),
  gateDetail: text("gate_detail"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * RFC 0003 Phase 3 — factory metrics: periodic time-series snapshots.
 *
 * A snapshot captures the factory's state at a point in time: throughput,
 * cycle time, defect rate, rework rate, station utilization, WIP occupancy,
 * cost per work order. Fed to the factory dashboard / status-bar surface.
 */
export const factoryMetricsTable = pgTable("factory_metrics", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => productsTable.id, { onDelete: "cascade" }),
  snapshotTime: timestamp("snapshot_time").notNull().defaultNow(),
  /** Aggregate metrics snapshot (throughput, cycleTime, defectRate, ...). */
  snapshotJson: jsonb("snapshot_json").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Factory = typeof factoriesTable.$inferSelect;
export type InsertFactory = typeof factoriesTable.$inferInsert;
export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = typeof productsTable.$inferInsert;
export type WorkOrder = typeof workOrdersTable.$inferSelect;
export type InsertWorkOrder = typeof workOrdersTable.$inferInsert;
export type Station = typeof stationsTable.$inferSelect;
export type InsertStation = typeof stationsTable.$inferInsert;
export type StationClaim = typeof stationClaimsTable.$inferSelect;
export type InsertStationClaim = typeof stationClaimsTable.$inferInsert;
export type ReworkItem = typeof reworkItemsTable.$inferSelect;
export type InsertReworkItem = typeof reworkItemsTable.$inferInsert;
export type PipelineRun = typeof pipelineRunsTable.$inferSelect;
export type InsertPipelineRun = typeof pipelineRunsTable.$inferInsert;
export type FactoryMetrics = typeof factoryMetricsTable.$inferSelect;
export type InsertFactoryMetrics = typeof factoryMetricsTable.$inferInsert;
