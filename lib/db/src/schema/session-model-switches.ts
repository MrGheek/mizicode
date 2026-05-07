import { pgTable, serial, integer, text, timestamp, numeric } from "drizzle-orm/pg-core";
import { sessionsTable } from "./sessions";

// Audit log of every LLM model swap that occurs within a session.
// Populated by PATCH /sessions/:id/model. Used to render the Inference tab
// timeline in the dashboard and for post-session cost/quality analysis.
export const sessionModelSwitchesTable = pgTable("session_model_switches", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
  // Model before the switch (null for the initial assignment at session start).
  fromModelId: text("from_model_id"),
  fromProvider: text("from_provider"),
  // Model after the switch.
  toModelId: text("to_model_id").notNull(),
  toProvider: text("to_provider").notNull(),
  // Phase that triggered the switch (or the phase active at switch time).
  phase: text("phase"),
  // "auto" = triggered by phase-watcher; "manual" = user-initiated via dashboard.
  triggeredBy: text("triggered_by").notNull().default("manual"),
  // Human-readable reason for the switch (e.g. "phase changed to swarm", "user selected").
  reason: text("reason"),
  switchedAt: timestamp("switched_at").notNull().defaultNow(),
  // Real token-usage metrics for the interval this model was active.
  // Populated by PATCH /sessions/:id/model when the caller reports actual usage
  // (e.g. Claw Runner or orchestrator). NULL when not reported — model-history
  // falls back to throughput-class estimates for display purposes.
  tokensIn:  integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costUsd:   numeric("cost_usd", { precision: 12, scale: 8 }),
});

export type SessionModelSwitch = typeof sessionModelSwitchesTable.$inferSelect;
export type InsertSessionModelSwitch = typeof sessionModelSwitchesTable.$inferInsert;
