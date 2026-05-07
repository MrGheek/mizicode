/**
 * inference-router.ts
 *
 * Phase-aware LLM model scoring for NIM sessions (Task #300).
 *
 * Scoring formula (identical intent to intent.ts for consistency):
 *   score = sweBench × phaseQualityWeight × (1000 / latencyMs) × costFactor × throughputBonus(phase, throughputClass)
 *
 * Each phase has a quality weight and a throughput-class bonus table so that
 * swarm phases reward high-throughput models and explore phases reward quality.
 * Live provider latency is probed from the PROVIDER_CONFIG endpoints (same
 * logic as getProviderLatencies() in intent.ts) so routing accounts for
 * real-time provider health — not just static catalog metadata.
 */

import { listNimModels, getConfiguredProviders, PROVIDER_CONFIG, CATALOG_SWE_BENCH_SCORES } from "./nim-catalog";
import type { NimModel, ThroughputClass } from "./nim-catalog";
import { logger } from "../lib/logger";

export type SessionPhase =
  | "explore"
  | "plan"
  | "implement"
  | "swarm"
  | "synthesise"
  | "review";

export const VALID_PHASES: SessionPhase[] = [
  "explore",
  "plan",
  "implement",
  "swarm",
  "synthesise",
  "review",
];

// ── Per-phase quality weight ──────────────────────────────────────────────────
// Applied as the `taskWeight` multiplier in the live scoring formula.
// Higher = quality-first; lower = cost/throughput-first.
const PHASE_QUALITY_WEIGHTS: Record<SessionPhase, number> = {
  explore:    0.80,
  plan:       0.65,
  implement:  0.50,
  swarm:      0.25,
  synthesise: 0.60,
  review:     0.45,
};

// ── Per-phase cost sensitivity weight ────────────────────────────────────────
// Multiplied into the provider costFactor so that cost sensitivity varies
// meaningfully by phase. Swarm runs many parallel workers → cost dominates.
// Explore/plan/synthesise/review need quality → accept premium-provider pricing.
// Higher weight = cost-sensitivity prioritised → cheaper providers preferred.
const PHASE_COST_WEIGHTS: Record<SessionPhase, number> = {
  explore:    0.85,  // quality-first: premium providers acceptable
  plan:       0.85,  // quality-first: best reasoning matters most
  implement:  1.00,  // balanced: throughput + quality tradeoff
  swarm:      1.40,  // cost-first: many workers → economy providers strongly preferred
  synthesise: 0.90,  // quality-first: summary accuracy matters
  review:     1.10,  // slightly cost-sensitive: final check can use economy tier
};

// ── Per-phase throughput-class bonus ─────────────────────────────────────────
// Multiplied into the final score AFTER the latency/swe formula.
// Swarm rewards high-throughput; explore/synthesise are cost-neutral.
const PHASE_THROUGHPUT_BONUS: Record<SessionPhase, Record<ThroughputClass, number>> = {
  explore:    { high: 0.95, standard: 1.00, economy: 1.05 }, // slight economy bonus
  plan:       { high: 0.95, standard: 1.00, economy: 1.05 },
  implement:  { high: 1.10, standard: 1.00, economy: 0.90 }, // throughput helps iteration
  swarm:      { high: 1.40, standard: 1.15, economy: 1.00 }, // throughput dominates swarm
  synthesise: { high: 1.05, standard: 1.00, economy: 0.95 },
  review:     { high: 0.90, standard: 1.00, economy: 1.10 }, // economy/cost matters in review
};

// ── Provider health snapshot ──────────────────────────────────────────────────

export interface ProviderSnapshot {
  latencyMs: number | null;
  live: boolean;
}

/**
 * Probe all configured NIM providers for liveness and latency.
 * Mirrors the getProviderLatencies() function in intent.ts.
 * Unconfigured providers are returned with { live: false, latencyMs: null }.
 */
export async function getProviderSnapshots(): Promise<Record<string, ProviderSnapshot>> {
  const configured = getConfiguredProviders();
  const results = await Promise.allSettled(
    Object.entries(PROVIDER_CONFIG).map(async ([key, info]) => {
      if (!configured[key]) return { key, latencyMs: null, live: false };
      const apiKey = process.env[info.envKey];
      const start = Date.now();
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 4000);
        const resp = await fetch(`${info.apiBase}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        clearTimeout(tid);
        return { key, latencyMs: Date.now() - start, live: resp.status < 500 };
      } catch {
        return { key, latencyMs: null, live: false };
      }
    }),
  );
  const out: Record<string, ProviderSnapshot> = {};
  for (const r of results) {
    if (r.status === "fulfilled") {
      const { key, ...snap } = r.value;
      out[key] = snap;
    }
  }
  return out;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export interface ScoredModel {
  model: NimModel;
  score: number;
  provider: string;
  latencyMs: number | null;
  // Component breakdown for UI transparency
  qualityComponent: number;
  costComponent: number;
  throughputComponent: number;
}

/**
 * Score a single model across its eligible providers using the live formula:
 *   score = sweBench × qualityWeight × (1000 / latencyMs) × costFactor × throughputBonus
 *
 * Returns the best {score, provider, latencyMs} or null if no live provider is found.
 * Falls back to a static catalog-only score when snapshots are unavailable.
 */
function scoreModel(
  model: NimModel,
  phase: SessionPhase,
  snapshots: Record<string, ProviderSnapshot>,
  configuredProviders: Record<string, boolean>,
): { score: number; provider: string; latencyMs: number | null;
     qualityComponent: number; costComponent: number; throughputComponent: number } | null {
  const qualityWeight = PHASE_QUALITY_WEIGHTS[phase];
  const tc: ThroughputClass = model.throughputClass ?? "standard";
  const throughputBonus = PHASE_THROUGHPUT_BONUS[phase][tc];

  const sweBench = model.sweBenchScore
    ?? CATALOG_SWE_BENCH_SCORES[model.nimModelId]?.score
    ?? 50;

  // Eligible providers: NVIDIA free tier (preview) + configured partner providers.
  const eligible: string[] = [
    ...(model.nimTypes.includes("nim_type_preview") && configuredProviders["nvidia"] ? ["nvidia"] : []),
    ...model.partnerProviders.filter((p) => configuredProviders[p]),
  ];

  let best: { score: number; provider: string; latencyMs: number | null;
              qualityComponent: number; costComponent: number; throughputComponent: number } | null = null;

  for (const provider of eligible) {
    const snap = snapshots[provider];
    const live = snap?.live ?? false;
    const latencyMs = snap?.latencyMs ?? null;

    // costFactor: reward cheaper providers with a higher multiplier, scaled by
    // phase cost sensitivity. NVIDIA NIM (preview) is premium-priced; partner
    // providers (Together, DeepInfra, Vultr) are lower cost per token.
    // PHASE_COST_WEIGHTS amplifies or dampens the provider price differential so
    // that in cost-sensitive phases (swarm) economy providers pull far ahead,
    // while in quality phases (explore/plan) the gap shrinks significantly.
    const providerCostBase = provider === "nvidia" ? 0.95 : 1.05;
    const costFactor = 1.0 + (providerCostBase - 1.0) * PHASE_COST_WEIGHTS[phase];

    let score: number;
    let qualityComponent: number;
    let costComponent: number;
    let throughputComponent: number;

    if (live && latencyMs !== null) {
      // Full live formula — matches intent.ts semantics
      const latencyScore = 1000 / latencyMs;
      qualityComponent = sweBench * qualityWeight;
      costComponent = costFactor;
      throughputComponent = throughputBonus;
      score = qualityComponent * latencyScore * costComponent * throughputComponent;
    } else if (!live) {
      // Provider is down or unconfigured — skip unless it's the only option
      continue;
    } else {
      // Live but no latency reading (timeout before measurement) — use fallback latency
      const fallbackLatencyMs = 500;
      const latencyScore = 1000 / fallbackLatencyMs;
      qualityComponent = sweBench * qualityWeight;
      costComponent = costFactor;
      throughputComponent = throughputBonus;
      score = qualityComponent * latencyScore * costComponent * throughputComponent;
    }

    if (!best || score > best.score) {
      best = { score, provider, latencyMs, qualityComponent, costComponent, throughputComponent };
    }
  }

  // NOTE: No static fallback here. If no live provider was found for any eligible
  // provider, return null so callers can apply graceful-degradation semantics
  // (stay on current model rather than switch to an unreachable one).
  // scoreModelsForPhase can include unconfigured models for display purposes, but
  // getBestModelForPhase only acts on live-scored candidates.

  return best;
}

/**
 * Score all available NIM models for the given phase.
 * Returns models sorted descending by composite score.
 * Uses live provider latency probes for primary scoring.
 *
 * @param phase             - The current session phase.
 * @param configuredProviders - Optional pre-fetched provider config (avoids extra DB call).
 * @param snapshots          - Optional pre-fetched health snapshots (avoids duplicate probes).
 */
export async function scoreModelsForPhase(
  phase: SessionPhase,
  options?: {
    configuredProviders?: Record<string, boolean>;
    snapshots?: Record<string, ProviderSnapshot>;
  },
): Promise<ScoredModel[]> {
  const configuredProviders = options?.configuredProviders ?? getConfiguredProviders();

  let snapshots: Record<string, ProviderSnapshot>;
  if (options?.snapshots) {
    snapshots = options.snapshots;
  } else {
    try {
      snapshots = await getProviderSnapshots();
    } catch (err) {
      logger.warn({ err }, "Provider snapshot probe failed — using empty snapshot");
      snapshots = {};
    }
  }

  const allModels = await listNimModels();

  const scored: ScoredModel[] = [];
  for (const model of allModels) {
    const result = scoreModel(model, phase, snapshots, configuredProviders);
    if (result) {
      scored.push({ model, ...result });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Pick the best model+provider for a phase.
 *
 * A switch is suggested when the top-ranked live candidate differs from the
 * current (modelId, provider) pair — covering both model switches AND
 * provider-only improvements (e.g. same model with lower latency on a
 * different provider).
 *
 * Returns null if the current (model, provider) pair is already top-ranked,
 * or if the improvement gap is < 5% (avoids thrashing on near-ties).
 */
export async function getBestModelForPhase(
  phase: SessionPhase,
  currentModelId: string | null | undefined,
  options?: {
    configuredProviders?: Record<string, boolean>;
    snapshots?: Record<string, ProviderSnapshot>;
    currentProvider?: string | null;
  },
): Promise<{ model: NimModel; provider: string } | null> {
  const ranked = await scoreModelsForPhase(phase, options);
  if (ranked.length === 0) return null;

  const top = ranked[0]!;
  // No switch needed if both the model AND provider are already the best candidate.
  const isSameModelAndProvider =
    top.model.nimModelId === currentModelId && top.provider === (options?.currentProvider ?? null);
  if (isSameModelAndProvider) return null;

  // Only suggest a switch if the top candidate meaningfully beats the current (model, provider).
  const currentRank = ranked.find(
    (s) => s.model.nimModelId === currentModelId && s.provider === options?.currentProvider,
  );
  if (currentRank && top.score - currentRank.score < top.score * 0.05) return null;

  return { model: top.model, provider: top.provider };
}
