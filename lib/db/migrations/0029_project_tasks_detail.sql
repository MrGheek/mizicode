-- Migration: add rich detail columns to project_tasks (Task #374)
-- done_looks_like : observable outcomes when the task is complete
-- out_of_scope     : what is explicitly not included in this task
-- file_dependencies: relevant files / sibling task names (newline-separated)
--
-- Idempotency guard: safe to re-run.

ALTER TABLE "project_tasks" ADD COLUMN IF NOT EXISTS "done_looks_like" text;
ALTER TABLE "project_tasks" ADD COLUMN IF NOT EXISTS "out_of_scope" text;
ALTER TABLE "project_tasks" ADD COLUMN IF NOT EXISTS "file_dependencies" text;
