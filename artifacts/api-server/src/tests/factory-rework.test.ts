/**
 * Tests for RFC 0003 Phase 2 — deliverable contract, rework loop, and
 * defect-adjusted WIP. All run against the in-memory store.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { FactoryRegistry, MemoryFactoryStore } from "../services/factory";
import {
  dispatchWorkOrders,
  effectiveStationWipLimit,
  stationWipUsed,
} from "../services/factory-dispatcher";
import {
  inspectDeliverable,
  type Deliverable,
} from "../services/deliverable-contract";
import {
  submitDeliverable,
  stationTelemetry,
  productTelemetry,
} from "../services/rework-loop";
import type { StationRole, WorkOrder } from "@workspace/db";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    workOrderId: 1,
    stationId: 1,
    diff: "+ some change",
    intentEvents: ["intent-1"],
    tests: [{ suite: "unit", passed: 5, failed: 0, status: "pass" }],
    verification: [
      { taskName: "compile", taskType: "compile", status: "pass" },
      { taskName: "test", taskType: "test", status: "pass" },
      { taskName: "lint", taskType: "lint", status: "pass" },
      { taskName: "typecheck", taskType: "typecheck", status: "pass" },
    ],
    worktreeClean: true,
    ...overrides,
  };
}

// ── Deliverable contract ─────────────────────────────────────────────────────

describe("inspectDeliverable", () => {
  it("conforms when all station-role gates pass", () => {
    const d = makeDeliverable();
    const result = inspectDeliverable(d, "build");
    expect(result.conforms).toBe(true);
    expect(result.defectClass).toBeNull();
    expect(result.reasons).toHaveLength(0);
  });

  it("rejects when diff is empty", () => {
    const d = makeDeliverable({ diff: "" });
    const result = inspectDeliverable(d, "build");
    expect(result.conforms).toBe(false);
    expect(result.defectClass).toBe("base");
    expect(result.reasons.some((r) => /diff is empty/.test(r))).toBe(true);
  });

  it("rejects when intent events are missing", () => {
    const d = makeDeliverable({ intentEvents: [] });
    const result = inspectDeliverable(d, "build");
    expect(result.conforms).toBe(false);
    expect(result.reasons.some((r) => /intent events/.test(r))).toBe(true);
  });

  it("rejects when worktree is dirty", () => {
    const d = makeDeliverable({ worktreeClean: false });
    const result = inspectDeliverable(d, "build");
    expect(result.conforms).toBe(false);
    expect(result.reasons.some((r) => /dirty/.test(r))).toBe(true);
  });

  it("rejects when compile evidence is missing (build station)", () => {
    const d = makeDeliverable({
      verification: [{ taskName: "test", taskType: "test", status: "pass" }],
    });
    const result = inspectDeliverable(d, "build");
    expect(result.conforms).toBe(false);
    expect(result.defectClass).toBe("compile");
    expect(result.reasons.some((r) => /no compile/.test(r))).toBe(true);
  });

  it("rejects when test evidence failed (build station)", () => {
    const d = makeDeliverable({
      verification: [
        { taskName: "compile", taskType: "compile", status: "pass" },
        { taskName: "test", taskType: "test", status: "fail", detail: "2 tests failed" },
      ],
    });
    const result = inspectDeliverable(d, "build");
    expect(result.conforms).toBe(false);
    expect(result.defectClass).toBe("test");
    expect(result.reasons.some((r) => /test failed/.test(r))).toBe(true);
  });

  it("review station requires lint + typecheck", () => {
    const d = makeDeliverable({
      verification: [
        { taskName: "lint", taskType: "lint", status: "pass" },
        { taskName: "typecheck", taskType: "typecheck", status: "pass" },
      ],
    });
    const result = inspectDeliverable(d, "review");
    expect(result.conforms).toBe(true);
  });

  it("review station rejects when lint fails", () => {
    const d = makeDeliverable({
      verification: [
        { taskName: "lint", taskType: "lint", status: "fail", detail: "no-unused-vars" },
        { taskName: "typecheck", taskType: "typecheck", status: "pass" },
      ],
    });
    const result = inspectDeliverable(d, "review");
    expect(result.conforms).toBe(false);
    expect(result.defectClass).toBe("lint");
  });

  it("explore station has no gates — always conforms on base checks", () => {
    const d = makeDeliverable({ verification: [] });
    const result = inspectDeliverable(d, "explore");
    expect(result.conforms).toBe(true);
  });

  it("team station requires test + lint + typecheck", () => {
    const d = makeDeliverable({
      verification: [
        { taskName: "test", taskType: "test", status: "pass" },
        { taskName: "lint", taskType: "lint", status: "fail" },
      ],
    });
    const result = inspectDeliverable(d, "team");
    expect(result.conforms).toBe(false);
    expect(result.defectClass).toBe("lint");
  });
});

// ── Defect-adjusted WIP ──────────────────────────────────────────────────────

describe("effectiveStationWipLimit", () => {
  it("returns full WIP when defect rate is below low threshold", () => {
    expect(effectiveStationWipLimit(4, 0.1)).toBe(4);
  });

  it("reduces WIP by 1 when defect rate crosses low threshold", () => {
    expect(effectiveStationWipLimit(4, 0.3)).toBe(3);
  });

  it("floors at 1 when nominal WIP is 1", () => {
    expect(effectiveStationWipLimit(1, 0.3)).toBe(1);
  });

  it("halves WIP when defect rate crosses high threshold", () => {
    expect(effectiveStationWipLimit(4, 0.6)).toBe(2);
  });

  it("halves and floors at 1 for small WIP", () => {
    expect(effectiveStationWipLimit(2, 0.7)).toBe(1);
  });
});

// ── Rework loop ──────────────────────────────────────────────────────────────

describe("submitDeliverable", () => {
  let store: MemoryFactoryStore;
  let registry: FactoryRegistry;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    registry = new FactoryRegistry(store);
  });

  async function setup() {
    const product = await registry.createProduct({ name: "test", repoUrl: "https://github.com/x/test", wipLimit: 4 });
    const station = await registry.createStation({ productId: product.id, role: "build" });
    const order = await registry.createWorkOrder({ productId: product.id, goal: "implement feature" });
    // Dispatch to station.
    await dispatchWorkOrders(store, product.id);
    return { product, station, order };
  }

  it("completes work order when deliverable conforms", async () => {
    const { order } = await setup();
    const d = makeDeliverable({ workOrderId: order.id, stationId: 1 });
    const result = await submitDeliverable(store, d, "build");
    expect(result.accepted).toBe(true);
    expect(result.workOrder?.status).toBe("done");
    expect(result.workOrder?.completedAt).toBeInstanceOf(Date);
  });

  it("routes to rework when deliverable fails gates", async () => {
    const { order } = await setup();
    const d = makeDeliverable({
      workOrderId: order.id,
      stationId: 1,
      verification: [
        { taskName: "compile", taskType: "compile", status: "fail", detail: "TS2345" },
      ],
    });
    const result = await submitDeliverable(store, d, "build");
    expect(result.accepted).toBe(false);
    expect(result.inspection.conforms).toBe(false);
    expect(result.inspection.defectClass).toBe("compile");
    // Work order should be back in queued for re-dispatch.
    const updated = await store.getWorkOrder(order.id);
    expect(updated?.status).toBe("queued");
    expect(updated?.reworkCount).toBe(1);
    expect(updated?.lastDefectClass).toBe("compile");
  });

  it("creates a rework item record on rejection", async () => {
    const { order } = await setup();
    const d = makeDeliverable({
      workOrderId: order.id,
      stationId: 1,
      intentEvents: [],  // base check fails
    });
    await submitDeliverable(store, d, "build");
    const items = await store.listReworkItems(order.id);
    expect(items.length).toBe(1);
    expect(items[0].defectClass).toBe("base");
    expect(items[0].cycle).toBe(1);
  });

  it("clears rework items when order is eventually accepted", async () => {
    const { order, product } = await setup();
    // First delivery fails.
    const fail = makeDeliverable({ workOrderId: order.id, stationId: 1, diff: "" });
    await submitDeliverable(store, fail, "build");
    expect((await store.listReworkItems(order.id)).length).toBe(1);
    // Re-dispatch and deliver again.
    await dispatchWorkOrders(store, product.id);
    const pass = makeDeliverable({ workOrderId: order.id, stationId: 1 });
    await submitDeliverable(store, pass, "build");
    const items = await store.listReworkItems(order.id);
    expect(items.every((i) => i.clearedAt !== null)).toBe(true);
  });

  it("returns null workOrder when order not found", async () => {
    await store.createProduct({ name: "x", repoUrl: "https://x" });
    const d = makeDeliverable({ workOrderId: 999 });
    const result = await submitDeliverable(store, d, "build");
    expect(result.accepted).toBe(false);
    expect(result.workOrder).toBeNull();
  });
});

// ── Telemetry ────────────────────────────────────────────────────────────────

describe("stationTelemetry / productTelemetry", () => {
  let store: MemoryFactoryStore;
  let registry: FactoryRegistry;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    registry = new FactoryRegistry(store);
  });

  it("reports zero defect rate for fresh stations", async () => {
    const product = await registry.createProduct({ name: "t", repoUrl: "https://x/t" });
    await registry.createStation({ productId: product.id, role: "build" });
    const telemetry = await stationTelemetry(store, product.id);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0].defectRate).toBe(0);
    expect(telemetry[0].effectiveWipLimit).toBe(2); // nominal default
  });

  it("computes defect rate from station defectCount + completed orders", async () => {
    const product = await registry.createProduct({ name: "t", repoUrl: "https://x/t", wipLimit: 10 });
    const station = await registry.createStation({ productId: product.id, role: "build", wipLimit: 4 });
    // Create and complete 3 work orders.
    for (let i = 0; i < 3; i++) {
      const order = await registry.createWorkOrder({ productId: product.id, goal: `task-${i}` });
      await dispatchWorkOrders(store, product.id);
      await submitDeliverable(store, makeDeliverable({ workOrderId: order.id, stationId: station.id }), "build");
    }
    // Now inject a defect on the station.
    await store.updateStation(station.id, { defectCount: 2 });
    const telemetry = await stationTelemetry(store, product.id);
    expect(telemetry[0].defectCount).toBe(2);
    expect(telemetry[0].completedCount).toBe(3);
    expect(telemetry[0].defectRate).toBeCloseTo(2 / 5, 4);
  });

  it("reduces effective WIP for high-defect stations", async () => {
    const product = await registry.createProduct({ name: "t", repoUrl: "https://x/t", wipLimit: 10 });
    await registry.createStation({ productId: product.id, role: "build", wipLimit: 4 });
    // Simulate high defect rate: 5 defects, 3 completed → 5/(5+3)=0.625 ≥ 0.5
    await store.updateStation(1, { defectCount: 5 });
    const telemetry = await stationTelemetry(store, product.id);
    expect(telemetry[0].effectiveWipLimit).toBe(2); // halved from 4
  });

  it("productTelemetry aggregates across stations", async () => {
    const product = await registry.createProduct({ name: "t", repoUrl: "https://x/t", wipLimit: 10 });
    const s1 = await registry.createStation({ productId: product.id, role: "build", wipLimit: 4 });
    const s2 = await registry.createStation({ productId: product.id, role: "review", wipLimit: 4 });
    await store.updateStation(s1.id, { defectCount: 3 });
    await store.updateStation(s2.id, { defectCount: 1 });
    const pt = await productTelemetry(store, product.id);
    expect(pt.totalDefects).toBe(4);
    expect(pt.stations).toHaveLength(2);
  });
});

// ── Dispatcher with defect-adjusted WIP ──────────────────────────────────────

describe("dispatchWorkOrders with defect-adjusted WIP", () => {
  let store: MemoryFactoryStore;
  let registry: FactoryRegistry;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    registry = new FactoryRegistry(store);
  });

  it("uses effective WIP (reduced) when station has high defect rate", async () => {
    const product = await registry.createProduct({ name: "t", repoUrl: "https://x/t", wipLimit: 10 });
    const station = await registry.createStation({ productId: product.id, role: "build", wipLimit: 4 });
    // Simulate high defect rate: 5 defects, 3 completed → defectRate ≥ 0.5
    await store.updateStation(station.id, { defectCount: 5 });
    // Create 5 work orders.
    for (let i = 0; i < 5; i++) {
      await registry.createWorkOrder({ productId: product.id, goal: `task-${i}` });
    }
    const result = await dispatchWorkOrders(store, product.id);
    // Station effective WIP should be 2 (halved from 4), so only 2 dispatched.
    expect(result.dispatched.length).toBe(2);
    expect(result.stationWip[0].limit).toBe(2);
  });

  it("uses full WIP when defect rate is low", async () => {
    const product = await registry.createProduct({ name: "t", repoUrl: "https://x/t", wipLimit: 10 });
    await registry.createStation({ productId: product.id, role: "build", wipLimit: 4 });
    for (let i = 0; i < 5; i++) {
      await registry.createWorkOrder({ productId: product.id, goal: `task-${i}` });
    }
    const result = await dispatchWorkOrders(store, product.id);
    // Station has no defects → full WIP of 4.
    expect(result.dispatched.length).toBe(4);
    expect(result.stationWip[0].limit).toBe(4);
  });
});
