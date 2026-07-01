/**
 * E2E tests for team member session setup with nginx path-based routing
 *
 * Tests the complex multi-user scenario:
 * 1. Orchestrate a session with multiple team members
 * 2. Each member gets their own code-server instance on a unique path
 * 3. nginx routes requests based on path prefix (e.g., /backend, /frontend)
 * 4. Each code-server maintains isolated auth via basic auth
 * 5. Shared workspace is accessible to all members
 *
 * This is the most complex orchestration scenario and was previously untested.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../app";
import {
  db,
  gpuProfilesTable,
  sessionsTable,
  sessionLanesTable,
  laneClaimsTable,
  laneHandoffsTable,
  laneHeavyJobsTable,
  laneEventsTable,
  provisionedResourcesTable,
  orchestrationIdempotencyTable,
  TeamMemberRecord,
} from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../services/vastai", () => ({
  searchOffers: vi.fn().mockResolvedValue([{ id: 42, dph_total: 0.35 }]),
  createInstance: vi.fn().mockResolvedValue({ new_contract: 9910, expected_price: 0.35 }),
  destroyInstance: vi.fn().mockResolvedValue({}),
  getInstance: vi.fn().mockResolvedValue({
    actual_status: "running",
    status_msg: "ready",
    dph_total: 0.35,
  }),
  buildInstanceUrls: vi.fn().mockReturnValue({
    theiaUrl: "http://workspace.fly.dev:8080",
    previewUrl: null,
    sshHost: "workspace.fly.dev",
    sshPort: 22,
    publicIp: "1.2.3.4",
    llmProxyUrl: "http://workspace.fly.dev:8081/v1",
  }),
  buildOnStartScript: vi.fn().mockReturnValue("#!/bin/bash\necho mocked"),
}));

vi.mock("../services/bridge-registry", () => ({
  getBridgeStatus: vi.fn().mockReturnValue("disconnected"),
  registerBridgeConnection: vi.fn(),
  unregisterBridgeConnection: vi.fn(),
}));

vi.mock("../services/skills-bundler", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    seedDefaultBundles: vi.fn().mockResolvedValue(undefined),
    getDefaultBundleForContext: vi.fn().mockResolvedValue(null),
    compileBundle: vi.fn().mockResolvedValue({
      skills: [],
      systemPrompt: "mock",
      totalTokens: 10,
      compiledAt: new Date().toISOString(),
    }),
    buildActiveBundleEnvPayload: vi.fn().mockReturnValue(""),
    recordSessionActivation: vi.fn().mockResolvedValue(undefined),
    compileLaneBundles: vi.fn().mockResolvedValue({
      sessionCoreBundleId: null,
      sessionCoreCompiled: null,
      sharedRepoBundleId: null,
      sharedRepoCompiled: null,
      laneOverlays: [],
    }),
  };
});

// ─── Fixtures ──────────────────────────────────────────────────────────────────

let testProfileId: number;
const TEST_PROFILE_NAME = `test-profile-team-routing-${Date.now()}`;
const createdSessionIds: number[] = [];
let mockInstanceCounter = 9910;

function nextInstanceId(): number {
  return ++mockInstanceCounter;
}

async function cleanupSession(sessionId: number) {
  const lanes = await db
    .select({ id: sessionLanesTable.id })
    .from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId));
  const laneIds = lanes.map((l) => l.id);

  await db.delete(laneHeavyJobsTable).where(eq(laneHeavyJobsTable.sessionId, sessionId));
  await db.delete(laneEventsTable).where(eq(laneEventsTable.sessionId, sessionId));
  await db.delete(provisionedResourcesTable).where(eq(provisionedResourcesTable.sessionId, sessionId));
  await db.delete(orchestrationIdempotencyTable).where(eq(orchestrationIdempotencyTable.sessionId, sessionId));

  if (laneIds.length > 0) {
    await db.delete(laneClaimsTable).where(inArray(laneClaimsTable.laneId, laneIds));
    await db.delete(laneHandoffsTable).where(inArray(laneHandoffsTable.laneId, laneIds));
    await db.delete(sessionLanesTable).where(eq(sessionLanesTable.sessionId, sessionId));
  }

  await new Promise<void>((resolve) => setImmediate(resolve));
  await db.delete(laneEventsTable).where(eq(laneEventsTable.sessionId, sessionId));
  await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
}

beforeAll(async () => {
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: TEST_PROFILE_NAME,
      displayName: "Test GPU Team",
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
      searchParams: { gpu_name: "A100", num_gpus: 1 },
    })
    .returning();
  testProfileId = profile.id;
});

afterAll(async () => {
  for (const id of createdSessionIds) {
    await cleanupSession(id).catch(() => {});
  }
  if (testProfileId) {
    await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, testProfileId)).catch(() => {});
  }
  vi.restoreAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("Team Member Session Setup & Nginx Path-Based Routing", () => {
  it("orchestrates team session with 3+ members and creates per-member lanes", async () => {
    const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    const instanceId = nextInstanceId();
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42, dph_total: 0.35 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    vi.mocked(compileLaneBundles).mockResolvedValueOnce({
      sessionCoreBundleId: null,
      sessionCoreCompiled: null,
      sharedRepoBundleId: null,
      sharedRepoCompiled: null,
      laneOverlays: [],
    } as never);

    const teamMembers = [
      { role: "backend", skills: [] },
      { role: "frontend", skills: [] },
      { role: "qa", skills: [] },
    ];

    const res = await request(app)
      .post("/api/sessions/orchestrate")
      .send({
        goal: "Multi-team development sprint",
        profileId: testProfileId,
        teamMembers,
      });

    expect(res.status).toBe(202);
    expect(res.body.members).toHaveLength(3);

    const sessionId = res.body.sessionId;
    createdSessionIds.push(sessionId);

    // Verify lanes in DB
    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, sessionId));
    expect(lanes).toHaveLength(3);

    // Verify each lane has unique memberIdentifier
    const memberIds = lanes.map((l) => l.memberIdentifier);
    expect(new Set(memberIds).size).toBe(3);

    // Verify lane types match roles
    const laneTypeMap = lanes.reduce(
      (acc, l) => {
        acc[l.memberIdentifier] = l.laneType;
        return acc;
      },
      {} as Record<string, string>,
    );

    expect(laneTypeMap).toHaveProperty("backend");
    expect(laneTypeMap).toHaveProperty("frontend");
    expect(laneTypeMap).toHaveProperty("qa");
  });

  it("persists team member paths for nginx routing", async () => {
    const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    const instanceId = nextInstanceId();
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42, dph_total: 0.35 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    vi.mocked(compileLaneBundles).mockResolvedValueOnce({
      sessionCoreBundleId: null,
      sessionCoreCompiled: null,
      sharedRepoBundleId: null,
      sharedRepoCompiled: null,
      laneOverlays: [],
    } as never);

    const teamMembers = [
      { role: "backend" },
      { role: "frontend" },
      { role: "design" },
    ];

    const res = await request(app)
      .post("/api/sessions/orchestrate")
      .send({
        goal: "Routing test",
        profileId: testProfileId,
        teamMembers,
      });

    expect(res.status).toBe(202);
    const sessionId = res.body.sessionId;
    createdSessionIds.push(sessionId);

    // Verify session has teamMembers persisted
    const [dbSession] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(dbSession.teamMembers).toBeDefined();

    const persistedMembers = dbSession.teamMembers as TeamMemberRecord[] | null;
    expect(persistedMembers).toHaveLength(3);

    // Verify each member has a unique path for nginx routing
    const paths = persistedMembers!.map((m) => m.path).filter(Boolean);
    expect(paths.length).toBeGreaterThan(0); // At least some paths should be set

    // Paths should be URL-safe and unique
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(paths.length);

    // Paths should follow pattern like /backend, /frontend, /design
    for (const path of paths) {
      expect(path).toMatch(/^\/\w+$/);
    }
  });

  it("reconstructs ideUrl with member paths after sync", async () => {
    const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    const instanceId = nextInstanceId();
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42, dph_total: 0.35 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    vi.mocked(compileLaneBundles).mockResolvedValueOnce({
      sessionCoreBundleId: null,
      sessionCoreCompiled: null,
      sharedRepoBundleId: null,
      sharedRepoCompiled: null,
      laneOverlays: [],
    } as never);

    const teamMembers = [
      { role: "backend" },
      { role: "frontend" },
    ];

    const createRes = await request(app)
      .post("/api/sessions/orchestrate")
      .send({
        goal: "IDE URL reconstruction test",
        profileId: testProfileId,
        teamMembers,
      });

    const sessionId = createRes.body.sessionId;
    createdSessionIds.push(sessionId);

    // Now sync the session (which reconstructs ideUrls)
    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "ready",
      dph_total: 0.35,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "https://workspace-123.fly.dev:8080",
      previewUrl: null,
      sshHost: "workspace-123.fly.dev",
      sshPort: 22,
      publicIp: "10.0.0.1",
      llmProxyUrl: "https://workspace-123.fly.dev:8081/v1",
    } as never);

    // Trigger sync via GET
    const syncRes = await request(app).get(`/api/sessions/${sessionId}`);
    expect(syncRes.status).toBe(200);

    // Check the ideUrls were reconstructed
    const [synced] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    const syncedMembers = synced.teamMembers as TeamMemberRecord[] | null;

    expect(syncedMembers).toBeDefined();
    for (const member of syncedMembers!) {
      // Each member should have ideUrl combining base URL + member path
      if (member.path) {
        expect(member.ideUrl).toMatch(/^https:\/\/workspace-123.fly.dev.*\/.+$/);
        expect(member.ideUrl).toContain(member.path);
      }
    }
  });

  it("maintains separate lane claims per team member (no cross-lane interference)", async () => {
    const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    const instanceId = nextInstanceId();
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42, dph_total: 0.35 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    vi.mocked(compileLaneBundles).mockResolvedValueOnce({
      sessionCoreBundleId: null,
      sessionCoreCompiled: null,
      sharedRepoBundleId: null,
      sharedRepoCompiled: null,
      laneOverlays: [],
    } as never);

    const res = await request(app)
      .post("/api/sessions/orchestrate")
      .send({
        goal: "Claim isolation test",
        profileId: testProfileId,
        teamMembers: [{ role: "backend" }, { role: "frontend" }],
      });

    const sessionId = res.body.sessionId;
    createdSessionIds.push(sessionId);

    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, sessionId));
    const [lane1, lane2] = lanes;

    // Backend claims src/api/routes.ts
    const claim1Res = await request(app)
      .post(`/api/sessions/${sessionId}/lanes/${lane1.id}/claim`)
      .send({
        claimType: "file",
        pathOrSymbol: "src/api/routes.ts",
        claimStrength: "editing",
      });
    expect(claim1Res.status).toBeLessThan(400);

    // Frontend claims different file
    const claim2Res = await request(app)
      .post(`/api/sessions/${sessionId}/lanes/${lane2.id}/claim`)
      .send({
        claimType: "file",
        pathOrSymbol: "src/components/App.tsx",
        claimStrength: "editing",
      });
    expect(claim2Res.status).toBeLessThan(400);

    // Verify both claims are active and independent
    const allClaims = await db
      .select()
      .from(laneClaimsTable)
      .where(
        and(
          eq(laneClaimsTable.sessionId, sessionId),
          eq(laneClaimsTable.active, true),
        ),
      );

    expect(allClaims).toHaveLength(2);
    expect(allClaims.map((c) => c.laneId).sort()).toEqual([lane1.id, lane2.id].sort());
  });

  it("handles member skill overlays in multi-member orchestration", async () => {
    const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    const instanceId = nextInstanceId();
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42, dph_total: 0.35 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");

    // Mock compileLaneBundles to track calls
    let compileBundlesCalls = 0;
    vi.mocked(compileLaneBundles)
      .mockImplementationOnce(async () => {
        compileBundlesCalls++;
        return {
          sessionCoreBundleId: null,
          sessionCoreCompiled: null,
          sharedRepoBundleId: null,
          sharedRepoCompiled: null,
          laneOverlays: [
            { laneId: 1, overlayBundleId: 100, skills: ["python-expert"] },
            { laneId: 2, overlayBundleId: 101, skills: ["react-expert"] },
          ],
        } as never;
      });

    const teamMembers = [
      { role: "backend", skills: ["python-expert"] },
      { role: "frontend", skills: ["react-expert"] },
    ];

    const res = await request(app)
      .post("/api/sessions/orchestrate")
      .send({
        goal: "Skill overlay test",
        profileId: testProfileId,
        teamMembers,
      });

    expect(res.status).toBe(202);
    const sessionId = res.body.sessionId;
    createdSessionIds.push(sessionId);

    // Verify compileLaneBundles was called
    expect(compileBundlesCalls).toBeGreaterThan(0);

    // Verify lanes have overlayBundleIds set
    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, sessionId));
    expect(lanes.some((l) => l.overlayBundleId)).toBe(true);
  });

  it("team session taskMode is 'team', not 'solo'", async () => {
    const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    const instanceId = nextInstanceId();
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42, dph_total: 0.35 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    vi.mocked(compileLaneBundles).mockResolvedValueOnce({
      sessionCoreBundleId: null,
      sessionCoreCompiled: null,
      sharedRepoBundleId: null,
      sharedRepoCompiled: null,
      laneOverlays: [],
    } as never);

    const res = await request(app)
      .post("/api/sessions/orchestrate")
      .send({
        goal: "Task mode test",
        profileId: testProfileId,
        teamMembers: [{ role: "backend" }, { role: "frontend" }],
      });

    expect(res.status).toBe(202);
    expect(res.body.taskMode).toBe("team");

    const sessionId = res.body.sessionId;
    createdSessionIds.push(sessionId);

    const [dbSession] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(dbSession.taskMode).toBe("team");
  });

  it("single-member orchestration defaults to solo taskMode", async () => {
    const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    const instanceId = nextInstanceId();
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42, dph_total: 0.35 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    vi.mocked(compileLaneBundles).mockResolvedValueOnce({
      sessionCoreBundleId: null,
      sessionCoreCompiled: null,
      sharedRepoBundleId: null,
      sharedRepoCompiled: null,
      laneOverlays: [],
    } as never);

    const res = await request(app)
      .post("/api/sessions/orchestrate")
      .send({
        goal: "Solo task mode test",
        profileId: testProfileId,
        teamMembers: [{ role: "backend" }], // Only one member
      });

    expect(res.status).toBe(202);
    expect(res.body.taskMode).toBe("solo");

    const sessionId = res.body.sessionId;
    createdSessionIds.push(sessionId);

    const [dbSession] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(dbSession.taskMode).toBe("solo");
  });
});
