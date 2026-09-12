/**
 * factory-eval.ts — RFC 0003 Phase 4: factory-scale multi-product A/B eval.
 *
 * Extends RFC 0002's eval harness to factory scale: run a scenario against two
 * factory configurations (differing station counts, WIP limits, resource pool
 * caps, etc.) and compare throughput, cycle time, defect rate, and cost. The
 * factory must not regress single-product correctness.
 *
 * Mirrors lane-eval.ts: a pluggable runner drives the actual factory machinery
 * (dispatch → deliverable → rework → telemetry), and the comparison layer
 * emits a verdict. A default simulator runner is provided that exercises the
 * real MemoryFactoryStore + dispatcher + resource pool.
 */

import type { StationRole } from "@workspace/db";
import { MemoryFactoryStore, type FactoryStore } from "./factory";
import { dispatchWorkOrders, completeWorkOrder, rejectToRework } from "./factory-dispatcher";
import { submitDeliverable } from "./rework-loop";
import { MemoryResourcePool } from "./factory-resource-pool";

// ── Scenario & config ────────────────────────────────────────────────────────

export interface FactoryEvalScenario {
  /** Product name across both arms (two products share the goal). */
  goal: string;
  /** Unique work-order goals dispatched per station. */
  tasks: string[];
  acceptanceCriteria: string[];
}

export interface FactoryEvalConfig {
  /** Human-readable label for the arm (e.g. "single-station", "3-station"). */
  label: string;
  /** Station roles to create (one station per role). */
  stations: Array<{ role: StationRole; wipLimit?: number; capacity?: number }>;
  /** Product WIP limit. */
  wipLimit?: number;
  /** Resource-pool caps: { totalUnits, productCap } for cross-product arbitration. */
  pool?: { totalUnits?: number; productCap?: number };
  /** Expected defect rate (0..1) — injected by the simulator for A/B realism. */
  defectRate?: number;
}

export interface FactoryEvalRunResult {
  wallClockMs: number;
  /** Work orders completed in the run. */
  completed: number;
  /** Completed orders per hour. */
  throughputPerHour: number;
  /** Mean cycle time (dispatch → done), ms. */
  avgCycleTimeMs: number;
  /** Pixel-level defect rate: rejected deliverables / total submitted. */
  defectRate: number;
  /** Rework cycles per completed order. */
  reworkPerCompleted: number;
  /** Est. cost (usd) — placeholder wired to RFC 0001 ledger. */
  costUsd: number;
  /** Correctness (0..1) or null when unjudged. */
  correctness: number | null;
}

export interface FactoryEvalRun {
  config: FactoryEvalConfig;
  result: FactoryEvalRunResult;
}

export interface FactoryEvalComparison {
  scenario: FactoryEvalScenario;
  armA: FactoryEvalRun;
  armB: FactoryEvalRun;
  /** Deltas = armB − armA. */
  deltas: {
    throughputPerHour: number;
    avgCycleTimeMs: number;
    defectRate: number;
    reworkPerCompleted: number;
    costUsd: number;
    correctness: number | null;
  };
  verdict: "config_a_wins" | "config_b_wins" | "tie" | "inconclusive";
}

export type FactoryEvalRunner = (
  scenario: FactoryEvalScenario,
  config: FactoryEvalConfig,
  sim?: SimulatorOptions,
) => Promise<FactoryEvalRunResult>;

// ── Comparison ───────────────────────────────────────────────────────────────

const CORRECTNESS_TOLERANCE = -0.05;
const DEFECT_TOLERANCE = 0.05;

/**
 * Compare the two factory arms. config B wins when it has higher throughput
 * (or equal) without regressing correctness (when judged) or defect rate.
 * Faster-but-worse outcomes (correctness or defect regression) are
 * inconclusive rather than a win, matching lane-eval's verdict semantics.
 */
export function compareFactoryEval(
  scenario: FactoryEvalScenario,
  armA: FactoryEvalRun,
  armB: FactoryEvalRun,
): FactoryEvalComparison {
  const deltas = {
    throughputPerHour: armB.result.throughputPerHour - armA.result.throughputPerHour,
    avgCycleTimeMs: armB.result.avgCycleTimeMs - armA.result.avgCycleTimeMs,
    defectRate: armB.result.defectRate - armA.result.defectRate,
    reworkPerCompleted: armB.result.reworkPerCompleted - armA.result.reworkPerCompleted,
    costUsd: armB.result.costUsd - armA.result.costUsd,
    correctness:
      armA.result.correctness !== null && armB.result.correctness !== null
        ? armB.result.correctness - armA.result.correctness
        : null,
  };

  let verdict: FactoryEvalComparison["verdict"];
  const bSpeedier = deltas.throughputPerHour >= 0;
  const aSpeedier = deltas.throughputPerHour < 0;
  const correctnessOk = deltas.correctness === null || deltas.correctness >= CORRECTNESS_TOLERANCE;
  const defectOk = deltas.defectRate <= DEFECT_TOLERANCE;

  if (bSpeedier && correctnessOk && defectOk) {
    verdict = "config_b_wins";
  } else if (aSpeedier && correctnessOk && defectOk) {
    verdict = "config_a_wins";
  } else if (!correctnessOk || !defectOk) {
    verdict = "inconclusive"; // a winner regressed quality
  } else {
    verdict = "tie";
  }

  return { scenario, armA, armB, deltas, verdict };
}

// ── Default simulator runner ─────────────────────────────────────────────────

export interface RunFactoryEvalOptions {
  scenario: FactoryEvalScenario;
  runner: FactoryEvalRunner;
  configA: FactoryEvalConfig;
  configB: FactoryEvalConfig;
  /** Optional LLM-judged correctness per arm (acceptance-weighted). */
  judge?: (args: { configLabel: string; scenario: FactoryEvalScenario; output: string }) => Promise<number | null>;
  /** Produces the judged output per arm (e.g. rendered diff). */
  armOutput?: (configLabel: string) => Promise<string>;
}

export interface FactoryEvalReport {
  comparison: FactoryEvalComparison;
  judged: boolean;
}

/** Run both arms and compare. */
export async function runFactoryEval(opts: RunFactoryEvalOptions): Promise<FactoryEvalReport> {
  const { scenario, runner, configA, configB } = opts;

  const resultA = await runner(scenario, configA);
  const resultB = await runner(scenario, configB);

  let judged = false;
  let correctnessA: number | null = resultA.correctness;
  let correctnessB: number | null = resultB.correctness;
  if (opts.judge && opts.armOutput) {
    judged = true;
    const [outA, outB] = await Promise.all([
      opts.armOutput(configA.label),
      opts.armOutput(configB.label),
    ]);
    const [scoreA, scoreB] = await Promise.all([
      opts.judge({ configLabel: configA.label, scenario, output: outA }),
      opts.judge({ configLabel: configB.label, scenario, output: outB }),
    ]);
    correctnessA = scoreA ?? correctnessA;
    correctnessB = scoreB ?? correctnessB;
  }

  const armA: FactoryEvalRun = { config: configA, result: { ...resultA, correctness: correctnessA } };
  const armB: FactoryEvalRun = { config: configB, result: { ...resultB, correctness: correctnessB } };

  return {
    comparison: compareFactoryEval(scenario, armA, armB),
    judged,
  };
}

// ── Straight-line factory simulator ─────────────────────────────────────────

export interface SimulatorOptions {
  /** Simulated latency per work order, ms. */
  perTaskMs?: number;
  /** Acceptance-weighted correctness for a completed arm (0..1). */
  correctness?: number | null;
}

/**
 * Deterministic factory-scale simulator. Drives the real dispatcher, resource
 * pool, deliverable contract, and rework loop over a per-station task list:
 *
 *  1. Creates a product + stations (per config) and queues one work order per
 *     task.
 *  2. Cycles dispatch until everything is done or the pool is saturated.
 *  3. Each dispatched order gets a simulated wall-clock cost; a configurable
 *     defectRate forces a rejection → rework → re-dispatch on the next pass.
 *  4. Collates throughput / cycle time / defect / rework / cost telemetry.
 *
 * Cost is estimated from completed work × constant (RFC 0001 ledger is wired
 * separately in factory-telemetry).
 */
export async function simulateFactoryRun(
  scenario: FactoryEvalScenario,
  config: FactoryEvalConfig,
  sim: SimulatorOptions = {},
): Promise<FactoryEvalRunResult> {
  const perTaskMs = sim.perTaskMs ?? 500;
  const correctness = sim.correctness ?? null;
  const defectRate = config.defectRate ?? 0;

  const store: FactoryStore = new MemoryFactoryStore();
  const product = await store.createProduct({
    name: config.label,
    repoUrl: `https://factory.local/eval/${encodeURIComponent(config.label)}.git`,
    wipLimit: config.wipLimit,
  });

  for (const s of config.stations) {
    await store.createStation({ productId: product.id, role: s.role, wipLimit: s.wipLimit, capacity: s.capacity });
  }

  const dispatchedAt = new Map<number, number>();

  for (const task of scenario.tasks) {
    await store.createWorkOrder({ productId: product.id, goal: task });
  }

  const pool = config.pool
    ? new MemoryResourcePool({ totalUnits: config.pool.totalUnits ?? 4, defaultProductCap: config.pool.productCap ?? 2, perProductCaps: {} })
    : null;

  let processed = 0;
  let rejected = 0;
  let reworkCycles = 0;
  const cycleTimes: number[] = [];
  let completedOrderIds = 0;

  // Deterministic RNG so A/B runs are reproducible.
  let seed = config.stations.length * 7919 + Math.round((config.defectRate ?? 0) * 1000);
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  let virtualMs = 0;
  let safety = 0;
  const maxPasses = (scenario.tasks.length + 1) * 16;
  while (safety++ < maxPasses) {
    const { dispatched } = await dispatchWorkOrders(store, product.id, { pool });
    for (const d of dispatched) {
      dispatchedAt.set(d.workOrderId, virtualMs);
    }
    // Work takes perTaskMs of simulated wall-clock time.
    virtualMs += perTaskMs;

    // Settle each active order at this tick.
    const pending = await store.listWorkOrders(product.id, ["dispatched", "in_progress"]);
    if (pending.length === 0 && dispatched.length === 0) break;

    for (const order of pending) {
      processed += 1;
      const fail = rnd() < defectRate;
      if (fail) {
        rejected += 1;
        reworkCycles += 1;
        if (order.assignedStationId != null) {
          await rejectToRework(store, order.id, "eval_defect", pool);
        }
        continue;
      }
      if (order.assignedStationId != null) {
        const station = await store.getStation(order.assignedStationId);
        if (!station) continue;
        const deliverable = {
          workOrderId: order.id,
          stationId: order.assignedStationId,
          diff: `SIMULATED DIFF for ${order.goal}`,
          intentEvents: [`intent:${order.goal}`],
          tests: [{ suite: "sim", passed: 1, failed: 0, status: "pass" as const }],
          verification: [
            { taskName: "compile", taskType: "compile" as const, status: "pass" as const },
            { taskName: "test", taskType: "test" as const, status: "pass" as const },
          ],
          worktreeClean: true,
        };
        const result = await submitDeliverable(store, deliverable, station.role, pool);
        if (result.accepted && result.workOrder) {
          cycleTimes.push(virtualMs - (dispatchedAt.get(order.id) ?? virtualMs));
          completedOrderIds += 1;
        }
      }
    }
  }

  const wallClockMs = virtualMs;
  const completed = completedOrderIds;
  const avgCycleTimeMs = cycleTimes.length > 0 ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : 0;
  const throughputPerHour = completed > 0 ? Math.round((completed / wallClockMs) * 3_600_000 * 100) / 100 : 0;
  const costUsd = Math.round(completed * 0.05 * 100) / 100;
  const submissions = Math.max(1, processed);

  return {
    wallClockMs,
    completed,
    throughputPerHour,
    avgCycleTimeMs: Math.round(avgCycleTimeMs),
    defectRate: Math.round((rejected / submissions) * 1000) / 1000,
    reworkPerCompleted: completed > 0 ? Math.round((reworkCycles / completed) * 100) / 100 : 0,
    costUsd,
    correctness,
  };
}