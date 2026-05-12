/**
 * Plan service — core logic for project plan generation, CRUD, reassessment,
 * memory integration, and export.
 */
import { db, projectPlansTable, projectTasksTable, sessionsTable } from "@workspace/db";
import type { ProjectPlan, ProjectTask, PlanTaskStatus, PlanTaskPriority } from "@workspace/db";
import { eq, and, asc, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { planEvents } from "./plan-events";
import { saveMemoryItem } from "./memory";
import { callLlm } from "./llm-client";

export type { ProjectPlan, ProjectTask };

interface PlanStep {
  stepIndex: number;
  text: string;
  priority: PlanTaskPriority;
  doneLooksLike?: string | null;
  outOfScope?: string | null;
  fileDependencies?: string | null;
}

interface GeneratedPlan {
  title: string;
  steps: PlanStep[];
}

async function callLlmForPlan(params: {
  intentText: string;
  repoUrl?: string | null;
  existingTasks?: Array<{ stepIndex: number; text: string; status: string; confirmedByUser: boolean }>;
}): Promise<GeneratedPlan | null> {
  const existingContext = params.existingTasks && params.existingTasks.length > 0
    ? `\n\nExisting task board state (MUST preserve user-confirmed tasks):\n${params.existingTasks.map(t =>
        `  [${t.stepIndex + 1}] ${t.text} — status: ${t.status}${t.confirmedByUser ? " (USER CONFIRMED — do not change)" : ""}`
      ).join("\n")}`
    : "";

  const raw = await callLlm({
    logTag: "plan.generate",
    temperature: 0.3,
    max_tokens: 2200,
    messages: [
      {
        role: "system",
        content: `You are MIZI, an AI project planner. Decompose a software development intent into 3–7 concrete, actionable steps.
Return ONLY valid JSON in this exact format:
{
  "title": "Short project title (max 60 chars)",
  "steps": [
    {
      "stepIndex": 0,
      "text": "Concrete step description",
      "priority": "high|normal|low",
      "doneLooksLike": "2-3 bullet lines (\\n-separated) describing observable outcomes when this step is done",
      "outOfScope": "1-2 bullet lines (\\n-separated) of what this step does NOT cover",
      "fileDependencies": "newline-separated list of relevant file paths or sibling task names this step depends on"
    },
    ...
  ]
}
Rules:
- 3 to 7 steps, ordered logically
- Each step must be a concrete implementation action, not vague
- Respect user-confirmed tasks from the existing board — preserve their meaning
- Priority: "high" for critical path, "normal" for standard, "low" for nice-to-have
- doneLooksLike: 2-3 short bullet lines describing the observable result (not code)
- outOfScope: 1-2 short bullet lines of explicit exclusions
- fileDependencies: newline-separated paths/names, or empty string if none
- No markdown, no extra text — pure JSON only`,
      },
      {
        role: "user",
        content: `Intent: ${params.intentText}${params.repoUrl ? `\nRepository: ${params.repoUrl}` : ""}${existingContext}`,
      },
    ],
  });
  if (!raw) return null;
  const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as GeneratedPlan;
    if (!parsed.title || !Array.isArray(parsed.steps)) return null;
    parsed.steps = parsed.steps.slice(0, 7);
    return parsed;
  } catch {
    return null;
  }
}

async function callLlmForReassessment(params: {
  tasks: Array<{ id: number; text: string; status: string; confirmedByUser: boolean }>;
  observations: Array<{ toolName: string; inputSummary: string; outputSummary: string }>;
}): Promise<Array<{ taskId: number; newStatus: PlanTaskStatus; reason: string }> | null> {
  const observationSummary = params.observations.slice(0, 40)
    .map(o => `[${o.toolName}] ${o.inputSummary} → ${o.outputSummary}`)
    .join("\n");

  const taskList = params.tasks.map(t =>
    `  taskId=${t.id}: "${t.text}" (current: ${t.status}${t.confirmedByUser ? ", USER CONFIRMED" : ""})`
  ).join("\n");

  const raw = await callLlm({
    logTag: "plan.reassess",
    temperature: 0,
    max_tokens: 800,
    messages: [
      {
        role: "system",
        content: `You are MIZI, an AI code session analyst. Based on what the AI did during a session, assess which tasks were completed.
Return ONLY valid JSON array:
[{ "taskId": <number>, "newStatus": "done|partial|in_progress|planned", "reason": "brief reason" }, ...]
Rules:
- Skip tasks where confirmedByUser=true — DO NOT change those
- "done" = clearly completed, "partial" = started but unfinished, "in_progress" = actively being worked, "planned" = untouched
- Only include entries where status should change from current
- Pure JSON array only, no markdown`,
      },
      {
        role: "user",
        content: `Tasks:\n${taskList}\n\nSession observations:\n${observationSummary}`,
      },
    ],
  });
  if (!raw) return null;
  const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0];
  if (!jsonStr) return null;
  const VALID_STATUSES: readonly string[] = ["done", "partial", "in_progress", "planned"];
  try {
    const parsed = JSON.parse(jsonStr) as unknown[];
    if (!Array.isArray(parsed)) return null;
    // Strictly validate each entry — drop any row with an unrecognized status or
    // non-integer taskId so malformed LLM output never reaches the DB.
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const e = entry as Record<string, unknown>;
      const taskId = typeof e["taskId"] === "number" ? Math.floor(e["taskId"]) : NaN;
      const newStatus = typeof e["newStatus"] === "string" ? e["newStatus"] : "";
      if (!Number.isFinite(taskId) || taskId <= 0) return [];
      if (!VALID_STATUSES.includes(newStatus)) return [];
      return [{ taskId, newStatus: newStatus as PlanTaskStatus, reason: typeof e["reason"] === "string" ? e["reason"] : "" }];
    });
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DraftStep {
  stepIndex: number;
  text: string;
  priority: PlanTaskPriority;
  isAdded: boolean;
  isChanged: boolean;
  isRemoved: boolean;
  existingTaskId?: number;
  doneLooksLike?: string | null;
  outOfScope?: string | null;
  fileDependencies?: string | null;
}

export interface RemovedStep {
  id: number;
  text: string;
  stepIndex: number;
}

export interface GeneratePlanResult {
  plan: ProjectPlan;
  // draftSteps are the LLM-proposed steps — NOT yet written to project_tasks.
  // The UI shows them for review/editing. Only POST /plan/:id/approve writes to DB.
  draftSteps: DraftStep[];
  // existingTasks is the current authoritative board state (unchanged by generate).
  existingTasks: ProjectTask[];
  diff: { removedSteps: RemovedStep[] };
  llmFailed: boolean;
}

export async function generatePlan(params: {
  intentText: string;
  repoUrl?: string | null;
  userId: string;
  existingPlanId?: number | null;
}): Promise<GeneratePlanResult> {
  // Ownership check FIRST — before reading any task data or calling the LLM,
  // so we never send another user's tasks to an external model endpoint.
  let existingTasks: ProjectTask[] = [];
  let existingPlanVersion = 1;

  if (params.existingPlanId) {
    const [ownerRow] = await db.select({ userId: projectPlansTable.userId, version: projectPlansTable.version })
      .from(projectPlansTable)
      .where(eq(projectPlansTable.id, params.existingPlanId));
    if (!ownerRow) {
      throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
    }
    if (ownerRow.userId !== params.userId) {
      throw Object.assign(new Error("Access denied"), { statusCode: 403 });
    }
    existingPlanVersion = ownerRow.version;

    // Now safe to load tasks for LLM context.
    existingTasks = await db
      .select()
      .from(projectTasksTable)
      .where(eq(projectTasksTable.planId, params.existingPlanId))
      .orderBy(asc(projectTasksTable.stepIndex));
  }

  const existingForLlm = existingTasks.map(t => ({
    stepIndex: t.stepIndex,
    text: t.text,
    status: t.status,
    confirmedByUser: t.confirmedByUser,
  }));

  const generated = await callLlmForPlan({
    intentText: params.intentText,
    repoUrl: params.repoUrl,
    existingTasks: existingForLlm.length > 0 ? existingForLlm : undefined,
  });

  const llmFailed = !generated;

  const planData = generated ?? {
    title: params.intentText.slice(0, 60),
    steps: [{ stepIndex: 0, text: params.intentText, priority: "normal" as PlanTaskPriority }],
  };

  let plan: ProjectPlan;

  if (params.existingPlanId) {
    // Update plan header only — no task mutations (tasks only change on approve).
    const [updated] = await db
      .update(projectPlansTable)
      .set({ title: planData.title, updatedAt: new Date() })
      .where(eq(projectPlansTable.id, params.existingPlanId))
      .returning();
    plan = updated!;
  } else {
    // Create new plan header — no task inserts yet.
    const [newPlan] = await db.insert(projectPlansTable).values({
      userId: params.userId,
      repoUrl: params.repoUrl ?? null,
      title: planData.title,
      version: 1,
    }).returning();
    plan = newPlan!;
  }

  // Compute diff for UI highlighting (against existing tasks, no DB writes).
  const existingTextMap = new Map(existingTasks.map(t => [t.text.toLowerCase().trim(), t]));
  const newTextSet = new Set(planData.steps.map(s => s.text.toLowerCase().trim()));

  const draftSteps: DraftStep[] = planData.steps.map((step, i) => {
    const existing = existingTextMap.get(step.text.toLowerCase().trim());
    return {
      stepIndex: i,
      text: step.text,
      priority: step.priority,
      isAdded: !existing,
      isChanged: !!existing && existing.priority !== step.priority,
      isRemoved: false,
      existingTaskId: existing?.id,
      doneLooksLike: step.doneLooksLike ?? null,
      outOfScope: step.outOfScope ?? null,
      fileDependencies: step.fileDependencies ?? null,
    };
  });

  // Identify tasks that exist but are NOT in the new draft — show as "removed" context
  const removedSteps: RemovedStep[] = existingTasks
    .filter(t => !newTextSet.has(t.text.toLowerCase().trim()))
    .map(t => ({ id: t.id, text: t.text, stepIndex: t.stepIndex }));

  // Emit plan.created only for truly new plans; existing plan regenerations are updates.
  planEvents.emit_plan({
    type: params.existingPlanId ? "plan.updated" : "plan.created",
    payload: {
      planId: plan.id,
      userId: params.userId,
      repoUrl: params.repoUrl ?? null,
      title: plan.title,
      taskCount: draftSteps.length,
    },
  });

  return { plan, draftSteps, existingTasks, diff: { removedSteps }, llmFailed };
}

// ── Preservation policy (pure, exported for unit tests) ───────────────────────
// Determines whether an existing task row should survive a plan approval delta.
// Rules (a task is kept if ANY apply):
//   a) its id is in the approved step set (matched by existingTaskId)
//   b) its normalized text matches an approved step without an id (new-step fallback)
//   c) confirmedByUser = true (user explicitly pinned it)
//   d) status is "done" or "skipped" — audit trail of completed work
// Exception: explicit removal (user dragged to trash) always overrides (c) and (d).
const AUDIT_STATUSES = new Set<string>(["done", "skipped"]);
export function shouldPreserveTask(
  task: { id: number; text: string; status: string; confirmedByUser: boolean },
  approvedIds: Set<number>,
  approvedTexts: Set<string>,
  explicitRemovals: Set<number>,
): boolean {
  if (explicitRemovals.has(task.id)) return false;
  if (approvedIds.has(task.id)) return true;
  if (approvedTexts.has(task.text.toLowerCase().trim())) return true;
  if (task.confirmedByUser) return true;
  if (AUDIT_STATUSES.has(task.status)) return true;
  return false;
}

// ── approvePlan ───────────────────────────────────────────────────────────────
// Applies the user-approved step list as a delta to project_tasks, preserving
// existing task status/sessionId/completedAt/confirmedByUser for continuing tasks.

export async function approvePlan(params: {
  planId: number;
  userId: string;
  steps: Array<{
    text: string;
    priority: PlanTaskPriority;
    stepIndex: number;
    existingTaskId?: number;
    doneLooksLike?: string | null;
    outOfScope?: string | null;
    fileDependencies?: string | null;
  }>;
  explicitRemovals?: number[];
}): Promise<ProjectTask[]> {
  const plan = await getPlanById(params.planId);
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
  if (plan.userId !== params.userId) throw Object.assign(new Error("Access denied"), { statusCode: 403 });

  const currentTasks = await getTasksForPlan(params.planId);
  // Primary identity: task DB id (stable across inline edits, including text changes).
  // Fallback: normalized text (for steps that had no prior DB row).
  const currentById = new Map(currentTasks.map(t => [t.id, t]));
  const currentByText = new Map(currentTasks.map(t => [t.text.toLowerCase().trim(), t]));

  // Approved task IDs — any currentTask whose id appears in the approved steps.
  const approvedIds = new Set(params.steps.flatMap(s => s.existingTaskId != null ? [s.existingTaskId] : []));
  // Text keys for truly new steps (no existingTaskId) for fallback matching.
  const approvedTexts = new Set(
    params.steps.filter(s => s.existingTaskId == null).map(s => s.text.toLowerCase().trim())
  );
  const explicitRemovalSet = new Set(params.explicitRemovals ?? []);

  const VALID_PRIORITIES: PlanTaskPriority[] = ["high", "normal", "low"];

  // All task mutations + plan version bump in a single transaction so partial
  // failure cannot leave the board in an inconsistent state.
  const result: ProjectTask[] = await db.transaction(async (tx) => {
    const rows: ProjectTask[] = [];

    for (const t of currentTasks) {
      if (!shouldPreserveTask(t, approvedIds, approvedTexts, explicitRemovalSet)) {
        await tx.delete(projectTasksTable).where(eq(projectTasksTable.id, t.id));
      }
    }

    for (let i = 0; i < params.steps.length; i++) {
      const step = params.steps[i]!;
      const priority: PlanTaskPriority = VALID_PRIORITIES.includes(step.priority)
        ? step.priority : "normal";

      // Prefer lookup by existingTaskId (stable identity even after inline text edits),
      // fall back to normalized text for genuinely new steps.
      const existing = step.existingTaskId != null
        ? currentById.get(step.existingTaskId)
        : currentByText.get(step.text.toLowerCase().trim());

      if (existing) {
        // Update text, index, priority, and mark as user-confirmed.
        // Preserve status/session/history fields so in-progress work is not lost.
        // Only overwrite detail fields if the new step supplies them (non-null).
        const detailPatch: Partial<typeof projectTasksTable.$inferInsert> = {};
        if (step.doneLooksLike != null) detailPatch.doneLooksLike = step.doneLooksLike;
        if (step.outOfScope != null) detailPatch.outOfScope = step.outOfScope;
        if (step.fileDependencies != null) detailPatch.fileDependencies = step.fileDependencies;
        const [updated] = await tx.update(projectTasksTable)
          .set({ text: step.text.trim(), stepIndex: i, priority, confirmedByUser: true, updatedAt: new Date(), ...detailPatch })
          .where(eq(projectTasksTable.id, existing.id))
          .returning();
        rows.push(updated!);
      } else {
        // New step authored or accepted by the user — mark confirmed immediately.
        const [inserted] = await tx.insert(projectTasksTable).values({
          planId: params.planId,
          stepIndex: i,
          text: step.text.trim(),
          status: "planned",
          priority,
          confirmedByUser: true,
          originPlanVersion: plan.version + 1,
          doneLooksLike: step.doneLooksLike ?? null,
          outOfScope: step.outOfScope ?? null,
          fileDependencies: step.fileDependencies ?? null,
        }).returning();
        rows.push(inserted!);
      }
    }

    await tx.update(projectPlansTable)
      .set({ version: plan.version + 1, updatedAt: new Date() })
      .where(eq(projectPlansTable.id, params.planId));

    return rows;
  });

  // Persist the FULL authoritative post-approve task set to memory — including any
  // confirmed tasks that were preserved (not deleted) but weren't in the approved steps list.
  // This ensures the memory snapshot reflects the true board state, not just the diff result.
  const authoritative = await getTasksForPlan(params.planId);
  await persistPlanToMemory(plan, authoritative);

  // Return the full authoritative post-approve task set (includes any preserved
  // confirmed/done tasks that were not in the transaction loop but survived deletion).
  logger.info({ planId: params.planId, userId: params.userId, stepCount: authoritative.length }, "[plan] Plan approved");
  return authoritative;
}

export async function getPlansForUser(userId: string, repoUrl?: string | null): Promise<ProjectPlan[]> {
  if (repoUrl) {
    return db.select()
      .from(projectPlansTable)
      .where(and(eq(projectPlansTable.userId, userId), eq(projectPlansTable.repoUrl, repoUrl)))
      .orderBy(desc(projectPlansTable.updatedAt));
  }
  return db.select()
    .from(projectPlansTable)
    .where(eq(projectPlansTable.userId, userId))
    .orderBy(desc(projectPlansTable.updatedAt));
}

export async function getPlanById(planId: number): Promise<ProjectPlan | null> {
  const [plan] = await db.select().from(projectPlansTable).where(eq(projectPlansTable.id, planId));
  return plan ?? null;
}

export async function getTasksForPlan(planId: number): Promise<ProjectTask[]> {
  return db.select()
    .from(projectTasksTable)
    .where(eq(projectTasksTable.planId, planId))
    .orderBy(asc(projectTasksTable.stepIndex));
}

export async function updateTask(params: {
  taskId: number;
  userId: string;
  updates: {
    text?: string;
    status?: PlanTaskStatus;
    priority?: PlanTaskPriority;
    confirmedByUser?: boolean;
    stepIndex?: number;
    blockedBy?: number[] | null;
    doneLooksLike?: string | null;
    outOfScope?: string | null;
    fileDependencies?: string | null;
  };
}): Promise<ProjectTask | null> {
  // Task-level ownership: join to project_plans and verify userId — prevents
  // attackers from mutating tasks in another user's plan via arbitrary taskId.
  const [row] = await db
    .select({ task: projectTasksTable, planUserId: projectPlansTable.userId })
    .from(projectTasksTable)
    .innerJoin(projectPlansTable, eq(projectTasksTable.planId, projectPlansTable.id))
    .where(eq(projectTasksTable.id, params.taskId));
  if (!row) return null;
  if (row.planUserId !== params.userId) {
    throw Object.assign(new Error("Access denied"), { statusCode: 403 });
  }
  const existing = row.task;

  const setData: Partial<typeof projectTasksTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  if (params.updates.text !== undefined) setData.text = params.updates.text;
  if (params.updates.status !== undefined) {
    setData.status = params.updates.status;
    if (params.updates.status === "done") setData.completedAt = new Date();
  }
  if (params.updates.priority !== undefined) setData.priority = params.updates.priority;
  if (params.updates.confirmedByUser !== undefined) setData.confirmedByUser = params.updates.confirmedByUser;
  if (params.updates.stepIndex !== undefined) setData.stepIndex = params.updates.stepIndex;
  if (params.updates.blockedBy !== undefined) setData.blockedBy = params.updates.blockedBy;
  if (params.updates.doneLooksLike !== undefined) setData.doneLooksLike = params.updates.doneLooksLike;
  if (params.updates.outOfScope !== undefined) setData.outOfScope = params.updates.outOfScope;
  if (params.updates.fileDependencies !== undefined) setData.fileDependencies = params.updates.fileDependencies;

  const [updated] = await db.update(projectTasksTable)
    .set(setData)
    .where(eq(projectTasksTable.id, params.taskId))
    .returning();

  if (!updated) return null;

  if (params.updates.status && params.updates.status !== existing.status) {
    planEvents.emit_plan({
      type: "plan.task_status_changed",
      payload: {
        taskId: params.taskId,
        planId: existing.planId,
        userId: params.userId,
        previousStatus: existing.status,
        newStatus: params.updates.status,
        confirmedByUser: updated.confirmedByUser,
      },
    });
  }

  return updated;
}

export async function addTaskToPlan(params: {
  planId: number;
  text: string;
  priority?: PlanTaskPriority;
  userId: string;
}): Promise<ProjectTask> {
  // Find max step index
  const existing = await db.select({ stepIndex: projectTasksTable.stepIndex })
    .from(projectTasksTable)
    .where(eq(projectTasksTable.planId, params.planId))
    .orderBy(desc(projectTasksTable.stepIndex))
    .limit(1);
  const nextIndex = (existing[0]?.stepIndex ?? -1) + 1;

  const [task] = await db.insert(projectTasksTable).values({
    planId: params.planId,
    stepIndex: nextIndex,
    text: params.text,
    status: "planned",
    priority: params.priority ?? "normal",
    confirmedByUser: true,
  }).returning();
  return task!;
}

export async function deleteTask(taskId: number, userId: string): Promise<void> {
  // Task-level ownership: join to project_plans and verify userId.
  const [row] = await db
    .select({ planUserId: projectPlansTable.userId })
    .from(projectTasksTable)
    .innerJoin(projectPlansTable, eq(projectTasksTable.planId, projectPlansTable.id))
    .where(eq(projectTasksTable.id, taskId));
  if (!row) return; // task doesn't exist — no-op
  if (row.planUserId !== userId) {
    throw Object.assign(new Error("Access denied"), { statusCode: 403 });
  }
  await db.delete(projectTasksTable).where(eq(projectTasksTable.id, taskId));
}

export interface ReassessResult {
  updatedCount: number;
  summary: string;
  skippedConfirmed: number;
}

export async function reassessSession(params: {
  sessionId: number;
  userId: string;
}): Promise<ReassessResult | null> {
  // Load session to find linked plan
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, params.sessionId));
  if (!session) return null;

  const planId = (session as typeof session & { planId?: number | null }).planId;
  if (!planId) return null;

  // Ownership check BEFORE loading tasks or calling LLM — prevents cross-user data leakage.
  const [plan] = await db.select().from(projectPlansTable).where(eq(projectPlansTable.id, planId));
  if (!plan) return null;
  if (plan.userId !== params.userId) {
    throw Object.assign(new Error("Access denied"), { statusCode: 403 });
  }

  const tasks = await getTasksForPlan(planId);
  if (tasks.length === 0) return null;

  // Import memory observations lazily to avoid circular deps
  const { listObservations } = await import("./memory");

  // Memory observations are stored under the operator memory user ID
  // (MIZI_MEM_USER_ID, default "operator"), NOT under the plan owner's dashboard
  // userId. The plan owner's userId is a browser-local anonymous ID that has no
  // corresponding memory records; using it would always return an empty list.
  // Normalize session id: accept both "sess-<id>" (passive-recall) and plain "<id>"
  // (addObservation in routes/sessions.ts) so reassessment captures both pipelines.
  const memOperatorId = process.env["MIZI_MEM_USER_ID"] ?? "operator";
  const memSessionId = `sess-${params.sessionId}`;
  const plainSessionId = String(params.sessionId);
  const observations = listObservations(memOperatorId, 100, 0)
    .filter((o: { sessionId?: string }) =>
      o.sessionId === memSessionId || o.sessionId === plainSessionId
    )
    .slice(0, 40);

  const reassessments = await callLlmForReassessment({
    tasks: tasks.map(t => ({
      id: t.id,
      text: t.text,
      status: t.status,
      confirmedByUser: t.confirmedByUser,
    })),
    observations: observations.map((o: { toolName: string; inputSummary: string; outputSummary: string }) => ({
      toolName: o.toolName,
      inputSummary: o.inputSummary,
      outputSummary: o.outputSummary,
    })),
  });

  if (!reassessments) {
    return { updatedCount: 0, summary: "Reassessment unavailable (LLM not configured).", skippedConfirmed: 0 };
  }

  let updatedCount = 0;
  let skippedConfirmed = 0;

  // Apply all status updates in a single transaction so a mid-loop failure
  // doesn't leave the board with a partially-reassessed task set.
  await db.transaction(async (tx) => {
    for (const r of reassessments) {
      const task = tasks.find(t => t.id === r.taskId);
      if (!task) continue;
      if (task.confirmedByUser) {
        skippedConfirmed++;
        continue;
      }
      if (r.newStatus !== task.status) {
        const now = new Date();
        await tx.update(projectTasksTable)
          .set({
            status: r.newStatus,
            confirmedByUser: false,
            sessionId: params.sessionId,
            ...(r.newStatus === "done" ? { completedAt: now } : {}),
            updatedAt: now,
          })
          .where(and(eq(projectTasksTable.id, task.id), eq(projectTasksTable.planId, planId)));
        // Emit per-task status-change event so downstream integrations see
        // reassessment-driven updates on the same contract as manual updates.
        planEvents.emit_plan({
          type: "plan.task_status_changed",
          payload: { planId, taskId: task.id, newStatus: r.newStatus, previousStatus: task.status, confirmedByUser: false, userId: params.userId },
        });
        updatedCount++;
      }
    }
  });

  // Derive summary from actually-applied reassessment entries only (post-skip),
  // so counts reflect what truly changed — not what the LLM suggested.
  const appliedEntries = reassessments.filter(r => {
    const task = tasks.find(t => t.id === r.taskId);
    return task && !task.confirmedByUser && r.newStatus !== task.status;
  });
  const doneCount = appliedEntries.filter(r => r.newStatus === "done").length;
  const partialCount = appliedEntries.filter(r => r.newStatus === "partial").length;
  const summary = [
    doneCount > 0 ? `${doneCount} task${doneCount > 1 ? "s" : ""} marked done` : null,
    partialCount > 0 ? `${partialCount} partially completed` : null,
    skippedConfirmed > 0 ? `${skippedConfirmed} user-confirmed task${skippedConfirmed > 1 ? "s" : ""} preserved` : null,
  ].filter(Boolean).join(", ") || "No status changes detected.";

  // Persist summary to plan so the board can surface it persistently.
  await db.update(projectPlansTable)
    .set({ lastReassessmentSummary: summary, updatedAt: new Date() })
    .where(eq(projectPlansTable.id, planId));

  planEvents.emit_plan({
    type: "plan.reassessed",
    payload: {
      planId,
      sessionId: params.sessionId,
      userId: params.userId,
      summary,
      updatedTaskCount: updatedCount,
    },
  });

  // Update memory with latest board state
  const updatedTasks = await getTasksForPlan(planId);
  await persistPlanToMemory(plan, updatedTasks);

  return { updatedCount, summary, skippedConfirmed };
}

export function exportPlanAsMarkdown(plan: ProjectPlan, tasks: ProjectTask[]): string {
  const statusEmoji: Record<string, string> = {
    planned: "⬜",
    in_progress: "🔄",
    done: "✅",
    partial: "🔶",
    skipped: "⏭️",
  };

  const lines = [
    `# ${plan.title}`,
    ``,
    `**Version:** ${plan.version}  `,
    `**Created:** ${plan.createdAt.toISOString().split("T")[0]}  `,
    plan.repoUrl ? `**Repository:** ${plan.repoUrl}  ` : null,
    ``,
    `## Tasks`,
    ``,
    ...tasks
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map(t => {
        const icon = statusEmoji[t.status] ?? "⬜";
        const priority = t.priority !== "normal" ? ` *(${t.priority} priority)*` : "";
        const confirmed = t.confirmedByUser ? " ✓" : "";
        const session = t.sessionId ? ` — session #${t.sessionId}` : "";
        const done = t.completedAt ? ` — completed ${t.completedAt.toISOString().split("T")[0]}` : "";
        return `${icon} **${t.stepIndex + 1}.** ${t.text}${priority}${confirmed}${session}${done}`;
      }),
    ``,
    `---`,
    `*Exported from MIZI on ${new Date().toISOString().split("T")[0]}*`,
  ].filter(l => l !== null);

  return lines.join("\n");
}

async function persistPlanToMemory(plan: ProjectPlan, tasks: ProjectTask[]): Promise<void> {
  // Always write plan memory under MIZI_MEM_USER_ID ("operator") — the same
  // identity that session memory recall (getPastContext) queries — so that
  // approved/reassessed plans are reliably injected into new session context.
  const memUserId = process.env["MIZI_MEM_USER_ID"] ?? "operator";
  try {
    const content = [
      `Project Plan: ${plan.title} (v${plan.version})`,
      plan.repoUrl ? `Repository: ${plan.repoUrl}` : null,
      `Tasks:`,
      ...tasks.sort((a, b) => a.stepIndex - b.stepIndex).map(t =>
        `  ${t.stepIndex + 1}. [${t.status}${t.confirmedByUser ? ", confirmed" : ""}] ${t.text}`
      ),
    ].filter(Boolean).join("\n");

    await saveMemoryItem({
      userId: memUserId,
      memoryType: "project_plan" as const,
      scope: "repo_shared" as const,
      content,
      symbolRef: `plan:${plan.id}`,
      metadata: {
        planId: plan.id,
        planVersion: plan.version,
        repoUrl: plan.repoUrl ?? null,
        source: "project_plan",
      },
    });
  } catch (err) {
    logger.warn({ err, planId: plan.id }, "[plan] Failed to persist plan to memory (non-fatal)");
  }
}
