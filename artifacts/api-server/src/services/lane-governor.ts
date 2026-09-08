/**
 * lane-governor.ts — RFC 0002 Phase 3 (governance)
 *
 * Operational safety and self-correction for the lane system:
 *
 *   1. Per-lane permission profiles — allow/deny tool lists per lane type,
 *      enforced in the MCP tool layer. A `review` lane cannot run `docker`;
 *      a `backend` lane cannot touch `frontend/**` unless claimed.
 *   2. Lane circuit breakers — per-lane failure counters (3 consecutive
 *      failures trips the breaker). A tripped lane auto-degrades instead of
 *      failing or overspending.
 *   3. Reconcile pass — post-session scan for orphan claims, uncommitted
 *      work, ghost worktrees, and goal-alignment gaps. Extends claim-sweeper
 *      from "delete stale rows" to "surface and recover abandoned work."
 *   4. Takeover protocol — a lane can adopt another lane's branch, worktree,
 *      events, and claims after evidence-based lock-break (the previous lane
 *      is provably dead: no heartbeat, no live process, stale lock). Forced
 *      breaks are recorded as recovery incidents.
 *
 * The store is pluggable so the logic is unit-testable without a DB; the
 * production store persists breaker state and takeover incidents.
 */

import { logger } from "../lib/logger";
import type { LaneType } from "@workspace/db";

// ── 1. Per-lane permission profiles ──────────────────────────────────────────

export interface LanePermissionProfile {
  /** MCP tool names this lane type may call. Empty = no restriction. */
  allowTools: string[];
  /** MCP tool names this lane type may never call (wins over allowTools). */
  denyTools: string[];
  /** Path prefixes this lane type may touch (e.g. ["src/backend/**"]). */
  allowPaths: string[];
  /** Path prefixes this lane type may never touch (wins over allowPaths). */
  denyPaths: string[];
}

export const LANE_PERMISSION_PROFILES: Record<LaneType, LanePermissionProfile> = {
  ux: {
    allowTools: [],
    denyTools: ["docker", "sql", "port_scan", "dns", "terraform"],
    allowPaths: ["src/frontend", "src/components", "src/styles", "src/pages", "public"],
    denyPaths: ["src/backend", "src/services", "lib/db", "migrations"],
  },
  debug: {
    allowTools: [],
    denyTools: ["docker", "terraform", "dns"],
    allowPaths: [],
    denyPaths: [],
  },
  backend: {
    allowTools: [],
    denyTools: ["terraform", "dns"],
    allowPaths: ["src/backend", "src/services", "lib/db", "migrations", "src/api"],
    denyPaths: ["src/frontend", "src/components", "src/styles", "public"],
  },
  review: {
    allowTools: ["read", "grep", "list_lanes", "list_claims", "get_repo_status", "repo_search", "ctx_search", "list_merge_queue"],
    denyTools: ["docker", "sql", "port_scan", "dns", "terraform", "write_file", "edit_file", "run_command", "externalize_output", "filter_terminal_output"],
    allowPaths: [],
    denyPaths: [],
  },
  general: {
    allowTools: [],
    denyTools: ["terraform", "dns"],
    allowPaths: [],
    denyPaths: [],
  },
};

export interface PermissionCheck {
  allowed: boolean;
  reason: string;
}

/**
 * Check whether a lane type may call a tool (optionally on a path).
 * deny* wins over allow*; empty allow* means unrestricted.
 */
export function checkLanePermission(
  laneType: string,
  toolName: string,
  path?: string | null,
): PermissionCheck {
  const profile = LANE_PERMISSION_PROFILES[laneType as LaneType] ?? LANE_PERMISSION_PROFILES.general;

  if (profile.denyTools.includes(toolName)) {
    return { allowed: false, reason: `tool "${toolName}" is denied for ${laneType} lanes` };
  }
  if (profile.allowTools.length > 0 && !profile.allowTools.includes(toolName)) {
    return { allowed: false, reason: `tool "${toolName}" is not in the ${laneType} allow-list` };
  }

  if (path) {
    const norm = path.replace(/\\/g, "/");
    if (profile.denyPaths.some((p) => norm.startsWith(p.replace(/\/\*+$/, "")))) {
      return { allowed: false, reason: `path "${path}" is denied for ${laneType} lanes` };
    }
    if (profile.allowPaths.length > 0 && !profile.allowPaths.some((p) => norm.startsWith(p.replace(/\/\*+$/, "")))) {
      return { allowed: false, reason: `path "${path}" is outside the ${laneType} allow-list` };
    }
  }

  return { allowed: true, reason: "allowed" };
}

// ── 2. Circuit breakers ──────────────────────────────────────────────────────

export const BREAKER_TRIP_THRESHOLD = 3;

export interface BreakerState {
  consecutiveFailures: number;
  tripped: boolean;
  trippedAt: string | null;
  lastFailureAt: string | null;
}

export function newBreakerState(): BreakerState {
  return { consecutiveFailures: 0, tripped: false, trippedAt: null, lastFailureAt: null };
}

/** Record a lane failure; trips the breaker after BREAKER_TRIP_THRESHOLD. */
export function recordLaneFailure(state: BreakerState): BreakerState {
  const next: BreakerState = {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailureAt: new Date().toISOString(),
  };
  if (next.consecutiveFailures >= BREAKER_TRIP_THRESHOLD && !next.tripped) {
    next.tripped = true;
    next.trippedAt = new Date().toISOString();
  }
  return next;
}

/** Record a lane success; resets the failure counter and un-trips. */
export function recordLaneSuccess(state: BreakerState): BreakerState {
  return { ...newBreakerState() };
}

export function isLaneTripped(state: BreakerState): boolean {
  return state.tripped;
}

// ── 3. Reconcile pass ────────────────────────────────────────────────────────

export interface ReconcileResult {
  orphanClaims: number;
  uncommittedLanes: string[];
  ghostWorktrees: string[];
  goalGaps: string[];
}

export interface ReconcileInput {
  /** Active claims that have no live lane (lane deleted / session gone). */
  orphanClaims: number;
  /** Lane member identifiers with uncommitted work. */
  uncommittedLanes: string[];
  /** Worktree paths that exist but have no matching lane. */
  ghostWorktrees: string[];
  /** Goal-alignment gaps (e.g. tasks with no lane assigned). */
  goalGaps: string[];
}

export function reconcileSession(input: ReconcileInput): ReconcileResult {
  return {
    orphanClaims: input.orphanClaims,
    uncommittedLanes: input.uncommittedLanes,
    ghostWorktrees: input.ghostWorktrees,
    goalGaps: input.goalGaps,
  };
}

// ── 4. Takeover protocol ──────────────────────────────────────────────────────

export interface TakeoverEvidence {
  /** The previous lane's claims are heartbeat-stale. */
  heartbeatStale: boolean;
  /** No live process is associated with the previous lane. */
  noLiveProcess: boolean;
  /** The previous lane's lock is older than the takeover window. */
  lockStale: boolean;
}

export interface TakeoverRequest {
  sessionId: number;
  fromLaneId: number;
  toLaneId: number;
  reason: string;
  evidence: TakeoverEvidence;
}

export interface TakeoverResult {
  ok: boolean;
  reason: string;
  incident: TakeoverIncident | null;
}

export interface TakeoverIncident {
  id: number;
  sessionId: number;
  fromLaneId: number;
  toLaneId: number;
  reason: string;
  evidence: TakeoverEvidence;
  createdAt: string;
}

export interface GovernanceStore {
  getBreaker(laneId: number): Promise<BreakerState>;
  setBreaker(laneId: number, state: BreakerState): Promise<void>;
  recordTakeover(incident: Omit<TakeoverIncident, "id" | "createdAt">): Promise<TakeoverIncident>;
  listTakeovers(sessionId: number): Promise<TakeoverIncident[]>;
}

export class MemoryGovernanceStore implements GovernanceStore {
  private breakers = new Map<number, BreakerState>();
  private takeovers: TakeoverIncident[] = [];
  private nextId = 1;

  async getBreaker(laneId: number): Promise<BreakerState> {
    return this.breakers.get(laneId) ?? newBreakerState();
  }

  async setBreaker(laneId: number, state: BreakerState): Promise<void> {
    this.breakers.set(laneId, state);
  }

  async recordTakeover(incident: Omit<TakeoverIncident, "id" | "createdAt">): Promise<TakeoverIncident> {
    const row: TakeoverIncident = { ...incident, id: this.nextId++, createdAt: new Date().toISOString() };
    this.takeovers.push(row);
    return row;
  }

  async listTakeovers(sessionId: number): Promise<TakeoverIncident[]> {
    return this.takeovers.filter((t) => t.sessionId === sessionId);
  }

  clear(): void {
    this.breakers.clear();
    this.takeovers = [];
  }
}

/**
 * Evidence-based takeover: a lane may adopt another lane's work only when the
 * previous lane is provably dead (stale heartbeat + no live process + stale
 * lock). Forced breaks are recorded as recovery incidents.
 */
export async function takeoverLane(
  store: GovernanceStore,
  req: TakeoverRequest,
): Promise<TakeoverResult> {
  const evidenceMet = req.evidence.heartbeatStale && req.evidence.noLiveProcess && req.evidence.lockStale;
  if (!evidenceMet) {
    return {
      ok: false,
      reason: "takeover requires evidence: stale heartbeat + no live process + stale lock",
      incident: null,
    };
  }

  const incident = await store.recordTakeover({
    sessionId: req.sessionId,
    fromLaneId: req.fromLaneId,
    toLaneId: req.toLaneId,
    reason: req.reason,
    evidence: req.evidence,
  });
  logger.warn({ incident }, "Lane takeover recorded (recovery incident)");
  return { ok: true, reason: "takeover granted", incident };
}

// ── Production DB-backed store ────────────────────────────────────────────────

/**
 * Production governance store. Breaker state and takeover incidents persist in
 * the lane_governance table. Lazy-imports @workspace/db to avoid a static
 * import cycle at module load.
 */
export function createDbGovernanceStore(): GovernanceStore {
  return {
    async getBreaker(laneId) {
      const { db, laneGovernanceTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(laneGovernanceTable).where(eq(laneGovernanceTable.laneId, laneId));
      if (!row?.breakerState) return newBreakerState();
      return row.breakerState as BreakerState;
    },
    async setBreaker(laneId, state) {
      const { db, laneGovernanceTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      await db.insert(laneGovernanceTable).values({
        laneId,
        breakerState: state as unknown as Record<string, unknown>,
      }).onConflictDoUpdate({
        target: laneGovernanceTable.laneId,
        set: { breakerState: state as unknown as Record<string, unknown> },
      });
    },
    async recordTakeover(incident) {
      const { db, laneGovernanceTable } = await import("@workspace/db");
      const [row] = await db.insert(laneGovernanceTable).values({
        sessionId: incident.sessionId,
        laneId: incident.toLaneId,
        takeoverFromLaneId: incident.fromLaneId,
        takeoverReason: incident.reason,
        takeoverEvidence: incident.evidence as unknown as Record<string, unknown>,
      }).returning();
      return {
        id: row.id,
        sessionId: row.sessionId ?? incident.sessionId,
        fromLaneId: row.takeoverFromLaneId ?? 0,
        toLaneId: row.laneId,
        reason: row.takeoverReason ?? "",
        evidence: (row.takeoverEvidence as TakeoverEvidence | null) ?? { heartbeatStale: false, noLiveProcess: false, lockStale: false },
        createdAt: row.createdAt.toISOString(),
      };
    },
    async listTakeovers(sessionId) {
      const { db, laneGovernanceTable } = await import("@workspace/db");
      const { eq, and, isNotNull } = await import("drizzle-orm");
      const rows = await db.select().from(laneGovernanceTable)
        .where(and(
          eq(laneGovernanceTable.sessionId, sessionId),
          isNotNull(laneGovernanceTable.takeoverFromLaneId),
        ));
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.sessionId ?? sessionId,
        fromLaneId: row.takeoverFromLaneId ?? 0,
        toLaneId: row.laneId,
        reason: row.takeoverReason ?? "",
        evidence: (row.takeoverEvidence as TakeoverEvidence | null) ?? { heartbeatStale: false, noLiveProcess: false, lockStale: false },
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };
}