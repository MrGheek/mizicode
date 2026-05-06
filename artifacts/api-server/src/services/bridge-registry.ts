/**
 * In-memory registry for active bridge WebSocket connections.
 * Each running claw process connects outbound to the API server and is keyed
 * by `${sessionId}:${laneId}`. Only one active connection per lane is tracked.
 */

import type { WebSocket } from "ws";

const registry = new Map<string, WebSocket>();

export function bridgeKey(sessionId: number | string, laneId: number | string): string {
  return `${sessionId}:${laneId}`;
}

export function registerBridge(sessionId: number | string, laneId: number | string, ws: WebSocket): void {
  const key = bridgeKey(sessionId, laneId);
  const existing = registry.get(key);
  if (existing && existing.readyState === existing.OPEN) {
    existing.close(1001, "Superseded by new connection");
  }
  registry.set(key, ws);
}

export function unregisterBridge(sessionId: number | string, laneId: number | string): void {
  registry.delete(bridgeKey(sessionId, laneId));
}

export function getBridge(sessionId: number | string, laneId: number | string): WebSocket | undefined {
  return registry.get(bridgeKey(sessionId, laneId));
}

export function getBridgeStatus(sessionId: number | string, laneId: number | string): "connected" | "disconnected" {
  const ws = registry.get(bridgeKey(sessionId, laneId));
  if (!ws) return "disconnected";
  return ws.readyState === ws.OPEN ? "connected" : "disconnected";
}

export function listBridgeKeys(): string[] {
  return Array.from(registry.keys());
}
