/**
 * registry.ts — the concrete provider capability registry.
 *
 * This is the single source of truth for what each inference backend can and
 * cannot do. The resolver (providers/resolver.ts) consults it via
 * `resolveProvider`; sessions-crud and the MCP tools use it to gate features.
 *
 * NOTE: Provider *config* (apiBase, apiKey env vars) lives in nim-catalog.ts
 * (hosted providers) and services/vastai.ts + services/fly.ts (orchestration).
 * This module only declares *capability* metadata so there is one obvious place
 * to answer "can backend X serve requirement Y?".
 */

import type { ProviderCapabilities } from "./capabilities";
import type { ModelFormat } from "./hf";

// Formats the GPU workspace images can serve. vLLM covers safetensors (incl.
// FP8/mxFP4 via compressed-tensors in recent releases); GGUF is served by vLLM
// or llama.cpp on the same image. EXL2/AWQ/GPTQ are supported by llama.cpp /
// vLLM-mixed toolchains — kept in the GPU list but gated per-architecture by the
// resolver, not blindly enabled.
const GPU_FORMATS: ModelFormat[] = ["safetensors", "gguf", "exl2", "awq", "gptq"];

export const GPU_IMAGE_TAGS: Record<string, string> = {
  cuda12_4: "gheeklabs/mizi-gpu:cuda12.4",
  a100: "gheeklabs/mizi-gpu:a100",
  h100: "gheeklabs/mizi-gpu:h100",
};

/**
 * Env-conditional capability bits so local/cloud builds behave consistently:
 * hosted providers only exist when their key env var is configured.
 */
function hostedProviderConfigured(envKey: string): boolean {
  return !!process.env[envKey] || process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] !== undefined;
}

export const PROVIDER_REGISTRY: ProviderCapabilities[] = [
  {
    provider: "nim",
    modelSource: "catalog",
    contentPolicy: "provider-enforced",
    maxConcurrentWorkers: 4,
    maxContextTokens: 128_000,
    dataResidency: "cloud",
    maxModelSizeGb: 0,
    supportedFormats: [],
    images: [],
  },
  {
    provider: "ollama-cloud",
    modelSource: "catalog",
    contentPolicy: "provider-enforced",
    maxConcurrentWorkers: 8,
    maxContextTokens: 131_072,
    dataResidency: "cloud",
    maxModelSizeGb: 0,
    supportedFormats: [],
    images: [],
  },
  {
    provider: "ollama-local",
    modelSource: "catalog",
    contentPolicy: "mizi-only",
    maxConcurrentWorkers: 4,
    maxContextTokens: 131_072,
    dataResidency: "on-box",
    maxModelSizeGb: 0,
    supportedFormats: ["gguf"],
    images: [],
  },
  {
    provider: "openai",
    modelSource: "catalog",
    contentPolicy: "provider-enforced",
    maxConcurrentWorkers: 8,
    maxContextTokens: 200_000,
    dataResidency: "cloud",
    maxModelSizeGb: 0,
    supportedFormats: [],
    images: [],
  },
  {
    provider: "vast",
    modelSource: "both",
    contentPolicy: "mizi-only",
    maxConcurrentWorkers: 250,
    maxContextTokens: 1_048_576,
    dataResidency: "on-box",
    maxModelSizeGb: 2_000,
    supportedFormats: GPU_FORMATS,
    images: [
      GPU_IMAGE_TAGS.cuda12_4,
      GPU_IMAGE_TAGS.a100,
      GPU_IMAGE_TAGS.h100,
    ],
  },
  {
    provider: "vultr",
    modelSource: "both",
    contentPolicy: "mizi-only",
    maxConcurrentWorkers: 250,
    maxContextTokens: 1_048_576,
    dataResidency: "on-box",
    maxModelSizeGb: 2_000,
    supportedFormats: GPU_FORMATS,
    images: [
      GPU_IMAGE_TAGS.cuda12_4,
      GPU_IMAGE_TAGS.a100,
      GPU_IMAGE_TAGS.h100,
    ],
  },
];

/** Filter registry to providers that are actually configured in this deployment. */
export function getRegisteredProviders(): ProviderCapabilities[] {
  return PROVIDER_REGISTRY.filter((p) => {
    if (p.provider === "nim") return hostedProviderConfigured("NVIDIA_NIM_API_KEY");
    if (p.provider === "ollama-cloud") return hostedProviderConfigured("OLLAMA_API_KEY");
    if (p.provider === "openai") return hostedProviderConfigured("OPENAI_API_KEY");
    // ollama-local is always registered — it is live only when a local Ollama
    // daemon answers on OLLAMA_BASE_URL (probed at routing time, not here).
    // GPU providers are configurable even if no key is present (VASTAI_API_KEY is
    // required at instance-creation time, not for capability declaration).
    return true;
  });
}
