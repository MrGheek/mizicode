-- Phase-aware mid-session model switching (Task #300)
-- Adds inference routing columns to sessions and nim_catalog, and a new
-- session_model_switches audit table.

-- nim_catalog: classify models by throughput profile
ALTER TABLE "nim_catalog" ADD COLUMN IF NOT EXISTS "throughput_class" text;

-- sessions: track active reasoning phase and model routing state
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "current_phase" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "active_nim_model_id" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "active_nim_provider" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "model_routing_mode" text DEFAULT 'auto';

-- session_model_switches: audit log of every model switch during a session
CREATE TABLE IF NOT EXISTS "session_model_switches" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" integer NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "from_model_id" text,
  "from_provider" text,
  "to_model_id" text NOT NULL,
  "to_provider" text NOT NULL,
  "phase" text,
  "triggered_by" text DEFAULT 'manual' NOT NULL,
  "reason" text,
  "switched_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "session_model_switches_session_id_idx"
  ON "session_model_switches" ("session_id");

-- Seed throughput_class consistent with CATALOG_THROUGHPUT_CLASS in nim-catalog.ts.
-- "high" = MoE large-total/small-active-param models (fast per-token).
-- "standard" = mid-size dense or moderate-MoE.
-- "economy" = small dense / distilled models.
UPDATE "nim_catalog" SET "throughput_class" = 'high' WHERE "nim_model_id" IN (
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2-instruct',
  'moonshotai/kimi-k2-instruct-0905',
  'moonshotai/kimi-k2-thinking',
  'minimaxai/minimax-m2.7',
  'minimaxai/minimax-m2.5',
  'qwen/qwen3-coder-480b-a35b-instruct',
  'qwen/qwen3.5-397b-a17b',
  'qwen/qwen3.5-122b-a10b',
  'deepseek-ai/deepseek-v4-pro',
  'deepseek-ai/deepseek-v4-flash',
  'mistralai/mistral-large-3-675b-instruct-2512'
);
UPDATE "nim_catalog" SET "throughput_class" = 'standard' WHERE "nim_model_id" IN (
  'z-ai/glm-5.1',
  'mistralai/devstral-2-123b-instruct-2512'
);
UPDATE "nim_catalog" SET "throughput_class" = 'economy' WHERE "nim_model_id" IN (
  'z-ai/glm-4.7',
  'mistralai/magistral-small-2506',
  'bytedance/seed-oss-36b-instruct'
);
