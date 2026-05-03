CREATE TABLE IF NOT EXISTS "design_intelligence_bookmarks" (
  "id" serial PRIMARY KEY NOT NULL,
  "entry_id" integer NOT NULL REFERENCES "design_intelligence_entries"("id") ON DELETE cascade,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "design_intelligence_bookmarks_entry_unique" ON "design_intelligence_bookmarks" ("entry_id");
