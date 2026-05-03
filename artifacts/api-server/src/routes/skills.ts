import { execFile } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Router } from "express";
import { db, skillsTable, skillBundlesTable, skillSourcesTable, skillVersionsTable, skillFeedbackTable, sessionSkillsTable, sessionsTable, skillEvalsTable, skillDesignCategoriesTable, designIntelligenceEntriesTable } from "@workspace/db";
import { eq, and, desc, or, like, sql, inArray } from "drizzle-orm";
import { importSkillFromUrl } from "../services/skills-import";
import { seedDefaultBundles, compileBundle, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext } from "../services/skills-bundler";
import { DEFAULT_SKILLS } from "../services/default-skills";
import { getSkillFeedbackScores } from "../services/skills-ranker";
import {
  scheduleEvalRun,
  listEvalRuns,
  getEvalRunWithVariants,
  getSkillPerformance,
  getBundlePerformance,
  recordEvalVariant,
  finalizeEvalRun,
  advanceEvalRunStatus,
  processNextQueuedEvalRun,
  TASK_MODE_SCORING_PRESETS,
  DEFAULT_EVAL_BUDGET,
} from "../services/skills-evals";
import { getSkillLeaderboard, getBundleLeaderboard } from "../services/skills-leaderboard";
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

router.get("/skills/leaderboard", async (req, res) => {
  const { limit, taskMode, minConfidence } = req.query as Record<string, string | undefined>;
  try {
    const result = await getSkillLeaderboard({
      limit: limit ? parseInt(limit) : undefined,
      taskMode: taskMode || undefined,
      minConfidence: minConfidence ? parseFloat(minConfidence) : undefined,
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Leaderboard fetch failed";
    logger.error({ err }, "Skill leaderboard error");
    res.status(500).json({ error: message });
  }
});

router.get("/skills/feedback-scores", async (_req, res) => {
  try {
    const scores = await getSkillFeedbackScores();
    res.json({ scores });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load feedback scores";
    logger.error({ err }, "Failed to load skill feedback scores");
    res.status(500).json({ error: message });
  }
});

router.get("/skills/evals", async (req, res) => {
  const { limit, offset, status, runType, taskMode } = req.query as Record<string, string | undefined>;
  try {
    const result = await listEvalRuns({
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
      status: status || undefined,
      runType: runType || undefined,
      taskMode: taskMode || undefined,
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Eval list failed";
    logger.error({ err }, "Eval list error");
    res.status(500).json({ error: message });
  }
});

router.post("/skills/evals/run", async (req, res) => {
  const {
    runType,
    targetSkillId,
    targetBundleId,
    taskMode,
    sessionType,
    tokenMode,
    modelProfile,
    repoKind,
    repoLangs,
    repoCommitSha,
    notes,
    costCapOverrideUsd,
    scoringWeightsOverride,
  } = req.body as {
    runType?: string;
    targetSkillId?: number;
    targetBundleId?: number;
    taskMode?: string;
    sessionType?: string;
    tokenMode?: string;
    modelProfile?: string;
    repoKind?: string;
    repoLangs?: string[];
    repoCommitSha?: string;
    notes?: string;
    costCapOverrideUsd?: number;
    scoringWeightsOverride?: Record<string, number>;
  };

  const VALID_RUN_TYPES = ["baseline", "skill", "bundle", "bundle_variant"] as const;
  if (!runType || !VALID_RUN_TYPES.includes(runType as typeof VALID_RUN_TYPES[number])) {
    res.status(400).json({ error: "runType is required and must be one of: baseline, skill, bundle, bundle_variant" });
    return;
  }

  if (runType === "skill" && !targetSkillId) {
    res.status(400).json({ error: "targetSkillId is required when runType is 'skill'" });
    return;
  }

  if ((runType === "bundle" || runType === "bundle_variant") && !targetBundleId) {
    res.status(400).json({ error: "targetBundleId is required when runType is 'bundle' or 'bundle_variant'" });
    return;
  }

  const VALID_TASK_MODES = ["build", "debug", "review", "refactor", "explore", "team"] as const;
  if (taskMode && !VALID_TASK_MODES.includes(taskMode as typeof VALID_TASK_MODES[number])) {
    res.status(400).json({ error: `taskMode must be one of: ${VALID_TASK_MODES.join(", ")}` });
    return;
  }

  try {
    const run = await scheduleEvalRun({
      runType: runType as "baseline" | "skill" | "bundle" | "bundle_variant",
      targetSkillId: targetSkillId ?? undefined,
      targetBundleId: targetBundleId ?? undefined,
      taskMode: taskMode ?? "build",
      sessionType: sessionType ?? "solo",
      tokenMode: tokenMode ?? "core",
      modelProfile: modelProfile ?? "kimi",
      repoKind: repoKind ?? undefined,
      repoLangs: Array.isArray(repoLangs) ? repoLangs : undefined,
      repoCommitSha: repoCommitSha ?? undefined,
      notes: notes ?? undefined,
      costCapOverrideUsd: costCapOverrideUsd ?? undefined,
      scoringWeightsOverride: scoringWeightsOverride ?? undefined,
    });
    res.status(202).json({ run, message: "Eval run scheduled. Status: queued." });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Eval run scheduling failed";
    logger.error({ err }, "Eval run schedule error");
    const httpStatus = (err as { statusCode?: number }).statusCode
      ?? (message.includes("budget") || message.includes("concurrent") ? 429 : 500);
    res.status(httpStatus).json({ error: message });
  }
});

router.post("/skills/evals/process-next", async (_req, res) => {
  try {
    const result = await processNextQueuedEvalRun();
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Worker execution failed";
    res.status(500).json({ error: message });
  }
});

router.get("/skills/evals/scoring-presets", (_req, res) => {
  res.json({ presets: TASK_MODE_SCORING_PRESETS, budgetConfig: DEFAULT_EVAL_BUDGET });
});

router.get("/skills/evals/:runId", async (req, res) => {
  const runId = parseInt(req.params.runId);
  if (isNaN(runId)) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }
  try {
    const result = await getEvalRunWithVariants(runId);
    if (!result) {
      res.status(404).json({ error: "Eval run not found" });
      return;
    }
    res.json({
      run: result.run,
      variants: result.variants.map(v => {
        const cost = v.costUsd != null ? parseFloat(String(v.costUsd)) : null;
        const score = v.compositeScore != null ? parseFloat(String(v.compositeScore)) : null;
        const costPerUsefulOutcome = cost != null && score != null && score > 0
          ? cost / score
          : null;
        return {
          ...v,
          skillIdsIncluded: Array.isArray(v.skillIdsIncludedJson) ? v.skillIdsIncludedJson : null,
          skillIdsExcluded: Array.isArray(v.skillIdsExcludedJson) ? v.skillIdsExcludedJson : null,
          costPerUsefulOutcome,
        };
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Eval fetch failed";
    res.status(500).json({ error: message });
  }
});

router.post("/skills/evals/:runId/variants", async (req, res) => {
  const runId = parseInt(req.params.runId);
  if (isNaN(runId)) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }

  const { variantType, skillIdsIncluded, skillIdsExcluded, metrics, notes } = req.body as {
    variantType?: string;
    skillIdsIncluded?: string[];
    skillIdsExcluded?: string[];
    metrics?: Record<string, unknown>;
    notes?: string;
  };

  if (!variantType) {
    res.status(400).json({ error: "variantType is required (baseline | treatment | ablated)" });
    return;
  }

  try {
    const result = await getEvalRunWithVariants(runId);
    if (!result) {
      res.status(404).json({ error: "Eval run not found" });
      return;
    }

    const variant = await recordEvalVariant(
      runId,
      {
        variantType: variantType as "baseline" | "treatment" | "ablated",
        skillIdsIncluded: Array.isArray(skillIdsIncluded) ? skillIdsIncluded : undefined,
        skillIdsExcluded: Array.isArray(skillIdsExcluded) ? skillIdsExcluded : undefined,
        metrics: metrics ?? {},
        notes: notes ?? undefined,
      },
      result.run.taskMode
    );

    res.status(201).json({
      ...variant,
      skillIdsIncluded: Array.isArray(variant.skillIdsIncludedJson) ? variant.skillIdsIncludedJson : null,
      skillIdsExcluded: Array.isArray(variant.skillIdsExcludedJson) ? variant.skillIdsExcludedJson : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Variant recording failed";
    res.status(500).json({ error: message });
  }
});

router.post("/skills/evals/:runId/finalize", async (req, res) => {
  const runId = parseInt(req.params.runId);
  if (isNaN(runId)) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }
  try {
    await finalizeEvalRun(runId);
    const result = await getEvalRunWithVariants(runId);
    res.json({ run: result?.run, message: "Eval run finalized and scores applied." });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Finalize failed";
    res.status(500).json({ error: message });
  }
});

router.patch("/skills/evals/:runId/status", async (req, res) => {
  const runId = parseInt(req.params.runId);
  if (isNaN(runId)) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }

  const { status, errorDetails, actualCostUsd } = req.body as {
    status?: string;
    errorDetails?: string;
    actualCostUsd?: number;
  };

  const allowed = ["preparing", "running", "scoring", "completed", "error"] as const;
  if (!status || !allowed.includes(status as typeof allowed[number])) {
    res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
    return;
  }

  try {
    const updated = await advanceEvalRunStatus(
      runId,
      status as typeof allowed[number],
      { errorDetails, actualCostUsd }
    );
    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status update failed";
    const httpStatus = message.includes("yielded") ? 429 : 500;
    res.status(httpStatus).json({ error: message });
  }
});

router.get("/skills/:skillId/feedback", async (req, res) => {
  const id = parseInt(req.params.skillId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid skill ID" });
    return;
  }

  const limitStr = (req.query.limit as string | undefined) ?? "50";
  const offsetStr = (req.query.offset as string | undefined) ?? "0";
  const limit = Math.min(parseInt(limitStr) || 50, 200);
  const offset = parseInt(offsetStr) || 0;

  const [skill] = await db.select({ id: skillsTable.id }).from(skillsTable).where(eq(skillsTable.id, id));
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const [history, [agg]] = await Promise.all([
    db
      .select()
      .from(skillFeedbackTable)
      .where(eq(skillFeedbackTable.skillId, id))
      .orderBy(desc(skillFeedbackTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({
        totalCount: sql<number>`count(*)::int`,
        helpfulCount: sql<number>`sum(case when helpful then 1 else 0 end)::int`,
      })
      .from(skillFeedbackTable)
      .where(eq(skillFeedbackTable.skillId, id)),
  ]);

  const totalAll = agg?.totalCount ?? 0;
  const helpfulAll = agg?.helpfulCount ?? 0;
  const helpfulRate = totalAll > 0 ? helpfulAll / totalAll : 0;

  res.json({
    helpfulRate,
    totalCount: totalAll,
    helpfulCount: helpfulAll,
    unhelpfulCount: totalAll - helpfulAll,
    history,
    pagination: { limit, offset, count: history.length },
  });
});

router.delete("/skills/:skillId/feedback/:feedbackId", async (req, res) => {
  const skillId = parseInt(req.params.skillId);
  const feedbackId = parseInt(req.params.feedbackId);
  if (isNaN(skillId) || isNaN(feedbackId)) {
    res.status(400).json({ error: "Invalid skill ID or feedback ID" });
    return;
  }

  const [existing] = await db
    .select({ id: skillFeedbackTable.id })
    .from(skillFeedbackTable)
    .where(and(eq(skillFeedbackTable.id, feedbackId), eq(skillFeedbackTable.skillId, skillId)));

  if (!existing) {
    res.status(404).json({ error: "Feedback entry not found" });
    return;
  }

  await db.delete(skillFeedbackTable).where(eq(skillFeedbackTable.id, feedbackId));
  logger.info({ skillId, feedbackId }, "Skill feedback entry deleted");
  res.json({ success: true });
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

  const [latestVersion, allCategories, explicitLinks] = await Promise.all([
    db
      .select()
      .from(skillVersionsTable)
      .where(eq(skillVersionsTable.skillId, id))
      .orderBy(desc(skillVersionsTable.createdAt))
      .limit(1),
    db
      .select({ category: designIntelligenceEntriesTable.category })
      .from(designIntelligenceEntriesTable)
      .groupBy(designIntelligenceEntriesTable.category),
    db
      .select({ category: skillDesignCategoriesTable.category })
      .from(skillDesignCategoriesTable)
      .where(eq(skillDesignCategoriesTable.skillId, id)),
  ]);

  const categoryNames = allCategories.map((r) => r.category);
  const explicitCats = new Set(explicitLinks.map((l) => l.category));

  const haystack = `${skill.name} ${skill.description} ${skill.class} ${skill.slug}`.toLowerCase();
  const computedCats = categoryNames.filter((cat) => {
    const keywords = cat.toLowerCase().split(/[-_\s]+/);
    return keywords.some((kw) => kw.length >= 3 && haystack.includes(kw));
  });

  const designCategories = Array.from(new Set([...explicitCats, ...computedCats])).sort();

  res.json({ skill, latestManifest: latestVersion?.manifestJson || null, designCategories });
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

router.get("/skills/:skillId/performance", async (req, res) => {
  const id = parseInt(req.params.skillId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid skill ID" });
    return;
  }
  const [skill] = await db.select({ id: skillsTable.id }).from(skillsTable).where(eq(skillsTable.id, id));
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }
  try {
    const performance = await getSkillPerformance(id);
    res.json(performance);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Performance fetch failed";
    res.status(500).json({ error: message });
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

router.get("/skill-bundles/leaderboard", async (req, res) => {
  const { limit, taskMode, tokenMode, repoKind, modelFamily } = req.query as Record<string, string | undefined>;
  try {
    const result = await getBundleLeaderboard({
      limit: limit ? parseInt(limit) : undefined,
      taskMode: taskMode || undefined,
      tokenMode: tokenMode || undefined,
      repoKind: repoKind || undefined,
      modelFamily: modelFamily || undefined,
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bundle leaderboard failed";
    logger.error({ err }, "Bundle leaderboard error");
    res.status(500).json({ error: message });
  }
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
  const { bundleId, sessionType, taskMode, tokenMode, repoLangs, repoUrl, intentText, modelProfile } = req.body as {
    bundleId?: number;
    sessionType?: string;
    taskMode?: string;
    tokenMode?: string;
    repoLangs?: string[];
    repoUrl?: string;
    intentText?: string;
    modelProfile?: string;
  };
  // intentText is forwarded into the session context as a soft ranking hint.
  // The bundle ranker may use it (alongside taskMode/repoLangs) to bias
  // selection toward bundles/skills that match the user's stated goal.
  const trimmedIntent = typeof intentText === "string" ? intentText.trim().slice(0, 500) : "";

  const ctx: SessionContext = {
    sessionType: (sessionType || "solo") as SessionContext["sessionType"],
    taskMode: (taskMode || "build") as SessionContext["taskMode"],
    modelProfile: modelProfile || "kimi",
    repoLangs: repoLangs || [],
    tokenMode: (tokenMode || "core") as SessionContext["tokenMode"],
    intentText: trimmedIntent || undefined,
  };

  try {
    // Auto-select default bundle from context if none specified
    let resolvedBundleId = bundleId;
    if (!resolvedBundleId) {
      // hasRepoContext=true when repoLangs were supplied, or when repoUrl is provided
      const hasRepoCtx = (Array.isArray(repoLangs) && repoLangs.length > 0) || !!repoUrl;
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

router.get("/skill-bundles/:bundleId/performance", async (req, res) => {
  const id = parseInt(req.params.bundleId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid bundle ID" });
    return;
  }
  const [bundle] = await db.select({ id: skillBundlesTable.id }).from(skillBundlesTable).where(eq(skillBundlesTable.id, id));
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }
  try {
    const performance = await getBundlePerformance(id);
    res.json(performance);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Performance fetch failed";
    res.status(500).json({ error: message });
  }
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

      // Track activation counts in skill_evals for each activated skill.
      const activatedSkillSlugs = (compiled.skills ?? [])
        .map((s: { id?: string }) => s.id)
        .filter((slug): slug is string => typeof slug === "string");
      if (activatedSkillSlugs.length > 0) {
        const resolvedSkills = await db
          .select({ id: skillsTable.id })
          .from(skillsTable)
          .where(inArray(skillsTable.slug, activatedSkillSlugs));
        await Promise.all(
          resolvedSkills.map(skill =>
            db.insert(skillEvalsTable)
              .values({ skillId: skill.id, activationCount: 1 })
              .onConflictDoUpdate({
                target: [skillEvalsTable.skillId],
                set: { activationCount: sql`skill_evals.activation_count + 1`, updatedAt: new Date() },
              })
              .catch(() => {})
          )
        );
      }

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

  const { skillId: rawSkillId, manifestId, helpful, notes, tokenDelta, taskSuccessScore } = req.body as {
    skillId?: number | null;
    manifestId?: string | null;
    helpful?: boolean;
    notes?: string;
    tokenDelta?: number;
    taskSuccessScore?: number;
  };

  if (helpful === undefined) {
    res.status(400).json({ error: "helpful is required" });
    return;
  }
  if (!rawSkillId && !manifestId) {
    res.status(400).json({ error: "Either skillId or manifestId is required" });
    return;
  }

  let skill: { id: number } | undefined;
  if (rawSkillId) {
    [skill] = await db.select({ id: skillsTable.id }).from(skillsTable).where(eq(skillsTable.id, rawSkillId));
  } else if (manifestId) {
    // Match both native slug (slug === manifestId) and imported slug (imported-{src}-{manifestId}).
    // Order by id DESC so native or most-recently-imported skill wins when multiple rows match.
    [skill] = await db.select({ id: skillsTable.id }).from(skillsTable)
      .where(or(eq(skillsTable.slug, manifestId), like(skillsTable.slug, `imported-%-${manifestId}`)))
      .orderBy(desc(skillsTable.id))
      .limit(1);
  }
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }
  const skillId = skill.id;

  // Upsert: if feedback already exists for this session+skill, update it so users can
  // revise their rating. The unique constraint on (session_id, skill_id) enforces one
  // record per combination; onConflictDoUpdate replaces the stale values.
  const [feedback] = await db.insert(skillFeedbackTable).values({
    sessionId,
    skillId,
    helpful: Boolean(helpful),
    notes: notes || null,
    tokenDelta: tokenDelta ?? null,
    taskSuccessScore: taskSuccessScore ?? null,
  })
  .onConflictDoUpdate({
    target: [skillFeedbackTable.sessionId, skillFeedbackTable.skillId],
    set: {
      helpful: Boolean(helpful),
      notes: notes || null,
      tokenDelta: tokenDelta ?? null,
      taskSuccessScore: taskSuccessScore ?? null,
    },
  })
  .returning();

  logger.info({ sessionId, skillId, helpful }, "Skill feedback recorded");
  res.status(201).json({ feedback });
});

/**
 * Record implicit feedback signals on session completion.
 * Uses routing stats (bytesAvoided) as a proxy signal for context-shield-core effectiveness,
 * and per-skill implicit signals for all skills active in the session.
 */
router.post("/sessions/:sessionId/skills/complete-feedback", async (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const rawBody = req.body as {
    bytesAvoided?: unknown;
    taskSuccessScore?: unknown;
  };

  // Validate bytesAvoided: must be a finite, non-negative integer when provided
  const rawBytesAvoided = Number(rawBody.bytesAvoided ?? 0);
  const bytesAvoided = Number.isFinite(rawBytesAvoided) && rawBytesAvoided >= 0
    ? Math.trunc(rawBytesAvoided)
    : 0;

  // Validate taskSuccessScore: must be an integer 1–5 when provided
  let taskSuccessScore: number | undefined;
  if (rawBody.taskSuccessScore !== undefined && rawBody.taskSuccessScore !== null) {
    const rawScore = Number(rawBody.taskSuccessScore);
    if (Number.isFinite(rawScore) && Number.isInteger(rawScore) && rawScore >= 1 && rawScore <= 5) {
      taskSuccessScore = rawScore;
    } else {
      res.status(400).json({ error: "taskSuccessScore must be an integer between 1 and 5" });
      return;
    }
  }

  // Find the most recent session_skills activation to know which skills were active
  const [latestActivation] = await db
    .select({ activatedSkillsJson: sessionSkillsTable.activatedSkillsJson })
    .from(sessionSkillsTable)
    .where(eq(sessionSkillsTable.sessionId, sessionId))
    .orderBy(desc(sessionSkillsTable.activatedAt))
    .limit(1);

  if (!latestActivation) {
    res.status(404).json({ error: "No skill activation found for this session" });
    return;
  }

  const activeManifests = (latestActivation.activatedSkillsJson as Array<{ id: string }>) || [];
  const recorded: Array<{ skillSlug: string; helpful: boolean; signal: string }> = [];

  for (const manifest of activeManifests) {
    if (!manifest.id) continue;

    // Determine implicit signal for this skill.
    // Only record a signal when we have real data — no signal is better than a wrong signal.
    let helpful = true;
    let notes: string | null = null;

    // context-shield-core gets a signal based on bytesAvoided, but only when we have
    // a non-trivial measurement (>0). Without routing stats we skip this skill entirely
    // to avoid poisoning the score with a false negative.
    if (manifest.id === "context-shield-core") {
      if (!bytesAvoided || bytesAvoided <= 0) {
        // No routing data available — skip to avoid recording a misleading negative signal
        continue;
      }
      helpful = bytesAvoided > 1000;
      notes = `implicit signal: bytesAvoided=${bytesAvoided}`;
    } else if (taskSuccessScore !== undefined) {
      // Other skills get a signal based on overall task success
      helpful = taskSuccessScore >= 3;
      notes = `implicit signal: taskSuccessScore=${taskSuccessScore}`;
    } else {
      // No signal for other skills without explicit task success
      continue;
    }

    // Look up the skill DB id by manifest.id.
    // For native skills: slug === manifest.id (direct match).
    // For imported skills: slug = "imported-{sourceId}-{manifestId}" (LIKE match on tail).
    // Order by id DESC to deterministically pick the most-recently-imported skill
    // if multiple rows match (e.g., same manifest imported from two sources).
    const [skill] = await db
      .select({ id: skillsTable.id })
      .from(skillsTable)
      .where(or(
        eq(skillsTable.slug, manifest.id),
        like(skillsTable.slug, `imported-%-${manifest.id}`),
      ))
      .orderBy(desc(skillsTable.id))
      .limit(1);

    if (!skill) continue;

    // Atomic idempotency: onConflictDoNothing on the (session_id, skill_id) unique index
    // prevents duplicate rows even under concurrent calls, without a read-then-write race.
    const [inserted] = await db.insert(skillFeedbackTable).values({
      sessionId,
      skillId: skill.id,
      helpful,
      notes,
      tokenDelta: manifest.id === "context-shield-core" ? -Math.floor(bytesAvoided / 4) : null,
      taskSuccessScore: taskSuccessScore ?? null,
    })
    .onConflictDoNothing({ target: [skillFeedbackTable.sessionId, skillFeedbackTable.skillId] })
    .returning();

    // Only record in response if a row was actually inserted (not skipped due to conflict)
    if (inserted) recorded.push({ skillSlug: manifest.id, helpful, signal: notes ?? "implicit" });
  }

  logger.info({ sessionId, bytesAvoided, taskSuccessScore, recordedCount: recorded.length }, "Implicit skill feedback recorded on session completion");
  res.status(201).json({ recorded });
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
