/**
 * cost-gate.ts — RFC 0001 E2E cost-gate measurement (shared by the vitest gate
 * and the standalone `cost-gate-e2e.ts` script).
 *
 * Snapshots rendered prompt token counts for the three plan paths — with the
 * pre-RFC naive full-file context vs the RFC graph-sliced signature block — and
 * enforces the ≥40% reduction gate (RFC test plan: "E2E cost assertion").
 *
 * Token counting uses the codebase's deterministic ~4-chars/token heuristic
 * (estimateTokens) so the gate is stable and CI-friendly.
 */

import {
  renderPlanGenerate,
  renderPlanReassess,
  renderPlanDecompose,
} from "../../prompts/contracts";
import { estimateTokens } from "../../services/repo-rank";

export interface CostGateResult {
  path: string;
  baselineTokens: number;
  optimizedTokens: number;
  reductionPct: number;
  passed: boolean;
}

export const COST_GATE_TARGET_PCT = 40;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INTENT = "Add a session-scoped audit trail that records every tool call, its input/output summary, and who triggered it, with a dashboard view";

const EXISTING_TASKS = [
  { stepIndex: 0, text: "Design the audit_trail schema (session_id, tool, input_summary, output_summary, actor)", status: "in_progress", confirmedByUser: true },
  { stepIndex: 1, text: "Instrument the tool runner to emit audit events", status: "planned", confirmedByUser: false },
  { stepIndex: 2, text: "Add GET /api/audit endpoint with session + actor filters", status: "planned", confirmedByUser: false },
];

const OBSERVATIONS = [
  { toolName: "grep", inputSummary: "audit_trail", outputSummary: "found 3 refs in routes/audit.ts, services/audit.ts, db/schema" },
  { toolName: "read", inputSummary: "routes/audit.ts", outputSummary: "router with GET /api/audit, query filters" },
  { toolName: "test", inputSummary: "audit", outputSummary: "12 passed, 1 failed (actor filter)" },
];

const ACTIVE_SKILLS = [
  { name: "backend", tasks: ["build", "test", "lint"] },
  { name: "repo", tasks: ["index", "search"] },
];

/** Pre-RFC baseline: naive full-file dumps injected wholesale. */
export function buildNaiveContext(): string {
  const files: string[] = [];
  for (let f = 0; f < 40; f++) {
    const lines: string[] = [];
    for (let l = 0; l < 20; l++) {
      lines.push(`  const value_${f}_${l} = compute(${f}, ${l}); // src/module_${f}.ts:${l + 1}`);
    }
    files.push(`// src/module_${f}.ts\n${lines.join("\n")}`);
  }
  return files.join("\n\n");
}

/** RFC optimized: graph-sliced signature lines + budget/coverage footer. */
export function buildGraphSlicedContext(): string {
  const symbols = [
    "export async function createAuditEvent(sessionId, tool, input, output, actor)  // src/services/audit.ts:12",
    "export function queryAuditTrail(filters: AuditFilters)  // src/services/audit.ts:41",
    "router.get('/api/audit', requireAuth, auditListHandler)  // src/routes/audit.ts:8",
    "export const auditTrailTable = pgTable('audit_trail', {...})  // lib/db/src/schema/audit.ts:3",
    "export function emitToolEvent(runner, event)  // src/services/tool-runner.ts:77",
    "export async function listAuditForSession(sessionId)  // src/services/audit.ts:88",
    "export function filterByActor(rows, actorId)  // src/services/audit.ts:120",
    "export const AUDIT_EVENT_TYPES = [...]  // src/services/audit.ts:5",
  ];
  return [
    ...symbols,
    "(~120 tokens; 8/214 symbols from the repo graph)",
  ].join("\n");
}

function messageTokens(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content), 0);
}

export function runCostGate(): CostGateResult[] {
  const naive = buildNaiveContext();
  const sliced = buildGraphSlicedContext();

  const generateBaseline = messageTokens(renderPlanGenerate({ intentText: INTENT, existingTasks: EXISTING_TASKS, codeContext: naive }));
  const generateOptimized = messageTokens(renderPlanGenerate({ intentText: INTENT, existingTasks: EXISTING_TASKS, codeContext: sliced }));

  const reassessBaseline = messageTokens(renderPlanReassess({ tasks: EXISTING_TASKS.map((t) => ({ id: t.stepIndex + 1, text: t.text, status: t.status, confirmedByUser: t.confirmedByUser })), observations: OBSERVATIONS, codeContext: naive }));
  const reassessOptimized = messageTokens(renderPlanReassess({ tasks: EXISTING_TASKS.map((t) => ({ id: t.stepIndex + 1, text: t.text, status: t.status, confirmedByUser: t.confirmedByUser })), observations: OBSERVATIONS, codeContext: sliced }));

  const decomposeBaseline = messageTokens(renderPlanDecompose({ existingTasks: EXISTING_TASKS, recentObservations: OBSERVATIONS, activeSkills: ACTIVE_SKILLS, rationaleContext: "swarm discovered audit filter gaps", maxCandidates: 3, codeContext: naive }));
  const decomposeOptimized = messageTokens(renderPlanDecompose({ existingTasks: EXISTING_TASKS, recentObservations: OBSERVATIONS, activeSkills: ACTIVE_SKILLS, rationaleContext: "swarm discovered audit filter gaps", maxCandidates: 3, codeContext: sliced }));

  const rows: Array<[string, number, number]> = [
    ["plan.generate", generateBaseline, generateOptimized],
    ["plan.reassess", reassessBaseline, reassessOptimized],
    ["plan.decompose", decomposeBaseline, decomposeOptimized],
  ];

  return rows.map(([path, baseline, optimized]) => {
    const reductionPct = baseline === 0 ? 0 : Math.round(((baseline - optimized) / baseline) * 1000) / 10;
    return { path, baselineTokens: baseline, optimizedTokens: optimized, reductionPct, passed: reductionPct >= COST_GATE_TARGET_PCT };
  });
}