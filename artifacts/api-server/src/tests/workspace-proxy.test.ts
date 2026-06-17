/**
 * workspace-proxy.test.ts
 *
 * Verifies that concurrent NIM sessions each have their own independent
 * workspace proxy pointing exclusively to their own Fly Machine.
 *
 * The proxy connects directly to Fly 6PN hostnames via getMachineProxyUrl,
 * which returns http://<machineId>.vm.<appName>.internal:8789 (nginx no-auth
 * proxy on the workspace machine that forwards to wrangler on :8788).
 *
 * Covers:
 *   1. getWorkspaceProxy — target URL is the 6PN .internal hostname
 *   2. getWorkspaceProxy — same machineId returns cached proxy instance
 *   3. getWorkspaceProxy — two different machineIds → two distinct proxy instances
 *   4. Route: session with flyMachineId → proxy invoked with correct target
 *   5. Route: session without flyMachineId → 404
 *   6. Route: missing FLY_WORKSPACE_APP_NAME env var → 500
 *   7. Route: two concurrent sessions → two distinct proxy targets (isolation check)
 */

import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";

// ── Mock http-proxy-middleware ─────────────────────────────────────────────────
// Must be declared before any app/sessions imports so vi.mock hoisting resolves
// createProxyMiddleware to our stub when sessions.ts is first evaluated.
//
// The stub captures the target option and returns a lightweight Express
// middleware that serialises {proxied:true, target} as JSON so tests can
// assert on the exact address that would be used.

vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: vi.fn((options: { target: string }) => {
    const target = String(options.target);
    const mw = (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }, _next: unknown) => {
      res.status(200).json({ proxied: true, target });
    };
    (mw as unknown as Record<string, unknown>)["__proxyTarget"] = target;
    return mw;
  }),
  // responseInterceptor is used by getWorkspaceProxy for HTML path rewriting.
  // In tests the proxy itself is mocked so the handler never runs; we only need
  // the factory to not throw when called during proxy creation.
  responseInterceptor: vi.fn((_interceptor: unknown) => vi.fn()),
}));

// ── Mock fly.getMachineProxyUrl / stopMachineProxy ────────────────────────────
// getMachineProxyUrl is the current implementation — it returns a deterministic
// 6PN hostname (no subprocess).  We let the real implementation run; it just
// builds a string, so no network calls are made.  stopMachineProxy is a no-op
// stub kept for evictWorkspaceProxy call-site compatibility.

vi.mock("../services/fly", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/fly")>();
  return {
    ...original,
    stopMachineProxy: vi.fn(),
  };
});

import app from "../app";
import { db, gpuProfilesTable, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getWorkspaceProxy, evictWorkspaceProxy } from "../routes/sessions";

// ─── DB fixtures ───────────────────────────────────────────────────────────────

const PROFILE_NAME = `test-profile-workspace-proxy-${Date.now()}`;
let testProfileId: number;
let sessionWithMachine: number;
let sessionWithoutMachine: number;
let sessionAlpha: number;
let sessionBeta: number;

const MACHINE_A = `machineaaa${Date.now()}`;
const MACHINE_B = `machinebbb${Date.now()}`;
const WORKSPACE_APP = "mizi-workspace-test";

const origFlyWorkspaceApp = process.env["FLY_WORKSPACE_APP_NAME"];
const origFlyApp = process.env["FLY_APP_NAME"];

beforeAll(async () => {
  // Insert a GPU profile that sessions can reference
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: PROFILE_NAME,
      displayName: "Workspace Proxy Test GPU",
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

  // Session that has a Fly Machine assigned
  const [s1] = await db
    .insert(sessionsTable)
    .values({ profileId: testProfileId, status: "ready", flyMachineId: MACHINE_A })
    .returning();
  sessionWithMachine = s1.id;

  // Session that has no Fly Machine (e.g. a Vast.ai session)
  const [s2] = await db
    .insert(sessionsTable)
    .values({ profileId: testProfileId, status: "ready" })
    .returning();
  sessionWithoutMachine = s2.id;

  // Two concurrent sessions with distinct machines — used for isolation tests
  const [sA] = await db
    .insert(sessionsTable)
    .values({ profileId: testProfileId, status: "ready", flyMachineId: MACHINE_A })
    .returning();
  sessionAlpha = sA.id;

  const [sB] = await db
    .insert(sessionsTable)
    .values({ profileId: testProfileId, status: "ready", flyMachineId: MACHINE_B })
    .returning();
  sessionBeta = sB.id;

  // Point both env vars to the test workspace app so the proxy handler works
  process.env["FLY_WORKSPACE_APP_NAME"] = WORKSPACE_APP;
  delete process.env["FLY_APP_NAME"];
});

afterAll(async () => {
  // Restore env
  if (origFlyWorkspaceApp !== undefined) process.env["FLY_WORKSPACE_APP_NAME"] = origFlyWorkspaceApp;
  else delete process.env["FLY_WORKSPACE_APP_NAME"];
  if (origFlyApp !== undefined) process.env["FLY_APP_NAME"] = origFlyApp;
  else delete process.env["FLY_APP_NAME"];

  // Clean DB rows in dependency order
  for (const id of [sessionWithMachine, sessionWithoutMachine, sessionAlpha, sessionBeta]) {
    await db.delete(sessionsTable).where(eq(sessionsTable.id, id));
  }
  await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, testProfileId));
});

afterEach(() => {
  // Evict proxy cache entries so each test starts with a clean slate
  evictWorkspaceProxy(MACHINE_A);
  evictWorkspaceProxy(MACHINE_B);
});

// ─── Unit tests: getWorkspaceProxy factory ─────────────────────────────────────

describe("getWorkspaceProxy (unit)", () => {
  it("builds target URL as 6PN internal hostname (direct Fly networking)", async () => {
    const proxy = getWorkspaceProxy("machine-abc123", "my-workspace-app");
    expect((proxy as unknown as Record<string, unknown>)["__proxyTarget"]).toMatch(
      /^http:\/\/machine-abc123\.vm\.my-workspace-app\.internal:\d+$/
    );
    evictWorkspaceProxy("machine-abc123");
  });

  it("returns the same proxy instance for the same machineId (cache hit)", () => {
    const first = getWorkspaceProxy("machine-cached", "app-x");
    const second = getWorkspaceProxy("machine-cached", "app-x");
    expect(second).toBe(first);
    evictWorkspaceProxy("machine-cached");
  });

  it("returns distinct proxy instances for two different machineIds", () => {
    const proxyA = getWorkspaceProxy("machine-001", "app-x");
    const proxyB = getWorkspaceProxy("machine-002", "app-x");
    expect(proxyA).not.toBe(proxyB);
    expect((proxyA as unknown as Record<string, unknown>)["__proxyTarget"]).not.toBe(
      (proxyB as unknown as Record<string, unknown>)["__proxyTarget"]
    );
    evictWorkspaceProxy("machine-001");
    evictWorkspaceProxy("machine-002");
  });
});

// ─── Integration tests: /sessions/:id/workspace route ─────────────────────────

describe("GET /api/sessions/:id/workspace", () => {
  it("invokes proxy with 6PN internal hostname when session has flyMachineId", async () => {
    const res = await request(app)
      .get(`/api/sessions/${sessionWithMachine}/workspace`)
      .expect(200);

    expect(res.body).toMatchObject({ proxied: true });
    expect(res.body.target).toMatch(/\.vm\.[^.]+\.internal:\d+$/);
    expect(res.body.target).toContain(MACHINE_A);
  });

  it("returns 404 when session has no flyMachineId", async () => {
    const res = await request(app)
      .get(`/api/sessions/${sessionWithoutMachine}/workspace`)
      .expect(404);

    expect(res.body).toMatchObject({ error: expect.stringContaining("No active workspace machine") });
  });

  it("returns 404 for a non-existent session ID", async () => {
    const res = await request(app)
      .get("/api/sessions/999999999/workspace")
      .expect(404);

    expect(res.body).toMatchObject({ error: expect.stringContaining("No active workspace machine") });
  });

  it("returns 400 for an invalid (non-numeric) session ID", async () => {
    const res = await request(app)
      .get("/api/sessions/not-a-number/workspace")
      .expect(400);

    expect(res.body).toMatchObject({ error: expect.stringContaining("Invalid session ID") });
  });

  it("returns 500 when FLY_WORKSPACE_APP_NAME is not configured", async () => {
    // Temporarily unset both env vars
    delete process.env["FLY_WORKSPACE_APP_NAME"];
    delete process.env["FLY_APP_NAME"];

    const res = await request(app)
      .get(`/api/sessions/${sessionWithMachine}/workspace`)
      .expect(500);

    expect(res.body).toMatchObject({ error: expect.stringContaining("FLY_WORKSPACE_APP_NAME") });

    // Restore for subsequent tests
    process.env["FLY_WORKSPACE_APP_NAME"] = WORKSPACE_APP;
  });
});

// ─── Isolation: two concurrent sessions → two distinct proxy targets ───────────

describe("Concurrent session workspace isolation", () => {
  it("routes session Alpha to its own machine, not Beta's", async () => {
    const resA = await request(app)
      .get(`/api/sessions/${sessionAlpha}/workspace`)
      .expect(200);

    expect(resA.body.target).toMatch(/\.vm\.[^.]+\.internal:\d+$/);
    expect(resA.body.target).toContain(MACHINE_A);
    expect(resA.body.target).not.toContain(MACHINE_B);
  });

  it("routes session Beta to its own machine, not Alpha's", async () => {
    const resB = await request(app)
      .get(`/api/sessions/${sessionBeta}/workspace`)
      .expect(200);

    expect(resB.body.target).toMatch(/\.vm\.[^.]+\.internal:\d+$/);
    expect(resB.body.target).toContain(MACHINE_B);
    expect(resB.body.target).not.toContain(MACHINE_A);
  });

  it("proxy targets for Alpha and Beta are distinct addresses", async () => {
    const [resA, resB] = await Promise.all([
      request(app).get(`/api/sessions/${sessionAlpha}/workspace`).expect(200),
      request(app).get(`/api/sessions/${sessionBeta}/workspace`).expect(200),
    ]);

    expect(resA.body.target).not.toBe(resB.body.target);
  });
});
