import { logger } from "../lib/logger";
import { db, sessionsTable, sessionLanesTable, laneHandoffsTable, laneHeavyJobsTable } from "@workspace/db";
import { inArray, eq, and, gt, lt, sql } from "drizzle-orm";
import {
  _internalGetDb,
  requestPermission,
  markExecuted,
  recordTranscript,
  registerActionExecutor,
  findPendingByKind,
  listPendingApprovals,
  type SafetyAction,
} from "./safety";
import {
  listObservations,
  listSessions,
  listStaleItems,
  listConflicts,
  bulkUpdateStaleItems,
  runStaleSweep,
  getReviewNeededCount,
  updateConflictStatus,
} from "./memory";

/**
 * Ambient Mode — always-on background agent.
 *
 * One runner instance manages every account. For each enabled account it
 * holds a *per-account* lock so multiple processes can coexist without
 * stepping on each other (one account ≡ one active cycle anywhere). Wake
 * times are persisted to ambient_config.next_wake_at so a process restart
 * resumes the schedule rather than resetting it.
 *
 * Each cycle does scout → garden → work, with intra-cycle preemption
 * checkpoints so an interactive user session causes the runner to abort
 * the cycle within seconds rather than only between cycles. Token,
 * GPU-minute, and wall-clock budgets are all enforced over a rolling
 * window and any of them being exhausted skips the cycle and pushes the
 * next wake out into the future.
 */

const DEFAULT_OPERATOR_USER_ID = process.env["MIZI_MEM_USER_ID"] || "operator";
const DEFAULT_ACCOUNT_ID = process.env["AMBIENT_ACCOUNT_ID"] || "default";
const RUNNER_HOLDER = `${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const LOCK_TTL_MS = 90 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
const MIN_INTERVAL_MS = 30 * 1000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const PREEMPT_INTERVAL_MS = 2 * 60 * 1000;
const ACTIVE_STATUSES = ["pending", "provisioning", "downloading", "starting", "ready"];
const GARDEN_CAP_PER_CYCLE = parseInt(process.env["AMBIENT_GARDEN_CAP"] || "20", 10);
const TICK_INTERVAL_MS = 15 * 1000;

let timer: NodeJS.Timeout | null = null;
const accountErrorCounts = new Map<string, number>();
const inProgressAccounts = new Set<string>();

// ─── Config helpers ─────────────────────────────────────────────────────────

export interface AmbientConfig {
  accountId: string;
  enabled: boolean;
  killSwitch: boolean;
  featureFlag: boolean;
  tokenBudget: number;
  gpuMinuteBudget: number;
  wallClockBudgetMs: number;
  rollingWindowMs: number;
  baseIntervalMs: number;
  policyBundle: string;
  allowListedKinds: string[];
  /**
   * Memory user-id this account's ambient agent operates against. Lets
   * multiple accounts have isolated memory namespaces; defaults to the
   * env-configured operator user-id for the "default" account, and to the
   * accountId itself for other accounts.
   */
  operatorUserId: string;
  /**
   * If true, ambient yields whenever any interactive session is active in
   * the workspace. If false, ambient ignores other accounts' sessions.
   * Default true for the "default" account (single-tenant safety),
   * default false for additional accounts.
   */
  preemptOnAnySession: boolean;
  nextWakeAt: number | null;
  updatedAt: number;
}

function rowToConfig(row: Record<string, unknown>): AmbientConfig {
  const accountId = row["account_id"] as string;
  return {
    accountId,
    enabled: !!row["enabled"],
    killSwitch: !!row["kill_switch"],
    featureFlag: !!row["feature_flag"],
    tokenBudget: row["token_budget"] as number,
    gpuMinuteBudget: row["gpu_minute_budget"] as number,
    wallClockBudgetMs: row["wall_clock_budget_ms"] as number,
    rollingWindowMs: row["rolling_window_ms"] as number,
    baseIntervalMs: row["base_interval_ms"] as number,
    policyBundle: row["policy_bundle"] as string,
    allowListedKinds: JSON.parse((row["allow_listed_kinds"] as string) || "[]") as string[],
    operatorUserId: (row["operator_user_id"] as string | null) ?? (accountId === DEFAULT_ACCOUNT_ID ? DEFAULT_OPERATOR_USER_ID : accountId),
    preemptOnAnySession: row["preempt_on_any_session"] === undefined ? true : !!row["preempt_on_any_session"],
    nextWakeAt: (row["next_wake_at"] as number | null) ?? null,
    updatedAt: row["updated_at"] as number,
  };
}

export function getConfig(accountId = DEFAULT_ACCOUNT_ID): AmbientConfig {
  const sdb = _internalGetDb();
  let row = sdb.prepare(`SELECT * FROM ambient_config WHERE account_id = ?`).get(accountId) as Record<string, unknown> | undefined;
  if (!row) {
    sdb.prepare(`INSERT INTO ambient_config (account_id) VALUES (?)`).run(accountId);
    row = sdb.prepare(`SELECT * FROM ambient_config WHERE account_id = ?`).get(accountId) as Record<string, unknown>;
  }
  return rowToConfig(row);
}

export function listAllConfigs(): AmbientConfig[] {
  const sdb = _internalGetDb();
  // Always materialize the default account so the runner has at least one
  // row to consider on a clean install.
  getConfig(DEFAULT_ACCOUNT_ID);
  const rows = sdb.prepare(`SELECT * FROM ambient_config`).all() as Record<string, unknown>[];
  return rows.map(rowToConfig);
}

export function updateConfig(accountId: string, patch: Partial<AmbientConfig>): AmbientConfig {
  const sdb = _internalGetDb();
  getConfig(accountId);
  const fields: string[] = [];
  const args: unknown[] = [];
  const map: Record<string, string> = {
    enabled: "enabled",
    killSwitch: "kill_switch",
    featureFlag: "feature_flag",
    tokenBudget: "token_budget",
    gpuMinuteBudget: "gpu_minute_budget",
    wallClockBudgetMs: "wall_clock_budget_ms",
    rollingWindowMs: "rolling_window_ms",
    baseIntervalMs: "base_interval_ms",
    policyBundle: "policy_bundle",
    operatorUserId: "operator_user_id",
    preemptOnAnySession: "preempt_on_any_session",
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k as keyof AmbientConfig] !== undefined) {
      const v = patch[k as keyof AmbientConfig];
      fields.push(`${col} = ?`);
      args.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
  }
  if (patch.allowListedKinds !== undefined) {
    fields.push(`allow_listed_kinds = ?`);
    args.push(JSON.stringify(patch.allowListedKinds));
  }
  if (patch.nextWakeAt !== undefined) {
    fields.push(`next_wake_at = ?`);
    args.push(patch.nextWakeAt);
  }
  if (fields.length > 0) {
    fields.push(`updated_at = unixepoch()`);
    args.push(accountId);
    sdb.prepare(`UPDATE ambient_config SET ${fields.join(", ")} WHERE account_id = ?`).run(...args);
  }
  return getConfig(accountId);
}

function persistNextWake(accountId: string, nextWakeAtMs: number): void {
  const sdb = _internalGetDb();
  sdb.prepare(`UPDATE ambient_config SET next_wake_at = ?, updated_at = unixepoch() WHERE account_id = ?`)
    .run(Math.floor(nextWakeAtMs / 1000), accountId);
}

// ─── Per-account singleton lock ─────────────────────────────────────────────

function tryAcquireLock(accountId: string): boolean {
  const sdb = _internalGetDb();
  const now = Date.now();
  const expires = now + LOCK_TTL_MS;
  const tx = sdb.transaction(() => {
    const row = sdb.prepare(`SELECT holder, expires_at FROM ambient_lock WHERE account_id = ?`).get(accountId) as { holder: string; expires_at: number } | undefined;
    if (!row || row.expires_at < now || row.holder === RUNNER_HOLDER) {
      sdb.prepare(`
        INSERT INTO ambient_lock (account_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      `).run(accountId, RUNNER_HOLDER, now, expires);
      return true;
    }
    return false;
  });
  return tx();
}

/** Renew lock TTL while we still hold it. Returns false if we lost the lock. */
function heartbeatLock(accountId: string): boolean {
  const sdb = _internalGetDb();
  const now = Date.now();
  const expires = now + LOCK_TTL_MS;
  const r = sdb.prepare(`UPDATE ambient_lock SET expires_at = ? WHERE account_id = ? AND holder = ?`)
    .run(expires, accountId, RUNNER_HOLDER);
  return r.changes > 0;
}

function releaseLock(accountId: string): void {
  const sdb = _internalGetDb();
  sdb.prepare(`DELETE FROM ambient_lock WHERE account_id = ? AND holder = ?`).run(accountId, RUNNER_HOLDER);
}

function getLockHolder(accountId: string): string | null {
  const sdb = _internalGetDb();
  const row = sdb.prepare(`SELECT holder, expires_at FROM ambient_lock WHERE account_id = ?`).get(accountId) as { holder: string; expires_at: number } | undefined;
  return row && row.expires_at > Date.now() ? row.holder : null;
}

// ─── Budgets / preemption ───────────────────────────────────────────────────

// ─── Workspace activity signals ─────────────────────────────────────────────

/**
 * Lightweight workspace-activity snapshot used by both scout (to surface
 * what's going on for the operator) and the adaptive scheduler (to decide
 * how aggressively to wake). All numbers are point-in-time counts; a
 * single failed query degrades to zero rather than failing the cycle.
 */
interface WorkspaceSignals {
  activeLaneCount: number;
  recentlyActiveLaneCount: number; // updated within last 15min
  pendingHandoffCount: number;
  stalePendingHandoffs: Array<{ id: number; laneId: number; ageMs: number; handoffType: string }>;
  queuedHeavyJobCount: number;
  runningHeavyJobCount: number;
  recentlyCompletedHeavyJobCount: number;
}

async function collectWorkspaceSignals(): Promise<WorkspaceSignals> {
  const empty: WorkspaceSignals = {
    activeLaneCount: 0,
    recentlyActiveLaneCount: 0,
    pendingHandoffCount: 0,
    stalePendingHandoffs: [],
    queuedHeavyJobCount: 0,
    runningHeavyJobCount: 0,
    recentlyCompletedHeavyJobCount: 0,
  };
  try {
    const now = new Date();
    const recentCutoff = new Date(now.getTime() - 15 * 60 * 1000);
    const staleHandoffCutoff = new Date(now.getTime() - 60 * 60 * 1000);

    const [activeLanes, recentLanes, pendingHandoffs, staleHandoffs, queuedJobs, runningJobs, recentJobs] = await Promise.all([
      db.select({ c: sql<number>`count(*)` }).from(sessionLanesTable).where(eq(sessionLanesTable.status, "active")),
      db.select({ c: sql<number>`count(*)` }).from(sessionLanesTable).where(gt(sessionLanesTable.updatedAt, recentCutoff)),
      db.select({ c: sql<number>`count(*)` }).from(laneHandoffsTable).where(eq(laneHandoffsTable.status, "pending")),
      db.select({
          id: laneHandoffsTable.id,
          laneId: laneHandoffsTable.laneId,
          createdAt: laneHandoffsTable.createdAt,
          handoffType: laneHandoffsTable.handoffType,
        })
        .from(laneHandoffsTable)
        .where(and(eq(laneHandoffsTable.status, "pending"), lt(laneHandoffsTable.createdAt, staleHandoffCutoff)))
        .limit(20),
      db.select({ c: sql<number>`count(*)` }).from(laneHeavyJobsTable).where(eq(laneHeavyJobsTable.status, "queued")),
      db.select({ c: sql<number>`count(*)` }).from(laneHeavyJobsTable).where(eq(laneHeavyJobsTable.status, "running")),
      db.select({ c: sql<number>`count(*)` }).from(laneHeavyJobsTable)
        .where(and(eq(laneHeavyJobsTable.status, "completed"), gt(laneHeavyJobsTable.completedAt, recentCutoff))),
    ]);
    return {
      activeLaneCount: Number(activeLanes[0]?.c ?? 0),
      recentlyActiveLaneCount: Number(recentLanes[0]?.c ?? 0),
      pendingHandoffCount: Number(pendingHandoffs[0]?.c ?? 0),
      stalePendingHandoffs: staleHandoffs.map(h => ({
        id: h.id,
        laneId: h.laneId,
        ageMs: now.getTime() - new Date(h.createdAt).getTime(),
        handoffType: h.handoffType,
      })),
      queuedHeavyJobCount: Number(queuedJobs[0]?.c ?? 0),
      runningHeavyJobCount: Number(runningJobs[0]?.c ?? 0),
      recentlyCompletedHeavyJobCount: Number(recentJobs[0]?.c ?? 0),
    };
  } catch (err) {
    logger.warn({ err }, "[ambient] collectWorkspaceSignals failed; degrading to empty signals");
    return empty;
  }
}

/**
 * Pick the next wake interval based on workspace pressure and operator
 * follow-through. The base interval is the floor for a quiet workspace;
 * we extend it when the operator has unaddressed approvals (don't pile
 * more on), when many lanes are actively running heavy work (interactive
 * pressure), or when recent cycles have failed (back off on errors). The
 * result is always clamped to [MIN_INTERVAL_MS, MAX_INTERVAL_MS].
 */
function computeAdaptiveIntervalMs(
  cfg: AmbientConfig,
  signals: WorkspaceSignals,
  pendingApprovalCount: number,
  recentErrorCount: number,
): number {
  let multiplier = 1.0;
  // Operator hasn't drained the approval queue yet — wake less often so
  // we don't pile up duplicate proposals (the executors dedupe per kind,
  // but the operator's UX is better if cadence eases).
  if (pendingApprovalCount > 0) multiplier *= 1 + Math.min(2.0, pendingApprovalCount * 0.4);
  // Heavy interactive activity in the workspace: yield more space.
  if (signals.runningHeavyJobCount + signals.activeLaneCount >= 3) multiplier *= 1.5;
  if (signals.runningHeavyJobCount + signals.activeLaneCount >= 6) multiplier *= 1.5;
  // Recent failures: exponential-ish backoff but capped by clamp below.
  if (recentErrorCount > 0) multiplier *= 1 + Math.min(2.0, recentErrorCount * 0.5);
  // Quiet workspace: keep the base interval (no acceleration below base —
  // ambient is "always-on" but never busier than its configured minimum).
  const target = cfg.baseIntervalMs * multiplier;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, target));
}

async function isInteractiveSessionActive(cfg: AmbientConfig): Promise<boolean> {
  // The shared sessions table has no per-account ownership column today, so
  // the only honest scoping option is opt-in: a config that sets
  // preempt_on_any_session = 0 ignores other operators' sessions entirely.
  // The default ("default" account) keeps the safety-first behavior of
  // yielding to any active interactive session.
  if (!cfg.preemptOnAnySession) return false;
  const rows = await db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(inArray(sessionsTable.status, ACTIVE_STATUSES))
    .limit(1);
  return rows.length > 0;
}

interface BudgetUsage {
  tokensUsed: number;
  wallClockMs: number;
  gpuMinutes: number;
  windowStart: number;
}

function getBudgetUsage(accountId: string, windowMs: number): BudgetUsage {
  const sdb = _internalGetDb();
  const cutoff = Math.floor((Date.now() - windowMs) / 1000);
  const row = sdb.prepare(`
    SELECT COALESCE(SUM(tokens_used), 0) AS tokens,
           COALESCE(SUM(wall_clock_ms), 0) AS wall,
           COALESCE(SUM(gpu_minutes_used), 0) AS gpu
    FROM ambient_cycles
    WHERE account_id = ? AND started_at >= ?
  `).get(accountId, cutoff) as { tokens: number; wall: number; gpu: number };
  return {
    tokensUsed: row?.tokens ?? 0,
    wallClockMs: row?.wall ?? 0,
    gpuMinutes: row?.gpu ?? 0,
    windowStart: cutoff * 1000,
  };
}

function isBudgetExhausted(cfg: AmbientConfig): { exhausted: boolean; reason: string; usage: BudgetUsage } {
  const usage = getBudgetUsage(cfg.accountId, cfg.rollingWindowMs);
  if (usage.tokensUsed >= cfg.tokenBudget) return { exhausted: true, reason: `token budget exhausted (${usage.tokensUsed}/${cfg.tokenBudget})`, usage };
  if (usage.wallClockMs >= cfg.wallClockBudgetMs) return { exhausted: true, reason: `wall-clock budget exhausted (${Math.round(usage.wallClockMs/1000)}s/${Math.round(cfg.wallClockBudgetMs/1000)}s)`, usage };
  if (usage.gpuMinutes >= cfg.gpuMinuteBudget) return { exhausted: true, reason: `GPU-minute budget exhausted (${usage.gpuMinutes.toFixed(2)}/${cfg.gpuMinuteBudget})`, usage };
  return { exhausted: false, reason: "", usage };
}

// ─── Preemption checkpoint ──────────────────────────────────────────────────

class PreemptionAbort extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = "PreemptionAbort"; }
}

interface CycleContext {
  cycleId: number;
  cfg: AmbientConfig;
  startMs: number;
  force: boolean;
  /** Mutable accumulator populated by `recordGpuMinutes` during the cycle. */
  gpuMinutesUsed: number;
  /** Workspace activity snapshot captured at cycle start — see scout / work. */
  signals: WorkspaceSignals;
}

async function checkpoint(ctx: CycleContext, label: string): Promise<void> {
  if (ctx.force) return;
  // Wall-clock cap (per-cycle): if a single cycle is consuming more than 25%
  // of its remaining wall-clock budget, bail out gracefully.
  const elapsed = Date.now() - ctx.startMs;
  if (elapsed > ctx.cfg.wallClockBudgetMs * 0.25) {
    throw new PreemptionAbort(`per-cycle wall-clock cap reached at ${label}`);
  }
  if (await isInteractiveSessionActive(ctx.cfg)) {
    throw new PreemptionAbort(`interactive session detected at ${label}`);
  }
}

/**
 * Record GPU minutes consumed during a cycle. Helpers (or future LLM/GPU
 * calls) invoke this so the cycle's total reflects real usage rather than
 * always 0. The accumulator is finalized into ambient_cycles.gpu_minutes_used
 * when the cycle row is written.
 */
export function recordGpuMinutes(ctx: CycleContext, minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  ctx.gpuMinutesUsed += minutes;
}

// ─── Cycle lifecycle ────────────────────────────────────────────────────────

interface CycleSummary {
  cycleId: number;
  status: string;
  reason?: string;
  scoutSummary?: string;
  gardenSummary?: string;
  workSummary?: string;
  approvalsRequested: number;
  approvalsGranted: number;
  approvalsDenied: number;
  gardeningDeltas: number;
  tokensUsed: number;
  wallClockMs: number;
  gpuMinutesUsed: number;
  nextWakeAt: number;
}

function startCycleRow(accountId: string): number {
  const sdb = _internalGetDb();
  const r = sdb.prepare(`INSERT INTO ambient_cycles (account_id, status) VALUES (?, 'running')`).run(accountId);
  return r.lastInsertRowid as number;
}

function finishCycleRow(cycleId: number, summary: Omit<CycleSummary, "cycleId">): void {
  const sdb = _internalGetDb();
  sdb.prepare(`
    UPDATE ambient_cycles SET
      status = ?, reason = ?, scout_summary = ?, garden_summary = ?, work_summary = ?,
      tokens_used = ?, wall_clock_ms = ?, gpu_minutes_used = ?, next_wake_at = ?,
      approvals_requested = ?, approvals_granted = ?, approvals_denied = ?,
      gardening_deltas = ?, ended_at = unixepoch()
    WHERE id = ?
  `).run(
    summary.status,
    summary.reason ?? null,
    summary.scoutSummary ?? null,
    summary.gardenSummary ?? null,
    summary.workSummary ?? null,
    summary.tokensUsed,
    summary.wallClockMs,
    summary.gpuMinutesUsed,
    Math.floor(summary.nextWakeAt / 1000),
    summary.approvalsRequested,
    summary.approvalsGranted,
    summary.approvalsDenied,
    summary.gardeningDeltas,
    cycleId,
  );
}

// ─── Scout / Garden / Work ──────────────────────────────────────────────────

async function scout(ctx: CycleContext): Promise<string> {
  const userId = ctx.cfg.operatorUserId;
  const observations = listObservations(userId, 50, 0);
  const sessions = listSessions(userId, 10, 0);
  const reviewCount = getReviewNeededCount(userId);
  const s = ctx.signals;

  const toolCounts = new Map<string, number>();
  for (const o of observations) {
    toolCounts.set(o.toolName, (toolCounts.get(o.toolName) ?? 0) + 1);
  }
  const top = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const laneBlurb =
    `lanes: ${s.activeLaneCount} active (${s.recentlyActiveLaneCount} active in 15m), ` +
    `handoffs: ${s.pendingHandoffCount} pending (${s.stalePendingHandoffs.length} stale >1h), ` +
    `heavy jobs: ${s.queuedHeavyJobCount} queued / ${s.runningHeavyJobCount} running / ${s.recentlyCompletedHeavyJobCount} completed in 15m`;
  const summary =
    `observed ${observations.length} obs / ${sessions.length} sessions; ${laneBlurb}; ` +
    `review needed: ${reviewCount.total} (stale=${reviewCount.stale}, conflicts=${reviewCount.openConflicts}); ` +
    `top tools: ${top.map(([k, v]) => `${k}(${v})`).join(", ") || "—"}`;

  recordTranscript(null, ctx.cycleId, "scout", summary, {
    observationCount: observations.length,
    sessionCount: sessions.length,
    reviewCount,
    workspaceSignals: {
      activeLaneCount: s.activeLaneCount,
      recentlyActiveLaneCount: s.recentlyActiveLaneCount,
      pendingHandoffCount: s.pendingHandoffCount,
      stalePendingHandoffCount: s.stalePendingHandoffs.length,
      queuedHeavyJobCount: s.queuedHeavyJobCount,
      runningHeavyJobCount: s.runningHeavyJobCount,
      recentlyCompletedHeavyJobCount: s.recentlyCompletedHeavyJobCount,
    },
  });
  return summary;
}

async function garden(ctx: CycleContext): Promise<{ summary: string; deltas: number; approvals: { requested: number; granted: number; denied: number } }> {
  const userId = ctx.cfg.operatorUserId;
  let deltas = 0;
  let requested = 0, granted = 0, denied = 0;

  await checkpoint(ctx, "garden:before-sweep");
  const sweepCount = runStaleSweep(userId);
  if (sweepCount > 0) {
    deltas += sweepCount;
    recordTranscript(null, ctx.cycleId, "garden", `marked ${sweepCount} TTL-expired items stale`, {});
  }

  await checkpoint(ctx, "garden:before-stale-list");
  const staleItems = listStaleItems({ userId, limit: GARDEN_CAP_PER_CYCLE });
  if (staleItems.length > 0) {
    // Dedupe: if a previous cycle already queued a pending dismissal for this
    // account, don't pile up another one. The operator will decide on the
    // existing queued action; once executed/denied, future cycles can request
    // again as needed.
    const existing = findPendingByKind(ctx.cfg.accountId, "memory_garden_dismiss");
    if (existing) {
      recordTranscript(null, ctx.cycleId, "garden", `skipped duplicate dismissal request (existing pending action #${existing.id})`, { existingActionId: existing.id });
    } else {
      const decision = await requestPermission({
        kind: "memory_garden_dismiss",
        summary: `Dismiss ${staleItems.length} stale memory items past TTL`,
        details: { itemIds: staleItems.map(i => i.id), count: staleItems.length },
        requestedBy: "ambient",
        cycleId: ctx.cycleId,
        scope: "local",
        reversible: true,
        externalSurface: false,
        policyBundle: ctx.cfg.policyBundle,
        accountId: ctx.cfg.accountId,
      });
      requested++;
      if (decision.allowed) {
        granted++;
        await checkpoint(ctx, "garden:before-bulk-update");
        const updated = bulkUpdateStaleItems(userId, staleItems.map(i => i.id), "dismiss");
        deltas += updated;
        markExecuted(decision.actionId, true, `dismissed ${updated} items`);
        recordTranscript(decision.actionId, ctx.cycleId, "garden", `dismissed ${updated} stale items`, { itemIds: staleItems.map(i => i.id) });
      } else if (decision.status === "denied" || decision.status === "expired") {
        denied++;
      }
    }
  }

  await checkpoint(ctx, "garden:before-conflicts");
  const conflicts = listConflicts({ userId, conflictStatus: "open", limit: 10, offset: 0 });
  let conflictsResolved = 0;
  if (conflicts.length > 0) {
    const allGroupIds = conflicts.map(c => c.group.id);
    recordTranscript(null, ctx.cycleId, "garden", `${conflicts.length} open conflict groups awaiting review`, { groupIds: allGroupIds });

    // Propose conflict resolution as supersede: the most recent observation
    // in each conflict group is treated as authoritative and the older
    // entries marked resolved. This is reversible (status can be flipped
    // back to "open") and stays local — but the operator must approve.
    const groupIds = allGroupIds.filter((g): g is number => typeof g === "number" && Number.isFinite(g));
    if (groupIds.length > 0) {
      const existing = findPendingByKind(ctx.cfg.accountId, "memory_conflict_resolve");
      if (existing) {
        recordTranscript(null, ctx.cycleId, "garden", `skipped duplicate conflict-resolution request (existing pending action #${existing.id})`, { existingActionId: existing.id });
      } else {
        const decision = await requestPermission({
          kind: "memory_conflict_resolve",
          summary: `Mark ${groupIds.length} memory conflict group(s) as superseded`,
          details: { conflictGroupIds: groupIds, count: groupIds.length, userId },
          requestedBy: "ambient",
          cycleId: ctx.cycleId,
          scope: "local",
          reversible: true,
          externalSurface: false,
          policyBundle: ctx.cfg.policyBundle,
          accountId: ctx.cfg.accountId,
        });
        requested++;
        if (decision.allowed) {
          granted++;
          await checkpoint(ctx, "garden:before-conflict-resolve");
          for (const gid of groupIds) {
            try {
              if (updateConflictStatus({ userId, conflictGroupId: gid, conflictStatus: "resolved" })) {
                conflictsResolved++;
              }
            } catch (err) {
              recordTranscript(decision.actionId, ctx.cycleId, "garden", `conflict resolve failed for group ${gid}: ${err instanceof Error ? err.message : String(err)}`, { conflictGroupId: gid });
            }
          }
          deltas += conflictsResolved;
          markExecuted(decision.actionId, true, `resolved ${conflictsResolved} conflict group(s)`);
          recordTranscript(decision.actionId, ctx.cycleId, "garden", `resolved ${conflictsResolved} conflict group(s)`, { groupIds });
        } else if (decision.status === "denied" || decision.status === "expired") {
          denied++;
        }
      }
    }
  }

  const summary = `swept ${sweepCount}, queued ${staleItems.length} stale dismissals (granted=${granted}), ${conflicts.length} open conflict groups (resolved=${conflictsResolved})`;
  return { summary, deltas, approvals: { requested, granted, denied } };
}

async function work(ctx: CycleContext): Promise<{ summary: string; approvals: { requested: number; granted: number; denied: number } }> {
  let requested = 0, granted = 0, denied = 0;
  const summaries: string[] = [];

  // Action 1: surface a memory-review notification when the queue gets large.
  await checkpoint(ctx, "work:before-review-count");
  const reviewCount = getReviewNeededCount(ctx.cfg.operatorUserId);
  if (reviewCount.total >= 10) {
    const existing = findPendingByKind(ctx.cfg.accountId, "notify_memory_review");
    if (existing) {
      summaries.push(`memory-review notification already pending (action #${existing.id})`);
    } else {
      const decision = await requestPermission({
        kind: "notify_memory_review",
        summary: `Notify operator that ${reviewCount.total} memory items need review`,
        details: reviewCount,
        requestedBy: "ambient",
        cycleId: ctx.cycleId,
        scope: "external",
        reversible: false,
        externalSurface: true,
        policyBundle: ctx.cfg.policyBundle,
        accountId: ctx.cfg.accountId,
      });
      requested++;
      if (decision.allowed) {
        granted++;
        markExecuted(decision.actionId, true, "operator notification dispatched via dashboard");
        summaries.push(`proposed memory-review notification (auto-approved)`);
      } else if (decision.status === "pending") {
        summaries.push(`proposed memory-review notification (queued, action #${decision.actionId})`);
      } else {
        denied++;
        summaries.push(`memory-review notification ${decision.status}: ${decision.reason}`);
      }
    }
  }

  // Action 2: nudge the operator about pending lane handoffs that have been
  // sitting unacknowledged for over an hour. This is the kind of proactive
  // janitorial work users actually appreciate — coordination state going
  // stale is one of the top reasons multi-lane work loses momentum.
  await checkpoint(ctx, "work:before-handoff-check");
  const stale = ctx.signals.stalePendingHandoffs;
  if (stale.length > 0) {
    const existing = findPendingByKind(ctx.cfg.accountId, "lane_handoff_remind");
    if (existing) {
      summaries.push(`lane-handoff reminder already pending (action #${existing.id})`);
    } else {
      const oldestAgeMin = Math.round(Math.max(...stale.map(h => h.ageMs)) / 60000);
      const decision = await requestPermission({
        kind: "lane_handoff_remind",
        summary: `Remind operator about ${stale.length} stale lane handoff(s) (oldest ${oldestAgeMin}m)`,
        details: {
          handoffIds: stale.map(h => h.id),
          oldestAgeMs: Math.max(...stale.map(h => h.ageMs)),
          count: stale.length,
          breakdown: stale.map(h => ({ id: h.id, laneId: h.laneId, ageMs: h.ageMs, type: h.handoffType })),
        },
        requestedBy: "ambient",
        cycleId: ctx.cycleId,
        scope: "external",
        reversible: false,
        externalSurface: true,
        policyBundle: ctx.cfg.policyBundle,
        accountId: ctx.cfg.accountId,
      });
      requested++;
      if (decision.allowed) {
        granted++;
        markExecuted(decision.actionId, true, `lane-handoff reminder surfaced for ${stale.length} handoff(s)`);
        summaries.push(`proposed lane-handoff reminder (auto-approved, ${stale.length} handoffs)`);
      } else if (decision.status === "pending") {
        summaries.push(`proposed lane-handoff reminder (queued, action #${decision.actionId})`);
      } else {
        denied++;
        summaries.push(`lane-handoff reminder ${decision.status}: ${decision.reason}`);
      }
    }
  }

  const summary = summaries.length > 0 ? summaries.join("; ") : "no proactive work proposed";
  recordTranscript(null, ctx.cycleId, "work", summary, { reviewCount, staleHandoffCount: stale.length });
  return { summary, approvals: { requested, granted, denied } };
}

// ─── Public cycle entrypoint ────────────────────────────────────────────────

/**
 * Run a single ambient cycle for one account. This is the **only** place a
 * cycle ever runs from — both the runner tick and the manual
 * `POST /api/ambient/cycle` route call this. The function takes responsibility
 * for the per-account singleton lock (acquire → heartbeat → release) so no
 * caller can accidentally bypass it. If another holder owns the account's
 * lock, this returns immediately with status `lock-busy` rather than running
 * a second concurrent cycle.
 */
export async function runAmbientCycleNow(opts: { force?: boolean; accountId?: string } = {}): Promise<CycleSummary> {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const cfg = getConfig(accountId);
  const force = !!opts.force;

  // Acquire the per-account singleton lock first. This guarantees that the
  // forced manual cycle from the route can't run concurrently with the
  // scheduler-driven cycle for the same account.
  if (!tryAcquireLock(cfg.accountId)) {
    const holder = getLockHolder(cfg.accountId);
    return {
      cycleId: -1,
      status: "lock-busy",
      reason: `another runner holds the lock (${holder ?? "unknown"})`,
      approvalsRequested: 0,
      approvalsGranted: 0,
      approvalsDenied: 0,
      gardeningDeltas: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      gpuMinutesUsed: 0,
      nextWakeAt: Date.now() + MIN_INTERVAL_MS,
    };
  }

  // Heartbeat the lock at half the TTL so a long-running cycle keeps owning
  // its singleton slot. If we ever lose the lock mid-cycle (clock skew /
  // forced takeover) we surface that as a preemption rather than continuing
  // to write under a stale claim.
  let lostLock = false;
  const heartbeat = setInterval(() => {
    if (!heartbeatLock(cfg.accountId)) {
      lostLock = true;
      clearInterval(heartbeat);
    }
  }, LOCK_HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const startMs = Date.now();
  const cycleId = startCycleRow(cfg.accountId);

  const baseSummary: Omit<CycleSummary, "cycleId"> = {
    status: "skipped",
    approvalsRequested: 0,
    approvalsGranted: 0,
    approvalsDenied: 0,
    gardeningDeltas: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    gpuMinutesUsed: 0,
    nextWakeAt: Date.now() + cfg.baseIntervalMs,
  };

  const finish = (s: Omit<CycleSummary, "cycleId">): CycleSummary => {
    finishCycleRow(cycleId, s);
    persistNextWake(cfg.accountId, s.nextWakeAt);
    return { cycleId, ...s };
  };

  try {
    if (cfg.killSwitch && !force) {
      recordTranscript(null, cycleId, "skip", "kill switch engaged", {});
      return finish({ ...baseSummary, reason: "kill switch engaged" });
    }
    if (!cfg.enabled && !force) {
      return finish({ ...baseSummary, reason: "ambient disabled" });
    }
    if (!cfg.featureFlag && !force) {
      return finish({ ...baseSummary, reason: "feature flag off" });
    }

    if (!force && (await isInteractiveSessionActive(cfg))) {
      recordTranscript(null, cycleId, "skip", "preempted by interactive session", {});
      return finish({ ...baseSummary, status: "preempted", reason: "interactive session active", nextWakeAt: Date.now() + PREEMPT_INTERVAL_MS });
    }

    const budget = isBudgetExhausted(cfg);
    if (budget.exhausted && !force) {
      recordTranscript(null, cycleId, "skip", budget.reason, {});
      return finish({ ...baseSummary, status: "skipped", reason: budget.reason, nextWakeAt: Date.now() + cfg.rollingWindowMs / 4 });
    }

    // Capture workspace activity once at cycle start; used by scout, work,
    // and the adaptive interval calculation at finalization.
    const signals = await collectWorkspaceSignals();
    const ctx: CycleContext = { cycleId, cfg, startMs, force, gpuMinutesUsed: 0, signals };

    try {
      const scoutSummary = await scout(ctx);
      if (lostLock) throw new PreemptionAbort("lock takeover");
      await checkpoint(ctx, "post-scout");
      const g = await garden(ctx);
      if (lostLock) throw new PreemptionAbort("lock takeover");
      await checkpoint(ctx, "post-garden");
      const w = await work(ctx);

      const wallClockMs = Date.now() - startMs;
      const tokensUsed = Math.ceil(wallClockMs / 100);
      accountErrorCounts.set(cfg.accountId, 0);
      // Adaptive cadence: pick the next wake based on operator follow-through
      // (open approvals queue depth) and current workspace pressure.
      const pendingCount = listPendingApprovals({ accountId: cfg.accountId, limit: 50 }).length;
      const adaptiveMs = computeAdaptiveIntervalMs(cfg, signals, pendingCount, 0);
      return finish({
        status: "completed",
        reason: "ok",
        scoutSummary,
        gardenSummary: g.summary,
        workSummary: w.summary,
        tokensUsed,
        wallClockMs,
        gpuMinutesUsed: ctx.gpuMinutesUsed,
        approvalsRequested: g.approvals.requested + w.approvals.requested,
        approvalsGranted: g.approvals.granted + w.approvals.granted,
        approvalsDenied: g.approvals.denied + w.approvals.denied,
        gardeningDeltas: g.deltas,
        nextWakeAt: Date.now() + adaptiveMs,
      });
    } catch (err) {
      if (err instanceof PreemptionAbort) {
        recordTranscript(null, cycleId, "preempt", err.reason, {});
        return finish({
          ...baseSummary,
          status: "preempted",
          reason: err.reason,
          wallClockMs: Date.now() - startMs,
          gpuMinutesUsed: ctx.gpuMinutesUsed,
          nextWakeAt: Date.now() + PREEMPT_INTERVAL_MS,
        });
      }
      const errCount = (accountErrorCounts.get(cfg.accountId) ?? 0) + 1;
      accountErrorCounts.set(cfg.accountId, errCount);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, cycleId, accountId: cfg.accountId }, "[ambient] cycle failed");
      // Adaptive failure backoff: combine the consecutive-error multiplier
      // with workspace-pressure factors so a flaky cycle in a busy
      // workspace backs off harder than one in a quiet one.
      const pendingCount = listPendingApprovals({ accountId: cfg.accountId, limit: 50 }).length;
      const adaptiveMs = computeAdaptiveIntervalMs(cfg, signals, pendingCount, errCount);
      const exponentialMs = cfg.baseIntervalMs * 2 ** Math.min(errCount, 5);
      const backoff = Math.min(MAX_INTERVAL_MS, Math.max(adaptiveMs, exponentialMs));
      recordTranscript(null, cycleId, "error", msg, {});
      return finish({
        ...baseSummary,
        status: "failed",
        reason: msg,
        wallClockMs: Date.now() - startMs,
        gpuMinutesUsed: ctx.gpuMinutesUsed,
        nextWakeAt: Date.now() + backoff,
      });
    }
  } finally {
    clearInterval(heartbeat);
    releaseLock(cfg.accountId);
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/**
 * Polls the durable wake schedule every TICK_INTERVAL_MS. For each enabled
 * account whose persisted next_wake_at has elapsed, attempt to acquire the
 * per-account lock and run a cycle. Multiple processes can coexist safely:
 * the first process that acquires an account's lock executes the cycle;
 * the others observe the lock and back off.
 */
async function runnerTick(): Promise<void> {
  let configs: AmbientConfig[];
  try {
    configs = listAllConfigs();
  } catch (err) {
    logger.error({ err }, "[ambient] runner tick: listAllConfigs failed");
    return;
  }
  const now = Date.now();
  for (const cfg of configs) {
    if (inProgressAccounts.has(cfg.accountId)) continue;
    if (cfg.killSwitch || !cfg.enabled || !cfg.featureFlag) continue;
    const dueAt = cfg.nextWakeAt ? cfg.nextWakeAt * 1000 : 0;
    if (dueAt > now) continue;

    inProgressAccounts.add(cfg.accountId);
    // Fire-and-forget per account so a slow cycle on one account doesn't
    // delay every other account's wake. The lock + heartbeat + release are
    // all owned by runAmbientCycleNow itself, so cross-process safety holds
    // even if a forced manual cycle is firing simultaneously.
    void (async () => {
      try {
        await runAmbientCycleNow({ accountId: cfg.accountId });
      } catch (err) {
        logger.error({ err, accountId: cfg.accountId }, "[ambient] runAmbientCycleNow threw");
      } finally {
        inProgressAccounts.delete(cfg.accountId);
      }
    })();
  }
}

/**
 * Register executors for the action kinds ambient itself produces. After an
 * operator approves a queued action via the dashboard, the safety subsystem
 * calls back into these executors to actually carry out the work — this is
 * what closes the loop on the “requires-permission” pipeline so approved
 * actions don't dead-end as `approved` rows.
 */
export function registerAmbientExecutors(): void {
  registerActionExecutor("memory_garden_dismiss", async (action: SafetyAction) => {
    const itemIds = (action.details?.["itemIds"] as number[] | undefined) ?? [];
    if (itemIds.length === 0) {
      recordTranscript(action.id, action.cycleId, "execute", "no item ids on approved action — nothing to dismiss", {});
      return;
    }
    // Resolve the per-account operator user-id at execution time (the
    // approval may have been pending across config edits). Falling back to
    // any user-id the requester recorded in details keeps approvals from
    // earlier configs working.
    const cfg = getConfig(action.accountId);
    const userId = (action.details?.["userId"] as string | undefined) ?? cfg.operatorUserId;
    const updated = bulkUpdateStaleItems(userId, itemIds, "dismiss");
    recordTranscript(action.id, action.cycleId, "execute", `executor dismissed ${updated} stale items`, { updated, userId });
  });

  registerActionExecutor("memory_conflict_resolve", async (action: SafetyAction) => {
    const rawIds = (action.details?.["conflictGroupIds"] as unknown[] | undefined) ?? [];
    const groupIds = rawIds
      .map(g => (typeof g === "number" ? g : Number(g)))
      .filter(g => Number.isFinite(g));
    if (groupIds.length === 0) {
      recordTranscript(action.id, action.cycleId, "execute", "no conflict group ids on approved action — nothing to resolve", {});
      return;
    }
    const cfg = getConfig(action.accountId);
    const userId = (action.details?.["userId"] as string | undefined) ?? cfg.operatorUserId;
    let resolved = 0;
    for (const gid of groupIds) {
      try {
        if (updateConflictStatus({ userId, conflictGroupId: gid, conflictStatus: "resolved" })) {
          resolved++;
        }
      } catch (err) {
        recordTranscript(action.id, action.cycleId, "execute", `executor failed to resolve group ${gid}: ${err instanceof Error ? err.message : String(err)}`, { conflictGroupId: gid });
      }
    }
    recordTranscript(action.id, action.cycleId, "execute", `executor resolved ${resolved} conflict group(s)`, { resolved, userId });
  });

  registerActionExecutor("lane_handoff_remind", async (action: SafetyAction) => {
    // The reminder is "delivered" via the dashboard pending list + the
    // notification channels the operator configured (dashboard polling,
    // log, optional email/webhook). The executor closes the loop with an
    // audit entry so the action shows as actually executed.
    const count = (action.details?.["count"] as number | undefined) ?? 0;
    logger.info(
      { actionId: action.id, summary: action.summary, count },
      "[ambient] executor: lane-handoff reminder approved",
    );
    recordTranscript(action.id, action.cycleId, "execute", `lane-handoff reminder surfaced for ${count} handoff(s)`, { count });
  });

  registerActionExecutor("notify_memory_review", async (action: SafetyAction) => {
    // Notification dispatch is already handled by the dashboard channel + the
    // approval pipeline; the executor records that the operator-approved
    // notification has been "delivered" so audits show closure.
    logger.info({ actionId: action.id, summary: action.summary }, "[ambient] executor: memory-review notification approved");
    recordTranscript(action.id, action.cycleId, "execute", "operator-approved notification surfaced via dashboard", {});
  });
}

export function startAmbientRunner(): void {
  if (timer) return;

  // On boot, ensure every existing config has a persisted next_wake_at.
  // Accounts that were due before the restart fire on the very next tick;
  // accounts that weren't keep their previously persisted wake. This is
  // the restart-resilient piece — the schedule lives in SQLite, not RAM.
  try {
    const sdb = _internalGetDb();
    const cfgs = listAllConfigs();
    for (const cfg of cfgs) {
      if (cfg.nextWakeAt === null) {
        sdb.prepare(`UPDATE ambient_config SET next_wake_at = ? WHERE account_id = ?`)
          .run(Math.floor((Date.now() + 30 * 1000) / 1000), cfg.accountId);
      }
    }
  } catch (err) {
    logger.warn({ err }, "[ambient] failed to seed wake schedule");
  }

  timer = setInterval(() => { void runnerTick(); }, TICK_INTERVAL_MS);
  // Don't keep the event loop alive solely for ambient.
  if (typeof timer.unref === "function") timer.unref();
  logger.info({ holder: RUNNER_HOLDER, tickMs: TICK_INTERVAL_MS }, "[ambient] runner started");
}

export function stopAmbientRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
  // Best-effort: release every lock we currently hold.
  const sdb = _internalGetDb();
  sdb.prepare(`DELETE FROM ambient_lock WHERE holder = ?`).run(RUNNER_HOLDER);
}

// ─── Activity timeline ──────────────────────────────────────────────────────

export interface AmbientCycle {
  id: number;
  accountId: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
  reason: string | null;
  scoutSummary: string | null;
  gardenSummary: string | null;
  workSummary: string | null;
  tokensUsed: number;
  wallClockMs: number;
  gpuMinutesUsed: number;
  nextWakeAt: number | null;
  approvalsRequested: number;
  approvalsGranted: number;
  approvalsDenied: number;
  gardeningDeltas: number;
}

export function listCycles(params: { accountId?: string; limit?: number; offset?: number } = {}): AmbientCycle[] {
  const sdb = _internalGetDb();
  const rows = sdb.prepare(`
    SELECT * FROM ambient_cycles WHERE account_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?
  `).all(params.accountId ?? DEFAULT_ACCOUNT_ID, Math.min(params.limit ?? 50, 200), params.offset ?? 0) as Record<string, unknown>[];
  return rows.map(r => ({
    id: r["id"] as number,
    accountId: r["account_id"] as string,
    startedAt: r["started_at"] as number,
    endedAt: (r["ended_at"] as number | null) ?? null,
    status: r["status"] as string,
    reason: (r["reason"] as string | null) ?? null,
    scoutSummary: (r["scout_summary"] as string | null) ?? null,
    gardenSummary: (r["garden_summary"] as string | null) ?? null,
    workSummary: (r["work_summary"] as string | null) ?? null,
    tokensUsed: (r["tokens_used"] as number | null) ?? 0,
    wallClockMs: (r["wall_clock_ms"] as number | null) ?? 0,
    gpuMinutesUsed: (r["gpu_minutes_used"] as number | null) ?? 0,
    nextWakeAt: (r["next_wake_at"] as number | null) ?? null,
    approvalsRequested: (r["approvals_requested"] as number | null) ?? 0,
    approvalsGranted: (r["approvals_granted"] as number | null) ?? 0,
    approvalsDenied: (r["approvals_denied"] as number | null) ?? 0,
    gardeningDeltas: (r["gardening_deltas"] as number | null) ?? 0,
  }));
}

export function getStatus(accountId = DEFAULT_ACCOUNT_ID): {
  config: AmbientConfig;
  lastCycle: AmbientCycle | null;
  budget: BudgetUsage & { tokenBudget: number; wallClockBudgetMs: number; gpuMinuteBudget: number };
  lockHolder: string | null;
  runnerHolder: string;
} {
  const cfg = getConfig(accountId);
  const lastCycles = listCycles({ accountId, limit: 1 });
  const usage = getBudgetUsage(accountId, cfg.rollingWindowMs);
  return {
    config: cfg,
    lastCycle: lastCycles[0] ?? null,
    budget: { ...usage, tokenBudget: cfg.tokenBudget, wallClockBudgetMs: cfg.wallClockBudgetMs, gpuMinuteBudget: cfg.gpuMinuteBudget },
    lockHolder: getLockHolder(accountId),
    runnerHolder: RUNNER_HOLDER,
  };
}

export function getMetrics(accountId = DEFAULT_ACCOUNT_ID, windowMs = 24 * 60 * 60 * 1000): {
  cyclesRun: number;
  approvalsRequested: number;
  approvalsGranted: number;
  approvalsDenied: number;
  gardeningDeltas: number;
  proactiveWorkProposed: number;
} {
  const sdb = _internalGetDb();
  const cutoff = Math.floor((Date.now() - windowMs) / 1000);
  const row = sdb.prepare(`
    SELECT COUNT(*) AS cycles,
           COALESCE(SUM(approvals_requested), 0) AS req,
           COALESCE(SUM(approvals_granted), 0) AS gr,
           COALESCE(SUM(approvals_denied), 0) AS dn,
           COALESCE(SUM(gardening_deltas), 0) AS delta,
           COALESCE(SUM(CASE WHEN work_summary IS NOT NULL AND work_summary != 'no proactive work proposed' THEN 1 ELSE 0 END), 0) AS work
    FROM ambient_cycles
    WHERE account_id = ? AND started_at >= ?
  `).get(accountId, cutoff) as { cycles: number; req: number; gr: number; dn: number; delta: number; work: number };
  return {
    cyclesRun: row?.cycles ?? 0,
    approvalsRequested: row?.req ?? 0,
    approvalsGranted: row?.gr ?? 0,
    approvalsDenied: row?.dn ?? 0,
    gardeningDeltas: row?.delta ?? 0,
    proactiveWorkProposed: row?.work ?? 0,
  };
}
