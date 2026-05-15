import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listNimModels, getConfiguredProviders, PROVIDER_CONFIG } from "../../services/nim-catalog.js";
import { getAllProfiles } from "../../services/profiles.js";
import * as vastai from "../../services/vastai.js";
import { logger } from "../../lib/logger.js";

export function registerModelCatalogTools(server: McpServer): void {
  server.registerTool("list_nim_catalog", {
    description: "[Read] List available NVIDIA NIM models and providers.",
    inputSchema: z.object({
      nimType: z.string().optional().describe("Filter by NIM type (e.g. nim_type_preview)"),
    }),
  }, async ({ nimType }) => {
    const models = await listNimModels(nimType);
    const configured = getConfiguredProviders();
    return { content: [{ type: "text", text: JSON.stringify({ models, configured, count: models.length }, null, 2) }] };
  });

  server.registerTool("get_nim_health", {
    description: "[Read] Get real-time latency and liveness for configured NIM providers.",
    inputSchema: z.object({}),
  }, async () => {
    const configured = getConfiguredProviders();
    const results = await Promise.all(
      Object.entries(PROVIDER_CONFIG).map(async ([key, info]) => {
        if (!configured[key]) {
          return { key, displayName: info.displayName, configured: false, live: false, latencyMs: null };
        }
        const apiKey = process.env[info.envKey];
        const start = Date.now();
        try {
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 5000);
          const resp = await fetch(`${info.apiBase}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
          clearTimeout(tid);
          return { key, displayName: info.displayName, configured: true, live: resp.status < 500, latencyMs: Date.now() - start };
        } catch {
          return { key, displayName: info.displayName, configured: true, live: false, latencyMs: null };
        }
      })
    );
    return { content: [{ type: "text", text: JSON.stringify({ providers: results }, null, 2) }] };
  });

  server.registerTool("list_gpu_offers", {
    description: "[Read] Search Vast.ai for live GPU instances matching a profile.",
    inputSchema: z.object({
      profileId: z.number().int().optional().describe("Hardware profile ID to use as search template"),
      gpuName: z.string().optional().describe("GPU model name filter"),
      numGpus: z.number().int().optional().describe("Number of GPUs required"),
      maxPrice: z.number().optional().describe("Maximum price per hour in USD"),
      limit: z.number().int().min(1).max(50).optional().describe("Max offers (default 10)"),
    }),
  }, async ({ profileId, gpuName, numGpus, maxPrice, limit }) => {
    try {
      let searchParams: vastai.VastSearchParams = { limit: limit ?? 10 };

      if (profileId) {
        const { getProfileById } = await import("../../services/profiles.js");
        const profile = await getProfileById(profileId);
        if (profile) {
          const ps = (profile.searchParams as Record<string, unknown>) || {};
          searchParams = {
            ...searchParams,
            gpu_name: ps.gpu_name as string,
            num_gpus: ps.num_gpus as number,
            min_gpu_ram: ps.min_gpu_ram as number,
            disk_space: profile.diskSizeGb,
          };
        }
      }

      if (gpuName) searchParams.gpu_name = gpuName;
      if (numGpus) searchParams.num_gpus = numGpus;
      if (maxPrice) searchParams.extra = { ...searchParams.extra, dph_total: { lte: maxPrice } };

      const offers = await vastai.searchOffers(searchParams);
      const mapped = (offers || []).map((o: Record<string, unknown>) => ({
        id: o.id,
        gpuName: o.gpu_name,
        numGpus: o.num_gpus,
        gpuRamGb: Math.round(((o.gpu_ram as number) || 0) / 1024),
        dphTotal: o.dph_total,
        diskSpace: o.disk_space,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ offers: mapped, count: mapped.length }, null, 2) }] };
    } catch (err) {
      logger.warn({ err }, "[MCP] list_gpu_offers failed");
      return { content: [{ type: "text", text: JSON.stringify({ error: "Failed to fetch GPU offers" }) }] };
    }
  });

  server.registerTool("list_profiles", {
    description: "[Read] List hardware profiles (Standard, Pro, etc.).",
    inputSchema: z.object({}),
  }, async () => {
    const profiles = await getAllProfiles();
    return { content: [{ type: "text", text: JSON.stringify({ profiles }, null, 2) }] };
  });
}
