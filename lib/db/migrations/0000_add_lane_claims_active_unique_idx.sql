-- Migration: add partial unique index on lane_claims (lane_id, path_or_symbol) WHERE active = true
-- This prevents duplicate active claims for the same resource in the same lane,
-- closing the race-condition window that application-level upsert logic cannot fully guard.

-- Step 1: Remove any duplicate active rows that may have accumulated before this index
-- For each (lane_id, path_or_symbol) group with more than one active row, keep only the
-- most recently heartbeated one and deactivate the rest.
UPDATE lane_claims
SET active = false
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY lane_id, path_or_symbol
        ORDER BY last_heartbeat_at DESC, id DESC
      ) AS rn
    FROM lane_claims
    WHERE active = true
  ) ranked
  WHERE rn > 1
);

-- Step 2: Create the partial unique index (idempotent via IF NOT EXISTS)
CREATE UNIQUE INDEX IF NOT EXISTS "lane_claims_active_unique_idx"
  ON "lane_claims" USING btree ("lane_id", "path_or_symbol")
  WHERE "active" = true;
