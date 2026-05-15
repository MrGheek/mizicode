import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireAdminTier } from "../tier-check.js";
import type { ApiKeyRecord } from "../../middlewares/agent-auth.js";
import {
  getConfig,
  updateConfig,
  runAmbientCycleNow,
  listCycles,
  getStatus,
  getMetrics,
} from "../../services/ambient.js";

export function registerAmbientTools(server: McpServer, getApiKey: () => ApiKeyRecord | undefined): void {
  server.registerTool("get_ambient_status", {
    description: "[Read] Get current ambient cycle state.",
    inputSchema: z.object({
      accountId: z.string().optional().describe("Account ID (optional)"),
    }),
  }, async ({ accountId }) => {
    const status = getStatus(accountId);
    const metrics = getMetrics(accountId);
    return { content: [{ type: "text", text: JSON.stringify({ ...status, metrics }, null, 2) }] };
  });

  server.registerTool("get_ambient_timeline", {
    description: "[Read] Get recent ambient cycle history.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
      accountId: z.string().optional().describe("Account ID (optional)"),
    }),
  }, async ({ limit, offset, accountId }) => {
    const cycles = listCycles({ limit: limit ?? 50, offset: offset ?? 0, accountId });
    return { content: [{ type: "text", text: JSON.stringify({ cycles, count: cycles.length }, null, 2) }] };
  });

  server.registerTool("get_ambient_metrics", {
    description: "[Read] Get ambient cycle performance metrics.",
    inputSchema: z.object({
      windowMs: z.number().int().optional().describe("Time window in milliseconds"),
      accountId: z.string().optional().describe("Account ID (optional)"),
    }),
  }, async ({ windowMs, accountId }) => {
    const metrics = getMetrics(accountId, windowMs);
    return { content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }] };
  });

  server.registerTool("get_ambient_config", {
    description: "[Read] Get current ambient configuration.",
    inputSchema: z.object({
      accountId: z.string().optional().describe("Account ID (optional)"),
    }),
  }, async ({ accountId }) => {
    const config = getConfig(accountId);
    return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
  });

  server.registerTool("update_ambient_config", {
    description: "[Admin] Modify ambient config or engage the kill switch. Requires admin scope.",
    inputSchema: z.object({
      accountId: z.string().optional().describe("Account ID (default: 'default')"),
      killSwitch: z.boolean().optional().describe("Engage or disengage the kill switch"),
      intervalMinutes: z.number().int().min(1).optional().describe("Cycle interval in minutes"),
      enabled: z.boolean().optional().describe("Enable or disable ambient mode"),
    }),
  }, async ({ accountId, killSwitch, intervalMinutes, enabled }) => {
    requireAdminTier(getApiKey());
    const resolvedAccountId = accountId ?? "default";
    const updates: Record<string, unknown> = {};
    if (killSwitch !== undefined) updates.killSwitch = killSwitch;
    if (intervalMinutes !== undefined) updates.intervalMinutes = intervalMinutes;
    if (enabled !== undefined) updates.enabled = enabled;
    const updated = updateConfig(resolvedAccountId, updates);
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  });

  server.registerTool("trigger_ambient_cycle", {
    description: "[Admin] Manually trigger an ambient run. Requires admin scope.",
    inputSchema: z.object({
      force: z.boolean().optional().describe("Force the cycle even if one is already running"),
      accountId: z.string().optional().describe("Account ID (optional)"),
    }),
  }, async ({ force, accountId }) => {
    requireAdminTier(getApiKey());
    const summary = await runAmbientCycleNow({ force: force ?? false, accountId });
    return { content: [{ type: "text", text: JSON.stringify({ id: summary.cycleId, ...summary }, null, 2) }] };
  });
}
