-- Migration: add origin and rationale columns to project_tasks (Task #383)
-- origin   : identifies where a task came from ('user' | 'initial_plan' | 'swarm_discovered')
-- rationale: short explanation of why the swarm added this task (null for user/initial tasks)
--
-- Idempotency guard: safe to re-run.

ALTER TABLE "project_tasks" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'user';
ALTER TABLE "project_tasks" ADD COLUMN IF NOT EXISTS "rationale" text;
