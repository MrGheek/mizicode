import { Router } from "express";
import { db, skillsTable, skillBundlesTable, skillSourcesTable, skillVersionsTable, skillFeedbackTable, sessionSkillsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { importSkillFromUrl } from "../services/skills-import";
import { seedDefaultBundles, compileBundle, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext } from "../services/skills-bundler";
import { DEFAULT_SKILLS } from "../services/default-skills";
import { logger } from "../lib/logger";
import type { SessionContext } from "../services/skills-types";

const router = Router();

const NOT_IMPLEMENTED = (feature: string) => ({
  error: "not implemented",
  feature,
  availableIn: "Phase 4",
});

router.get("/skills", async (_req, res) => {
  const skills = await db
    .select()
    .from(skillsTable)
    .orderBy(desc(skillsTable.createdAt));

  res.json({ skills, builtins: DEFAULT_SKILLS.map(s => ({ id: s.id, name: s.name, class: s.class, summary: s.summary })) });
});

router.get("/skills/discover", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED("skill discovery"));
});

router.get("/skills/leaderboard", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED("skill leaderboard"));
});

router.get("/skills/evals", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED("skill evals listing"));
});

router.post("/skills/evals/run", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED("skill evals"));
});

router.get("/skills/:skillId", async (req, res) => {
  const id = parseInt(req.params.skillId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid skill ID" });
    return;
  }

  const [skill] = await db.select().from(skillsTable).where(eq(skillsTable.id, id));
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const versions = await db
    .select()
    .from(skillVersionsTable)
    .where(eq(skillVersionsTable.skillId, id))
    .orderBy(desc(skillVersionsTable.createdAt));

  res.json({ skill, versions });
});

router.post("/skills/import", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing url field" });
    return;
  }

  try {
    const result = await importSkillFromUrl(url);
    res.status(201).json({
      source: result.source,
      skills: result.skills,
      count: result.skills.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    logger.error({ err, url }, "Skill import failed");
    res.status(400).json({ error: message });
  }
});

router.put("/skills/:skillId/review", async (req, res) => {
  const id = parseInt(req.params.skillId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid skill ID" });
    return;
  }

  const { action, reason } = req.body as { action?: string; reason?: string };
  if (!action || !["approve", "reject", "disable"].includes(action)) {
    res.status(400).json({ error: "action must be approve, reject, or disable" });
    return;
  }

  const [skill] = await db.select().from(skillsTable).where(eq(skillsTable.id, id));
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const reviewStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : skill.reviewStatus;
  const enabled = action === "approve" ? true : action === "disable" ? false : skill.enabled;

  const [updated] = await db
    .update(skillsTable)
    .set({ reviewStatus, enabled, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(skillsTable.id, id))
    .returning();

  logger.info({ skillId: id, action, reason }, "Skill review action applied");
  res.json({ skill: updated });
});

router.get("/skill-bundles", async (_req, res) => {
  const bundles = await db.select().from(skillBundlesTable).orderBy(desc(skillBundlesTable.createdAt));
  res.json({ bundles });
});

router.post("/skill-bundles/seed", async (_req, res) => {
  try {
    await seedDefaultBundles();
    const bundles = await db.select().from(skillBundlesTable);
    res.json({ seeded: true, bundles });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Seed failed";
    res.status(500).json({ error: message });
  }
});

router.get("/skill-bundles/:bundleId", async (req, res) => {
  const id = parseInt(req.params.bundleId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid bundle ID" });
    return;
  }

  const [bundle] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, id));
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }

  res.json({ bundle });
});

router.post("/skill-bundles/:bundleId/activate", async (req, res) => {
  const id = parseInt(req.params.bundleId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid bundle ID" });
    return;
  }

  const [bundle] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, id));
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }

  const { sessionId } = req.body as { sessionId?: number };

  if (sessionId) {
    const { sessionsTable } = await import("@workspace/db");
    await db
      .update(sessionsTable)
      .set({ activeBundleId: id, updatedAt: new Date() })
      .where(eq(sessionsTable.id, sessionId));
    logger.info({ bundleId: id, sessionId }, "Bundle set as active for session (next-launch)");
  }

  res.json({
    bundle,
    activationMode: "next-launch",
    message: "Bundle will be activated on the next session launch.",
  });
});

router.post("/skill-bundles", async (req, res) => {
  const { name, slug, skillIds, taskMode, sessionMode, tokenMode } = req.body as {
    name?: string;
    slug?: string;
    skillIds?: string[];
    taskMode?: string;
    sessionMode?: string;
    tokenMode?: string;
  };

  if (!name || !slug || !Array.isArray(skillIds)) {
    res.status(400).json({ error: "name, slug, and skillIds are required" });
    return;
  }

  const existing = await db.select({ id: skillBundlesTable.id }).from(skillBundlesTable).where(eq(skillBundlesTable.slug, slug));
  if (existing.length > 0) {
    res.status(409).json({ error: `Bundle slug "${slug}" already exists` });
    return;
  }

  const [bundle] = await db.insert(skillBundlesTable).values({
    slug,
    name,
    bundleJson: { skillIds } as unknown as Record<string, unknown>,
    taskMode,
    sessionMode,
    tokenMode: (tokenMode || "core"),
    isDefault: false,
  }).returning();

  res.status(201).json({ bundle });
});

router.put("/skill-bundles/:bundleId", async (req, res) => {
  const id = parseInt(req.params.bundleId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid bundle ID" });
    return;
  }

  const [bundle] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, id));
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }

  const { name, skillIds, taskMode, sessionMode, tokenMode } = req.body as {
    name?: string;
    skillIds?: string[];
    taskMode?: string;
    sessionMode?: string;
    tokenMode?: string;
  };

  const updates: Partial<typeof skillBundlesTable.$inferInsert> = { updatedAt: new Date() };
  if (name) updates.name = name;
  if (taskMode) updates.taskMode = taskMode;
  if (sessionMode) updates.sessionMode = sessionMode;
  if (tokenMode) updates.tokenMode = tokenMode;
  if (skillIds) updates.bundleJson = { skillIds } as unknown as Record<string, unknown>;

  const [updated] = await db.update(skillBundlesTable).set(updates).where(eq(skillBundlesTable.id, id)).returning();
  res.json({ bundle: updated });
});

router.get("/sessions/:sessionId/skills", async (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const activations = await db
    .select()
    .from(sessionSkillsTable)
    .where(eq(sessionSkillsTable.sessionId, sessionId))
    .orderBy(desc(sessionSkillsTable.activatedAt));

  res.json({ activations });
});

router.post("/sessions/:sessionId/skills/feedback", async (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const { skillId, helpful, notes, tokenDelta, taskSuccessScore } = req.body as {
    skillId?: number;
    helpful?: boolean;
    notes?: string;
    tokenDelta?: number;
    taskSuccessScore?: number;
  };

  if (skillId === undefined || helpful === undefined) {
    res.status(400).json({ error: "skillId and helpful are required" });
    return;
  }

  const [skill] = await db.select({ id: skillsTable.id }).from(skillsTable).where(eq(skillsTable.id, skillId));
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const [feedback] = await db.insert(skillFeedbackTable).values({
    sessionId,
    skillId,
    helpful: Boolean(helpful),
    notes: notes || null,
    tokenDelta: tokenDelta ?? null,
    taskSuccessScore: taskSuccessScore ?? null,
  }).returning();

  logger.info({ sessionId, skillId, helpful }, "Skill feedback recorded");
  res.status(201).json({ feedback });
});

router.post("/skills/compile-preview", async (req, res) => {
  const { bundleId, taskMode, tokenMode, repoLangs, modelProfile } = req.body as {
    bundleId?: number;
    taskMode?: string;
    tokenMode?: string;
    repoLangs?: string[];
    modelProfile?: string;
  };

  if (!bundleId) {
    res.status(400).json({ error: "bundleId is required" });
    return;
  }

  const ctx: SessionContext = {
    sessionType: "solo",
    taskMode: (taskMode || "build") as SessionContext["taskMode"],
    modelProfile: modelProfile || "kimi",
    repoLangs: repoLangs || [],
    tokenMode: (tokenMode || "core") as SessionContext["tokenMode"],
  };

  try {
    const compiled = await compileBundle(bundleId, ctx);
    const b64 = buildActiveBundleEnvPayload(compiled, ctx.tokenMode);
    res.json({ compiled, activeBundleB64: b64, byteLength: Buffer.from(b64, "base64").length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compile failed";
    res.status(500).json({ error: message });
  }
});

export default router;
