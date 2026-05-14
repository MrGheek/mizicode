/**
 * Plan Decompose — Task #383
 *
 * Watches the memory observation stream mid-session and automatically appends
 * newly discovered tasks to the plan board when the swarm encounters unanticipated
 * complexity.
 *
 * Design constraints:
 *  - Fully fire-and-forget: never blocks the memory write path
 *  - Skill-aware: only suggests tasks within the swarm's active capability set
 *  - Semantic deduplication: suppresses near-duplicate candidates using
 *    computeSemanticSimilarityBatch (NIM embeddings → TF-IDF cosine fallback)
 *  - Rate-limited: at most one decomposition pass per session per N minutes,
 *    and only after M new observations have accumulated since the last pass
 *  - Appends only: never modifies or removes existing tasks
 *  - Persists enriched board to memory after each successful pass
 */

import { db, sessionsTable, projectPlansTable, projectTasksTable, sessionSkillsTable } from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { subscribeToObservations } from "./memory";
import { getTasksForPlan, getPlanById, persistPlanToMemory } from "./plan";
import { planEvents } from "./plan-events";
import { computeSemanticSimilarityBatch } from "./memory-semantic";
import { broadcastPlanTasks } from "./lane-sse-broadcaster";
import { callLlm } from "./llm-client";
import { scoreModelsForPhase } from "./inference-router";
import type { Observation } from "./memory";

// ── Tuning constants ───────────────────────────────────────────────────────────

/** Minimum new observations since last pass before triggering decomposition */
const MIN_NEW_OBS_THRESHOLD = 8;

/** Minimum minutes between decomposition passes for the same session */
const MIN_PASS_INTERVAL_MS = 5 * 60 * 1000;

/** Maximum candidate tasks the LLM may return per pass */
const MAX_CANDIDATES_PER_PASS = 3;

/** Semantic similarity threshold above which a candidate is suppressed as a duplicate */
const DEDUP_SIMILARITY_THRESHOLD = 0.72;

/** Cache TTL for session → plan lookups */
const SESSION_CACHE_TTL_MS = 90_000;

// ── Per-session rate-limit state ──────────────────────────────────────────────

interface SessionDecomposeState {
  newObsSinceLastPass: number;
  lastPassAt: number;
  planId: number | null;
  planUserId: string;
  cachedAt: number;
}

const sessionState = new Map<string, SessionDecomposeState>();

// ── Session → plan resolution (cached) ───────────────────────────────────────

async function resolveSessionPlan(
  sessionId: string,
): Promise<{ planId: number; planUserId: string } | null> {
  const now = Date.now();
  const state = sessionState.get(sessionId);
  if (state && now - state.cachedAt < SESSION_CACHE_TTL_MS) {
    return state.planId ? { planId: state.planId, planUserId: state.planUserId } : null;
  }

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
    logger.warn({ err, sessionId }, "[plan-decompose] Failed to resolve session plan (non-fatal)");
    return null;
  }

  const existing = sessionState.get(sessionId);
  sessionState.set(sessionId, {
    newObsSinceLastPass: existing?.newObsSinceLastPass ?? 0,
    lastPassAt: existing?.lastPassAt ?? 0,
    planId,
    planUserId,
    cachedAt: now,
  });

  return planId ? { planId, planUserId } : null;
}

// ── Skill-aware LLM prompt ────────────────────────────────────────────────────

interface ActiveSkillSummary {
  name: string;
  tasks: string[];
}

interface SkillSnapshot {
  skills: ActiveSkillSummary[];
  rationaleContext: string;
}

async function loadActiveSkills(sessionId: string): Promise<SkillSnapshot> {
  const numericId = parseInt(sessionId.replace(/^sess-/, ""), 10);
  if (isNaN(numericId)) return { skills: [], rationaleContext: "" };

  try {
    const [row] = await db
      .select({
        activatedSkillsJson: sessionSkillsTable.activatedSkillsJson,
        rationaleJson: sessionSkillsTable.rationaleJson,
      })
      .from(sessionSkillsTable)
      .where(eq(sessionSkillsTable.sessionId, numericId))
      .orderBy(desc(sessionSkillsTable.id))
      .limit(1);

    if (!row) return { skills: [], rationaleContext: "" };

    const skills = row.activatedSkillsJson as Array<{ name?: string; triggers?: { tasks?: string[] } }> | null;
    const rationale = row.rationaleJson as Record<string, unknown> | null;

    const activeSummaries: ActiveSkillSummary[] = Array.isArray(skills)
      ? skills
          .filter(s => s?.name)
          .map(s => ({
            name: s.name!,
            tasks: Array.isArray(s.triggers?.tasks) ? (s.triggers.tasks as string[]) : [],
          }))
      : [];

    // Summarise rationale context (top intent-fitting skills with their reasoning)
    let rationaleContext = "";
    if (rationale && typeof rationale === "object") {
      const lines = Object.entries(rationale)
        .slice(0, 5)
        .map(([skill, reason]) => `  ${skill}: ${String(reason).slice(0, 120)}`)
        .join("\n");
      if (lines) rationaleContext = lines;
    }

    return { skills: activeSummaries, rationaleContext };
  } catch {
    return { skills: [], rationaleContext: "" };
  }
}

interface CandidateTask {
  text: string;
  priority: "high" | "normal" | "low";
  rationale: string;
}

async function callLlmForDecomposition(params: {
  existingTasks: Array<{ text: string; status: string }>;
  recentObservations: Array<{ toolName: string; inputSummary: string; outputSummary: string }>;
  activeSkills: ActiveSkillSummary[];
  rationaleContext: string;
}): Promise<CandidateTask[]> {
  const taskList = params.existingTasks
    .map((t, i) => `  ${i + 1}. [${t.status}] ${t.text}`)
    .join("\n");

  const obsList = params.recentObservations
    .slice(0, 30)
    .map(o => `  [${o.toolName}] ${o.inputSummary} → ${o.outputSummary}`)
    .join("\n");

  const skillList = params.activeSkills.length > 0
    ? params.activeSkills.map(s => `  - ${s.name}${s.tasks.length > 0 ? ` (handles: ${s.tasks.slice(0, 3).join(", ")})` : ""}`).join("\n")
    : "  (no skill information available)";

  const rationaleSection = params.rationaleContext
    ? `\nSkill activation rationale (why these skills were chosen for this session):\n${params.rationaleContext}\n`
    : "";

  // Route through the inference-router for the plan phase so model selection
  // is cost/quality-aware. Falls back to the default PLAN_LLM_MODEL env var
  // (via getLlmClientConfig) if no live NIM provider is ranked.
  let overrideModel: string | undefined;
  try {
    const ranked = await scoreModelsForPhase("plan");
    if (ranked.length > 0) {
      overrideModel = ranked[0]!.model.nimModelId;
    }
  } catch (err) {
    logger.debug({ err }, "[plan-decompose] Inference-router score failed, using default model");
  }

  const raw = await callLlm({
    logTag: "plan.decompose",
    temperature: 0.2,
    max_tokens: 600,
    overrideModel,
    messages: [
      {
        role: "system",
        content: `You are MIZI, an AI project planner analyzing mid-session swarm activity to discover hidden complexity.

Given the current plan tasks and recent swarm observations, identify NEW tasks that should be added to the plan — tasks that represent unanticipated complexity the swarm has discovered.

Active swarm skills (only suggest tasks these skills can handle):
${skillList}
${rationaleSection}
Rules:
- Return ONLY valid JSON array of NEW task objects (not existing tasks)
- Maximum ${MAX_CANDIDATES_PER_PASS} tasks
- Each task must address real complexity seen in the observations, not speculation
- Do not duplicate or paraphrase existing tasks
- Tasks must be within the active skill set
- Return [] if no new tasks are warranted
- Format: [{"text": "...", "priority": "high|normal|low", "rationale": "1 sentence: what the swarm observed that triggered this"}, ...]
- Pure JSON array only, no markdown`,
      },
      {
        role: "user",
        content: `Current plan tasks:\n${taskList}\n\nRecent swarm observations:\n${obsList}`,
      },
    ],
  });

  if (!raw) return [];

  const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0];
  if (!jsonStr) return [];

  try {
    const parsed = JSON.parse(jsonStr) as unknown[];
    if (!Array.isArray(parsed)) return [];
    const VALID_PRIORITIES = ["high", "normal", "low"] as const;
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const e = entry as Record<string, unknown>;
      const text = typeof e["text"] === "string" ? e["text"].trim() : "";
      const rationale = typeof e["rationale"] === "string" ? e["rationale"].trim() : "";
      const priority = VALID_PRIORITIES.includes(e["priority"] as (typeof VALID_PRIORITIES)[number])
        ? (e["priority"] as "high" | "normal" | "low")
        : "normal";
      if (!text || text.length < 5) return [];
      return [{ text, priority, rationale }];
    });
  } catch {
    return [];
  }
}

// ── Semantic deduplication ────────────────────────────────────────────────────

async function deduplicateCandidates(
  candidates: CandidateTask[],
  existingTasks: Array<{ text: string }>,
): Promise<CandidateTask[]> {
  if (candidates.length === 0 || existingTasks.length === 0) return candidates;

  const existingTexts = existingTasks.map(t => t.text);
  const approved: CandidateTask[] = [];

  for (const candidate of candidates) {
    try {
      const scores = await computeSemanticSimilarityBatch(candidate.text, existingTexts);
      const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
      if (maxScore >= DEDUP_SIMILARITY_THRESHOLD) {
        logger.debug(
          { candidate: candidate.text, maxScore },
          "[plan-decompose] Suppressed near-duplicate candidate",
        );
        continue;
      }
      // Also check against already-approved candidates this pass
      if (approved.length > 0) {
        const approvedScores = await computeSemanticSimilarityBatch(
          candidate.text,
          approved.map(a => a.text),
        );
        const maxApprovedScore = approvedScores.length > 0 ? Math.max(...approvedScores) : 0;
        if (maxApprovedScore >= DEDUP_SIMILARITY_THRESHOLD) {
          continue;
        }
      }
      approved.push(candidate);
    } catch {
      approved.push(candidate);
    }
  }

  return approved;
}

// ── Core decomposition pass ───────────────────────────────────────────────────

export async function runDecompositionPass(sessionId: string): Promise<number> {
  const planInfo = await resolveSessionPlan(sessionId);
  if (!planInfo) return 0;

  const { planId, planUserId } = planInfo;
  const plan = await getPlanById(planId);
  if (!plan) return 0;

  const existingTasks = await getTasksForPlan(planId);

  // Resolve numeric session ID once — used for both DB insert and SSE broadcast.
  const numericSessionId = parseInt(sessionId.replace(/^sess-/, ""), 10);
  const numericSessionIdOrNull = isNaN(numericSessionId) ? null : numericSessionId;

  const memOperatorId = process.env["MIZI_MEM_USER_ID"] ?? "operator";
  const { listObservations } = await import("./memory");
  const memSessionId = `sess-${sessionId.replace(/^sess-/, "")}`;
  const plainSessionId = sessionId.replace(/^sess-/, "");

  const allObs = listObservations(memOperatorId, 60, 0)
    .filter((o: { sessionId?: string }) =>
      o.sessionId === memSessionId || o.sessionId === plainSessionId
    )
    .slice(0, 30);

  if (allObs.length === 0) return 0;

  const { skills: activeSkills, rationaleContext } = await loadActiveSkills(sessionId);

  const candidates = await callLlmForDecomposition({
    existingTasks: existingTasks.map(t => ({ text: t.text, status: t.status })),
    recentObservations: allObs.map((o: { toolName: string; inputSummary: string; outputSummary: string }) => ({
      toolName: o.toolName,
      inputSummary: o.inputSummary,
      outputSummary: o.outputSummary,
    })),
    activeSkills,
    rationaleContext,
  });

  if (candidates.length === 0) return 0;

  const approved = await deduplicateCandidates(candidates, existingTasks);
  if (approved.length === 0) return 0;

  const maxStepIndex = existingTasks.length > 0
    ? Math.max(...existingTasks.map(t => t.stepIndex))
    : -1;

  const newVersion = plan.version + 1;

  const inserted = await db.transaction(async (tx) => {
    const rows = [];
    for (let i = 0; i < approved.length; i++) {
      const candidate = approved[i]!;
      const [row] = await tx.insert(projectTasksTable).values({
        planId,
        sessionId: numericSessionIdOrNull,
        stepIndex: maxStepIndex + 1 + i,
        text: candidate.text,
        status: "planned",
        priority: candidate.priority,
        confirmedByUser: false,
        origin: "swarm_discovered",
        rationale: candidate.rationale || null,
        originPlanVersion: newVersion,
      }).returning();
      rows.push(row!);
    }

    await tx.update(projectPlansTable)
      .set({ version: newVersion, updatedAt: new Date() })
      .where(eq(projectPlansTable.id, planId));

    return rows;
  });

  logger.info(
    { planId, sessionId, newTaskCount: inserted.length, newVersion },
    "[plan-decompose] Swarm-discovered tasks appended to plan",
  );

  planEvents.emit_plan({
    type: "plan.decomposed",
    payload: {
      planId,
      sessionId,
      userId: planUserId,
      newTaskCount: inserted.length,
      planVersion: newVersion,
    },
  });

  for (const task of inserted) {
    planEvents.emit_plan({
      type: "plan.task_status_changed",
      payload: {
        taskId: task.id,
        planId,
        userId: planUserId,
        previousStatus: "planned",
        newStatus: "planned",
        confirmedByUser: false,
      },
    });
  }

  if (numericSessionIdOrNull !== null) {
    broadcastPlanTasks(numericSessionIdOrNull, inserted);
  }

  const updatedTasks = await getTasksForPlan(planId);
  await persistPlanToMemory({ ...plan, version: newVersion }, updatedTasks);

  return inserted.length;
}

// ── Observation handler ───────────────────────────────────────────────────────

async function handleObservation(obs: Observation): Promise<void> {
  const { sessionId } = obs;

  const state = sessionState.get(sessionId) ?? {
    newObsSinceLastPass: 0,
    lastPassAt: 0,
    planId: null,
    planUserId: "",
    cachedAt: 0,
  };

  state.newObsSinceLastPass++;
  sessionState.set(sessionId, state);

  const now = Date.now();
  const enoughObs = state.newObsSinceLastPass >= MIN_NEW_OBS_THRESHOLD;
  const enoughTime = now - state.lastPassAt >= MIN_PASS_INTERVAL_MS;

  if (!enoughObs || !enoughTime) return;

  state.newObsSinceLastPass = 0;
  state.lastPassAt = now;
  sessionState.set(sessionId, state);

  try {
    const added = await runDecompositionPass(sessionId);
    if (added > 0) {
      logger.info({ sessionId, added }, "[plan-decompose] Decomposition pass completed");
    }
  } catch (err) {
    logger.warn({ err, sessionId }, "[plan-decompose] Decomposition pass failed (non-fatal)");
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the plan decomposition listener.
 *
 * Subscribes to the memory observation emitter and asynchronously fires
 * decomposition passes when rate-limit conditions are met.
 *
 * Safe to call once at server startup.
 */
export function startPlanDecompose(): void {
  const memOperatorId = process.env["MIZI_MEM_USER_ID"] ?? "operator";

  subscribeToObservations(memOperatorId, (obs) => {
    handleObservation(obs).catch((err) => {
      logger.warn({ err, sessionId: obs.sessionId }, "[plan-decompose] Observation handler error (non-fatal)");
    });
  });

  logger.info({ memOperatorId }, "[plan-decompose] Plan decomposition listener started");
}
