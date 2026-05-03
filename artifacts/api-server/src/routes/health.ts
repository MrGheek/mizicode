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
