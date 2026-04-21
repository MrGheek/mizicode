import { execFile } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Router } from "express";
import { db, skillsTable, skillBundlesTable, skillSourcesTable, skillVersionsTable, skillFeedbackTable, sessionSkillsTable, sessionsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { importSkillFromUrl } from "../services/skills-import";
import { seedDefaultBundles, compileBundle, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext } from "../services/skills-bundler";
import { DEFAULT_SKILLS } from "../services/default-skills";
import { logger } from "../lib/logger";
import type { SessionContext } from "../services/skills-types";

const router = Router();

/** Validates that a string is a safe hostname or IPv4 address (no shell-special chars). */
function isSafeHost(host: string): boolean {
  return /^[a-zA-Z0-9._-]{1,253}$/.test(host);
}

/**
 * Best-effort: write active-bundle.json to a running instance via SSH.
 * This is an internal implementation detail — callers always return next-launch
 * semantics regardless of whether this succeeds.
 */
async function tryWriteActiveBundleViaSSH(
  sshHost: string,
  sshPort: number,
  payload: string,
): Promise<void> {
  const privateKey = process.env["FLOATR_SSH_PRIVATE_KEY"];
  if (!privateKey) return; // SSH key not configured — skip

  // Validate host and port strictly before invoking ssh
  if (!isSafeHost(sshHost)) {
    logger.warn({ sshHost }, "SSH write skipped: unsafe host value");
    return;
  }
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    logger.warn({ sshPort }, "SSH write skipped: invalid port");
    return;
  }

  const keyFile = join(tmpdir(), `floatr-ssh-${Date.now()}.pem`);
  await writeFile(keyFile, privateKey, { mode: 0o600 });

  const remoteDir = "/workspace/.floatr/skills";
  const remoteFile = `${remoteDir}/active-bundle.json`;
  // Write payload via stdin to avoid any shell-level interpolation of the JSON content
  const remoteCmd = `mkdir -p ${remoteDir} && cat > ${remoteFile}`;

  // Use execFile (no shell) with explicit argument array to prevent injection
  const sshArgs = [
    "-i", keyFile,
    "-p", String(sshPort),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=5",
    `root@${sshHost}`,
    remoteCmd,
  ];

  await new Promise<void>((resolve) => {
    const child = execFile("ssh", sshArgs, { timeout: 8000 }, async (err) => {
      await unlink(keyFile).catch(() => {});
      if (err) {
        logger.warn({ sshHost, sshPort, errMsg: err.message }, "SSH active-bundle.json write failed (instance may be starting)");
      } else {
        logger.info({ sshHost, sshPort }, "SSH active-bundle.json write succeeded");
      }
      resolve();
    });
    // Pipe payload to stdin so JSON never touches the command line
    child.stdin?.end(payload, "utf8");
  });
}

const NOT_IMPLEMENTED = (feature: string) => ({
  error: "not implemented",
  feature,
  availableIn: "Phase 4",
});

router.get("/skills", async (req, res) => {
  const { class: classFilter, trustTier, reviewStatus, limit: limitStr, offset: offsetStr } = req.query as {
    class?: string;
    trustTier?: string;
    reviewStatus?: string;
    limit?: string;
    offset?: string;
  };

  const limit = Math.min(parseInt(limitStr || "50") || 50, 200);
  const offset = parseInt(offsetStr || "0") || 0;

  let query = db.select().from(skillsTable).$dynamic();

  const filters = [];
  if (classFilter) filters.push(eq(skillsTable.class, classFilter));
  if (trustTier) filters.push(eq(skillsTable.trustTier, trustTier));
  if (reviewStatus) filters.push(eq(skillsTable.reviewStatus, reviewStatus));
  if (filters.length) {
    query = query.where(and(...filters));
  }

  const skills = await query.orderBy(desc(skillsTable.createdAt)).limit(limit).offset(offset);

  res.json({
    skills,
    builtins: DEFAULT_SKILLS.map(s => ({ id: s.id, name: s.name, class: s.class, summary: s.summary })),
    pagination: { limit, offset, count: skills.length },
  });
});

router.post("/skills/discover", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED("skill discovery"));
});

router.get("/skills/leaderboard", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED("skill leaderboard"));
});

router.get("/skills/evals", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED("skill evals listing"));
});

router.post("/skills/evals/run", (_req, res) => {
  res.status(501).json(NOT_IMPLEMENTED("skill eval runner"));
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

  // Return only the latest version manifest
  const [latestVersion] = await db
    .select()
    .from(skillVersionsTable)
    .where(eq(skillVersionsTable.skillId, id))
    .orderBy(desc(skillVersionsTable.createdAt))
    .limit(1);

  res.json({ skill, latestManifest: latestVersion?.manifestJson || null });
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

router.post("/skills/:skillId/review", async (req, res) => {
  const id = parseInt(req.params.skillId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid skill ID" });
    return;
  }

  const { approved, reason } = req.body as { approved?: boolean; reason?: string };
  if (typeof approved !== "boolean") {
    res.status(400).json({ error: "approved (boolean) is required" });
    return;
  }

  const [skill] = await db.select().from(skillsTable).where(eq(skillsTable.id, id));
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const reviewStatus = approved ? "approved" : "rejected";
  const enabled = approved;

  const [updated] = await db
    .update(skillsTable)
    .set({ reviewStatus, enabled, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(skillsTable.id, id))
    .returning();

  logger.info({ skillId: id, approved, reason }, "Skill review action applied");
  res.json({ skill: updated });
});

router.post("/skills/:skillId/enable", async (req, res) => {
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

  // Review is the single gate: must be approved before enabling
  if (skill.reviewStatus !== "approved") {
    res.status(403).json({ error: "Skill must be approved before it can be enabled. Use POST /skills/:id/review first." });
    return;
  }

  const [updated] = await db
    .update(skillsTable)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(skillsTable.id, id))
    .returning();

  logger.info({ skillId: id }, "Skill enabled");
  res.json({ skill: updated });
});

router.post("/skills/:skillId/disable", async (req, res) => {
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

  const [updated] = await db
    .update(skillsTable)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(skillsTable.id, id))
    .returning();

  logger.info({ skillId: id }, "Skill disabled");
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

router.post("/skill-bundles/compile", async (req, res) => {
  const { bundleId, sessionType, taskMode, tokenMode, repoLangs, modelProfile } = req.body as {
    bundleId?: number;
    sessionType?: string;
    taskMode?: string;
    tokenMode?: string;
    repoLangs?: string[];
    modelProfile?: string;
  };

  const ctx: SessionContext = {
    sessionType: (sessionType || "solo") as SessionContext["sessionType"],
    taskMode: (taskMode || "build") as SessionContext["taskMode"],
    modelProfile: modelProfile || "kimi",
    repoLangs: repoLangs || [],
    tokenMode: (tokenMode || "core") as SessionContext["tokenMode"],
  };

  try {
    // Auto-select default bundle from context if none specified
    let resolvedBundleId = bundleId;
    if (!resolvedBundleId) {
      // hasRepoContext=true when repoLangs were supplied, enabling context-scored selection
      const hasRepoCtx = Array.isArray(repoLangs) && repoLangs.length > 0;
      const defaultBundle = await getDefaultBundleForContext(ctx, hasRepoCtx);
      if (!defaultBundle) {
        res.status(400).json({ error: "No bundle found for provided context" });
        return;
      }
      resolvedBundleId = defaultBundle.id;
    }

    const compiled = await compileBundle(resolvedBundleId, ctx);
    // Return compiled bundle shape directly (not the b64-encoded payload)
    res.json({
      bundleId: compiled.bundleId,
      slug: compiled.slug,
      name: compiled.name,
      skills: compiled.skills,
      reasoning: compiled.reasoning,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compile failed";
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

  const { sessionId, taskMode, tokenMode } = req.body as { sessionId?: number; taskMode?: string; tokenMode?: string };
  let sessionSkillsRecord: (typeof sessionSkillsTable.$inferSelect) | null = null;

  if (sessionId) {
    await db
      .update(sessionsTable)
      .set({ activeBundleId: id, updatedAt: new Date() })
      .where(eq(sessionsTable.id, sessionId));

    // Compile bundle and record session_skills for next-launch
    try {
      const [session] = await db
        .select({ status: sessionsTable.status, sshHost: sessionsTable.sshHost, sshPort: sessionsTable.sshPort, tokenMode: sessionsTable.tokenMode, teamMembers: sessionsTable.teamMembers, taskMode: sessionsTable.taskMode })
        .from(sessionsTable)
        .where(eq(sessionsTable.id, sessionId));

      const effectiveTokenMode = (tokenMode || session?.tokenMode || bundle.tokenMode || "core") as SessionContext["tokenMode"];
      // Derive sessionType from the session row: if teamMembers array is non-empty → team, else solo
      const derivedSessionType = Array.isArray(session?.teamMembers) && (session.teamMembers as unknown[]).length > 0 ? "team" : "solo";
      const ctx: SessionContext = {
        sessionType: derivedSessionType,
        taskMode: (taskMode || session?.taskMode || bundle.taskMode || "build") as SessionContext["taskMode"],
        modelProfile: "kimi",
        repoLangs: [],
        tokenMode: effectiveTokenMode,
      };
      const compiled = await compileBundle(id, ctx);
      const [record] = await db.insert(sessionSkillsTable).values({
        sessionId,
        bundleId: id,
        activatedSkillsJson: compiled.skills as unknown as Record<string, unknown>[],
        rationaleJson: compiled.reasoning as unknown as Record<string, unknown>,
        tokenMode: ctx.tokenMode,
        activationMode: "next-launch",
      }).returning();
      sessionSkillsRecord = record;

      // Best-effort SSH pre-write when instance is already running.
      // This is a silent optimisation — the API contract always returns next-launch.
      if (session?.status === "running" && session.sshHost && session.sshPort) {
        const b64 = buildActiveBundleEnvPayload(compiled, effectiveTokenMode);
        const payload = Buffer.from(b64, "base64").toString("utf8");
        tryWriteActiveBundleViaSSH(session.sshHost, session.sshPort, payload).catch(() => {});
      }
    } catch (err) {
      logger.warn({ err, sessionId, bundleId: id }, "Could not compile bundle for session_skills during activate");
    }

    logger.info({ bundleId: id, sessionId }, "Bundle queued for next-launch activation");
  }

  // v1 contract: always next-launch semantics (SSH write is a silent pre-write, not contract-visible)
  res.json({
    bundle,
    sessionSkills: sessionSkillsRecord,
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

  // Fetch the latest activation's bundle details if available
  const latest = activations[0] || null;
  let activeBundle: (typeof skillBundlesTable.$inferSelect) | null = null;
  if (latest?.bundleId) {
    const [bundle] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, latest.bundleId));
    activeBundle = bundle || null;
  }

  // Active skill manifests from the latest activation
  const activeManifests = (latest?.activatedSkillsJson as unknown as Array<{ id: string }>) || [];

  res.json({ activations, activeBundle, activeManifests });
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
