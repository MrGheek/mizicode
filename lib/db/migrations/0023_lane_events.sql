-- Add lane_events table for per-lane activity timeline audit trail
-- lane_id is intentionally NOT a foreign key to session_lanes so that audit
-- rows survive lane deletion (lane_destroyed events must outlive the lane row).
-- session_id IS a foreign key to sessions for ownership/access checks.
CREATE TABLE IF NOT EXISTS "lane_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" integer NOT NULL REFERENCES "sessions"("id"),
  "lane_id" integer NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "lane_events_lane_id_created_at_idx" ON "lane_events" ("lane_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "lane_events_session_id_created_at_idx" ON "lane_events" ("session_id", "created_at" DESC);
