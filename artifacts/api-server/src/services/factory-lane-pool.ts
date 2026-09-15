/**
 * factory-lane-pool.ts — RFC 0006 Phase 1: the shared fab lane pool.
 *
 * Sessions (boxes) are the pool's units. A station CLAIMS a session at
 * dispatch and RELEASES it when idle; orders ride the claim via
 * work_orders.session_id (swarm fan-out up to the station's capacity).
 *
 * The pool is advisory (RFC 0003 non-goal): it gates factory dispatch, never
 * blocks agent mutations. It is a pure decision layer over FactoryStore's
 * station-claim methods plus the sessions table's status column.
 */

import { logger } from "../lib/logger";
import type { Session, Station, StationClaim } from "@workspace/db";
import type { FactoryStore } from "./factory";

// ── Policy ────────────────────────────────────────────────────────────────────

/** Session statuses a claim may target (any runnable, unclaimed box). */
export const CLAIMABLE_SESSION_STATUSES = ["ready"] as const;

export const DEFAULT_IDLE_RELEASE_AFTER_MS = 300_000; // 5 min idle → release
export const DEFAULT_CLAIM_LAPSE_AFTER_MS = 900_000; // 15 min no heartbeat → lapse

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LanePoolStatus {
  lanePoolUsed: number;
  lanePoolLimit: number;
  freeLanes: number;
  activeClaims: number;
}

export interface ClaimCandidate {
  session: Session;
  /** Why this session cannot be claimed (null = claimable). */
  blockedReason: string | null;
}

export interface PoolGrant {
  granted: boolean;
  /** Claim row when granted (store has persisted it). */
  claim?: StationClaim;
  reason: string | null;
}

export interface PoolRelease {
  released: boolean;
  /** Claim ids that were released. */
  claimIds: number[];
  reason: string | null;
}

// ── Pure functions (unit-tested, no DB) ───────────────────────────────────────

/** A session is claimable when runnable, unclaimed, and within the fab limit. */
export function sessionClaimable(
  session: Session,
  activeClaims: StationClaim[],
  lanePoolLimit: number,
  now: Date = new Date(),
): string | null {
  if (!CLAIMABLE_SESSION_STATUSES.includes(session.status as (typeof CLAIMABLE_SESSION_STATUSES)[number])) {
    return `session ${session.id} status is '${session.status}' (need ready)`;
  }
  if (activeClaims.some((c) => c.sessionId === session.id && c.active)) {
    return `session ${session.id} is already claimed`;
  }
  if (activeClaims.filter((c) => c.active).length >= lanePoolLimit) {
    return `fab lane pool saturated (${activeClaims.length}/${lanePoolLimit})`;
  }
  return null;
}

/**
 * Find the claim a station may extend for `workOrderId` (fan-out), or null.
 * A station's active claim can serve the order when the number of in-flight
 * orders riding it is below the station's capacity.
 */
export function findStationClaim(
  station: Station,
  activeClaims: StationClaim[],
  inFlightOrdersOnSession: number,
): StationClaim | null {
  const claim = activeClaims.find((c) => c.active && c.stationId === station.id) ?? null;
  if (!claim) return null;
  return inFlightOrdersOnSession < station.capacity ? claim : null;
}

/**
 * Choose the claimable session to grant to a station, preferring the station's
 * current session (continuity) and then the least-recently-released claim's
 * session (cheap re-claim). Returns null when the pool cannot grant.
 */
export function chooseClaimableSession(
  station: Station,
  candidates: Array<{ session: Session; blockedReason: string | null }>,
  activeClaims: StationClaim[],
): Session | null {
  const claimable = candidates.filter((c) => c.blockedReason === null);
  if (claimable.length === 0) return null;
  const preferred = claimable.find((c) => c.session.id === station.sessionId);
  if (preferred) return preferred.session;
  return claimable[0]!.session;
}

/** Claim expiry for a new claim; long-claim override may extend it. */
export function claimExpiry(now: Date, lapseAfterMs: number): Date {
  return new Date(now.getTime() + lapseAfterMs);
}

// ── Store-backed pool (production) ────────────────────────────────────────────

export async function lanePoolStatus(
  store: FactoryStore,
  factoryId: number,
): Promise<LanePoolStatus> {
  const fab = await store.getFactory(factoryId);
  const claims = await store.listActiveClaims();
  const used = claims.filter((c) => c.active).length;
  const limit = fab?.lanePoolLimit ?? 8;
  return { lanePoolUsed: used, lanePoolLimit: limit, freeLanes: Math.max(0, limit - used), activeClaims: used };
}

/**
 * Attempt to claim a session from the pool for `station` to execute
 * `workOrderId`. Persists the claim via the store when granted.
 */
export async function claimSession(
  store: FactoryStore,
  params: {
    factoryId: number;
    station: Station;
    workOrderId: number;
    sessions: Session[];
    now?: Date;
  },
): Promise<PoolGrant> {
  const now = params.now ?? new Date();
  const fab = await store.getFactory(params.factoryId);
  const activeClaims = await store.listActiveClaims();
  const limit = fab?.lanePoolLimit ?? 8;

  const candidates: ClaimCandidate[] = params.sessions.map((session) => ({
    session,
    blockedReason: sessionClaimable(session, activeClaims, limit, now),
  }));

  const chosen = chooseClaimableSession(params.station, candidates, activeClaims);
  if (!chosen) {
    const reasons = candidates.map((c) => c.blockedReason).filter(Boolean);
    return { granted: false, reason: reasons[0] ?? "no eligible session in the pool" };
  }

  const claim = await store.createStationClaim({
    productId: params.station.productId,
    stationId: params.station.id,
    sessionId: chosen.id,
    workOrderId: params.workOrderId,
    expiresAt: claimExpiry(now, DEFAULT_CLAIM_LAPSE_AFTER_MS),
  });
  logger.info(
    { stationId: params.station.id, sessionId: chosen.id, workOrderId: params.workOrderId },
    "[factory] lane pool claim granted",
  );
  return { granted: true, claim, reason: null };
}

/**
 * Release a claim: mark inactive, record release. Call on the session's last
 * in-flight order completion/rework, or on idle-return / operator release.
 */
export async function releaseClaim(
  store: FactoryStore,
  claimId: number,
): Promise<PoolRelease> {
  const claim = await store.getStationClaim(claimId);
  if (!claim || !claim.active) {
    return { released: false, claimIds: [], reason: claim ? "claim already released" : "claim not found" };
  }
  await store.updateStationClaim(claimId, { active: false, releasedAt: new Date() });
  logger.info({ claimId, sessionId: claim.sessionId }, "[factory] lane pool claim released");
  return { released: true, claimIds: [claimId], reason: null };
}

/**
 * Idle-return on lifecycle: release the active claim(s) on `sessionId` for a
 * product when no in-flight orders remain on that session (last-order rule).
 * Returns released claim ids.
 */
export async function releaseClaimsIfSessionIdle(
  store: FactoryStore,
  params: { sessionId: number; productId: number },
): Promise<number[]> {
  const claims = await store.listActiveClaims(params.productId);
  const own = claims.filter((c) => c.sessionId === params.sessionId);
  if (own.length === 0) return [];
  const inFlight = await store.listWorkOrders(params.productId, ["dispatched", "in_progress"]);
  const busy = inFlight.some((o) => o.sessionId === params.sessionId);
  if (busy) return [];
  const releasedIds: number[] = [];
  for (const claim of own) {
    const result = await releaseClaim(store, claim.id);
    if (result.released) releasedIds.push(claim.id);
  }
  return releasedIds;
}

/**
 * Idle-return sweep: release any active claim whose expiry has passed (lapse),
 * or whose session has no in-flight orders and no heartbeat for longer than
 * `idleReleaseAfterMs`. Returns released claim ids.
 */
export async function sweepIdleClaims(
  store: FactoryStore,
  params: { idleReleaseAfterMs?: number; busySessionIds?: Set<number>; now?: Date } = {},
): Promise<number[]> {
  const now = params.now ?? new Date();
  const idleAfter = params.idleReleaseAfterMs ?? DEFAULT_IDLE_RELEASE_AFTER_MS;
  const claims = await store.listActiveClaims();
  const releasedIds: number[] = [];

  for (const claim of claims) {
    const staleFor = now.getTime() - claim.lastHeartbeatAt.getTime();
    const lapsed = claim.expiresAt.getTime() <= now.getTime();
    const idle = !params.busySessionIds?.has(claim.sessionId) && staleFor >= idleAfter;
    if (lapsed || idle) {
      const result = await releaseClaim(store, claim.id);
      if (result.released) releasedIds.push(claim.id);
    }
  }
  if (releasedIds.length > 0) {
    logger.info({ released: releasedIds.length }, "[factory] idle-claim sweep released claims");
  }
  return releasedIds;
}
