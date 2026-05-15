import { z } from "zod";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_UNAUTHORIZED_CODE, requireAdminTier } from "../tier-check.js";
import type { ApiKeyRecord } from "../../middlewares/agent-auth.js";
import {
  listPendingApprovals,
  listTranscript,
  listPolicies,
  decideAction,
  setPolicy,
  getActionById,
} from "../../services/safety.js";
import type { PolicyRules, SafetyAction } from "../../services/safety.js";

/**
 * Derive the "principal account" from the auth context.
 *
 * - API-key callers: the API keys table has no per-account binding, so they
 *   are always scoped to the "default" account. Allowing them to reference
 *   other accounts would be a scope leak.
 * - Operator callers (apiKey === undefined, i.e. MIZI_MEM_TOKEN): unrestricted;
 *   explicit accountId is honoured, otherwise falls back to "default".
 */
function derivePrincipalAccountId(apiKey: ApiKeyRecord | undefined, requested?: string): string {
  if (apiKey !== undefined) return "default";
  return requested ?? "default";
}

/**
 * Verify the authenticated principal may mutate this action.
 *
 * - API-key callers: can only act on actions whose accountId is "default".
 * - Operator callers: unrestricted.
 *
 * Throws MCP Unauthorized (-32001) on a mismatch.
 */
function requireActionOwnership(apiKey: ApiKeyRecord | undefined, action: SafetyAction): void {
  if (apiKey === undefined) return;
  if (action.accountId !== "default") {
    throw new McpError(
      MCP_UNAUTHORIZED_CODE,
      `Unauthorized: API keys are scoped to the "default" account and cannot mutate actions belonging to account "${action.accountId}".`,
    );
  }
}

export function registerSafetyTools(server: McpServer, getApiKey: () => ApiKeyRecord | undefined): void {
  server.registerTool("list_pending_approvals", {
    description: "[Read] List actions awaiting human approval. Reads are scoped to the 'default' account for API-key callers; operator callers may optionally specify accountId.",
    inputSchema: z.object({
      accountId: z.string().optional().describe("Account ID filter — operator callers only; API-key callers are always scoped to 'default' regardless of this field"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    }),
  }, async ({ accountId, limit, offset }) => {
    const apiKey = getApiKey();
    // API-key callers are always scoped to "default" — the API keys table has no
    // per-account binding, so any caller-supplied accountId would be a scope leak.
    const resolvedAccountId = apiKey !== undefined ? "default" : (accountId ?? "default");
    const actions = listPendingApprovals({ accountId: resolvedAccountId, limit: limit ?? 50, offset: offset ?? 0 });
    return { content: [{ type: "text", text: JSON.stringify({ actions, count: actions.length, scopedTo: resolvedAccountId }, null, 2) }] };
  });

  server.registerTool("get_safety_transcript", {
    description: "[Read] Read the approval/denial transcript.",
    inputSchema: z.object({
      actionId: z.number().int().optional().describe("Filter by specific action ID"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 200)"),
    }),
  }, async ({ actionId, limit }) => {
    const entries = listTranscript({ actionId, limit: limit ?? 200 });
    return { content: [{ type: "text", text: JSON.stringify({ entries, count: entries.length }, null, 2) }] };
  });

  server.registerTool("get_safety_policies", {
    description: "[Read] Read current behavioral guardrail policies for skill bundles.",
    inputSchema: z.object({}),
  }, async () => {
    const policies = listPolicies();
    return { content: [{ type: "text", text: JSON.stringify({ policies }, null, 2) }] };
  });

  server.registerTool("approve_action", {
    description: "[Admin] Approve a pending safety action by ID. Requires an API key with the 'admin' scope or the operator token. API-key callers are restricted to 'default'-account actions.",
    inputSchema: z.object({
      actionId: z.number().int().describe("Safety action ID to approve"),
      note: z.string().optional().describe("Optional approval note"),
    }),
  }, async ({ actionId, note }) => {
    const apiKey = getApiKey();
    requireAdminTier(apiKey);
    const action = getActionById(actionId);
    if (!action) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Action not found" }) }] };
    }
    requireActionOwnership(apiKey, action);
    const updated = decideAction({
      actionId,
      decision: "approve",
      decidedBy: apiKey ? `api-key:${apiKey.id}` : "mcp-operator",
      note,
    });
    if (!updated) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Action not found or already decided" }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  });

  server.registerTool("deny_action", {
    description: "[Admin] Deny a pending safety action by ID. Requires an API key with the 'admin' scope or the operator token. API-key callers are restricted to 'default'-account actions.",
    inputSchema: z.object({
      actionId: z.number().int().describe("Safety action ID to deny"),
      note: z.string().optional().describe("Optional denial note"),
    }),
  }, async ({ actionId, note }) => {
    const apiKey = getApiKey();
    requireAdminTier(apiKey);
    const action = getActionById(actionId);
    if (!action) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Action not found" }) }] };
    }
    requireActionOwnership(apiKey, action);
    const updated = decideAction({
      actionId,
      decision: "deny",
      decidedBy: apiKey ? `api-key:${apiKey.id}` : "mcp-operator",
      note,
    });
    if (!updated) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Action not found or already decided" }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  });

  server.registerTool("update_safety_policy", {
    description: "[Admin] Update a behavioral guardrail policy for a skill bundle. Requires an API key with the 'admin' scope or the operator token.",
    inputSchema: z.object({
      bundle: z.string().describe("Bundle identifier to update policy for"),
      rules: z.record(z.unknown()).describe("Policy rules object"),
      description: z.string().optional().describe("Human-readable policy description"),
    }),
  }, async ({ bundle, rules, description }) => {
    requireAdminTier(getApiKey());
    setPolicy(bundle, rules as PolicyRules, description);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, bundle }) }] };
  });
}
