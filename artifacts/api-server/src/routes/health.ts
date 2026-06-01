import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getSweeperHealth } from "../services/claim-sweeper";
import { probeMemoryDb, getMemoryDiskHealth } from "../services/memory";

const router: IRouter = Router();

router.get("/health", (_req, res) => {
  const result = probeMemoryDb();
  if (result.ok) {
    res.status(200).json({ status: "ok", memDb: "ok", dbPath: result.dbPath });
  } else {
    res.status(503).json({ status: "degraded", memDb: "error", error: result.error });
  }
});

router.get("/healthz", (_req, res) => {
  const isProd = process.env["NODE_ENV"] === "production";
  const isLocal = process.env["MIZI_DISTRIBUTION"] === "local";

  const missingSecrets: string[] = [];

  if (isProd && !isLocal) {
    if (!process.env["FLY_API_TOKEN"]) {
      missingSecrets.push(
        "FLY_API_TOKEN — required to provision NIM workspace machines via the Fly Machines API. " +
        "Generate: fly tokens create deploy -x 999999h  " +
        "Set: fly secrets set --app mizi-api FLY_API_TOKEN=<token>"
      );
    }
    // FLY_APP_NAME is intentionally NOT accepted as a fallback here — workspace
    // machines must live in their own dedicated Fly app, not the API server's app.
    if (!process.env["FLY_WORKSPACE_APP_NAME"]) {
      missingSecrets.push(
        "FLY_WORKSPACE_APP_NAME — name of the dedicated Fly app for workspace machines (e.g. mizi-workspace). " +
        "FLY_APP_NAME is NOT accepted as a substitute (workspace and API machines must be isolated). " +
        "Create: flyctl apps create mizi-workspace  " +
        "Set: fly secrets set --app mizi-api FLY_WORKSPACE_APP_NAME=mizi-workspace"
      );
    }
  }

  if (missingSecrets.length > 0) {
    res.status(503).json({
      status: "degraded",
      error: "One or more required secrets are missing — NIM workspace provisioning will fail",
      missingSecrets,
    });
    return;
  }

  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/admin/status", (_req, res) => {
  const diskHealth = getMemoryDiskHealth();
  const overallStatus = diskHealth.status === "critical" ? "degraded" : "ok";
  res.json({
    status: overallStatus,
    sweeper: getSweeperHealth(),
    memoryDisk: {
      status: diskHealth.status,
      freeBytes: diskHealth.freeBytes,
    },
  });
});

export default router;
