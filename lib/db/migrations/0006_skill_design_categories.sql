-- Migration: create skill_design_categories join table
-- Task #116: Link design entries to skills so users can see which skills use each design pattern
--
-- This table links skills to design intelligence categories.
-- Rows are inserted via keyword/tag matching or explicit manual links.
-- All statements use IF NOT EXISTS guards for safe re-execution.

CREATE TABLE IF NOT EXISTS "skill_design_categories" (
  "id"            serial       PRIMARY KEY,
  "skill_id"      integer      NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  "category"      text         NOT NULL,
  "match_method"  text         NOT NULL DEFAULT 'keyword',
  "created_at"    timestamp    NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "skill_design_category_unique"
  ON "skill_design_categories" ("skill_id", "category");
