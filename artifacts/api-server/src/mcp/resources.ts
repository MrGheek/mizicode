import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, sessionsTable, gpuProfilesTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { memoryIndex, getMemoryDiskHealth } from "../services/memory.js";
import { listNimModels } from "../services/nim-catalog.js";
import { getAllProfiles } from "../services/profiles.js";
import { listPendingApprovals } from "../services/safety.js";
import { getStatus } from "../services/ambient.js";

export function registerResources(server: McpServer): void {
  server.resource(
    "sessions",
    "mizi://sessions",
    { description: "Live session list — all sessions with their current status." },
    async () => {
      const rows = await db.select({
        id: sessionsTable.id,
        status: sessionsTable.status,
        statusMessage: sessionsTable.statusMessage,
        provider: sessionsTable.provider,
        gpuName: sessionsTable.gpuName,
        createdAt: sessionsTable.createdAt,
        profileName: gpuProfilesTable.displayName,
      })
        .from(sessionsTable)
        .leftJoin(gpuProfilesTable, eq(sessionsTable.profileId, gpuProfilesTable.id))
        .orderBy(desc(sessionsTable.createdAt))
        .limit(100);

      return {
        contents: [{
          uri: "mizi://sessions",
          mimeType: "application/json",
          text: JSON.stringify({ sessions: rows, count: rows.length }, null, 2),
        }],
      };
    },
  );

  server.resource(
    "memory-index",
    "mizi://memory/index",
    { description: "System-level memory shortlist — global-scope and session_core memory items across the system user. For per-user memory, use the memory_index tool." },
    async () => {
      const health = getMemoryDiskHealth();
      const globalItems = memoryIndex({
        userId: "system",
        scope: "global",
        tokenMode: "core",
        limit: 20,
      });
      const sessionCoreItems = memoryIndex({
        userId: "system",
        scope: "session_core",
        tokenMode: "core",
        limit: 20,
      });
      return {
        contents: [{
          uri: "mizi://memory/index",
          mimeType: "application/json",
          text: JSON.stringify({
            diskHealth: health,
            globalItems,
            sessionCoreItems,
            totalReturned: globalItems.length + sessionCoreItems.length,
            hint: "Use the memory_index MCP tool with { userId } for per-user memory retrieval.",
          }, null, 2),
        }],
      };
    },
  );

  server.resource(
    "plans",
    "mizi://plans",
    { description: "Recent project plans — the 50 most recently created plans across all users." },
    async () => {
      const result = await db.execute<{
        id: number;
        userId: string;
        title: string;
        repoUrl: string | null;
        version: number;
        createdAt: Date;
        updatedAt: Date;
      }>(sql`SELECT id, user_id AS "userId", title, repo_url AS "repoUrl", version, created_at AS "createdAt", updated_at AS "updatedAt" FROM project_plans ORDER BY created_at DESC LIMIT 50`);
      const plans = result.rows;

      return {
        contents: [{
          uri: "mizi://plans",
          mimeType: "application/json",
          text: JSON.stringify({
            plans,
            count: plans.length,
            hint: "Use the list_plans MCP tool with { userId } to retrieve plans for a specific user.",
          }, null, 2),
        }],
      };
    },
  );

  server.resource(
    "nim-catalog",
    "mizi://nim/catalog",
    { description: "NVIDIA NIM model catalog snapshot — all available models and providers." },
    async () => {
      const models = await listNimModels();
      return {
        contents: [{
          uri: "mizi://nim/catalog",
          mimeType: "application/json",
          text: JSON.stringify({ models, count: models.length }, null, 2),
        }],
      };
    },
  );

  server.resource(
    "profiles",
    "mizi://profiles",
    { description: "Hardware profile list — GPU configurations available for provisioning." },
    async () => {
      const profiles = await getAllProfiles();
      return {
        contents: [{
          uri: "mizi://profiles",
          mimeType: "application/json",
          text: JSON.stringify({ profiles }, null, 2),
        }],
      };
    },
  );

  server.resource(
    "safety-pending",
    "mizi://safety/pending",
    { description: "Pending approval queue — safety actions awaiting human review." },
    async () => {
      const actions = listPendingApprovals({ limit: 100 });
      return {
        contents: [{
          uri: "mizi://safety/pending",
          mimeType: "application/json",
          text: JSON.stringify({ actions, count: actions.length }, null, 2),
        }],
      };
    },
  );

  server.resource(
    "ambient-status",
    "mizi://ambient/status",
    { description: "Ambient cycle state — current status of the background ambient runner." },
    async () => {
      const status = getStatus();
      return {
        contents: [{
          uri: "mizi://ambient/status",
          mimeType: "application/json",
          text: JSON.stringify(status, null, 2),
        }],
      };
    },
  );
}
