-- Migration: create design_intelligence_entries table
-- Task #107: Auto-ingest Design Intelligence from ui-ux-pro-max-skill
--
-- These changes are normally synced via `drizzle-kit push` in development.
-- This SQL file provides an idempotent reference for applying the schema to
-- existing production databases.
--
-- All statements use IF NOT EXISTS guards for safe re-execution.

CREATE TABLE IF NOT EXISTS "design_intelligence_entries" (
  "id"          serial       PRIMARY KEY,
  "source_id"   integer      NOT NULL REFERENCES "skill_sources"("id"),
  "category"    text         NOT NULL,
  "name"        text         NOT NULL,
  "data_json"   jsonb        NOT NULL,
  "tags"        jsonb        NOT NULL DEFAULT '[]',
  "created_at"  timestamp    NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "design_intel_source_category_name_unique"
  ON "design_intelligence_entries" ("source_id", "category", "name");
