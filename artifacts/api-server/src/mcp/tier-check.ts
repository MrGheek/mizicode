import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ApiKeyRecord } from "../middlewares/agent-auth.js";

export type PrivilegeTier = "Read" | "Write" | "Admin";

/**
 * MCP error code for "Unauthorized / insufficient privilege".
 * -32001 is the standard MCP Unauthorized code per the MCP specification.
 */
export const MCP_UNAUTHORIZED_CODE = -32001;

/**
 * Checks that the authenticated API key has the `admin` scope required for
 * Admin-tier tools. MCP calls passing MIZI_MEM_TOKEN bypass this check
 * (those calls do not populate apiKey, which signals operator-level access).
 *
 * Throws a typed MCP Unauthorized error (-32001) if the check fails.
 */
export function requireAdminTier(apiKey: ApiKeyRecord | undefined): void {
  if (!apiKey) return;
  const scopes = (apiKey.scopes as string[]) ?? [];
  if (!scopes.includes("admin")) {
    throw new McpError(
      MCP_UNAUTHORIZED_CODE,
      "Unauthorized: Admin-tier tool requires an API key with the `admin` scope.",
    );
  }
}
