/**
 * Plan routes — Living Project Plan with Task Board (Task #360)
 *
 * POST   /api/plan/generate              — generate or extend a plan from intent
 * POST   /api/plan/reassess              — post-session task reassessment
 * GET    /api/plans                      — list plans for a user (+ optional repoUrl filter)
 * GET    /api/plans/:planId              — get plan + tasks
 * GET    /api/plans/:planId/export       — export plan as markdown
 * POST   /api/plans/:planId/tasks        — add a task manually
 * PATCH  /api/plans/:planId/tasks/:taskId — update a task (status, text, reorder)
 * DELETE /api/plans/:planId/tasks/:taskId — delete a task
 * PATCH  /api/sessions/:sessionId/plan   — link a plan to a session
 */
import { Router } from "express";
import { db, sessionsTable } from "@workspace/db";
import type { PlanTaskStatus, PlanTaskPriority } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { optionalAgentAuth, requireAgentAuth } from "../middlewares/agent-auth";
import {
  generatePlan,
  approvePlan,
  getPlansForUser,
  getPlanById,
  getTasksForPlan,
  updateTask,
  addTaskToPlan,
  deleteTask,
  reassessSession,
  exportPlanAsMarkdown,
} from "../services/plan";

const router = Router();

// optionalAgentAuth: pass-through when no Authorization header (dashboard UI),
// but validates fully when a token is present (API clients/agents). This prevents
// callers from sending an invalid token to appear semi-authenticated.
// All handlers enforce ownership via userId checks regardless.
router.use(optionalAgentAuth([]));

// ── POST /api/plan/generate ───────────────────────────────────────────────────

router.post("/plan/generate", async (req, res) => {
  try {
    const {
      intentText,
      repoUrl,
      userId,
      existingPlanId,
    } = req.body as {
      intentText?: string;
      repoUrl?: string | null;
      userId?: string;
      existingPlanId?: number | null;
    };

    if (!intentText?.trim()) {
      res.status(400).json({ error: "intentText is required" });
      return;
    }
    if (!userId?.trim()) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const result = await generatePlan({
      intentText: intentText.trim(),
      repoUrl: repoUrl ?? null,
      userId: userId.trim(),
      existingPlanId: existingPlanId ?? null,
    });

    res.status(201).json(result);
  } catch (err: unknown) {
    const sc = err instanceof Error ? (err as { statusCode?: number }).statusCode : undefined;
    if (sc === 403) { res.status(403).json({ error: "Access denied" }); return; }
    if (sc === 404) { res.status(404).json({ error: "Plan not found" }); return; }
    logger.error({ err }, "[plan] /plan/generate failed");
    res.status(500).json({ error: "Plan generation failed" });
  }
});

// ── POST /api/plan/reassess ───────────────────────────────────────────────────
// Agent-only: triggered server-side after session stops. Not called by the dashboard.

router.post("/plan/reassess", requireAgentAuth([]), async (req, res) => {
  try {
    const { sessionId, userId } = req.body as { sessionId?: number; userId?: string };
    if (!sessionId || !userId?.trim()) {
      res.status(400).json({ error: "sessionId and userId are required" });
      return;
    }

    const result = await reassessSession({ sessionId, userId: userId.trim() });
    if (!result) {
      res.status(404).json({ error: "No linked plan found for this session" });
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error({ err }, "[plan] /plan/reassess failed");
    res.status(500).json({ error: "Reassessment failed" });
  }
});

// ── GET /api/plans ────────────────────────────────────────────────────────────

router.get("/plans", async (req, res) => {
  try {
    const userId = req.query["userId"] as string | undefined;
    if (!userId) {
      res.status(400).json({ error: "userId query param required" });
      return;
    }
    const repoUrl = req.query["repoUrl"] as string | undefined;
    const plans = await getPlansForUser(userId, repoUrl ?? null);

    // Attach task counts
    const withCounts = await Promise.all(plans.map(async (plan) => {
      const tasks = await getTasksForPlan(plan.id);
      return {
        ...plan,
        taskCount: tasks.length,
        doneCount: tasks.filter(t => t.status === "done").length,
      };
    }));

    res.json(withCounts);
  } catch (err) {
    logger.error({ err }, "[plan] GET /plans failed");
    res.status(500).json({ error: "Failed to list plans" });
  }
});

// ── GET /api/plans/:planId ────────────────────────────────────────────────────

router.get("/plans/:planId", async (req, res) => {
  try {
    const planId = parseInt(req.params["planId"]!, 10);
    if (isNaN(planId)) { res.status(400).json({ error: "Invalid planId" }); return; }

    const plan = await getPlanById(planId);
    if (!plan) { res.status(404).json({ error: "Plan not found" }); return; }

    // Ownership check — always required, not optional.
    const requestedUserId = req.query["userId"] as string | undefined;
    if (!requestedUserId?.trim()) {
      res.status(400).json({ error: "userId query param required" });
      return;
    }
    if (plan.userId !== requestedUserId.trim()) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const tasks = await getTasksForPlan(planId);
    res.json({ plan, tasks });
  } catch (err) {
    logger.error({ err }, "[plan] GET /plans/:planId failed");
    res.status(500).json({ error: "Failed to get plan" });
  }
});

// ── POST /api/plan/:planId/approve ────────────────────────────────────────────
// Applies user-reviewed steps as a delta to the authoritative task list.
// Preserves status/history for continuing tasks; only inserts/deletes the diff.

router.post("/plan/:planId/approve", async (req, res) => {
  try {
    const planId = parseInt(req.params["planId"]!, 10);
    if (isNaN(planId)) { res.status(400).json({ error: "Invalid planId" }); return; }

    const { userId, steps, explicitRemovals } = req.body as {
      userId?: string;
      steps?: Array<{ text: string; priority?: string; stepIndex: number; existingTaskId?: unknown }>;
      explicitRemovals?: unknown;
    };
    if (!userId?.trim()) { res.status(400).json({ error: "userId is required" }); return; }
    if (!Array.isArray(steps) || steps.length === 0) {
      res.status(400).json({ error: "steps array is required" });
      return;
    }

    // Validate and sanitise explicitRemovals — must be an array of positive integers.
    const sanitisedRemovals: number[] = Array.isArray(explicitRemovals)
      ? explicitRemovals
          .map((v: unknown) => (typeof v === "number" ? v : Number(v)))
          .filter((n: number) => Number.isFinite(n) && n > 0)
      : [];

    const VALID_PRIORITIES = ["high", "normal", "low"] as const;
    const normalizedSteps = steps.map((s, i) => {
      // Validate existingTaskId — must be a positive integer when provided.
      const rawId = s.existingTaskId;
      const existingTaskId =
        rawId != null && Number.isFinite(Number(rawId)) && Number(rawId) > 0
          ? Number(rawId)
          : undefined;
      return {
        text: s.text.trim(),
        priority: (VALID_PRIORITIES.includes(s.priority as (typeof VALID_PRIORITIES)[number])
          ? s.priority : "normal") as "high" | "normal" | "low",
        stepIndex: i,
        existingTaskId,
      };
    });

    const tasks = await approvePlan({ planId, userId: userId.trim(), steps: normalizedSteps, explicitRemovals: sanitisedRemovals });

    // Re-fetch the plan so the response includes the bumped version number.
    const plan = await getPlanById(planId);

    logger.info({ planId, userId, stepCount: tasks.length }, "[plan] Plan approved by user");
    res.json({ ok: true, plan, tasks });
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 403) { res.status(403).json({ error: "Access denied" }); return; }
    if (statusCode === 404) { res.status(404).json({ error: "Plan not found" }); return; }
    logger.error({ err }, "[plan] POST /plan/:planId/approve failed");
    res.status(500).json({ error: "Approval failed" });
  }
});

// ── GET /api/plans/:planId/export  (also aliased as /api/plan/:planId/export) ──

router.get(["/plans/:planId/export", "/plan/:planId/export"], async (req, res) => {
  try {
    const planId = parseInt((req.params as Record<string, string>)["planId"]!, 10);
    if (isNaN(planId)) { res.status(400).json({ error: "Invalid planId" }); return; }

    const plan = await getPlanById(planId);
    if (!plan) { res.status(404).json({ error: "Plan not found" }); return; }

    // Ownership check — always required.
    const requestedUserId = req.query["userId"] as string | undefined;
    if (!requestedUserId?.trim()) {
      res.status(400).json({ error: "userId query param required" });
      return;
    }
    if (plan.userId !== requestedUserId.trim()) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const tasks = await getTasksForPlan(planId);
    const markdown = exportPlanAsMarkdown(plan, tasks);

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="plan-${planId}.md"`);
    res.send(markdown);
  } catch (err) {
    logger.error({ err }, "[plan] GET /plans/:planId/export failed");
    res.status(500).json({ error: "Export failed" });
  }
});

// ── POST /api/plans/:planId/tasks ─────────────────────────────────────────────

router.post("/plans/:planId/tasks", async (req, res) => {
  try {
    const planId = parseInt(req.params["planId"]!, 10);
    if (isNaN(planId)) { res.status(400).json({ error: "Invalid planId" }); return; }

    const { text, priority, userId } = req.body as {
      text?: string;
      priority?: PlanTaskPriority;
      userId?: string;
    };
    if (!text?.trim() || !userId?.trim()) {
      res.status(400).json({ error: "text and userId are required" });
      return;
    }

    // Ownership check
    const plan = await getPlanById(planId);
    if (!plan) { res.status(404).json({ error: "Plan not found" }); return; }
    if (plan.userId !== userId.trim()) { res.status(403).json({ error: "Access denied" }); return; }

    const task = await addTaskToPlan({
      planId,
      text: text.trim(),
      priority: priority ?? "normal",
      userId: userId.trim(),
    });
    res.status(201).json(task);
  } catch (err) {
    logger.error({ err }, "[plan] POST /plans/:planId/tasks failed");
    res.status(500).json({ error: "Failed to add task" });
  }
});

// ── PATCH /api/plans/:planId/tasks/:taskId ────────────────────────────────────

router.patch("/plans/:planId/tasks/:taskId", async (req, res) => {
  try {
    const planId = parseInt(req.params["planId"]!, 10);
    const taskId = parseInt(req.params["taskId"]!, 10);
    if (isNaN(taskId)) { res.status(400).json({ error: "Invalid taskId" }); return; }

    const { userId, text, status, priority, confirmedByUser, stepIndex, blockedBy } = req.body as {
      userId?: string;
      text?: string;
      status?: PlanTaskStatus;
      priority?: PlanTaskPriority;
      confirmedByUser?: boolean;
      stepIndex?: number;
      blockedBy?: number[] | null;
    };
    if (!userId?.trim()) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    // Ownership check — verify the task belongs to a plan owned by the caller
    if (!isNaN(planId)) {
      const ownerPlan = await getPlanById(planId);
      if (ownerPlan && ownerPlan.userId !== userId.trim()) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
    }

    const VALID_STATUSES: PlanTaskStatus[] = ["planned", "in_progress", "done", "partial", "skipped"];
    if (status && !VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
      return;
    }

    const updated = await updateTask({
      taskId,
      userId: userId.trim(),
      updates: { text, status, priority, confirmedByUser, stepIndex, blockedBy },
    });
    if (!updated) { res.status(404).json({ error: "Task not found" }); return; }
    res.json(updated);
  } catch (err: unknown) {
    if (err instanceof Error && (err as { statusCode?: number }).statusCode === 403) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    logger.error({ err }, "[plan] PATCH /plans/:planId/tasks/:taskId failed");
    res.status(500).json({ error: "Failed to update task" });
  }
});

// ── DELETE /api/plans/:planId/tasks/:taskId ───────────────────────────────────

router.delete("/plans/:planId/tasks/:taskId", async (req, res) => {
  try {
    const planId = parseInt(req.params["planId"]!, 10);
    const taskId = parseInt(req.params["taskId"]!, 10);
    if (isNaN(taskId)) { res.status(400).json({ error: "Invalid taskId" }); return; }

    // Ownership check — always required.
    const userId = req.query["userId"] as string | undefined;
    if (!userId?.trim()) {
      res.status(400).json({ error: "userId query param required" });
      return;
    }
    // deleteTask enforces ownership via service-layer join — no extra route check needed.
    await deleteTask(taskId, userId.trim());
    res.json({ ok: true });
  } catch (err: unknown) {
    if (err instanceof Error && (err as { statusCode?: number }).statusCode === 403) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    logger.error({ err }, "[plan] DELETE /plans/:planId/tasks/:taskId failed");
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// ── GET /api/sessions/:sessionId/plan ────────────────────────────────────────
// Public (dashboard-safe): returns the plan + tasks linked to a session.
// Returns { plan: null, tasks: [] } when no plan is linked.

router.get("/sessions/:sessionId/plan", async (req, res) => {
  try {
    const sessionId = parseInt(req.params["sessionId"] as string, 10);
    if (isNaN(sessionId)) { res.status(400).json({ error: "Invalid sessionId" }); return; }

    const [session] = await db
      .select({ planId: sessionsTable.planId })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) { res.status(404).json({ error: "Session not found" }); return; }

    if (!session.planId) {
      res.json({ plan: null, tasks: [] });
      return;
    }

    const plan = await getPlanById(session.planId);
    if (!plan) {
      res.json({ plan: null, tasks: [] });
      return;
    }

    const tasks = await getTasksForPlan(session.planId);
    res.json({ plan, tasks });
  } catch (err) {
    logger.error({ err }, "[plan] GET /sessions/:sessionId/plan failed");
    res.status(500).json({ error: "Failed to get session plan" });
  }
});

// ── PATCH /api/sessions/:sessionId/plan ──────────────────────────────────────
// Agent-only: requires a valid API key. The dashboard does not call this endpoint —
// planId is passed at session creation time. This is used by server-side workflows
// (e.g. post-reassessment) to re-link or unlink sessions.

router.patch("/sessions/:sessionId/plan", requireAgentAuth([]), async (req, res) => {
  try {
    const sessionId = parseInt(req.params["sessionId"] as string, 10);
    if (isNaN(sessionId)) { res.status(400).json({ error: "Invalid sessionId" }); return; }

    const { planId, userId } = req.body as { planId?: number | null; userId?: string };
    if (!userId?.trim()) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    // If linking a plan, verify ownership so callers can't link other users' plans.
    if (planId != null) {
      const plan = await getPlanById(planId);
      if (!plan) { res.status(404).json({ error: "Plan not found" }); return; }
      if (plan.userId !== userId.trim()) { res.status(403).json({ error: "Access denied" }); return; }
    }

    // Verify the session exists and belongs to this user (profileId->userId not directly on session;
    // use planId cross-check — if a session already has a plan, only that plan's owner may re-link).
    const [session] = await db.select({ id: sessionsTable.id, existingPlanId: sessionsTable.planId })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }

    // If session already has a plan, verify the current caller owns that plan.
    if (session.existingPlanId) {
      const existingPlan = await getPlanById(session.existingPlanId);
      if (existingPlan && existingPlan.userId !== userId.trim()) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
    }

    const [updated] = await db.update(sessionsTable)
      .set({ planId: planId ?? null, updatedAt: new Date() } as Partial<typeof sessionsTable.$inferInsert> & { updatedAt: Date })
      .where(eq(sessionsTable.id, sessionId))
      .returning({ id: sessionsTable.id, planId: sessionsTable.planId });

    if (!updated) { res.status(404).json({ error: "Session not found" }); return; }
    res.json(updated);
  } catch (err) {
    logger.error({ err }, "[plan] PATCH /sessions/:sessionId/plan failed");
    res.status(500).json({ error: "Failed to link plan to session" });
  }
});

export default router;
