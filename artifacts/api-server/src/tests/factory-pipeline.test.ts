/**
 * Tests for RFC 0003 Phase 3 — continuous pipeline and factory telemetry /
 * dashboard. All run against the in-memory store.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { FactoryRegistry, MemoryFactoryStore } from "../services/factory";
import { dispatchWorkOrders, completeWorkOrder } from "../services/factory-dispatcher";
import { submitDeliverable } from "../services/rework-loop";
import type { Deliverable } from "../services/deliverable-contract";
import {
  triggerPipeline,
  advancePipeline,
  checkStageGate,
  latestPipelineSnapshot,
  DEFAULT_STAGE_GATES,
} from "../services/factory-pipeline";
import {
  computeDashboard,
  snapshotMetrics,
  getMetricsHistory,
} from "../services/factory-telemetry";

const makeDeliverable = (workOrderId: number): Deliverable => ({
  workOrderId,
  stationId: 1,
  diff: "+ change",
  intentEvents: ["intent-1"],
  tests: [{ suite: "unit", passed: 3, failed: 0, status: "pass" }],
  verification: [
    { taskName: "compile", taskType: "compile", status: "pass" },
    { taskName: "test", taskType: "test", status: "pass" },
    { taskName: "lint", taskType: "lint", status: "pass" },
    { taskName: "typecheck", taskType: "typecheck", status: "pass" },
  ],
  worktreeClean: true,
});

// ── Stage gates ──────────────────────────────────────────────────────────────

describe("checkStageGate", () => {
  it("passes when required checks have evidence", () => {
    const result = checkStageGate("build", [{ taskType: "compile", status: "pass" }]);
    expect(result.passed).toBe(true);
  });

  it("fails when required evidence is missing", () => {
    const result = checkStageGate("build", []);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/missing compile/);
  });

  it("fails when evidence status is fail", () => {
    const result = checkStageGate("build", [{ taskType: "compile", status: "fail", detail: "TS2345" }]);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/compile failed: TS2345/);
  });

  it("passes for a stage with no required gate", () => {
    const result = checkStageGate("stage", []);
    expect(result.passed).toBe(true);
  });

  it("ship stage requires lint + typecheck", () => {
    expect(DEFAULT_STAGE_GATES["ship"].checks).toEqual(["lint", "typecheck"]);
    const pass = checkStageGate("ship", [
      { taskType: "lint", status: "pass" },
      { taskType: "typecheck", status: "pass" },
    ]);
    expect(pass.passed).toBe(true);
    const fail = checkStageGate("ship", [{ taskType: "lint", status: "pass" }]);
    expect(fail.passed).toBe(false);
  });
});

// ── Pipeline lifecycle ───────────────────────────────────────────────────────

describe("factory-pipeline trigger/advance", () => {
  let store: MemoryFactoryStore;
  let registry: FactoryRegistry;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    registry = new FactoryRegistry(store);
  });

  async function setupProduct() {
    const product = await registry.createProduct({ name: "test", repoUrl: "https://github.com/x/test", wipLimit: 10 });
    await registry.createStation({ productId: product.id, role: "build" });
    return product;
  }

  it("triggerPipeline starts at the build stage", async () => {
    const product = await setupProduct();
    const order = await registry.createWorkOrder({ productId: product.id, goal: "task" });
    const run = await triggerPipeline(store, product.id, order.id);
    expect(run.stage).toBe("build");
    expect(run.status).toBe("pending");
    expect(run.triggerWorkOrderId).toBe(order.id);
  });

  it("advancePipeline walks build → test → stage → ship", async () => {
    const product = await setupProduct();
    const order = await registry.createWorkOrder({ productId: product.id, goal: "task" });
    const run = await triggerPipeline(store, product.id, order.id);

    const stages: Array<{ stage: "build" | "test" | "stage" | "ship"; evidence: Array<{ taskType: string; status: "pass" | "fail" }> }> = [
      { stage: "build", evidence: [{ taskType: "compile", status: "pass" }] },
      { stage: "test", evidence: [{ taskType: "test", status: "pass" }] },
      { stage: "stage", evidence: [] },
      { stage: "ship", evidence: [{ taskType: "lint", status: "pass" }, { taskType: "typecheck", status: "pass" }] },
    ];

    let currentRun = run;
    let complete = false;
    for (const s of stages) {
      expect(currentRun.stage).toBe(s.stage);
      const result = await advancePipeline(store, currentRun.id, {
        stage: s.stage,
        status: "passed",
        artifacts: s.stage === "stage" ? [{ name: "app.tar.gz", url: "s3://mizi/app.tar.gz", hash: "abc123" }] : [],
        evidence: s.evidence,
      });
      currentRun = result.nextRun!;
      complete = result.complete;
    }

    expect(complete).toBe(true);
    expect(currentRun).toBeNull();
  });

  it("halts the pipeline when a stage gate fails", async () => {
    const product = await setupProduct();
    const order = await registry.createWorkOrder({ productId: product.id, goal: "task" });
    const run = await triggerPipeline(store, product.id, order.id);

    const result = await advancePipeline(store, run.id, {
      stage: "build",
      status: "failed",
      artifacts: [],
      evidence: [{ taskType: "compile", status: "fail", detail: "TS2345" }],
    });

    expect(result.complete).toBe(false);
    expect(result.nextRun).toBeNull();
    // Since status=passed is required to advance, a 'failed' result stays halted.
    const updated = await store.getPipelineRun(run.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.gatePassed).toBe(false);
  });

  it("advancePipeline throws when a stage gate is missing but status=passed", async () => {
    const product = await setupProduct();
    const order = await registry.createWorkOrder({ productId: product.id, goal: "task" });
    const run = await triggerPipeline(store, product.id, order.id);

    // Build gate requires compile evidence — none provided → gate fails → status becomes 'failed' regardless of input.
    const result = await advancePipeline(store, run.id, {
      stage: "build",
      status: "passed",
      artifacts: [],
      evidence: [],
    });
    expect(result.nextRun).toBeNull();
    expect((await store.getPipelineRun(run.id))?.status).toBe("failed");
  });

  it("completeWorkOrder triggers pipeline (via submitDeliverable integration)", async () => {
    const product = await setupProduct();
    const order = await registry.createWorkOrder({ productId: product.id, goal: "task" });
    await dispatchWorkOrders(store, product.id);
    await submitDeliverable(store, makeDeliverable(order.id), "build");
    const runs = await store.listPipelineRuns(product.id);
    expect(runs.length).toBe(1);
    expect(runs[0].triggerWorkOrderId).toBe(order.id);
  });
});

// ── Dashboard / telemetry ────────────────────────────────────────────────────

describe("computeDashboard + metrics", () => {
  let store: MemoryFactoryStore;
  let registry: FactoryRegistry;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    registry = new FactoryRegistry(store);
  });

  it("reports empty dashboard for a fresh product", async () => {
    const product = await registry.createProduct({ name: "fresh", repoUrl: "https://x/fresh" });
    const dash = await computeDashboard(store, product.id);
    expect(dash.completedTotal).toBe(0);
    expect(dash.defectRate).toBe(0);
    expect(dash.reworkRate).toBe(0);
    expect(dash.productWip).toEqual({ used: 0, limit: 4 });
  });

  it("computes throughput, cycle time and defect rates", async () => {
    const product = await registry.createProduct({ name: "t", repoUrl: "https://x/t", wipLimit: 10 });
    const station = await registry.createStation({ productId: product.id, role: "build", wipLimit: 4 });

    // Complete 3 work orders (with startedAt/completedAt for cycle time).
    for (let i = 0; i < 3; i++) {
      const order = await registry.createWorkOrder({ productId: product.id, goal: `task-${i}` });
      await dispatchWorkOrders(store, product.id);
      const assigned = await store.getWorkOrder(order.id);
      await store.updateWorkOrder(order.id, { startedAt: new Date(assigned!.createdAt.getTime() - 1000) });
      await submitDeliverable(
        store,
        {
          ...makeDeliverable(order.id),
          stationId: station.id,
        },
        "build",
      );
    }

    // Inject defects on the station.
    await store.updateStation(station.id, { defectCount: 2 });

    const dash = await computeDashboard(store, product.id);
    expect(dash.completedTotal).toBe(3);
    expect(dash.defectRate).toBeCloseTo(2 / 5, 4);
    expect(dash.reworkRate).toBe(0);
    expect(dash.avgCycleTimeMs).toBeGreaterThan(0);
    expect(dash.medianCycleTimeMs).toBeGreaterThan(0);

    // defectRate 0.4: between LOW(0.25) and HIGH(0.5) → WIP-1 → 4-1=3
    expect(dash.stationUtilization[0].effectiveLimit).toBe(3);
  });

  it("snapshotMetrics persists a dashboard and getMetricsHistory returns it", async () => {
    const product = await registry.createProduct({ name: "snap", repoUrl: "https://x/snap" });
    const m1 = await snapshotMetrics(store, product.id);
    const m2 = await snapshotMetrics(store, product.id);
    expect(m1.snapshotTime).toBeInstanceOf(Date);
    expect(m1.snapshotJson).toMatchObject({ productId: product.id });

    const history = await getMetricsHistory(store, product.id, 10);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(m2.id); // newest first
  });
});