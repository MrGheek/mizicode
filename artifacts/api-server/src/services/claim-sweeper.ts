/**
 * Claim Sweeper Service
 *
 * Background job that deactivates ghost claims left by lanes that crashed or
 * disconnected without sending a release. Runs on a short interval so the
 * window during which stale claims block other lanes is minimised.
 *
 * A claim is considered expired if either:
 *   - its `expires_at` timestamp has passed, OR
 *   - its `last_heartbeat_at` timestamp is older than LANE_HEARTBEAT_WINDOW_SECONDS
 *
 * We set `active = false` rather than deleting so that audit history is preserved.
 */

import { db, laneClaimsTable } from "@workspace/db";
import { and, eq, lt, or } from "drizzle-orm";
import { logger } from "../lib/logger";
import { LANE_HEARTBEAT_WINDOW_SECONDS } from "./lane-policy";

export interface SweepResult {
  deactivated: number;
  sweptAt: string;
}

/**
 * Mark all globally expired or heartbeat-stale active claims as inactive.
 * Safe to call concurrently — the WHERE filter is idempotent.
 */
export async function sweepExpiredClaims(): Promise<SweepResult> {
  const now = new Date();
  const heartbeatCutoff = new Date(Date.now() - LANE_HEARTBEAT_WINDOW_SECONDS * 1000);

  const deactivated = await db
    .update(laneClaimsTable)
    .set({ active: false })
    .where(
      and(
        eq(laneClaimsTable.active, true),
        or(
          lt(laneClaimsTable.expiresAt, now),
          lt(laneClaimsTable.lastHeartbeatAt, heartbeatCutoff),
        ),
      ),
    )
    .returning({ id: laneClaimsTable.id });

  return { deactivated: deactivated.length, sweptAt: now.toISOString() };
}

const SWEEP_INTERVAL_MS = 30_000;

let _sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background sweeper interval. Safe to call once at startup.
 * Calling more than once is a no-op.
 */
export function startClaimSweeper(): void {
  if (_sweepTimer !== null) return;

  _sweepTimer = setInterval(async () => {
    try {
      const result = await sweepExpiredClaims();
      if (result.deactivated > 0) {
        logger.info(result, "Claim sweeper deactivated ghost claims");
      }
    } catch (err) {
      logger.error({ err }, "Claim sweeper failed");
    }
  }, SWEEP_INTERVAL_MS);

  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "Claim sweeper started");
}
