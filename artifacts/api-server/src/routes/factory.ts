/**
 * routes/factory.ts — RFC 0003 Phase 1: product, work-order, station, dispatch,
 * and admission endpoints. RFC 0006: fab model (factories, station claims),
 * multi-product arbitration, live events, and product-spec decompose.
 *
 * The factory orchestrates sessions/lanes (it does not replace them): products
 * are repos with roadmaps, work orders flow through stations, and the dispatcher
 * bounds WIP. All routes are agent-auth gated like the coordination surface.
 */

import { Router } from "express";
import { requireAgentAuth } from "../middlewares/agent-auth";
import { createDbFactoryStore, FactoryRegistry } from "../services/factory";
import { dispatchWorkOrders, completeWorkOrder, rejectToRework } from "../services/factory-dispatcher";
import { admitMerge } from "../services/factory-admission";
import { submitDeliverable, stationTelemetry, productTelemetry } from "../services/rework-loop";
import type { StationRole } from "@workspace/db";
import type { Deliverable } from "../services/deliverable-contract";
import { triggerPipeline, advancePipeline, latestPipelineSnapshot, type PipelineStageResult } from "../services/factory-pipeline";
import { computeDashboard, snapshotMetrics, getMetricsHistory } from "../services/factory-telemetry";
import { getFactoryResourcePool, resetFactoryResourcePool } from "../services/factory-resource-pool";
import { runFactoryEval, simulateFactoryRun, type FactoryEvalScenario, type FactoryEvalConfig } from "../services/factory-eval";
import { runArbitrationPass, getLatestPass, setLatestPass } from "../services/factory-arbitration";
import { releaseClaim, releaseClaimsIfSessionIdle, lanePoolStatus } from "../services/factory-lane-pool";
import {
  addFactoryClient,
  removeFactoryClient,
  broadcastFactoryEvent,
} from "../services/factory-event-emitter";
import { generatePlan } from "../services/plan";
import { logger } from "../lib/logger";

const router = Router();

const VALID_WORK_ORDER_STATUSES = ["queued", "dispatched", "in_progress", "blocked", "done", "skipped"] as const;

function serializeProduct(p: Awaited<ReturnType<FactoryRegistry["getProduct"]>>) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    repoUrl: p.repoUrl,
    factoryId: p.factoryId,
    priority: p.productPriority,
    dueDate: p.dueDate?.toISOString() ?? null,
    budgetUsd: p.budgetUsd ?? null,
    roadmap: p.roadmapJson,
    wipLimit: p.wipLimit,
    qualityGateConfig: p.qualityGateConfig,
    pipelineConfig: p.pipelineConfig,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function serializeWorkOrder(w: Awaited<ReturnType<FactoryRegistry["getWorkOrder"]>>) {
  if (!w) return null;
  return {
    id: w.id,
    productId: w.productId,
    goal: w.goal,
    priority: w.priority,
    dependencies: w.dependenciesJson,
    acceptanceCriteria: w.acceptanceCriteria,
    assignedStationId: w.assignedStationId,
    status: w.status,
    reworkCount: w.reworkCount,
    lastDefectClass: w.lastDefectClass,
    sessionId: w.sessionId,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
    startedAt: w.startedAt?.toISOString() ?? null,
    completedAt: w.completedAt?.toISOString() ?? null,
  };
}

function serializeStation(s: Awaited<ReturnType<FactoryRegistry["getStation"]>>) {
  if (!s) return null;
  return {
    id: s.id,
    productId: s.productId,
    sessionId: s.sessionId,
    role: s.role,
    capacity: s.capacity,
    wipLimit: s.wipLimit,
    defectCount: s.defectCount,
    reworkCycles: s.reworkCycles,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// ── Products ───────────────────────────────────────────────────────────────────

router.get("/factory/products", requireAgentAuth(["coordination:read"]), async (_req, res) => {
  const registry = new FactoryRegistry(createDbFactoryStore());
  const products = await registry.listProducts();
  res.json({ products: products.map(serializeProduct), total: products.length });
});

router.post("/factory/products", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const { name, repoUrl, factoryId, priority, dueDate, budgetUsd, wipLimit, qualityGateConfig, pipelineConfig } = req.body as {
    name?: string;
    repoUrl?: string;
    factoryId?: number | null;
    priority?: "p0" | "p1" | "p2";
    dueDate?: string | null;
    budgetUsd?: number | null;
    wipLimit?: number;
    qualityGateConfig?: Record<string, unknown> | null;
    pipelineConfig?: Record<string, unknown> | null;
  };
  if (!name || !repoUrl) {
    res.status(400).json({ error: "name and repoUrl are required" });
    return;
  }
  const registry = new FactoryRegistry(createDbFactoryStore());
  try {
    const product = await registry.createProduct({
      name,
      repoUrl,
      factoryId: factoryId ?? null,
      productPriority: priority ?? "p2",
      dueDate: dueDate ? new Date(dueDate) : null,
      budgetUsd: typeof budgetUsd === "number" ? budgetUsd : null,
      wipLimit: typeof wipLimit === "number" && wipLimit > 0 ? wipLimit : undefined,
      qualityGateConfig: qualityGateConfig ?? null,
      pipelineConfig: pipelineConfig ?? null,
    });
    broadcastFactoryEvent(0, { type: "wip_changed", productWip: { used: 0, limit: product.wipLimit } });
    res.status(201).json({ product: serializeProduct(product) });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/factory/products/:id", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid product id" }); return; }
  const registry = new FactoryRegistry(createDbFactoryStore());
  const product = await registry.getProduct(id);
  if (!product) { res.status(404).json({ error: "product not found" }); return; }
  res.json({ product: serializeProduct(product) });
});

router.patch("/factory/products/:id", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid product id" }); return; }
  const { priority, dueDate, budgetUsd, wipLimit } = req.body as {
    priority?: "p0" | "p1" | "p2";
    dueDate?: string | null;
    budgetUsd?: number | null;
    wipLimit?: number;
  };
  const store = createDbFactoryStore();
  const existing = await store.getProduct(id);
  if (!existing) { res.status(404).json({ error: "product not found" }); return; }
  const patch: Partial<{ productPriority: "p0" | "p1" | "p2"; dueDate: Date | null; budgetUsd: number | null; wipLimit: number }> = {};
  if (priority !== undefined) patch.productPriority = priority;
  if (dueDate !== undefined) patch.dueDate = dueDate ? new Date(dueDate) : null;
  if (budgetUsd !== undefined) patch.budgetUsd = budgetUsd;
  if (typeof wipLimit === "number" && wipLimit > 0) patch.wipLimit = wipLimit;
  const updated = await store.updateProduct(id, patch);
  if (!updated) { res.status(404).json({ error: "product not found" }); return; }
  broadcastFactoryEvent(0, { type: "wip_changed", productWip: { used: 0, limit: updated.wipLimit } });
  res.json({ product: serializeProduct(updated) });
});

// ── Work orders ───────────────────────────────────────────────────────────────

router.get("/factory/products/:id/work-orders", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const rawStatus = req.query["status"] as string | undefined;
  let statuses: typeof VALID_WORK_ORDER_STATUSES[number][] | undefined;
  if (rawStatus) {
    const parts = rawStatus.split(",").map((s) => s.trim());
    const invalid = parts.filter((s) => !VALID_WORK_ORDER_STATUSES.includes(s as (typeof VALID_WORK_ORDER_STATUSES)[number]));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid status values: ${invalid.join(", ")}` });
      return;
    }
    statuses = parts as typeof VALID_WORK_ORDER_STATUSES[number][];
  }
  const registry = new FactoryRegistry(createDbFactoryStore());
  const orders = await registry.listWorkOrders(productId, statuses);
  res.json({ productId, workOrders: orders.map(serializeWorkOrder), total: orders.length });
});

router.post("/factory/products/:id/work-orders", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const { goal, priority, dependencies, acceptanceCriteria } = req.body as {
    goal?: string;
    priority?: "high" | "normal" | "low";
    dependencies?: number[];
    acceptanceCriteria?: Record<string, unknown> | null;
  };
  if (!goal) { res.status(400).json({ error: "goal is required" }); return; }
  const registry = new FactoryRegistry(createDbFactoryStore());
  try {
    const order = await registry.createWorkOrder({
      productId,
      goal,
      priority: priority ?? "normal",
      dependencies: Array.isArray(dependencies) ? dependencies : [],
      acceptanceCriteria: acceptanceCriteria ?? null,
    });
    res.status(201).json({ workOrder: serializeWorkOrder(order) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/factory/work-orders/:id/complete", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid work order id" }); return; }
  const status = (req.body as { status?: string }).status === "skipped" ? "skipped" : "done";
  const store = createDbFactoryStore();
  const before = await store.getWorkOrder(id);
  const order = await completeWorkOrder(store, id, status, getFactoryResourcePool());
  if (!order) { res.status(404).json({ error: "work order not found" }); return; }
  if (before?.sessionId != null) {
    await releaseClaimsIfSessionIdle(store, { sessionId: before.sessionId, productId: order.productId });
  }
  broadcastFactoryEvent(order.productId, { type: "order_completed", workOrderId: order.id, status });
  res.json({ workOrder: serializeWorkOrder(order) });
});

router.post("/factory/work-orders/:id/rework", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid work order id" }); return; }
  const defectClass = (req.body as { defectClass?: string }).defectClass ?? "gate_failure";
  const store = createDbFactoryStore();
  const before = await store.getWorkOrder(id);
  const order = await rejectToRework(store, id, defectClass, getFactoryResourcePool());
  if (!order) { res.status(404).json({ error: "work order not found" }); return; }
  if (before?.sessionId != null) {
    await releaseClaimsIfSessionIdle(store, { sessionId: before.sessionId, productId: order.productId });
  }
  broadcastFactoryEvent(order.productId, {
    type: "defect_recorded",
    workOrderId: order.id,
    stationId: order.assignedStationId ?? 0,
    defectClass,
    cycle: order.reworkCount,
  });
  res.json({ workOrder: serializeWorkOrder(order) });
});

// ── Stations ──────────────────────────────────────────────────────────────────

router.get("/factory/products/:id/stations", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const registry = new FactoryRegistry(createDbFactoryStore());
  const stations = await registry.listStations(productId);
  res.json({ productId, stations: stations.map(serializeStation), total: stations.length });
});

router.post("/factory/products/:id/stations", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const { sessionId, role, capacity, wipLimit } = req.body as {
    sessionId?: number | null;
    role?: "build" | "review" | "debug" | "refactor" | "explore" | "team";
    capacity?: number;
    wipLimit?: number;
  };
  const registry = new FactoryRegistry(createDbFactoryStore());
  try {
    const station = await registry.createStation({
      productId,
      sessionId: sessionId ?? null,
      role: role ?? "build",
      capacity: typeof capacity === "number" && capacity > 0 ? capacity : undefined,
      wipLimit: typeof wipLimit === "number" && wipLimit > 0 ? wipLimit : undefined,
    });
    res.status(201).json({ station: serializeStation(station) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Dispatch + admission ────────────────────────────────────────────────────────

router.post("/factory/products/:id/dispatch", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const maxDispatch = (req.body as { maxDispatch?: number }).maxDispatch;
  try {
    const result = await dispatchWorkOrders(createDbFactoryStore(), productId, {
      maxDispatch: typeof maxDispatch === "number" && maxDispatch > 0 ? maxDispatch : undefined,
      pool: getFactoryResourcePool(),
    });
    for (const d of result.dispatched) {
      broadcastFactoryEvent(productId, {
        type: "order_dispatched",
        workOrderId: d.workOrderId,
        stationId: d.stationId,
        sessionId: 0,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/factory/admission/check", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const { repoUrl, sessionId, laneCount } = req.body as {
    repoUrl?: string;
    sessionId?: number;
    laneCount?: number;
  };
  if (!repoUrl || !Number.isFinite(sessionId)) {
    res.status(400).json({ error: "repoUrl and sessionId are required" });
    return;
  }
  const decision = await admitMerge(createDbFactoryStore(), repoUrl, sessionId as number, laneCount ?? 1);
  res.json(decision);
});

// ── Deliverable contract + rework (Phase 2) ──────────────────────────────────

router.post("/factory/work-orders/:id/deliver", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const workOrderId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(workOrderId)) { res.status(400).json({ error: "invalid work order id" }); return; }
  const body = req.body as {
    stationId?: number;
    stationRole?: StationRole;
    diff?: string;
    intentEvents?: string[];
    tests?: Array<{ suite: string; passed: number; failed: number; status: "pass" | "fail" }>;
    verification?: Array<{ taskName: string; taskType: "compile" | "lint" | "typecheck" | "test"; status: "pass" | "fail"; detail?: string }>;
    worktreeClean?: boolean;
  };
  if (!body.stationId || !body.stationRole || body.diff == null) {
    res.status(400).json({ error: "stationId, stationRole, and diff are required" });
    return;
  }
  const store = createDbFactoryStore();
  const deliverable: Deliverable = {
    workOrderId,
    stationId: body.stationId,
    diff: body.diff,
    intentEvents: body.intentEvents ?? [],
    tests: body.tests ?? [],
    verification: body.verification ?? [],
    worktreeClean: body.worktreeClean ?? true,
  };
  const result = await submitDeliverable(store, deliverable, body.stationRole, getFactoryResourcePool());
  res.json({ accepted: result.accepted, inspection: result.inspection, workOrder: result.workOrder });
});

router.get("/factory/products/:id/telemetry", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const store = createDbFactoryStore();
  const telemetry = await productTelemetry(store, productId);
  res.json(telemetry);
});

// ── Pipeline + dashboard (Phase 3) ───────────────────────────────────────────

router.post("/factory/products/:id/pipeline/trigger", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const workOrderId = parseInt(String((req.body as { workOrderId?: number }).workOrderId ?? ""), 10);
  if (!Number.isFinite(workOrderId)) { res.status(400).json({ error: "workOrderId is required" }); return; }
  try {
    const run = await triggerPipeline(createDbFactoryStore(), productId, workOrderId);
    res.status(201).json({ pipelineRun: run });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/factory/pipeline-runs/:id/advance", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const runId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(runId)) { res.status(400).json({ error: "invalid pipeline run id" }); return; }
  const body = req.body as {
    stage?: PipelineStageResult["stage"];
    status?: "passed" | "failed";
    artifacts?: Array<{ name: string; url: string; hash: string }>;
    evidence?: Array<{ taskType: string; status: "pass" | "fail"; detail?: string }>;
  };
  if (!body.stage || !body.status) {
    res.status(400).json({ error: "stage and status are required" });
    return;
  }
  const result = await advancePipeline(createDbFactoryStore(), runId, {
    stage: body.stage,
    status: body.status,
    artifacts: body.artifacts ?? [],
    evidence: body.evidence ?? [],
  });
  broadcastFactoryEvent(result.completedRun.productId, {
    type: "stage_advanced",
    pipelineRunId: result.completedRun.id,
    stage: result.completedRun.stage,
    status: result.completedRun.status,
  });
  res.json(result);
});

router.get("/factory/products/:id/pipeline", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const store = createDbFactoryStore();
  const snapshot = await latestPipelineSnapshot(store, productId);
  const runs = await store.listPipelineRuns(productId);
  res.json({ latest: snapshot, runs });
});

router.get("/factory/products/:id/dashboard", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  try {
    const dashboard = await computeDashboard(createDbFactoryStore(), productId);
    res.json(dashboard);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/factory/products/:id/metrics/snapshot", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  try {
    const metrics = await snapshotMetrics(createDbFactoryStore(), productId);
    res.status(201).json({ metrics });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/factory/products/:id/metrics", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const limit = parseInt(String(req.query["limit"] ?? "50"), 10);
  const metrics = await getMetricsHistory(createDbFactoryStore(), productId, Math.min(Math.max(limit, 1), 1000));
  res.json({ productId, total: metrics.length, metrics });
});

// ── Resource pool + factory eval (Phase 4) ───────────────────────────────────

router.get("/factory/resources", requireAgentAuth(["coordination:read"]), async (_req, res) => {
  const pool = getFactoryResourcePool();
  res.json({ status: pool.status(), config: pool.configSnapshot() });
});

router.post("/factory/resources/caps", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const { productId, cap, reset } = req.body as { productId?: number; cap?: number; reset?: boolean };
  const pool = getFactoryResourcePool();
  if (reset) {
    const fresh = resetFactoryResourcePool();
    res.json({ status: fresh.status(), config: fresh.configSnapshot() });
    return;
  }
  if (!Number.isFinite(productId) || !Number.isFinite(cap) || (cap as number) <= 0) {
    res.status(400).json({ error: "productId and cap (>0) are required" });
    return;
  }
  pool.setProductCap(productId as number, cap as number);
  res.json({ productId, status: pool.status(), config: pool.configSnapshot() });
});

router.post("/factory/evals/run", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const body = req.body as {
    scenario: FactoryEvalScenario;
    configA: FactoryEvalConfig;
    configB: FactoryEvalConfig;
  };
  if (!body?.scenario?.tasks?.length || !body?.configA || !body?.configB) {
    res.status(400).json({ error: "scenario.tasks, configA, and configB are required" });
    return;
  }
  const report = await runFactoryEval({
    scenario: body.scenario,
    runner: simulateFactoryRun,
    configA: body.configA,
    configB: body.configB,
  });
  res.json(report);
});

// ── RFC 0006: fab model ────────────────────────────────────────────────────────

router.get("/factory/fabs", requireAgentAuth(["coordination:read"]), async (_req, res) => {
  const store = createDbFactoryStore();
  const fabs = await store.listFactories();
  res.json({
    fabs: fabs.map((f) => ({
      id: f.id,
      name: f.name,
      lanePoolLimit: f.lanePoolLimit,
      budgetUsd: f.budgetUsd,
      defaultPolicy: f.defaultPolicyJson,
      createdAt: f.createdAt.toISOString(),
    })),
  });
});

router.get("/factory/fab/status", requireAgentAuth(["coordination:read"]), async (_req, res) => {
  const store = createDbFactoryStore();
  const fab = await store.getDefaultFactory();
  if (!fab) { res.status(404).json({ error: "no factory exists" }); return; }
  const pool = await lanePoolStatus(store, fab.id);
  const products = await store.listProductsForFactory(fab.id);
  res.json({ fab: { id: fab.id, name: fab.name, lanePoolLimit: fab.lanePoolLimit, budgetUsd: fab.budgetUsd }, lanePool: pool, products: products.length });
});

router.post("/factory/dispatch", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const store = createDbFactoryStore();
  const fab = await store.getDefaultFactory();
  if (!fab) { res.status(404).json({ error: "no factory exists" }); return; }
  try {
    const pass = await runArbitrationPass(store, { factoryId: fab.id });
    setLatestPass(pass);
    broadcastFactoryEvent(0, {
      type: "arbitration_recomputed",
      passId: pass.passId,
      dispatched: pass.dispatched,
      held: pass.held,
    });
    for (const line of pass.lines) {
      if (line.outcome === "dispatched") {
        const order = await store.getWorkOrder(line.workOrderId);
        if (order) {
          broadcastFactoryEvent(line.productId, {
            type: "order_dispatched",
            workOrderId: line.workOrderId,
            stationId: order.assignedStationId ?? 0,
            sessionId: order.sessionId ?? 0,
          });
        }
      }
    }
    res.json({ pass });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/factory/arbitration/latest", requireAgentAuth(["coordination:read"]), async (_req, res) => {
  const pass = getLatestPass();
  if (!pass) { res.status(404).json({ error: "no arbitration pass has run yet" }); return; }
  res.json({ pass });
});

router.get("/factory/products/:id/arbitration", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const pass = getLatestPass();
  if (!pass) { res.status(404).json({ error: "no arbitration pass has run yet" }); return; }
  const lines = pass.lines.filter((l) => l.productId === productId);
  const signals = pass.starvationSignals.filter((s) => s.productId === productId);
  res.json({ passId: pass.passId, ranAt: pass.ranAt, lines, starvationSignals: signals, lanePool: pass.lanePool });
});

router.post("/factory/claims/:id/release", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const claimId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(claimId)) { res.status(400).json({ error: "invalid claim id" }); return; }
  const store = createDbFactoryStore();
  const claim = await store.getStationClaim(claimId);
  if (!claim) { res.status(404).json({ error: "claim not found" }); return; }
  // Operator-explicit eviction: requeue the station's in-flight orders so the
  // session returns to the pool (resume via planSnapshotJson downstream).
  const inFlight = await store.listWorkOrders(claim.productId, ["dispatched", "in_progress"]);
  const requeued: number[] = [];
  for (const order of inFlight) {
    if (order.sessionId === claim.sessionId) {
      await store.updateWorkOrder(order.id, {
        status: "queued",
        assignedStationId: null,
        sessionId: null,
        startedAt: null,
      });
      requeued.push(order.id);
    }
  }
  const result = await releaseClaim(store, claimId);
  if (!result.released) { res.status(409).json({ error: result.reason ?? "claim release failed" }); return; }
  broadcastFactoryEvent(claim.productId, { type: "claim_released", workOrderId: null, sessionId: claim.sessionId });
  res.json({ ok: true, claimId, requeuedWorkOrders: requeued, sessionId: claim.sessionId });
});

router.post("/factory/products/:id/decompose", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const { intentText, userId, commit } = req.body as { intentText?: string; userId?: string; commit?: boolean };
  if (!intentText?.trim()) { res.status(400).json({ error: "intentText is required" }); return; }
  const store = createDbFactoryStore();
  const product = await store.getProduct(productId);
  if (!product) { res.status(404).json({ error: "product not found" }); return; }
  const ownerId = userId?.trim() || "factory-operator";
  try {
    const plan = await generatePlan({
      intentText: intentText.trim(),
      repoUrl: product.repoUrl,
      userId: ownerId,
    });
    const roadmap = plan.draftSteps.map((s) => s.text);
    if (commit) {
      const registry = new FactoryRegistry(store);
      const created: number[] = [];
      for (const goal of roadmap) {
        const order = await registry.createWorkOrder({ productId, goal, priority: "normal" });
        created.push(order.id);
      }
      broadcastFactoryEvent(productId, { type: "wip_changed", productWip: { used: 0, limit: product.wipLimit } });
      res.status(201).json({ ok: true, planId: plan.plan.id, roadmap, committedWorkOrderIds: created });
      return;
    }
    res.json({ ok: true, planId: plan.plan.id, roadmap, llmFailed: plan.llmFailed });
  } catch (err) {
    logger.error({ err, productId }, "[factory] decompose failed");
    res.status(500).json({ error: "Product roadmap decomposition failed" });
  }
});

router.get("/factory/products/:id/stream", requireAgentAuth(["coordination:read"]), (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  addFactoryClient(productId, res);
  // The fab-wide channel (key 0) carries portfolio-level events too.
  addFactoryClient(0, res);

  const keepAlive = setInterval(() => {
    try { res.write("event: ping\ndata: {}\n\n"); } catch { /* ignore */ }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    removeFactoryClient(productId, res);
    removeFactoryClient(0, res);
  });
});

export default router;
