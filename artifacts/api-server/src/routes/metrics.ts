import { Router, type Request, type Response } from "express";

const router = Router();

interface MetricsSnapshot {
  gpuUtilization: number;
  gpuMemoryUsedMb: number;
  gpuMemoryTotalMb: number;
  tokensPerSecond: number;
  totalTokensUsed: number;
  totalTokensBudget: number;
  activeModel: string;
  phase: string;
  latencyMs: number;
  estimatedCost: number;
  uptime: number;
  history: Array<{
    timestamp: number;
    gpuUtilization: number;
    tokensPerSecond: number;
    latencyMs: number;
    estimatedCost: number;
  }>;
}

const history: MetricsSnapshot["history"] = [];
const MAX_HISTORY = 60;

function collectMetrics(): MetricsSnapshot {
  const phase = process.env["MIZI_PHASE"] || "idle";
  const activeModel = process.env["NIM_MODEL_ID"] || "unknown";
  const uptime = process.uptime();

  const snapshot: MetricsSnapshot = {
    gpuUtilization: parseFloat(process.env["MIZI_GPU_UTIL"] || "0"),
    gpuMemoryUsedMb: parseFloat(process.env["MIZI_GPU_MEM_USED"] || "0"),
    gpuMemoryTotalMb: parseFloat(process.env["MIZI_GPU_MEM_TOTAL"] || "0"),
    tokensPerSecond: parseFloat(process.env["MIZI_TOKENS_PER_SEC"] || "0"),
    totalTokensUsed: parseInt(process.env["MIZI_TOKENS_USED"] || "0", 10),
    totalTokensBudget: parseInt(process.env["MIZI_TOKENS_BUDGET"] || "128000", 10),
    activeModel,
    phase,
    latencyMs: parseFloat(process.env["MIZI_LATENCY_MS"] || "0"),
    estimatedCost: parseFloat(process.env["MIZI_COST_USD"] || "0"),
    uptime,
    history: [...history],
  };

  history.push({
    timestamp: Date.now(),
    gpuUtilization: snapshot.gpuUtilization,
    tokensPerSecond: snapshot.tokensPerSecond,
    latencyMs: snapshot.latencyMs,
    estimatedCost: snapshot.estimatedCost,
  });
  if (history.length > MAX_HISTORY) history.shift();

  return snapshot;
}

router.get("/metrics", (_req: Request, res: Response) => {
  res.json(collectMetrics());
});

export default router;
