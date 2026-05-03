import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getSweeperHealth } from "../services/claim-sweeper";

const router: IRouter = Router();

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
