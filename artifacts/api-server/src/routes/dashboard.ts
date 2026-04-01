import { Router } from "express";
import { db, sessionsTable, gpuProfilesTable } from "@workspace/db";
import { eq, sql, inArray } from "drizzle-orm";

const router = Router();

router.get("/dashboard/summary", async (_req, res) => {
  const activeStatuses = ["pending", "provisioning", "downloading", "starting", "ready"];

  const [stats] = await db
    .select({
      totalSessions: sql<number>`count(*)::int`,
      activeSessions: sql<number>`count(*) filter (where ${sessionsTable.status} in ('pending','provisioning','downloading','starting','ready'))::int`,
      totalCost: sql<number>`coalesce(sum(${sessionsTable.totalCost}), 0)`,
      totalHours: sql<number>`coalesce(sum(
        case when ${sessionsTable.startedAt} is not null then
          extract(epoch from (coalesce(${sessionsTable.stoppedAt}, now()) - ${sessionsTable.startedAt})) / 3600.0
        else 0 end
      ), 0)`,
    })
    .from(sessionsTable);

  const profileCounts: Record<string, number> = {};
  const counts = await db
    .select({
      name: gpuProfilesTable.displayName,
      count: sql<number>`count(*)::int`,
    })
    .from(sessionsTable)
    .innerJoin(gpuProfilesTable, eq(sessionsTable.profileId, gpuProfilesTable.id))
    .groupBy(gpuProfilesTable.displayName);

  for (const c of counts) {
    profileCounts[c.name] = c.count;
  }

  res.json({
    activeSessions: stats?.activeSessions || 0,
    totalSessions: stats?.totalSessions || 0,
    totalCost: Math.round((stats?.totalCost || 0) * 100) / 100,
    totalHours: Math.round((stats?.totalHours || 0) * 10) / 10,
    profileCounts,
  });
});

export default router;
