/**
 * Integration tests for the coordination API endpoints.
 *
 * Tests the full HTTP layer: lanes, claims, handoffs, conflicts, and heavy-jobs.
 * Uses a real PostgreSQL database; test data is isolated by a unique test session
 * and cleaned up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import app from "../app";
import { db, gpuProfilesTable, sessionsTable, sessionLanesTable, laneClaimsTable, laneHandoffsTable, laneHeavyJobsTable, claimPurgeLogsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { sweepExpiredClaims, expireStaleClaimsForSession } from "../services/claim-sweeper";
import { LANE_HEARTBEAT_WINDOW_SECONDS } from "../services/lane-policy";

// ─── Test Fixture Setup ────────────────────────────────────────────────────────

let testSessionId: number;
let testProfileId: number;
const TEST_PROFILE_NAME = `test-profile-coordination-${Date.now()}`;

async function cleanupSession(sessionId: number) {
  const lanes = await db
    .select({ id: sessionLanesTable.id })
    .from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId));
  const laneIds = lanes.map((l) => l.id);

  await db.delete(laneHeavyJobsTable).where(eq(laneHeavyJobsTable.sessionId, sessionId));

  if (laneIds.length > 0) {
    await db.delete(laneClaimsTable).where(inArray(laneClaimsTable.laneId, laneIds));
    await db.delete(laneHandoffsTable).where(inArray(laneHandoffsTable.laneId, laneIds));
    await db.delete(sessionLanesTable).where(eq(sessionLanesTable.sessionId, sessionId));
  }
  await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
}

beforeAll(async () => {
  // Create a GPU profile for the test session
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: TEST_PROFILE_NAME,
      displayName: "Test GPU",
      gpuName: "A100",
      numGpus: 1,
      totalVram: 80,
      dockerImageTag: "test:latest",
      defaultQuant: "Q4_K_M",
      quantSizeGb: 10,
      diskSizeGb: 50,
      estimatedSpeedMin: 20,
      estimatedSpeedMax: 40,
      estimatedCostMin: 0.5,
      estimatedCostMax: 1.0,
      searchParams: {},
    })
    .returning();
  testProfileId = profile.id;

  // Create a test session
  const [session] = await db
    .insert(sessionsTable)
    .values({
      profileId: testProfileId,
      status: "ready",
    })
    .returning();
  testSessionId = session.id;
});

afterAll(async () => {
  if (testSessionId) await cleanupSession(testSessionId);
  if (testProfileId) {
    await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, testProfileId));
  }
});

// ─── Lanes ─────────────────────────────────────────────────────────────────────

describe("GET /api/sessions/:id/lanes", () => {
  it("returns empty lanes list for a new session", async () => {
    const res = await request(app).get(`/api/sessions/${testSessionId}/lanes`);
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(testSessionId);
    expect(Array.isArray(res.body.lanes)).toBe(true);
  });

  it("returns 404 for a non-existent session", async () => {
    const res = await request(app).get("/api/sessions/999999999/lanes");
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid session ID", async () => {
    const res = await request(app).get("/api/sessions/not-a-number/lanes");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sessions/:id/lanes", () => {
  it("creates a lane with required fields", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "alice@test.com", laneType: "ux" });

    expect(res.status).toBe(201);
    expect(res.body.memberIdentifier).toBe("alice@test.com");
    expect(res.body.laneType).toBe("ux");
    expect(res.body.status).toBe("active");
    expect(res.body.policy).toBeDefined();
    expect(res.body.claims).toEqual([]);
  });

  it("defaults laneType to 'general' for unknown type", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "bob@test.com", laneType: "unknown-type" });

    expect(res.status).toBe(201);
    expect(res.body.laneType).toBe("general");
  });

  it("returns 400 when memberIdentifier is missing", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ laneType: "backend" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-existent session", async () => {
    const res = await request(app)
      .post("/api/sessions/999999999/lanes")
      .send({ memberIdentifier: "ghost@test.com" });

    expect(res.status).toBe(404);
  });
});

describe("PUT /api/sessions/:id/lanes/:laneId", () => {
  it("updates lane status and currentTask", async () => {
    // Create lane
    const createRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "charlie@test.com", laneType: "backend" });
    const laneId = createRes.body.id;

    const res = await request(app)
      .put(`/api/sessions/${testSessionId}/lanes/${laneId}`)
      .send({ status: "blocked", currentTask: "Fixing auth bug" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("blocked");
    expect(res.body.currentTask).toBe("Fixing auth bug");
  });

  it("returns 404 for non-existent lane", async () => {
    const res = await request(app)
      .put(`/api/sessions/${testSessionId}/lanes/999999999`)
      .send({ status: "blocked" });

    expect(res.status).toBe(404);
  });
});

// ─── Claims ────────────────────────────────────────────────────────────────────

describe("POST /api/sessions/:id/lanes/:laneId/claim + DELETE (release)", () => {
  let laneId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "claimer@test.com", laneType: "backend" });
    laneId = res.body.id;
  });

  it("creates a file claim on a lane", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file", resourcePath: "src/routes/auth.ts", strength: 0.8 });

    expect(res.status).toBe(201);
    expect(res.body.claim.resourcePath).toBe("src/routes/auth.ts");
    expect(res.body.claim.strength).toBeGreaterThan(0);
    expect(res.body.overallRecommendation).toBe("no_conflict");
  });

  it("returns 400 when resourcePath is missing", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file" });

    expect(res.status).toBe(400);
  });

  it("releases a claim via DELETE", async () => {
    const createRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ resourcePath: "src/utils/helpers.ts" });
    const claimId = createRes.body.claim.id;

    const res = await request(app)
      .delete(`/api/sessions/${testSessionId}/lanes/${laneId}/claim/${claimId}`);

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("released");
    expect(res.body.claimId).toBe(claimId);
  });

  it("upserts an existing active claim instead of inserting a duplicate", async () => {
    const resourcePath = "src/services/upsert-test.ts";

    const firstRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file", resourcePath, strength: 0.4 });

    expect(firstRes.status).toBe(201);
    const firstClaimId = firstRes.body.claim.id;

    // Claim the same resource again — should upsert, not insert a new row
    const secondRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file", resourcePath, strength: 0.9 });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.claim.id).toBe(firstClaimId);

    // Verify only one active claim row exists for this lane + resource
    const rows = await db
      .select()
      .from(laneClaimsTable)
      .where(and(
        eq(laneClaimsTable.laneId, laneId),
        eq(laneClaimsTable.pathOrSymbol, resourcePath),
        eq(laneClaimsTable.active, true),
      ));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(firstClaimId);
  });

  it("refreshes claim heartbeat via DELETE?heartbeat=true", async () => {
    const createRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ resourcePath: "src/db/schema.ts" });
    const claimId = createRes.body.claim.id;

    const res = await request(app)
      .delete(`/api/sessions/${testSessionId}/lanes/${laneId}/claim/${claimId}?heartbeat=true`);

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("heartbeat_refreshed");
    expect(res.body.expiresAt).toBeDefined();
  });

  it("preserveHistory=false (default): refreshes existing claim in place", async () => {
    const resourcePath = "src/services/preserve-history-false-test.ts";

    const firstRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file", resourcePath, strength: 0.4, preserveHistory: false });

    expect(firstRes.status).toBe(201);
    const firstClaimId = firstRes.body.claim.id;

    const secondRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file", resourcePath, strength: 0.9, preserveHistory: false });

    expect(secondRes.status).toBe(201);
    // Same row updated in place — ID must be identical
    expect(secondRes.body.claim.id).toBe(firstClaimId);

    // Exactly one active row should exist
    const rows = await db
      .select()
      .from(laneClaimsTable)
      .where(and(
        eq(laneClaimsTable.laneId, laneId),
        eq(laneClaimsTable.pathOrSymbol, resourcePath),
        eq(laneClaimsTable.active, true),
      ));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(firstClaimId);
  });

  it("preserveHistory=true: deactivates old claim and inserts a fresh row", async () => {
    const resourcePath = "src/services/preserve-history-true-test.ts";

    const firstRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file", resourcePath, strength: 0.4 });

    expect(firstRes.status).toBe(201);
    const firstClaimId = firstRes.body.claim.id;

    const secondRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file", resourcePath, strength: 0.9, preserveHistory: true });

    expect(secondRes.status).toBe(201);
    // A brand-new row should have been inserted
    expect(secondRes.body.claim.id).not.toBe(firstClaimId);

    // Only one active row — the new one
    const activeRows = await db
      .select()
      .from(laneClaimsTable)
      .where(and(
        eq(laneClaimsTable.laneId, laneId),
        eq(laneClaimsTable.pathOrSymbol, resourcePath),
        eq(laneClaimsTable.active, true),
      ));
    expect(activeRows.length).toBe(1);
    expect(activeRows[0].id).toBe(secondRes.body.claim.id);

    // The original row still exists but is now inactive (historical record preserved)
    const allRows = await db
      .select()
      .from(laneClaimsTable)
      .where(and(
        eq(laneClaimsTable.laneId, laneId),
        eq(laneClaimsTable.pathOrSymbol, resourcePath),
      ));
    expect(allRows.length).toBe(2);
    const oldRow = allRows.find(r => r.id === firstClaimId);
    expect(oldRow).toBeDefined();
    expect(oldRow!.active).toBe(false);
  });

  it("preserveHistory=true with no prior claim: inserts fresh row normally", async () => {
    const resourcePath = "src/services/preserve-history-no-prior.ts";

    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneId}/claim`)
      .send({ claimType: "file", resourcePath, strength: 0.5, preserveHistory: true });

    expect(res.status).toBe(201);
    expect(res.body.claim.resourcePath).toBe(resourcePath);

    const rows = await db
      .select()
      .from(laneClaimsTable)
      .where(and(
        eq(laneClaimsTable.laneId, laneId),
        eq(laneClaimsTable.pathOrSymbol, resourcePath),
        eq(laneClaimsTable.active, true),
      ));
    expect(rows.length).toBe(1);
  });
});

// ─── Conflict Detection ────────────────────────────────────────────────────────

describe("Conflict detection: two lanes claiming the same file", () => {
  let laneAId: number;
  let laneBId: number;

  beforeAll(async () => {
    const resA = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "conflict-alice@test.com", laneType: "ux" });
    laneAId = resA.body.id;

    const resB = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "conflict-bob@test.com", laneType: "backend" });
    laneBId = resB.body.id;
  });

  it("detects overlap when two lanes claim the exact same file", async () => {
    // Lane A claims the file
    await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneAId}/claim`)
      .send({ resourcePath: "src/shared/config.ts", strength: 0.9 });

    // Lane B claims the same file — should produce a warn or block recommendation
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneBId}/claim`)
      .send({ resourcePath: "src/shared/config.ts", strength: 0.9 });

    expect(res.status).toBe(201);
    expect(res.body.overlaps.length).toBeGreaterThan(0);
    expect(["warn", "block"]).toContain(res.body.overallRecommendation);

    // Verify the overlap references the correct conflicting lane
    const overlap = res.body.overlaps[0];
    expect(overlap.conflictingLaneId).toBe(laneAId);
  });

  it("produces no_conflict when lanes claim different files", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${laneBId}/claim`)
      .send({ resourcePath: "src/backend-only/server.ts", strength: 0.5 });

    expect(res.status).toBe(201);
    expect(res.body.overallRecommendation).toBe("no_conflict");
  });
});

describe("GET /api/sessions/:id/conflicts", () => {
  it("returns a conflicts summary for the session", async () => {
    const res = await request(app).get(`/api/sessions/${testSessionId}/conflicts`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(testSessionId);
    expect(Array.isArray(res.body.conflicts)).toBe(true);
    expect(typeof res.body.totalConflicts).toBe("number");
    expect(typeof res.body.highSeverity).toBe("number");
  });
});

// ─── Handoffs ──────────────────────────────────────────────────────────────────

describe("POST /api/sessions/:id/lanes/:laneId/handoff", () => {
  let handoffLaneId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "handoff-user@test.com", laneType: "review" });
    handoffLaneId = res.body.id;
  });

  it("creates a blocked handoff signal and updates lane status", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${handoffLaneId}/handoff`)
      .send({ handoffType: "blocked", message: "Waiting on API contract" });

    expect(res.status).toBe(201);
    expect(res.body.handoffType).toBe("blocked");
    expect(res.body.message).toBe("Waiting on API contract");

    // Verify lane status was auto-updated to "blocked"
    const laneRes = await request(app).get(`/api/sessions/${testSessionId}/lanes`);
    const lane = laneRes.body.lanes.find((l: { id: number }) => l.id === handoffLaneId);
    expect(lane.status).toBe("blocked");
  });

  it("creates a needs_review handoff and sets lane to review-needed", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${handoffLaneId}/handoff`)
      .send({ handoffType: "needs_review", resourcePaths: ["src/api/auth.ts"] });

    expect(res.status).toBe(201);
    expect(res.body.handoffType).toBe("needs_review");

    const laneRes = await request(app).get(`/api/sessions/${testSessionId}/lanes`);
    const lane = laneRes.body.lanes.find((l: { id: number }) => l.id === handoffLaneId);
    expect(lane.status).toBe("review-needed");
  });

  it("creates a safe_to_merge handoff and sets lane to ready-to-merge", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${handoffLaneId}/handoff`)
      .send({ handoffType: "safe_to_merge" });

    expect(res.status).toBe(201);

    const laneRes = await request(app).get(`/api/sessions/${testSessionId}/lanes`);
    const lane = laneRes.body.lanes.find((l: { id: number }) => l.id === handoffLaneId);
    expect(lane.status).toBe("ready-to-merge");
  });

  it("returns 400 for an invalid handoffType", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${handoffLaneId}/handoff`)
      .send({ handoffType: "teleport" });

    expect(res.status).toBe(400);
  });

  it("creates a watch_files handoff without changing lane status", async () => {
    const beforeRes = await request(app).get(`/api/sessions/${testSessionId}/lanes`);
    const beforeLane = beforeRes.body.lanes.find((l: { id: number }) => l.id === handoffLaneId);
    const statusBefore = beforeLane.status;

    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${handoffLaneId}/handoff`)
      .send({ handoffType: "watch_files", resourcePaths: ["src/shared/utils.ts"] });

    expect(res.status).toBe(201);

    const afterRes = await request(app).get(`/api/sessions/${testSessionId}/lanes`);
    const afterLane = afterRes.body.lanes.find((l: { id: number }) => l.id === handoffLaneId);
    expect(afterLane.status).toBe(statusBefore);
  });
});

// ─── Heavy Jobs ────────────────────────────────────────────────────────────────

describe("POST /api/sessions/:id/heavy-jobs (enqueue)", () => {
  it("enqueues an indexing job with default priority", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/heavy-jobs`)
      .send({ jobClass: "indexing" });

    expect(res.status).toBe(201);
    expect(res.body.jobClass).toBe("indexing");
    expect(res.body.status).toBe("queued");
    expect(res.body.priority).toBe(5);
    expect(typeof res.body.score).toBe("number");
    expect(res.body.score).toBeGreaterThan(0);
  });

  it("enqueues a job with a custom priority and payload", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/heavy-jobs`)
      .send({
        jobClass: "embedding",
        priority: 8,
        payload: { files: ["src/routes/auth.ts"] },
      });

    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(8);
    expect(res.body.payload).toEqual({ files: ["src/routes/auth.ts"] });
  });

  it("returns 400 for an invalid jobClass", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/heavy-jobs`)
      .send({ jobClass: "turbo-compute" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent session", async () => {
    const res = await request(app)
      .post("/api/sessions/999999999/heavy-jobs")
      .send({ jobClass: "indexing" });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:id/heavy-jobs", () => {
  it("lists all jobs for the session", async () => {
    const res = await request(app).get(`/api/sessions/${testSessionId}/heavy-jobs`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(testSessionId);
    expect(Array.isArray(res.body.jobs)).toBe(true);
    expect(res.body.total).toBe(res.body.jobs.length);
  });

  it("filters by status query param", async () => {
    const res = await request(app).get(
      `/api/sessions/${testSessionId}/heavy-jobs?status=queued`,
    );

    expect(res.status).toBe(200);
    for (const job of res.body.jobs) {
      expect(job.status).toBe("queued");
    }
  });

  it("returns 400 for invalid status filter", async () => {
    const res = await request(app).get(
      `/api/sessions/${testSessionId}/heavy-jobs?status=invalid`,
    );

    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:id/heavy-jobs/next", () => {
  it("peeks at the highest-scored queued job", async () => {
    const res = await request(app).get(
      `/api/sessions/${testSessionId}/heavy-jobs/next`,
    );

    // Session has queued jobs from earlier tests
    if (res.status === 200) {
      expect(res.body.job).toBeDefined();
      expect(res.body.job.status).toBe("queued");
    } else {
      expect(res.status).toBe(204);
    }
  });
});

describe("Heavy-job scheduler: priority ordering", () => {
  let lowPriorityJobId: number;
  let highPriorityJobId: number;

  beforeAll(async () => {
    // Enqueue a low-priority job first
    const lowRes = await request(app)
      .post(`/api/sessions/${testSessionId}/heavy-jobs`)
      .send({ jobClass: "other", priority: 1 });
    lowPriorityJobId = lowRes.body.id;

    // Enqueue a high-priority job immediately after
    const highRes = await request(app)
      .post(`/api/sessions/${testSessionId}/heavy-jobs`)
      .send({ jobClass: "other", priority: 10 });
    highPriorityJobId = highRes.body.id;
  });

  it("higher priority job has a higher effective score than lower priority", async () => {
    const res = await request(app).get(`/api/sessions/${testSessionId}/heavy-jobs?status=queued`);
    const jobs = res.body.jobs as Array<{ id: number; score: number; priority: number }>;

    const lowJob = jobs.find((j) => j.id === lowPriorityJobId);
    const highJob = jobs.find((j) => j.id === highPriorityJobId);

    expect(lowJob).toBeDefined();
    expect(highJob).toBeDefined();
    expect(highJob!.score).toBeGreaterThan(lowJob!.score);
  });

  it("GET /heavy-jobs/next returns the highest-scored job", async () => {
    const nextRes = await request(app).get(
      `/api/sessions/${testSessionId}/heavy-jobs/next`,
    );

    if (nextRes.status === 200) {
      // Should be the highest-scored queued job
      expect(nextRes.body.job.status).toBe("queued");
      // The next job should have the highest priority score among queued jobs
      const listRes = await request(app).get(
        `/api/sessions/${testSessionId}/heavy-jobs?status=queued`,
      );
      const maxScore = Math.max(
        ...listRes.body.jobs.map((j: { score: number }) => j.score),
      );
      expect(nextRes.body.job.score).toBeCloseTo(maxScore, 1);
    }
  });
});

describe("PATCH /api/sessions/:id/heavy-jobs/:jobId (update status)", () => {
  let jobId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/heavy-jobs`)
      .send({ jobClass: "eval", priority: 5 });
    jobId = res.body.id;
  });

  it("marks a job as running", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${testSessionId}/heavy-jobs/${jobId}`)
      .send({ status: "running" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.startedAt).toBeDefined();
  });

  it("marks a running job as completed with a result", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${testSessionId}/heavy-jobs/${jobId}`)
      .send({ status: "completed", result: { filesIndexed: 42 } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.result).toEqual({ filesIndexed: 42 });
    expect(res.body.completedAt).toBeDefined();
  });

  it("returns 400 for an invalid status transition value", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${testSessionId}/heavy-jobs/${jobId}`)
      .send({ status: "deleted" });

    expect(res.status).toBe(400);
  });

  it("marks a job as failed with an error message", async () => {
    const enqueueRes = await request(app)
      .post(`/api/sessions/${testSessionId}/heavy-jobs`)
      .send({ jobClass: "blast_radius", priority: 3 });
    const failJobId = enqueueRes.body.id;

    const res = await request(app)
      .patch(`/api/sessions/${testSessionId}/heavy-jobs/${failJobId}`)
      .send({ status: "failed", errorMessage: "OOM error" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.errorMessage).toBe("OOM error");
  });

  it("marks a job as deferred with a future timestamp", async () => {
    const enqueueRes = await request(app)
      .post(`/api/sessions/${testSessionId}/heavy-jobs`)
      .send({ jobClass: "compile", priority: 2 });
    const deferJobId = enqueueRes.body.id;

    const res = await request(app)
      .patch(`/api/sessions/${testSessionId}/heavy-jobs/${deferJobId}`)
      .send({ status: "deferred", deferUntilSeconds: 600 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deferred");
    expect(res.body.deferUntil).toBeDefined();
    expect(new Date(res.body.deferUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns 404 for a non-existent job", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${testSessionId}/heavy-jobs/999999999`)
      .send({ status: "running" });

    expect(res.status).toBe(404);
  });
});

// ─── Coordination Summary ──────────────────────────────────────────────────────

describe("GET /api/sessions/:id/coordination", () => {
  it("returns a full coordination summary for the session", async () => {
    const res = await request(app).get(`/api/sessions/${testSessionId}/coordination`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(testSessionId);
    expect(Array.isArray(res.body.lanes)).toBe(true);
    expect(typeof res.body.totalActiveClaims).toBe("number");
    expect(typeof res.body.totalQueuedJobs).toBe("number");
    expect(typeof res.body.pendingHandoffs).toBe("number");
    expect(Array.isArray(res.body.recentHandoffs)).toBe(true);
  });
});

describe("GET /api/sessions/:id/coordination - count accuracy", () => {
  let coordSessionId: number;
  let coordLaneId: number;

  beforeAll(async () => {
    const [session] = await db
      .insert(sessionsTable)
      .values({ profileId: testProfileId, status: "ready" })
      .returning();
    coordSessionId = session.id;

    const res = await request(app)
      .post(`/api/sessions/${coordSessionId}/lanes`)
      .send({ memberIdentifier: "coord-user@test.com", laneType: "backend" });
    coordLaneId = res.body.id;
  });

  afterAll(async () => {
    await cleanupSession(coordSessionId);
  });

  it("starts with zero totalActiveClaims for a fresh session", async () => {
    const res = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    expect(res.status).toBe(200);
    expect(res.body.totalActiveClaims).toBe(0);

    const laneSummary = res.body.lanes.find(
      (l: { lane: { id: number } }) => l.lane.id === coordLaneId,
    );
    expect(laneSummary).toBeDefined();
    expect(laneSummary.activeClaims).toBe(0);
  });

  it("totalActiveClaims increments when a claim is created", async () => {
    await request(app)
      .post(`/api/sessions/${coordSessionId}/lanes/${coordLaneId}/claim`)
      .send({ resourcePath: "src/coord-test/file.ts", strength: 0.5 });

    const res = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    expect(res.status).toBe(200);
    expect(res.body.totalActiveClaims).toBe(1);

    const laneSummary = res.body.lanes.find(
      (l: { lane: { id: number } }) => l.lane.id === coordLaneId,
    );
    expect(laneSummary.activeClaims).toBe(1);
  });

  it("totalActiveClaims decrements when a claim is released", async () => {
    const claimRes = await request(app)
      .post(`/api/sessions/${coordSessionId}/lanes/${coordLaneId}/claim`)
      .send({ resourcePath: "src/coord-test/releasable.ts", strength: 0.5 });
    const claimId = claimRes.body.claim.id;

    const beforeRes = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    const countBefore: number = beforeRes.body.totalActiveClaims;

    await request(app).delete(
      `/api/sessions/${coordSessionId}/lanes/${coordLaneId}/claim/${claimId}`,
    );

    const afterRes = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    expect(afterRes.body.totalActiveClaims).toBe(countBefore - 1);

    const laneSummary = afterRes.body.lanes.find(
      (l: { lane: { id: number } }) => l.lane.id === coordLaneId,
    );
    expect(laneSummary.activeClaims).toBe(countBefore - 1);
  });

  it("pendingHandoffs increments when a handoff is created", async () => {
    const beforeRes = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    const totalBefore: number = beforeRes.body.pendingHandoffs;
    const laneBefore = beforeRes.body.lanes.find(
      (l: { lane: { id: number } }) => l.lane.id === coordLaneId,
    );
    const laneCountBefore: number = laneBefore.pendingHandoffs;

    await request(app)
      .post(`/api/sessions/${coordSessionId}/lanes/${coordLaneId}/handoff`)
      .send({ handoffType: "watch_files", resourcePaths: ["src/shared/api.ts"] });

    const afterRes = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    expect(afterRes.body.pendingHandoffs).toBe(totalBefore + 1);

    const laneAfter = afterRes.body.lanes.find(
      (l: { lane: { id: number } }) => l.lane.id === coordLaneId,
    );
    expect(laneAfter.pendingHandoffs).toBe(laneCountBefore + 1);
  });

  it("totalQueuedJobs increments when a job is enqueued associated with a lane", async () => {
    const beforeRes = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    const totalBefore: number = beforeRes.body.totalQueuedJobs;
    const laneBefore = beforeRes.body.lanes.find(
      (l: { lane: { id: number } }) => l.lane.id === coordLaneId,
    );
    const laneJobsBefore: number = laneBefore.queuedJobs;

    await request(app)
      .post(`/api/sessions/${coordSessionId}/heavy-jobs`)
      .send({ jobClass: "indexing", laneId: coordLaneId });

    const afterRes = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    expect(afterRes.body.totalQueuedJobs).toBe(totalBefore + 1);

    const laneAfter = afterRes.body.lanes.find(
      (l: { lane: { id: number } }) => l.lane.id === coordLaneId,
    );
    expect(laneAfter.queuedJobs).toBe(laneJobsBefore + 1);
  });

  it("totalQueuedJobs excludes completed jobs", async () => {
    const enqueueRes = await request(app)
      .post(`/api/sessions/${coordSessionId}/heavy-jobs`)
      .send({ jobClass: "other", laneId: coordLaneId });
    const jobId: number = enqueueRes.body.id;

    const beforeRes = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    const countBefore: number = beforeRes.body.totalQueuedJobs;

    await request(app)
      .patch(`/api/sessions/${coordSessionId}/heavy-jobs/${jobId}`)
      .send({ status: "running" });
    await request(app)
      .patch(`/api/sessions/${coordSessionId}/heavy-jobs/${jobId}`)
      .send({ status: "completed", result: {} });

    const afterRes = await request(app).get(`/api/sessions/${coordSessionId}/coordination`);
    expect(afterRes.body.totalQueuedJobs).toBe(countBefore - 1);
  });
});

// ─── Claim Expiry ──────────────────────────────────────────────────────────────

describe("Claim expiry: expireStaleClaimsForSession", () => {
  let expirySessionId: number;
  let expiryLaneId: number;

  beforeAll(async () => {
    const [session] = await db
      .insert(sessionsTable)
      .values({ profileId: testProfileId, status: "ready" })
      .returning();
    expirySessionId = session.id;

    const res = await request(app)
      .post(`/api/sessions/${expirySessionId}/lanes`)
      .send({ memberIdentifier: "expiry-user@test.com", laneType: "backend" });
    expiryLaneId = res.body.id;
  });

  afterAll(async () => {
    await cleanupSession(expirySessionId);
  });

  it("marks a claim inactive when its expiresAt is backdated to the past", async () => {
    const claimRes = await request(app)
      .post(`/api/sessions/${expirySessionId}/lanes/${expiryLaneId}/claim`)
      .send({ resourcePath: "src/expiry-test/stale.ts", strength: 0.5 });
    expect(claimRes.status).toBe(201);
    const claimId: number = claimRes.body.claim.id;

    const [before] = await db
      .select({ active: laneClaimsTable.active })
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, claimId));
    expect(before.active).toBe(true);

    await db
      .update(laneClaimsTable)
      .set({ expiresAt: sql`NOW() - INTERVAL '1 second'` })
      .where(eq(laneClaimsTable.id, claimId));

    const lanesRes = await request(app).get(`/api/sessions/${expirySessionId}/lanes`);
    expect(lanesRes.status).toBe(200);

    const [after] = await db
      .select({ active: laneClaimsTable.active })
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, claimId));
    expect(after.active).toBe(false);
  });

  it("coordination totalActiveClaims excludes the expired claim", async () => {
    const activeRes = await request(app)
      .post(`/api/sessions/${expirySessionId}/lanes/${expiryLaneId}/claim`)
      .send({ resourcePath: "src/expiry-test/active.ts", strength: 0.5 });
    expect(activeRes.status).toBe(201);

    const staleRes = await request(app)
      .post(`/api/sessions/${expirySessionId}/lanes/${expiryLaneId}/claim`)
      .send({ resourcePath: "src/expiry-test/stale2.ts", strength: 0.5 });
    expect(staleRes.status).toBe(201);
    const staleClaimId: number = staleRes.body.claim.id;

    await db
      .update(laneClaimsTable)
      .set({ expiresAt: sql`NOW() - INTERVAL '1 second'` })
      .where(eq(laneClaimsTable.id, staleClaimId));

    const coordRes = await request(app).get(`/api/sessions/${expirySessionId}/coordination`);
    expect(coordRes.status).toBe(200);

    const laneSummary = coordRes.body.lanes.find(
      (l: { lane: { id: number } }) => l.lane.id === expiryLaneId,
    );
    expect(laneSummary.activeClaims).toBe(1);
    expect(coordRes.body.totalActiveClaims).toBe(1);
  });

  it("marks a claim inactive when lastHeartbeatAt is beyond the heartbeat window", async () => {
    const claimRes = await request(app)
      .post(`/api/sessions/${expirySessionId}/lanes/${expiryLaneId}/claim`)
      .send({ resourcePath: "src/expiry-test/heartbeat-stale.ts", strength: 0.5 });
    expect(claimRes.status).toBe(201);
    const claimId: number = claimRes.body.claim.id;

    await db
      .update(laneClaimsTable)
      .set({
        lastHeartbeatAt: sql`NOW() - INTERVAL '1 hour'`,
        expiresAt: sql`NOW() + INTERVAL '1 hour'`,
      })
      .where(eq(laneClaimsTable.id, claimId));

    const lanesRes = await request(app).get(`/api/sessions/${expirySessionId}/lanes`);
    expect(lanesRes.status).toBe(200);

    const [after] = await db
      .select({ active: laneClaimsTable.active })
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, claimId));
    expect(after.active).toBe(false);
  });

  it("does not expire a claim whose expiresAt and lastHeartbeatAt are both in the future", async () => {
    const claimRes = await request(app)
      .post(`/api/sessions/${expirySessionId}/lanes/${expiryLaneId}/claim`)
      .send({ resourcePath: "src/expiry-test/fresh.ts", strength: 0.5 });
    expect(claimRes.status).toBe(201);
    const claimId: number = claimRes.body.claim.id;

    await db
      .update(laneClaimsTable)
      .set({
        lastHeartbeatAt: sql`NOW()`,
        expiresAt: sql`NOW() + INTERVAL '1 hour'`,
      })
      .where(eq(laneClaimsTable.id, claimId));

    const lanesRes = await request(app).get(`/api/sessions/${expirySessionId}/lanes`);
    expect(lanesRes.status).toBe(200);

    const [after] = await db
      .select({ active: laneClaimsTable.active })
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, claimId));
    expect(after.active).toBe(true);
  });
});

// ─── Heavy-job scheduler: age-weight ordering ─────────────────────────────────
//
// Verifies that job age contributes to effective score independently of priority.
// Score formula: priority_norm + ageWeight + laneWeight + classFloor
// ageWeight accrues at 0.05 per minute, capped at 2.0.
//
// By backdating a job's createdAt by 60 minutes we add 2.0 to its score,
// which must dominate any same-priority newly-created job.

describe("Heavy-job scheduler: age-weight ordering", () => {
  let ageSessionId: number;

  beforeAll(async () => {
    const [session] = await db
      .insert(sessionsTable)
      .values({ profileId: testProfileId, status: "ready" })
      .returning();
    ageSessionId = session.id;
  });

  afterAll(async () => {
    await db.delete(laneHeavyJobsTable).where(eq(laneHeavyJobsTable.sessionId, ageSessionId));
    await db.delete(sessionsTable).where(eq(sessionsTable.id, ageSessionId));
  });

  it("older job scores higher than newer job of equal priority", async () => {
    // Enqueue two jobs with identical priority and jobClass
    const newRes = await request(app)
      .post(`/api/sessions/${ageSessionId}/heavy-jobs`)
      .send({ jobClass: "other", priority: 5 });
    const newJobId: number = newRes.body.id;

    const oldRes = await request(app)
      .post(`/api/sessions/${ageSessionId}/heavy-jobs`)
      .send({ jobClass: "other", priority: 5 });
    const oldJobId: number = oldRes.body.id;

    // Backdate the "old" job's createdAt by 60 minutes to simulate age accrual.
    // At 0.05 weight/min × 60 min = 3.0 → capped at MAX_AGE_WEIGHT = 2.0.
    // This guarantees the old job will score higher after refreshJobWeights runs.
    await db
      .update(laneHeavyJobsTable)
      .set({ createdAt: sql`NOW() - INTERVAL '60 minutes'` })
      .where(eq(laneHeavyJobsTable.id, oldJobId));

    // Trigger refreshJobWeights by listing jobs (the GET endpoint calls it)
    const listRes = await request(app).get(`/api/sessions/${ageSessionId}/heavy-jobs?status=queued`);
    expect(listRes.status).toBe(200);

    const jobs = listRes.body.jobs as Array<{ id: number; score: number; ageWeight: number }>;
    const newJob = jobs.find((j) => j.id === newJobId)!;
    const oldJob = jobs.find((j) => j.id === oldJobId)!;

    expect(newJob).toBeDefined();
    expect(oldJob).toBeDefined();

    // Old job must have accumulated non-zero age weight
    expect(oldJob.ageWeight).toBeGreaterThan(0);

    // Old job's effective score must exceed new job's score
    expect(oldJob.score).toBeGreaterThan(newJob.score);
  });

  it("age alone can make a lower-priority job score higher than a brand-new one", async () => {
    // A low-priority job (1) that is 60 minutes old should score higher
    // than a high-priority job (10) that was just created, because:
    // low-job score = 0.1 + 2.0 (age) + 1.0 (lane) + 0.1 (class floor) = 3.2
    // high-job score = 1.0 + 0   (age) + 1.0 (lane) + 0.1 (class floor) = 2.1
    const freshHighRes = await request(app)
      .post(`/api/sessions/${ageSessionId}/heavy-jobs`)
      .send({ jobClass: "other", priority: 10 });
    const freshHighId: number = freshHighRes.body.id;

    const staleRes = await request(app)
      .post(`/api/sessions/${ageSessionId}/heavy-jobs`)
      .send({ jobClass: "other", priority: 1 });
    const staleJobId: number = staleRes.body.id;

    await db
      .update(laneHeavyJobsTable)
      .set({ createdAt: sql`NOW() - INTERVAL '60 minutes'` })
      .where(eq(laneHeavyJobsTable.id, staleJobId));

    const listRes = await request(app).get(`/api/sessions/${ageSessionId}/heavy-jobs?status=queued`);
    const jobs = listRes.body.jobs as Array<{ id: number; score: number }>;

    const freshHighJob = jobs.find((j) => j.id === freshHighId)!;
    const staleJob = jobs.find((j) => j.id === staleJobId)!;

    expect(staleJob.score).toBeGreaterThan(freshHighJob.score);
  });
});

// ─── sweepExpiredClaims unit/integration tests ─────────────────────────────────

describe("sweepExpiredClaims", () => {
  let sweepLaneId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "sweep-test@test.com", laneType: "general" });
    sweepLaneId = res.body.id;
  });

  afterEach(async () => {
    await db.delete(laneClaimsTable).where(eq(laneClaimsTable.laneId, sweepLaneId));
  });

  it("hard-deletes a claim whose expires_at has passed (TTL expiry)", async () => {
    const [expired] = await db
      .insert(laneClaimsTable)
      .values({
        laneId: sweepLaneId,
        claimType: "file",
        pathOrSymbol: "src/sweep-test/ttl-expired.ts",
        expiresAt: new Date(Date.now() - 60_000),
        active: true,
      })
      .returning();

    const result = await sweepExpiredClaims();

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(typeof result.sweptAt).toBe("string");

    const remaining = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, expired.id));
    expect(remaining).toHaveLength(0);
  });

  it("hard-deletes a claim whose last_heartbeat_at is older than the heartbeat window (missed heartbeat)", async () => {
    const staleHeartbeat = new Date(Date.now() - (LANE_HEARTBEAT_WINDOW_SECONDS + 60) * 1000);

    const [expired] = await db
      .insert(laneClaimsTable)
      .values({
        laneId: sweepLaneId,
        claimType: "file",
        pathOrSymbol: "src/sweep-test/heartbeat-expired.ts",
        expiresAt: new Date(Date.now() + 3_600_000),
        active: true,
      })
      .returning();

    await db
      .update(laneClaimsTable)
      .set({ lastHeartbeatAt: staleHeartbeat })
      .where(eq(laneClaimsTable.id, expired.id));

    const result = await sweepExpiredClaims();

    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, expired.id));
    expect(remaining).toHaveLength(0);
  });

  it("leaves a still-active claim untouched (valid TTL and recent heartbeat)", async () => {
    const [active] = await db
      .insert(laneClaimsTable)
      .values({
        laneId: sweepLaneId,
        claimType: "file",
        pathOrSymbol: "src/sweep-test/still-active.ts",
        expiresAt: new Date(Date.now() + 3_600_000),
        active: true,
      })
      .returning();

    await sweepExpiredClaims();

    const remaining = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, active.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].active).toBe(true);
  });

  it("does not hard-delete an already-inactive claim even if its timestamps are stale", async () => {
    const [inactive] = await db
      .insert(laneClaimsTable)
      .values({
        laneId: sweepLaneId,
        claimType: "file",
        pathOrSymbol: "src/sweep-test/already-inactive.ts",
        expiresAt: new Date(Date.now() - 60_000),
        active: false,
      })
      .returning();

    await sweepExpiredClaims();

    const remaining = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, inactive.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].active).toBe(false);
  });

  it("returns sweptAt as a valid ISO timestamp", async () => {
    const result = await sweepExpiredClaims();
    expect(() => new Date(result.sweptAt)).not.toThrow();
    expect(new Date(result.sweptAt).getTime()).not.toBeNaN();
  });
});

// ─── expireStaleClaimsForSession unit/integration tests ────────────────────────

describe("expireStaleClaimsForSession", () => {
  let softExpireLaneId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes`)
      .send({ memberIdentifier: "soft-expire-test@test.com", laneType: "general" });
    softExpireLaneId = res.body.id;
  });

  afterEach(async () => {
    await db.delete(laneClaimsTable).where(eq(laneClaimsTable.laneId, softExpireLaneId));
  });

  it("soft-deactivates a claim whose expires_at has passed (TTL expiry)", async () => {
    const [expired] = await db
      .insert(laneClaimsTable)
      .values({
        laneId: softExpireLaneId,
        claimType: "file",
        pathOrSymbol: "src/soft-expire-test/ttl-expired.ts",
        expiresAt: new Date(Date.now() - 60_000),
        active: true,
      })
      .returning();

    const result = await expireStaleClaimsForSession(testSessionId);

    expect(result.deactivated).toBeGreaterThanOrEqual(1);

    const row = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, expired.id));
    expect(row).toHaveLength(1);
    expect(row[0].active).toBe(false);
  });

  it("soft-deactivates a claim whose last_heartbeat_at is older than the heartbeat window", async () => {
    const staleHeartbeat = new Date(Date.now() - (LANE_HEARTBEAT_WINDOW_SECONDS + 60) * 1000);

    const [expired] = await db
      .insert(laneClaimsTable)
      .values({
        laneId: softExpireLaneId,
        claimType: "file",
        pathOrSymbol: "src/soft-expire-test/heartbeat-expired.ts",
        expiresAt: new Date(Date.now() + 3_600_000),
        active: true,
      })
      .returning();

    await db
      .update(laneClaimsTable)
      .set({ lastHeartbeatAt: staleHeartbeat })
      .where(eq(laneClaimsTable.id, expired.id));

    const result = await expireStaleClaimsForSession(testSessionId);

    expect(result.deactivated).toBeGreaterThanOrEqual(1);

    const row = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, expired.id));
    expect(row).toHaveLength(1);
    expect(row[0].active).toBe(false);
  });

  it("leaves a still-active claim untouched (valid TTL and recent heartbeat)", async () => {
    const [active] = await db
      .insert(laneClaimsTable)
      .values({
        laneId: softExpireLaneId,
        claimType: "file",
        pathOrSymbol: "src/soft-expire-test/still-active.ts",
        expiresAt: new Date(Date.now() + 3_600_000),
        active: true,
      })
      .returning();

    const result = await expireStaleClaimsForSession(testSessionId);

    expect(result.deactivated).toBe(0);

    const row = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, active.id));
    expect(row).toHaveLength(1);
    expect(row[0].active).toBe(true);
  });

  it("does not touch claims belonging to a different session", async () => {
    const [otherSession] = await db
      .insert(sessionsTable)
      .values({ profileId: testProfileId, status: "ready" })
      .returning();

    const [otherLane] = await db
      .insert(sessionLanesTable)
      .values({ sessionId: otherSession.id, memberIdentifier: "other@test.com", laneType: "general" })
      .returning();

    const [otherClaim] = await db
      .insert(laneClaimsTable)
      .values({
        laneId: otherLane.id,
        claimType: "file",
        pathOrSymbol: "src/soft-expire-test/other-session.ts",
        expiresAt: new Date(Date.now() - 60_000),
        active: true,
      })
      .returning();

    await expireStaleClaimsForSession(testSessionId);

    const row = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.id, otherClaim.id));
    expect(row).toHaveLength(1);
    expect(row[0].active).toBe(true);

    await db.delete(laneClaimsTable).where(eq(laneClaimsTable.laneId, otherLane.id));
    await db.delete(sessionLanesTable).where(eq(sessionLanesTable.id, otherLane.id));
    await db.delete(sessionsTable).where(eq(sessionsTable.id, otherSession.id));
  });
});

// ─── Admin sweep-claims auth tests ────────────────────────────────────────────

describe("POST /api/admin/sweep-claims authentication", () => {
  const REAL_TOKEN = "test-admin-token-123";

  beforeAll(() => {
    process.env.ADMIN_SWEEP_TOKEN = REAL_TOKEN;
  });

  afterAll(() => {
    delete process.env.ADMIN_SWEEP_TOKEN;
  });

  it("returns 401 when no X-Admin-Token header is provided", async () => {
    const res = await request(app).post("/api/admin/sweep-claims");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Unauthorized" });
  });

  it("returns 401 when an incorrect X-Admin-Token is provided", async () => {
    const res = await request(app)
      .post("/api/admin/sweep-claims")
      .set("X-Admin-Token", "wrong-token");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Unauthorized" });
  });

  it("returns 200 when the correct X-Admin-Token is provided", async () => {
    const res = await request(app)
      .post("/api/admin/sweep-claims")
      .set("X-Admin-Token", REAL_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sweptAt");
  });
});

// ─── Claim cleanup stats ───────────────────────────────────────────────────────

describe("GET /api/admin/claim-cleanup-stats", () => {
  let insertedIds: number[] = [];

  beforeAll(async () => {
    // Seed a couple of known purge log rows so assertions are deterministic
    const rows = await db
      .insert(claimPurgeLogsTable)
      .values([
        { rowsDeleted: 5, retentionDays: 7 },
        { rowsDeleted: 0, retentionDays: 7 },
      ])
      .returning({ id: claimPurgeLogsTable.id });
    insertedIds = rows.map((r) => r.id);
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      for (const id of insertedIds) {
        await db.delete(claimPurgeLogsTable).where(eq(claimPurgeLogsTable.id, id));
      }
    }
  });

  it("returns 200 with the expected shape", async () => {
    const res = await request(app).get("/api/admin/claim-cleanup-stats");
    expect(res.status).toBe(200);
    expect(typeof res.body.totalRuns).toBe("number");
    expect(typeof res.body.totalRowsDeleted).toBe("number");
    expect(Array.isArray(res.body.recentRuns)).toBe(true);
  });

  it("totalRuns reflects the seeded rows", async () => {
    const res = await request(app).get("/api/admin/claim-cleanup-stats");
    expect(res.status).toBe(200);
    expect(res.body.totalRuns).toBeGreaterThanOrEqual(2);
  });

  it("totalRowsDeleted is the sum of all rowsDeleted values", async () => {
    const res = await request(app).get("/api/admin/claim-cleanup-stats");
    expect(res.status).toBe(200);
    // At minimum the 5 rows we seeded should be accounted for
    expect(res.body.totalRowsDeleted).toBeGreaterThanOrEqual(5);
  });

  it("recentRuns entries have the correct shape", async () => {
    const res = await request(app).get("/api/admin/claim-cleanup-stats");
    expect(res.status).toBe(200);
    const run = res.body.recentRuns[0];
    expect(typeof run.id).toBe("number");
    expect(typeof run.purgedAt).toBe("string");
    expect(typeof run.rowsDeleted).toBe("number");
    expect(typeof run.retentionDays).toBe("number");
  });

  it("lastPurgedAt is a non-null ISO string when runs exist", async () => {
    const res = await request(app).get("/api/admin/claim-cleanup-stats");
    expect(res.status).toBe(200);
    expect(res.body.lastPurgedAt).not.toBeNull();
    expect(new Date(res.body.lastPurgedAt).getTime()).not.toBeNaN();
  });

  it("recentRuns is ordered newest-first", async () => {
    const res = await request(app).get("/api/admin/claim-cleanup-stats");
    expect(res.status).toBe(200);
    const runs: Array<{ purgedAt: string }> = res.body.recentRuns;
    for (let i = 1; i < runs.length; i++) {
      expect(new Date(runs[i - 1]!.purgedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(runs[i]!.purgedAt).getTime(),
      );
    }
  });
});
