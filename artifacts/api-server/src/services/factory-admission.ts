/**
 * factory-admission.ts — RFC 0003 Phase 1: merge-queue admission control.
 *
 * The RFC 0002 merge queue gains admission control: a lane's merge is admitted
 * only when the product's WIP and the station's capacity allow it. This prevents
 * merge pileups — a product at its WIP limit holds new merges instead of
 * enqueueing unbounded work.
 *
 * The check is advisory (RFC 0003 non-goal: no central scheduler as a single
 * point of failure). When no product is registered for a session's repo, the
 * merge is admitted (backwards-compatible with pre-factory sessions).
 */

import { logger } from "../lib/logger";
import type { FactoryStore } from "./factory";
import { productWipUsed, stationWipUsed } from "./factory-dispatcher";

export interface AdmissionDecision {
  admitted: boolean;
  reason: string | null;
  productId: number | null;
  productWip: { used: number; limit: number } | null;
}

/**
 * Decide whether a merge for a session's lane may be enqueued.
 *
 * @param store        factory store (products/work-orders/stations)
 * @param repoUrl      the session's repo URL (product key)
 * @param sessionId    the session backing the station
 * @param laneCount    number of lanes the session is running (station load)
 */
export async function admitMerge(
  store: FactoryStore,
  repoUrl: string | null | undefined,
  sessionId: number,
  laneCount: number,
): Promise<AdmissionDecision> {
  if (!repoUrl) {
    return { admitted: true, reason: null, productId: null, productWip: null };
  }

  const product = await store.getProductByRepo(repoUrl);
  if (!product) {
    // No factory product registered for this repo — pre-factory session.
    return { admitted: true, reason: null, productId: null, productWip: null };
  }

  const orders = await store.listWorkOrders(product.id);
  const used = productWipUsed(orders);
  const limit = product.wipLimit;

  if (used >= limit) {
    const reason = `product WIP saturated (${used}/${limit}) — merge held`;
    logger.info({ productId: product.id, sessionId, reason }, "[factory] merge admission denied");
    return { admitted: false, reason, productId: product.id, productWip: { used, limit } };
  }

  // Station capacity: the session's station must have headroom for the lane.
  const stations = await store.listStations(product.id);
  const station = stations.find((s) => s.sessionId === sessionId);
  if (station) {
    const stationUsed = stationWipUsed(orders, station.id);
    if (stationUsed + laneCount > station.wipLimit) {
      const reason = `station ${station.id} WIP saturated (${stationUsed}/${station.wipLimit}) — merge held`;
      logger.info({ productId: product.id, stationId: station.id, reason }, "[factory] merge admission denied");
      return { admitted: false, reason, productId: product.id, productWip: { used, limit } };
    }
  }

  return { admitted: true, reason: null, productId: product.id, productWip: { used, limit } };
}
