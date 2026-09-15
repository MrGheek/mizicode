/**
 * factory-arbitration.ts — RFC 0006 Phase 2: fab-wide, multi-product dispatch
 * with an explicit arbitration readout.
 *
 * One pass across every product in the fab:
 *   dispatchScore = productWeight · orderWeight · dueDatePressure · budgetWeight
 *
 * The pass dispatches greedily in score order against each product's WIP,
 * station headroom, and the shared fab lane pool (§ factory-lane-pool.ts).
 * The readout explains every decision: factors, `lostTo`, held reasons, and a
 * starvation signal when a senior product is starved by lower-priority claims.
 *
 * Advisory by design (RFC 0003 non-goal): the pass never aborts work; the
 * operator may release a claim explicitly (human-in-the-loop preemption).
 */

import { logger } from "../lib/logger";
import { readyWorkOrders, productWipUsed, stationWipUsed, effectiveStationWipLimit } from "./factory-dispatcher";
import { claimSession, findStationClaim, CLAIMABLE_SESSION_STATUSES, DEFAULT_CLAIM_LAPSE_AFTER_MS, type LanePoolStatus } from "./factory-lane-pool";
import type { FactoryStore } from "./factory";
import type { Product, Station, WorkOrder, Session, ProductPriority, WorkOrderPriority } from "@workspace/db";
import { db, sessionsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// ── Score factors ─────────────────────────────────────────────────────────────

export interface ArbitrationFactors {
  productWeight: number;
  orderWeight: number;
  dueDatePressure: number;
  budgetWeight: number;
}

export interface ArbitrationLine {
  workOrderId: number;
  productId: number;
  productPriority: ProductPriority;
  orderPriority: WorkOrderPriority;
  dueDate: string | null;
  dispatchScore: number;
  factors: ArbitrationFactors;
  outcome: "dispatched" | "held";
  reason: string | null;
  /** Orders that beat this one when held on "outranked". */
  lostTo: Array<{ workOrderId: number; dispatchScore: number; productId: number }>;
}

export interface StarvationSignal {
  starvedWorkOrderId: number;
  productId: number;
  heldForMs: number;
  holdingClaims: Array<{ claimId: number; productId: number; stationId: number; sessionId: number; score: number }>;
}

export interface ArbitrationPass {
  passId: number;
  ranAt: string;
  dispatched: number;
  held: number;
  lines: ArbitrationLine[];
  starvationSignals: StarvationSignal[];
  lanePool: LanePoolStatus;
}

/** Standing product-priority weights (RFC 0006 decision defaults). */
export const PRODUCT_WEIGHTS: Record<ProductPriority, number> = { p0: 1.0, p1: 0.6, p2: 0.3 };
export const ORDER_WEIGHTS: Record<WorkOrderPriority, number> = { high: 1.0, normal: 0.6, low: 0.3 };
export const DEFAULT_EXPECTED_CYCLE_MS = 3_600_000; // 1 h fallback

export const DEFAULT_STARVED_AFTER_MS = 600_000; // 10 min

export function dueDatePressure(dueDate: Date | null, now: Date, expectedCycleMs: number): number {
  if (!dueDate) return 1;
  const slack = (dueDate.getTime() - now.getTime()) / expectedCycleMs;
  if (slack >= 2) return 0.5;
  if (slack >= 0) return 1.0;
  return 1.5;
}

export function budgetWeight(spentUsd: number, budgetUsd: number | null): number {
  if (!budgetUsd || budgetUsd <= 0) return 1;
  const remaining = Math.min(1, Math.max(0, 1 - spentUsd / budgetUsd));
  return 0.25 + 0.75 * remaining;
}

/** Pure dispatch-score computation for one order. */
export function dispatchScoreFor(params: {
  productPriority: ProductPriority;
  orderPriority: WorkOrderPriority;
  dueDate: Date | null;
  spentUsd: number;
  budgetUsd: number | null;
  now?: Date;
  expectedCycleMs?: number;
}): { score: number; factors: ArbitrationFactors } {
  const now = params.now ?? new Date();
  const productWeight = PRODUCT_WEIGHTS[params.productPriority] ?? PRODUCT_WEIGHTS.p2;
  const orderWeight = ORDER_WEIGHTS[params.orderPriority] ?? ORDER_WEIGHTS.normal;
  const pressure = dueDatePressure(params.dueDate, now, params.expectedCycleMs ?? DEFAULT_EXPECTED_CYCLE_MS);
  const budget = budgetWeight(params.spentUsd, params.budgetUsd);
  const factors = { productWeight, orderWeight, dueDatePressure: pressure, budgetWeight: budget };
  return { score: productWeight * orderWeight * pressure * budget, factors };
}

function stationDefectRate(station: Station, completedCount: number): number {
  const total = completedCount + station.defectCount;
  return total > 0 ? station.defectCount / total : 0;
}

// ── The pass ──────────────────────────────────────────────────────────────────

let nextPassId = 1;

export async function runArbitrationPass(
  store: FactoryStore,
  params: { factoryId: number; sessions?: Session[]; spentByProduct?: Map<number, number>; now?: Date } = { factoryId: 0 },
): Promise<ArbitrationPass> {
  const now = params.now ?? new Date();
  const passId = nextPassId++;

  const products = await store.listProducts();
  const activeClaims = await store.listActiveClaims();
  const fab = await store.getFactory(params.factoryId);
  const lanePoolLimit = fab?.lanePoolLimit ?? 8;
  const lanePoolUsedAtStart = activeClaims.filter((c) => c.active).length;

  // Eligible pool units: any runnable, unclaimed session. Inject for tests;
  // production fetches from the sessions table.
  const sessions: Session[] =
    params.sessions ??
    (await db.select().from(sessionsTable).where(inArray(sessionsTable.status, CLAIMABLE_SESSION_STATUSES)));

  const spentByProduct = params.spentByProduct ?? new Map<number, number>();

  interface Scored {
    order: WorkOrder;
    product: Product;
    score: number;
    factors: ArbitrationFactors;
  }
  const scored: Scored[] = [];

  // Freeze pass-start state so in-pass dispatches are accounted exactly once,
  // independent of whether the store mutates rows in place or snapshots them.
  interface ProductState {
    initialOrders: WorkOrder[];
    initialProductWip: number;
    initialWipByStation: Map<number, number>;
    completedByStation: Map<number, number>;
    stations: Station[];
  }
  const stateByProduct = new Map<number, ProductState>();

  for (const product of products) {
    const orders = await store.listWorkOrders(product.id);
    const stations = await store.listStations(product.id);
    const initialWipByStation = new Map<number, number>();
    const completedByStation = new Map<number, number>();
    for (const o of orders) {
      if (o.assignedStationId != null) {
        const inFlight = o.status === "dispatched" || o.status === "in_progress";
        const terminal = o.status === "done" || o.status === "skipped";
        if (inFlight) initialWipByStation.set(o.assignedStationId, (initialWipByStation.get(o.assignedStationId) ?? 0) + 1);
        if (terminal) completedByStation.set(o.assignedStationId, (completedByStation.get(o.assignedStationId) ?? 0) + 1);
      }
    }
    stateByProduct.set(product.id, {
      initialOrders: orders,
      initialProductWip: productWipUsed(orders),
      initialWipByStation,
      completedByStation,
      stations,
    });

    const ready = readyWorkOrders(orders);
    for (const order of ready) {
      const { score, factors } = dispatchScoreFor({
        productPriority: product.productPriority,
        orderPriority: order.priority,
        dueDate: product.dueDate,
        spentUsd: spentByProduct.get(product.id) ?? 0,
        budgetUsd: product.budgetUsd ?? null,
        now,
      });
      scored.push({ order, product, score, factors });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.order.createdAt.getTime() - b.order.createdAt.getTime() || a.order.id - b.order.id);

  const lines: ArbitrationLine[] = [];
  const dispatchedOrderIds = new Set<number>();
  const passClaims = [...activeClaims];
  const dispatchedForStation = new Map<number, number>();
  const dispatchedForProduct = new Map<number, number>();
  let inFlightSessions = lanePoolUsedAtStart;
  let remainingHeadroom = lanePoolLimit - lanePoolUsedAtStart;

  for (const { order, product, score, factors } of scored) {
    const lineBase = {
      workOrderId: order.id,
      productId: product.id,
      productPriority: product.productPriority,
      orderPriority: order.priority,
      dueDate: product.dueDate?.toISOString() ?? null,
      dispatchScore: score,
      factors,
    };

    const state = stateByProduct.get(product.id);
    if (!state) {
      lines.push({ ...lineBase, outcome: "held", reason: "missing product state", lostTo: [] });
      continue;
    }
    const productUsed = state.initialProductWip + (dispatchedForProduct.get(product.id) ?? 0);
    const productLimit = product.wipLimit;

    if (productUsed >= productLimit) {
      lines.push({ ...lineBase, outcome: "held", reason: `product WIP saturated (${productUsed}/${productLimit})`, lostTo: [] });
      continue;
    }
    if (remainingHeadroom <= 0) {
      const lostTo = scored
        .filter((s) => dispatchedOrderIds.has(s.order.id) && s.product.id !== product.id)
        .map((s) => ({ workOrderId: s.order.id, dispatchScore: s.score, productId: s.product.id }))
        .slice(0, 3);
      lines.push({ ...lineBase, outcome: "held", reason: `fab lane pool saturated (${lanePoolLimit}/${lanePoolLimit})`, lostTo });
      continue;
    }

    // Station: fan-out on the station's active claim, else claim a session.
    const candidates = state.stations
      .filter((s) => {
        const defectRate = stationDefectRate(s, state.completedByStation.get(s.id) ?? 0);
        const effLimit = effectiveStationWipLimit(s.wipLimit, defectRate);
        return (state.initialWipByStation.get(s.id) ?? 0) + (dispatchedForStation.get(s.id) ?? 0) < effLimit;
      })
      .sort((a, b) => (state.initialWipByStation.get(a.id) ?? 0) - (state.initialWipByStation.get(b.id) ?? 0));

    if (candidates.length === 0) {
      lines.push({ ...lineBase, outcome: "held", reason: "no station has WIP headroom", lostTo: [] });
      continue;
    }

    const station = candidates[0]!;
    const inFlightOnStation = (state.initialWipByStation.get(station.id) ?? 0) + (dispatchedForStation.get(station.id) ?? 0);

    const existingClaim = findStationClaim(station, passClaims, inFlightOnStation);
    let sessionId: number | null = null;

    if (existingClaim) {
      sessionId = existingClaim.sessionId;
      await store.updateStationClaim(existingClaim.id, {
        workOrderId: order.id,
        lastHeartbeatAt: new Date(),
        expiresAt: new Date(now.getTime() + DEFAULT_CLAIM_LAPSE_AFTER_MS),
      });
    } else {
      const grant = await claimSession(store, {
        factoryId: params.factoryId,
        station,
        workOrderId: order.id,
        sessions,
      });
      if (!grant.granted || !grant.claim) {
        lines.push({ ...lineBase, outcome: "held", reason: grant.reason ?? "lane pool could not grant a session", lostTo: [] });
        continue;
      }
      sessionId = grant.claim.sessionId;
      passClaims.push(grant.claim);
      remainingHeadroom -= 1;
      inFlightSessions += 1;
    }

    await store.updateWorkOrder(order.id, {
      status: "dispatched",
      assignedStationId: station.id,
      sessionId,
      startedAt: now,
    });
    dispatchedOrderIds.add(order.id);
    dispatchedForStation.set(station.id, (dispatchedForStation.get(station.id) ?? 0) + 1);
    dispatchedForProduct.set(product.id, (dispatchedForProduct.get(product.id) ?? 0) + 1);
    lines.push({ ...lineBase, outcome: "dispatched", reason: null, lostTo: [] });
  }

  // Starvation signals: senior orders held on pool saturation.
  const starvationSignals: StarvationSignal[] = [];
  for (const line of lines) {
    if (line.outcome === "held" && (line.reason ?? "").includes("lane pool saturated") && line.productPriority !== "p2") {
      const holdingClaims = passClaims
        .filter((c) => c.productId !== line.productId)
        .map((c) => ({ claimId: c.id, productId: c.productId, stationId: c.stationId, sessionId: c.sessionId, score: 0 }));
      starvationSignals.push({
        starvedWorkOrderId: line.workOrderId,
        productId: line.productId,
        heldForMs: 0,
        holdingClaims,
      });
    }
  }

  const dispatched = lines.filter((l) => l.outcome === "dispatched").length;
  const held = lines.filter((l) => l.outcome === "held").length;

  const poolReadout: LanePoolStatus = {
    lanePoolUsed: inFlightSessions,
    lanePoolLimit,
    freeLanes: Math.max(0, lanePoolLimit - inFlightSessions),
    activeClaims: inFlightSessions,
  };

  logger.info({ passId, products: products.length, dispatched, held, pool: poolReadout }, "[factory] arbitration pass complete");

  return {
    passId,
    ranAt: now.toISOString(),
    dispatched,
    held,
    lines,
    starvationSignals,
    lanePool: poolReadout,
  };
}

/** Latest pass retained in-process for the /arbitration/latest endpoint. */
let latestPass: ArbitrationPass | null = null;

export function setLatestPass(pass: ArbitrationPass): void {
  latestPass = pass;
}

export function getLatestPass(): ArbitrationPass | null {
  return latestPass;
}

export function _resetArbitrationForTest(): void {
  latestPass = null;
  nextPassId = 1;
}
