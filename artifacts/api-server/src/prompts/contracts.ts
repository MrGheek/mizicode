/**
 * prompts/contracts.ts
 *
 * Typed Zod input contracts and prompt-version stamps for all inline LLM
 * prompt sites in the API server.  Each contract:
 *   1. Defines a typed Zod schema for the prompt's dynamic inputs.
 *   2. Exports a semver-style version stamp so template changes are explicitly
 *      versioned in logs and lane-prompt-snapshot records.
 *   3. Exports a render function that accepts validated inputs and returns the
 *      full LlmMessage array ready to pass to callLlm().
 *   4. Is reachable via the generic renderPrompt(contractId, vars) dispatcher
 *      for callers that receive a contract ID at runtime.
 *
 * Prompt sites covered:
 *   plan.generate        — plan.ts callLlmForPlan
 *   plan.reassess        — plan.ts callLlmForReassessment
 *   plan.decompose       — plan-decompose.ts callLlmForDecomposition
 *   memory.sidecarVerify — memory-passive.ts sidecarVerify
 *   palette.intent       — routes/palette-intent.ts POST /palette/intent
 */

import { z } from "zod";
import type { LlmMessage } from "../services/llm-client";

// ─── plan.generate ────────────────────────────────────────────────────────────

export const PLAN_GENERATE_SYSTEM = `You are MIZI, an AI project planner. Decompose a software development intent into 3–7 concrete, actionable steps.
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

/** Semver-style version stamp. Bump manually when the system template above changes. */
export const PLAN_GENERATE_VERSION = "plan.generate@1.0.0";

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

export const PLAN_REASSESS_SYSTEM = `You are MIZI, an AI code session analyst. Based on what the AI did during a session, assess which tasks were completed.
Return ONLY valid JSON array:
[{ "taskId": <number>, "newStatus": "done|partial|in_progress|planned", "reason": "brief reason" }, ...]
Rules:
- Skip tasks where confirmedByUser=true — DO NOT change those
- "done" = clearly completed, "partial" = started but unfinished, "in_progress" = actively being worked, "planned" = untouched
- Only include entries where status should change from current
- Pure JSON array only, no markdown`;

/** Semver-style version stamp. Bump manually when the system template above changes. */
export const PLAN_REASSESS_VERSION = "plan.reassess@1.0.0";

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

/** Semver-style version stamp. Bump manually when the preamble or rules above change. */
export const PLAN_DECOMPOSE_VERSION = "plan.decompose@1.0.0";

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

export const MEMORY_SIDECAR_VERIFY_SYSTEM = `You are a strict relevance judge. Decide if a retrieved memory is genuinely useful for the current conversation turn. Reply ONLY with JSON: {"relevant": boolean, "reason": string}.`;

/** Semver-style version stamp. Bump manually when the system template above changes. */
export const MEMORY_SIDECAR_VERIFY_VERSION = "memory.sidecarVerify@1.0.0";

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

// ─── palette.intent ───────────────────────────────────────────────────────────

export const PALETTE_INTENT_SYSTEM = `You are an AI assistant embedded in the MIZI command palette — a cloud coding platform for managing GPU-backed coding sessions.

Your job is to parse a natural-language command from the user and return a structured JSON action object. The user is currently using the app; use the context provided to resolve ambiguous references like "my session", "the running one", "last night's session", etc.

Available action types:
- navigate: Navigate to a route in the app
  Available routes: "/" (dashboard), "/sessions" (sessions list), "/sessions/{id}" (session detail), "/skills", "/memory", "/templates", "/design-intelligence"
- stop-session: Stop a session. Requires sessionId in payload. Use activeSessionId from context when user says "my session", "the running one", etc. If no active session exists in context, set ok=false.
- reindex-session: Trigger a repo re-index for a session. Requires sessionId in payload.
- new-session: Open the new session launch dialog.
- relaunch-session: Re-launch a stopped session. Requires sessionId in payload.
- copy-ssh: Copy the SSH command for a session. Requires sessionId in payload.

Respond with ONLY valid JSON matching this schema:
{
  "ok": boolean,
  "action": "<action-type>" | null,
  "payload": { "route": "<route>" | null, "sessionId": <number> | null } | null,
  "explanation": "<human-readable description of what will happen, or reason for failure>"
}

Rules:
- If the command is clear and actionable, set ok=true and fill in action+payload.
- If the command references "active session", "running session", or "my session" and there is an activeSessionId in context, use that sessionId.
- If the command references a session by number (e.g. "session 42" or "#42"), use that ID as sessionId.
- If context is needed but not available (e.g. user says "stop my session" but there is no active session), set ok=false and explain why.
- If the command is unrecognizable or outside scope, set ok=false with a friendly explanation.
- Keep explanation concise (≤ 80 chars). It will be shown in a toast notification.
- Never include markdown, code fences, or any text outside the JSON object.`;

/** Semver-style version stamp. Bump manually when the system template above changes. */
export const PALETTE_INTENT_VERSION = "palette.intent@1.0.0";

export const PaletteIntentFewShotExampleSchema = z.object({
  query: z.string(),
  action: z.string().nullable(),
  payloadJson: z.unknown().nullable(),
  explanation: z.string(),
});

export const PaletteIntentInputSchema = z.object({
  query: z.string().min(1).max(500),
  context: z.object({
    route: z.string().default("/"),
    activeSessionId: z.number().nullable().default(null),
    activeSessionStatus: z.string().nullable().default(null),
    recentSessionIds: z.array(z.number()).default([]),
  }),
  fewShotExamples: z.array(PaletteIntentFewShotExampleSchema).default([]),
});

export type PaletteIntentInput = z.infer<typeof PaletteIntentInputSchema>;

function buildPaletteFewShotBlock(
  examples: PaletteIntentInput["fewShotExamples"],
): string {
  if (examples.length === 0) return "";
  const lines = [
    "",
    "Past successful commands from this user (use as few-shot examples):",
  ];
  for (const ex of examples) {
    const payload = ex.payloadJson ?? null;
    lines.push(
      `  User: "${ex.query}" → ${JSON.stringify({ ok: true, action: ex.action, payload, explanation: ex.explanation })}`,
    );
  }
  return lines.join("\n");
}

export function renderPaletteIntent(input: PaletteIntentInput): LlmMessage[] {
  const validated = PaletteIntentInputSchema.parse(input);
  const ctx = validated.context;
  const fewShotBlock = buildPaletteFewShotBlock(validated.fewShotExamples);
  const systemContent = fewShotBlock
    ? PALETTE_INTENT_SYSTEM + fewShotBlock
    : PALETTE_INTENT_SYSTEM;
  const userContent = [
    `User query: "${validated.query}"`,
    "",
    "Current context:",
    `  route: ${ctx.route}`,
    `  activeSessionId: ${ctx.activeSessionId ?? "none"}`,
    `  activeSessionStatus: ${ctx.activeSessionStatus ?? "none"}`,
    `  recentSessionIds: [${ctx.recentSessionIds.join(", ")}]`,
  ].join("\n");
  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}

// ─── Generic dispatcher ───────────────────────────────────────────────────────

/**
 * Generic renderPrompt dispatcher — accepts a contract ID and validated input,
 * returns the LlmMessage array for that contract.
 *
 * Use this when the contract ID is determined at runtime (e.g. eval harnesses,
 * prompt-replay tooling).  For statically-typed call sites, prefer calling the
 * specific render* function directly.
 */
export function renderPrompt(contractId: "plan.generate", vars: PlanGenerateInput): LlmMessage[];
export function renderPrompt(contractId: "plan.reassess", vars: PlanReassessInput): LlmMessage[];
export function renderPrompt(contractId: "plan.decompose", vars: PlanDecomposeInput): LlmMessage[];
export function renderPrompt(contractId: "memory.sidecarVerify", vars: MemorySidecarVerifyInput): LlmMessage[];
export function renderPrompt(contractId: "palette.intent", vars: PaletteIntentInput): LlmMessage[];
export function renderPrompt(contractId: string, vars: unknown): LlmMessage[] {
  switch (contractId) {
    case "plan.generate":
      return renderPlanGenerate(vars as PlanGenerateInput);
    case "plan.reassess":
      return renderPlanReassess(vars as PlanReassessInput);
    case "plan.decompose":
      return renderPlanDecompose(vars as PlanDecomposeInput);
    case "memory.sidecarVerify":
      return renderMemorySidecarVerify(vars as MemorySidecarVerifyInput);
    case "palette.intent":
      return renderPaletteIntent(vars as PaletteIntentInput);
    default:
      throw new Error(`Unknown prompt contract: ${contractId}`);
  }
}
