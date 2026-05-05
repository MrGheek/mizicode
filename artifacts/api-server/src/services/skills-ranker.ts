import { db, skillsTable, skillFeedbackTable, skillEvalsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import type { MiziSkillManifest, SessionContext, TrustTier, RepoIntelligenceContext } from "./skills-types";

const INSTALL_RISK_PENALTY: Record<string, number> = {
  virtual: 0,
  config: 0.1,
  hooked: 0.5,
  binary: 0.8,
  networked: 0.3,
};

const TRUST_BONUS: Record<TrustTier, number> = {
  mizi_native: 2.0,
  reviewed: 1.0,
  user_approved: 0.0,
  experimental: -1.0,
};

function taskFit(manifest: MiziSkillManifest, ctx: SessionContext): number {
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

function repoFit(manifest: MiziSkillManifest, ctx: SessionContext): number {
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

/**
 * Intent fit — lexical overlap between the user's natural-language session
 * intent and the manifest's name / summary / task triggers. Gated on
 * `intentText.length > 10` so short or absent intents contribute zero and
 * cannot perturb existing recommendations.
 *
 * Returns a score in [0, 1] based on the number of intent tokens (length ≥ 4)
 * that appear in the manifest's searchable text.
 *
 * Exported so callers (e.g. the bundler's reasoning path) can inspect per-skill
 * intent contributions without re-running the full ranking pipeline.
 */
export function intentFit(manifest: MiziSkillManifest, ctx: SessionContext): number {
  const intent = ctx.intentText?.trim();
  if (!intent || intent.length <= 10) return 0;
  const STOP = new Set([
    "the","and","for","with","that","this","from","into","have","been","will",
    "your","you","are","but","not","all","any","can","want","need","add","use",
    "make","just","also","then","than","when","what","does","over","into","onto",
  ]);
  const tokens = Array.from(
    new Set(
      intent
        .toLowerCase()
        .replace(/`[^`]*`/g, " ")
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 4 && !STOP.has(t)),
    ),
  );
  if (tokens.length === 0) return 0;
  const haystack = [
    manifest.name,
    manifest.summary,
    ...manifest.triggers.tasks,
    ...(manifest.triggers.repoKinds || []),
  ].join(" ").toLowerCase();
  let hits = 0;
  for (const t of tokens) if (haystack.includes(t)) hits += 1;
  return Math.min(1.0, hits / Math.max(3, tokens.length));
}

function modelFit(manifest: MiziSkillManifest, ctx: SessionContext): number {
  const compat = manifest.compatibility.models;
  if (compat.includes("all")) return 1.0;
  const modelLower = ctx.modelProfile.toLowerCase();
  const match = compat.some(m => modelLower.includes(m.toLowerCase()));
  return match ? 1.0 : 0.3;
}

function freshness(manifest: MiziSkillManifest): number {
  if (manifest.source.trust === "mizi_native") return 1.0;
  return 0.5;
}

function tokenCostPenalty(manifest: MiziSkillManifest): number {
  return Math.min(1.0, manifest.cost.tokenOverheadEstimate / 500);
}

function conflictRisk(manifest: MiziSkillManifest, selected: MiziSkillManifest[]): number {
  // "team" and "repo" class skills are complementary — they do not conflict with each other.
  // Coordination and repo skills are designed to coexist in the same bundle.
  if (manifest.class === "team" || manifest.class === "repo") return 0.0;

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
 * Compute the measured-lift bonus from historical feedback and eval data.
 *
 * Two signal sources are blended:
 * 1. historyScores: feedback-based recency-weighted score in [-1, +1]
 * 2. evalLiftScores: eval-run-based directional lift in [-MAX_EVAL_LIFT, +MAX_EVAL_LIFT]
 *
 * When both signals are available, the eval signal blends at 40% weight with feedback at 60%.
 * When only one signal is available, that signal is used at full weight.
 *
 * Safety: eval lift signals are already confidence-gated and clipped before reaching ctx.
 * Low-confidence eval data contributes 0 (no evalLiftScore key set).
 * Experimental skills are bounded by trust-tier rules applied upstream in rankSkills.
 *
 * measuredLiftWeight from the manifest scales the total blended signal.
 */
function measuredLiftBonus(manifest: MiziSkillManifest, ctx: SessionContext): number {
  const historyScore = ctx.historyScores?.[manifest.id] ?? null;
  const evalLift = ctx.evalLiftScores?.[manifest.id] ?? null;
  const weight = manifest.rankingHints.measuredLiftWeight || 0;

  let blendedScore = 0;
  if (historyScore !== null && evalLift !== null) {
    blendedScore = historyScore * 0.6 + evalLift * 0.4;
  } else if (historyScore !== null) {
    blendedScore = historyScore;
  } else if (evalLift !== null) {
    blendedScore = evalLift;
  }

  return blendedScore * weight;
}

/**
 * Build an eval lift scores map (manifest.id → recency-weighted, clipped lift value).
 *
 * Recency decay: Eval data older than RECENCY_HALF_LIFE_DAYS is discounted.
 *   effectiveLift = rawLift × 2^(-ageDays / halfLifeDays)
 *   This ensures stale eval results (e.g. from a previous skill version) fade out
 *   rather than permanently biasing recommendations.
 *
 * Confidence gate: Only skills meeting MIN_EVAL_CONFIDENCE are included.
 *   Low-confidence data returns no key, so the blending logic uses feedback only.
 *
 * Negative-lift penalty: Skills with decayed lift < NEGATIVE_LIFT_THRESHOLD
 *   receive an additional suppression multiplier (NEGATIVE_LIFT_PENALTY_FACTOR).
 *   This encodes a risk-averse prior — we suppress more aggressively than we boost.
 */
export async function getEvalLiftScoresMap(): Promise<Record<string, number>> {
  const MIN_EVAL_CONFIDENCE = 0.30;
  const MAX_EVAL_LIFT = 0.5;
  const RECENCY_HALF_LIFE_DAYS = 30;
  const NEGATIVE_LIFT_THRESHOLD = -0.02;
  const NEGATIVE_LIFT_PENALTY_FACTOR = 1.5;

  const rows = await db
    .select({
      slug: skillsTable.slug,
      estimatedContribution: skillEvalsTable.estimatedContribution,
      confidenceScore: skillEvalsTable.confidenceScore,
      negativeLiftCount: skillEvalsTable.negativeLiftCount,
      updatedAt: skillEvalsTable.updatedAt,
    })
    .from(skillEvalsTable)
    .innerJoin(skillsTable, eq(skillEvalsTable.skillId, skillsTable.id));

  const now = Date.now();
  const map: Record<string, number> = {};

  for (const row of rows) {
    if ((row.confidenceScore ?? 0) < MIN_EVAL_CONFIDENCE) continue;

    const rawLift = row.estimatedContribution ?? 0;

    const ageDays = row.updatedAt
      ? (now - new Date(row.updatedAt).getTime()) / 86_400_000
      : 0;
    const recencyFactor = Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);

    let effectiveLift = rawLift * recencyFactor;

    if (effectiveLift < NEGATIVE_LIFT_THRESHOLD) {
      effectiveLift *= NEGATIVE_LIFT_PENALTY_FACTOR;
    }

    const clipped = Math.max(-MAX_EVAL_LIFT, Math.min(MAX_EVAL_LIFT, effectiveLift));
    map[row.slug] = clipped;

    if (row.slug.startsWith("imported-")) {
      const manifestId = row.slug.replace(/^imported-\d+-/, "");
      if (manifestId && manifestId !== row.slug) {
        map[manifestId] = clipped;
      }
    }
  }
  return map;
}

export interface RankedSkill {
  manifest: MiziSkillManifest;
  score: number;
}

export function rankSkills(
  manifests: MiziSkillManifest[],
  ctx: SessionContext,
  alreadySelected: MiziSkillManifest[] = []
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
    // Intent fit blends in at 0.6 weight — large enough to break ties between
    // similarly-scored skills when the user has expressed a clear intent, but
    // small enough not to dominate trust/task/repo signals.
    const intent = intentFit(manifest, ctx) * 0.6;

    const score = tf + rf + mf + trust + fresh - tokenPenalty - installPenalty - conflict * 2 + lift + intent;
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
 * Cache TTL in milliseconds — configurable via FEEDBACK_SCORES_CACHE_TTL_MS env var (default 5 min).
 * Must be a positive integer; non-positive or non-numeric values fall back to the default.
 *
 * NOTE: This cache is process-local (in-memory). In multi-instance deployments each instance
 * maintains its own cache independently, so scores may be up to TTL seconds stale on instances
 * that have not yet received a write and had their cache invalidated.
 */
const _parsedTtl = parseInt(process.env["FEEDBACK_SCORES_CACHE_TTL_MS"] ?? "", 10);
const FEEDBACK_SCORES_CACHE_TTL_MS = Number.isFinite(_parsedTtl) && _parsedTtl > 0
  ? _parsedTtl
  : 5 * 60 * 1000;

interface FeedbackScoresCache {
  scores: SkillFeedbackScore[];
  expiresAt: number;
}

let feedbackScoresCache: FeedbackScoresCache | null = null;

/**
 * Invalidate the feedback scores cache. Call this whenever new feedback is written
 * so that the next request re-fetches fresh data from the DB.
 */
export function invalidateFeedbackScoresCache(): void {
  feedbackScoresCache = null;
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
 *
 * Results are cached in-memory for FEEDBACK_SCORES_CACHE_TTL_MS (default 5 minutes)
 * to avoid redundant DB reads. The cache is invalidated when new feedback is written.
 */
export async function getSkillFeedbackScores(): Promise<SkillFeedbackScore[]> {
  const now = Date.now();
  if (feedbackScoresCache && now < feedbackScoresCache.expiresAt) {
    return feedbackScoresCache.scores;
  }
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

  const scores = Array.from(bySkill.values()).map(e => {
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

  feedbackScoresCache = { scores, expiresAt: Date.now() + FEEDBACK_SCORES_CACHE_TTL_MS };
  return scores;
}

/**
 * Load aggregate feedback stats for a single skill by DB id.
 * Uses the same recency-decay logic as getSkillFeedbackScores().
 * Returns null rates/scores when no feedback exists (explicit empty state).
 */
export async function getSkillFeedbackScoreById(skillId: number): Promise<{
  totalCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
  helpfulRate: number | null;
  rawHelpfulRate: number | null;
  normalizedScore: number | null;
  avgTaskSuccessScore: number | null;
}> {
  const rows = await db
    .select({
      helpful: skillFeedbackTable.helpful,
      taskSuccessScore: skillFeedbackTable.taskSuccessScore,
      createdAt: skillFeedbackTable.createdAt,
    })
    .from(skillFeedbackTable)
    .where(eq(skillFeedbackTable.skillId, skillId));

  let totalCount = 0;
  let helpfulCount = 0;
  let decayedTotalWeight = 0;
  let decayedHelpfulWeight = 0;
  let taskSuccessSum = 0;
  let taskSuccessCount = 0;

  for (const row of rows) {
    totalCount += 1;
    const weight = computeDecayWeight(row.createdAt);
    decayedTotalWeight += weight;
    if (row.helpful) {
      helpfulCount += 1;
      decayedHelpfulWeight += weight;
    }
    if (row.taskSuccessScore !== null && row.taskSuccessScore !== undefined) {
      taskSuccessSum += row.taskSuccessScore;
      taskSuccessCount += 1;
    }
  }

  const rawHelpfulRate = totalCount > 0 ? helpfulCount / totalCount : null;
  const helpfulRate = decayedTotalWeight > 0 ? decayedHelpfulWeight / decayedTotalWeight : null;
  const normalizedScore = helpfulRate !== null ? (helpfulRate - 0.5) * 2 : null;

  return {
    totalCount,
    helpfulCount,
    unhelpfulCount: totalCount - helpfulCount,
    helpfulRate,
    rawHelpfulRate,
    normalizedScore,
    avgTaskSuccessScore: taskSuccessCount > 0 ? taskSuccessSum / taskSuccessCount : null,
  };
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
