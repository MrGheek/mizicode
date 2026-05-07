-- Schema templates: reusable SQL definitions for pre-seeded test databases
CREATE TABLE IF NOT EXISTS "schema_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(100) NOT NULL,
  "description" varchar(500) DEFAULT '' NOT NULL,
  "sql_content" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Provisioned resources: Postgres branches and Redis instances tied to sessions
CREATE TABLE IF NOT EXISTS "provisioned_resources" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" integer NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "type" varchar(50) NOT NULL,
  "resource_id" varchar(255),
  "connection_string" text,
  "schema_template_id" integer REFERENCES "schema_templates"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp,
  "deleted_at" timestamp
);
