/**
 * Lane Event Emitter
 *
 * Fire-and-forget helper for inserting lane_events rows AND broadcasting the
 * new event over the coordination SSE channel at coordination lifecycle points.
 * All operations are non-blocking — callers do NOT await this function so
 * hot-path latency is unaffected. Errors are logged and swallowed.
 */

import { db, laneEventsTable } from "@workspace/db";
import type { LaneEventType } from "@workspace/db";
import { logger } from "../lib/logger";
import { broadcastLaneEvent } from "./lane-sse-broadcaster";

export interface LaneEventPayload {
  [key: string]: unknown;
}

/**
 * Emit a lane lifecycle event: persist to DB and broadcast over SSE.
 * Always fire-and-forget — never await in hot paths.
 *
 * @param sessionId  The session that owns the lane.
 * @param laneId     The lane the event belongs to.
 * @param eventType  One of the LaneEventType enum values.
 * @param payload    Optional JSONB payload with event-specific metadata.
 */
export function emitLaneEvent(
  sessionId: number,
  laneId: number,
  eventType: LaneEventType,
  payload?: LaneEventPayload,
): void {
  db.insert(laneEventsTable)
    .values({ sessionId, laneId, eventType, payload: payload ?? null })
    .returning()
    .then(([inserted]) => {
      if (inserted) broadcastLaneEvent(sessionId, inserted);
    })
    .catch((err: unknown) => {
      logger.warn({ err, sessionId, laneId, eventType }, "lane_event insert failed (non-fatal)");
    });
}
