import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sessionsTable } from "./sessions";

/**
 * Persists orchestration idempotency keys so that a server restart (deploy,
 * crash, scale-out) does not cause a second identical POST /sessions/orchestrate
 * call within the 5-minute window to create a duplicate GPU instance.
 *
 * The key is a SHA-256 of (goal + profileId + sorted member roles).
 *
 * Lifecycle:
 *   1. The first caller atomically INSERTs a row with session_id = NULL ("reserved").
 *   2. After successful session creation, the row is UPDATEd with the real session_id.
 *   3. If provisioning fails, the row is DELETEd so the next call can retry.
 *   4. Concurrent callers that lose the INSERT race check the existing row:
 *      - session_id IS NULL  → another request is provisioning (return 409, retry shortly)
 *      - session_id IS NOT NULL → return the existing session (200 idempotent)
 *
 * A NULL session_id that is older than 60 seconds is treated as a stale crash
 * reservation and is cleared automatically so new calls are not blocked forever.
 *
 * Entries older than 5 minutes are pruned by a periodic background cleanup job.
 */
export const orchestrationIdempotencyTable = pgTable("orchestration_idempotency", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  sessionId: integer("session_id").references(() => sessionsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("orchestration_idempotency_created_at_idx").on(table.createdAt),
]);

export type OrchestrationIdempotencyEntry = typeof orchestrationIdempotencyTable.$inferSelect;
