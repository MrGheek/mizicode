import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sessionsTable } from "./sessions";

export type PlanTaskStatus = "planned" | "in_progress" | "done" | "partial" | "skipped";
export type PlanTaskPriority = "high" | "normal" | "low";

export const projectPlansTable = pgTable("project_plans", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  repoUrl: text("repo_url"),
  title: text("title").notNull(),
  version: integer("version").notNull().default(1),
  lastReassessmentSummary: text("last_reassessment_summary"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const projectTasksTable = pgTable("project_tasks", {
  id: serial("id").primaryKey(),
  planId: integer("plan_id").notNull().references(() => projectPlansTable.id, { onDelete: "cascade" }),
  stepIndex: integer("step_index").notNull(),
  text: text("text").notNull(),
  status: text("status").notNull().default("planned").$type<PlanTaskStatus>(),
  priority: text("priority").notNull().default("normal").$type<PlanTaskPriority>(),
  confirmedByUser: boolean("confirmed_by_user").notNull().default(false),
  // originPlanVersion records which plan version first introduced this task.
  // Enables per-task traceability: the board card can display "added in v3" and
  // the export can group tasks by the plan version that produced them.
  originPlanVersion: integer("origin_plan_version"),
  blockedBy: jsonb("blocked_by").$type<number[]>(),
  sessionId: integer("session_id").references(() => sessionsTable.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ProjectPlan = typeof projectPlansTable.$inferSelect;
export type InsertProjectPlan = typeof projectPlansTable.$inferInsert;
export type ProjectTask = typeof projectTasksTable.$inferSelect;
export type InsertProjectTask = typeof projectTasksTable.$inferInsert;
