-- Migration: add claim_purge_logs table to track historical purge runs
-- Each row records a single execution of the inactive-claim purge job, capturing
-- how many rows were deleted and the retention window used. This lets operators
-- query cumulative cleanup volume and detect abnormal accumulation trends.

CREATE TABLE IF NOT EXISTS "claim_purge_logs" (
  "id"             serial PRIMARY KEY,
  "purged_at"      timestamp NOT NULL DEFAULT now(),
  "rows_deleted"   integer   NOT NULL,
  "retention_days" integer   NOT NULL
);
