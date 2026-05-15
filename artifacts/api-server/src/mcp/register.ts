/**
 * Factory that creates and fully configures an McpServer instance.
 *
 * Because McpServer has a 1-to-1 relationship with a Transport, we create
 * one McpServer per MCP session (not per request). The factory is cheap —
 * all service functions are imported at module load time; only the McpServer
 * object itself is allocated fresh per session.
 *
 * getApiKey is a thunk evaluated at tool-call time to inspect the current
 * request's authenticated API key, enabling Admin-tier checks inside handlers.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerSkillsTools } from "./tools/skills.js";
import { registerLaneTools } from "./tools/lanes.js";
import { registerBridgeTools } from "./tools/bridge.js";
import { registerSafetyTools } from "./tools/safety.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerRepoTools } from "./tools/repo.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerDesignTools } from "./tools/design.js";
import { registerModelCatalogTools } from "./tools/model-catalog.js";
import { registerAmbientTools } from "./tools/ambient.js";
import { registerDashboardTools } from "./tools/dashboard.js";
import { registerResources } from "./resources.js";
import type { ApiKeyRecord } from "../middlewares/agent-auth.js";

export function createMcpServer(getApiKey: () => ApiKeyRecord | undefined): McpServer {
  const server = new McpServer(
    { name: "mizi", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  registerSessionTools(server, getApiKey);
  registerMemoryTools(server);
  registerSkillsTools(server);
  registerLaneTools(server);
  registerBridgeTools(server);
  registerSafetyTools(server, getApiKey);
  registerPlanningTools(server);
  registerRepoTools(server);
  registerAgentTools(server);
  registerDesignTools(server);
  registerModelCatalogTools(server);
  registerAmbientTools(server, getApiKey);
  registerDashboardTools(server);
  registerResources(server);

  return server;
}
