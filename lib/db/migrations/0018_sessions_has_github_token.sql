ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "has_github_token" boolean NOT NULL DEFAULT false;
