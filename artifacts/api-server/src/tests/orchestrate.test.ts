/**
 * Tests for POST /sessions/orchestrate and GET /sessions/:id/orchestration-status
 *
 * Covers:
 * - Happy path end-to-end (mocked Vast.ai + bridge)
 * - Per-member skill bundles: member.skills → overlayBundleId persisted on lane
 * - Idempotency: second identical call within 5 min returns existing session
 * - Failure teardown: createInstance failure (no teardown) vs post-instance failure
 *   (destroyInstance called)
 * - Pre-registered file claims
 * - Input validation
 * - Status polling endpoint
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import app from "../app";
import { db, gpuProfilesTable, sessionsTable, sessionLanesTable, laneClaimsTable, skillBundlesTable } from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";

// ─── Mock Vast.ai ──────────────────────────────────────────────────────────────
// vastInstanceId is an integer column — new_contract must be numeric.

vi.mock("../services/vastai", () => ({
  searchOffers: vi.fn().mockResolvedValue([{ id: 42, dph_total: 0.35 }]),
  createInstance: vi.fn().mockResolvedValue({ new_contract: 9900, expected_price: 0.35 }),
  destroyInstance: vi.fn().mockResolvedValue({}),
  getInstance: vi.fn().mockResolvedValue({ actual_status: "running", status_msg: "llm_ready", dph_total: 0.35 }),
  buildInstanceUrls: vi.fn().mockReturnValue({ codeServerUrl: "http://mock-host:8080", boltDiyUrl: null, previewUrl: null, sshHost: "mock-host", sshPort: 22, publicIp: "1.2.3.4" }),
  buildOnStartScript: vi.fn().mockReturnValue("#!/bin/bash\necho mocked"),
}));

vi.mock("../services/bridge-registry", () => ({
  getBridgeStatus: vi.fn().mockReturnValue("disconnected"),
  registerBridgeConnection: vi.fn(),
  unregisterBridgeConnection: vi.fn(),
}));

// ─── Mock skills bundler (use controlled implementations) ─────────────────────

vi.mock("../services/skills-bundler", async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    seedDefaultBundles: vi.fn().mockResolvedValue(undefined),
    getDefaultBundleForContext: vi.fn().mockResolvedValue(null),
    compileBundle: vi.fn().mockResolvedValue({ skills: [], systemPrompt: "mock", totalTokens: 10, compiledAt: new Date().toISOString() }),
    buildActiveBundleEnvPayload: vi.fn().mockReturnValue(""),
    recordSessionActivation: vi.fn().mockResolvedValue(undefined),
    compileLaneBundles: vi.fn().mockResolvedValue({ sessionCoreBundleId: null, sessionCoreCompiled: null, sharedRepoBundleId: null, sharedRepoCompiled: null, laneOverlays: [] }),
  };
});

// ─── Fixtures ──────────────────────────────────────────────────────────────────

let testProfileId: number;
const TEST_PROFILE_NAME = `test-profile-orchestrate-${Date.now()}`;
const createdSessionIds: number[] = [];

// Counter to generate unique vast instance IDs per test
let mockInstanceCounter = 9900;
function nextInstanceId(): number {
  return ++mockInstanceCounter;
}

async function cleanupSession(sessionId: number) {
  const lanes = await db
    .select({ id: sessionLanesTable.id })
    .from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId));
  const laneIds = lanes.map((l) => l.id);
  if (laneIds.length > 0) {
    await db.delete(laneClaimsTable).where(inArray(laneClaimsTable.laneId, laneIds));
    await db.delete(sessionLanesTable).where(eq(sessionLanesTable.sessionId, sessionId));
  }
  await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
}

beforeAll(async () => {
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: TEST_PROFILE_NAME,
      displayName: "Test Orchestrate GPU",
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

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    goal: "Build a feature-complete auth module",
    profileId: testProfileId,
    teamMembers: [
      { role: "backend" },
      { role: "ux" },
    ],
    ...overrides,
  };
}

async function orchestrate(body: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/sessions/orchestrate")
    .send(body);
}

/** Set up mocks for one happy-path orchestrate call and return the instance ID used. */
async function setupHappyMocks(instanceId = nextInstanceId()) {
  const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
  const { compileLaneBundles } = await import("../services/skills-bundler");
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
  return instanceId;
}

// ─── Input validation ──────────────────────────────────────────────────────────

describe("POST /api/sessions/orchestrate — validation", () => {
  it("returns 400 when goal is missing", async () => {
    const res = await orchestrate({ profileId: testProfileId, teamMembers: [{ role: "backend" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/goal/i);
  });

  it("returns 400 when profileId is missing", async () => {
    const res = await orchestrate({ goal: "test", teamMembers: [{ role: "backend" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profileId/i);
  });

  it("returns 400 when teamMembers is empty", async () => {
    const res = await orchestrate({ goal: "test", profileId: testProfileId, teamMembers: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/teamMembers/i);
  });

  it("returns 400 when teamMembers is not an array", async () => {
    const res = await orchestrate({ goal: "test", profileId: testProfileId, teamMembers: "backend" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/teamMembers/i);
  });

  it("returns 400 for an invalid profileId", async () => {
    const res = await orchestrate({ goal: "test", profileId: 999999999, teamMembers: [{ role: "backend" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profile/i);
  });

  it("returns 400 when a member role fails the safe-name regex", async () => {
    const res = await orchestrate({ goal: "test", profileId: testProfileId, teamMembers: [{ role: "INVALID ROLE!" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(res.body.error).toMatch(/role/i);
  });

  it("returns 400 when a member role is a reserved name", async () => {
    for (const reserved of ["admin", "root", "owner", "__shared__", "shared"]) {
      const res = await orchestrate({ goal: "test", profileId: testProfileId, teamMembers: [{ role: reserved }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid/i);
    }
  });

  it("returns 400 when a member role is an empty string", async () => {
    const res = await orchestrate({ goal: "test", profileId: testProfileId, teamMembers: [{ role: "" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role/i);
  });
});

// ─── Happy path ────────────────────────────────────────────────────────────────

describe("POST /api/sessions/orchestrate — happy path", () => {
  it("provisions session and lanes, returns 202 with member list and session fields", async () => {
    const instanceId = await setupHappyMocks();

    const res = await orchestrate(baseBody());
    expect(res.status).toBe(202);

    const body = res.body as {
      sessionId: number;
      status: string;
      vastInstanceId: number | null;
      profile: { id: number; name: string; gpuName: string; numGpus: number };
      goal: string;
      taskMode: string;
      members: Array<{ laneId: number; memberIdentifier: string; role: string; overlayBundleId: number | null; skills: string[]; claimPaths: string[] }>;
      sessionCoreBundleId: number | null;
      message: string;
    };
    expect(body.status).toBe("provisioning");
    expect(typeof body.sessionId).toBe("number");
    expect(body.vastInstanceId).toBe(instanceId);
    expect(body.goal).toBe("Build a feature-complete auth module");
    expect(body.taskMode).toBe("team");
    expect(body.profile.gpuName).toBe("A100");
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members).toHaveLength(2);

    createdSessionIds.push(body.sessionId);

    // Verify session in DB
    const [dbSession] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, body.sessionId));
    expect(dbSession).toBeDefined();
    expect(dbSession.status).toBe("provisioning");
    expect(dbSession.vastInstanceId).toBe(instanceId);
    expect(dbSession.intentText).toBe("Build a feature-complete auth module");
    expect(dbSession.taskMode).toBe("team");

    // Verify lanes in DB
    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, body.sessionId));
    expect(lanes).toHaveLength(2);
    const memberIds = lanes.map((l) => l.memberIdentifier);
    expect(memberIds).toContain("backend");
    expect(memberIds).toContain("ux");

    // Lanes must be "pending" at creation time — they become "active" only after
    // the GPU instance fires the llm_ready callback (PUT /sessions/:id/instance-status).
    for (const lane of lanes) {
      expect(lane.status).toBe("pending");
    }
  });

  it("attaches correct lane types from member roles", async () => {
    await setupHappyMocks();

    const res = await orchestrate(baseBody({
      goal: "Lane type test",
      teamMembers: [{ role: "debug" }, { role: "review" }],
    }));
    expect(res.status).toBe(202);
    createdSessionIds.push(res.body.sessionId);

    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, res.body.sessionId));
    const laneTypes = lanes.map((l) => l.laneType);
    expect(laneTypes).toContain("debug");
    expect(laneTypes).toContain("review");
  });

  it("unknown role falls back to 'general' lane type", async () => {
    await setupHappyMocks();

    const res = await orchestrate(baseBody({
      goal: "Fallback lane type test",
      teamMembers: [{ role: "teleporter" }],
    }));
    expect(res.status).toBe(202);
    createdSessionIds.push(res.body.sessionId);

    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, res.body.sessionId));
    expect(lanes[0].laneType).toBe("general");
  });

  it("propagates goal as intentText and as currentTask on each lane", async () => {
    await setupHappyMocks();
    const goal = `Specific goal ${Date.now()}`;

    const res = await orchestrate(baseBody({ goal, teamMembers: [{ role: "backend" }] }));
    expect(res.status).toBe(202);
    createdSessionIds.push(res.body.sessionId);

    const [dbSession] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, res.body.sessionId));
    expect(dbSession.intentText).toBe(goal);

    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, res.body.sessionId));
    expect(lanes[0].currentTask).toMatch(goal.slice(0, 50));
  });
});

// ─── Per-member skill overlays ─────────────────────────────────────────────────

describe("POST /api/sessions/orchestrate — per-member skill overlays", () => {
  it("creates an ephemeral bundle for member.skills and sets overlayBundleId on the lane", async () => {
    await setupHappyMocks();

    const res = await orchestrate(baseBody({
      goal: `Skills overlay test ${Date.now()}`,
      teamMembers: [
        { role: "backend", skills: ["mizi-builder", "karpathy-doctrine"] },
        { role: "ux" },
      ],
    }));
    expect(res.status).toBe(202);
    createdSessionIds.push(res.body.sessionId);

    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, res.body.sessionId));
    const backendLane = lanes.find((l) => l.memberIdentifier === "backend");
    const uxLane = lanes.find((l) => l.memberIdentifier === "ux");

    expect(backendLane).toBeDefined();
    expect(backendLane!.overlayBundleId).not.toBeNull();

    // Verify the ephemeral bundle was created with the correct skill IDs
    const [bundle] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, backendLane!.overlayBundleId!));
    expect(bundle).toBeDefined();
    expect(bundle.isDefault).toBe(false);
    const bundleJson = bundle.bundleJson as { skillIds?: string[] };
    expect(bundleJson.skillIds).toContain("karpathy-doctrine");
    expect(bundleJson.skillIds).toContain("mizi-builder");

    // UX lane with no explicit skills should have whatever compileLaneBundles returned (null in mock)
    expect(uxLane).toBeDefined();
    expect(uxLane!.overlayBundleId).toBeNull();

    // Response body should include skills and overlayBundleId for the backend member
    const responseBackend = res.body.members.find((m: { memberIdentifier: string }) => m.memberIdentifier === "backend");
    expect(responseBackend).toBeDefined();
    expect(responseBackend.overlayBundleId).toBe(backendLane!.overlayBundleId);
    expect(responseBackend.skills).toEqual(expect.arrayContaining(["mizi-builder", "karpathy-doctrine"]));
  });

  it("reuses the same ephemeral bundle for identical skill sets across sessions", async () => {
    const skills = ["mizi-builder"];
    const role = "backend";

    await setupHappyMocks();
    const first = await orchestrate(baseBody({
      goal: `Reuse bundle test A ${Date.now()}`,
      teamMembers: [{ role, skills }],
    }));
    expect(first.status).toBe(202);
    createdSessionIds.push(first.body.sessionId);

    const lanesA = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, first.body.sessionId));
    const bundleIdA = lanesA[0].overlayBundleId;
    expect(bundleIdA).not.toBeNull();

    await setupHappyMocks();
    const second = await orchestrate(baseBody({
      goal: `Reuse bundle test B ${Date.now()}`,
      teamMembers: [{ role, skills }],
    }));
    expect(second.status).toBe(202);
    createdSessionIds.push(second.body.sessionId);

    const lanesB = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, second.body.sessionId));
    const bundleIdB = lanesB[0].overlayBundleId;

    // Both sessions should reuse the same ephemeral bundle row
    expect(bundleIdB).toBe(bundleIdA);
  });

  it("members with no skills get null overlayBundleId when compileLaneBundles returns no overlays", async () => {
    await setupHappyMocks();

    const res = await orchestrate(baseBody({
      goal: `No skills test ${Date.now()}`,
      teamMembers: [{ role: "review" }],
    }));
    expect(res.status).toBe(202);
    createdSessionIds.push(res.body.sessionId);

    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, res.body.sessionId));
    expect(lanes[0].overlayBundleId).toBeNull();
  });
});

// ─── Pre-registered file claims ────────────────────────────────────────────────

describe("POST /api/sessions/orchestrate — pre-registered file claims", () => {
  it("inserts lane_claims for members with claimPaths", async () => {
    await setupHappyMocks();

    const res = await orchestrate(baseBody({
      goal: "File claims test",
      teamMembers: [
        { role: "backend", claimPaths: ["src/routes/auth.ts", "src/routes/users.ts"] },
        { role: "ux" },
      ],
    }));
    expect(res.status).toBe(202);
    createdSessionIds.push(res.body.sessionId);

    const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, res.body.sessionId));
    const backendLane = lanes.find((l) => l.memberIdentifier === "backend");
    expect(backendLane).toBeDefined();

    const claims = await db.select().from(laneClaimsTable).where(eq(laneClaimsTable.laneId, backendLane!.id));
    expect(claims).toHaveLength(2);
    const paths = claims.map((c) => c.pathOrSymbol);
    expect(paths).toContain("src/routes/auth.ts");
    expect(paths).toContain("src/routes/users.ts");
    expect(claims[0].claimStrength).toBe("owner");
    expect(claims[0].active).toBe(true);

    // UX lane should have no claims
    const uxLane = lanes.find((l) => l.memberIdentifier === "ux");
    expect(uxLane).toBeDefined();
    const uxClaims = await db.select().from(laneClaimsTable).where(eq(laneClaimsTable.laneId, uxLane!.id));
    expect(uxClaims).toHaveLength(0);
  });

  it("members with no claimPaths have empty claim list in response", async () => {
    await setupHappyMocks();

    const res = await orchestrate(baseBody({
      goal: "No claims test",
      teamMembers: [{ role: "review" }],
    }));
    expect(res.status).toBe(202);
    createdSessionIds.push(res.body.sessionId);

    expect(res.body.members[0].claimPaths).toEqual([]);
  });
});

// ─── Idempotency ───────────────────────────────────────────────────────────────

describe("POST /api/sessions/orchestrate — idempotency", () => {
  it("returns the same session on a second identical call within 5 minutes", async () => {
    await setupHappyMocks();

    const goal = `Idempotency test goal ${Date.now()}`;
    const body = baseBody({ goal });

    const first = await orchestrate(body);
    expect(first.status).toBe(202);
    createdSessionIds.push(first.body.sessionId);

    // Clear call counts to isolate second call's behaviour
    const { createInstance } = await import("../services/vastai");
    vi.mocked(createInstance).mockClear();

    // Second call — same body, should hit idempotency cache
    const second = await orchestrate(body);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.sessionId).toBe(first.body.sessionId);

    // No new GPU instance should be created
    expect(vi.mocked(createInstance)).not.toHaveBeenCalled();
  });

  it("creates a new session when goal differs", async () => {
    const ts = Date.now();

    await setupHappyMocks();
    const first = await orchestrate(baseBody({ goal: `Goal A ${ts}` }));
    expect(first.status).toBe(202);
    createdSessionIds.push(first.body.sessionId);

    await setupHappyMocks();
    const second = await orchestrate(baseBody({ goal: `Goal B ${ts}` }));
    expect(second.status).toBe(202);
    createdSessionIds.push(second.body.sessionId);

    expect(second.body.sessionId).not.toBe(first.body.sessionId);
  });

  it("creates a new session when team composition differs", async () => {
    const ts = Date.now();
    const sharedGoal = `Same goal ${ts}`;

    await setupHappyMocks();
    const first = await orchestrate(baseBody({ goal: sharedGoal, teamMembers: [{ role: "backend" }] }));
    expect(first.status).toBe(202);
    createdSessionIds.push(first.body.sessionId);

    await setupHappyMocks();
    const second = await orchestrate(baseBody({ goal: sharedGoal, teamMembers: [{ role: "ux" }] }));
    expect(second.status).toBe(202);
    createdSessionIds.push(second.body.sessionId);

    expect(second.body.sessionId).not.toBe(first.body.sessionId);
  });
});

// ─── Failure teardown ──────────────────────────────────────────────────────────

describe("POST /api/sessions/orchestrate — failure teardown", () => {
  it("returns 400 when searchOffers returns empty (no GPU available)", async () => {
    const { searchOffers } = await import("../services/vastai");
    vi.mocked(searchOffers).mockResolvedValueOnce([] as never);

    const res = await orchestrate(baseBody({ goal: `No offers test ${Date.now()}` }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no gpu offers/i);
  });

  it("returns 500 without calling destroyInstance when createInstance throws (no instance to clean up)", async () => {
    const { searchOffers, createInstance, destroyInstance } = await import("../services/vastai");
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42 } as never]);
    vi.mocked(createInstance).mockRejectedValueOnce(new Error("Vast.ai unavailable"));
    // NOTE: compileLaneBundles is NOT mocked here because the route throws before reaching it.

    const res = await orchestrate(baseBody({ goal: `CreateInstance fail ${Date.now()}` }));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Orchestration failed/i);

    // destroyInstance should NOT be called — instance was never created
    expect(vi.mocked(destroyInstance)).not.toHaveBeenCalled();
  });

  it("calls destroyInstance and marks session as error when compileLaneBundles fails after createInstance", async () => {
    // compileLaneBundles runs in the main try block AFTER createInstance.
    // Throwing here means vastInstanceId is set → teardown triggers destroyInstance.
    const instanceId = nextInstanceId();
    const { searchOffers, createInstance, destroyInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    // compileLaneBundles fails AFTER the instance was created
    vi.mocked(compileLaneBundles).mockRejectedValueOnce(new Error("Skills service unavailable"));

    const res = await orchestrate(baseBody({ goal: `Teardown trigger test ${Date.now()}` }));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Orchestration failed/i);

    // Instance was created before compileLaneBundles threw → destroyInstance must be called
    expect(vi.mocked(destroyInstance)).toHaveBeenCalledWith(instanceId);
    expect(vi.mocked(destroyInstance)).toHaveBeenCalledTimes(1);
  });

  it("still returns 500 when both compileLaneBundles and destroyInstance throw", async () => {
    // Exercises the inner catch around destroyInstance (line 734 branch)
    const instanceId = nextInstanceId();
    const { searchOffers, createInstance, destroyInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");

    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: instanceId, expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    vi.mocked(compileLaneBundles).mockRejectedValueOnce(new Error("Skills unavailable"));
    vi.mocked(destroyInstance).mockRejectedValueOnce(new Error("Vast.ai destroy failed"));

    const res = await orchestrate(baseBody({ goal: `Destroy fail teardown ${Date.now()}` }));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Orchestration failed/i);
    expect(vi.mocked(destroyInstance)).toHaveBeenCalledWith(instanceId);
  });
});

// ─── Orchestration status polling ─────────────────────────────────────────────

describe("GET /api/sessions/:id/orchestration-status", () => {
  let pollingSessionId: number;

  beforeAll(async () => {
    const { searchOffers, createInstance, buildOnStartScript } = await import("../services/vastai");
    const { compileLaneBundles } = await import("../services/skills-bundler");
    vi.mocked(searchOffers).mockResolvedValueOnce([{ id: 42, dph_total: 0.35 } as never]);
    vi.mocked(createInstance).mockResolvedValueOnce({ new_contract: nextInstanceId(), expected_price: 0.35 } as never);
    vi.mocked(buildOnStartScript).mockReturnValueOnce("#!/bin/bash\necho mocked");
    vi.mocked(compileLaneBundles).mockResolvedValueOnce({ sessionCoreBundleId: null, sessionCoreCompiled: null, sharedRepoBundleId: null, sharedRepoCompiled: null, laneOverlays: [] } as never);

    const res = await orchestrate(baseBody({ goal: `Polling status test ${Date.now()}` }));
    expect(res.status).toBe(202);
    pollingSessionId = res.body.sessionId;
    createdSessionIds.push(pollingSessionId);
  });

  it("returns 200 with status fields for a provisioning session", async () => {
    const res = await request(app).get(`/api/sessions/${pollingSessionId}/orchestration-status`);
    expect(res.status).toBe(200);
    const body = res.body as {
      sessionId: number;
      status: string;
      bootPhase: string;
      bootMessage: string | null;
      vastInstanceId: number | null;
      lanes: Array<{ laneId: number; memberIdentifier: string; bridgeStatus: string; overlayBundleId: number | null }>;
      error: string | null;
    };
    expect(body.sessionId).toBe(pollingSessionId);
    expect(body.status).toBe("provisioning");
    expect(body.bootPhase).toBe("provisioning");
    expect(Array.isArray(body.lanes)).toBe(true);
    expect(body.lanes).toHaveLength(2);
    expect(body.error).toBeNull();

    for (const lane of body.lanes) {
      expect(lane.bridgeStatus).toBe("disconnected");
      expect(typeof lane.laneId).toBe("number");
    }
  });

  it("returns 'ready' or 'provisioning' status when bootPhase is ready (depends on bridge connections)", async () => {
    await db.update(sessionsTable)
      .set({ status: "ready", statusMessage: "Session is ready — vLLM online", codeServerUrl: "http://mock:8080" })
      .where(eq(sessionsTable.id, pollingSessionId));

    const res = await request(app).get(`/api/sessions/${pollingSessionId}/orchestration-status`);
    expect(res.status).toBe(200);
    expect(res.body.bootPhase).toBe("ready");
    expect(res.body.error).toBeNull();
    // Without bridge connections, effectiveStatus stays "provisioning"
    // once all bridges connect it becomes "ready"
    expect(["ready", "provisioning"]).toContain(res.body.status);
  });

  it("returns 'error' status and error message when session failed", async () => {
    await db.update(sessionsTable)
      .set({ status: "error", statusMessage: "boot_failure:vllm_warmup_failed: vLLM did not respond" })
      .where(eq(sessionsTable.id, pollingSessionId));

    const res = await request(app).get(`/api/sessions/${pollingSessionId}/orchestration-status`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(res.body.error).toMatch(/vllm_warmup_failed/);
  });

  it("returns 404 for a non-existent session", async () => {
    const res = await request(app).get("/api/sessions/999999999/orchestration-status");
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid session ID", async () => {
    const res = await request(app).get("/api/sessions/not-a-number/orchestration-status");
    expect(res.status).toBe(400);
  });

  it("returns 500 when an unexpected error occurs fetching status", async () => {
    const { getBridgeStatus } = await import("../services/bridge-registry");
    vi.mocked(getBridgeStatus).mockImplementationOnce(() => {
      throw new Error("Bridge registry failure");
    });

    const res = await request(app).get(`/api/sessions/${pollingSessionId}/orchestration-status`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to fetch orchestration status/i);
  });
});
