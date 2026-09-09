/**
 * lane-eval.ts — RFC 0002 Phase 4 (lane-system evaluation harness)
 *
 * A/B harness that proves the lane system beats single-agent development:
 * the same goal is executed once by a single agent and once by N parallel
 * lanes, then scored on correctness, merge cleanliness, and wall-clock.
 *
 * The scenario runner is pluggable so the harness is unit-testable without
 * real agents or a real repo. In production the runner drives the existing
 * orchestrate → lane → merge-queue pipeline.
 *
 * Scoring reuses the RFC 0002 merge machinery's own signals (conflicts,
 * structural merges, test-gate passes) plus an optional LLM-as-judge
 * correctness score.
 */

import { logger } from "../lib/logger";

// ── Scenario model ──────────────────────────────────────────────────────────

export interface LaneEvalScenario {
  /** Human-readable goal, e.g. "Add OAuth + billing + dashboard nav". */
  goal: string;
  /** Independent sub-tasks, one per lane in the multi-lane arm. */
  tasks: string[];
  /** Acceptance criteria the judge checks. */
  acceptanceCriteria: string[];
}

export interface LaneEvalRunResult {
  /** Wall-clock ms for the whole arm. */
  wallClockMs: number;
  /** True when the arm's test gate passed at the end. */
  testsPassed: boolean;
  /** Merge conflicts encountered (0 = clean). */
  mergeConflicts: number;
  /** Files resolved via structural merge (0 = none). */
  structuralMerges: number;
  /** Correctness score [0,1] from the judge (null when not judged). */
  correctness: number | null;
  /** Number of lanes used (1 = single-agent arm). */
  laneCount: number;
}

export interface LaneEvalComparison {
  scenario: LaneEvalScenario;
  singleAgent: LaneEvalRunResult;
  multiLane: LaneEvalRunResult;
  /** Multi-lane vs single-agent deltas. */
  deltas: {
    wallClockMs: number;
    mergeConflicts: number;
    structuralMerges: number;
    correctness: number | null;
  };
  /** True when multi-lane wins on wall-clock without regressing correctness. */
  verdict: "multi_lane_wins" | "single_agent_wins" | "tie" | "inconclusive";
}

// ── Pluggable runner ─────────────────────────────────────────────────────────

export interface LaneEvalRunner {
  /**
   * Run a scenario with the given lane count. laneCount === 1 means the
   * single-agent arm; > 1 means that many parallel lanes.
   */
  run(scenario: LaneEvalScenario, laneCount: number): Promise<LaneEvalRunResult>;
}

// ── Comparison ───────────────────────────────────────────────────────────────

/**
 * Compare the two arms of an A/B run. Multi-lane wins when it is faster
 * (or equal) AND does not regress correctness (when judged) AND does not add
 * merge conflicts beyond a small tolerance.
 */
export function compareLaneEval(
  scenario: LaneEvalScenario,
  singleAgent: LaneEvalRunResult,
  multiLane: LaneEvalRunResult,
): LaneEvalComparison {
  const deltas = {
    wallClockMs: multiLane.wallClockMs - singleAgent.wallClockMs,
    mergeConflicts: multiLane.mergeConflicts - singleAgent.mergeConflicts,
    structuralMerges: multiLane.structuralMerges - singleAgent.structuralMerges,
    correctness: multiLane.correctness !== null && singleAgent.correctness !== null
      ? multiLane.correctness - singleAgent.correctness
      : null,
  };

  let verdict: LaneEvalComparison["verdict"];
  const faster = deltas.wallClockMs < 0;
  const slower = deltas.wallClockMs > 0;
  const correctnessOk = deltas.correctness === null || deltas.correctness >= -0.05;
  const conflictsOk = deltas.mergeConflicts <= 1;

  if (faster && correctnessOk && conflictsOk) {
    verdict = "multi_lane_wins";
  } else if (slower && correctnessOk) {
    verdict = "single_agent_wins";
  } else if (faster && !correctnessOk) {
    verdict = "inconclusive"; // faster but correctness regressed
  } else {
    verdict = "tie";
  }

  return { scenario, singleAgent, multiLane, deltas, verdict };
}

// ── LLM-as-judge correctness ─────────────────────────────────────────────────

export type CorrectnessJudge = (args: {
  goal: string;
  acceptanceCriteria: string[];
  output: string;
}) => Promise<{ score: number; summary: string }>;

/**
 * Default judge: routes through the shared callLlm client so prompt versioning
 * and the RFC 0001 budget/ledger apply uniformly.
 */
export function createDefaultCorrectnessJudge(): CorrectnessJudge {
  return async ({ goal, acceptanceCriteria, output }) => {
    const { callLlm } = await import("./llm-client");
    const raw = await callLlm({
      messages: [
        { role: "system", content: "You are a strict code-review judge. Score how completely the delivered work satisfies the acceptance criteria. Return ONLY a JSON object: {\"score\": 0.0-1.0, \"summary\": \"1 sentence\"}." },
        {
          role: "user",
          content: [
            `Goal: ${goal}`,
            `Acceptance criteria:\n${acceptanceCriteria.map((c) => `  - ${c}`).join("\n")}`,
            `Delivered work:\n${output.slice(0, 4000)}`,
          ].join("\n"),
        },
      ],
      temperature: 0,
      max_tokens: 200,
      promptVersion: "lane.eval.judge@1.0.0",
      logTag: "lane.eval.judge",
      budget: { taskClass: "plan-reassess" },
    });
    if (!raw) return { score: 0.5, summary: "judge unavailable" };
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { score: 0.5, summary: "judge returned malformed output" };
    try {
      const parsed = JSON.parse(json) as { score?: number; summary?: string };
      const score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0.5;
      return { score, summary: typeof parsed.summary === "string" ? parsed.summary : "" };
    } catch {
      return { score: 0.5, summary: "judge returned malformed output" };
    }
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface RunLaneEvalOptions {
  scenario: LaneEvalScenario;
  runner: LaneEvalRunner;
  /** Judge correctness for both arms (optional). */
  judge?: CorrectnessJudge;
  /** Judge output for each arm (e.g. the merged diff). */
  armOutput?: (laneCount: number) => Promise<string>;
}

export interface LaneEvalReport {
  comparison: LaneEvalComparison;
  judged: boolean;
}

/**
 * Run the full A/B: single-agent arm, then multi-lane arm, then compare.
 */
export async function runLaneEval(opts: RunLaneEvalOptions): Promise<LaneEvalReport> {
  const { scenario, runner } = opts;

  const singleAgent = await runner.run(scenario, 1);
  const multiLane = await runner.run(scenario, Math.max(2, scenario.tasks.length));

  // Judge correctness when a judge + arm output are provided.
  if (opts.judge && opts.armOutput) {
    const [saOut, mlOut] = await Promise.all([opts.armOutput(1), opts.armOutput(scenario.tasks.length)]);
    const [saJudge, mlJudge] = await Promise.all([
      opts.judge({ goal: scenario.goal, acceptanceCriteria: scenario.acceptanceCriteria, output: saOut }),
      opts.judge({ goal: scenario.goal, acceptanceCriteria: scenario.acceptanceCriteria, output: mlOut }),
    ]);
    singleAgent.correctness = saJudge.score;
    multiLane.correctness = mlJudge.score;
  }

  const comparison = compareLaneEval(scenario, singleAgent, multiLane);
  logger.info({ verdict: comparison.verdict, deltas: comparison.deltas }, "[lane-eval] A/B run complete");
  return { comparison, judged: !!opts.judge };
}