-- Add NIM/provider columns to sessions table
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'vastai';
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "nim_provider" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "nim_model_id" text;

-- Create NIM catalog table
CREATE TABLE IF NOT EXISTS "nim_catalog" (
	"nim_model_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"nim_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"partner_providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"short_description" text,
	"usecase_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_length" text,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
