-- Add SWE-bench scoring fields to nim_catalog table
-- sweBenchScore: numeric SWE-bench score (e.g. 65.8 for Kimi K2.6)
-- benchmarkVariant: which benchmark suite was used (e.g. "SWE-bench Verified")
ALTER TABLE "nim_catalog" ADD COLUMN IF NOT EXISTS "swe_bench_score" real;
ALTER TABLE "nim_catalog" ADD COLUMN IF NOT EXISTS "benchmark_variant" text;

-- Seed confirmed SWE-bench Verified scores from public leaderboard data
UPDATE "nim_catalog" SET "swe_bench_score" = 80.2, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'minimaxai/minimax-m2.5';
UPDATE "nim_catalog" SET "swe_bench_score" = 67.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'deepseek-ai/deepseek-v4-pro';
UPDATE "nim_catalog" SET "swe_bench_score" = 65.8, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'moonshotai/kimi-k2.6';
UPDATE "nim_catalog" SET "swe_bench_score" = 63.6, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'moonshotai/kimi-k2-instruct-0905';
UPDATE "nim_catalog" SET "swe_bench_score" = 63.6, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'moonshotai/kimi-k2-instruct';
UPDATE "nim_catalog" SET "swe_bench_score" = 63.6, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'moonshotai/kimi-k2-thinking';
UPDATE "nim_catalog" SET "swe_bench_score" = 62.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'qwen/qwen3-coder-480b-a35b-instruct';
UPDATE "nim_catalog" SET "swe_bench_score" = 60.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'qwen/qwen3.5-397b-a17b';
UPDATE "nim_catalog" SET "swe_bench_score" = 58.4, "benchmark_variant" = 'SWE-bench Pro' WHERE "nim_model_id" = 'z-ai/glm-5.1';
UPDATE "nim_catalog" SET "swe_bench_score" = 58.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'mistralai/devstral-2-123b-instruct-2512';
UPDATE "nim_catalog" SET "swe_bench_score" = 55.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'deepseek-ai/deepseek-v4-flash';
UPDATE "nim_catalog" SET "swe_bench_score" = 55.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'qwen/qwen3.5-122b-a10b';
UPDATE "nim_catalog" SET "swe_bench_score" = 55.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'minimaxai/minimax-m2.7';
UPDATE "nim_catalog" SET "swe_bench_score" = 46.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'mistralai/mistral-large-3-675b-instruct-2512';
UPDATE "nim_catalog" SET "swe_bench_score" = 45.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'z-ai/glm-4.7';
UPDATE "nim_catalog" SET "swe_bench_score" = 42.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'bytedance/seed-oss-36b-instruct';
UPDATE "nim_catalog" SET "swe_bench_score" = 38.0, "benchmark_variant" = 'SWE-bench Verified' WHERE "nim_model_id" = 'mistralai/magistral-small-2506';
