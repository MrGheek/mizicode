/**
 * factory-telemetry.ts — RFC 0003 Phase 3: factory dashboard + metrics surface.
 *
 * Throughput (work orders completed/period), cycle time (work order → merged),
 * defect rate, rework rate, station utilization, WIP occupancy, cost per work
 * order (RFC 0001 ledger). Exposed via the existing metrics/status-bar surface
 * and a factory dashboard.
 *
 * Snapshots are periodic and stored in the factory_metrics table for
 * time-series analysis.
 */

import type { Product, WorkOrder, Station, FactoryMetrics, PipelineStage } from "@workspace/db";
import type { FactoryStore } from "./factory";
import { productWipUsed, stationWipUsed } from "./factory-dispatcher";
import { effectiveStationWipLimit } from "./factory-dispatcher";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StationUtilization {
  stationId: number;
  role: string;
  /** Work orders currently executing (dispatched or in_progress). */
  active: number;
  /** Effective WIP limit (defect-adjusted). */
  effectiveLimit: number;
  /** active / effectiveLimit — clamped to [0, 1]. */
  utilization: number;
}

export interface FactoryDashboard {
  productId: number;
  productName: string;
  repoUrl: string;

  // Throughput
  /** Work orders completed in this snapshot period. */
  completedThisPeriod: number;
  /** Total completed work orders. */
  completedTotal: number;

  // Cycle time
  /** Mean cycle time (startedAt → completedAt) across completed orders, in ms. */
  avgCycleTimeMs: number;
  /** Median cycle time. */
  medianCycleTimeMs: number;

  // Defect / rework
  defectRate: number;
  reworkRate: number;
  meanCyclesToClear: number;

  // WIP occupancy
  productWip: { used: number; limit: number };
  stationUtilization: StationUtilization[];

  // Pipeline
  pipelineStages: Record<PipelineStage, { status: string; gatePassed: boolean } | null>;

  // Cost (placeholder — wired to RFC 0001 ledger when available)
  costPerWorkOrder: number;

  // Snapshot time
  snapshotTime: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function cycleTimeMs(order: WorkOrder): number | null {
  if (!order.startedAt || !order.completedAt) return null;
  return order.completedAt.getTime() - order.startedAt.getTime();
}

// ── Dashboard ────────────────────────────────────────────────────────────────

/**
 * Compute the factory dashboard for a product.
 *
 * Aggregates work-order throughput, cycle time, defect/rework rates,
 * station utilization, WIP occupancy, and pipeline status into a single
 * snapshot suitable for the status-bar surface and factory dashboard.
 */
export async function computeDashboard(
  store: FactoryStore,
  productId: number,
): Promise<FactoryDashboard> {
  const product = await store.getProduct(productId);
  if (!product) throw new Error(`Product ${productId} not found`);

  const orders = await store.listWorkOrders(productId);
  const stations = await store.listStations(productId);

  // ── Throughput ─────────────────────────────────────────────────────────
  const completed = orders.filter((o) => o.status === "done" || o.status === "skipped");
  const completedTotal = completed.length;

  // "This period" = completed in the last 24 hours.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const completedThisPeriod = completed.filter(
    (o) => o.completedAt && o.completedAt >= dayAgo,
  ).length;

  // ── Cycle time ─────────────────────────────────────────────────────────
  const cycleTimes = completed.map(cycleTimeMs).filter((v): v is number => v !== null);
  const avgCycleTimeMs = cycleTimes.length > 0
    ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
    : 0;
  const medianCycleTimeMs = median(cycleTimes);

  // ── Defect / rework ────────────────────────────────────────────────────
  const totalDefects = stations.reduce((s, st) => s + st.defectCount, 0);
  const totalDeliveries = completedTotal + totalDefects;
  const defectRate = totalDeliveries > 0 ? totalDefects / totalDeliveries : 0;

  const reworkOrders = orders.filter((o) => o.reworkCount > 0);
  const reworkRate = orders.length > 0 ? reworkOrders.length / orders.length : 0;

  const meanCyclesToClear = completed.length > 0
    ? completed.reduce((sum, o) => sum + o.reworkCount, 0) / completed.length
    : 0;

  // ── WIP occupancy ──────────────────────────────────────────────────────
  const productWip = { used: productWipUsed(orders), limit: product.wipLimit };

  const stationUtilization: StationUtilization[] = stations.map((s) => {
    const active = stationWipUsed(orders, s.id);
    const completedAtStation = orders.filter(
      (o) => o.assignedStationId === s.id && (o.status === "done" || o.status === "skipped"),
    ).length;
    const defectRate = completedAtStation + s.defectCount > 0
      ? s.defectCount / (completedAtStation + s.defectCount)
      : 0;
    const effectiveLimit = effectiveStationWipLimit(s.wipLimit, defectRate);
    return {
      stationId: s.id,
      role: s.role,
      active,
      effectiveLimit,
      utilization: effectiveLimit > 0 ? Math.min(1, active / effectiveLimit) : 0,
    };
  });

  // ── Pipeline ───────────────────────────────────────────────────────────
  const pipelineRuns = await store.listPipelineRuns(productId);
  const pipelineStages: FactoryDashboard["pipelineStages"] = {
    build: null,
    test: null,
    stage: null,
    ship: null,
  };
  // Get the latest run per stage.
  for (const run of pipelineRuns) {
    const key = run.stage as PipelineStage;
    if (!pipelineStages[key] || run.id > 0) {
      pipelineStages[key] = { status: run.status, gatePassed: run.gatePassed ?? false };
    }
  }

  // ── Cost (placeholder) ─────────────────────────────────────────────────
  // TODO: wire to RFC 0001 ledger for actual cost per work order.
  const costPerWorkOrder = 0;

  return {
    productId,
    productName: product.name,
    repoUrl: product.repoUrl,
    completedThisPeriod,
    completedTotal,
    avgCycleTimeMs,
    medianCycleTimeMs,
    defectRate,
    reworkRate,
    meanCyclesToClear,
    productWip,
    stationUtilization,
    pipelineStages,
    costPerWorkOrder,
    snapshotTime: new Date().toISOString(),
  };
}

// ── Snapshot persistence ─────────────────────────────────────────────────────

/**
 * Take a snapshot of the factory dashboard and persist it to the metrics table.
 * Call this periodically (e.g. on a cron or after each work order completion).
 */
export async function snapshotMetrics(
  store: FactoryStore,
  productId: number,
): Promise<FactoryMetrics> {
  const dashboard = await computeDashboard(store, productId);
  return store.insertFactoryMetrics({
    productId,
    snapshot: dashboard as unknown as Record<string, unknown>,
  });
}

/**
 * Retrieve the most recent metrics snapshots for a product.
 */
export async function getMetricsHistory(
  store: FactoryStore,
  productId: number,
  limit: number = 50,
): Promise<FactoryMetrics[]> {
  return store.listFactoryMetrics(productId, limit);
}
