-- Add NIM metadata columns to gpu_profiles table
-- isNimWorkspace marks a profile as a hosted-inference workspace (no GPU rental)
-- nimDefaultProvider records the default provider key for NIM sessions
ALTER TABLE "gpu_profiles" ADD COLUMN IF NOT EXISTS "is_nim_workspace" boolean NOT NULL DEFAULT false;
ALTER TABLE "gpu_profiles" ADD COLUMN IF NOT EXISTS "nim_default_provider" text;

-- Mark the nim-workspace profile as a NIM workspace with nvidia as default provider
UPDATE "gpu_profiles"
SET "is_nim_workspace" = true, "nim_default_provider" = 'nvidia'
WHERE "name" = 'nim-workspace';
