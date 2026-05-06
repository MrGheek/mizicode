CREATE TABLE IF NOT EXISTS "orchestration_idempotency" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"session_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "orchestration_idempotency"
  ADD CONSTRAINT "orchestration_idempotency_session_id_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "orchestration_idempotency_created_at_idx"
  ON "orchestration_idempotency" USING btree ("created_at");
