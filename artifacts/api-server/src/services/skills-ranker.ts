import type { FloatrSkillManifest, SessionContext, TrustTier } from "./skills-types";

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
  if (!ctx.repoLangs || ctx.repoLangs.length === 0) return 0.0;
  const repoKinds = manifest.triggers.repoKinds;
  if (repoKinds.includes("any")) return 0.5;
  const matches = repoKinds.filter(k => ctx.repoLangs.some(l => l.toLowerCase().includes(k.toLowerCase())));
  return matches.length > 0 ? 1.0 : 0.2;
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
