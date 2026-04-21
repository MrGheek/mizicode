/**
 * Weighted Fair Heavy-Job Scheduler
 *
 * Schedules GPU-expensive coordination jobs using a weighted fair queue with four inputs:
 *   1. Priority level (caller-supplied, 1-10; higher = more urgent)
 *   2. Job age (prevents indefinite starvation of low-priority background jobs)
 *   3. Per-lane fairness budget (each lane gets equal share over time)
 *   4. Job class floor (background indexing cannot be starved by high-priority debug work)
 *
 * Job classes and floor weights:
 *   indexing: +0.5   — repo graph rebuild, file indexing
 *   embedding: +0.3  — semantic vector embedding
 *   eval: +0.2       — skill eval harnesses
 *   blast_radius: +0.4 — dependency impact analysis
 *   compile: +0.35   — bundle compilation
 *   other: +0.1      — general background work
 */

import { db, laneHeavyJobsTable } from "@workspace/db";
import { eq, and, or, inArray, asc, desc, gt } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { HeavyJobClass, HeavyJobStatus } from "@workspace/db";

const JOB_CLASS_FLOOR_WEIGHT: Record<HeavyJobClass, number> = {
  indexing: 0.5,
  embedding: 0.3,
  eval: 0.2,
  blast_radius: 0.4,
  compile: 0.35,
  other: 0.1,
};

const AGE_WEIGHT_ACCRUAL_PER_MINUTE = 0.05;
const MAX_AGE_WEIGHT = 2.0;

/**
 * Compute the effective scheduling score for a job.
 * Higher score → scheduled sooner.
 *
 * score = priority_norm + ageWeight + laneWeight + classFloor
 *
 * priority_norm: priority / 10 (normalized to [0.1, 1.0])
 * ageWeight: accrued since creation, capped at MAX_AGE_WEIGHT
 * laneWeight: fairness token granted to the lane
 * classFloor: minimum boost for background classes to prevent starvation
 */
function computeEffectiveScore(params: {
  priority: number;
  createdAt: Date;
  laneWeight: number;
  jobClass: HeavyJobClass;
}): number {
  const priorityNorm = Math.max(0.1, Math.min(1.0, params.priority / 10));
  const ageMinutes = (Date.now() - params.createdAt.getTime()) / 60000;
  const ageWeight = Math.min(MAX_AGE_WEIGHT, ageMinutes * AGE_WEIGHT_ACCRUAL_PER_MINUTE);
  const classFloor = JOB_CLASS_FLOOR_WEIGHT[params.jobClass] ?? 0.1;
  return priorityNorm + ageWeight + params.laneWeight + classFloor;
}

export interface EnqueueJobParams {
  sessionId: number;
  laneId?: number;
  jobClass: HeavyJobClass;
  priority?: number;
  laneWeight?: number;
  payload?: Record<string, unknown>;
}

export async function enqueueHeavyJob(params: EnqueueJobParams): Promise<typeof laneHeavyJobsTable.$inferSelect> {
  const priority = params.priority ?? 5;
  const laneWeight = params.laneWeight ?? 1.0;
  const jobClass = params.jobClass;

  const effectiveScore = computeEffectiveScore({
    priority,
    createdAt: new Date(),
    laneWeight,
    jobClass,
  });

  const [job] = await db.insert(laneHeavyJobsTable).values({
    sessionId: params.sessionId,
    laneId: params.laneId ?? null,
    jobClass,
    status: "queued",
    priority,
    ageWeight: 0,
    laneWeight,
    effectiveScore,
    payload: params.payload as Record<string, unknown> | undefined,
  }).returning();

  logger.info({ jobId: job.id, sessionId: params.sessionId, jobClass, priority, effectiveScore }, "Heavy job enqueued");
  return job;
}

const FAIRNESS_WINDOW_MINUTES = 60; // Sliding window for fairness budgeting
const FAIRNESS_MAX_WEIGHT = 2.0;    // Underrepresented lanes get up to 2× boost
const FAIRNESS_MIN_WEIGHT = 0.5;    // Overrepresented lanes get down to 0.5× weight

/**
 * Compute dynamic fairness weights for each lane based on their recent job run-share.
 *
 * Lanes that have executed fewer jobs than their fair share over the last hour get a
 * higher weight (boosted toward front of queue). Lanes that have executed more get a
 * lower weight (backpressure). This prevents any single lane from monopolizing the GPU.
 *
 * weight = clamp(2.0 - laneShareRatio, FAIRNESS_MIN_WEIGHT, FAIRNESS_MAX_WEIGHT)
 * where laneShareRatio = laneCompletedJobs / fairShare, fairShare = totalJobs / numLanes
 */
async function computeLaneFairnessWeights(
  sessionId: number,
  laneIds: number[],
): Promise<Map<number, number>> {
  if (laneIds.length === 0) return new Map();

  const windowStart = new Date(Date.now() - FAIRNESS_WINDOW_MINUTES * 60 * 1000);

  const recentJobs = await db
    .select({ laneId: laneHeavyJobsTable.laneId })
    .from(laneHeavyJobsTable)
    .where(and(
      eq(laneHeavyJobsTable.sessionId, sessionId),
      inArray(laneHeavyJobsTable.status, ["running", "completed"] as HeavyJobStatus[]),
      gt(laneHeavyJobsTable.createdAt, windowStart),
    ));

  // Count completed/running jobs per lane in the sliding window
  const jobCountsByLane = new Map<number, number>();
  for (const job of recentJobs) {
    if (job.laneId !== null) {
      jobCountsByLane.set(job.laneId, (jobCountsByLane.get(job.laneId) ?? 0) + 1);
    }
  }

  const totalJobs = Array.from(jobCountsByLane.values()).reduce((a, b) => a + b, 0);
  const fairShare = totalJobs > 0 ? totalJobs / laneIds.length : 0;

  const weights = new Map<number, number>();
  for (const laneId of laneIds) {
    const laneJobs = jobCountsByLane.get(laneId) ?? 0;
    const shareRatio = fairShare > 0 ? laneJobs / fairShare : 1.0;
    // Lanes with fewer jobs than fair share get weight > 1.0, more get < 1.0
    const weight = Math.max(FAIRNESS_MIN_WEIGHT, Math.min(FAIRNESS_MAX_WEIGHT, 2.0 - shareRatio));
    weights.set(laneId, weight);
  }
  return weights;
}

/**
 * Refresh age-based weights and per-lane fairness budgets for all queued jobs in a session.
 * Called before listing jobs or picking the next job.
 */
export async function refreshJobWeights(sessionId: number): Promise<void> {
  const queuedJobs = await db
    .select()
    .from(laneHeavyJobsTable)
    .where(and(
      eq(laneHeavyJobsTable.sessionId, sessionId),
      eq(laneHeavyJobsTable.status, "queued"),
    ));

  if (queuedJobs.length === 0) return;

  // Collect all distinct lane IDs for fairness computation
  const allLaneIds = [...new Set(
    queuedJobs.map(j => j.laneId).filter((id): id is number => id !== null),
  )];

  const fairnessWeights = await computeLaneFairnessWeights(sessionId, allLaneIds);

  for (const job of queuedJobs) {
    const newAgeWeight = Math.min(
      MAX_AGE_WEIGHT,
      (Date.now() - job.createdAt.getTime()) / 60000 * AGE_WEIGHT_ACCRUAL_PER_MINUTE,
    );
    const updatedLaneWeight = job.laneId !== null
      ? (fairnessWeights.get(job.laneId) ?? job.laneWeight)
      : job.laneWeight;
    const newScore = computeEffectiveScore({
      priority: job.priority,
      createdAt: job.createdAt,
      laneWeight: updatedLaneWeight,
      jobClass: job.jobClass as HeavyJobClass,
    });
    await db.update(laneHeavyJobsTable)
      .set({ ageWeight: newAgeWeight, laneWeight: updatedLaneWeight, effectiveScore: newScore })
      .where(eq(laneHeavyJobsTable.id, job.id));
  }
}

/**
 * Get the next job to run for a session (highest effective score among queued jobs).
 */
export async function getNextJob(sessionId: number): Promise<typeof laneHeavyJobsTable.$inferSelect | null> {
  await refreshJobWeights(sessionId);

  const jobs = await db
    .select()
    .from(laneHeavyJobsTable)
    .where(and(
      eq(laneHeavyJobsTable.sessionId, sessionId),
      eq(laneHeavyJobsTable.status, "queued"),
    ))
    .orderBy(asc(laneHeavyJobsTable.effectiveScore));

  return jobs[jobs.length - 1] ?? null;
}

export async function markJobRunning(jobId: number): Promise<void> {
  await db.update(laneHeavyJobsTable)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(laneHeavyJobsTable.id, jobId));
}

export async function markJobCompleted(jobId: number, result?: Record<string, unknown>): Promise<void> {
  await db.update(laneHeavyJobsTable)
    .set({ status: "completed", completedAt: new Date(), result: result ?? null })
    .where(eq(laneHeavyJobsTable.id, jobId));
}

export async function markJobFailed(jobId: number, errorDetails: string): Promise<void> {
  await db.update(laneHeavyJobsTable)
    .set({ status: "failed", completedAt: new Date(), errorDetails })
    .where(eq(laneHeavyJobsTable.id, jobId));
}

export async function markJobDeferred(jobId: number, deferUntil: Date): Promise<void> {
  await db.update(laneHeavyJobsTable)
    .set({ status: "deferred", deferredUntil: deferUntil })
    .where(eq(laneHeavyJobsTable.id, jobId));
}

export async function listHeavyJobs(sessionId: number, statusFilter?: HeavyJobStatus[]) {
  // Queued jobs are ordered by effectiveScore DESC (highest-priority first).
  // Non-queued jobs (running/completed/failed/deferred) are ordered by createdAt DESC.
  let query = db.select().from(laneHeavyJobsTable)
    .where(eq(laneHeavyJobsTable.sessionId, sessionId))
    .$dynamic();

  if (statusFilter && statusFilter.length > 0) {
    query = query.where(inArray(laneHeavyJobsTable.status, statusFilter));
  }

  // Score-descending: highest effective score (= highest scheduler priority) first.
  // This makes the queue view reflect actual execution order.
  return query.orderBy(desc(laneHeavyJobsTable.effectiveScore));
}

/**
 * Peek at the next job to run without dequeuing it.
 * Useful for external orchestrators to poll for work.
 */
export async function peekNextJob(sessionId: number): Promise<typeof laneHeavyJobsTable.$inferSelect | null> {
  await refreshJobWeights(sessionId);
  return getNextJob(sessionId);
}
