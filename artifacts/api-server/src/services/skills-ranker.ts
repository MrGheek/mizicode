import { db, skillsTable, skillFeedbackTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { FloatrSkillManifest, SessionContext, TrustTier, RepoIntelligenceContext } from "./skills-types";

const INSTALL_RISK_PENALTY: Record<string, number> = {
  virtual: 0,
  config: 0.1,
  hooked: 0.5,
  binary: 0.8,
  networked: 0.3,
};

const TRUST_BONUS: Record<TrustTier, number> = {
  floatr_native: 2.0,
  reviewed: 1.0,
  user_approved: 0.0,
  experimental: -1.0,
};

function taskFit(manifest: FloatrSkillManifest, ctx: SessionContext): number {
  const triggerTasks = manifest.triggers.tasks;
  if (triggerTasks.includes(ctx.taskMode)) return 1.0;
  const relatedMap: Record<string, string[]> = {
    build: ["refactor", "debug"],
    review: ["build"],
    debug: ["build"],
    refactor: ["build", "debug"],
    explore: ["build"],
    team: ["build", "review"],
  };
  const related = relatedMap[ctx.taskMode] || [];
  if (triggerTasks.some(t => related.includes(t))) return 0.5;
  return 0.0;
}

function repoFit(manifest: FloatrSkillManifest, ctx: SessionContext): number {
  const intel = ctx.repoIntelligence;

  const effectiveLangs = intel && intel.confidenceLevel !== "none"
    ? [...new Set([...ctx.repoLangs, ...intel.primaryLangs, ...intel.frameworks])]
    : ctx.repoLangs;

  if (!effectiveLangs || effectiveLangs.length === 0) return 0.0;

  const repoKinds = manifest.triggers.repoKinds;
  if (repoKinds.includes("any")) return 0.5;

  const matches = repoKinds.filter(k =>
    effectiveLangs.some(l => l.toLowerCase().includes(k.toLowerCase()))
  );

  let score = matches.length > 0 ? 1.0 : 0.2;

  if (intel && intel.confidenceLevel === "full") {
    const complexityBonus: Record<string, number> = {
      "very-high": 0.3,
      high: 0.2,
      medium: 0.1,
      low: 0,
    };
    score += complexityBonus[intel.complexityClass || "low"] || 0;

    if (intel.monorepo) score += 0.1;
  }

  return Math.min(score, 1.5);
}

function modelFit(manifest: FloatrSkillManifest, ctx: SessionContext): number {
  const compat = manifest.compatibility.models;
  if (compat.includes("all")) return 1.0;
  const modelLower = ctx.modelProfile.toLowerCase();
  const match = compat.some(m => modelLower.includes(m.toLowerCase()));
  return match ? 1.0 : 0.3;
}

function freshness(manifest: FloatrSkillManifest): number {
  if (manifest.source.trust === "floatr_native") return 1.0;
  return 0.5;
}

function tokenCostPenalty(manifest: FloatrSkillManifest): number {
  return Math.min(1.0, manifest.cost.tokenOverheadEstimate / 500);
}

function conflictRisk(manifest: FloatrSkillManifest, selected: FloatrSkillManifest[]): number {
  for (const existing of selected) {
    if (
      existing.class === manifest.class &&
      existing.id !== manifest.id &&
      existing.triggers.tasks.some(t => manifest.triggers.tasks.includes(t))
    ) {
      return 1.0;
    }
  }
  return 0.0;
}

/**
 * Compute the measured-lift bonus from historical feedback.
 * historyScores maps manifest.id → normalized score in [-1.0, +1.0]:
 *   +1.0 = always helpful, -1.0 = never helpful, 0 = unknown/neutral.
 * measuredLiftWeight scales how much impact this has on the final score.
 */
function measuredLiftBonus(manifest: FloatrSkillManifest, ctx: SessionContext): number {
  const historyScore = ctx.historyScores?.[manifest.id] ?? 0;
  const weight = manifest.rankingHints.measuredLiftWeight || 0;
  return historyScore * weight;
}

export interface RankedSkill {
  manifest: FloatrSkillManifest;
  score: number;
}

export function rankSkills(
  manifests: FloatrSkillManifest[],
  ctx: SessionContext,
  alreadySelected: FloatrSkillManifest[] = []
): RankedSkill[] {
  const ranked = manifests.map(manifest => {
    const tf = taskFit(manifest, ctx) * (manifest.rankingHints.taskFitWeight || 1.0);
    const rf = repoFit(manifest, ctx) * (manifest.rankingHints.repoFitWeight || 0.5);
    const mf = modelFit(manifest, ctx);
    const trust = TRUST_BONUS[manifest.source.trust as TrustTier] ?? 0;
    const fresh = freshness(manifest);
    const tokenPenalty = tokenCostPenalty(manifest);
    const installPenalty = INSTALL_RISK_PENALTY[manifest.install.type] || 0;
    const conflict = conflictRisk(manifest, alreadySelected);
    const lift = measuredLiftBonus(manifest, ctx);

    const score = tf + rf + mf + trust + fresh - tokenPenalty - installPenalty - conflict * 2 + lift;
    return { manifest, score };
  });

  return ranked.sort((a, b) => b.score - a.score);
}

export interface SkillFeedbackScore {
  skillId: number;
  slug: string;
  totalCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
  helpfulRate: number;
  /** Normalized to [-1.0, 1.0] centered at 0.5 helpfulRate */
  normalizedScore: number;
  avgTaskSuccessScore: number | null;
}

/**
 * Load aggregate feedback scores for all skills from the DB.
 * Returns a map of manifest slug → normalizedScore for use as historyScores in SessionContext.
 */
export async function getSkillFeedbackScores(): Promise<SkillFeedbackScore[]> {
  const rows = await db
    .select({
      skillId: skillFeedbackTable.skillId,
      slug: skillsTable.slug,
      totalCount: sql<number>`COUNT(*)::int`,
      helpfulCount: sql<number>`SUM(CASE WHEN ${skillFeedbackTable.helpful} THEN 1 ELSE 0 END)::int`,
      unhelpfulCount: sql<number>`SUM(CASE WHEN NOT ${skillFeedbackTable.helpful} THEN 1 ELSE 0 END)::int`,
      avgTaskSuccessScore: sql<number | null>`AVG(${skillFeedbackTable.taskSuccessScore})`,
    })
    .from(skillFeedbackTable)
    .innerJoin(skillsTable, eq(skillFeedbackTable.skillId, skillsTable.id))
    .groupBy(skillFeedbackTable.skillId, skillsTable.slug);

  return rows.map(r => {
    const total = r.totalCount || 0;
    const helpful = r.helpfulCount || 0;
    const helpfulRate = total > 0 ? helpful / total : 0.5;
    const normalizedScore = (helpfulRate - 0.5) * 2; // maps [0,1] → [-1,+1]
    return {
      skillId: r.skillId,
      slug: r.slug,
      totalCount: total,
      helpfulCount: helpful,
      unhelpfulCount: r.unhelpfulCount || 0,
      helpfulRate,
      normalizedScore,
      avgTaskSuccessScore: r.avgTaskSuccessScore ?? null,
    };
  });
}

/**
 * Build a historyScores map (manifest.id → normalizedScore) from feedback score records.
 * For native skills, slug === manifest.id.
 * For imported skills, slug = "imported-{sourceId}-{manifestId}" — we extract the
 * manifest.id tail so the ranker's ctx.historyScores[manifest.id] lookup always works.
 *
 * When multiple imported skills share the same manifest.id tail (e.g., same manifest
 * imported from two sources), we aggregate their feedback counts to produce a single
 * deterministic normalized score rather than letting last-in-iteration win.
 */
export function buildHistoryScoresMap(scores: SkillFeedbackScore[]): Record<string, number> {
  // First pass: accumulate per-manifestId totals across all matching rows
  const accumulator = new Map<string, { helpful: number; total: number }>();

  const accumulate = (key: string, s: SkillFeedbackScore) => {
    const existing = accumulator.get(key);
    if (existing) {
      existing.helpful += s.helpfulCount;
      existing.total += s.totalCount;
    } else {
      accumulator.set(key, { helpful: s.helpfulCount, total: s.totalCount });
    }
  };

  for (const s of scores) {
    // Accumulate under the full DB slug key (native skills: slug === manifest.id)
    accumulate(s.slug, s);

    // For imported skills, also accumulate under the bare manifest.id tail
    if (s.slug.startsWith("imported-")) {
      const manifestId = s.slug.replace(/^imported-\d+-/, "");
      if (manifestId && manifestId !== s.slug) {
        accumulate(manifestId, s);
      }
    }
  }

  // Second pass: compute normalizedScore from aggregated counts
  const map: Record<string, number> = {};
  for (const [key, { helpful, total }] of accumulator) {
    const helpfulRate = total > 0 ? helpful / total : 0.5;
    map[key] = (helpfulRate - 0.5) * 2; // maps [0,1] → [-1,+1]
  }
  return map;
}

export function buildRepoIntelligenceContext(contextData: {
  fingerprintJson?: unknown;
  summaryJson?: unknown;
  confidenceLevel?: string;
  isStale?: boolean;
}): RepoIntelligenceContext | undefined {
  const { fingerprintJson, summaryJson, confidenceLevel, isStale } = contextData;
  if (!confidenceLevel || confidenceLevel === "none") return undefined;

  const fp = fingerprintJson as Record<string, unknown> | null;
  const sm = summaryJson as Record<string, unknown> | null;

  return {
    primaryLangs: (fp?.primaryLangs as string[]) || (fp?.langs as string[]) || [],
    frameworks: (fp?.frameworks as string[]) || [],
    monorepo: Boolean(fp?.monorepo),
    graphDensity: typeof sm?.graphDensity === "number" ? sm.graphDensity : undefined,
    complexityClass: (sm?.complexityClass as RepoIntelligenceContext["complexityClass"]) || undefined,
    confidenceLevel: (confidenceLevel as RepoIntelligenceContext["confidenceLevel"]) || "none",
    isStale: Boolean(isStale),
    hotspotPaths: (sm?.hotspots as Array<{ path: string }> || []).map(h => h.path).slice(0, 10),
  };
}
