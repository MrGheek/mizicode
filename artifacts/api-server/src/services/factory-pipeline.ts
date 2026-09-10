/**
 * factory-pipeline.ts — RFC 0003 Phase 3: continuous build → test → stage →
 * ship pipeline per product.
 *
 * The RFC 0002 merge queue feeds a pipeline that runs continuously per product
 * (not per session). Each stage has a quality gate. Staged artifacts are the
 * product's shippable state; ship is gated on the product's quality_gate_config.
 *
 * The pipeline is triggered when a work order completes. It advances through
 * stages in sequence; a failed gate halts the pipeline at that stage.
 */

import { logger } from "../lib/logger";
import type { Product, PipelineRun, PipelineStage, PipelineStatus } from "@workspace/db";
import type { FactoryStore } from "./factory";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StageGate {
  /** Whether this stage has a required gate. */
  required: boolean;
  /** Which checks must pass (task types: compile, test, lint, typecheck). */
  checks: string[];
}

export interface PipelineConfig {
  /** Ordered list of stages (default: build → test → stage → ship). */
  stages: PipelineStage[];
  /** Quality gates per stage. */
  gates: Record<PipelineStage, StageGate>;
}

export interface Artifact {
  name: string;
  url: string;
  hash: string;
}

export interface StageEvidence {
  taskType: string;
  status: "pass" | "fail";
  detail?: string;
}

export interface PipelineStageResult {
  stage: PipelineStage;
  status: "passed" | "failed";
  artifacts: Artifact[];
  evidence: StageEvidence[];
}

export interface PipelineAdvanceResult {
  /** The run that was just completed. */
  completedRun: PipelineRun;
  /** The next stage run (null if pipeline is done or halted on failure). */
  nextRun: PipelineRun | null;
  /** Whether the pipeline is complete (all stages passed). */
  complete: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_PIPELINE_STAGES: PipelineStage[] = ["build", "test", "stage", "ship"];

export const DEFAULT_STAGE_GATES: Record<PipelineStage, StageGate> = {
  build: { required: true, checks: ["compile"] },
  test: { required: true, checks: ["test"] },
  stage: { required: false, checks: [] },
  ship: { required: true, checks: ["lint", "typecheck"] },
};

// ── Gate logic ───────────────────────────────────────────────────────────────

/**
 * Check whether a stage gate passes given the verification evidence.
 *
 * Returns passed + detail. A stage with `required: false` always passes.
 */
export function checkStageGate(
  stage: PipelineStage,
  evidence: StageEvidence[],
  gates: Record<PipelineStage, StageGate> = DEFAULT_STAGE_GATES,
): { passed: boolean; detail: string } {
  const gate = gates[stage];
  if (!gate || !gate.required) {
    return { passed: true, detail: "no gate required" };
  }

  for (const check of gate.checks) {
    const ev = evidence.find((e) => e.taskType === check);
    if (!ev) {
      return { passed: false, detail: `missing ${check} evidence` };
    }
    if (ev.status === "fail") {
      return { passed: false, detail: `${check} failed${ev.detail ? `: ${ev.detail}` : ""}` };
    }
  }

  return { passed: true, detail: "all checks passed" };
}

// ── Pipeline lifecycle ───────────────────────────────────────────────────────

/**
 * Get the pipeline config for a product, falling back to defaults.
 */
function resolveConfig(product: Product): PipelineConfig {
  const raw = product.pipelineConfig as Partial<PipelineConfig> | null;
  return {
    stages: raw?.stages ?? DEFAULT_PIPELINE_STAGES,
    gates: { ...DEFAULT_STAGE_GATES, ...(raw?.gates ?? {}) },
  };
}

/**
 * Trigger a new pipeline run for a product after a work order completes.
 *
 * Creates a pipeline run at the first stage. If the product has no pipeline
 * config, the default (build → test → stage → ship) is used.
 */
export async function triggerPipeline(
  store: FactoryStore,
  productId: number,
  triggerWorkOrderId: number,
): Promise<PipelineRun> {
  const product = await store.getProduct(productId);
  if (!product) throw new Error(`Product ${productId} not found`);

  const config = resolveConfig(product);
  const firstStage = config.stages[0] ?? "build";

  const run = await store.createPipelineRun({
    productId,
    triggerWorkOrderId,
    stage: firstStage,
  });

  logger.info(
    { productId, pipelineRunId: run.id, stage: firstStage, triggerWorkOrderId },
    "[factory-pipeline] triggered",
  );
  return run;
}

/**
 * Complete the current pipeline stage and advance to the next one.
 *
 * If the stage passes, the next stage run is created. If it fails, the
 * pipeline halts. Returns the completed run and the next run (if any).
 */
export async function advancePipeline(
  store: FactoryStore,
  runId: number,
  result: PipelineStageResult,
): Promise<PipelineAdvanceResult> {
  const run = await store.getPipelineRun(runId);
  if (!run) throw new Error(`Pipeline run ${runId} not found`);

  const product = await store.getProduct(run.productId);
  if (!product) throw new Error(`Product ${run.productId} not found`);

  const config = resolveConfig(product);
  const gate = checkStageGate(run.stage, result.evidence, config.gates);

  const status: PipelineStatus = result.status === "passed" && gate.passed ? "passed" : "failed";

  // Update the current run.
  await store.updatePipelineRun(runId, {
    status,
    artifactsJson: result.artifacts.length > 0 ? result.artifacts : null,
    gatePassed: gate.passed,
    gateDetail: gate.detail,
    completedAt: new Date(),
  });

  logger.info(
    { pipelineRunId: runId, stage: run.stage, status, gatePassed: gate.passed },
    "[factory-pipeline] stage completed",
  );

  const updatedRun = (await store.getPipelineRun(runId))!;

  // If failed, pipeline halts.
  if (status === "failed") {
    return { completedRun: updatedRun, nextRun: null, complete: false };
  }

  // Find the next stage.
  const currentIdx = config.stages.indexOf(run.stage);
  if (currentIdx < 0 || currentIdx >= config.stages.length - 1) {
    // Last stage passed — pipeline complete.
    return { completedRun: updatedRun, nextRun: null, complete: true };
  }

  const nextStage = config.stages[currentIdx + 1]!;
  const nextRun = await store.createPipelineRun({
    productId: run.productId,
    triggerWorkOrderId: run.triggerWorkOrderId,
    stage: nextStage,
  });

  return { completedRun: updatedRun, nextRun, complete: false };
}

/**
 * Get the latest pipeline runs for a product — one per stage, most recent first.
 * Useful for the factory dashboard.
 */
export async function latestPipelineSnapshot(
  store: FactoryStore,
  productId: number,
): Promise<Record<PipelineStage, PipelineRun | null>> {
  const runs = await store.listPipelineRuns(productId);
  const latest: Record<string, PipelineRun> = {};
  for (const run of runs) {
    if (!latest[run.stage] || run.id > latest[run.stage]!.id) {
      latest[run.stage] = run;
    }
  }
  return {
    build: latest["build"] ?? null,
    test: latest["test"] ?? null,
    stage: latest["stage"] ?? null,
    ship: latest["ship"] ?? null,
  };
}
