-- Migration: project plans and tasks tables (Task #360 Living Project Plan)
--
-- project_plans: one plan per user+intent, supports versioning across sessions.
-- project_tasks: ordered steps within a plan, tracks status/priority/confirmation.
-- sessions.plan_id: nullable FK so sessions can be linked to a plan on creation.
--
-- Idempotency guard: safe to re-run.

CREATE TABLE IF NOT EXISTS "project_plans" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "repo_url" text,
  "title" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "project_tasks" (
  "id" serial PRIMARY KEY NOT NULL,
  "plan_id" integer NOT NULL REFERENCES "project_plans"("id") ON DELETE CASCADE,
  "step_index" integer NOT NULL,
  "text" text NOT NULL,
  "status" text NOT NULL DEFAULT 'planned',
  "priority" text NOT NULL DEFAULT 'normal',
  "confirmed_by_user" boolean NOT NULL DEFAULT false,
  "blocked_by" jsonb,
  "session_id" integer REFERENCES "sessions"("id") ON DELETE SET NULL,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "plan_id" integer REFERENCES "project_plans"("id") ON DELETE SET NULL;
ALTER TABLE "project_plans" ADD COLUMN IF NOT EXISTS "last_reassessment_summary" text;
ALTER TABLE "project_tasks" ADD COLUMN IF NOT EXISTS "origin_plan_version" integer;
