/**
 * skills-leaderboard.ts
 *
 * Leaderboard service for Smart Skills.
 *
 * Computes:
 * - Top bundles by task mode, repo shape, token mode, and model family
 * - Top individual skills by measured lift
 * - Skills with negative lift or regression risk
 *
 * All entries link back to specific reproducible eval runs.
 * Results are backed by stored eval data — not hardcoded.
 */

import {
  db,
  skillsTable,
  skillBundlesTable,
  skillEvalsTable,
  bundleEvalsTable,
  evalRunsTable,
  evalRunVariantsTable,
  skillFeedbackTable,
} from "@workspace/db";
import { eq, desc, asc, and, sql, lt, gt, isNotNull, inArray } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkillLeaderboardEntry {
  skillId: number;
  slug: string;
  name: string;
  class: string;
  trustTier: string;
  evalAppearances: number;
  positiveLiftCount: number;
  negativeLiftCount: number;
  confidenceScore: number;
  estimatedContribution: number;
  lastEvalRunId: number | null;
  regressionRisk: boolean;
  feedbackHelpfulRate: number | null;
}

export interface BundleLeaderboardEntry {
  bundleId: number;
  slug: string;
  name: string;
  taskMode: string | null;
  tokenMode: string;
  evalRunCount: number;
  avgCompositeScore: number | null;
  avgBaselineScore: number | null;
  avgLift: number | null;
  confidenceScore: number;
  lastEvalRunId: number | null;
}

export interface SkillLeaderboardResponse {
  topByLift: SkillLeaderboardEntry[];
  regressionRisk: SkillLeaderboardEntry[];
  total: number;
  generatedAt: string;
}

export interface BundleLeaderboardResponse {
  overall: BundleLeaderboardEntry[];
  byTaskMode: Record<string, BundleLeaderboardEntry[]>;
  byTokenMode: Record<string, BundleLeaderboardEntry[]>;
  byRepoKind: Record<string, BundleLeaderboardEntry[]>;
  byModelFamily: Record<string, BundleLeaderboardEntry[]>;
  total: number;
  generatedAt: string;
}

// ─── Skill Leaderboard ────────────────────────────────────────────────────────

export async function getSkillLeaderboard(opts: {
  limit?: number;
  taskMode?: string;
  minConfidence?: number;
} = {}): Promise<SkillLeaderboardResponse> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const minConfidence = opts.minConfidence ?? 0.10;

  // When taskMode is provided, rank by treatment scores from runs in that task mode.
  // Otherwise fall back to the global estimated_contribution aggregate in skill_evals.
  let taskModeScoreBySkillId: Map<number, { score: number; runId: number }> | null = null;
  if (opts.taskMode) {
    const taskModeVariants = await db
      .select({
        skillId: evalRunsTable.targetSkillId,
        compositeScore: evalRunVariantsTable.compositeScore,
        runId: evalRunsTable.id,
      })
      .from(evalRunVariantsTable)
      .innerJoin(evalRunsTable, eq(evalRunVariantsTable.runId, evalRunsTable.id))
      .where(
        and(
          eq(evalRunsTable.taskMode, opts.taskMode),
          eq(evalRunsTable.status, "completed"),
          eq(evalRunVariantsTable.variantType, "treatment"),
          isNotNull(evalRunsTable.targetSkillId)
        )
      )
      .orderBy(desc(evalRunVariantsTable.compositeScore));

    // Keep highest-score run per skill for the requested task mode
    taskModeScoreBySkillId = new Map();
    for (const row of taskModeVariants) {
      if (row.skillId == null || row.compositeScore == null) continue;
      if (!taskModeScoreBySkillId.has(row.skillId)) {
        taskModeScoreBySkillId.set(row.skillId, { score: row.compositeScore, runId: row.runId });
      }
    }
  }

  const skillEvalWhere = taskModeScoreBySkillId && taskModeScoreBySkillId.size > 0
    ? inArray(skillEvalsTable.skillId, [...taskModeScoreBySkillId.keys()])
    : undefined;

  const skillEvalRows = await db
    .select({
      skillId: skillEvalsTable.skillId,
      evalAppearances: skillEvalsTable.evalAppearances,
      positiveLiftCount: skillEvalsTable.positiveLiftCount,
      negativeLiftCount: skillEvalsTable.negativeLiftCount,
      confidenceScore: skillEvalsTable.confidenceScore,
      estimatedContribution: skillEvalsTable.estimatedContribution,
      lastEvalRunId: skillEvalsTable.lastEvalRunId,
      slug: skillsTable.slug,
      name: skillsTable.name,
      class: skillsTable.class,
      trustTier: skillsTable.trustTier,
    })
    .from(skillEvalsTable)
    .innerJoin(skillsTable, eq(skillEvalsTable.skillId, skillsTable.id))
    .where(skillEvalWhere)
    .orderBy(desc(skillEvalsTable.estimatedContribution))
    .limit(limit * 3);

  const feedbackRows = await db
    .select({
      skillId: skillFeedbackTable.skillId,
      totalCount: sql<number>`count(*)::int`,
      helpfulCount: sql<number>`sum(case when helpful then 1 else 0 end)::int`,
    })
    .from(skillFeedbackTable)
    .groupBy(skillFeedbackTable.skillId);

  const feedbackBySkill = new Map(
    feedbackRows.map(r => [
      r.skillId,
      r.totalCount > 0 ? r.helpfulCount / r.totalCount : null,
    ])
  );

  const toEntry = (row: typeof skillEvalRows[0]): SkillLeaderboardEntry => {
    // If taskMode was requested, use the task-mode-specific score for ordering
    const taskModeScore = taskModeScoreBySkillId?.get(row.skillId);
    const contribution = taskModeScore?.score ?? row.estimatedContribution;
    const lastRunId = taskModeScore?.runId ?? row.lastEvalRunId ?? null;
    return {
      skillId: row.skillId,
      slug: row.slug,
      name: row.name,
      class: row.class,
      trustTier: row.trustTier,
      evalAppearances: row.evalAppearances,
      positiveLiftCount: row.positiveLiftCount,
      negativeLiftCount: row.negativeLiftCount,
      confidenceScore: row.confidenceScore,
      estimatedContribution: contribution,
      lastEvalRunId: lastRunId,
      regressionRisk: row.negativeLiftCount > row.positiveLiftCount && row.confidenceScore >= 0.30,
      feedbackHelpfulRate: feedbackBySkill.get(row.skillId) ?? null,
    };
  };

  const qualified = skillEvalRows.filter(r => r.confidenceScore >= minConfidence);

  const topByLift = qualified
    .sort((a, b) => {
      const aScore = taskModeScoreBySkillId?.get(a.skillId)?.score ?? a.estimatedContribution;
      const bScore = taskModeScoreBySkillId?.get(b.skillId)?.score ?? b.estimatedContribution;
      return bScore - aScore;
    })
    .slice(0, limit)
    .map(toEntry);

  const regressionRisk = qualified
    .filter(r => r.negativeLiftCount > r.positiveLiftCount && r.confidenceScore >= 0.30)
    .sort((a, b) => a.estimatedContribution - b.estimatedContribution)
    .slice(0, limit)
    .map(toEntry);

  return {
    topByLift,
    regressionRisk,
    total: skillEvalRows.length,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Bundle Leaderboard ───────────────────────────────────────────────────────

export async function getBundleLeaderboard(opts: {
  limit?: number;
  taskMode?: string;
  tokenMode?: string;
  modelFamily?: string;
  repoKind?: string;
} = {}): Promise<BundleLeaderboardResponse> {
  const limit = Math.min(opts.limit ?? 20, 100);

  const bundleEvalRows = await db
    .select({
      bundleId: bundleEvalsTable.bundleId,
      evalRunCount: bundleEvalsTable.evalRunCount,
      avgCompositeScore: bundleEvalsTable.avgCompositeScore,
      avgBaselineScore: bundleEvalsTable.avgBaselineScore,
      avgLift: bundleEvalsTable.avgLift,
      confidenceScore: bundleEvalsTable.confidenceScore,
      bestTaskMode: bundleEvalsTable.bestTaskMode,
      bestTokenMode: bundleEvalsTable.bestTokenMode,
      lastEvalRunId: bundleEvalsTable.lastEvalRunId,
      slug: skillBundlesTable.slug,
      name: skillBundlesTable.name,
      taskMode: skillBundlesTable.taskMode,
      tokenMode: skillBundlesTable.tokenMode,
    })
    .from(bundleEvalsTable)
    .innerJoin(skillBundlesTable, eq(bundleEvalsTable.bundleId, skillBundlesTable.id))
    .orderBy(desc(bundleEvalsTable.avgLift));

  const bundleIds = bundleEvalRows.map(r => r.bundleId);
  const runContextRows = bundleIds.length > 0
    ? await db
        .select({
          bundleId: evalRunsTable.targetBundleId,
          repoKind: evalRunsTable.repoKind,
          modelProfile: evalRunsTable.modelProfile,
        })
        .from(evalRunsTable)
        .where(
          and(
            isNotNull(evalRunsTable.targetBundleId),
            inArray(evalRunsTable.targetBundleId, bundleIds)
          )
        )
    : [];

  const repoKindsByBundle = new Map<number, Set<string>>();
  const modelFamiliesByBundle = new Map<number, Set<string>>();
  for (const row of runContextRows) {
    if (!row.bundleId) continue;
    if (row.repoKind) {
      if (!repoKindsByBundle.has(row.bundleId)) repoKindsByBundle.set(row.bundleId, new Set());
      repoKindsByBundle.get(row.bundleId)!.add(row.repoKind);
    }
    const modelFamily = deriveModelFamily(row.modelProfile);
    if (!modelFamiliesByBundle.has(row.bundleId)) modelFamiliesByBundle.set(row.bundleId, new Set());
    modelFamiliesByBundle.get(row.bundleId)!.add(modelFamily);
  }

  const toEntry = (row: typeof bundleEvalRows[0]): BundleLeaderboardEntry => ({
    bundleId: row.bundleId,
    slug: row.slug,
    name: row.name,
    taskMode: row.taskMode ?? null,
    tokenMode: row.tokenMode,
    evalRunCount: row.evalRunCount,
    avgCompositeScore: row.avgCompositeScore ?? null,
    avgBaselineScore: row.avgBaselineScore ?? null,
    avgLift: row.avgLift ?? null,
    confidenceScore: row.confidenceScore,
    lastEvalRunId: row.lastEvalRunId ?? null,
  });

  let filtered = bundleEvalRows;
  if (opts.taskMode) filtered = filtered.filter(r => r.taskMode === opts.taskMode || r.bestTaskMode === opts.taskMode);
  if (opts.tokenMode) filtered = filtered.filter(r => r.tokenMode === opts.tokenMode);
  if (opts.repoKind) filtered = filtered.filter(r => repoKindsByBundle.get(r.bundleId)?.has(opts.repoKind!) ?? false);
  if (opts.modelFamily) filtered = filtered.filter(r => modelFamiliesByBundle.get(r.bundleId)?.has(opts.modelFamily!) ?? false);

  const overall = filtered.slice(0, limit).map(toEntry);

  const byTaskMode: Record<string, BundleLeaderboardEntry[]> = {};
  for (const row of bundleEvalRows) {
    const mode = row.taskMode ?? row.bestTaskMode ?? "build";
    if (!byTaskMode[mode]) byTaskMode[mode] = [];
    if (byTaskMode[mode].length < limit) byTaskMode[mode].push(toEntry(row));
  }

  const byTokenMode: Record<string, BundleLeaderboardEntry[]> = {};
  for (const row of bundleEvalRows) {
    const mode = row.tokenMode ?? "core";
    if (!byTokenMode[mode]) byTokenMode[mode] = [];
    if (byTokenMode[mode].length < limit) byTokenMode[mode].push(toEntry(row));
  }

  const byRepoKind: Record<string, BundleLeaderboardEntry[]> = {};
  for (const row of bundleEvalRows) {
    const kinds = repoKindsByBundle.get(row.bundleId) ?? new Set(["unknown"]);
    for (const kind of kinds) {
      if (!byRepoKind[kind]) byRepoKind[kind] = [];
      if (byRepoKind[kind].length < limit) byRepoKind[kind].push(toEntry(row));
    }
  }

  const byModelFamily: Record<string, BundleLeaderboardEntry[]> = {};
  for (const row of bundleEvalRows) {
    const families = modelFamiliesByBundle.get(row.bundleId) ?? new Set([deriveModelFamily(null)]);
    for (const family of families) {
      if (!byModelFamily[family]) byModelFamily[family] = [];
      if (byModelFamily[family].length < limit) byModelFamily[family].push(toEntry(row));
    }
  }

  return {
    overall,
    byTaskMode,
    byTokenMode,
    byRepoKind,
    byModelFamily,
    total: bundleEvalRows.length,
    generatedAt: new Date().toISOString(),
  };
}

function deriveModelFamily(modelProfile: string | null | undefined): string {
  if (!modelProfile) return "unknown";
  if (modelProfile.startsWith("kimi")) return "kimi";
  if (modelProfile.startsWith("gpt") || modelProfile.startsWith("o1") || modelProfile.startsWith("o3")) return "openai";
  if (modelProfile.startsWith("claude")) return "anthropic";
  if (modelProfile.startsWith("gemini")) return "google";
  if (modelProfile.startsWith("llama") || modelProfile.startsWith("codellama")) return "meta";
  if (modelProfile.startsWith("deepseek")) return "deepseek";
  if (modelProfile.startsWith("mistral") || modelProfile.startsWith("mixtral")) return "mistral";
  return "other";
}
