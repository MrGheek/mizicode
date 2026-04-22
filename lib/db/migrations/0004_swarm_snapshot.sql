-- Migration: add swarm_snapshot_json to sessions
-- Task #113: Swarm activity panel in session cockpit
--
-- swarm_snapshot_json stores the last-known swarm execution snapshot pushed
-- by the Claw Runner via POST /sessions/:id/swarm-push. Persisting it to the
-- DB ensures the cockpit can render historical swarm data even after an API
-- server restart (in-memory cache is gone, DB record survives).
--
-- Nullable: null means no swarm snapshot was ever received for this session.
-- All statements use idempotency guards for safe re-execution.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS swarm_snapshot_json jsonb;
