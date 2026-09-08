/**
 * lane-merge.ts — RFC 0002 Phase 1 (risk-sequenced lane merge queue)
 *
 * Converts the advisory `safe_to_merge` handoff into a real integration
 * guarantee: lanes implement in parallel, landing is serialized and
 * risk-sequenced (smallest/lowest-risk first), skip-not-abort on conflict, and
 * every merge is test-gated (lane-test-gate.ts) with single-merge rollback.
 *
 * The git operations are behind a pluggable GitExecutor so the queue logic is
 * unit-testable without a real repo; the store is pluggable so tests run
 * against memory while production uses the lane_merge_queue table.
 */

import { logger } from "../lib/logger";
import { structuralMergeManifest, type StructuralMergeResult } from "./json-merge";

// ── Git executor ──────────────────────────────────────────────────────────────

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitExecutor {
  /** Resolve the current HEAD sha of a branch. */
  resolveSha(repoPath: string, branch: string): Promise<string | null>;
  /** Commit all changes on the given branch with a message. */
  commitAll(repoPath: string, branch: string, message: string): Promise<boolean>;
  /** Diff stat between two branches (base..head). */
  diffStat(repoPath: string, baseBranch: string, headBranch: string): Promise<DiffStat | null>;
  /**
   * Merge headBranch into baseBranch. Returns "clean" | "conflict" | "error".
   * On "conflict" the working tree is left in the conflicted state so the
   * caller can inspect; on "error" it is aborted.
   */
  merge(repoPath: string, baseBranch: string, headBranch: string): Promise<"clean" | "conflict" | "error">;
  /** Abort an in-progress merge (restore pre-merge state). */
  abortMerge(repoPath: string): Promise<boolean>;
  /** Read a file's content at a branch ref. */
  readFile(repoPath: string, ref: string, filePath: string): Promise<string | null>;
  /** Write a file into the working tree (used to apply a structural merge). */
  writeFile(repoPath: string, filePath: string, content: string): Promise<boolean>;
  /** Stage a specific file. */
  stageFile(repoPath: string, filePath: string): Promise<boolean>;
  /** Continue a merge after conflicts were resolved (git add + commit). */
  finishMerge(repoPath: string, message: string): Promise<boolean>;
  /** List files with unmerged (conflicted) paths after a failed merge. */
  listConflictedFiles(repoPath: string): Promise<string[]>;
}

// ── Risk scoring ──────────────────────────────────────────────────────────────

export interface MergeRiskInput {
  diffSize: number;
  filesChanged: number;
  blastRadiusOverlap: number;
  laneType: string;
}

const LANE_TYPE_RISK: Record<string, number> = {
  ux: 0.2,
  debug: 0.3,
  backend: 0.5,
  review: 0.4,
  general: 0.5,
};

/**
 * Risk score [0, 1] for merge sequencing — lower = merge sooner.
 * Small/low-risk changes land first so the integration branch stays stable.
 */
export function scoreMergeRisk(input: MergeRiskInput): number {
  const diffNorm = Math.min(1, input.diffSize / 2000);
  const filesNorm = Math.min(1, input.filesChanged / 50);
  const blast = Math.min(1, input.blastRadiusOverlap);
  const laneTypeRisk = LANE_TYPE_RISK[input.laneType] ?? 0.5;
  return Math.min(1, diffNorm * 0.4 + filesNorm * 0.2 + blast * 0.3 + laneTypeRisk * 0.1);
}

// ── Store ─────────────────────────────────────────────────────────────────────

export type MergeStatus = "queued" | "merging" | "merged" | "skipped" | "failed";

export interface MergeJob {
  id: number;
  sessionId: number;
  laneId: number;
  handoffId: number | null;
  status: MergeStatus;
  riskScore: number;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  result: Record<string, unknown> | null;
  errorDetails: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface EnqueueMergeParams {
  sessionId: number;
  laneId: number;
  handoffId?: number | null;
  headBranch: string;
  baseBranch: string;
  headSha?: string | null;
  riskScore?: number;
}

export interface MergeQueueStore {
  enqueue(params: EnqueueMergeParams): Promise<MergeJob>;
  list(sessionId: number, statuses?: MergeStatus[]): Promise<MergeJob[]>;
  get(id: number): Promise<MergeJob | null>;
  update(id: number, patch: Partial<MergeJob>): Promise<MergeJob | null>;
}

export class MemoryMergeQueueStore implements MergeQueueStore {
  private nextId = 1;
  private jobs: MergeJob[] = [];

  async enqueue(params: EnqueueMergeParams): Promise<MergeJob> {
    const job: MergeJob = {
      id: this.nextId++,
      sessionId: params.sessionId,
      laneId: params.laneId,
      handoffId: params.handoffId ?? null,
      status: "queued",
      riskScore: params.riskScore ?? 0.5,
      headBranch: params.headBranch,
      baseBranch: params.baseBranch,
      headSha: params.headSha ?? null,
      result: null,
      errorDetails: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };
    this.jobs.push(job);
    return job;
  }

  async list(sessionId: number, statuses?: MergeStatus[]): Promise<MergeJob[]> {
    return this.jobs
      .filter((j) => j.sessionId === sessionId)
      .filter((j) => (statuses ? statuses.includes(j.status) : true))
      .sort((a, b) => a.riskScore - b.riskScore || a.id - b.id);
  }

  async get(id: number): Promise<MergeJob | null> {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  async update(id: number, patch: Partial<MergeJob>): Promise<MergeJob | null> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    Object.assign(job, patch);
    return job;
  }

  clear(): void {
    this.jobs = [];
  }
}

// ── Merge queue service ───────────────────────────────────────────────────────

export interface MergeOutcome {
  jobId: number;
  status: "merged" | "skipped" | "failed";
  reason: string;
  mergedKeys: string[];
  conflicts: Array<{ file: string; block: string; key: string; ours: string; theirs: string }>;
}

export interface TestGate {
  /** Run the session's test command; resolve true when it passes. */
  run(repoPath: string, sessionId: number): Promise<{ passed: boolean; output: string }>;
}

export interface DrainOptions {
  repoPath: string;
  testGate: TestGate;
  /** Structural-merge manifests before falling back to text merge. */
  structuralMerge?: boolean;
}

export class LaneMergeQueue {
  constructor(
    private store: MergeQueueStore,
    private git: GitExecutor,
  ) {}

  async enqueue(params: EnqueueMergeParams): Promise<MergeJob> {
    return this.store.enqueue(params);
  }

  async list(sessionId: number, statuses?: MergeStatus[]): Promise<MergeJob[]> {
    return this.store.list(sessionId, statuses);
  }

  /**
   * Drain the queue in risk order (smallest/lowest-risk first). Each merge is
   * test-gated; a conflict or test failure skips just that lane and continues.
   */
  async drain(sessionId: number, opts: DrainOptions): Promise<MergeOutcome[]> {
    const queued = await this.store.list(sessionId, ["queued"]);
    const outcomes: MergeOutcome[] = [];

    for (const job of queued) {
      const outcome = await this.mergeOne(job, opts);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async mergeOne(job: MergeJob, opts: DrainOptions): Promise<MergeOutcome> {
    await this.store.update(job.id, { status: "merging", startedAt: new Date() });

    try {
      // 1. Auto-commit the lane's uncommitted work.
      const committed = await this.git.commitAll(opts.repoPath, job.headBranch, `[MIZI] lane ${job.laneId} — merge queue`);
      if (!committed) {
        return this.finish(job, "failed", "lane branch could not be committed", {});
      }

      // 2. Attempt the merge (structural first for manifests, then text).
      const mergeResult = await this.mergeWithStructuralFallback(job, opts);

      if (mergeResult === "conflict") {
        await this.git.abortMerge(opts.repoPath);
        return this.finish(job, "skipped", "merge conflict — resumable via resolve", {});
      }
      if (mergeResult === "error") {
        await this.git.abortMerge(opts.repoPath);
        return this.finish(job, "failed", "git merge error", {});
      }

      // 3. Test gate — a failure undoes just this merge.
      const test = await opts.testGate.run(opts.repoPath, job.sessionId);
      if (!test.passed) {
        await this.git.abortMerge(opts.repoPath);
        return this.finish(job, "skipped", `test gate failed: ${test.output.slice(0, 200)}`, {});
      }

      return this.finish(job, "merged", "merged + tests passed", {});
    } catch (err) {
      logger.warn({ err, jobId: job.id }, "[lane-merge] merge attempt threw");
      return this.finish(job, "failed", String(err), {});
    }
  }

  /**
   * Merge head into base. When a manifest file conflicts, attempt a structural
   * union-merge first; only fall back to a text merge when structural fails.
   */
  private async mergeWithStructuralFallback(
    job: MergeJob,
    opts: DrainOptions,
  ): Promise<"clean" | "conflict" | "error"> {
    const result = await this.git.merge(opts.repoPath, job.baseBranch, job.headBranch);
    if (result !== "conflict" || !opts.structuralMerge) return result;

    // A text conflict: try structural merge on each conflicted manifest.
    const conflictedFiles = await this.git.listConflictedFiles(opts.repoPath);
    let resolvedAny = false;
    for (const file of conflictedFiles) {
      const base = await this.git.readFile(opts.repoPath, job.baseBranch, file);
      const incoming = await this.git.readFile(opts.repoPath, job.headBranch, file);
      if (base === null || incoming === null) continue;

      const structural = structuralMergeManifest(file, base, incoming);
      if (structural.status !== "merged") continue;

      // Write the structural merge, stage it, and mark the conflict resolved.
      await this.git.writeFile(opts.repoPath, file, structural.content);
      await this.git.stageFile(opts.repoPath, file);
      resolvedAny = true;
    }

    if (!resolvedAny) return "conflict";

    const finished = await this.git.finishMerge(opts.repoPath, `[MIZI] structural merge of ${conflictedFiles.join(", ")}`);
    return finished ? "clean" : "conflict";
  }

  private async finish(
    job: MergeJob,
    status: "merged" | "skipped" | "failed",
    reason: string,
    result: Record<string, unknown>,
  ): Promise<MergeOutcome> {
    await this.store.update(job.id, {
      status,
      completedAt: new Date(),
      result: { ...result, reason },
      errorDetails: status === "failed" ? reason : null,
    });
    return { jobId: job.id, status, reason, mergedKeys: [], conflicts: [] };
  }
}

// ── Default DB-backed store ──────────────────────────────────────────────────

/**
 * Production store backed by the lane_merge_queue table. Lazy-imports
 * @workspace/db to avoid a static import cycle at module load.
 */
export function createDbMergeQueueStore(): MergeQueueStore {
  return {
    async enqueue(params) {
      const { db, laneMergeQueueTable } = await import("@workspace/db");
      const [job] = await db.insert(laneMergeQueueTable).values({
        sessionId: params.sessionId,
        laneId: params.laneId,
        handoffId: params.handoffId ?? null,
        status: "queued",
        riskScore: params.riskScore ?? 0.5,
        headBranch: params.headBranch,
        baseBranch: params.baseBranch,
        headSha: params.headSha ?? null,
      }).returning();
      return mapDbJob(job);
    },
    async list(sessionId, statuses) {
      const { db, laneMergeQueueTable } = await import("@workspace/db");
      const { eq, inArray, asc } = await import("drizzle-orm");
      let q = db.select().from(laneMergeQueueTable).where(eq(laneMergeQueueTable.sessionId, sessionId)).$dynamic();
      if (statuses && statuses.length > 0) {
        q = q.where(inArray(laneMergeQueueTable.status, statuses));
      }
      const rows = await q.orderBy(asc(laneMergeQueueTable.riskScore), asc(laneMergeQueueTable.id));
      return rows.map(mapDbJob);
    },
    async get(id) {
      const { db, laneMergeQueueTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(laneMergeQueueTable).where(eq(laneMergeQueueTable.id, id));
      return row ? mapDbJob(row) : null;
    },
    async update(id, patch) {
      const { db, laneMergeQueueTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db.update(laneMergeQueueTable)
        .set({
          status: patch.status,
          riskScore: patch.riskScore,
          headSha: patch.headSha,
          result: patch.result as Record<string, unknown> | null | undefined,
          errorDetails: patch.errorDetails,
          startedAt: patch.startedAt,
          completedAt: patch.completedAt,
        })
        .where(eq(laneMergeQueueTable.id, id))
        .returning();
      return row ? mapDbJob(row) : null;
    },
  };
}

function mapDbJob(row: {
  id: number;
  sessionId: number;
  laneId: number;
  handoffId: number | null;
  status: string;
  riskScore: number;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  result: unknown;
  errorDetails: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): MergeJob {
  return {
    id: row.id,
    sessionId: row.sessionId,
    laneId: row.laneId,
    handoffId: row.handoffId,
    status: row.status as MergeStatus,
    riskScore: row.riskScore,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    headSha: row.headSha,
    result: (row.result as Record<string, unknown> | null) ?? null,
    errorDetails: row.errorDetails,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}