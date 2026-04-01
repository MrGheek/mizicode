import { Router } from "express";
import { db, templatesTable } from "@workspace/db";
import { eq, ne } from "drizzle-orm";
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

    if (isDefault) {
      await db.update(templatesTable).set({ isDefault: false });
    }

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

  const { name, image, onStartScript, envVars, profileId, diskSpace, isDefault } = req.body;

  const contentChanged =
    (image !== undefined && image !== existing.image) ||
    (onStartScript !== undefined && onStartScript !== existing.onStartScript) ||
    (envVars !== undefined && envVars !== existing.envVars) ||
    (diskSpace !== undefined && diskSpace !== existing.diskSpace);

  let templateHash = existing.templateHash;

  if (contentChanged && existing.templateHash) {
    try {
      const vastResult = await vastai.updateTemplate(existing.templateHash, {
        name: name || existing.name,
        image_tag: image || existing.image || "",
        onstart: onStartScript || existing.onStartScript || "",
        env: envVars || existing.envVars || "",
        disk_space: diskSpace || existing.diskSpace || 400,
      });
      templateHash = vastResult.template_hash || vastResult.hash_id || templateHash;
      logger.info({ templateHash }, "Template updated on Vast.ai (delete+recreate)");
    } catch (err: unknown) {
      logger.error(err, "Failed to update template on Vast.ai — updating local DB only");
    }
  }

  if (isDefault === true) {
    await db.update(templatesTable).set({ isDefault: false }).where(ne(templatesTable.id, id));
  }

  const updates: Record<string, unknown> = { updatedAt: new Date(), templateHash };
  if (name !== undefined) updates.name = name;
  if (image !== undefined) updates.image = image;
  if (onStartScript !== undefined) updates.onStartScript = onStartScript;
  if (envVars !== undefined) updates.envVars = envVars;
  if (profileId !== undefined) updates.profileId = profileId;
  if (diskSpace !== undefined) updates.diskSpace = diskSpace;
  if (isDefault !== undefined) updates.isDefault = isDefault;

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
