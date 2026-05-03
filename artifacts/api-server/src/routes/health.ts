import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getSweeperHealth } from "../services/claim-sweeper";
import { probeMemoryDb } from "../services/memory";

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
  res.json({
    status: "ok",
    sweeper: getSweeperHealth(),
  });
});

export default router;
