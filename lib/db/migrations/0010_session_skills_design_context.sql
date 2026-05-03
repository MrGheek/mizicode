-- Migration: add design_context_json to session_skills
-- Task #119: Surface design context in the Skills panel
--
-- design_context_json stores the DesignContextEntry[] that was injected into
-- the compiled bundle at session activation time. It is returned by the
-- GET /sessions/:id/skills endpoint so the dashboard Skills panel can display
-- which color palettes, typography rules, and UX guidelines were active.
--
-- NULL for old activations and for lean/ultra token modes (injection skipped).
--
-- Idempotency guard: safe to re-run.

ALTER TABLE "session_skills" ADD COLUMN IF NOT EXISTS "design_context_json" jsonb;
