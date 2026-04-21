import { db, skillsTable, skillFeedbackTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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

/** Exponential decay half-life in days (older signals fade toward zero). */
const DECAY_HALF_LIFE_DAYS = 90;
/** Feedback this many days old or newer receives full weight (no decay). */
const FULL_WEIGHT_DAYS = 30;

/**
 * Compute a recency weight in (0, 1] for a feedback row.
 * - Age ≤ 30 days → weight 1.0 (full weight)
 * - Age > 30 days → exponential decay with a 90-day half-life starting from day 30
 *   weight = 2^(-(age_days - 30) / 90)
 *   e.g. 120 days old → 0.5, 210 days old → 0.25, 390 days old → 0.125
 */
function computeDecayWeight(createdAt: Date): number {
  const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
  if (ageDays <= FULL_WEIGHT_DAYS) return 1.0;
  return Math.pow(2, -(ageDays - FULL_WEIGHT_DAYS) / DECAY_HALF_LIFE_DAYS);
}

export interface SkillFeedbackScore {
  skillId: number;
  slug: string;
  totalCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
  /** Recency-weighted helpful rate in [0, 1] (recent feedback counts more) */
  helpfulRate: number;
  /** Raw (unweighted) helpful rate in [0, 1] — for observability only */
  rawHelpfulRate: number;
  /** Normalized to [-1.0, 1.0] centered at 0.5 helpfulRate — recency-weighted */
  normalizedScore: number;
  /** Average task success score — raw (unweighted) arithmetic mean for direct interpretability */
  avgTaskSuccessScore: number | null;
  /** Sum of decay weights (effective sample size) */
  decayedTotalWeight: number;
  /** Sum of decay weights for helpful rows */
  decayedHelpfulWeight: number;
}

/**
 * Load aggregate feedback scores for all skills from the DB, applying
 * time-based decay so that outdated signals do not dominate ranking forever.
 *
 * Each feedback row is weighted by computeDecayWeight(createdAt):
 *   - Last 30 days: full weight (1.0)
 *   - Older: exponential decay with 90-day half-life
 *
 * helpfulRate and normalizedScore reflect recency-weighted averages.
 */
export async function getSkillFeedbackScores(): Promise<SkillFeedbackScore[]> {
  const rows = await db
    .select({
      skillId: skillFeedbackTable.skillId,
      slug: skillsTable.slug,
      helpful: skillFeedbackTable.helpful,
      taskSuccessScore: skillFeedbackTable.taskSuccessScore,
      createdAt: skillFeedbackTable.createdAt,
    })
    .from(skillFeedbackTable)
    .innerJoin(skillsTable, eq(skillFeedbackTable.skillId, skillsTable.id));

  type AccEntry = {
    skillId: number;
    slug: string;
    totalCount: number;
    helpfulCount: number;
    unhelpfulCount: number;
    decayedTotalWeight: number;
    decayedHelpfulWeight: number;
    taskSuccessSum: number;
    taskSuccessCount: number;
  };

  const bySkill = new Map<number, AccEntry>();

  for (const row of rows) {
    const weight = computeDecayWeight(row.createdAt);
    let entry = bySkill.get(row.skillId);
    if (!entry) {
      entry = {
        skillId: row.skillId,
        slug: row.slug,
        totalCount: 0,
        helpfulCount: 0,
        unhelpfulCount: 0,
        decayedTotalWeight: 0,
        decayedHelpfulWeight: 0,
        taskSuccessSum: 0,
        taskSuccessCount: 0,
      };
      bySkill.set(row.skillId, entry);
    }
    entry.totalCount += 1;
    entry.decayedTotalWeight += weight;
    if (row.helpful) {
      entry.helpfulCount += 1;
      entry.decayedHelpfulWeight += weight;
    } else {
      entry.unhelpfulCount += 1;
    }
    if (row.taskSuccessScore !== null && row.taskSuccessScore !== undefined) {
      entry.taskSuccessSum += row.taskSuccessScore;
      entry.taskSuccessCount += 1;
    }
  }

  return Array.from(bySkill.values()).map(e => {
    const rawHelpfulRate = e.totalCount > 0 ? e.helpfulCount / e.totalCount : 0.5;
    const helpfulRate = e.decayedTotalWeight > 0
      ? e.decayedHelpfulWeight / e.decayedTotalWeight
      : 0.5;
    const normalizedScore = (helpfulRate - 0.5) * 2; // maps [0,1] → [-1,+1]
    return {
      skillId: e.skillId,
      slug: e.slug,
      totalCount: e.totalCount,
      helpfulCount: e.helpfulCount,
      unhelpfulCount: e.unhelpfulCount,
      helpfulRate,
      rawHelpfulRate,
      normalizedScore,
      avgTaskSuccessScore: e.taskSuccessCount > 0 ? e.taskSuccessSum / e.taskSuccessCount : null,
      decayedTotalWeight: e.decayedTotalWeight,
      decayedHelpfulWeight: e.decayedHelpfulWeight,
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
  // Accumulate decay-weighted totals per manifest key so that the final
  // normalizedScore preserves recency weighting even when multiple imported
  // skill slugs share the same manifest.id tail.
  const accumulator = new Map<string, { helpfulWeight: number; totalWeight: number }>();

  const accumulate = (key: string, s: SkillFeedbackScore) => {
    const existing = accumulator.get(key);
    if (existing) {
      existing.helpfulWeight += s.decayedHelpfulWeight;
      existing.totalWeight += s.decayedTotalWeight;
    } else {
      accumulator.set(key, {
        helpfulWeight: s.decayedHelpfulWeight,
        totalWeight: s.decayedTotalWeight,
      });
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

  // Compute decay-weighted normalizedScore for each key
  const map: Record<string, number> = {};
  for (const [key, { helpfulWeight, totalWeight }] of accumulator) {
    const helpfulRate = totalWeight > 0 ? helpfulWeight / totalWeight : 0.5;
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
