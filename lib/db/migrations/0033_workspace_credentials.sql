-- Migration: workspace_user and workspace_password columns on sessions (Task #455 follow-up)
--
-- NIM sessions are protected by nginx basic auth. The credentials are now
-- generated at provisioning time by the API server and stored here so the
-- dashboard can display them to the user.

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "workspace_user"     text,
  ADD COLUMN IF NOT EXISTS "workspace_password"  text;
