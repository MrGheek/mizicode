-- Migration: add pr_url to lane_handoffs for auto-opened draft PRs
-- When a lane signals "safe_to_merge" and the operator has a GitHub OAuth token,
-- the API server creates a draft PR and stores the resulting URL here.
-- NULL means no PR was created (no OAuth token, or non-safe_to_merge handoff type).

ALTER TABLE "lane_handoffs" ADD COLUMN IF NOT EXISTS "pr_url" text;
