-- Migration: add team_member_names to scheduler_config
-- Task #198: Fix scheduler sessions to match manual launch quality
--
-- team_member_names stores the optional list of member names configured by the
-- operator for scheduled sessions. launchScheduledSession reads this field,
-- generates per-member credentials, and passes them to buildOnStartScript so
-- scheduled sessions support the same team workspace flow as manually-launched ones.
--
-- Idempotency guard: safe to re-run.

ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS team_member_names text[] NOT NULL DEFAULT ARRAY[]::text[];
