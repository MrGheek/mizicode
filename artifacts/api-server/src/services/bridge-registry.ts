/**
 * In-memory registry for active bridge WebSocket connections.
 * Each running claw process connects outbound to the API server and is keyed
 * by `${sessionId}:${laneId}`. Only one active connection per lane is tracked.
 *
 * This module also owns the centralized per-lane exec lock so that all callers
 * — both the bridge exec SSE route and the file-tree API — share the same
 * mutual-exclusion domain and cannot cross-pollute frames on the same socket.
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

/**
 * Returns the first open WebSocket found for a session, with a deterministic
 * preference for lane 1 (the primary orchestration lane).  Falls back to the
 * numerically lowest available lane ID so the result is stable across calls.
 *
 * Used by file-tree API routes that need any available bridge for a session.
 */
export function getBridgeForSession(sessionId: number | string): { ws: WebSocket; laneId: string } | undefined {
  const prefix = `${sessionId}:`;

  // Prefer lane 1 (primary orchestration lane) for determinism
  const laneOneKey = bridgeKey(sessionId, 1);
  const laneOneWs = registry.get(laneOneKey);
  if (laneOneWs && laneOneWs.readyState === laneOneWs.OPEN) {
    return { ws: laneOneWs, laneId: "1" };
  }

  // Fall back to numerically lowest available lane so selection is stable
  let bestLaneId: number | null = null;
  let bestWs: WebSocket | null = null;
  for (const [key, ws] of registry.entries()) {
    if (!key.startsWith(prefix) || ws.readyState !== ws.OPEN) continue;
    const laneIdNum = parseInt(key.slice(prefix.length), 10);
    if (isNaN(laneIdNum)) continue;
    if (bestLaneId === null || laneIdNum < bestLaneId) {
      bestLaneId = laneIdNum;
      bestWs = ws;
    }
  }
  if (bestWs !== null && bestLaneId !== null) {
    return { ws: bestWs, laneId: String(bestLaneId) };
  }
  return undefined;
}

// ─── Centralized per-lane exec lock ──────────────────────────────────────────
//
// All callers that send an `exec` frame on a bridge WS must hold this lock for
// the duration of their command.  The lock is keyed by the bridge key
// (sessionId:laneId) so two different lanes may run concurrently, but two
// callers sharing the same lane WS (e.g. the exec SSE route and a file-tree
// operation) are serialised and cannot interleave their message listeners.
//
// Usage:
//   const held = tryAcquireExecLock(sessionId, laneId);
//   if (!held) { /* reject with 409 */ }
//   try { ... } finally { releaseExecLock(sessionId, laneId); }

const execLocks = new Set<string>();

/**
 * Attempt to acquire the exec lock for a session:lane pair.
 * Returns true if the lock was acquired, false if already held.
 */
export function tryAcquireExecLock(sessionId: number | string, laneId: number | string): boolean {
  const key = bridgeKey(sessionId, laneId);
  if (execLocks.has(key)) return false;
  execLocks.add(key);
  return true;
}

/**
 * Release the exec lock for a session:lane pair.
 * Safe to call even if the lock is not held (no-op).
 */
export function releaseExecLock(sessionId: number | string, laneId: number | string): void {
  execLocks.delete(bridgeKey(sessionId, laneId));
}
