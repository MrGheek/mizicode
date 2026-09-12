/**
 * rework-loop.ts — RFC 0003 Phase 2: defect → rework → re-verify → telemetry.
 *
 * A rejected deliverable (test failure, Arbiter rejection, gate failure)
 * becomes a rework work order with the defect attached. Rework is tracked:
 * which station produced it, what defect class, how many cycles to clear.
 * Defect rate per station is a first-class metric.
 *
 * High-defect stations get lower WIP (defect-adjusted capacity) — fed back
 * into the dispatcher so the factory self-heals under load.
 */

import { logger } from "../lib/logger";
import type { Product, WorkOrder, Station, StationRole } from "@workspace/db";
import type { FactoryStore } from "./factory";
import { rejectToRework, effectiveStationWipLimit } from "./factory-dispatcher";
import { inspectDeliverable, type Deliverable, type DeliverableInspection } from "./deliverable-contract";
import { triggerPipeline } from "./factory-pipeline";
import type { ResourcePool } from "./factory-resource-pool";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReworkResult {
  /** Whether the work order passed inspection and was completed. */
  accepted: boolean;
  /** Inspection result (gates, reasons, defect class). */
  inspection: DeliverableInspection;
  /** The work order (completed or re-routed to queued). */
  workOrder: WorkOrder | null;
}

export interface StationTelemetry {
  stationId: number;
  productId: number;
  role: StationRole;
  defectCount: number;
  reworkCycles: number;
  /** Completed work orders at this station. */
  completedCount: number;
  /** defectCount / (completedCount + defectCount) — defects per deliverable. */
  defectRate: number;
  /** Mean rework cycles to clear across completed orders. */
  meanCyclesToClear: number;
  /** Defect class histogram. */
  defectClasses: Record<string, number>;
  /** WIP limit adjusted for defect rate. */
  effectiveWipLimit: number;
}

export interface ProductTelemetry {
  productId: number;
  totalDefects: number;
  totalReworkCycles: number;
  totalCompleted: number;
  productDefectRate: number;
  stations: StationTelemetry[];
}

// ── Rework loop ──────────────────────────────────────────────────────────────

/**
 * Inspect a deliverable and either complete or rework the work order.
 *
 * If the deliverable conforms (all station-role gates pass + base checks),
 * the work order is marked done. If it fails, the order is routed back to
 * queued via `rejectToRework`, a rework item is recorded, and the station's
 * defect counters are incremented.
 */
export async function submitDeliverable(
  store: FactoryStore,
  deliverable: Deliverable,
  stationRole: StationRole,
  pool?: ResourcePool | null,
): Promise<ReworkResult> {
  // Check work order exists before inspection.
  const existing = await store.getWorkOrder(deliverable.workOrderId);
  if (!existing) {
    const inspection: DeliverableInspection = { conforms: false, gates: [], defectClass: null, reasons: ["work order not found"] };
    return { accepted: false, inspection, workOrder: null };
  }

  const inspection = inspectDeliverable(deliverable, stationRole);

  if (inspection.conforms) {
    if (pool) {
      pool.release(existing.productId, deliverable.workOrderId);
    }
    const order = await store.updateWorkOrder(deliverable.workOrderId, {
      status: "done",
      completedAt: new Date(),
    });
    // Clear rework items — the order has cleared the loop.
    await store.clearReworkItems(deliverable.workOrderId);
    // Trigger the product pipeline (Phase 3).
    try {
      await triggerPipeline(store, existing.productId, deliverable.workOrderId);
    } catch (err) {
      logger.warn({ workOrderId: deliverable.workOrderId }, "[rework-loop] pipeline trigger failed (non-fatal)");
    }
    logger.info({ workOrderId: deliverable.workOrderId, stationId: deliverable.stationId }, "[rework-loop] deliverable accepted");
    return { accepted: true, inspection, workOrder: order };
  }

  // ── Non-conforming → route to rework ──────────────────────────────────
  const defectClass = inspection.defectClass ?? "unknown";
  const order = await rejectToRework(store, deliverable.workOrderId, defectClass, pool);
  if (!order) {
    logger.error({ workOrderId: deliverable.workOrderId }, "[rework-loop] work order not found during rework");
    return { accepted: false, inspection, workOrder: null };
  }

  // Record the rework item for telemetry.
  const station = await store.getStation(deliverable.stationId);
  if (station) {
    await store.createReworkItem({
      workOrderId: deliverable.workOrderId,
      stationId: deliverable.stationId,
      defectClass,
      cycle: order.reworkCount,
    });
  }

  logger.warn(
    { workOrderId: deliverable.workOrderId, defectClass, reworkCount: order.reworkCount },
    "[rework-loop] deliverable rejected → rework",
  );
  return { accepted: false, inspection, workOrder: order };
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/**
 * Compute per-station telemetry for a product.
 *
 * Queries the work-order and station tables to derive defect rate, rework
 * cycles, and defect class distribution. The effective WIP limit is
 * computed from the defect rate so high-defect stations get less work.
 */
export async function stationTelemetry(
  store: FactoryStore,
  productId: number,
): Promise<StationTelemetry[]> {
  const stations = await store.listStations(productId);
  const allOrders = await store.listWorkOrders(productId);

  const results: StationTelemetry[] = [];

  for (const station of stations) {
    const stationOrders = allOrders.filter((o) => o.assignedStationId === station.id);
    const completedCount = stationOrders.filter((o) => o.status === "done" || o.status === "skipped").length;
    const totalDeliverables = completedCount + station.defectCount;
    const defectRate = totalDeliverables > 0 ? station.defectCount / totalDeliverables : 0;

    const doneOrders = stationOrders.filter((o) => o.status === "done" || o.status === "skipped");
    const meanCyclesToClear = doneOrders.length > 0
      ? doneOrders.reduce((sum, o) => sum + o.reworkCount, 0) / doneOrders.length
      : 0;

    // Defect class histogram from rework items.
    const defectClasses: Record<string, number> = {};
    for (const o of stationOrders) {
      if (o.lastDefectClass && o.reworkCount > 0) {
        defectClasses[o.lastDefectClass] = (defectClasses[o.lastDefectClass] ?? 0) + 1;
      }
    }

    const effectiveWipLimit = effectiveStationWipLimit(station.wipLimit, defectRate);

    results.push({
      stationId: station.id,
      productId,
      role: station.role,
      defectCount: station.defectCount,
      reworkCycles: station.reworkCycles,
      completedCount,
      defectRate,
      meanCyclesToClear,
      defectClasses,
      effectiveWipLimit,
    });
  }

  return results;
}

/**
 * Aggregate telemetry for a product across all its stations.
 */
export async function productTelemetry(
  store: FactoryStore,
  productId: number,
): Promise<ProductTelemetry> {
  const stations = await stationTelemetry(store, productId);

  const totalDefects = stations.reduce((s, t) => s + t.defectCount, 0);
  const totalReworkCycles = stations.reduce((s, t) => s + t.reworkCycles, 0);
  const totalCompleted = stations.reduce((s, t) => s + t.completedCount, 0);
  const productDefectRate = totalCompleted + totalDefects > 0
    ? totalDefects / (totalCompleted + totalDefects)
    : 0;

  return {
    productId,
    totalDefects,
    totalReworkCycles,
    totalCompleted,
    productDefectRate,
    stations,
  };
}
