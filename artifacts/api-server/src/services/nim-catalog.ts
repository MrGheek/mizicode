import { db, nimCatalogTable } from "@workspace/db";
import { notInArray } from "drizzle-orm";
import { logger } from "../lib/logger";

export type NimTier = "free" | "partner";

export type ThroughputClass = "high" | "standard" | "economy";

export interface NimModel {
  nimModelId: string;
  displayName: string;
  nimTypes: string[];
  partnerProviders: string[];
  shortDescription: string;
  usecaseTags: string[];
  contextLength: string | null;
  sweBenchScore?: number | null;
  benchmarkVariant?: string | null;
  throughputClass?: ThroughputClass | null;
  syncedAt: string;
}

// Known SWE-bench scores used to seed the catalog (source of truth moves to DB over time)
export const CATALOG_SWE_BENCH_SCORES: Record<string, { score: number; variant: string }> = {
  "minimaxai/minimax-m2.5":                      { score: 80.2, variant: "SWE-bench Verified" },
  "moonshotai/kimi-k2.6":                        { score: 65.8, variant: "SWE-bench Verified" },
  "deepseek-ai/deepseek-v4-pro":                 { score: 67.0, variant: "SWE-bench Verified" },
  "moonshotai/kimi-k2-instruct-0905":            { score: 63.6, variant: "SWE-bench Verified" },
  "moonshotai/kimi-k2-thinking":                 { score: 63.6, variant: "SWE-bench Verified" },
  "qwen/qwen3-coder-480b-a35b-instruct":         { score: 62.0, variant: "SWE-bench Verified" },
  "z-ai/glm-5.1":                                { score: 58.4, variant: "SWE-bench Pro" },
  "mistralai/devstral-2-123b-instruct-2512":     { score: 58.0, variant: "SWE-bench Verified" },
  "deepseek-ai/deepseek-v4-flash":               { score: 55.0, variant: "SWE-bench Verified" },
  "qwen/qwen3.5-397b-a17b":                      { score: 60.0, variant: "SWE-bench Verified" },
  "qwen/qwen3.5-122b-a10b":                      { score: 55.0, variant: "SWE-bench Verified" },
  "minimaxai/minimax-m2.7":                      { score: 55.0, variant: "SWE-bench Verified" },
  "z-ai/glm-4.7":                                { score: 45.0, variant: "SWE-bench Verified" },
  "mistralai/magistral-small-2506":              { score: 38.0, variant: "SWE-bench Verified" },
  "mistralai/mistral-large-3-675b-instruct-2512":{ score: 46.0, variant: "SWE-bench Verified" },
  "bytedance/seed-oss-36b-instruct":             { score: 42.0, variant: "SWE-bench Verified" },
};

// Throughput class hints: "high" for MoE models (large total / small active params)
// which tend to be fast per-token; "standard" for mid-size dense; "economy" for small.
export const CATALOG_THROUGHPUT_CLASS: Record<string, ThroughputClass> = {
  "moonshotai/kimi-k2.6":                        "high",
  "moonshotai/kimi-k2-instruct-0905":            "high",
  "moonshotai/kimi-k2-thinking":                 "high",
  "minimaxai/minimax-m2.7":                      "high",
  "minimaxai/minimax-m2.5":                      "high",
  "qwen/qwen3-coder-480b-a35b-instruct":         "high",
  "qwen/qwen3.5-397b-a17b":                      "high",
  "qwen/qwen3.5-122b-a10b":                      "high",
  "deepseek-ai/deepseek-v4-pro":                 "high",
  "deepseek-ai/deepseek-v4-flash":               "high",
  "mistralai/mistral-large-3-675b-instruct-2512":"high",
  "z-ai/glm-5.1":                                "standard",
  "mistralai/devstral-2-123b-instruct-2512":     "standard",
  "z-ai/glm-4.7":                                "economy",
  "mistralai/magistral-small-2506":              "economy",
  "bytedance/seed-oss-36b-instruct":             "economy",
};

const PARTNER_PROVIDERS: Record<string, string[]> = {
  "moonshotai/kimi-k2.6":                        ["vultr", "together", "bitdeer"],
  "deepseek-ai/deepseek-v4-pro":                 ["vultr", "together", "bitdeer", "deepinfra"],
  "deepseek-ai/deepseek-v4-flash":               ["vultr", "together", "bitdeer", "deepinfra"],
  "z-ai/glm-5.1":                                ["together", "bitdeer"],
  "z-ai/glm5":                                   ["together"],
  "qwen/qwen3.5-397b-a17b":                      ["together", "deepinfra"],
  "qwen/qwen3.5-122b-a10b":                      ["together", "deepinfra"],
  "minimaxai/minimax-m2.5":                      ["vultr", "together"],
  "bytedance/seed-oss-36b-instruct":             ["together"],
  "moonshotai/kimi-k2-instruct-0905":            [],
  "moonshotai/kimi-k2-thinking":                 [],
  "minimaxai/minimax-m2.7":                      ["vultr"],
  "z-ai/glm-4.7":                                [],
  "qwen/qwen3-coder-480b-a35b-instruct":         ["deepinfra"],
  "mistralai/devstral-2-123b-instruct-2512":     [],
  "mistralai/magistral-small-2506":              [],
  "mistralai/mistral-large-3-675b-instruct-2512":["together"],
};

const SEED_MODELS: Omit<NimModel, "syncedAt">[] = [
  {
    nimModelId: "moonshotai/kimi-k2.6",
    displayName: "Kimi K2.6",
    nimTypes: ["nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["moonshotai/kimi-k2.6"],
    shortDescription: "Frontier coding model from Moonshot AI. Best-in-class agentic coding on partner clouds.",
    usecaseTags: ["coding", "agentic", "reasoning"],
    contextLength: "128K",
  },
  {
    nimModelId: "moonshotai/kimi-k2-instruct-0905",
    displayName: "Kimi K2 (Sept)",
    nimTypes: ["nim_type_preview"],
    partnerProviders: [],
    shortDescription: "Kimi K2 September checkpoint. Free on NVIDIA-hosted endpoint.",
    usecaseTags: ["coding", "chat"],
    contextLength: "128K",
  },
  {
    nimModelId: "moonshotai/kimi-k2-thinking",
    displayName: "Kimi K2 Thinking",
    nimTypes: ["nim_type_preview"],
    partnerProviders: [],
    shortDescription: "Kimi K2 with extended chain-of-thought reasoning. Free on NVIDIA-hosted endpoint.",
    usecaseTags: ["coding", "reasoning"],
    contextLength: "128K",
  },
  {
    nimModelId: "minimaxai/minimax-m2.7",
    displayName: "MiniMax M2.7",
    nimTypes: ["nim_type_preview", "nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["minimaxai/minimax-m2.7"],
    shortDescription: "MiniMax M2.7 MoE model. Free on NVIDIA endpoint; also on Vultr.",
    usecaseTags: ["coding", "chat"],
    contextLength: "64K",
  },
  {
    nimModelId: "z-ai/glm-4.7",
    displayName: "GLM 4.7",
    nimTypes: ["nim_type_preview"],
    partnerProviders: [],
    shortDescription: "GLM 4.7 from Zhipu AI. Free on NVIDIA-hosted endpoint.",
    usecaseTags: ["coding", "chat"],
    contextLength: "128K",
  },
  {
    nimModelId: "qwen/qwen3-coder-480b-a35b-instruct",
    displayName: "Qwen3 Coder 480B",
    nimTypes: ["nim_type_preview", "nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["qwen/qwen3-coder-480b-a35b-instruct"],
    shortDescription: "Qwen3 Coder 480B MoE (35B active). Free on NVIDIA endpoint.",
    usecaseTags: ["coding", "agentic"],
    contextLength: "128K",
  },
  {
    nimModelId: "mistralai/devstral-2-123b-instruct-2512",
    displayName: "Devstral 2",
    nimTypes: ["nim_type_preview"],
    partnerProviders: [],
    shortDescription: "Mistral's dedicated coding model. Free on NVIDIA-hosted endpoint.",
    usecaseTags: ["coding", "agentic"],
    contextLength: "128K",
  },
  {
    nimModelId: "mistralai/magistral-small-2506",
    displayName: "Magistral Small",
    nimTypes: ["nim_type_preview"],
    partnerProviders: [],
    shortDescription: "Small reasoning model from Mistral. Free on NVIDIA-hosted endpoint.",
    usecaseTags: ["coding", "reasoning"],
    contextLength: "40K",
  },
  {
    nimModelId: "mistralai/mistral-large-3-675b-instruct-2512",
    displayName: "Mistral Large 3",
    nimTypes: ["nim_type_preview", "nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["mistralai/mistral-large-3-675b-instruct-2512"],
    shortDescription: "Mistral Large 3 675B — powerful general-purpose model. Free on NVIDIA endpoint.",
    usecaseTags: ["coding", "chat", "reasoning"],
    contextLength: "128K",
  },
  {
    nimModelId: "deepseek-ai/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    nimTypes: ["nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["deepseek-ai/deepseek-v4-pro"],
    shortDescription: "DeepSeek V4 Pro — top-tier coding via partner cloud.",
    usecaseTags: ["coding", "reasoning"],
    contextLength: "128K",
  },
  {
    nimModelId: "deepseek-ai/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    nimTypes: ["nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["deepseek-ai/deepseek-v4-flash"],
    shortDescription: "DeepSeek V4 Flash — faster, lower-cost variant via partner cloud.",
    usecaseTags: ["coding"],
    contextLength: "64K",
  },
  {
    nimModelId: "z-ai/glm-5.1",
    displayName: "GLM 5.1",
    nimTypes: ["nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["z-ai/glm-5.1"],
    shortDescription: "GLM 5.1 from Zhipu AI. Best open-weight SWE-Bench Pro score. Partner cloud only.",
    usecaseTags: ["coding", "agentic"],
    contextLength: "128K",
  },
  {
    nimModelId: "qwen/qwen3.5-397b-a17b",
    displayName: "Qwen3.5 397B",
    nimTypes: ["nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["qwen/qwen3.5-397b-a17b"],
    shortDescription: "Qwen3.5 397B MoE via partner cloud.",
    usecaseTags: ["coding", "chat"],
    contextLength: "128K",
  },
  {
    nimModelId: "qwen/qwen3.5-122b-a10b",
    displayName: "Qwen3.5 122B",
    nimTypes: ["nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["qwen/qwen3.5-122b-a10b"],
    shortDescription: "Qwen3.5 122B MoE via partner cloud.",
    usecaseTags: ["coding", "chat"],
    contextLength: "128K",
  },
  {
    nimModelId: "minimaxai/minimax-m2.5",
    displayName: "MiniMax M2.5",
    nimTypes: ["nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["minimaxai/minimax-m2.5"],
    shortDescription: "MiniMax M2.5 via partner cloud. Strong SWE-Bench performance.",
    usecaseTags: ["coding", "agentic"],
    contextLength: "64K",
  },
  {
    nimModelId: "bytedance/seed-oss-36b-instruct",
    displayName: "Seed OSS 36B",
    nimTypes: ["nim_type_upgrade_available"],
    partnerProviders: PARTNER_PROVIDERS["bytedance/seed-oss-36b-instruct"],
    shortDescription: "ByteDance Seed OSS 36B via partner cloud.",
    usecaseTags: ["coding", "chat"],
    contextLength: "32K",
  },
];

const NIM_API_BASE = "https://integrate.api.nvidia.com/v1";

/** Fetch model IDs from a provider's /models endpoint. Returns [] on failure. */
async function fetchProviderModels(apiBase: string, apiKey: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${apiBase}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return [];
    const data = await res.json() as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * Sync the NIM catalog using live data from all configured providers.
 *
 * Strategy:
 * 1. Fetch model IDs from NVIDIA /v1/models (if NVIDIA key configured).
 * 2. Fetch model IDs from each configured partner's /models endpoint.
 * 3. Build a cross-reference: for each model ID seen on a partner, record it as
 *    a partner provider for that model — this dynamically discovers new partner models.
 * 4. Upsert SEED_MODELS that are confirmed live on at least one provider, enriched
 *    with any additional partner providers discovered in step 3.
 * 5. For model IDs from partners that are NOT in SEED_MODELS, insert them with
 *    nim_type_upgrade_available and the discovering provider as partner.
 */
export async function syncNimCatalog(): Promise<void> {
  try {
    const now = new Date();

    // Step 1: Fetch NVIDIA live model IDs
    const nvidiaKey = process.env["NVIDIA_NIM_API_KEY"];
    const nvidiaModels = nvidiaKey
      ? await fetchProviderModels(NIM_API_BASE, nvidiaKey)
      : [];
    const nvidiaSet = new Set(nvidiaModels);

    // Step 2: Fetch partner model IDs from each configured partner
    const partnerModelsByProvider: Record<string, Set<string>> = {};
    for (const [providerKey, pc] of Object.entries(PROVIDER_CONFIG)) {
      if (providerKey === "nvidia") continue;
      const apiKey = process.env[pc.envKey];
      if (!apiKey) continue;
      const models = await fetchProviderModels(pc.apiBase, apiKey);
      partnerModelsByProvider[providerKey] = new Set(models);
    }

    // Step 3: Build reverse map: modelId → partner providers that serve it
    const discoveredPartners: Record<string, string[]> = {};
    for (const [providerKey, modelSet] of Object.entries(partnerModelsByProvider)) {
      for (const modelId of modelSet) {
        if (!discoveredPartners[modelId]) discoveredPartners[modelId] = [];
        discoveredPartners[modelId].push(providerKey);
      }
    }

    // Step 4: Upsert SEED_MODELS (enriched with any additionally discovered partners)
    const seedSet = new Set(SEED_MODELS.map((m) => m.nimModelId));
    let upserted = 0;

    for (const model of SEED_MODELS) {
      const onNvidia = nvidiaSet.has(model.nimModelId);
      const extraPartners = discoveredPartners[model.nimModelId] ?? [];
      // Merge seed partners with live-discovered partners, deduplicated
      const mergedPartners = Array.from(
        new Set([...model.partnerProviders, ...extraPartners])
      );
      const onPartner = mergedPartners.some((p) => partnerModelsByProvider[p]?.has(model.nimModelId));

      // Skip if NVIDIA is configured but the model isn't live anywhere (covers
      // the case where a model reaches end-of-life and NVIDIA drops it, even when
      // no partner keys are configured).
      const nvidiaConfigured = !!nvidiaKey;
      const anyPartnerConfigured = Object.keys(partnerModelsByProvider).length > 0;
      if (nvidiaConfigured && !onNvidia && (anyPartnerConfigured ? !onPartner : true)) {
        continue;
      }

      const benchSeed = CATALOG_SWE_BENCH_SCORES[model.nimModelId];
      const throughputClass = CATALOG_THROUGHPUT_CLASS[model.nimModelId] ?? null;
      await db
        .insert(nimCatalogTable)
        .values({
          nimModelId: model.nimModelId,
          displayName: model.displayName,
          nimTypes: model.nimTypes,
          partnerProviders: mergedPartners,
          shortDescription: model.shortDescription ?? null,
          usecaseTags: model.usecaseTags,
          contextLength: model.contextLength ?? null,
          sweBenchScore: benchSeed?.score ?? null,
          benchmarkVariant: benchSeed?.variant ?? null,
          throughputClass,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: nimCatalogTable.nimModelId,
          set: {
            displayName: model.displayName,
            nimTypes: model.nimTypes,
            partnerProviders: mergedPartners,
            shortDescription: model.shortDescription ?? null,
            usecaseTags: model.usecaseTags,
            contextLength: model.contextLength ?? null,
            // Only update benchmark fields if we have values (don't overwrite manual data)
            ...(benchSeed ? { sweBenchScore: benchSeed.score, benchmarkVariant: benchSeed.variant } : {}),
            ...(throughputClass ? { throughputClass } : {}),
            syncedAt: now,
          },
        });
      upserted++;
    }

    // Step 4.5: Auto-upsert NVIDIA-live models not covered by SEED_MODELS.
    // SEED_MODELS provides hand-curated metadata for known models; any model that
    // NVIDIA makes live but isn't in SEED_MODELS is auto-discovered here so the
    // dashboard stays current without manual SEED_MODELS maintenance.
    // Seeded models are always preferred — this only fills the gaps.
    let nvidiaDiscovered = 0;
    if (nvidiaKey) {
      for (const modelId of nvidiaSet) {
        if (seedSet.has(modelId)) continue; // Already handled by Step 4
        const rawName = modelId.split("/").pop() ?? modelId;
        const displayName = rawName
          .split(/[-_.]/g)
          .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
          .join(" ");
        const extraPartners = discoveredPartners[modelId] ?? [];
        const benchSeed = CATALOG_SWE_BENCH_SCORES[modelId];
        const throughputClass = CATALOG_THROUGHPUT_CLASS[modelId] ?? null;
        await db
          .insert(nimCatalogTable)
          .values({
            nimModelId: modelId,
            displayName,
            nimTypes: extraPartners.length > 0 ? ["nim_type_preview", "nim_type_upgrade_available"] : ["nim_type_preview"],
            partnerProviders: extraPartners,
            shortDescription: "Available on NVIDIA NIM. Free on hosted endpoint.",
            usecaseTags: [],
            contextLength: null,
            sweBenchScore: benchSeed?.score ?? null,
            benchmarkVariant: benchSeed?.variant ?? null,
            throughputClass,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: nimCatalogTable.nimModelId,
            set: {
              // Update live-status fields but don't overwrite any manually set display name,
              // description, or tags in case an admin enriched the record since last sync.
              partnerProviders: extraPartners,
              ...(benchSeed ? { sweBenchScore: benchSeed.score, benchmarkVariant: benchSeed.variant } : {}),
              ...(throughputClass ? { throughputClass } : {}),
              syncedAt: now,
            },
          });
        nvidiaDiscovered++;
      }
    }

    // Step 5: Insert dynamically discovered partner models not in SEED_MODELS
    let discovered = 0;
    for (const [modelId, providers] of Object.entries(discoveredPartners)) {
      if (seedSet.has(modelId)) continue; // Already handled above
      if (nvidiaSet.has(modelId)) continue; // Already handled by Step 4.5
      // Infer a display name from the model ID (last segment, title-cased)
      const rawName = modelId.split("/").pop() ?? modelId;
      const displayName = rawName
        .split(/[-_]/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" ");
      await db
        .insert(nimCatalogTable)
        .values({
          nimModelId: modelId,
          displayName,
          nimTypes: ["nim_type_upgrade_available"],
          partnerProviders: providers,
          shortDescription: `Discovered via ${providers.map((p) => PROVIDER_CONFIG[p]?.displayName ?? p).join(", ")}.`,
          usecaseTags: [],
          contextLength: null,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: nimCatalogTable.nimModelId,
          set: {
            partnerProviders: providers,
            syncedAt: now,
          },
        });
      discovered++;
    }

    // Step 6: Prune stale records — delete any DB entry that is no longer in
    // SEED_MODELS and was not discovered from any live partner provider.
    // Without this, EOL models removed from SEED_MODELS linger in the DB and
    // keep appearing as selectable options in the dashboard.
    const keepIds = [...seedSet, ...nvidiaSet, ...Object.keys(discoveredPartners)];
    let pruned = 0;
    if (keepIds.length > 0) {
      const result = await db
        .delete(nimCatalogTable)
        .where(notInArray(nimCatalogTable.nimModelId, keepIds));
      pruned = (result as { rowCount?: number }).rowCount ?? 0;
    }

    logger.info({ upserted, nvidiaDiscovered, discovered, pruned }, "NIM catalog synced");
  } catch (err) {
    logger.error({ err }, "NIM catalog sync failed");
  }
}

export async function listNimModels(nimType?: string): Promise<NimModel[]> {
  const rows = await db.select().from(nimCatalogTable);
  const models: NimModel[] = rows.map((r) => {
    // Prefer DB-stored score; fall back to seed map for models not yet synced
    const seed = CATALOG_SWE_BENCH_SCORES[r.nimModelId];
    const throughputSeed = CATALOG_THROUGHPUT_CLASS[r.nimModelId];
    return {
      nimModelId: r.nimModelId,
      displayName: r.displayName,
      nimTypes: (r.nimTypes as string[]) ?? [],
      partnerProviders: (r.partnerProviders as string[]) ?? [],
      shortDescription: r.shortDescription ?? "",
      usecaseTags: (r.usecaseTags as string[]) ?? [],
      contextLength: r.contextLength ?? null,
      sweBenchScore: r.sweBenchScore ?? seed?.score ?? null,
      benchmarkVariant: r.benchmarkVariant ?? seed?.variant ?? null,
      throughputClass: (r.throughputClass as ThroughputClass | null) ?? throughputSeed ?? null,
      syncedAt: r.syncedAt.toISOString(),
    };
  });

  if (nimType) {
    return models.filter((m) => m.nimTypes.includes(nimType));
  }
  return models;
}

export function getConfiguredProviders(): Record<string, boolean> {
  return {
    nvidia: !!process.env["NVIDIA_NIM_API_KEY"],
    vultr: !!process.env["VULTR_INFERENCE_API_KEY"],
    together: !!process.env["TOGETHER_API_KEY"],
    deepinfra: !!process.env["DEEPINFRA_API_KEY"],
  };
}

/**
 * Per-token pricing for inference providers billed by token consumption rather
 * than by the hour.  Rates are in USD per token (combined prompt + completion).
 * NVIDIA NIM endpoints are free — they have no entry here.
 */
export const PROVIDER_TOKEN_RATES: Record<string, number> = {
  // Vultr Cloud Inference: $1.40 / 1M tokens → $0.0000014 / token
  // Source: https://www.vultr.com/products/cloud-inference/
  vultr: 0.0000014,
};

export const PROVIDER_CONFIG: Record<string, { apiBase: string; envKey: string; displayName: string; pricingUrl: string }> = {
  nvidia: {
    apiBase: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_NIM_API_KEY",
    displayName: "NVIDIA NIM",
    pricingUrl: "https://build.nvidia.com",
  },
  vultr: {
    apiBase: "https://api.vultrinference.com/v1",
    envKey: "VULTR_INFERENCE_API_KEY",
    displayName: "Vultr",
    pricingUrl: "https://www.vultr.com/products/cloud-inference/",
  },
  together: {
    apiBase: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    displayName: "Together AI",
    pricingUrl: "https://www.together.ai/pricing",
  },
  deepinfra: {
    apiBase: "https://api.deepinfra.com/v1/openai",
    envKey: "DEEPINFRA_API_KEY",
    displayName: "DeepInfra",
    pricingUrl: "https://deepinfra.com/pricing",
  },
};
