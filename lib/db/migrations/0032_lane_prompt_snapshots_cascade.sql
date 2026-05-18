-- Migration: add ON DELETE CASCADE to lane_prompt_snapshots FKs (Task #443)
--
-- Without CASCADE, deleting a session or lane while snapshot rows exist raises a FK
-- violation. Both FKs must be dropped and re-added with ON DELETE CASCADE.
-- Safe to re-run — IF EXISTS guards prevent double-drop errors.

ALTER TABLE "lane_prompt_snapshots"
  DROP CONSTRAINT IF EXISTS "lane_prompt_snapshots_session_id_fkey";
ALTER TABLE "lane_prompt_snapshots"
  DROP CONSTRAINT IF EXISTS "lane_prompt_snapshots_lane_id_fkey";

ALTER TABLE "lane_prompt_snapshots"
  ADD CONSTRAINT "lane_prompt_snapshots_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;

ALTER TABLE "lane_prompt_snapshots"
  ADD CONSTRAINT "lane_prompt_snapshots_lane_id_fkey"
  FOREIGN KEY ("lane_id") REFERENCES "session_lanes"("id") ON DELETE CASCADE;
