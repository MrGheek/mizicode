ALTER TABLE "operator_credentials" ADD COLUMN IF NOT EXISTS "refresh_token_encrypted" text;
ALTER TABLE "operator_credentials" ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamp;
