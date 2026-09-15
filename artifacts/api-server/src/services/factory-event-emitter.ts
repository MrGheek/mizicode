/**
 * factory-event-emitter.ts — RFC 0006 §5: the backend live-event surface for
 * the factory control room (RFC 0005).
 *
 * Mirrors lane-sse-broadcaster.ts: an in-process client registry keyed by
 * productId (plus a fab-wide channel), broadcasting `factory_event` messages
 * to open SSE responses. Emit points are additive — they never alter route
 * response shapes.
 */

import type { Response } from "express";
import type { PipelineStage, PipelineStatus } from "@workspace/db";

// ── Event union (RFC 0006 §5) ─────────────────────────────────────────────────

export type FactoryEvent =
  | { type: "order_dispatched"; workOrderId: number; stationId: number; sessionId: number }
  | { type: "order_completed"; workOrderId: number; status: "done" | "skipped" }
  | { type: "defect_recorded"; workOrderId: number; stationId: number; defectClass: string; cycle: number }
  | { type: "stage_advanced"; pipelineRunId: number; stage: PipelineStage; status: PipelineStatus }
  | { type: "wip_changed"; productWip: { used: number; limit: number } }
  | { type: "pool_changed"; lanePool: { lanePoolUsed: number; lanePoolLimit: number; freeLanes: number } }
  | { type: "arbitration_recomputed"; passId: number; dispatched: number; held: number }
  | { type: "claim_released"; workOrderId: number | null; sessionId: number };

// ── Registry ──────────────────────────────────────────────────────────────────

type SseClient = Response;

/** productId → clients; fab-wide clients live under key 0. */
const productClients = new Map<number, Set<SseClient>>();

export function addFactoryClient(productId: number, res: SseClient): void {
  let clients = productClients.get(productId);
  if (!clients) {
    clients = new Set();
    productClients.set(productId, clients);
  }
  clients.add(res);
}

export function removeFactoryClient(productId: number, res: SseClient): void {
  const clients = productClients.get(productId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) productClients.delete(productId);
  }
}

function writeToClients(clients: Set<SseClient> | undefined, payload: string): void {
  if (!clients || clients.size === 0) return;
  const dead: SseClient[] = [];
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) clients.delete(res);
}

/**
 * Broadcast a factory event to a product's clients and the fab-wide channel
 * (key 0). `productId` may be null for fab-wide-only events.
 */
export function broadcastFactoryEvent(productId: number | null, event: FactoryEvent): void {
  const msg = `data: ${JSON.stringify({ type: "factory_event", event })}\n\n`;
  writeToClients(productClients.get(0), msg);
  if (productId != null && productId !== 0) {
    writeToClients(productClients.get(productId), msg);
  }
}

/** Test seam: drop all registered clients. */
export function resetFactoryEventClients(): void {
  productClients.clear();
}
