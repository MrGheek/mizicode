import { Router } from "express";
import { db, templatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as vastai from "../services/vastai";
import { logger } from "../lib/logger";

const router = Router();

router.get("/templates", async (_req, res) => {
  const templates = await db.select().from(templatesTable);
  res.json(templates);
});

router.get("/templates/:templateId", async (req, res) => {
  const id = parseInt(req.params.templateId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }

  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, id));
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  res.json(template);
});

router.post("/templates", async (req, res) => {
  const { name, image, onStartScript, envVars, profileId, diskSpace, isDefault } = req.body;

  if (!name || !image) {
    res.status(400).json({ error: "name and image are required" });
    return;
  }

  try {
    const vastTemplate = await vastai.createTemplate({
      name,
      image_tag: image,
      onstart: onStartScript || "",
      env: envVars || "",
      disk_space: diskSpace || 400,
    });

    const templateHash = vastTemplate.template_hash || vastTemplate.hash_id || "";

    const [template] = await db
      .insert(templatesTable)
      .values({
        templateHash,
        name,
        image,
        onStartScript,
        envVars,
        isDefault: isDefault || false,
        profileId,
        diskSpace,
      })
      .returning();

    res.status(201).json(template);
  } catch (err: unknown) {
    logger.error(err, "Failed to create template");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to create template: ${message}` });
  }
});

router.put("/templates/:templateId", async (req, res) => {
  const id = parseInt(req.params.templateId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }

  const [existing] = await db.select().from(templatesTable).where(eq(templatesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.image !== undefined) updates.image = req.body.image;
  if (req.body.onStartScript !== undefined) updates.onStartScript = req.body.onStartScript;
  if (req.body.envVars !== undefined) updates.envVars = req.body.envVars;
  if (req.body.profileId !== undefined) updates.profileId = req.body.profileId;
  if (req.body.diskSpace !== undefined) updates.diskSpace = req.body.diskSpace;
  if (req.body.isDefault !== undefined) updates.isDefault = req.body.isDefault;

  const [updated] = await db
    .update(templatesTable)
    .set(updates)
    .where(eq(templatesTable.id, id))
    .returning();

  res.json(updated);
});

router.delete("/templates/:templateId", async (req, res) => {
  const id = parseInt(req.params.templateId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }

  const [existing] = await db.select().from(templatesTable).where(eq(templatesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  try {
    if (existing.templateHash) {
      await vastai.deleteTemplate(existing.templateHash).catch(() => {});
    }
  } catch {}

  await db.delete(templatesTable).where(eq(templatesTable.id, id));
  res.json({ success: true });
});

export default router;
