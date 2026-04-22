-- Migration: add swarm_worker_cap to gpu_profiles
-- Task #112: vLLM swarm-mode profile tuning for all models
--
-- swarm_worker_cap is the maximum number of concurrent swarm workers a profile
-- can support without starving the orchestrator's KV cache. The value is passed
-- to each container as the SWARM_MAX_WORKERS environment variable so the Claw
-- Runner can enforce the cap without model-awareness.
--
-- Nullable: null means swarm is not configured for that profile.
-- All statements use IF NOT EXISTS / idempotency guards for safe re-execution.

ALTER TABLE gpu_profiles ADD COLUMN IF NOT EXISTS swarm_worker_cap integer;
