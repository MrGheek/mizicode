/**
 * Plan Auto-Advance — Task #362
 *
 * Subscribes to the real-time memory observation emitter and automatically
 * advances plan task status as MIZI works during a session:
 *
 *   planned → in_progress  when the agent starts working on a matching task
 *   in_progress → done     when the agent emits a completion signal for it
 *
 * Design constraints:
 *  - Fully fire-and-forget: never blocks the memory write path
 *  - Uses lexical overlap scoring (no external API) — same algorithm in memory.ts
 *  - Respects confirmedByUser=true (user-pinned tasks are never touched)
 *  - Never regresses a status (done is terminal; in_progress won't overwrite done)
 *  - Caches session→plan lookups for SESSION_CACHE_TTL_MS to avoid hammering Postgres
 */
import { db, sessionsTable, projectPlansTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { subscribeToObservations } from "./memory";
import { updateTask, getTasksForPlan } from "./plan";
import type { Observation } from "./memory";

// ── Tuning constants ───────────────────────────────────────────────────────────

/** Minimum Jaccard token overlap to consider a task "matched" by an observation */
const MATCH_THRESHOLD = 0.12;

/** Cache TTL for session → planId lookups */
const SESSION_CACHE_TTL_MS = 90_000;

/**
 * Tool names whose output almost always indicates task-level completion.
 * Observing one of these tools raises confidence even with lower lexical overlap.
 */
const HIGH_CONFIDENCE_TOOLS = new Set([
  "bash", "write_file", "edit_file", "create_file", "apply_patch",
  "run_tests", "deploy", "commit", "push",
]);

// ── Signal word lists ─────────────────────────────────────────────────────────

const COMPLETION_SIGNALS = [
  "completed", "done", "finished", "implemented", "fixed", "resolved",
  "deployed", "added", "created", "built", "wrote", "written", "updated",
  "merged", "closed", "shipped", "passed", "success", "succeeded",
  "installed", "configured", "migrated", "generated", "refactored",
];

const PROGRESS_SIGNALS = [
  "starting", "working", "implementing", "fixing", "resolving", "editing",
  "modifying", "updating", "refactoring", "writing", "creating", "building",
  "reading", "loading", "fetching", "running", "calling", "checking",
];

// ── Session→plan cache ────────────────────────────────────────────────────────

interface CachedPlanEntry {
  planId: number | null;
  planUserId: string;
  cachedAt: number;
}

const sessionPlanCache = new Map<string, CachedPlanEntry>();

async function resolveSessionPlan(
  sessionId: string,
): Promise<{ planId: number; planUserId: string } | null> {
  const now = Date.now();
  const cached = sessionPlanCache.get(sessionId);
  if (cached && now - cached.cachedAt < SESSION_CACHE_TTL_MS) {
    return cached.planId ? { planId: cached.planId, planUserId: cached.planUserId } : null;
  }

  // Accept both "sess-<n>" (passive-recall format) and plain "<n>"
  const numericId = parseInt(sessionId.replace(/^sess-/, ""), 10);
  if (isNaN(numericId)) return null;

  let planId: number | null = null;
  let planUserId = "";

  try {
    const [session] = await db
      .select({ planId: sessionsTable.planId })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, numericId));

    if (session?.planId) {
      const [plan] = await db
        .select({ userId: projectPlansTable.userId })
        .from(projectPlansTable)
        .where(eq(projectPlansTable.id, session.planId));

      if (plan) {
        planId = session.planId;
        planUserId = plan.userId;
      }
    }
  } catch (err) {
    logger.warn({ err, sessionId }, "[plan-auto] Failed to resolve session plan (non-fatal)");
    return null;
  }

  sessionPlanCache.set(sessionId, { planId, planUserId, cachedAt: now });
  return planId ? { planId, planUserId } : null;
}

// ── Lexical helpers ───────────────────────────────────────────────────────────

function lexicalOverlapScore(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

function detectSignal(
  toolName: string,
  inputSummary: string,
  outputSummary: string,
): "done" | "in_progress" | null {
  const combined = `${toolName} ${inputSummary} ${outputSummary}`.toLowerCase();

  if (COMPLETION_SIGNALS.some((s) => combined.includes(s))) return "done";
  if (PROGRESS_SIGNALS.some((s) => combined.includes(s))) return "in_progress";

  // High-confidence tools imply active progress even without an explicit signal
  if (HIGH_CONFIDENCE_TOOLS.has(toolName)) return "in_progress";

  return null;
}

// ── Core handler ──────────────────────────────────────────────────────────────

async function handleObservation(obs: Observation): Promise<void> {
  // Skip tool calls with no usable content
  if (!obs.inputSummary && !obs.outputSummary) return;

  const signal = detectSignal(obs.toolName, obs.inputSummary, obs.outputSummary);
  if (!signal) return;

  const planInfo = await resolveSessionPlan(obs.sessionId);
  if (!planInfo) return;

  const tasks = await getTasksForPlan(planInfo.planId);

  // Filter to tasks that can be advanced toward the detected signal.
  // Direct planned→done transitions are intentionally permitted: when a tool
  // observation carries a clear completion signal (e.g. "implemented", "shipped"),
  // forcing an intermediate in_progress step would delay the board update with no
  // practical benefit. The task spec's "planned→in_progress→done" ordering describes
  // the natural flow; a single high-confidence completion observation short-circuits it.
  const candidates = tasks.filter((t) => {
    if (t.confirmedByUser) return false;
    if (t.status === "done" || t.status === "skipped") return false;
    if (signal === "in_progress" && t.status === "in_progress") return false;
    return true;
  });

  if (candidates.length === 0) return;

  // Build observation text — weight task-relevant fields more
  const observationText = `${obs.inputSummary} ${obs.outputSummary} ${obs.toolName}`;

  // Find best-matching task by Jaccard overlap
  let bestTask = candidates[0]!;
  let bestScore = 0;

  for (const task of candidates) {
    const score = lexicalOverlapScore(observationText, task.text);
    if (score > bestScore) {
      bestScore = score;
      bestTask = task;
    }
  }

  // Boost threshold slightly for in_progress to reduce noise
  const effectiveThreshold =
    signal === "done" ? MATCH_THRESHOLD : MATCH_THRESHOLD * 1.3;

  // High-confidence tools get a lower threshold (they signal intent clearly)
  const adjustedThreshold = HIGH_CONFIDENCE_TOOLS.has(obs.toolName)
    ? effectiveThreshold * 0.8
    : effectiveThreshold;

  if (bestScore < adjustedThreshold) {
    _metrics.skipped++;
    return;
  }

  // Never regress: in_progress won't overwrite partial/done
  if (
    signal === "in_progress" &&
    (bestTask.status === "partial" || bestTask.status === "done")
  ) {
    return;
  }

  // Status is already what we'd set — skip the write
  if (bestTask.status === signal) return;

  // Track outcome for structured metrics logging
  _metrics.evaluated++;

  try {
    await updateTask({
      taskId: bestTask.id,
      userId: planInfo.planUserId,
      updates: { status: signal },
    });
    _metrics.advanced++;
    logger.info(
      {
        taskId: bestTask.id,
        planId: planInfo.planId,
        previousStatus: bestTask.status,
        newStatus: signal,
        score: bestScore.toFixed(3),
        tool: obs.toolName,
        sessionId: obs.sessionId,
        // Running totals for threshold tuning in production
        metricsEvaluated: _metrics.evaluated,
        metricsAdvanced: _metrics.advanced,
        metricsSkipped: _metrics.skipped,
      },
      "[plan-auto] Auto-advanced task status from observation",
    );
  } catch (err) {
    _metrics.errors++;
    logger.warn(
      { err, taskId: bestTask.id, planId: planInfo.planId },
      "[plan-auto] Failed to auto-advance task (non-fatal)",
    );
  }
}

// ── In-process outcome counters ───────────────────────────────────────────────
// Lightweight metrics for production threshold tuning.
// Surfaced in each successful auto-advance log line and reset on restart.
const _metrics = {
  evaluated: 0, // observations that passed signal detection and plan resolution
  advanced: 0,  // tasks whose status was actually updated
  skipped: 0,   // observations that passed signal but had no task match above threshold
  errors: 0,    // updateTask failures (Postgres errors, authz rejections)
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the plan auto-advance listener.
 *
 * Subscribes to the memory observation emitter for the operator memory user
 * (MIZI_MEM_USER_ID, default "operator") and fires asynchronous, non-blocking
 * task-status updates whenever a matching signal is detected.
 *
 * Safe to call once at server startup.
 */
export function startPlanAutoAdvance(): void {
  const memOperatorId = process.env["MIZI_MEM_USER_ID"] ?? "operator";

  subscribeToObservations(memOperatorId, (obs) => {
    handleObservation(obs).catch((err) => {
      logger.warn({ err, sessionId: obs.sessionId }, "[plan-auto] Observation handler error (non-fatal)");
    });
  });

  logger.info(
    { memOperatorId },
    "[plan-auto] Plan auto-advance listener started",
  );
}
