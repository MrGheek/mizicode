/**
 * Tests for RFC 0003 Phase 1 — factory registry, WIP-bounded dispatcher, and
 * merge-queue admission control. All run against the in-memory store.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { FactoryRegistry, MemoryFactoryStore } from "../services/factory";
import {
  dispatchWorkOrders,
  readyWorkOrders,
  completeWorkOrder,
  rejectToRework,
  productWipUsed,
  stationWipUsed,
} from "../services/factory-dispatcher";
import { admitMerge } from "../services/factory-admission";
import type { WorkOrder } from "@workspace/db";

describe("FactoryRegistry", () => {
  let store: MemoryFactoryStore;
  let registry: FactoryRegistry;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    registry = new FactoryRegistry(store);
  });

  it("creates a product and rejects duplicate repos", async () => {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi" });
    expect(p.wipLimit).toBe(4);
    await expect(
      registry.createProduct({ name: "dup", repoUrl: "https://github.com/x/mizi" }),
    ).rejects.toThrow(/already exists/);
  });

  it("creates work orders and appends them to the product roadmap", async () => {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi" });
    const w1 = await registry.createWorkOrder({ productId: p.id, goal: "task one" });
    const w2 = await registry.createWorkOrder({ productId: p.id, goal: "task two", priority: "high" });
    const updated = await registry.getProduct(p.id);
    expect(updated?.roadmapJson).toEqual([w1.id, w2.id]);
    expect(w2.priority).toBe("high");
  });

  it("rejects work orders for a missing product", async () => {
    await expect(registry.createWorkOrder({ productId: 999, goal: "x" })).rejects.toThrow(/does not exist/);
  });

  it("creates stations with role + capacity", async () => {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi" });
    const s = await registry.createStation({ productId: p.id, role: "review", capacity: 3, wipLimit: 2 });
    expect(s.role).toBe("review");
    expect(s.capacity).toBe(3);
    expect(s.wipLimit).toBe(2);
  });

  it("records defects on a station", async () => {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi" });
    const s = await registry.createStation({ productId: p.id });
    await registry.recordDefect(s.id, "test_failure");
    const updated = await registry.getStation(s.id);
    expect(updated?.defectCount).toBe(1);
    expect(updated?.reworkCycles).toBe(1);
  });
});

describe("readyWorkOrders (topological)", () => {
  function order(id: number, deps: number[], status: WorkOrder["status"] = "queued"): WorkOrder {
    return {
      id,
      productId: 1,
      goal: `task ${id}`,
      priority: "normal",
      dependenciesJson: deps,
      acceptanceCriteria: null,
      assignedStationId: null,
      status,
      reworkCount: 0,
      lastDefectClass: null,
      sessionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: null,
      completedAt: null,
    };
  }

  it("returns queued orders whose deps are done, priority-first", () => {
    const orders = [
      order(1, []),
      order(2, [1]),
      order(3, [1, 2]),
      order(4, [99]), // dep never done → blocked
    ];
    const ready = readyWorkOrders(orders);
    expect(ready.map((o) => o.id)).toEqual([1]);
  });

  it("releases dependents once deps complete", () => {
    const orders = [
      order(1, [], "done"),
      order(2, [1]),
      order(3, [2]),
    ];
    const ready = readyWorkOrders(orders);
    expect(ready.map((o) => o.id)).toEqual([2]);
  });

  it("sorts high priority before normal", () => {
    const orders = [
      { ...order(1, []), priority: "normal" as const },
      { ...order(2, []), priority: "high" as const },
    ];
    const ready = readyWorkOrders(orders);
    expect(ready.map((o) => o.id)).toEqual([2, 1]);
  });
});

describe("dispatchWorkOrders (WIP-bounded)", () => {
  let store: MemoryFactoryStore;
  let registry: FactoryRegistry;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    registry = new FactoryRegistry(store);
  });

  async function seed() {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi", wipLimit: 2 });
    const s1 = await registry.createStation({ productId: p.id, wipLimit: 1 });
    const s2 = await registry.createStation({ productId: p.id, wipLimit: 1 });
    const w1 = await registry.createWorkOrder({ productId: p.id, goal: "a" });
    const w2 = await registry.createWorkOrder({ productId: p.id, goal: "b" });
    const w3 = await registry.createWorkOrder({ productId: p.id, goal: "c" });
    return { p, s1, s2, w1, w2, w3 };
  }

  it("dispatches up to the product WIP limit", async () => {
    const { p, w1, w2, w3 } = await seed();
    const result = await dispatchWorkOrders(store, p.id);
    expect(result.dispatched.map((d) => d.workOrderId)).toEqual([w1.id, w2.id]);
    expect(result.held.map((h) => h.workOrderId)).toEqual([w3.id]);
    expect(result.held[0]?.reason).toMatch(/WIP saturated/);
    expect(result.productWip).toEqual({ used: 0, limit: 2 });
  });

  it("respects station WIP limits", async () => {
    const { p, s1, w1, w2 } = await seed();
    // Both stations have wipLimit 1; two orders → one per station.
    const result = await dispatchWorkOrders(store, p.id);
    expect(result.dispatched).toHaveLength(2);
    const stationIds = result.dispatched.map((d) => d.stationId);
    expect(stationIds).toContain(s1.id);
    expect(new Set(stationIds).size).toBe(2);
    expect(result.stationWip.every((s) => s.used <= s.limit)).toBe(true);
    expect(w1.id).toBeGreaterThan(0);
    expect(w2.id).toBeGreaterThan(0);
  });

  it("holds when no station has headroom", async () => {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi", wipLimit: 4 });
    const s = await registry.createStation({ productId: p.id, wipLimit: 1 });
    await registry.createWorkOrder({ productId: p.id, goal: "a" });
    await registry.createWorkOrder({ productId: p.id, goal: "b" });
    const result = await dispatchWorkOrders(store, p.id);
    expect(result.dispatched).toHaveLength(1);
    expect(result.held).toHaveLength(1);
    expect(result.held[0]?.reason).toMatch(/no station has WIP headroom/);
    expect(s.id).toBeGreaterThan(0);
  });

  it("respects maxDispatch cap", async () => {
    const { p } = await seed();
    const result = await dispatchWorkOrders(store, p.id, { maxDispatch: 1 });
    expect(result.dispatched).toHaveLength(1);
    expect(result.held.some((h) => h.reason.includes("maxDispatch"))).toBe(true);
  });

  it("completing a work order frees WIP for the next dispatch", async () => {
    const { p, w1, w2, w3 } = await seed();
    await dispatchWorkOrders(store, p.id);
    await completeWorkOrder(store, w1.id, "done");
    const result = await dispatchWorkOrders(store, p.id);
    expect(result.dispatched.map((d) => d.workOrderId)).toEqual([w3.id]);
    expect(w2.id).toBeGreaterThan(0);
  });

  it("rework returns an order to queued and increments counters", async () => {
    const { p, w1 } = await seed();
    await dispatchWorkOrders(store, p.id);
    const reworked = await rejectToRework(store, w1.id, "test_failure");
    expect(reworked?.status).toBe("queued");
    expect(reworked?.reworkCount).toBe(1);
    expect(reworked?.lastDefectClass).toBe("test_failure");
    expect(reworked?.assignedStationId).toBeNull();
    // Station defect telemetry incremented.
    const stations = await registry.listStations(p.id);
    expect(stations.some((s) => s.defectCount === 1)).toBe(true);
  });
});

describe("admitMerge (admission control)", () => {
  let store: MemoryFactoryStore;
  let registry: FactoryRegistry;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    registry = new FactoryRegistry(store);
  });

  it("admits when no product is registered (pre-factory session)", async () => {
    const d = await admitMerge(store, "https://github.com/other/repo", 1, 1);
    expect(d.admitted).toBe(true);
    expect(d.productId).toBeNull();
  });

  it("admits when product WIP has headroom", async () => {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi", wipLimit: 4 });
    const d = await admitMerge(store, p.repoUrl, 1, 1);
    expect(d.admitted).toBe(true);
    expect(d.productId).toBe(p.id);
  });

  it("holds when product WIP is saturated", async () => {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi", wipLimit: 1 });
    const s = await registry.createStation({ productId: p.id, sessionId: 1, wipLimit: 1 });
    await registry.createWorkOrder({ productId: p.id, goal: "a" });
    await dispatchWorkOrders(store, p.id);
    const d = await admitMerge(store, p.repoUrl, 1, 1);
    expect(d.admitted).toBe(false);
    expect(d.reason).toMatch(/WIP saturated/);
    expect(s.id).toBeGreaterThan(0);
  });

  it("holds when the station is saturated", async () => {
    const p = await registry.createProduct({ name: "mizi", repoUrl: "https://github.com/x/mizi", wipLimit: 4 });
    const s = await registry.createStation({ productId: p.id, sessionId: 1, wipLimit: 1 });
    await registry.createWorkOrder({ productId: p.id, goal: "a" });
    await dispatchWorkOrders(store, p.id);
    // Station 1 already holds 1 order; a second lane merge would exceed it.
    const d = await admitMerge(store, p.repoUrl, 1, 1);
    expect(d.admitted).toBe(false);
    expect(d.reason).toMatch(/station .* WIP saturated/);
    expect(s.id).toBeGreaterThan(0);
  });
});
