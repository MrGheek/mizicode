/**
 * Claim Sweeper Service
 *
 * Background job that hard-deletes ghost claims left by lanes that crashed or
 * disconnected without sending a release. Runs on a short interval so the
 * window during which stale claims block other lanes is minimised.
 *
 * A claim is considered expired if either:
 *   - its `expires_at` timestamp has passed, OR
 *   - its `last_heartbeat_at` timestamp is older than LANE_HEARTBEAT_WINDOW_SECONDS
 */

import { db, laneClaimsTable, sessionLanesTable } from "@workspace/db";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { logger } from "../lib/logger";
import { LANE_HEARTBEAT_WINDOW_SECONDS } from "./lane-policy";
import { emitLaneEvent } from "./lane-event-emitter";

export interface SweepResult {
  deleted: number;
  sweptAt: string;
}

export interface ExpireResult {
  deactivated: number;
  sweptAt: string;
}

/**
 * Soft-expire (set active=false) all stale active claims that belong to the
 * given session. Called on GET /lanes so callers always see a consistent view
 * without waiting for the background hard-delete sweeper interval.
 *
 * Preserves the claim rows (unlike sweepExpiredClaims which hard-deletes) so
 * history-preserving callers can still query the inactive rows.
 */
export async function expireStaleClaimsForSession(sessionId: number): Promise<ExpireResult> {
  const now = new Date();
  const heartbeatCutoff = new Date(Date.now() - LANE_HEARTBEAT_WINDOW_SECONDS * 1000);

  const lanes = await db
    .select({ id: sessionLanesTable.id })
    .from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId));

  const laneIds = lanes.map((l) => l.id);
  if (laneIds.length === 0) return { deactivated: 0, sweptAt: now.toISOString() };

  const deactivated = await db
    .update(laneClaimsTable)
    .set({ active: false })
    .where(
      and(
        eq(laneClaimsTable.active, true),
        inArray(laneClaimsTable.laneId, laneIds),
        or(
          lt(laneClaimsTable.expiresAt, now),
          lt(laneClaimsTable.lastHeartbeatAt, heartbeatCutoff),
        ),
      ),
    )
    .returning({ id: laneClaimsTable.id, laneId: laneClaimsTable.laneId, pathOrSymbol: laneClaimsTable.pathOrSymbol, claimType: laneClaimsTable.claimType });

  for (const row of deactivated) {
    emitLaneEvent(sessionId, row.laneId, "claim_expired", {
      claimId: row.id,
      resourcePath: row.pathOrSymbol,
      claimType: row.claimType,
    });
  }

  return { deactivated: deactivated.length, sweptAt: now.toISOString() };
}

/**
 * Hard-delete all globally expired or heartbeat-stale active claims.
 * Safe to call concurrently — the WHERE filter is idempotent.
 */
export async function sweepExpiredClaims(): Promise<SweepResult> {
  const now = new Date();
  const heartbeatCutoff = new Date(Date.now() - LANE_HEARTBEAT_WINDOW_SECONDS * 1000);

  // Single atomic DELETE with RETURNING — no race window between select and delete.
  // Claims are only removed when the stale conditions still hold at delete time.
  const deleted = await db
    .delete(laneClaimsTable)
    .where(
      and(
        eq(laneClaimsTable.active, true),
        or(
          lt(laneClaimsTable.expiresAt, now),
          lt(laneClaimsTable.lastHeartbeatAt, heartbeatCutoff),
        ),
      ),
    )
    .returning({
      id: laneClaimsTable.id,
      laneId: laneClaimsTable.laneId,
      pathOrSymbol: laneClaimsTable.pathOrSymbol,
      claimType: laneClaimsTable.claimType,
    });

  if (deleted.length === 0) return { deleted: 0, sweptAt: now.toISOString() };

  // Fetch session IDs for the affected lanes so we can emit + broadcast events.
  const uniqueLaneIds = [...new Set(deleted.map((c) => c.laneId))];
  const lanes = await db
    .select({ id: sessionLanesTable.id, sessionId: sessionLanesTable.sessionId })
    .from(sessionLanesTable)
    .where(inArray(sessionLanesTable.id, uniqueLaneIds));

  const laneSessionMap = new Map(lanes.map((l) => [l.id, l.sessionId]));

  for (const claim of deleted) {
    const sessionId = laneSessionMap.get(claim.laneId);
    if (sessionId == null) continue;
    emitLaneEvent(sessionId, claim.laneId, "claim_expired", {
      claimId: claim.id,
      resourcePath: claim.pathOrSymbol,
      claimType: claim.claimType,
    });
  }

  return { deleted: deleted.length, sweptAt: now.toISOString() };
}

const SWEEP_INTERVAL_MS = 30_000;

let _sweepTimer: ReturnType<typeof setInterval> | null = null;

export interface SweeperHealth {
  lastRunAt: string | null;
  lastCleared: number;
  totalCleared: number;
  intervalMs: number;
}

let _lastRunAt: string | null = null;
let _lastCleared = 0;
let _totalCleared = 0;

function recordSweepResult(result: SweepResult): void {
  _lastRunAt = result.sweptAt;
  _lastCleared = result.deleted;
  _totalCleared += result.deleted;
}

/**
 * Returns in-memory health metrics for the claim sweeper.
 */
export function getSweeperHealth(): SweeperHealth {
  return {
    lastRunAt: _lastRunAt,
    lastCleared: _lastCleared,
    totalCleared: _totalCleared,
    intervalMs: SWEEP_INTERVAL_MS,
  };
}

/**
 * Record a sweep result that happened outside the interval (e.g. startup sweep).
 * Keeps health metrics consistent regardless of where the sweep was triggered.
 */
export function recordExternalSweep(result: SweepResult): void {
  recordSweepResult(result);
}

/**
 * Start the background sweeper interval. Safe to call once at startup.
 * Calling more than once is a no-op.
 */
export function startClaimSweeper(): void {
  if (_sweepTimer !== null) return;

  _sweepTimer = setInterval(async () => {
    try {
      const result = await sweepExpiredClaims();
      recordSweepResult(result);
      if (result.deleted > 0) {
        logger.info(result, "Claim sweeper hard-deleted ghost claims");
      }
    } catch (err) {
      logger.error({ err }, "Claim sweeper failed");
    }
  }, SWEEP_INTERVAL_MS);

  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "Claim sweeper started");
}
