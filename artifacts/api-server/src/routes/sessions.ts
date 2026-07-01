import { Router } from "express";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getWorkspaceProxy, cleanupSessionResources, evictWorkspaceProxy, syncSessionFromVastai } from "./sessions-common";
import crudRouter from "./sessions-crud";
import memoryRouter from "./sessions-memory";
import planRouter from "./sessions-plan";
import swarmRouter from "./sessions-swarm";
import messagesRouter from "./sessions-messages";
import modelRouter from "./sessions-model";
import filesRouter from "./sessions-files";

const router = Router();

// ├─ Sub-routers (CRUD, memory, plan, swarm, messages, model, files) ──────────
router.use(crudRouter);
router.use(memoryRouter);
router.use(planRouter);
router.use(swarmRouter);
router.use(messagesRouter);
router.use(modelRouter);
router.use(filesRouter);

export { getWorkspaceProxy, evictWorkspaceProxy, cleanupSessionResources, syncSessionFromVastai };

router.use(["/sessions/:id/workspace", /^\/sessions\/(\d+)\/workspace[^/]/], async (req, res, next) => {
  const rawId = req.params["id"] ?? (req.url.match(/^\/sessions\/(\d+)\/workspace/)?.[1]);
  const sessionId = parseInt(String(rawId ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db
    .select({ flyMachineId: sessionsTable.flyMachineId })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);

  if (!session?.flyMachineId) {
    res.status(404).json({ error: "No active workspace machine for this session" });
    return;
  }

  const workspaceApp = process.env.FLY_WORKSPACE_APP_NAME || process.env.FLY_APP_NAME;
  if (!workspaceApp) {
    res.status(500).json({ error: "FLY_WORKSPACE_APP_NAME is not configured on the API server" });
    return;
  }

  const proxy = getWorkspaceProxy(session.flyMachineId, workspaceApp);
  proxy(req, res, next);
});

export default router;
