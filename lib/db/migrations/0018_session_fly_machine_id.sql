-- Add fly_machine_id to sessions for NIM sessions provisioned on Fly.io
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "fly_machine_id" text;
