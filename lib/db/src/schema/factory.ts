import { pgTable, serial, text, integer, timestamp, jsonb, real, boolean } from "drizzle-orm/pg-core";

export type WorkOrderStatus = "queued" | "dispatched" | "in_progress" | "blocked" | "done" | "skipped";
export type WorkOrderPriority = "high" | "normal" | "low";
export type StationRole = "build" | "review" | "debug" | "refactor" | "explore" | "team";

/**
 * RFC 0003 — Code Factory: products, work orders, stations.
 *
 * A product is a repo with a roadmap that outlives any single session. Work
 * orders are the unit of factory work — they flow through stations (sessions
 * with a role + capacity), not through sessions directly. WIP limits bound how
 * many work orders a product/station may run concurrently (Little's law).
 */
export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull().unique(),
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

export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = typeof productsTable.$inferInsert;
export type WorkOrder = typeof workOrdersTable.$inferSelect;
export type InsertWorkOrder = typeof workOrdersTable.$inferInsert;
export type Station = typeof stationsTable.$inferSelect;
export type InsertStation = typeof stationsTable.$inferInsert;
