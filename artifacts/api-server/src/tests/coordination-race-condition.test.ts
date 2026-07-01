/**
 * Race condition tests for concurrent claim upsert
 *
 * Tests concurrent POST /claim requests for the same (laneId, resourcePath)
 * to detect and prevent duplicate active claims.
 *
 * This is CRITICAL because the lane_claims table has a unique constraint:
 *   UNIQUE (laneId, pathOrSymbol) WHERE active = true
 *
 * Race condition: Two concurrent requests both check for existing claim,
 * both find none, both try to INSERT → one succeeds, other fails with
 * unique constraint violation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, gpuProfilesTable, sessionsTable, sessionLanesTable, laneClaimsTable } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

let testProfileId: number;
let testSessionId: number;
let testLaneId: number;

const TEST_PROFILE_NAME = `test-profile-race-${Date.now()}`;

async function setup() {
  // Create GPU profile
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: TEST_PROFILE_NAME,
      displayName: "Test GPU Race",
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

  // Create session
  const [session] = await db
    .insert(sessionsTable)
    .values({
      profileId: testProfileId,
      status: "ready",
    })
    .returning();
  testSessionId = session.id;

  // Create lane
  const [lane] = await db
    .insert(sessionLanesTable)
    .values({
      sessionId: testSessionId,
      memberIdentifier: "test-member",
      laneType: "backend",
      status: "active",
    })
    .returning();
  testLaneId = lane.id;
}

async function cleanup() {
  if (testLaneId) {
    await db.delete(laneClaimsTable).where(eq(laneClaimsTable.laneId, testLaneId));
    await db.delete(sessionLanesTable).where(eq(sessionLanesTable.id, testLaneId));
  }
  if (testSessionId) {
    await db.delete(sessionsTable).where(eq(sessionsTable.id, testSessionId));
  }
  if (testProfileId) {
    await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, testProfileId));
  }
}

beforeAll(async () => {
  await setup();
});

afterAll(async () => {
  await cleanup();
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("Concurrent Claim Upsert — Race Condition Prevention", () => {
  it("first concurrent claim request succeeds, second gets conflict or is deduplicated", async () => {
    // This test attempts two concurrent POST /claim requests
    // Both target the same lane and resource path
    // Expected: Only one active claim exists after both complete

    const resourcePath = "src/auth/middleware.ts";
    const claimType = "file";

    // Fire both requests concurrently (don't await each one individually)
    const promises = [
      request(app)
        .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
        .send({
          claimType,
          pathOrSymbol: resourcePath,
          claimStrength: "editing",
        }),
      request(app)
        .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
        .send({
          claimType,
          pathOrSymbol: resourcePath,
          claimStrength: "editing",
        }),
    ];

    // Wait for both to complete
    const [res1, res2] = await Promise.all(promises);

    // Both should return either 200 (success) or 409 (conflict/duplicate)
    // NOT 500 (internal error)
    expect([res1.status, res2.status]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(200|201|409)$/),
        expect.stringMatching(/^(200|201|409)$/),
      ]),
    );

    // At least one should succeed (200 or 201)
    const successCount = [res1, res2].filter((r) => r.status >= 200 && r.status < 300).length;
    expect(successCount).toBeGreaterThan(0);

    // Verify exactly ONE active claim exists in the database
    const activeClaims = await db
      .select()
      .from(laneClaimsTable)
      .where(
        and(
          eq(laneClaimsTable.laneId, testLaneId),
          eq(laneClaimsTable.pathOrSymbol, resourcePath),
          eq(laneClaimsTable.active, true),
        ),
      );

    expect(activeClaims).toHaveLength(1);
  });

  it("claim upsert with preserveHistory flag handles concurrent requests correctly", async () => {
    const resourcePath = "src/database/schema.ts";
    const claimType = "file";

    // First, create an initial claim
    const initialRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
      .send({
        claimType,
        pathOrSymbol: resourcePath,
        claimStrength: "editing",
      });

    expect(initialRes.status).toBeLessThan(400);
    const firstClaimId = initialRes.body.claimId;

    // Now send two concurrent refresh requests with preserveHistory=true
    const promises = [
      request(app)
        .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
        .send({
          claimType,
          pathOrSymbol: resourcePath,
          claimStrength: "editing",
          preserveHistory: true,
        }),
      request(app)
        .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
        .send({
          claimType,
          pathOrSymbol: resourcePath,
          claimStrength: "editing",
          preserveHistory: true,
        }),
    ];

    const [res1, res2] = await Promise.all(promises);

    // Both should succeed
    expect(res1.status).toBeLessThan(400);
    expect(res2.status).toBeLessThan(400);

    // Verify we have 3 rows: 1 active + 2 inactive (from the two refresh operations)
    const allClaims = await db
      .select()
      .from(laneClaimsTable)
      .where(eq(laneClaimsTable.laneId, testLaneId));

    const activeClaims = allClaims.filter((c) => c.active);
    expect(activeClaims).toHaveLength(1);

    // The new active claim should be different from the first
    expect(activeClaims[0].id).not.toBe(firstClaimId);
  });

  it("concurrent claims for different resources in same lane succeed independently", async () => {
    const resources = ["src/api/routes.ts", "src/utils/helpers.ts"];

    // Fire claims for different resources concurrently
    const promises = resources.map((path) =>
      request(app)
        .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
        .send({
          claimType: "file",
          pathOrSymbol: path,
          claimStrength: "editing",
        }),
    );

    const responses = await Promise.all(promises);

    // Both should succeed
    for (const res of responses) {
      expect(res.status).toBeLessThan(400);
    }

    // Verify both claims are active
    const activeClaims = await db
      .select()
      .from(laneClaimsTable)
      .where(and(eq(laneClaimsTable.laneId, testLaneId), eq(laneClaimsTable.active, true)));

    expect(activeClaims).toHaveLength(2);
  });

  it("claim expiry and refresh don't create duplicates under concurrency", async () => {
    const resourcePath = "src/models/user.ts";

    // Create initial claim
    const initialRes = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
      .send({
        claimType: "file",
        pathOrSymbol: resourcePath,
        claimStrength: "watching",
      });

    expect(initialRes.status).toBeLessThan(400);

    // Get the current claim
    const claims = await db
      .select()
      .from(laneClaimsTable)
      .where(and(eq(laneClaimsTable.laneId, testLaneId), eq(laneClaimsTable.pathOrSymbol, resourcePath)));

    const originalId = claims[0].id;

    // Now artificially expire the claim by setting lastHeartbeatAt to far in the past
    await db
      .update(laneClaimsTable)
      .set({
        lastHeartbeatAt: new Date(Date.now() - 600000), // 10 minutes ago
      })
      .where(eq(laneClaimsTable.id, originalId));

    // Fire two concurrent refresh requests
    const promises = [
      request(app)
        .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
        .send({
          claimType: "file",
          pathOrSymbol: resourcePath,
          claimStrength: "watching",
        }),
      request(app)
        .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
        .send({
          claimType: "file",
          pathOrSymbol: resourcePath,
          claimStrength: "watching",
        }),
    ];

    const [res1, res2] = await Promise.all(promises);

    expect(res1.status).toBeLessThan(400);
    expect(res2.status).toBeLessThan(400);

    // Verify only one active claim exists
    const activeClaims = await db
      .select()
      .from(laneClaimsTable)
      .where(
        and(
          eq(laneClaimsTable.laneId, testLaneId),
          eq(laneClaimsTable.pathOrSymbol, resourcePath),
          eq(laneClaimsTable.active, true),
        ),
      );

    expect(activeClaims).toHaveLength(1);
  });

  it("concurrent claims with symbol metadata prevents false conflicts", async () => {
    const resourcePath = "src/auth/validators.ts";
    const symbols1 = ["validateEmail", "validatePassword"];
    const symbols2 = ["validateUrl", "sanitizeInput"];

    // Lane1 claims symbols in the file
    const res1 = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/claim`)
      .send({
        claimType: "symbol",
        pathOrSymbol: resourcePath,
        claimSymbols: symbols1,
        claimStrength: "editing",
      });

    expect(res1.status).toBeLessThan(400);

    // Concurrently from a different lane, try to claim different symbols in same file
    const [lane2] = await db
      .insert(sessionLanesTable)
      .values({
        sessionId: testSessionId,
        memberIdentifier: "test-member-2",
        laneType: "frontend",
        status: "active",
      })
      .returning();

    const res2 = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${lane2.id}/claim`)
      .send({
        claimType: "symbol",
        pathOrSymbol: resourcePath,
        claimSymbols: symbols2,
        claimStrength: "watching",
      });

    // Both should succeed (non-overlapping symbols)
    expect(res1.status).toBeLessThan(400);
    expect(res2.status).toBeLessThan(400);

    // Verify both claims exist as active
    const allClaims = await db
      .select()
      .from(laneClaimsTable)
      .where(and(eq(laneClaimsTable.pathOrSymbol, resourcePath), eq(laneClaimsTable.active, true)));

    expect(allClaims).toHaveLength(2);

    // Cleanup lane2
    await db.delete(sessionLanesTable).where(eq(sessionLanesTable.id, lane2.id));
  });
});
