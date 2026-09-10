/**
 * capabilities.ts — provider capability model + resolution.
 *
 * Every inference backend (hosted or self-orchestrated) declares a capability
 * profile. Session creation carries an optional set of *required* capabilities
 * and `resolveProvider` returns the backends that can satisfy them — this is the
 * single gate that keeps GPU-only features (uncensored models, air-gap, wide
 * lanes) off hosted endpoints, and lets hosted endpoints carry the rest.
 *
 * See also: providers/registry.ts (the concrete provider list) and
 * providers/resolver.ts (turns a request into a deployment).
 */

import type { ModelFormat } from "./hf";

export type ProviderId = "nim" | "ollama-cloud" | "ollama-local" | "openai" | "vast" | "vultr";

export type ContentPolicy = "provider-enforced" | "mizi-only";
export type DataResidency = "cloud" | "on-box";
export type ModelSource = "catalog" | "custom-hf" | "both";

/** Fan-out budget above which a session is considered "wide" (GPU-direct tier). */
export const HIGH_CONCURRENCY_THRESHOLD = 16;

export interface ProviderCapabilities {
  provider: ProviderId;
  /** Can it serve arbitrary user-chosen weights (pasted HF URL)? */
  modelSource: ModelSource;
  /** Does the provider enforce its own content policy (blocks uncensored models)? */
  contentPolicy: ContentPolicy;
  /** Max concurrent lane/swarm workers before the backend should be considered wide. */
  maxConcurrentWorkers: number;
  /** Max context tokens the backend can serve. */
  maxContextTokens: number;
  /** Where prompts + repo content physically live. */
  dataResidency: DataResidency;
  /** Max model size (GB) the backend can serve; 0 = weights never touch a box. */
  maxModelSizeGb: number;
  /** Weight formats the backend can serve; [] = hosted only (no local weights). */
  supportedFormats: ModelFormat[];
  /** GPU image tags that satisfy this capability set (GPU providers only). */
  images: string[];
}

/**
 * Capabilities a session *requires*. Fields are optional: absent = no constraint.
 * The dashboard / MCP / CLI set these implicitly (see module doc) rather than
 * exposing raw capability flags to users.
 */
export interface RequiredCapabilities {
  modelSource?: ModelSource;
  contentPolicy?: "mizi-only";
  concurrency?: "high";
  dataResidency?: "on-box";
  maxModelSizeGb?: number;
  requiredFormats?: ModelFormat[];
  /** A specific model architecture (used to check image compatibility). */
  architecture?: string | null;
  needsRemoteCode?: boolean;
}

export interface CapabilityMatch {
  ok: boolean;
  reasons: string[];
}

/**
 * Check a single provider against required capabilities. Returns ok=false with
 * human-readable reasons when any constraint fails. `registry` may be omitted
 * (pure function — the caller decides which providers are registered).
 */
export function providerMatches(
  provider: ProviderCapabilities,
  required: RequiredCapabilities,
): CapabilityMatch {
  const reasons: string[] = [];

  if (required.modelSource) {
    const serves = provider.modelSource === "both" || provider.modelSource === required.modelSource;
    if (!serves) {
      reasons.push(
        `provider ${provider.provider} serves ${provider.modelSource} models only (required ${required.modelSource})`,
      );
    }
  }

  if (required.contentPolicy && provider.contentPolicy !== "mizi-only") {
    reasons.push(`provider ${provider.provider} enforces provider-side content policy (uncensored models require mizi-only)`);
  }

  if (required.concurrency === "high" && provider.maxConcurrentWorkers < HIGH_CONCURRENCY_THRESHOLD) {
    reasons.push(`provider ${provider.provider} supports ${provider.maxConcurrentWorkers} concurrent workers (< ${HIGH_CONCURRENCY_THRESHOLD})`);
  }

  if (required.dataResidency && provider.dataResidency !== "on-box") {
    reasons.push(`provider ${provider.provider} is cloud-resident (required on-box)`);
  }

  if (required.maxModelSizeGb && required.maxModelSizeGb > 0) {
    if (provider.maxModelSizeGb === 0 || provider.maxModelSizeGb < required.maxModelSizeGb) {
      reasons.push(`provider ${provider.provider} cannot serve a ${required.maxModelSizeGb} GB model`);
    }
  }

  if (required.requiredFormats && required.requiredFormats.length > 0) {
    const lacks = required.requiredFormats.filter(
      (f) => f !== "unknown" && !provider.supportedFormats.includes(f),
    );
    if (lacks.length > 0) {
      reasons.push(`provider ${provider.provider} does not support format(s): ${lacks.join(", ")}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Picks the minimal set of providers that satisfy every required capability.
 * GPU providers are ordered after hosted ones so hosted is preferred when both
 * qualify (hosted is cheaper for a given capability set). `pick` returns the
 * first provider that matches when specified.
 */
export function resolveProvider(
  required: RequiredCapabilities,
  registry: ProviderCapabilities[],
  opts: { pick?: ProviderId } = {},
): ProviderId[] {
  const matches = registry.filter((p) => providerMatches(p, required).ok);

  if (opts.pick) {
    const exact = matches.find((p) => p.provider === opts.pick);
    return exact ? [exact.provider] : [];
  }

  // Hosted first (cheaper per token for catalog work), GPU after.
  const order: Record<ProviderId, number> = { nim: 0, "ollama-cloud": 1, openai: 2, "ollama-local": 3, vast: 4, vultr: 5 };
  return matches
    .sort((a, b) => (order[a.provider] ?? 9) - (order[b.provider] ?? 9))
    .map((p) => p.provider);
}
