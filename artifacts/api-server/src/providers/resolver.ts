/**
 * resolver.ts — turns a model request into a concrete deployment.
 *
 * This is the single decision point that replaces the hardcoded
 * `provider: nimModelId ? "nim" : "vastai"` ternary in sessions-crud. It:
 *
 *   1. Parses whatever the user picked (hosted catalog id OR pasted HF URL).
 *   2. Inspects HF repos (sizing, format, architecture, custom code) via hf.ts.
 *   3. Applies the required-capability gate (GPU-only features stay GPU-only).
 *   4. Checks model→image compatibility so a Kimi-K3-class model never boots
 *      on an image that can't serve it.
 *   5. Returns a ModelDeployment the session layer can provision against.
 *
 * The module is pure (no DB, no side effects) so it is trivially testable.
 */

import { inspectHfRepo, parseHfRepoRef, type HfRepoInfo, type ModelFormat } from "./hf";
import { resolveProvider, providerMatches, type RequiredCapabilities } from "./capabilities";
import { getRegisteredProviders } from "./registry";
import type { ProviderId } from "./capabilities";
import type { ProviderCapabilities } from "./capabilities";

export interface HostedModelRef {
  provider: ProviderId;
  modelId: string;
}

export interface GpuProvisionPlan {
  provider: ProviderId;
  repoId: string;
  info: HfRepoInfo;
  /** GPU image tag selected by compatibility. */
  image: string;
  /** Offer-search sizing inputs. */
  diskGb: number;
  vramGb: number;
  numGpus: number;
  /** onstart env inputs. */
  modelRepo: string;
  defaultQuant: string;
  servedModelName: string;
  needsRemoteCode: boolean;
}

export interface ModelDeployment {
  kind: "hosted" | "gpu";
  /** Human-readable description for logs / dashboard. */
  label: string;
  hosted?: HostedModelRef;
  gpu?: GpuProvisionPlan;
  requiredCapabilities: RequiredCapabilities;
}

export interface ResolveModelRequest {
  /** Hosted catalog pick: either nimModelId, ollamaModelId, or openaiModelId. */
  nimModelId?: string;
  ollamaModelId?: string;
  openaiModelId?: string;
  /** Local Ollama model (on-box, cheap — used for cost-sensitive phases). */
  ollamaLocalModelId?: string;
  /** Pasted HF URL / repo id → self-orchestrated GPU session. */
  hfUrl?: string;
  /** Explicit capability overrides (e.g. dashboard "private" toggle, lane width). */
  requiredCapabilities?: RequiredCapabilities;
}

export class ModelResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolveError";
  }
}

/** Pick the image tag whose GPU arch is most compatible with the model's needs. */
export function pickGpuImage(
  providerCaps: ProviderCapabilities,
  info: Pick<HfRepoInfo, "sizeGb" | "quantHint" | "multimodal">,
  needsRemoteCode: boolean,
): string {
  if (providerCaps.images.length === 0) {
    throw new ModelResolveError(`provider ${providerCaps.provider} has no GPU images configured`);
  }
  if (needsRemoteCode || info.quantHint === "mxfp4-compressed-tensors" || info.multimodal) {
    // Custom-code / compressed-tensors / multimodal models require the newest
    // vLLM — use the latest stable image tag (cuda12.4 is the base for all).
    const cuda = providerCaps.images.find((i) => i.includes("cuda12.4")) ?? providerCaps.images[0];
    return cuda;
  }
  if (info.sizeGb >= 120) {
    // Big dense models: prefer the h100 image (higher compute headroom for
    // tensor-parallel on large contexts).
    const h100 = providerCaps.images.find((i) => i.includes("h100")) ?? providerCaps.images[0];
    return h100;
  }
  const a100 = providerCaps.images.find((i) => i.includes("a100")) ?? providerCaps.images[0];
  return a100;
}

/** Derive safe onstart identifiers from a repo id (e.g. "Kimi-K3-Abliterated-V1"). */
function deriveSlug(repoId: string): string {
  const short = repoId.split("/").pop() || repoId;
  return short.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

/**
 * Inspect an HF repo and build the GPU provisioning plan.
 * Throws ModelResolveError on incompatible/unsupported models.
 */
export async function planGpuSession(
  repoId: string,
  provider: ProviderId,
  extra: RequiredCapabilities = {},
): Promise<GpuProvisionPlan> {
  const info = await inspectHfRepo(repoId).catch((err: unknown) => {
    throw new ModelResolveError(`Failed to inspect model "${repoId}": ${err instanceof Error ? err.message : String(err)}`);
  });

  if (info.formats.includes("unknown")) {
    throw new ModelResolveError(
      `Model "${repoId}" contains no GGUF or safetensors weights — MIZI cannot serve it.`,
    );
  }

  const registry = getRegisteredProviders();
  const providerCaps = registry.find((p) => p.provider === provider);
  if (!providerCaps) {
    throw new ModelResolveError(`Provider "${provider}" is not registered`);
  }

  // Model→image compatibility gate: refuse to boot formats the provider's
  // images cannot serve. GGUF is CPU-servable so it passes everywhere.
  const requiredFormats: ModelFormat[] = info.formats.filter((f) => f !== "gguf");
  if (requiredFormats.length > 0) {
    const match = providerMatches(providerCaps, {
      requiredFormats,
      architecture: info.architecture,
      needsRemoteCode: info.needsRemoteCode,
    });
    if (!match.ok) {
      throw new ModelResolveError(
        `Model "${repoId}" (${info.formats.join(",")}) cannot run on ${provider}: ${match.reasons.join("; ")}`,
      );
    }
  }

  const image = pickGpuImage(providerCaps, info, info.needsRemoteCode);
  const slug = deriveSlug(repoId);

  return {
    provider,
    repoId,
    info,
    image,
    diskGb: info.sizing.diskGb,
    vramGb: info.sizing.vramGb,
    numGpus: info.sizing.numGpus,
    modelRepo: repoId,
    defaultQuant: slug,
    servedModelName: slug,
    needsRemoteCode: info.needsRemoteCode,
  };
}

/**
 * Resolve a create-session model request into a deployment.
 * - Hosted picks route to their provider endpoint.
 * - HF URLs route to a GPU provider (vast/vultr) with a provisioning plan.
 * - requiredCapabilities are merged in and gated here.
 */
export async function resolveModel(req: ResolveModelRequest): Promise<ModelDeployment> {
  const required: RequiredCapabilities = {
    ...(req.requiredCapabilities || {}),
  };

  const hfRef = req.hfUrl?.trim();
  if (hfRef) {
    const repoId = parseHfRepoRef(hfRef);
    // Paste an HF URL = custom weights = GPU-direct tier (hosted cannot serve it).
    required.modelSource = "custom-hf";
    required.contentPolicy = "mizi-only";

    const providers = resolveProvider(required, getRegisteredProviders());
    if (providers.length === 0) {
      throw new ModelResolveError(
        "No GPU provider is available for a custom HuggingFace model. Configure a Vast.ai/Vultr provisioner.",
      );
    }
    const provider = providers[0] as ProviderId;
    const gpu = await planGpuSession(repoId, provider, required);

    return {
      kind: "gpu",
      label: `${repoId} via ${provider} (GPU)`,
      gpu,
      requiredCapabilities: required,
    };
  }

  // Hosted catalog path.
  if (req.nimModelId) {
    required.modelSource = "catalog";
    if (required.contentPolicy === "mizi-only" || required.concurrency === "high" || required.dataResidency === "on-box") {
      const alt = resolveProvider(required, getRegisteredProviders());
      if (alt.length === 0) {
        throw new ModelResolveError(
          "The requested capabilities (privacy / wide concurrency / uncensored) require a GPU-direct provider. " +
          "Pick a Vast.ai or Vultr session instead.",
        );
      }
    }
    return {
      kind: "hosted",
      label: `${req.nimModelId} via nim`,
      hosted: { provider: "nim", modelId: req.nimModelId },
      requiredCapabilities: required,
    };
  }

  if (req.ollamaModelId) {
    return {
      kind: "hosted",
      label: `${req.ollamaModelId} via ollama-cloud`,
      hosted: { provider: "ollama-cloud", modelId: req.ollamaModelId },
      requiredCapabilities: required,
    };
  }

  if (req.ollamaLocalModelId) {
    return {
      kind: "hosted",
      label: `${req.ollamaLocalModelId} via ollama-local`,
      hosted: { provider: "ollama-local", modelId: req.ollamaLocalModelId },
      requiredCapabilities: required,
    };
  }

  if (req.openaiModelId) {
    return {
      kind: "hosted",
      label: `${req.openaiModelId} via openai`,
      hosted: { provider: "openai", modelId: req.openaiModelId },
      requiredCapabilities: required,
    };
  }

  throw new ModelResolveError(
    "No model was selected — provide nimModelId, ollamaModelId, ollamaLocalModelId, openaiModelId, or hfUrl.",
  );
}
