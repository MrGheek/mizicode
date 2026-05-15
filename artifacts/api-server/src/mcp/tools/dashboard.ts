import { z } from "zod";
import { db, sessionsTable, gpuProfilesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerDashboardTools(server: McpServer): void {
  server.registerTool("get_dashboard_summary", {
    description: "[Read] Get aggregate session counts, costs, and uptime for the MIZI dashboard.",
    inputSchema: z.object({}),
  }, async () => {
    const [stats] = await db.select({
      totalSessions: sql<number>`count(*)::int`,
      activeSessions: sql<number>`count(*) filter (where ${sessionsTable.status} in ('pending','provisioning','downloading','starting','ready'))::int`,
      totalCost: sql<number>`coalesce(sum(${sessionsTable.totalCost}), 0)`,
      totalHours: sql<number>`coalesce(sum(
        case when ${sessionsTable.startedAt} is not null then
          extract(epoch from (coalesce(${sessionsTable.stoppedAt}, now()) - ${sessionsTable.startedAt})) / 3600.0
        else 0 end
      ), 0)`,
    }).from(sessionsTable);

    const counts = await db.select({
      name: gpuProfilesTable.displayName,
      count: sql<number>`count(*)::int`,
    })
      .from(sessionsTable)
      .innerJoin(gpuProfilesTable, eq(sessionsTable.profileId, gpuProfilesTable.id))
      .groupBy(gpuProfilesTable.displayName);

    const profileCounts: Record<string, number> = {};
    for (const c of counts) {
      profileCounts[c.name] = c.count;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          activeSessions: stats?.activeSessions || 0,
          totalSessions: stats?.totalSessions || 0,
          totalCost: Math.round((stats?.totalCost || 0) * 100) / 100,
          totalHours: Math.round((stats?.totalHours || 0) * 10) / 10,
          profileCounts,
        }, null, 2),
      }],
    };
  });
}
