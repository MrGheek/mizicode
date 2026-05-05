-- Add per-model NIM metadata columns to gpu_profiles
-- nimModelId: the catalog model ID this profile targets (e.g. "moonshotai/kimi-k2-instruct")
-- nimTypes: cached tier tags array (nim_type_preview | nim_type_upgrade_available)
-- nimPartnerProviders: cached partner provider keys that can serve this model
ALTER TABLE "gpu_profiles" ADD COLUMN IF NOT EXISTS "nim_model_id" text;
ALTER TABLE "gpu_profiles" ADD COLUMN IF NOT EXISTS "nim_types" jsonb;
ALTER TABLE "gpu_profiles" ADD COLUMN IF NOT EXISTS "nim_partner_providers" jsonb;

-- Populate NIM metadata for the nim-workspace profile (NVIDIA free endpoint, Kimi K2 base)
UPDATE "gpu_profiles"
SET
  "nim_model_id" = 'moonshotai/kimi-k2-instruct',
  "nim_types" = '["nim_type_preview"]'::jsonb,
  "nim_partner_providers" = '[]'::jsonb
WHERE "name" = 'nim-workspace';
