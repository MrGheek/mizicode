/**
 * Lane SSE Broadcaster
 *
 * Shared module that owns the per-session SSE client registry and the two
 * broadcast helpers used by coordination routes AND the lane-event-emitter
 * service.  Keeping the registry here (rather than inside coordination.ts)
 * breaks the import cycle: lane-event-emitter -> this module, and
 * coordination.ts -> this module, with no cycle in either direction.
 */

import type { Response } from "express";

type SseClient = Response;

const coordinationClients = new Map<number, Set<SseClient>>();

export function addCoordinationClient(sessionId: number, res: SseClient): void {
  let clients = coordinationClients.get(sessionId);
  if (!clients) {
    clients = new Set();
    coordinationClients.set(sessionId, clients);
  }
  clients.add(res);
}

export function removeCoordinationClient(sessionId: number, res: SseClient): void {
  const clients = coordinationClients.get(sessionId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) coordinationClients.delete(sessionId);
  }
}

export function broadcastCoordinationUpdate(sessionId: number, prUrl?: string): void {
  const clients = coordinationClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const msg: Record<string, unknown> = { type: "coordination_update", sessionId };
  if (prUrl) msg["prUrl"] = prUrl;
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  const dead: SseClient[] = [];
  for (const res of clients) {
    try { res.write(payload); } catch { dead.push(res); }
  }
  for (const res of dead) clients.delete(res);
  if (clients.size === 0) coordinationClients.delete(sessionId);
}

export interface LaneEventRow {
  id: number;
  sessionId: number;
  laneId: number;
  eventType: string;
  payload: unknown;
  createdAt: Date;
}

export function broadcastLaneEvent(sessionId: number, event: LaneEventRow): void {
  const clients = coordinationClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const msg = `data: ${JSON.stringify({
    type: "lane_event",
    sessionId,
    event: {
      id: event.id,
      sessionId: event.sessionId,
      laneId: event.laneId,
      eventType: event.eventType,
      payload: event.payload ?? null,
      createdAt: event.createdAt.toISOString(),
    },
  })}\n\n`;
  const dead: SseClient[] = [];
  for (const res of clients) {
    try { res.write(msg); } catch { dead.push(res); }
  }
  for (const res of dead) clients.delete(res);
  if (clients.size === 0) coordinationClients.delete(sessionId);
}
