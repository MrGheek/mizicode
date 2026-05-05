import { db, nimCatalogTable } from "@workspace/db";
import { logger } from "../lib/logger";

export type NimTier = "free" | "partner";

export interface NimModel {
  nimModelId: string;
  displayName: string;
  nimTypes: string[];
  partnerProviders: string[];
  shortDescription: string;
  usecaseTags: string[];
  contextLength: string | null;
  syncedAt: string;
}

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
  "moonshotai/kimi-k2-instruct":                 [],
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
    nimModelId: "moonshotai/kimi-k2-instruct",
    displayName: "Kimi K2",
    nimTypes: ["nim_type_preview"],
    partnerProviders: [],
    shortDescription: "Kimi K2 base instruct model. Free on NVIDIA-hosted endpoint.",
    usecaseTags: ["coding", "chat"],
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

function getNimApiKey(): string | undefined {
  return process.env["NVIDIA_NIM_API_KEY"];
}

async function fetchNimModels(): Promise<string[]> {
  const key = getNimApiKey();
  if (!key) return [];
  try {
    const res = await fetch(`${NIM_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

export async function syncNimCatalog(): Promise<void> {
  try {
    const liveModelIds = await fetchNimModels();
    const liveSet = new Set(liveModelIds);
    const now = new Date();

    for (const model of SEED_MODELS) {
      if (liveModelIds.length > 0 && !liveSet.has(model.nimModelId)) {
        continue;
      }
      await db
        .insert(nimCatalogTable)
        .values({
          nimModelId: model.nimModelId,
          displayName: model.displayName,
          nimTypes: model.nimTypes,
          partnerProviders: model.partnerProviders,
          shortDescription: model.shortDescription ?? null,
          usecaseTags: model.usecaseTags,
          contextLength: model.contextLength ?? null,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: nimCatalogTable.nimModelId,
          set: {
            displayName: model.displayName,
            nimTypes: model.nimTypes,
            partnerProviders: model.partnerProviders,
            shortDescription: model.shortDescription ?? null,
            usecaseTags: model.usecaseTags,
            contextLength: model.contextLength ?? null,
            syncedAt: now,
          },
        });
    }
    logger.info({ count: SEED_MODELS.length }, "NIM catalog synced");
  } catch (err) {
    logger.error({ err }, "NIM catalog sync failed");
  }
}

export async function listNimModels(nimType?: string): Promise<NimModel[]> {
  const rows = await db.select().from(nimCatalogTable);
  const models: NimModel[] = rows.map((r) => ({
    nimModelId: r.nimModelId,
    displayName: r.displayName,
    nimTypes: (r.nimTypes as string[]) ?? [],
    partnerProviders: (r.partnerProviders as string[]) ?? [],
    shortDescription: r.shortDescription ?? "",
    usecaseTags: (r.usecaseTags as string[]) ?? [],
    contextLength: r.contextLength ?? null,
    syncedAt: r.syncedAt.toISOString(),
  }));

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
