-- Migration: create Smart Skills eval tables
-- Task #61: Smart Skills Evals + Self-Optimizing Bundles
--
-- These tables are normally synced via `drizzle-kit push` in development.
-- This SQL file provides an idempotent reference for applying the schema to
-- existing production databases via `psql $DATABASE_URL -f 0001_eval_tables.sql`.
--
-- All statements use IF NOT EXISTS / IF NOT EXISTS guards for safe re-execution.

-- ─── eval_runs ────────────────────────────────────────────────────────────────
-- Each row represents one async eval run request (baseline, skill, bundle, or
-- bundle_variant ablation).  The worker picks it up from 'queued' status and
-- advances it through: queued → preparing → running → scoring → completed|error.
CREATE TABLE IF NOT EXISTS "eval_runs" (
  "id"                      serial PRIMARY KEY,
  "status"                  varchar(32)   NOT NULL DEFAULT 'queued',
  "run_type"                varchar(32)   NOT NULL,
  "target_skill_id"         integer       REFERENCES "skills"("id") ON DELETE SET NULL,
  "target_bundle_id"        integer       REFERENCES "skill_bundles"("id") ON DELETE SET NULL,
  "task_mode"               varchar(32)   NOT NULL DEFAULT 'build',
  "session_type"            varchar(32)   NOT NULL DEFAULT 'solo',
  "token_mode"              varchar(32)   NOT NULL DEFAULT 'core',
  "model_profile"           varchar(64)   NOT NULL DEFAULT 'kimi',
  "repo_kind"               varchar(64),
  "repo_langs_json"         jsonb,
  "repo_commit_sha"         varchar(64),
  "skill_version_ids_json"  jsonb         NOT NULL DEFAULT '{}',
  "bundle_version_hash"     varchar(64),
  "config_version"          varchar(128)  NOT NULL DEFAULT '1',
  "scoring_weights_json"    jsonb,
  "priority"                integer       NOT NULL DEFAULT 3,
  "cost_cap_usd"            numeric(12,6),
  "estimated_cost_usd"      numeric(12,6),
  "actual_cost_usd"         numeric(12,6),
  "error_details"           text,
  "notes"                   text,
  "scheduled_at"            timestamptz,
  "started_at"              timestamptz,
  "completed_at"            timestamptz,
  "created_at"              timestamptz   NOT NULL DEFAULT now(),
  "updated_at"              timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "eval_runs_status_idx"        ON "eval_runs" ("status");
CREATE INDEX IF NOT EXISTS "eval_runs_run_type_idx"      ON "eval_runs" ("run_type");
CREATE INDEX IF NOT EXISTS "eval_runs_target_skill_idx"  ON "eval_runs" ("target_skill_id");
CREATE INDEX IF NOT EXISTS "eval_runs_target_bundle_idx" ON "eval_runs" ("target_bundle_id");
CREATE INDEX IF NOT EXISTS "eval_runs_created_at_idx"    ON "eval_runs" ("created_at" DESC);

-- ─── eval_run_variants ────────────────────────────────────────────────────────
-- One row per variant per eval run.
-- variantType: 'baseline' | 'treatment' | 'ablated'
-- Ablated rows represent a bundle_variant run where one skill was withheld.
CREATE TABLE IF NOT EXISTS "eval_run_variants" (
  "id"                        serial PRIMARY KEY,
  "run_id"                    integer       NOT NULL REFERENCES "eval_runs"("id") ON DELETE CASCADE,
  "variant_type"              varchar(32)   NOT NULL,
  "skill_ids_included_json"   jsonb,
  "skill_ids_excluded_json"   jsonb,
  "time_to_first_answer_ms"   integer,
  "total_elapsed_ms"          integer,
  "memory_items_retrieved"    integer,
  "context_bytes_injected"    integer,
  "shielded_bytes_avoided"    integer,
  "repo_hit_count"            integer,
  "repo_cache_hit"            integer,
  "success"                   boolean,
  "user_rating"               integer,
  "cost_usd"                  numeric(12,6),
  "raw_score"                 numeric(10,6),
  "composite_score"           numeric(10,6),
  "scoring_weights_json"      jsonb,
  "metrics_json"              jsonb,
  "notes"                     text,
  "created_at"                timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "eval_run_variants_run_id_idx" ON "eval_run_variants" ("run_id");

-- ─── skill_evals ─────────────────────────────────────────────────────────────
-- Aggregated eval performance per skill (one row per skill, upserted after
-- each eval run that includes the skill as a treatment target).
CREATE TABLE IF NOT EXISTS "skill_evals" (
  "id"                      serial PRIMARY KEY,
  "skill_id"                integer       NOT NULL UNIQUE REFERENCES "skills"("id") ON DELETE CASCADE,
  "activation_count"        integer       NOT NULL DEFAULT 0,
  "eval_appearances"        integer       NOT NULL DEFAULT 0,
  "positive_lift_count"     integer       NOT NULL DEFAULT 0,
  "negative_lift_count"     integer       NOT NULL DEFAULT 0,
  "confidence_score"        numeric(10,6) NOT NULL DEFAULT 0,
  "estimated_contribution"  numeric(10,6) NOT NULL DEFAULT 0,
  "last_eval_run_id"        integer       REFERENCES "eval_runs"("id") ON DELETE SET NULL,
  "updated_at"              timestamptz   NOT NULL DEFAULT now()
);

-- ─── bundle_evals ────────────────────────────────────────────────────────────
-- Aggregated eval performance per bundle (one row per bundle, upserted after
-- each bundle/bundle_variant eval run targeting that bundle).
CREATE TABLE IF NOT EXISTS "bundle_evals" (
  "id"                      serial PRIMARY KEY,
  "bundle_id"               integer       NOT NULL UNIQUE REFERENCES "skill_bundles"("id") ON DELETE CASCADE,
  "eval_run_count"          integer       NOT NULL DEFAULT 0,
  "avg_composite_score"     numeric(10,6),
  "avg_baseline_score"      numeric(10,6),
  "avg_lift"                numeric(10,6),
  "confidence_score"        numeric(10,6) NOT NULL DEFAULT 0,
  "best_task_mode"              varchar(32),
  "best_token_mode"             varchar(32),
  "ablation_lift_scores_json"   jsonb,
  "by_task_mode_json"           jsonb,
  "last_eval_run_id"            integer       REFERENCES "eval_runs"("id") ON DELETE SET NULL,
  "updated_at"              timestamptz   NOT NULL DEFAULT now()
);
