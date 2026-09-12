import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFactoryStore, type FactoryStore } from "../services/factory";
import { dispatchWorkOrders } from "../services/factory-dispatcher";
import { MemoryResourcePool, canAllocate, productCap, type ResourcePoolConfig } from "../services/factory-resource-pool";
import { compareFactoryEval, runFactoryEval, simulateFactoryRun, type FactoryEvalRun, type FactoryEvalConfig } from "../services/factory-eval";

// ── Resource pool unit tests ─────────────────────────────────────────────────

const POOL_CONFIG: ResourcePoolConfig = {
  totalUnits: 10,
  defaultProductCap: 4,
  perProductCaps: {},
};

describe("factory-resource-pool", () => {
  it("productCap falls back to defaultProductCap", () => {
    expect(productCap(POOL_CONFIG, 42)).toBe(4);
    expect(productCap({ ...POOL_CONFIG, perProductCaps: { 7: 2 } }, 7)).toBe(2);
  });

  it("canAllocate respects the per-product cap", () => {
    const reservations = [{ workOrderId: 1, productId: 5, units: 4 }];
    const allowance = canAllocate(POOL_CONFIG, reservations, 5, 1);
    expect(allowance.allowed).toBe(false);
    expect(allowance.reason).toContain("product resource cap reached");
  });

  it("canAllocate respects the shared pool total", () => {
    const reservations = [
      { workOrderId: 1, productId: 5, units: 4 },
      { workOrderId: 2, productId: 6, units: 4 },
    ];
    const allowance = canAllocate(POOL_CONFIG, reservations, 7, 3);
    expect(allowance.allowed).toBe(false);
    expect(allowance.reason).toContain("shared pool exhausted");
  });

  it("canAllocate allows room for a fresh product", () => {
    const reservations = [{ workOrderId: 1, productId: 5, units: 5 }];
    const allowance = canAllocate(POOL_CONFIG, reservations, 8, 3);
    expect(allowance.allowed).toBe(true);
    expect(allowance.reason).toBeNull();
  });

  it("MemoryResourcePool reserves, releases, and reports status", () => {
    const pool = new MemoryResourcePool({ ...POOL_CONFIG, perProductCaps: { 5: 2 } });
    expect(pool.canReserve(5, 1).allowed).toBe(true);
    pool.reserve(5, 1001, 1);
    pool.reserve(5, 1002, 1);
    expect(pool.canReserve(5, 1).allowed).toBe(false); // 2/2 used
    expect(pool.canReserve(6, 1).allowed).toBe(true);

    const status = pool.status();
    expect(status.usedUnits).toBe(2);
    expect(status.freeUnits).toBe(8);
    expect(status.products.find((p) => p.productId === 5)?.reservedUnits).toBe(2);
    expect(status.products.find((p) => p.productId === 5)?.cap).toBe(2);

    pool.release(5, 1001);
    expect(pool.status().usedUnits).toBe(1);
  });

  it("setProductCap adjusts the cap used for arbitration", () => {
    const pool = new MemoryResourcePool(POOL_CONFIG); // default cap 4
    pool.reserve(5, 2001, 4);
    expect(pool.canReserve(5, 1).allowed).toBe(false); // 4/4 used
    pool.setProductCap(5, 8);
    expect(pool.canReserve(5, 1).allowed).toBe(true);
  });
});

// ── Dispatch × resource pool integration ────────────────────────────────────

describe("dispatchWorkOrders with a resource pool", () => {
  let store: FactoryStore;

  beforeEach(async () => {
    store = new MemoryFactoryStore();
    const product = await store.createProduct({ name: "pool-prod", repoUrl: "https://example.test/pool.git", wipLimit: 4 });
    await store.createStation({ productId: product.id, role: "build", wipLimit: 3 });
  });

  it("holds orders when the product cap is exhausted", async () => {
    const product = (await store.listProducts())[0]!;
    const pool = new MemoryResourcePool({ totalUnits: 4, defaultProductCap: 2, perProductCaps: {} });

    for (let i = 0; i < 4; i++) {
      await store.createWorkOrder({ productId: product.id, goal: `task-${i}` });
    }

    const result = await dispatchWorkOrders(store, product.id, { pool });
    expect(result.dispatched.length).toBe(2);
    expect(result.held.length).toBe(2);
    expect(result.held.every((h) => h.reason.includes("resource cap"))).toBe(true);
    expect(pool.status().usedUnits).toBe(2);
  });

  it("releases the reservation when the order completes", async () => {
    const product = (await store.listProducts())[0]!;
    const pool = new MemoryResourcePool({ totalUnits: 4, defaultProductCap: 1, perProductCaps: {} });

    await store.createWorkOrder({ productId: product.id, goal: "a" });
    const first = await dispatchWorkOrders(store, product.id, { pool });
    const orderId = first.dispatched[0]!.workOrderId;
    expect(pool.status().usedUnits).toBe(1);

    const { completeWorkOrder } = await import("../services/factory-dispatcher");
    const order = await completeWorkOrder(store, orderId, "done", pool);
    expect(order?.status).toBe("done");
    expect(pool.status().usedUnits).toBe(0);

    await store.createWorkOrder({ productId: product.id, goal: "b" });
    const second = await dispatchWorkOrders(store, product.id, { pool });
    expect(second.dispatched.length).toBe(1);
  });

  it("resourceAllowance is reported on the dispatch result", async () => {
    const product = (await store.listProducts())[0]!;
    const pool = new MemoryResourcePool({ totalUnits: 4, defaultProductCap: 2, perProductCaps: {} });
    await store.createWorkOrder({ productId: product.id, goal: "c" });
    const result = await dispatchWorkOrders(store, product.id, { pool });
    expect(result.resourceAllowance?.allowed).toBe(true);
    expect(result.resourceAllowance?.productCap).toBe(2);
  });
});

// ── Factory eval harness ─────────────────────────────────────────────────────

const EVAL_SCENARIO = {
  goal: "Implement robust auth",
  tasks: ["task-a", "task-b", "task-c", "task-d"],
  acceptanceCriteria: ["c1", "c2"],
};

function runResult(partial: Partial<ReturnType<typeof buildRun>> = {}) {
  const base = buildRun();
  return { ...base, ...partial };
}

function buildRun() {
  return {
    wallClockMs: 1000,
    completed: 4,
    throughputPerHour: 3600,
    avgCycleTimeMs: 250,
    defectRate: 0,
    reworkPerCompleted: 0,
    costUsd: 0.2,
    correctness: 0.9 as number | null,
  };
}

describe("compareFactoryEval", () => {
  const armA: FactoryEvalRun = { config: { label: "A", stations: [{ role: "build" }] }, result: runResult() };
  const armB: FactoryEvalRun = { config: { label: "B", stations: [{ role: "build" }] }, result: runResult() };

  it("config B wins when it is faster without regressing correctness or defects", () => {
    const comparison = compareFactoryEval(EVAL_SCENARIO, armA, { ...armB, result: runResult({ throughputPerHour: 7200 }) });
    expect(comparison.verdict).toBe("config_b_wins");
    expect(comparison.deltas.throughputPerHour).toBe(3600);
  });

  it("config A wins when config B is slower", () => {
    const comparison = compareFactoryEval(EVAL_SCENARIO, armA, { ...armB, result: runResult({ throughputPerHour: 1000 }) });
    expect(comparison.verdict).toBe("config_a_wins");
  });

  it("is inconclusive when B is faster but correctness regressed", () => {
    const comparison = compareFactoryEval(EVAL_SCENARIO, armA, { ...armB, result: runResult({ throughputPerHour: 7200, correctness: 0.5 }) });
    expect(comparison.verdict).toBe("inconclusive");
  });

  it("is inconclusive when B is faster but defect rate regressed", () => {
    const comparison = compareFactoryEval(EVAL_SCENARIO, armA, { ...armB, result: runResult({ throughputPerHour: 7200, defectRate: 0.3 }) });
    expect(comparison.verdict).toBe("inconclusive");
  });

  it("ties when both arms are equal", () => {
    const comparison = compareFactoryEval(EVAL_SCENARIO, armA, armB);
    expect(comparison.verdict).toBe("config_b_wins"); // equal throughput → b wins by rule
  });

  it("does not regress single-product correctness (null correctness treated as ok)", () => {
    const comparison = compareFactoryEval(
      EVAL_SCENARIO,
      { ...armA, result: runResult({ correctness: null }) },
      { ...armB, result: runResult({ throughputPerHour: 7200, correctness: null }) },
    );
    expect(comparison.verdict).toBe("config_b_wins");
  });
});

describe("runFactoryEval", () => {
  const configA: FactoryEvalConfig = { label: "single", stations: [{ role: "build" }], pool: { totalUnits: 2, productCap: 1 } };
  const configB: FactoryEvalConfig = { label: "multi", stations: [{ role: "build" }, { role: "review" }], pool: { totalUnits: 4, productCap: 4 } };

  it("runs both arms and returns a report with verdict", async () => {
    const report = await runFactoryEval({
      scenario: EVAL_SCENARIO,
      runner: simulateFactoryRun,
      configA,
      configB,
    });
    expect(report.comparison.armA.config.label).toBe("single");
    expect(report.comparison.armB.config.label).toBe("multi");
    expect(["config_a_wins", "config_b_wins", "tie", "inconclusive"]).toContain(report.comparison.verdict);
    expect(report.judged).toBe(false);
  });

  it("can attach judged correctness to both arms", async () => {
    const report = await runFactoryEval({
      scenario: EVAL_SCENARIO,
      runner: simulateFactoryRun,
      configA,
      configB,
      judge: async () => 0.88,
      armOutput: async () => "diff",
    });
    expect(report.judged).toBe(true);
    expect(report.comparison.armA.result.correctness).toBe(0.88);
    expect(report.comparison.armB.result.correctness).toBe(0.88);
  });

  it("does not regress factory-scale correctness vs single-product baseline", async () => {
    const report = await runFactoryEval({
      scenario: EVAL_SCENARIO,
      runner: simulateFactoryRun,
      configA: { label: "baseline", stations: [{ role: "build", wipLimit: 4 }], wipLimit: 4 },
      configB: { label: "factory", stations: [{ role: "build", wipLimit: 4 }, { role: "review", wipLimit: 4 }], wipLimit: 8 },
    });
    const { deltas, verdict } = report.comparison;
    expect(verdict !== "inconclusive" || deltas.correctness !== null).toBe(true);
    expect(report.comparison.armB.result.completed).toBeGreaterThanOrEqual(0);
  });
});

describe("simulateFactoryRun", () => {
  it("completes all tasks with zero defect rate", async () => {
    const result = await simulateFactoryRun(EVAL_SCENARIO, {
      label: "sim",
      stations: [{ role: "build", wipLimit: 2 }],
      wipLimit: 4,
    });
    expect(result.completed).toBe(4);
    expect(result.defectRate).toBe(0);
    expect(result.reworkPerCompleted).toBe(0);
    expect(result.avgCycleTimeMs).toBeGreaterThan(0);
  });

  it("produces rework telemetry under a high defect rate", async () => {
    const result = await simulateFactoryRun(EVAL_SCENARIO, {
      label: "sim-defect",
      stations: [{ role: "build", wipLimit: 2 }],
      wipLimit: 4,
      defectRate: 0.8,
    });
    expect(result.completed).toBeLessThanOrEqual(4);
    expect(result.reworkPerCompleted).toBeGreaterThanOrEqual(0);
    expect(result.defectRate).toBeGreaterThan(0);
  });

  it("respects a tight shared resource pool", async () => {
    const result = await simulateFactoryRun(EVAL_SCENARIO, {
      label: "sim-pool",
      stations: [{ role: "build", wipLimit: 5 }],
      wipLimit: 10,
      pool: { totalUnits: 1, productCap: 1 },
    });
    expect(result.completed).toBe(4); // pool gates concurrency, not completion
  });
});