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

    const score = tf + rf + mf + trust + fresh - tokenPenalty - installPenalty - conflict * 2;
    return { manifest, score };
  });

  return ranked.sort((a, b) => b.score - a.score);
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
