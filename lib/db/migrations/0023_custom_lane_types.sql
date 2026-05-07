-- Add custom_lane_types table for operator-defined lane configurations
CREATE TABLE IF NOT EXISTS "custom_lane_types" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "description" text NOT NULL DEFAULT '',
  "max_concurrent_claims" integer NOT NULL DEFAULT 20,
  "heavy_job_slots" integer NOT NULL DEFAULT 2,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
