-- Migration: add owner_token to sessions
-- Task #113: Swarm activity panel — server-enforced abort authorization
--
-- owner_token is a random token generated at session creation time.
-- It is returned to the dashboard operator on the session detail endpoint
-- and required as Bearer auth on the POST /sessions/:id/swarm/abort route.
-- This prevents unauthorized aborts from direct API calls (e.g. by team members
-- who know the API URL but do not have dashboard access).
--
-- Backfill: existing sessions get a new random token so the constraint is
-- consistent. Uses gen_random_uuid() to avoid dependency on pgcrypto.
--
-- All statements use idempotency guards for safe re-execution.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_token text;

-- Back-fill existing rows with a unique random token (uuid-based)
UPDATE sessions SET owner_token = gen_random_uuid()::text WHERE owner_token IS NULL;
