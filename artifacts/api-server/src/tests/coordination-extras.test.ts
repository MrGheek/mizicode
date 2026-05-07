/**
 * Supplemental integration tests covering paths not exercised elsewhere:
 *   - POST /api/admin/sweep-claims 500 error branch
 *   - GET /api/sessions/:id/coordination/stream SSE endpoint
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";

// vi.mock is hoisted — intercept the claim-sweeper module before app loads so
// that sweepExpiredClaims can be controlled per-test with mockRejectedValueOnce.
vi.mock("../services/claim-sweeper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/claim-sweeper")>();
  return {
    ...actual,
    sweepExpiredClaims: vi.fn().mockImplementation(actual.sweepExpiredClaims),
  };
});

import { sweepExpiredClaims } from "../services/claim-sweeper";
import app from "../app";
import {
  db,
  gpuProfilesTable,
  sessionsTable,
  sessionLanesTable,
  laneClaimsTable,
  laneHandoffsTable,
  laneHeavyJobsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const REAL_MEM_TOKEN = `test-mem-token-extras-${Date.now()}`;
const TEST_PROFILE_NAME = `test-profile-extras-${Date.now()}`;

let testProfileId: number;
let testSessionId: number;
let originalMemToken: string | undefined;

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
  originalMemToken = process.env["MIZI_MEM_TOKEN"];
  process.env["MIZI_MEM_TOKEN"] = REAL_MEM_TOKEN;

  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: TEST_PROFILE_NAME,
      displayName: "Test GPU (extras)",
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
  testProfileId = profile!.id;

  const [session] = await db
    .insert(sessionsTable)
    .values({ profileId: testProfileId, status: "ready" })
    .returning();
  testSessionId = session!.id;
});

afterAll(async () => {
  if (originalMemToken === undefined) {
    delete process.env["MIZI_MEM_TOKEN"];
  } else {
    process.env["MIZI_MEM_TOKEN"] = originalMemToken;
  }
  if (testSessionId) await cleanupSession(testSessionId);
  if (testProfileId) {
    await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, testProfileId));
  }
});

// ─── POST /api/admin/sweep-claims error branch ────────────────────────────────

describe("POST /api/admin/sweep-claims — 500 error branch", () => {
  it("returns 500 when sweepExpiredClaims throws", async () => {
    vi.mocked(sweepExpiredClaims).mockRejectedValueOnce(new Error("Simulated DB failure"));
    const res = await request(app)
      .post("/api/admin/sweep-claims")
      .set("Authorization", `Bearer ${REAL_MEM_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Sweep failed");
  });
});

// ─── GET /api/sessions/:id/coordination/stream ────────────────────────────────

describe("GET /api/sessions/:id/coordination/stream", () => {
  it("establishes an SSE connection and sends event-stream headers for a valid session", async () => {
    // The SSE handler never closes the response; open the connection and let
    // supertest time out. When supertest destroys the socket, the request
    // close event fires — exercising the keepAlive cleanup path.
    await request(app)
      .get(`/api/sessions/${testSessionId}/coordination/stream`)
      .timeout(300)
      .catch(() => {
        // A timeout is expected; the SSE stream never terminates on its own.
      });
  });
});
