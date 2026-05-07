import { Router } from "express";
import { db, schemaTemplatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { requireAgentAuth, optionalAgentAuth } from "../middlewares/agent-auth";

const router = Router();

const STANDARD_WEB_APP_TEMPLATE = `-- Standard web app schema: users, sessions, events
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`;

async function seedBuiltinTemplates() {
  try {
    const existing = await db
      .select({ id: schemaTemplatesTable.id })
      .from(schemaTemplatesTable)
      .limit(1);
    if (existing.length > 0) return;

    await db.insert(schemaTemplatesTable).values({
      name: "Standard web app",
      description: "Minimal schema with users, sessions, and events tables — covers the most common starting point",
      sqlContent: STANDARD_WEB_APP_TEMPLATE,
    });
    logger.info("Seeded built-in schema template: Standard web app");
  } catch (err) {
    logger.warn({ err }, "Failed to seed built-in schema templates (non-fatal)");
  }
}

seedBuiltinTemplates();

// GET schema-template endpoints use optionalAgentAuth — the dashboard fetches them without
// credentials (non-sensitive DDL templates). POST/DELETE remain write-protected.
router.get("/schema-templates", optionalAgentAuth(["sessions:read"]), async (_req, res) => {
  try {
    const templates = await db
      .select()
      .from(schemaTemplatesTable)
      .orderBy(schemaTemplatesTable.createdAt);
    res.json(templates);
  } catch (err) {
    logger.error(err, "Failed to list schema templates");
    res.status(500).json({ error: "Failed to list schema templates" });
  }
});

router.get("/schema-templates/:id", optionalAgentAuth(["sessions:read"]), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const [template] = await db
    .select()
    .from(schemaTemplatesTable)
    .where(eq(schemaTemplatesTable.id, id));
  if (!template) {
    res.status(404).json({ error: "Schema template not found" });
    return;
  }
  res.json(template);
});

router.post("/schema-templates", requireAgentAuth(["sessions:write"]), async (req, res) => {
  const { name, description, sqlContent } = req.body as {
    name?: string;
    description?: string;
    sqlContent?: string;
  };

  if (!name || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!sqlContent || !sqlContent.trim()) {
    res.status(400).json({ error: "sqlContent is required" });
    return;
  }

  try {
    const [template] = await db
      .insert(schemaTemplatesTable)
      .values({
        name: name.trim().slice(0, 100),
        description: (description ?? "").trim().slice(0, 500),
        sqlContent: sqlContent.trim(),
      })
      .returning();
    res.status(201).json(template);
  } catch (err) {
    logger.error(err, "Failed to create schema template");
    res.status(500).json({ error: "Failed to create schema template" });
  }
});

router.delete("/schema-templates/:id", requireAgentAuth(["sessions:write"]), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const [existing] = await db
    .select({ id: schemaTemplatesTable.id })
    .from(schemaTemplatesTable)
    .where(eq(schemaTemplatesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Schema template not found" });
    return;
  }
  await db
    .delete(schemaTemplatesTable)
    .where(eq(schemaTemplatesTable.id, id));
  res.json({ ok: true });
});

export default router;
