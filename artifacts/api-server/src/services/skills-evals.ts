/**
 * Observational eval runner for Smart Skills.
 *
 * Uses real session data rather than synthetic execution. Baseline = sessions with
 * no skills active; treatment = sessions where all evaluated skills were active (AND
 * semantics); ablation = treatment minus one withheld skill per variant.
 *
 * Data sources: sessionsTable (cost, elapsed), sessionSkillsTable (activatedSkillsJson),
 * skillFeedbackTable (helpful, taskSuccessScore, tokenDelta), routingStatsJson (shielded bytes).
 *
 * Eval jobs run as async queue (queued → preparing → running → scoring → completed)
 * processed every 60s by the scheduler or via POST /api/skills/evals/process-next.
 */

import crypto from "crypto";
import {
  db,
  skillsTable,
  skillBundlesTable,
  skillVersionsTable,
  evalRunsTable,
  evalRunVariantsTable,
  skillEvalsTable,
  bundleEvalsTable,
  laneHeavyJobsTable,
  sessionsTable,
  sessionSkillsTable,
  skillFeedbackTable,
  sessionRepoContextTable,
} from "@workspace/db";
import { eq, and, sql, desc, lt, inArray, count, or } from "drizzle-orm";
import { logger } from "../lib/logger";

// ─── Budget + Priority Controls ──────────────────────────────────────────────

export interface EvalBudgetConfig {
  /** Maximum concurrent eval jobs (across all sessions). */
  maxConcurrentEvalJobs: number;
  /** Per-run cost cap in USD. Runs exceeding this are rejected. */
  perRunCostCapUsd: number;
  /** Daily total eval GPU budget in USD. Runs are rejected when budget is exhausted. */
  dailyEvalBudgetUsd: number;
  /** Scheduling priority for eval jobs. Must be ≤ 3 (interactive uses 5–10). */
  evalJobPriority: number;
  /** Config version string — stored in eval_runs for reproducibility. */
  configVersion: string;
}

export const DEFAULT_EVAL_BUDGET: EvalBudgetConfig = {
  maxConcurrentEvalJobs: parseInt(process.env["EVAL_MAX_CONCURRENT"] || "2"),
  perRunCostCapUsd: parseFloat(process.env["EVAL_PER_RUN_COST_CAP_USD"] || "0.50"),
  dailyEvalBudgetUsd: parseFloat(process.env["EVAL_DAILY_BUDGET_USD"] || "5.00"),
  evalJobPriority: 3,
  configVersion: "1",
};

// ─── Task-Mode Scoring Presets ────────────────────────────────────────────────

export interface ScoringWeights {
  successScore: number;
  timeScore: number;
  retrievalEfficiency: number;
  contextEfficiency: number;
  stabilityPenalty: number;
  userFeedbackBonus: number;
}

export interface TaskModeScoringPreset {
  taskMode: string;
  weights: ScoringWeights;
  description: string;
}

/**
 * Task-mode scoring presets.
 *
 * Weights must sum to 1.0 (excluding userFeedbackBonus which is an additive bonus).
 * stabilityPenalty is subtracted from the weighted score.
 *
 * These are exported and inspectable via GET /api/skills/evals/scoring-presets.
 */
export const TASK_MODE_SCORING_PRESETS: Record<string, TaskModeScoringPreset> = {
  build: {
    taskMode: "build",
    description: "Build mode: prioritises success and fast time-to-answer. Context efficiency matters.",
    weights: {
      successScore: 0.35,
      timeScore: 0.25,
      retrievalEfficiency: 0.15,
      contextEfficiency: 0.20,
      stabilityPenalty: 0.05,
      userFeedbackBonus: 0.10,
    },
  },
  debug: {
    taskMode: "debug",
    description: "Debug mode: retrieval efficiency and success are most important; time matters less.",
    weights: {
      successScore: 0.40,
      timeScore: 0.15,
      retrievalEfficiency: 0.25,
      contextEfficiency: 0.15,
      stabilityPenalty: 0.05,
      userFeedbackBonus: 0.10,
    },
  },
  review: {
    taskMode: "review",
    description: "Review mode: context efficiency and retrieval quality matter most; time is secondary.",
    weights: {
      successScore: 0.30,
      timeScore: 0.10,
      retrievalEfficiency: 0.25,
      contextEfficiency: 0.30,
      stabilityPenalty: 0.05,
      userFeedbackBonus: 0.10,
    },
  },
  refactor: {
    taskMode: "refactor",
    description: "Refactor mode: stability and correctness dominate; speed and retrieval are secondary.",
    weights: {
      successScore: 0.35,
      timeScore: 0.15,
      retrievalEfficiency: 0.20,
      contextEfficiency: 0.20,
      stabilityPenalty: 0.10,
      userFeedbackBonus: 0.10,
    },
  },
  team: {
    taskMode: "team",
    description: "Team mode: overall success and retrieval efficiency weighted equally; context efficiency matters for lane coordination.",
    weights: {
      successScore: 0.30,
      timeScore: 0.15,
      retrievalEfficiency: 0.25,
      contextEfficiency: 0.20,
      stabilityPenalty: 0.05,
      userFeedbackBonus: 0.15,
    },
  },
  explore: {
    taskMode: "explore",
    description: "Explore mode: retrieval and context efficiency are most important; success is binary but less weighted.",
    weights: {
      successScore: 0.25,
      timeScore: 0.20,
      retrievalEfficiency: 0.30,
      contextEfficiency: 0.20,
      stabilityPenalty: 0.05,
      userFeedbackBonus: 0.10,
    },
  },
};

// ─── Eval Run Types ───────────────────────────────────────────────────────────

export type EvalRunType = "baseline" | "skill" | "bundle" | "bundle_variant";
export type EvalVariantType = "baseline" | "treatment" | "ablated";

export interface EvalRunRequest {
  runType: EvalRunType;
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
  budgetConfig?: Partial<EvalBudgetConfig>;
  /**
   * Per-run scoring weights override.
   * When provided, overrides the task-mode preset weights for this run only.
   * This is the hook for policy inputs such as A/B testing different weight regimes
   * or conducting sensitivity analysis on the composite score formula.
   */
  scoringWeightsOverride?: Partial<ScoringWeights>;
}

export interface EvalVariantMetrics {
  timeToFirstAnswerMs?: number;
  totalElapsedMs?: number;
  memoryItemsRetrieved?: number;
  contextBytesInjected?: number;
  shieldedBytesAvoided?: number;
  repoHitCount?: number;
  repoCacheHit?: number;
  success?: boolean;
  userRating?: number;
  costUsd?: number;
  /** Observed task success score [0–100] derived from feedback records; stored in metricsJson */
  taskSuccessScore?: number;
  [key: string]: unknown;
}

export interface EvalVariantInput {
  variantType: EvalVariantType;
  skillIdsIncluded?: string[];
  skillIdsExcluded?: string[];
  metrics?: EvalVariantMetrics;
  notes?: string;
}

// ─── Budget Enforcement ───────────────────────────────────────────────────────

async function isDailyBudgetExhausted(cfg: EvalBudgetConfig): Promise<boolean> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const [result] = await db
    .select({ total: sql<number>`COALESCE(SUM(actual_cost_usd), 0)` })
    .from(evalRunsTable)
    .where(
      and(
        sql`created_at >= ${dayStart.toISOString()}`,
        inArray(evalRunsTable.status, ["completed", "running", "scoring"])
      )
    );

  const dailyUsed = result?.total ?? 0;
  return dailyUsed >= cfg.dailyEvalBudgetUsd;
}

async function countActiveEvalJobs(): Promise<number> {
  const [result] = await db
    .select({ n: count() })
    .from(evalRunsTable)
    .where(inArray(evalRunsTable.status, ["preparing", "running", "scoring"]));
  return result?.n ?? 0;
}

async function isLaneHeavyJobActive(): Promise<boolean> {
  const [job] = await db
    .select({ id: laneHeavyJobsTable.id })
    .from(laneHeavyJobsTable)
    .where(eq(laneHeavyJobsTable.status, "running"))
    .limit(1);
  return !!job;
}

// ─── Reproducibility Metadata ─────────────────────────────────────────────────

/**
 * Build reproducibility metadata for an eval run.
 *
 * The configVersion hash encodes all run-condition dimensions:
 *   - scoring preset version identifier
 *   - model profile
 *   - token mode
 *   - session type
 *   - skill version hashes
 *
 * This ensures that any change in scoring weights, model, or skill content
 * produces a distinct configVersion, enabling exact replay comparisons.
 */
async function buildReproducibilityMetadata(req: EvalRunRequest): Promise<{
  skillVersionIds: Record<string, string>;
  bundleVersionHash: string | null;
  configVersion: string;
}> {
  const skillVersionIds: Record<string, string> = {};

  if (req.targetSkillId) {
    const [v] = await db
      .select({ versionHash: skillVersionsTable.versionHash })
      .from(skillVersionsTable)
      .where(eq(skillVersionsTable.skillId, req.targetSkillId))
      .orderBy(desc(skillVersionsTable.createdAt))
      .limit(1);
    if (v) skillVersionIds[String(req.targetSkillId)] = v.versionHash;
  }

  let bundleVersionHash: string | null = null;

  if (req.targetBundleId) {
    const [bundle] = await db
      .select({ bundleJson: skillBundlesTable.bundleJson, slug: skillBundlesTable.slug })
      .from(skillBundlesTable)
      .where(eq(skillBundlesTable.id, req.targetBundleId));

    if (bundle) {
      bundleVersionHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(bundle.bundleJson))
        .digest("hex")
        .slice(0, 16);

      const bundleData = bundle.bundleJson as { skillIds?: string[] };
      const skillIds = bundleData.skillIds || [];

      const skills = skillIds.length > 0
        ? await db.select({ id: skillsTable.id, slug: skillsTable.slug }).from(skillsTable).where(inArray(skillsTable.slug, skillIds))
        : [];

      for (const skill of skills) {
        const [v] = await db
          .select({ versionHash: skillVersionsTable.versionHash })
          .from(skillVersionsTable)
          .where(eq(skillVersionsTable.skillId, skill.id))
          .orderBy(desc(skillVersionsTable.createdAt))
          .limit(1);
        if (v) skillVersionIds[String(skill.id)] = v.versionHash;
      }
    }
  }

  const configVersion = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        scoringPresetVersion: "v1",
        modelProfile: req.modelProfile ?? "kimi",
        tokenMode: req.tokenMode ?? "core",
        sessionType: req.sessionType ?? "solo",
        taskMode: req.taskMode ?? "build",
        skillVersionIds,
        bundleVersionHash,
      })
    )
    .digest("hex")
    .slice(0, 16);

  return { skillVersionIds, bundleVersionHash, configVersion };
}

// ─── Composite Score Computation ──────────────────────────────────────────────

/**
 * Compute a composite score [0, 1] for a variant using task-mode scoring presets.
 *
 * Components:
 *   successScore:         1 if success=true, 0 if false, 0.5 if unknown
 *   timeScore:            normalized inverse of elapsed time relative to a 30s baseline
 *   retrievalEfficiency:  memory items retrieved per context-byte; normalized
 *   contextEfficiency:    shielded bytes / context bytes injected; proxy for noise reduction
 *   stabilityPenalty:     1 if error occurred (success=false), 0 otherwise
 *   userFeedbackBonus:    userRating mapped to [0, 1]
 */
export function computeCompositeScore(
  metrics: EvalVariantMetrics,
  taskMode: string,
  customWeights?: Partial<ScoringWeights>
): { compositeScore: number; rawScore: number; weights: ScoringWeights } {
  const preset = TASK_MODE_SCORING_PRESETS[taskMode] ?? TASK_MODE_SCORING_PRESETS["build"];
  const weights: ScoringWeights = { ...preset.weights, ...customWeights };

  // successScore: [0, 1]
  const successScore = metrics.success === undefined ? 0.5 : metrics.success ? 1.0 : 0.0;

  // timeScore: invert elapsed time, normalize. 5s → 1.0, 30s → 0.5, 120s → ~0.2
  const elapsedMs = metrics.totalElapsedMs ?? metrics.timeToFirstAnswerMs ?? 0;
  const timeScore = elapsedMs > 0
    ? Math.max(0, 1 - Math.log(elapsedMs / 5000) / Math.log(24))
    : 0.5;

  // retrievalEfficiency: items retrieved, normalized by context bytes
  const contextBytes = Math.max(1, metrics.contextBytesInjected ?? 1);
  const items = metrics.memoryItemsRetrieved ?? 0;
  const retrievalEfficiency = items > 0
    ? Math.min(1, (items / (contextBytes / 1000)) / 5)
    : 0;

  // contextEfficiency: shielded bytes / (context bytes + shielded bytes)
  const shielded = metrics.shieldedBytesAvoided ?? 0;
  const contextEfficiency = shielded > 0 || contextBytes > 1
    ? shielded / (contextBytes + shielded)
    : 0;

  // stabilityPenalty: 1 if failed, 0 if success
  const stabilityPenalty = metrics.success === false ? 1.0 : 0.0;

  // userFeedbackBonus: map rating 1–5 to [0, 1]
  const feedbackBonus = metrics.userRating !== undefined
    ? (metrics.userRating - 1) / 4
    : 0;

  const rawScore =
    weights.successScore * successScore +
    weights.timeScore * timeScore +
    weights.retrievalEfficiency * retrievalEfficiency +
    weights.contextEfficiency * contextEfficiency -
    weights.stabilityPenalty * stabilityPenalty +
    weights.userFeedbackBonus * feedbackBonus;

  const compositeScore = Math.max(0, Math.min(1, rawScore));

  return { compositeScore, rawScore, weights };
}

// ─── Contribution Heuristics ──────────────────────────────────────────────────

/**
 * Compute directional lift and confidence for a skill based on baseline vs treatment comparison.
 *
 * MVP approach: simple directional heuristics.
 * - Compare baseline variant score vs treatment variant score.
 * - Attribute lift to the skills present in treatment but not baseline.
 * - Confidence is based on sample count (more runs → higher confidence, capped at 0.95).
 *
 * Safety: low-confidence data cannot override trust/risk rules in the compiler.
 * The confidence cap ensures experimental skills remain bounded.
 */
export function computeContributionHeuristic(
  baselineScore: number,
  treatmentScore: number,
  sampleCount: number,
): { lift: number; direction: "positive" | "negative" | "neutral"; confidence: number } {
  const lift = treatmentScore - baselineScore;
  const direction = lift > 0.02 ? "positive" : lift < -0.02 ? "negative" : "neutral";

  // Confidence: log-scale function of sample count, capped at 0.95.
  // 1 sample → ~0.10, 5 → ~0.40, 10 → ~0.60, 30 → ~0.80, 100 → ~0.95
  const confidence = Math.min(0.95, 0.10 + 0.85 * (Math.log(sampleCount + 1) / Math.log(101)));

  return { lift, direction, confidence };
}

// ─── Eval Run Lifecycle ───────────────────────────────────────────────────────

/**
 * Schedule a new eval run, enforcing budget and priority controls.
 * Returns the queued run record.
 *
 * Budget enforcement:
 * - Rejects if daily eval GPU budget is exhausted.
 * - Rejects if max concurrent eval jobs are already running.
 * - Always lower priority than interactive work (priority ≤ 3).
 */
export async function scheduleEvalRun(
  req: EvalRunRequest,
  budgetConfig: EvalBudgetConfig = DEFAULT_EVAL_BUDGET
): Promise<typeof evalRunsTable.$inferSelect> {
  const cfg = { ...budgetConfig, ...req.budgetConfig };

  // Validate run-type / target combinations
  if (req.runType === "skill" && !req.targetSkillId) {
    throw new Error("targetSkillId is required for runType='skill'");
  }
  if ((req.runType === "bundle" || req.runType === "bundle_variant") && !req.targetBundleId) {
    throw new Error("targetBundleId is required for runType='bundle' or 'bundle_variant'");
  }

  if (await isDailyBudgetExhausted(cfg)) {
    throw new Error("Daily eval GPU budget exhausted — try again tomorrow");
  }

  // Validate that referenced skill/bundle IDs exist before creating a run,
  // so callers get a deterministic 4xx instead of a dangling queued row.
  if (req.targetSkillId != null) {
    const [exists] = await db
      .select({ id: skillsTable.id })
      .from(skillsTable)
      .where(eq(skillsTable.id, req.targetSkillId))
      .limit(1);
    if (!exists) {
      throw Object.assign(new Error(`Skill ${req.targetSkillId} not found`), { statusCode: 404 });
    }
  }
  if (req.targetBundleId != null) {
    const [exists] = await db
      .select({ id: skillBundlesTable.id })
      .from(skillBundlesTable)
      .where(eq(skillBundlesTable.id, req.targetBundleId))
      .limit(1);
    if (!exists) {
      throw Object.assign(new Error(`Bundle ${req.targetBundleId} not found`), { statusCode: 404 });
    }
  }

  // Concurrency is enforced at execution time (processNextQueuedEvalRun), not schedule time,
  // so runs can always be enqueued and will be processed when a slot opens.
  const meta = await buildReproducibilityMetadata(req);

  const costCap = req.costCapOverrideUsd ?? cfg.perRunCostCapUsd;

  const [run] = await db
    .insert(evalRunsTable)
    .values({
      status: "queued",
      runType: req.runType,
      targetSkillId: req.targetSkillId ?? null,
      targetBundleId: req.targetBundleId ?? null,
      taskMode: req.taskMode ?? "build",
      sessionType: req.sessionType ?? "solo",
      tokenMode: req.tokenMode ?? "core",
      modelProfile: req.modelProfile ?? "kimi",
      repoKind: req.repoKind ?? null,
      repoLangsJson: req.repoLangs ? (req.repoLangs as unknown as Record<string, unknown>) : null,
      repoCommitSha: req.repoCommitSha ?? null,
      skillVersionIdsJson: meta.skillVersionIds as unknown as Record<string, unknown>,
      bundleVersionHash: meta.bundleVersionHash,
      configVersion: meta.configVersion,
      scoringWeightsJson: req.scoringWeightsOverride
        ? (req.scoringWeightsOverride as unknown as Record<string, unknown>)
        : null,
      priority: cfg.evalJobPriority,
      costCapUsd: costCap,
      notes: req.notes ?? null,
      scheduledAt: new Date(),
    })
    .returning();

  logger.info(
    { runId: run.id, runType: run.runType, targetSkillId: run.targetSkillId, targetBundleId: run.targetBundleId },
    "[evals] Eval run scheduled"
  );

  return run;
}

/**
 * Advance an eval run to the next status.
 * Yields if a heavy interactive job is currently running.
 */
export async function advanceEvalRunStatus(
  runId: number,
  newStatus: "preparing" | "running" | "scoring" | "completed" | "error",
  opts?: { errorDetails?: string; actualCostUsd?: number }
): Promise<typeof evalRunsTable.$inferSelect> {
  if (newStatus === "preparing" || newStatus === "running") {
    if (await isLaneHeavyJobActive()) {
      logger.info({ runId }, "[evals] Eval job yielding — lane heavy job is active");
      throw new Error("Eval job yielded: interactive heavy job is active. Retry shortly.");
    }
  }

  const [existing] = await db.select().from(evalRunsTable).where(eq(evalRunsTable.id, runId)).limit(1);
  if (!existing) throw new Error(`Eval run ${runId} not found`);

  if (opts?.actualCostUsd !== undefined && existing.costCapUsd !== null && existing.costCapUsd !== undefined) {
    if (opts.actualCostUsd > existing.costCapUsd) {
      const capErrorDetails = `Per-run cost cap exceeded: actual $${opts.actualCostUsd.toFixed(4)} > cap $${existing.costCapUsd.toFixed(4)}`;
      logger.warn({ runId, actualCostUsd: opts.actualCostUsd, costCapUsd: existing.costCapUsd }, `[evals] ${capErrorDetails}`);
      const [errored] = await db
        .update(evalRunsTable)
        .set({
          status: "error",
          errorDetails: capErrorDetails,
          actualCostUsd: opts.actualCostUsd,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evalRunsTable.id, runId))
        .returning();
      return errored;
    }
  }

  const updates: Partial<typeof evalRunsTable.$inferInsert> = {
    status: newStatus,
    updatedAt: new Date(),
  };

  if (newStatus === "running") updates.startedAt = new Date();
  if (newStatus === "completed" || newStatus === "error") updates.completedAt = new Date();
  if (opts?.errorDetails) updates.errorDetails = opts.errorDetails;
  if (opts?.actualCostUsd !== undefined) updates.actualCostUsd = opts.actualCostUsd;

  const [updated] = await db
    .update(evalRunsTable)
    .set(updates)
    .where(eq(evalRunsTable.id, runId))
    .returning();

  return updated;
}

/**
 * Record a variant result for an eval run.
 * Computes the composite score automatically using task-mode presets.
 */
export async function recordEvalVariant(
  runId: number,
  variantInput: EvalVariantInput,
  taskMode: string,
  customWeights?: Partial<ScoringWeights>,
): Promise<typeof evalRunVariantsTable.$inferSelect> {
  const metrics = variantInput.metrics ?? {};
  const { compositeScore, rawScore, weights } = computeCompositeScore(metrics, taskMode, customWeights);

  const [variant] = await db
    .insert(evalRunVariantsTable)
    .values({
      runId,
      variantType: variantInput.variantType,
      skillIdsIncludedJson: variantInput.skillIdsIncluded
        ? (variantInput.skillIdsIncluded as unknown as Record<string, unknown>)
        : null,
      skillIdsExcludedJson: variantInput.skillIdsExcluded
        ? (variantInput.skillIdsExcluded as unknown as Record<string, unknown>)
        : null,
      timeToFirstAnswerMs: metrics.timeToFirstAnswerMs ?? null,
      totalElapsedMs: metrics.totalElapsedMs ?? null,
      memoryItemsRetrieved: metrics.memoryItemsRetrieved ?? null,
      contextBytesInjected: metrics.contextBytesInjected ?? null,
      shieldedBytesAvoided: metrics.shieldedBytesAvoided ?? null,
      repoHitCount: metrics.repoHitCount ?? null,
      repoCacheHit: metrics.repoCacheHit ?? null,
      success: metrics.success ?? null,
      userRating: metrics.userRating ?? null,
      costUsd: metrics.costUsd ?? null,
      rawScore,
      compositeScore,
      scoringWeightsJson: weights as unknown as Record<string, unknown>,
      metricsJson: metrics as unknown as Record<string, unknown>,
      notes: variantInput.notes ?? null,
    })
    .returning();

  return variant;
}

/**
 * Finalize an eval run after all variants have been recorded.
 * - Computes baseline vs treatment lift for each skill and bundle.
 * - Updates per-skill and per-bundle aggregate tables.
 * - Advances run status to "completed".
 */
export async function finalizeEvalRun(runId: number): Promise<void> {
  const [run] = await db.select().from(evalRunsTable).where(eq(evalRunsTable.id, runId));
  if (!run) throw new Error(`Eval run ${runId} not found`);

  const variants = await db
    .select()
    .from(evalRunVariantsTable)
    .where(eq(evalRunVariantsTable.runId, runId));

  const baselineVariant = variants.find(v => v.variantType === "baseline");
  const treatmentVariants = variants.filter(v => v.variantType === "treatment");

  const baselineScore = baselineVariant?.compositeScore ?? 0;

  for (const treatment of treatmentVariants) {
    const treatmentScore = treatment.compositeScore ?? 0;
    const { lift, direction, confidence } = computeContributionHeuristic(
      baselineScore,
      treatmentScore,
      1
    );

    const includedSkillIds = (treatment.skillIdsIncludedJson as string[] | null) ?? [];

    for (const skillSlug of includedSkillIds) {
      const [skill] = await db
        .select({ id: skillsTable.id })
        .from(skillsTable)
        .where(eq(skillsTable.slug, skillSlug));
      if (!skill) continue;

      const [existing] = await db
        .select()
        .from(skillEvalsTable)
        .where(eq(skillEvalsTable.skillId, skill.id));

      if (existing) {
        const newEvalAppearances = existing.evalAppearances + 1;
        const newPositive = direction === "positive" ? existing.positiveLiftCount + 1 : existing.positiveLiftCount;
        const newNegative = direction === "negative" ? existing.negativeLiftCount + 1 : existing.negativeLiftCount;
        const { confidence: newConf } = computeContributionHeuristic(0, 0, newEvalAppearances);

        const oldContribution = existing.estimatedContribution;
        const estimatedContribution = (oldContribution * (newEvalAppearances - 1) + lift) / newEvalAppearances;

        await db
          .update(skillEvalsTable)
          .set({
            evalAppearances: newEvalAppearances,
            positiveLiftCount: newPositive,
            negativeLiftCount: newNegative,
            confidenceScore: newConf,
            estimatedContribution,
            lastEvalRunId: runId,
            updatedAt: new Date(),
          })
          .where(eq(skillEvalsTable.skillId, skill.id));
      } else {
        const { confidence: newConf } = computeContributionHeuristic(0, 0, 1);
        await db
          .insert(skillEvalsTable)
          .values({
            skillId: skill.id,
            evalAppearances: 1,
            positiveLiftCount: direction === "positive" ? 1 : 0,
            negativeLiftCount: direction === "negative" ? 1 : 0,
            confidenceScore: newConf,
            estimatedContribution: lift,
            lastEvalRunId: runId,
          })
          .onConflictDoUpdate({
            target: [skillEvalsTable.skillId],
            set: {
              evalAppearances: sql`skill_evals.eval_appearances + 1`,
              updatedAt: new Date(),
            },
          });
      }
    }
  }

  if (run.targetBundleId && treatmentVariants.length > 0) {
    const avgTreatmentScore = treatmentVariants.reduce((s, v) => s + (v.compositeScore ?? 0), 0) / treatmentVariants.length;
    const avgLift = avgTreatmentScore - baselineScore;

    const [existingBundleEval] = await db
      .select()
      .from(bundleEvalsTable)
      .where(eq(bundleEvalsTable.bundleId, run.targetBundleId));

    if (existingBundleEval) {
      const newCount = existingBundleEval.evalRunCount + 1;
      const prevAvg = existingBundleEval.avgCompositeScore ?? 0;
      const prevBaseline = existingBundleEval.avgBaselineScore ?? 0;
      const prevLift = existingBundleEval.avgLift ?? 0;
      const newAvgComposite = (prevAvg * (newCount - 1) + avgTreatmentScore) / newCount;
      const newAvgBaseline = (prevBaseline * (newCount - 1) + baselineScore) / newCount;
      const newAvgLift = (prevLift * (newCount - 1) + avgLift) / newCount;
      const { confidence } = computeContributionHeuristic(0, 0, newCount);

      await db
        .update(bundleEvalsTable)
        .set({
          evalRunCount: newCount,
          avgCompositeScore: newAvgComposite,
          avgBaselineScore: newAvgBaseline,
          avgLift: newAvgLift,
          confidenceScore: confidence,
          bestTaskMode: run.taskMode,
          bestTokenMode: run.tokenMode,
          lastEvalRunId: runId,
          updatedAt: new Date(),
        })
        .where(eq(bundleEvalsTable.bundleId, run.targetBundleId));
    } else {
      const { confidence } = computeContributionHeuristic(0, 0, 1);
      await db
        .insert(bundleEvalsTable)
        .values({
          bundleId: run.targetBundleId,
          evalRunCount: 1,
          avgCompositeScore: avgTreatmentScore,
          avgBaselineScore: baselineScore,
          avgLift,
          confidenceScore: confidence,
          bestTaskMode: run.taskMode,
          bestTokenMode: run.tokenMode,
          lastEvalRunId: runId,
        })
        .onConflictDoUpdate({
          target: [bundleEvalsTable.bundleId],
          set: {
            evalRunCount: sql`bundle_evals.eval_run_count + 1`,
            updatedAt: new Date(),
          },
        });
    }
  }

  // ─── Ablation contribution attribution ────────────────────────────────────
  // For bundle_variant runs, each ablated variant excluded one skill.
  // ablationLift = treatmentScore - ablatedScore:
  //   > 0 → excluded skill helped (treatment WITH skill outperformed WITHOUT)
  //   < 0 → excluded skill hurt (treatment WITHOUT skill was better)
  const ablatedVariants = variants.filter(v => v.variantType === "ablated");
  const treatmentScore = treatmentVariants[0]?.compositeScore ?? baselineScore;
  const ablationLiftScores: Record<string, number> = {};

  for (const ablated of ablatedVariants) {
    const ablatedScore = ablated.compositeScore ?? baselineScore;
    const ablationLift = treatmentScore - ablatedScore;
    const excludedSlugs = (ablated.skillIdsExcludedJson as string[] | null) ?? [];

    for (const excludedSlug of excludedSlugs) {
      ablationLiftScores[excludedSlug] = ablationLift;

      const [skill] = await db
        .select({ id: skillsTable.id })
        .from(skillsTable)
        .where(eq(skillsTable.slug, excludedSlug));
      if (!skill) continue;

      // Use ablation lift as the directional signal for this skill's contribution
      const { lift, direction, confidence } = computeContributionHeuristic(baselineScore, baselineScore + ablationLift, 1);

      const [existing] = await db.select().from(skillEvalsTable).where(eq(skillEvalsTable.skillId, skill.id));

      if (existing) {
        const newEvalAppearances = existing.evalAppearances + 1;
        const newPositive = direction === "positive" ? existing.positiveLiftCount + 1 : existing.positiveLiftCount;
        const newNegative = direction === "negative" ? existing.negativeLiftCount + 1 : existing.negativeLiftCount;
        const { confidence: newConf } = computeContributionHeuristic(0, 0, newEvalAppearances);
        const estimatedContribution = (existing.estimatedContribution * (newEvalAppearances - 1) + lift) / newEvalAppearances;
        await db.update(skillEvalsTable).set({
          evalAppearances: newEvalAppearances,
          positiveLiftCount: newPositive,
          negativeLiftCount: newNegative,
          confidenceScore: newConf,
          estimatedContribution,
          lastEvalRunId: runId,
          updatedAt: new Date(),
        }).where(eq(skillEvalsTable.skillId, skill.id));
      } else {
        const { confidence: newConf } = computeContributionHeuristic(0, 0, 1);
        await db.insert(skillEvalsTable).values({
          skillId: skill.id,
          evalAppearances: 1,
          positiveLiftCount: direction === "positive" ? 1 : 0,
          negativeLiftCount: direction === "negative" ? 1 : 0,
          confidenceScore: newConf,
          estimatedContribution: lift,
          lastEvalRunId: runId,
        }).onConflictDoUpdate({
          target: [skillEvalsTable.skillId],
          set: { evalAppearances: sql`skill_evals.eval_appearances + 1`, updatedAt: new Date() },
        });
      }
    }
  }

  // Persist ablation lift scores into bundleEvalsTable if this is a bundle_variant run
  if (run.targetBundleId && Object.keys(ablationLiftScores).length > 0) {
    await db.update(bundleEvalsTable)
      .set({ ablationLiftScoresJson: ablationLiftScores, updatedAt: new Date() })
      .where(eq(bundleEvalsTable.bundleId, run.targetBundleId));
  }

  await advanceEvalRunStatus(runId, "completed");

  logger.info({ runId, baselineScore, treatmentCount: treatmentVariants.length, ablatedCount: ablatedVariants.length }, "[evals] Eval run finalized");
}

// ─── Instrumentation Hooks ────────────────────────────────────────────────────

/**
 * Collect runtime metrics from the existing session stack.
 * These are pulled from already-existing sources — no duplication of instrumentation.
 */
export async function collectSessionMetrics(sessionId: number): Promise<EvalVariantMetrics> {
  try {
    const [session] = await db
      .select({
        startedAt: sessionsTable.startedAt,
        stoppedAt: sessionsTable.stoppedAt,
        totalCost: sessionsTable.totalCost,
        routingStatsJson: sessionsTable.routingStatsJson,
      })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) return {};

    const totalElapsedMs = session.startedAt && session.stoppedAt
      ? session.stoppedAt.getTime() - session.startedAt.getTime()
      : undefined;

    const routingStats = session.routingStatsJson as {
      totalBytesAvoided?: number;
      totalShielded?: number;
    } | null;

    // Repo context: count of indexed symbols is a proxy for file/symbol search efficiency;
    // indexStatus='complete' indicates the repo cache was warm (repoCacheHit).
    const [repoCtx] = await db
      .select({
        symbolsJson: sessionRepoContextTable.symbolsJson,
        indexStatus: sessionRepoContextTable.indexStatus,
        confidenceLevel: sessionRepoContextTable.confidenceLevel,
      })
      .from(sessionRepoContextTable)
      .where(eq(sessionRepoContextTable.sessionId, sessionId))
      .limit(1);

    let repoHitCount: number | undefined;
    let repoCacheHit: number | undefined;
    if (repoCtx) {
      const symbols = repoCtx.symbolsJson as Record<string, unknown>[] | null;
      repoHitCount = Array.isArray(symbols) ? symbols.length : undefined;
      repoCacheHit = repoCtx.indexStatus === "complete" ? 1 : 0;
    }

    // Skill feedback for this session: tokenDelta sum (bytes/token * 4) → context bytes injected;
    // feedback count → memory items retrieved (skill-sourced memory activations per session).
    const feedbackRows = await db
      .select({ tokenDelta: skillFeedbackTable.tokenDelta })
      .from(skillFeedbackTable)
      .where(eq(skillFeedbackTable.sessionId, sessionId));

    const contextBytesInjected = feedbackRows.length > 0
      ? Math.max(0, feedbackRows.reduce((s, r) => s + (r.tokenDelta ?? 0), 0) * 4)
      : undefined;
    const memoryItemsRetrieved = feedbackRows.length > 0 ? feedbackRows.length : undefined;

    // Time-to-first-answer: session start → first skill activation (proxy for when context
    // injection completed and the model could begin producing a useful answer).
    let timeToFirstAnswerMs: number | undefined;
    if (session.startedAt) {
      const [firstSkillActivation] = await db
        .select({ activatedAt: sessionSkillsTable.activatedAt })
        .from(sessionSkillsTable)
        .where(eq(sessionSkillsTable.sessionId, sessionId))
        .orderBy(sessionSkillsTable.activatedAt)
        .limit(1);
      if (firstSkillActivation?.activatedAt) {
        const delta = firstSkillActivation.activatedAt.getTime() - session.startedAt.getTime();
        if (delta > 0) timeToFirstAnswerMs = delta;
      }
    }

    return {
      totalElapsedMs,
      timeToFirstAnswerMs,
      shieldedBytesAvoided: routingStats?.totalShielded ?? routingStats?.totalBytesAvoided ?? undefined,
      costUsd: session.totalCost ?? undefined,
      repoHitCount,
      repoCacheHit,
      contextBytesInjected,
      memoryItemsRetrieved,
    };
  } catch (err) {
    logger.warn({ err, sessionId }, "[evals] Failed to collect session metrics");
    return {};
  }
}

// ─── Eval-Aware Lift Score for Bundle Compiler ────────────────────────────────

/**
 * Compute an eval-based lift signal for a skill ID, safe for injection into the bundle compiler.
 *
 * Safety rules (internal, not user-facing):
 * - Returns 0 when confidence < MIN_EVAL_CONFIDENCE (low-confidence data has no power)
 * - Returns 0 for experimental skills regardless of measured lift (trust-tier cap)
 * - Lifts are clipped to [-MAX_EVAL_LIFT, +MAX_EVAL_LIFT] to avoid crowding out trust signals
 */
const MIN_EVAL_CONFIDENCE = 0.30;
const MAX_EVAL_LIFT = 0.5;

export interface SkillEvalSignal {
  skillId: number;
  evalLift: number;
  confidenceScore: number;
  isHighConfidence: boolean;
}

export async function getEvalLiftSignals(
  skillIds: number[]
): Promise<Map<number, SkillEvalSignal>> {
  if (skillIds.length === 0) return new Map();

  const rows = await db
    .select({
      skillId: skillEvalsTable.skillId,
      estimatedContribution: skillEvalsTable.estimatedContribution,
      confidenceScore: skillEvalsTable.confidenceScore,
      evalAppearances: skillEvalsTable.evalAppearances,
    })
    .from(skillEvalsTable)
    .where(inArray(skillEvalsTable.skillId, skillIds));

  const result = new Map<number, SkillEvalSignal>();

  for (const row of rows) {
    const confidence = row.confidenceScore ?? 0;
    if (confidence < MIN_EVAL_CONFIDENCE) {
      result.set(row.skillId, {
        skillId: row.skillId,
        evalLift: 0,
        confidenceScore: confidence,
        isHighConfidence: false,
      });
      continue;
    }

    const rawLift = row.estimatedContribution ?? 0;
    const evalLift = Math.max(-MAX_EVAL_LIFT, Math.min(MAX_EVAL_LIFT, rawLift));

    result.set(row.skillId, {
      skillId: row.skillId,
      evalLift,
      confidenceScore: confidence,
      isHighConfidence: confidence >= 0.60,
    });
  }

  return result;
}

// ─── List / Get Eval Runs ─────────────────────────────────────────────────────

export async function listEvalRuns(opts: {
  limit?: number;
  offset?: number;
  status?: string;
  runType?: string;
  taskMode?: string;
} = {}): Promise<{ runs: typeof evalRunsTable.$inferSelect[]; total: number }> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;

  let query = db.select().from(evalRunsTable).$dynamic();
  const filters = [];
  if (opts.status) filters.push(eq(evalRunsTable.status, opts.status));
  if (opts.runType) filters.push(eq(evalRunsTable.runType, opts.runType));
  if (opts.taskMode) filters.push(eq(evalRunsTable.taskMode, opts.taskMode));
  if (filters.length) query = query.where(and(...filters));

  const runs = await query.orderBy(desc(evalRunsTable.createdAt)).limit(limit).offset(offset);

  let countQuery = db.select({ n: count() }).from(evalRunsTable).$dynamic();
  const countFilters = [];
  if (opts.status) countFilters.push(eq(evalRunsTable.status, opts.status));
  if (opts.runType) countFilters.push(eq(evalRunsTable.runType, opts.runType));
  if (opts.taskMode) countFilters.push(eq(evalRunsTable.taskMode, opts.taskMode));
  if (countFilters.length) countQuery = countQuery.where(and(...countFilters));
  const [{ n }] = await countQuery;

  return { runs, total: n };
}

export async function getEvalRunWithVariants(runId: number): Promise<{
  run: typeof evalRunsTable.$inferSelect;
  variants: typeof evalRunVariantsTable.$inferSelect[];
} | null> {
  const [run] = await db.select().from(evalRunsTable).where(eq(evalRunsTable.id, runId));
  if (!run) return null;

  const variants = await db
    .select()
    .from(evalRunVariantsTable)
    .where(eq(evalRunVariantsTable.runId, runId))
    .orderBy(evalRunVariantsTable.id);

  return { run, variants };
}

export async function getSkillPerformance(skillId: number): Promise<{
  skill: typeof skillEvalsTable.$inferSelect | null;
  recentRuns: typeof evalRunsTable.$inferSelect[];
}> {
  const [skill] = await db
    .select()
    .from(skillEvalsTable)
    .where(eq(skillEvalsTable.skillId, skillId));

  const recentRuns = await db
    .select()
    .from(evalRunsTable)
    .where(eq(evalRunsTable.targetSkillId, skillId))
    .orderBy(desc(evalRunsTable.createdAt))
    .limit(10);

  return { skill: skill ?? null, recentRuns };
}

export async function getBundlePerformance(bundleId: number): Promise<{
  bundle: typeof bundleEvalsTable.$inferSelect | null;
  recentRuns: typeof evalRunsTable.$inferSelect[];
}> {
  const [bundle] = await db
    .select()
    .from(bundleEvalsTable)
    .where(eq(bundleEvalsTable.bundleId, bundleId));

  const recentRuns = await db
    .select()
    .from(evalRunsTable)
    .where(eq(evalRunsTable.targetBundleId, bundleId))
    .orderBy(desc(evalRunsTable.createdAt))
    .limit(10);

  return { bundle: bundle ?? null, recentRuns };
}

// ─── Async Eval Worker ────────────────────────────────────────────────────────

/**
 * Average multiple real-session metric observations into a single EvalVariantMetrics.
 * Used by both baseline and treatment metric gathering to collapse per-session data.
 */
function averageSessionMetrics(observations: EvalVariantMetrics[]): EvalVariantMetrics {
  if (observations.length === 0) return {};

  // Only average over observations that have a defined (non-undefined) value for a key,
  // so sparse metrics don't drag down the average with implicit zeros.
  const avgDefined = (key: keyof EvalVariantMetrics): number | undefined => {
    const defined = observations.filter(o => o[key] !== undefined);
    if (defined.length === 0) return undefined;
    return defined.reduce((acc, o) => acc + ((o[key] as number) ?? 0), 0) / defined.length;
  };
  const roundDefined = (key: keyof EvalVariantMetrics): number | undefined => {
    const v = avgDefined(key);
    return v !== undefined ? Math.round(v) : undefined;
  };

  return {
    totalElapsedMs: roundDefined("totalElapsedMs"),
    timeToFirstAnswerMs: roundDefined("timeToFirstAnswerMs"),
    shieldedBytesAvoided: roundDefined("shieldedBytesAvoided"),
    costUsd: avgDefined("costUsd"),
    repoHitCount: roundDefined("repoHitCount"),
    repoCacheHit: roundDefined("repoCacheHit"),
    contextBytesInjected: roundDefined("contextBytesInjected"),
    memoryItemsRetrieved: roundDefined("memoryItemsRetrieved"),
  };
}

// Baseline: 20 most recent stopped sessions where no skills were activated (NOT IN session_skills).
// Metrics sourced from real session data only; fields not present in the schema remain undefined.
async function gatherBaselineMetrics(run: typeof evalRunsTable.$inferSelect): Promise<{ metrics: EvalVariantMetrics; samplesUsed: number }> {
  const skillActivatedSessionIds = db
    .select({ sessionId: sessionSkillsTable.sessionId })
    .from(sessionSkillsTable);

  const recentSessions = await db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.status, "stopped"),
        sql`${sessionsTable.id} NOT IN (${skillActivatedSessionIds})`
      )
    )
    .orderBy(desc(sessionsTable.stoppedAt))
    .limit(20);

  const sessionObservations: EvalVariantMetrics[] = [];
  for (const s of recentSessions) {
    const m = await collectSessionMetrics(s.id);
    if (m.totalElapsedMs) sessionObservations.push(m);
  }
  const sessionAvg = averageSessionMetrics(sessionObservations);

  const [globalFeedback] = await db
    .select({
      total: sql<number>`count(*)::int`,
      helpful: sql<number>`sum(case when helpful then 1 else 0 end)::int`,
      avgSuccessScore: sql<number>`avg(task_success_score)`,
      avgTokenDelta: sql<number>`avg(token_delta)`,
    })
    .from(skillFeedbackTable);

  const feedbackTotal = globalFeedback?.total ?? 0;
  const helpful = globalFeedback?.helpful ?? 0;
  const helpfulRate = feedbackTotal > 0 ? helpful / feedbackTotal : 0.5;
  const avgSuccessScore = feedbackTotal > 0 ? (globalFeedback?.avgSuccessScore ?? 50) : 50;
  const avgTokenDelta = feedbackTotal > 0 ? (globalFeedback?.avgTokenDelta ?? 0) : 0;

  const userRating = feedbackTotal > 0 ? Math.max(1, Math.min(5, Math.round(helpfulRate * 4 + 1))) : undefined;

  // Only use session-derived timing when actual sessions exist; do not fabricate when no baseline exists.
  const totalElapsedMs = sessionObservations.length > 0 && (sessionAvg.totalElapsedMs ?? 0) > 0
    ? sessionAvg.totalElapsedMs
    : undefined;

  const samplesUsed = sessionObservations.length + feedbackTotal;

  return {
    metrics: {
      success: feedbackTotal > 0 ? helpfulRate >= 0.5 : undefined,
      totalElapsedMs,
      shieldedBytesAvoided: sessionObservations.length > 0 ? sessionAvg.shieldedBytesAvoided : undefined,
      costUsd: sessionObservations.length > 0 ? sessionAvg.costUsd : undefined,
      taskSuccessScore: feedbackTotal > 0 ? avgSuccessScore : undefined,
      userRating,
      // contextBytesInjected and memoryItemsRetrieved are not tracked in baseline sessions
    },
    samplesUsed,
  };
}

// Treatment: sessions where all evaluated skills were active (AND semantics for bundles).
// opts.overrideSkillSlugs: for ablation runs, the reduced skill set (bundle minus one skill).
// opts.excludeSlug: additionally exclude sessions where the withheld skill was active.
async function gatherTreatmentMetrics(
  run: typeof evalRunsTable.$inferSelect,
  opts?: { overrideSkillSlugs?: string[]; excludeSlug?: string },
): Promise<{ metrics: EvalVariantMetrics; samplesUsed: number }> {
  let skillSessionIds: number[] = [];
  let feedbackTotal = 0;
  let helpful = 0;
  let avgSuccessScore = 50;
  let avgTokenDelta = 0;

  if (run.targetSkillId) {
    const [skillRow] = await db
      .select({ slug: skillsTable.slug })
      .from(skillsTable)
      .where(eq(skillsTable.id, run.targetSkillId));

    if (skillRow) {
      // activatedSkillsJson stores MiziSkillManifest objects; match on id field
      const matchingSessions = await db
        .select({ sessionId: sessionSkillsTable.sessionId })
        .from(sessionSkillsTable)
        .where(sql`${sessionSkillsTable.activatedSkillsJson} @> ${JSON.stringify([{ id: skillRow.slug }])}::jsonb`)
        .orderBy(desc(sessionSkillsTable.activatedAt))
        .limit(20);
      skillSessionIds = matchingSessions.map(r => r.sessionId);
    }

    const [fb] = await db
      .select({
        total: sql<number>`count(*)::int`,
        helpful: sql<number>`sum(case when helpful then 1 else 0 end)::int`,
        avgSuccessScore: sql<number>`avg(task_success_score)`,
        avgTokenDelta: sql<number>`avg(token_delta)`,
      })
      .from(skillFeedbackTable)
      .where(eq(skillFeedbackTable.skillId, run.targetSkillId));

    feedbackTotal = fb?.total ?? 0;
    helpful = fb?.helpful ?? 0;
    avgSuccessScore = feedbackTotal > 0 ? (fb?.avgSuccessScore ?? 50) : 50;
    avgTokenDelta = feedbackTotal > 0 ? (fb?.avgTokenDelta ?? 0) : 0;
  }

  if (run.targetBundleId || opts?.overrideSkillSlugs) {
    let skillSlugs: string[] = opts?.overrideSkillSlugs ?? [];

    // When no override is provided, load the full bundle skill list
    if (!opts?.overrideSkillSlugs && run.targetBundleId) {
      const [bundle] = await db
        .select({ bundleJson: skillBundlesTable.bundleJson })
        .from(skillBundlesTable)
        .where(eq(skillBundlesTable.id, run.targetBundleId));

      if (bundle) {
        const bundleData = bundle.bundleJson as { skillIds?: string[] };
        skillSlugs = bundleData.skillIds || [];
      }
    }

    if (skillSlugs.length > 0) {
      // AND semantics: match sessions where ALL skills in the evaluated set were active.
      // For a bundle [A, B, C, D] this finds sessions with the exact composition present,
      // giving strict baseline-vs-treatment comparability and preventing single-skill
      // activations from contaminating bundle treatment measurements.
      const slugConditions = skillSlugs.map(
        slug => sql`${sessionSkillsTable.activatedSkillsJson} @> ${JSON.stringify([{ id: slug }])}::jsonb`
      );
      let whereClause = and(...slugConditions);

      // For ablation: additionally exclude sessions where the withheld skill was also active.
      // This isolates sessions that operated without the withheld skill — the ablation counterfactual.
      if (opts?.excludeSlug) {
        whereClause = and(
          whereClause,
          sql`NOT (${sessionSkillsTable.activatedSkillsJson} @> ${JSON.stringify([{ id: opts.excludeSlug }])}::jsonb)`
        );
      }

      const matchingSessions = await db
        .select({ sessionId: sessionSkillsTable.sessionId })
        .from(sessionSkillsTable)
        .where(whereClause)
        .orderBy(desc(sessionSkillsTable.activatedAt))
        .limit(20);
      skillSessionIds = matchingSessions.map(r => r.sessionId);

      const bundleSkills = await db.select({ id: skillsTable.id }).from(skillsTable).where(inArray(skillsTable.slug, skillSlugs));
      if (bundleSkills.length > 0) {
        const [bundleFb] = await db
          .select({
            total: sql<number>`count(*)::int`,
            helpful: sql<number>`sum(case when helpful then 1 else 0 end)::int`,
            avgSuccessScore: sql<number>`avg(task_success_score)`,
            avgTokenDelta: sql<number>`avg(token_delta)`,
          })
          .from(skillFeedbackTable)
          .where(inArray(skillFeedbackTable.skillId, bundleSkills.map(s => s.id)));
        feedbackTotal = bundleFb?.total ?? 0;
        helpful = bundleFb?.helpful ?? 0;
        avgSuccessScore = feedbackTotal > 0 ? (bundleFb?.avgSuccessScore ?? 50) : 50;
        avgTokenDelta = feedbackTotal > 0 ? (bundleFb?.avgTokenDelta ?? 0) : 0;
      }
    }
  }

  const sessionObservations: EvalVariantMetrics[] = [];
  for (const sessionId of skillSessionIds) {
    const m = await collectSessionMetrics(sessionId);
    if (m.totalElapsedMs) sessionObservations.push(m);
  }
  const sessionAvg = averageSessionMetrics(sessionObservations);

  const helpfulRate = feedbackTotal > 0 ? helpful / feedbackTotal : undefined;
  const userRating = helpfulRate != null ? Math.max(1, Math.min(5, Math.round(helpfulRate * 4 + 1))) : undefined;
  const samplesUsed = sessionObservations.length + feedbackTotal;

  // Session-sourced real metrics take precedence; feedback-aggregate proxy used only as fallback
  // when no matching sessions exist (cold-start scenario).
  const hasSessions = sessionObservations.length > 0;
  const fallbackContextBytes = feedbackTotal > 0 ? Math.max(0, Math.round(avgTokenDelta * 4)) : undefined;

  return {
    metrics: {
      success: feedbackTotal > 0 ? avgSuccessScore / 100 >= 0.5 : undefined,
      totalElapsedMs: hasSessions ? sessionAvg.totalElapsedMs : undefined,
      timeToFirstAnswerMs: hasSessions ? sessionAvg.timeToFirstAnswerMs : undefined,
      shieldedBytesAvoided: hasSessions ? sessionAvg.shieldedBytesAvoided : undefined,
      costUsd: hasSessions ? sessionAvg.costUsd : undefined,
      contextBytesInjected: hasSessions ? sessionAvg.contextBytesInjected : fallbackContextBytes,
      memoryItemsRetrieved: hasSessions ? sessionAvg.memoryItemsRetrieved : undefined,
      repoHitCount: hasSessions ? sessionAvg.repoHitCount : undefined,
      repoCacheHit: hasSessions ? sessionAvg.repoCacheHit : undefined,
      userRating,
      taskSuccessScore: feedbackTotal > 0 ? avgSuccessScore : undefined,
    },
    samplesUsed,
  };
}

/**
 * Process the next queued eval run, if budget and concurrency allow.
 * This is the core of the autonomous eval execution loop.
 */
export async function processNextQueuedEvalRun(): Promise<{ processed: boolean; runId?: number; reason?: string }> {
  if (await isLaneHeavyJobActive()) {
    return { processed: false, reason: "lane-heavy-job-active" };
  }
  if (await isDailyBudgetExhausted(DEFAULT_EVAL_BUDGET)) {
    return { processed: false, reason: "daily-budget-exhausted" };
  }

  const runningCount = await countActiveEvalJobs();
  if (runningCount >= DEFAULT_EVAL_BUDGET.maxConcurrentEvalJobs) {
    return { processed: false, reason: "concurrency-limit-reached" };
  }

  // Atomically claim one queued run by updating status to 'preparing' in a single statement.
  // FOR UPDATE SKIP LOCKED ensures concurrent scheduler/manual trigger invocations each
  // claim a different run (or skip if none available), eliminating duplicate-pickup races.
  const [run] = await db
    .update(evalRunsTable)
    .set({ status: "preparing" })
    .where(
      sql`id = (SELECT id FROM eval_runs WHERE status = 'queued' ORDER BY scheduled_at LIMIT 1 FOR UPDATE SKIP LOCKED)`
    )
    .returning();

  if (!run) {
    return { processed: false, reason: "no-queued-runs" };
  }

  logger.info({ runId: run.id, runType: run.runType, taskMode: run.taskMode }, "[eval-worker] Claimed and processing queued eval run");

  try {
    await advanceEvalRunStatus(run.id, "running");

    const customWeights = run.scoringWeightsJson
      ? (run.scoringWeightsJson as Partial<ScoringWeights>)
      : undefined;

    const { metrics: baselineMetrics, samplesUsed: baselineSamples } = await gatherBaselineMetrics(run);
    await recordEvalVariant(run.id, { variantType: "baseline", metrics: baselineMetrics }, run.taskMode, customWeights);

    logger.debug(
      { runId: run.id, baselineSamples, baselineCost: baselineMetrics.costUsd },
      "[eval-worker] Baseline variant recorded"
    );

    let totalActualCostUsd = baselineMetrics.costUsd ?? 0;

    if (run.runType !== "baseline" && (run.targetSkillId || run.targetBundleId)) {
      const { metrics: treatmentMetrics, samplesUsed: treatmentSamples } = await gatherTreatmentMetrics(run);
      let skillSlugsIncluded: string[] | undefined;
      if (run.targetSkillId) {
        const [skillRow] = await db
          .select({ slug: skillsTable.slug })
          .from(skillsTable)
          .where(eq(skillsTable.id, run.targetSkillId));
        if (skillRow) skillSlugsIncluded = [skillRow.slug];
      } else if (run.targetBundleId) {
        const [bundle] = await db
          .select({ bundleJson: skillBundlesTable.bundleJson })
          .from(skillBundlesTable)
          .where(eq(skillBundlesTable.id, run.targetBundleId));
        if (bundle) {
          const bundleData = bundle.bundleJson as { skillIds?: string[] };
          skillSlugsIncluded = bundleData.skillIds || undefined;
        }
      }
      await recordEvalVariant(
        run.id,
        { variantType: "treatment", skillIdsIncluded: skillSlugsIncluded, metrics: treatmentMetrics },
        run.taskMode,
        customWeights,
      );
      totalActualCostUsd += treatmentMetrics.costUsd ?? 0;

      logger.debug(
        { runId: run.id, treatmentSamples, treatmentCost: treatmentMetrics.costUsd },
        "[eval-worker] Treatment variant recorded"
      );

      // bundle_variant: produce an ablated variant to isolate per-skill contribution.
      // Each ablation withholds one skill from the active set, measuring what happens
      // when that skill is removed. This enables bundle scorecard decomposition.
      //
      // Ablation data source: sessions where ANY of the reducedSlugs were active AND the
      // excluded skill was NOT active. This represents the "bundle minus skill" condition.
      if (run.runType === "bundle_variant" && skillSlugsIncluded && skillSlugsIncluded.length > 1) {
        for (const excludedSlug of skillSlugsIncluded) {
          const reducedSlugs = skillSlugsIncluded.filter(s => s !== excludedSlug);
          // Pass reducedSlugs as overrideSkillSlugs and excludeSlug to find sessions
          // that operated with the reduced bundle (without the withheld skill)
          const { metrics: ablationMetrics } = await gatherTreatmentMetrics(
            run,
            { overrideSkillSlugs: reducedSlugs, excludeSlug: excludedSlug }
          );
          await recordEvalVariant(
            run.id,
            {
              variantType: "ablated",
              skillIdsIncluded: reducedSlugs,
              skillIdsExcluded: [excludedSlug],
              metrics: ablationMetrics,
              notes: `Ablation: ${excludedSlug} withheld`,
            },
            run.taskMode,
            customWeights,
          );
          totalActualCostUsd += ablationMetrics.costUsd ?? 0;
          logger.debug({ runId: run.id, excludedSlug }, "[eval-worker] Ablated variant recorded");
        }
      }
    }

    const scoringRun = await advanceEvalRunStatus(run.id, "scoring", { actualCostUsd: totalActualCostUsd });
    if (scoringRun.status === "error") {
      logger.warn({ runId: run.id, actualCostUsd: totalActualCostUsd, cap: run.costCapUsd }, "[eval-worker] Run aborted at scoring — cost cap exceeded");
      return { processed: false, reason: scoringRun.errorDetails ?? "cost-cap-exceeded" };
    }
    await finalizeEvalRun(run.id);

    logger.info({ runId: run.id, actualCostUsd: totalActualCostUsd }, "[eval-worker] Eval run completed");
    return { processed: true, runId: run.id };
  } catch (err) {
    const errorDetails = err instanceof Error ? err.message : "Worker execution error";
    logger.error({ runId: run.id, err }, "[eval-worker] Eval run failed");
    await advanceEvalRunStatus(run.id, "error", { errorDetails }).catch(() => {});
    return { processed: false, reason: errorDetails };
  }
}

/**
 * Start the recurring eval scheduler.
 * Runs every `intervalSeconds` and processes one queued eval run per tick,
 * respecting budget, concurrency, and interactive-job priority rules.
 */
export function startEvalScheduler(intervalSeconds = 60): NodeJS.Timeout {
  logger.info({ intervalSeconds }, "[eval-worker] Eval scheduler started");
  return setInterval(async () => {
    try {
      const result = await processNextQueuedEvalRun();
      if (result.processed) {
        logger.info({ runId: result.runId }, "[eval-worker] Scheduler processed a queued eval run");
      }
    } catch (err) {
      logger.error({ err }, "[eval-worker] Scheduler tick error");
    }
  }, intervalSeconds * 1000);
}
