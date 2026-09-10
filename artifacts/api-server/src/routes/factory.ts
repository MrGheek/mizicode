/**
 * routes/factory.ts — RFC 0003 Phase 1: product, work-order, station, dispatch,
 * and admission endpoints.
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
import { logger } from "../lib/logger";

const router = Router();

const VALID_WORK_ORDER_STATUSES = ["queued", "dispatched", "in_progress", "blocked", "done", "skipped"] as const;

function serializeProduct(p: Awaited<ReturnType<FactoryRegistry["getProduct"]>>) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    repoUrl: p.repoUrl,
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
  const { name, repoUrl, wipLimit, qualityGateConfig, pipelineConfig } = req.body as {
    name?: string;
    repoUrl?: string;
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
      wipLimit: typeof wipLimit === "number" && wipLimit > 0 ? wipLimit : undefined,
      qualityGateConfig: qualityGateConfig ?? null,
      pipelineConfig: pipelineConfig ?? null,
    });
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
  const order = await completeWorkOrder(createDbFactoryStore(), id, status);
  if (!order) { res.status(404).json({ error: "work order not found" }); return; }
  res.json({ workOrder: serializeWorkOrder(order) });
});

router.post("/factory/work-orders/:id/rework", requireAgentAuth(["coordination:write"]), async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid work order id" }); return; }
  const defectClass = (req.body as { defectClass?: string }).defectClass ?? "gate_failure";
  const order = await rejectToRework(createDbFactoryStore(), id, defectClass);
  if (!order) { res.status(404).json({ error: "work order not found" }); return; }
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
    });
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
  const result = await submitDeliverable(store, deliverable, body.stationRole);
  res.json({ accepted: result.accepted, inspection: result.inspection, workOrder: result.workOrder });
});

router.get("/factory/products/:id/telemetry", requireAgentAuth(["coordination:read"]), async (req, res) => {
  const productId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(productId)) { res.status(400).json({ error: "invalid product id" }); return; }
  const store = createDbFactoryStore();
  const telemetry = await productTelemetry(store, productId);
  res.json(telemetry);
});

export default router;
