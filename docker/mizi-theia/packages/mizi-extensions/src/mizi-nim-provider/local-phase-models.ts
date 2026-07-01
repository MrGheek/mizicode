export type ModelTier = "ultra-light" | "fast" | "balanced" | "quality" | "flagship";

export interface LocalModelEntry {
  modelId: string;
  displayName: string;
  tier: ModelTier;
  estimatedVramGb: number;
  tags: string[];
}

export const LOCAL_MODEL_CATALOG: LocalModelEntry[] = [
  { modelId: "phi3.5", displayName: "Phi-3.5 Mini", tier: "ultra-light", estimatedVramGb: 2.6, tags: ["fast", "cpu-friendly", "coding"] },
  { modelId: "qwen2.5:1.5b", displayName: "Qwen2.5 1.5B", tier: "ultra-light", estimatedVramGb: 1.1, tags: ["ultra-light", "cpu-friendly"] },
  { modelId: "qwen2.5-coder:3b", displayName: "Qwen2.5-Coder 3B", tier: "fast", estimatedVramGb: 2.0, tags: ["coding", "fast"] },
  { modelId: "llama3.2:3b", displayName: "Llama 3.2 3B", tier: "fast", estimatedVramGb: 2.0, tags: ["general", "fast"] },
  { modelId: "qwen2.5-coder:7b", displayName: "Qwen2.5-Coder 7B", tier: "balanced", estimatedVramGb: 4.5, tags: ["coding", "balanced"] },
  { modelId: "llama3.1:8b", displayName: "Llama 3.1 8B", tier: "balanced", estimatedVramGb: 5.0, tags: ["general", "balanced"] },
  { modelId: "deepseek-coder-v2:16b", displayName: "DeepSeek-Coder-V2 16B", tier: "quality", estimatedVramGb: 9.5, tags: ["coding", "quality"] },
  { modelId: "qwen2.5-coder:14b", displayName: "Qwen2.5-Coder 14B", tier: "quality", estimatedVramGb: 9.0, tags: ["coding", "quality"] },
  { modelId: "qwen2.5-coder:32b", displayName: "Qwen2.5-Coder 32B", tier: "quality", estimatedVramGb: 20.0, tags: ["coding", "high-quality"] },
  { modelId: "codestral:22b", displayName: "Codestral 22B", tier: "quality", estimatedVramGb: 13.5, tags: ["coding", "quality"] },
  { modelId: "llama3.1:70b", displayName: "Llama 3.1 70B", tier: "flagship", estimatedVramGb: 42.0, tags: ["high-quality", "large"] },
  { modelId: "qwen2.5-coder:72b", displayName: "Qwen2.5-Coder 72B", tier: "flagship", estimatedVramGb: 44.0, tags: ["coding", "flagship"] },
];

export type SessionPhase = "explore" | "plan" | "implement" | "swarm" | "synthesise" | "review";

interface PhaseTierMapping {
  primary: ModelTier;
  fallback: ModelTier;
}

const PHASE_TIER_MAP: Record<SessionPhase, PhaseTierMapping> = {
  explore:    { primary: "quality",     fallback: "balanced" },
  plan:       { primary: "quality",     fallback: "balanced" },
  implement:  { primary: "balanced",    fallback: "fast" },
  swarm:      { primary: "ultra-light", fallback: "fast" },
  synthesise: { primary: "balanced",    fallback: "quality" },
  review:     { primary: "balanced",    fallback: "fast" },
};

const TIER_ORDER: ModelTier[] = ["ultra-light", "fast", "balanced", "quality", "flagship"];

function tierDistance(a: ModelTier, b: ModelTier): number {
  return Math.abs(TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
}

function phaseScore(model: LocalModelEntry, primary: ModelTier, fallback: ModelTier): number {
  const distPrimary = tierDistance(model.tier, primary);
  const distFallback = tierDistance(model.tier, fallback);
  const bestDist = Math.min(distPrimary, distFallback);
  if (bestDist === 0) {
    const baseScore = distPrimary === 0 ? 100 : 80;
    const codingBonus = model.tags.includes("coding") ? 10 : 0;
    const fastBonus = distPrimary === 0 && model.tags.includes("fast") ? 5 : 0;
    return Math.min(100, baseScore + codingBonus + fastBonus);
  }
  if (bestDist === 1) return 50;
  if (bestDist === 2) return 20;
  return 5;
}

export interface ScoredLocalModel extends LocalModelEntry {
  phaseScore: number;
  available: boolean;
}

export function scoreModelsForPhase(
  phase: string,
  availableModelIds: string[],
): ScoredLocalModel[] {
  const mapping = PHASE_TIER_MAP[phase as SessionPhase];
  if (!mapping) return [];

  return LOCAL_MODEL_CATALOG
    .map((m) => ({
      ...m,
      phaseScore: phaseScore(m, mapping.primary, mapping.fallback),
      available: availableModelIds.some(
        (id) => id === m.modelId || id.startsWith(m.modelId + ":") || id === `${m.modelId}:latest`,
      ),
    }))
    .sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      const scoreDiff = b.phaseScore - a.phaseScore;
      if (scoreDiff !== 0) return scoreDiff;
      return a.estimatedVramGb - b.estimatedVramGb;
    });
}

export function getBestLocalModelForPhase(
  phase: string,
  availableModelIds: string[],
): ScoredLocalModel | null {
  const scored = scoreModelsForPhase(phase, availableModelIds);
  return scored.find((m) => m.available) ?? null;
}
