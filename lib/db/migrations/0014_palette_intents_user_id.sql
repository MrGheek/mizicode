ALTER TABLE "palette_intents" ADD COLUMN IF NOT EXISTS "user_id" text NOT NULL DEFAULT 'operator';
