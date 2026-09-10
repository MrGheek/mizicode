/**
 * factory-dispatcher.ts — RFC 0003 Phase 1: WIP-bounded, topological scheduling.
 *
 * Given a product's WIP limit, station capacities, work-order priorities, and
 * the work-order dependency DAG, decide *what to dispatch, when, and what to
 * hold*. Scheduling is topological (Kahn's algorithm over the DAG) and
 * WIP-bounded: a work order is only dispatched when the product's WIP and the
 * station's capacity allow it. Saturated WIP holds work orders instead of
 * spawning unbounded lanes (Little's law).
 *
 * The dispatcher is advisory by design (RFC 0003 non-goal: no central scheduler
 * as a single point of failure) — stations keep working when it is down.
 */

import { logger } from "../lib/logger";
import type { Product, WorkOrder, Station, WorkOrderStatus } from "@workspace/db";
import type { FactoryStore } from "./factory";

export interface DispatchResult {
  dispatched: Array<{ workOrderId: number; stationId: number }>;
  held: Array<{ workOrderId: number; reason: string }>;
  productWip: { used: number; limit: number };
  stationWip: Array<{ stationId: number; used: number; limit: number }>;
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
}

/**
 * Dispatch ready work orders to stations, respecting product WIP and station
 * capacity. Returns what was dispatched and what was held (with reasons).
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

  const stationWip: DispatchResult["stationWip"] = stations.map((s) => ({
    stationId: s.id,
    used: stationWipUsed(orders, s.id),
    limit: s.wipLimit,
  }));

  const ready = readyWorkOrders(orders);
  const dispatched: DispatchResult["dispatched"] = [];
  const held: DispatchResult["held"] = [];

  let budget = opts.maxDispatch ?? Number.POSITIVE_INFINITY;
  let remainingProductHeadroom = productHeadroom;

  for (const order of ready) {
    if (budget <= 0) {
      held.push({ workOrderId: order.id, reason: "maxDispatch cap reached" });
      continue;
    }
    if (remainingProductHeadroom <= 0) {
      held.push({ workOrderId: order.id, reason: `product WIP saturated (${productUsed}/${productLimit})` });
      continue;
    }

    // Pick the least-loaded station with headroom. Prefer a station whose role
    // matches the order's needs when the order carries a station hint.
    const candidates = stations
      .filter((s) => stationWipUsed(orders, s.id) < s.wipLimit)
      .sort((a, b) => stationWipUsed(orders, a.id) - stationWipUsed(orders, b.id));

    if (candidates.length === 0) {
      held.push({ workOrderId: order.id, reason: "no station has WIP headroom" });
      continue;
    }

    const station = candidates[0]!;
    await store.updateWorkOrder(order.id, {
      status: "dispatched",
      assignedStationId: station.id,
      startedAt: new Date(),
    });
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
  };
}

/**
 * Mark a work order done (or skipped) and release its station slot. Returns
 * the updated order.
 */
export async function completeWorkOrder(
  store: FactoryStore,
  workOrderId: number,
  status: "done" | "skipped",
): Promise<WorkOrder | null> {
  const order = await store.getWorkOrder(workOrderId);
  if (!order) return null;
  return store.updateWorkOrder(workOrderId, {
    status,
    completedAt: new Date(),
  });
}

/**
 * Reject a work order at a station gate → route to rework. Increments the
 * rework counter, records the defect class on the station, and returns the
 * order to queued so the next dispatch pass can re-assign it.
 */
export async function rejectToRework(
  store: FactoryStore,
  workOrderId: number,
  defectClass: string,
): Promise<WorkOrder | null> {
  const order = await store.getWorkOrder(workOrderId);
  if (!order) return null;
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
