/**
 * prompts/contracts.ts
 *
 * Typed Zod input contracts and prompt-version stamps for all inline LLM
 * prompt sites in the API server.  Each contract:
 *   1. Defines a typed Zod schema for the prompt's dynamic inputs.
 *   2. Exports a deterministic version stamp (SHA-256 of the static system
 *      template, truncated to 12 hex chars) so that any template change is
 *      automatically reflected in logs and lane-prompt-snapshot records.
 *   3. Exports a render function that accepts validated inputs and returns the
 *      full LlmMessage array ready to pass to callLlm().
 *
 * Prompt sites covered:
 *   plan.generate        — plan.ts callLlmForPlan
 *   plan.reassess        — plan.ts callLlmForReassessment
 *   plan.decompose       — plan-decompose.ts callLlmForDecomposition
 *   memory.sidecarVerify — memory-passive.ts sidecarVerify
 */

import crypto from "crypto";
import { z } from "zod";
import type { LlmMessage } from "../services/llm-client";

function sha12(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

// ─── plan.generate ────────────────────────────────────────────────────────────

const PLAN_GENERATE_SYSTEM = `You are MIZI, an AI project planner. Decompose a software development intent into 3–7 concrete, actionable steps.
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
- No markdown, no extra text — pure JSON only`;

export const PLAN_GENERATE_VERSION = `plan.generate@${sha12(PLAN_GENERATE_SYSTEM)}`;

export const PlanGenerateInputSchema = z.object({
  intentText: z.string(),
  repoUrl: z.string().nullable().optional(),
  existingTasks: z
    .array(
      z.object({
        stepIndex: z.number().int(),
        text: z.string(),
        status: z.string(),
        confirmedByUser: z.boolean(),
      }),
    )
    .optional(),
  skillContext: z.string().optional(),
});

export type PlanGenerateInput = z.infer<typeof PlanGenerateInputSchema>;

export function renderPlanGenerate(input: PlanGenerateInput): LlmMessage[] {
  const validated = PlanGenerateInputSchema.parse(input);
  const existingContext =
    validated.existingTasks && validated.existingTasks.length > 0
      ? `\n\nExisting task board state (MUST preserve user-confirmed tasks):\n${validated.existingTasks
          .map(
            (t) =>
              `  [${t.stepIndex + 1}] ${t.text} — status: ${t.status}${t.confirmedByUser ? " (USER CONFIRMED — do not change)" : ""}`,
          )
          .join("\n")}`
      : "";
  const skillSection = validated.skillContext
    ? `\n\n${validated.skillContext}\nOnly decompose into tasks that fall within the described capabilities. If the goal requires capabilities outside this set, flag it explicitly in the first step.`
    : "";
  return [
    { role: "system", content: PLAN_GENERATE_SYSTEM },
    {
      role: "user",
      content: `Intent: ${validated.intentText}${validated.repoUrl ? `\nRepository: ${validated.repoUrl}` : ""}${skillSection}${existingContext}`,
    },
  ];
}

// ─── plan.reassess ────────────────────────────────────────────────────────────

const PLAN_REASSESS_SYSTEM = `You are MIZI, an AI code session analyst. Based on what the AI did during a session, assess which tasks were completed.
Return ONLY valid JSON array:
[{ "taskId": <number>, "newStatus": "done|partial|in_progress|planned", "reason": "brief reason" }, ...]
Rules:
- Skip tasks where confirmedByUser=true — DO NOT change those
- "done" = clearly completed, "partial" = started but unfinished, "in_progress" = actively being worked, "planned" = untouched
- Only include entries where status should change from current
- Pure JSON array only, no markdown`;

export const PLAN_REASSESS_VERSION = `plan.reassess@${sha12(PLAN_REASSESS_SYSTEM)}`;

export const PlanReassessInputSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.number().int(),
      text: z.string(),
      status: z.string(),
      confirmedByUser: z.boolean(),
    }),
  ),
  observations: z.array(
    z.object({
      toolName: z.string(),
      inputSummary: z.string(),
      outputSummary: z.string(),
    }),
  ),
  skillContext: z.string().optional(),
});

export type PlanReassessInput = z.infer<typeof PlanReassessInputSchema>;

export function renderPlanReassess(input: PlanReassessInput): LlmMessage[] {
  const validated = PlanReassessInputSchema.parse(input);
  const observationSummary = validated.observations
    .slice(0, 40)
    .map((o) => `[${o.toolName}] ${o.inputSummary} → ${o.outputSummary}`)
    .join("\n");
  const taskList = validated.tasks
    .map(
      (t) =>
        `  taskId=${t.id}: "${t.text}" (current: ${t.status}${t.confirmedByUser ? ", USER CONFIRMED" : ""})`,
    )
    .join("\n");
  const skillSection = validated.skillContext
    ? `\n\n${validated.skillContext}\nUse this to inform your assessment — the swarm can only perform actions within these capabilities.`
    : "";
  return [
    { role: "system", content: PLAN_REASSESS_SYSTEM },
    {
      role: "user",
      content: `Tasks:\n${taskList}${skillSection}\n\nSession observations:\n${observationSummary}`,
    },
  ];
}

// ─── plan.decompose ───────────────────────────────────────────────────────────

const PLAN_DECOMPOSE_STATIC_PREAMBLE = `You are MIZI, an AI project planner analyzing mid-session swarm activity to discover hidden complexity.

Given the current plan tasks and recent swarm observations, identify NEW tasks that should be added to the plan — tasks that represent unanticipated complexity the swarm has discovered.`;

const PLAN_DECOMPOSE_STATIC_RULES = `Rules:
- Return ONLY valid JSON array of NEW task objects (not existing tasks)
- Each task must address real complexity seen in the observations, not speculation
- Do not duplicate or paraphrase existing tasks
- Tasks must be within the active skill set
- Return [] if no new tasks are warranted
- Format: [{"text": "...", "priority": "high|normal|low", "rationale": "1 sentence: what the swarm observed that triggered this"}, ...]
- Pure JSON array only, no markdown`;

export const PLAN_DECOMPOSE_VERSION = `plan.decompose@${sha12(PLAN_DECOMPOSE_STATIC_PREAMBLE + PLAN_DECOMPOSE_STATIC_RULES)}`;

export const PlanDecomposeInputSchema = z.object({
  existingTasks: z.array(z.object({ text: z.string(), status: z.string() })),
  recentObservations: z.array(
    z.object({
      toolName: z.string(),
      inputSummary: z.string(),
      outputSummary: z.string(),
    }),
  ),
  activeSkills: z.array(
    z.object({
      name: z.string(),
      tasks: z.array(z.string()),
    }),
  ),
  rationaleContext: z.string(),
  maxCandidates: z.number().int().positive().default(3),
});

export type PlanDecomposeInput = z.infer<typeof PlanDecomposeInputSchema>;

export function renderPlanDecompose(input: PlanDecomposeInput): LlmMessage[] {
  const validated = PlanDecomposeInputSchema.parse(input);
  const taskList = validated.existingTasks
    .map((t, i) => `  ${i + 1}. [${t.status}] ${t.text}`)
    .join("\n");
  const obsList = validated.recentObservations
    .slice(0, 30)
    .map((o) => `  [${o.toolName}] ${o.inputSummary} → ${o.outputSummary}`)
    .join("\n");
  const skillList =
    validated.activeSkills.length > 0
      ? validated.activeSkills
          .map(
            (s) =>
              `  - ${s.name}${s.tasks.length > 0 ? ` (handles: ${s.tasks.slice(0, 3).join(", ")})` : ""}`,
          )
          .join("\n")
      : "  (no skill information available)";
  const rationaleSection = validated.rationaleContext
    ? `\nSkill activation rationale (why these skills were chosen for this session):\n${validated.rationaleContext}\n`
    : "";
  const system = `${PLAN_DECOMPOSE_STATIC_PREAMBLE}

Active swarm skills (only suggest tasks these skills can handle):
${skillList}
${rationaleSection}
- Maximum ${validated.maxCandidates} tasks
${PLAN_DECOMPOSE_STATIC_RULES}`;
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `Current plan tasks:\n${taskList}\n\nRecent swarm observations:\n${obsList}`,
    },
  ];
}

// ─── memory.sidecarVerify ────────────────────────────────────────────────────

const MEMORY_SIDECAR_VERIFY_SYSTEM = `You are a strict relevance judge. Decide if a retrieved memory is genuinely useful for the current conversation turn. Reply ONLY with JSON: {"relevant": boolean, "reason": string}.`;

export const MEMORY_SIDECAR_VERIFY_VERSION = `memory.sidecarVerify@${sha12(MEMORY_SIDECAR_VERIFY_SYSTEM)}`;

export const MemorySidecarVerifyInputSchema = z.object({
  turnContent: z.string(),
  candidateContent: z.string(),
  candidateId: z.number().int(),
  similarity: z.number().min(0).max(1),
});

export type MemorySidecarVerifyInput = z.infer<typeof MemorySidecarVerifyInputSchema>;

export function renderMemorySidecarVerify(input: MemorySidecarVerifyInput): LlmMessage[] {
  const validated = MemorySidecarVerifyInputSchema.parse(input);
  return [
    { role: "system", content: MEMORY_SIDECAR_VERIFY_SYSTEM },
    {
      role: "user",
      content: `TURN:\n${validated.turnContent.slice(0, 1500)}\n\nMEMORY:\n${validated.candidateContent.slice(0, 1500)}`,
    },
  ];
}
