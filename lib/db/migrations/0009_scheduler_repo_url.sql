-- Migration: add repo_url to scheduler_config
-- Task #211: Pass repo fingerprint into auto-scheduled sessions for Smart Skills
--
-- repo_url stores an optional GitHub repository URL configured by the operator.
-- launchScheduledSession reads this field, derives a repo fingerprint (languages
-- and frameworks via the GitHub API), and injects repoLangs into the SessionContext
-- before compileBundle so scheduled sessions use the same Smart Skills bundle
-- selection logic as manually-launched sessions.
--
-- Idempotency guard: safe to re-run.

ALTER TABLE scheduler_config ADD COLUMN IF NOT EXISTS repo_url text;
