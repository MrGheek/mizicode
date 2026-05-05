CREATE TABLE IF NOT EXISTS "palette_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"ok" boolean NOT NULL,
	"action" text,
	"payload_json" jsonb,
	"explanation" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
