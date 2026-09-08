import { beforeEach, describe, expect, it } from "vitest";
import {
  LaneMergeQueue,
  MemoryMergeQueueStore,
  scoreMergeRisk,
  type GitExecutor,
  type MergeJob,
} from "../services/lane-merge";
import { LaneTestGate, resolveTestCommand } from "../services/lane-test-gate";

// ── Fake git executor ─────────────────────────────────────────────────────────

class FakeGit implements GitExecutor {
  calls: string[] = [];
  mergeResult: "clean" | "conflict" | "error" = "clean";
  commitOk = true;
  structuralFiles: Array<{ file: string; base: string; incoming: string }> = [];
  conflictedFiles: string[] = [];

  async resolveSha(_repoPath: string, branch: string): Promise<string | null> {
    this.calls.push(`resolveSha:${branch}`);
    return `sha-${branch}`;
  }
  async commitAll(_repoPath: string, branch: string, _message: string): Promise<boolean> {
    this.calls.push(`commitAll:${branch}`);
    return this.commitOk;
  }
  async diffStat(_repoPath: string, base: string, head: string) {
    this.calls.push(`diffStat:${base}..${head}`);
    return { filesChanged: 2, insertions: 10, deletions: 2 };
  }
  async merge(_repoPath: string, base: string, head: string): Promise<"clean" | "conflict" | "error"> {
    this.calls.push(`merge:${base}<-${head}`);
    return this.mergeResult;
  }
  async abortMerge(_repoPath: string): Promise<boolean> {
    this.calls.push("abortMerge");
    return true;
  }
  async readFile(_repoPath: string, ref: string, filePath: string): Promise<string | null> {
    const f = this.structuralFiles.find((s) => s.file === filePath);
    if (!f) return null;
    return ref === "base" ? f.base : f.incoming;
  }
  async writeFile(_repoPath: string, _filePath: string, _content: string): Promise<boolean> {
    this.calls.push("writeFile");
    return true;
  }
  async stageFile(_repoPath: string, _filePath: string): Promise<boolean> {
    this.calls.push("stageFile");
    return true;
  }
  async finishMerge(_repoPath: string, _message: string): Promise<boolean> {
    this.calls.push("finishMerge");
    return true;
  }
  async listConflictedFiles(_repoPath: string): Promise<string[]> {
    return this.conflictedFiles;
  }
}

function makeQueue(git: FakeGit) {
  const store = new MemoryMergeQueueStore();
  const queue = new LaneMergeQueue(store, git);
  return { store, queue };
}

async function enqueueTwo(queue: LaneMergeQueue, store: MemoryMergeQueueStore) {
  await queue.enqueue({ sessionId: 1, laneId: 1, headBranch: "mizi/session-1/a", baseBranch: "mizi/session-1", riskScore: 0.2 });
  await queue.enqueue({ sessionId: 1, laneId: 2, headBranch: "mizi/session-1/b", baseBranch: "mizi/session-1", riskScore: 0.8 });
  return store.list(1);
}

const passingGate = { run: async () => ({ passed: true, output: "ok" }) };
const failingGate = { run: async () => ({ passed: false, output: "1 test failed" }) };

describe("scoreMergeRisk", () => {
  it("scores small low-risk changes lower than large high-risk ones", () => {
    const small = scoreMergeRisk({ diffSize: 10, filesChanged: 1, blastRadiusOverlap: 0, laneType: "ux" });
    const large = scoreMergeRisk({ diffSize: 5000, filesChanged: 40, blastRadiusOverlap: 0.9, laneType: "backend" });
    expect(small).toBeLessThan(large);
    expect(small).toBeGreaterThanOrEqual(0);
    expect(large).toBeLessThanOrEqual(1);
  });
});

describe("LaneMergeQueue", () => {
  beforeEach(() => {
    // fresh store per test
  });

  it("drains in risk order (small/low-risk first)", async () => {
    const git = new FakeGit();
    const { store, queue } = makeQueue(git);
    const jobs = await enqueueTwo(queue, store);
    expect(jobs.map((j) => j.riskScore)).toEqual([0.2, 0.8]);

    const outcomes = await queue.drain(1, { repoPath: "/repo", testGate: passingGate });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === "merged")).toBe(true);
    // Lane 1 (low risk) merged before lane 2.
    const mergeCalls = git.calls.filter((c) => c.startsWith("merge:"));
    expect(mergeCalls[0]).toContain("mizi/session-1/a");
    expect(mergeCalls[1]).toContain("mizi/session-1/b");
  });

  it("skip-not-abort on conflict — one conflicting lane never blocks the batch", async () => {
    const git = new FakeGit();
    git.mergeResult = "conflict";
    const { store, queue } = makeQueue(git);
    await enqueueTwo(queue, store);

    const outcomes = await queue.drain(1, { repoPath: "/repo", testGate: passingGate });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === "skipped")).toBe(true);
    expect(outcomes[0]!.reason).toContain("conflict");
    // Both lanes were attempted (skip-not-abort).
    expect(git.calls.filter((c) => c.startsWith("merge:")).length).toBe(2);
    // Abort was called after each conflict.
    expect(git.calls.filter((c) => c === "abortMerge").length).toBe(2);
  });

  it("test gate failure undoes just that merge and skips the lane", async () => {
    const git = new FakeGit();
    const { store, queue } = makeQueue(git);
    await enqueueTwo(queue, store);

    const outcomes = await queue.drain(1, { repoPath: "/repo", testGate: failingGate });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === "skipped")).toBe(true);
    expect(outcomes[0]!.reason).toContain("test gate failed");
    // Abort was called after each failed test gate (single-merge rollback).
    expect(git.calls.filter((c) => c === "abortMerge").length).toBe(2);
  });

  it("marks a lane failed when the branch cannot be committed", async () => {
    const git = new FakeGit();
    git.commitOk = false;
    const { store, queue } = makeQueue(git);
    await enqueueTwo(queue, store);

    const outcomes = await queue.drain(1, { repoPath: "/repo", testGate: passingGate });
    expect(outcomes.every((o) => o.status === "failed")).toBe(true);
    expect(outcomes[0]!.reason).toContain("could not be committed");
  });

  it("applies a structural merge when a manifest conflicts, then finishes clean", async () => {
    const git = new FakeGit();
    git.mergeResult = "conflict";
    git.conflictedFiles = ["package.json"];
    git.structuralFiles = [{
      file: "package.json",
      base: JSON.stringify({ dependencies: { a: "1" } }, null, 2),
      incoming: JSON.stringify({ dependencies: { a: "1", b: "2" } }, null, 2),
    }];
    const { store, queue } = makeQueue(git);
    await enqueueTwo(queue, store);

    const outcomes = await queue.drain(1, { repoPath: "/repo", testGate: passingGate, structuralMerge: true });
    expect(outcomes[0]!.status).toBe("merged");
    expect(git.calls).toContain("writeFile");
    expect(git.calls).toContain("stageFile");
    expect(git.calls).toContain("finishMerge");
  });

  it("falls back to skip when structural merge cannot resolve the conflict", async () => {
    const git = new FakeGit();
    git.mergeResult = "conflict";
    git.conflictedFiles = ["src/index.ts"]; // not a manifest → no structural merge
    const { store, queue } = makeQueue(git);
    await enqueueTwo(queue, store);

    const outcomes = await queue.drain(1, { repoPath: "/repo", testGate: passingGate, structuralMerge: true });
    expect(outcomes[0]!.status).toBe("skipped");
    expect(git.calls).not.toContain("writeFile");
  });

  it("resolve retries a skipped job and can succeed on the second attempt", async () => {
    const git = new FakeGit();
    const { store, queue } = makeQueue(git);
    await enqueueTwo(queue, store);

    // First drain: conflict → skipped.
    git.mergeResult = "conflict";
    const first = await queue.drain(1, { repoPath: "/repo", testGate: passingGate });
    expect(first[0]!.status).toBe("skipped");

    // Operator fixes the underlying disagreement; resolve retries → clean.
    git.mergeResult = "clean";
    const jobs = await store.list(1);
    const outcome = await queue.resolve(jobs[0]!.id, { repoPath: "/repo", testGate: passingGate });
    expect(outcome.status).toBe("merged");
    expect(outcome.reason).toContain("tests passed");
  });

  it("resolve refuses jobs that are not skipped/failed", async () => {
    const git = new FakeGit();
    const { store, queue } = makeQueue(git);
    await enqueueTwo(queue, store);
    const jobs = await store.list(1);

    const outcome = await queue.resolve(jobs[0]!.id, { repoPath: "/repo", testGate: passingGate });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("only skipped/failed");
  });

  it("resolve reports a missing job", async () => {
    const git = new FakeGit();
    const { queue } = makeQueue(git);
    const outcome = await queue.resolve(999, { repoPath: "/repo", testGate: passingGate });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("not found");
  });
});

describe("LaneTestGate", () => {
  it("passes when the command exits 0", async () => {
    const gate = new LaneTestGate({ command: "npm", args: ["test"], runner: () => ({ status: 0, stdout: "ok", stderr: "" }) });
    const r = await gate.run("/repo", 1);
    expect(r.passed).toBe(true);
  });

  it("fails when the command exits non-zero", async () => {
    const gate = new LaneTestGate({ command: "npm", args: ["test"], runner: () => ({ status: 1, stdout: "", stderr: "1 failed" }) });
    const r = await gate.run("/repo", 1);
    expect(r.passed).toBe(false);
    expect(r.output).toContain("1 failed");
  });

  it("resolves the test command from env", () => {
    const prev = process.env["MIZI_TEST_COMMAND"];
    process.env["MIZI_TEST_COMMAND"] = "pnpm run test:unit";
    try {
      const opts = resolveTestCommand(1);
      expect(opts.command).toBe("pnpm");
      expect(opts.args).toEqual(["run", "test:unit"]);
    } finally {
      if (prev === undefined) delete process.env["MIZI_TEST_COMMAND"];
      else process.env["MIZI_TEST_COMMAND"] = prev;
    }
  });
});