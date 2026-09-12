/**
 * factory-dispatcher.ts — RFC 0003 Phase 1+2: WIP-bounded, topological scheduling
 * with defect-adjusted capacity.
 *
 * Given a product's WIP limit, station capacities, work-order priorities, and
 * the work-order dependency DAG, decide *what to dispatch, when, and what to
 * hold*. Scheduling is topological (Kahn's algorithm over the DAG) and
 * WIP-bounded: a work order is only dispatched when the product's WIP and the
 * station's capacity allow it. Saturated WIP holds work orders instead of
 * spawning unbounded lanes (Little's law).
 *
 * Phase 2 adds defect-adjusted WIP: high-defect stations get lower WIP so
 * the factory self-heals under load (RFC 0003 §10).
 *
 * The dispatcher is advisory by design (RFC 0003 non-goal: no central scheduler
 * as a single point of failure) — stations keep working when it is down.
 */

import { logger } from "../lib/logger";
import type { Product, WorkOrder, Station, WorkOrderStatus } from "@workspace/db";
import type { FactoryStore } from "./factory";
import type { ResourcePool, ResourceAllowance } from "./factory-resource-pool";

export interface DispatchResult {
  dispatched: Array<{ workOrderId: number; stationId: number }>;
  held: Array<{ workOrderId: number; reason: string }>;
  productWip: { used: number; limit: number };
  stationWip: Array<{ stationId: number; used: number; limit: number }>;
  /** Per-product resource allowance from the shared pool (Phase 4). */
  resourceAllowance: ResourceAllowance | null;
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

/**
 * Count how many work orders are currently in-flight (dispatched or
 * in_progress) for a product — the product's WIP occupancy.
 */
export function productWipUsed(orders: WorkOrder[]): number {
  return orders.filter((o) => o.status === "dispatched" || o.status === "in_progress").length;
}

/**
 * Count how many work orders a station is currently executing.
 */
export function stationWipUsed(orders: WorkOrder[], stationId: number): number {
  return orders.filter(
    (o) => o.assignedStationId === stationId && (o.status === "dispatched" || o.status === "in_progress"),
  ).length;
}

// ── Defect-adjusted WIP (Phase 2) ───────────────────────────────────────────

/**
 * Thresholds at which a station's effective WIP is reduced.
 *
 * - defectRate < LOW  → full WIP (no penalty)
 * - LOW ≤ defectRate < HIGH → WIP − 1 (floor 1)
 * - defectRate ≥ HIGH → WIP halved (floor 1)
 */
const DEFECT_LOW = 0.25;
const DEFECT_HIGH = 0.5;

/**
 * Compute the effective WIP limit for a station given its defect rate.
 * High-defect stations get lower WIP so the factory self-heals.
 */
export function effectiveStationWipLimit(
  nominalWipLimit: number,
  defectRate: number,
): number {
  if (defectRate >= DEFECT_HIGH) {
    return Math.max(1, Math.floor(nominalWipLimit * 0.5));
  }
  if (defectRate >= DEFECT_LOW) {
    return Math.max(1, nominalWipLimit - 1);
  }
  return nominalWipLimit;
}

/**
 * Compute defect rate for a station: defects / (completed + defects).
 */
function stationDefectRate(station: Station, completedCount: number): number {
  const total = completedCount + station.defectCount;
  return total > 0 ? station.defectCount / total : 0;
}

/**
 * Topological sort of queued work orders over the dependency DAG (Kahn's
 * algorithm). Returns orders whose dependencies are all done/skipped, ordered
 * by priority then id. Orders with unsatisfied (or cyclic) dependencies are
 * excluded from the ready set.
 */
export function readyWorkOrders(orders: WorkOrder[]): WorkOrder[] {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const done = new Set(
    orders.filter((o) => o.status === "done" || o.status === "skipped").map((o) => o.id),
  );

  const ready = orders.filter((o) => {
    if (o.status !== "queued") return false;
    const deps = o.dependenciesJson ?? [];
    // A dependency that is not in the set (or not done) blocks this order.
    return deps.every((d) => done.has(d));
  });

  return ready.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1;
    const pb = PRIORITY_ORDER[b.priority] ?? 1;
    return pa - pb || a.id - b.id;
  });
}

export interface DispatchOptions {
  /** Cap on how many work orders to dispatch in one pass (default: no cap). */
  maxDispatch?: number;
  /** Shared GPU pool for cross-product arbitration (Phase 4). */
  pool?: ResourcePool | null;
}

/**
 * Dispatch ready work orders to stations, respecting product WIP and station
 * capacity. Returns what was dispatched and what was held (with reasons).
 *
 * Phase 4: when a pool is supplied, orders are additionally gated on the
 * shared resource pool — a product may only run as many orders as its
 * per-product cap allows, and the shared pool headroom is honored.
 */
export async function dispatchWorkOrders(
  store: FactoryStore,
  productId: number,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const product = await store.getProduct(productId);
  if (!product) throw new Error(`Product ${productId} does not exist`);

  const orders = await store.listWorkOrders(productId);
  const stations = await store.listStations(productId);

  const productUsed = productWipUsed(orders);
  const productLimit = product.wipLimit;
  const productHeadroom = Math.max(0, productLimit - productUsed);

  const stationWip: DispatchResult["stationWip"] = stations.map((s) => {
    const completedCount = orders.filter(
      (o) => o.assignedStationId === s.id && (o.status === "done" || o.status === "skipped"),
    ).length;
    const defectRate = stationDefectRate(s, completedCount);
    const effectiveLimit = effectiveStationWipLimit(s.wipLimit, defectRate);
    return {
      stationId: s.id,
      used: stationWipUsed(orders, s.id),
      limit: effectiveLimit,
    };
  });

  // Build a map for quick effective-limit lookups.
  const effectiveLimitMap = new Map(stationWip.map((sw) => [sw.stationId, sw.limit]));

  const ready = readyWorkOrders(orders);
  const dispatched: DispatchResult["dispatched"] = [];
  const held: DispatchResult["held"] = [];

  let budget = opts.maxDispatch ?? Number.POSITIVE_INFINITY;
  let remainingProductHeadroom = productHeadroom;
  let resourceAllowance: ResourceAllowance | null = opts.pool
    ? opts.pool.canReserve(productId, 1)
    : null;

  for (const order of ready) {
    if (budget <= 0) {
      held.push({ workOrderId: order.id, reason: "maxDispatch cap reached" });
      continue;
    }
    if (remainingProductHeadroom <= 0) {
      held.push({ workOrderId: order.id, reason: `product WIP saturated (${productUsed}/${productLimit})` });
      continue;
    }
    if (opts.pool && resourceAllowance && !resourceAllowance.allowed) {
      held.push({ workOrderId: order.id, reason: resourceAllowance.reason ?? "resource pool exhausted" });
      continue;
    }

    // Pick the least-loaded station with headroom. Uses defect-adjusted WIP.
    const candidates = stations
      .filter((s) => stationWipUsed(orders, s.id) < (effectiveLimitMap.get(s.id) ?? s.wipLimit))
      .sort((a, b) => stationWipUsed(orders, a.id) - stationWipUsed(orders, b.id));

    if (candidates.length === 0) {
      held.push({ workOrderId: order.id, reason: "no station has WIP headroom" });
      continue;
    }

    const station = candidates[0]!;
    await store.updateWorkOrder(order.id, {
      status: "dispatched",
      assignedStationId: station.id,
      sessionId: station.sessionId ?? order.sessionId,
      startedAt: new Date(),
    });
    if (opts.pool) {
      opts.pool.reserve(productId, order.id, 1);
      resourceAllowance = opts.pool.canReserve(productId, 1);
    }
    dispatched.push({ workOrderId: order.id, stationId: station.id });
    remainingProductHeadroom -= 1;
    budget -= 1;
  }

  logger.info(
    { productId, dispatched: dispatched.length, held: held.length, productWip: { used: productUsed, limit: productLimit } },
    "[factory] dispatch pass complete",
  );

  return {
    dispatched,
    held,
    productWip: { used: productUsed, limit: productLimit },
    stationWip,
    resourceAllowance,
  };
}

/**
 * Mark a work order done (or skipped) and release its station slot. Returns
 * the updated order. When a pool is supplied, its reservation is released.
 */
export async function completeWorkOrder(
  store: FactoryStore,
  workOrderId: number,
  status: "done" | "skipped",
  pool?: ResourcePool | null,
): Promise<WorkOrder | null> {
  const order = await store.getWorkOrder(workOrderId);
  if (!order) return null;
  if (pool) {
    pool.release(order.productId, workOrderId);
  }
  return store.updateWorkOrder(workOrderId, {
    status,
    completedAt: new Date(),
  });
}

/**
 * Reject a work order at a station gate → route to rework. Increments the
 * rework counter, records the defect class on the station, and returns the
 * order to queued so the next dispatch pass can re-assign it. The pool
 * reservation is released so rework re-acquires on the next dispatch.
 */
export async function rejectToRework(
  store: FactoryStore,
  workOrderId: number,
  defectClass: string,
  pool?: ResourcePool | null,
): Promise<WorkOrder | null> {
  const order = await store.getWorkOrder(workOrderId);
  if (!order) return null;
  if (pool) {
    pool.release(order.productId, workOrderId);
  }
  if (order.assignedStationId != null) {
    const station = await store.getStation(order.assignedStationId);
    if (station) {
      await store.updateStation(station.id, {
        defectCount: station.defectCount + 1,
        reworkCycles: station.reworkCycles + 1,
      });
    }
  }
  return store.updateWorkOrder(workOrderId, {
    status: "queued",
    reworkCount: order.reworkCount + 1,
    lastDefectClass: defectClass,
    assignedStationId: null,
    startedAt: null,
  });
}
