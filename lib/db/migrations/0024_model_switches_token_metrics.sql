-- Task #300: add real token-usage and cost columns to session_model_switches.
-- When the Claw Runner (or orchestrator) reports actual token counts at switch
-- time, these columns store the real data. When not provided, the model-history
-- endpoint falls back to throughput-class estimates so the cost chart always
-- has something to show — but real values take priority when present.
ALTER TABLE "session_model_switches" ADD COLUMN IF NOT EXISTS "tokens_in"  integer;
ALTER TABLE "session_model_switches" ADD COLUMN IF NOT EXISTS "tokens_out" integer;
ALTER TABLE "session_model_switches" ADD COLUMN IF NOT EXISTS "cost_usd"   numeric(12, 8);
