-- Migration: prompt contracts — lane_prompt_snapshots table + custom_lane_types policy columns (Task #443)
--
-- Adds:
--   custom_lane_types.overlay_skill_ids_json   — JSONB array of skill IDs to inject for this lane type
--   custom_lane_types.retrieval_emphasis_json  — JSONB map controlling memory retrieval weighting
--   custom_lane_types.policy_token_mode        — text override for default token mode (full|core|lean|ultra)
--   custom_lane_types.design_categories_json   — JSONB array of design intelligence categories to inject
--
--   lane_prompt_snapshots                      — records the active skill bundle (+ instruction fragment hash)
--                                                for each lane at compile time, enabling prompt replay
--
-- Idempotency guard: safe to re-run.

ALTER TABLE "custom_lane_types" ADD COLUMN IF NOT EXISTS "overlay_skill_ids_json" jsonb;
ALTER TABLE "custom_lane_types" ADD COLUMN IF NOT EXISTS "retrieval_emphasis_json" jsonb;
ALTER TABLE "custom_lane_types" ADD COLUMN IF NOT EXISTS "policy_token_mode" text;
ALTER TABLE "custom_lane_types" ADD COLUMN IF NOT EXISTS "design_categories_json" jsonb;

CREATE TABLE IF NOT EXISTS "lane_prompt_snapshots" (
  "id" serial PRIMARY KEY,
  "session_id" integer NOT NULL REFERENCES "sessions"("id"),
  "lane_id" integer NOT NULL REFERENCES "session_lanes"("id"),
  "prompt_hash" text NOT NULL,
  "skill_ids_json" jsonb NOT NULL,
  "system_prompt_fragment" text,
  "activated_at" timestamp NOT NULL DEFAULT now()
);
