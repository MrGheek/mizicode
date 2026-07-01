/**
 * Unit tests for syncSessionFromVastai state machine
 *
 * Tests the 105-line function that polls Vast.ai for instance status
 * and syncs session state based on:
 * - Instance actual_status (running, loading, creating, exited, error)
 * - Instance status_msg (markers: downloading, starting_llm, llm_ready, services_ready)
 * - Cost tracking (dph_total, cost_run_time)
 * - URL reconstruction (theiaUrl, previewUrl, etc.)
 *
 * Critical paths:
 * - Status state machine (provisioning → downloading → starting → ready)
 * - Fallback heuristic (if "success" status after 30+ min, assume ready)
 * - Cost calculation (vastCumulativeCost vs. computed from dph_total × hours)
 * - Team member ideUrl reconstruction
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db, gpuProfilesTable, sessionsTable, TeamMemberRecord } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─── Mock Vast.ai service ──────────────────────────────────────────────────────

vi.mock("../services/vastai", () => ({
  getInstance: vi.fn(),
  buildInstanceUrls: vi.fn(),
}));

// ─── Import the function to test ────────────────────────────────────────────────

// We need to extract syncSessionFromVastai from sessions.ts
// For now, we'll test it indirectly via the GET /sessions/:id endpoint
// which calls syncSessionFromVastai internally
import request from "supertest";
import app from "../app";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

let testProfileId: number;
const TEST_PROFILE_NAME = `test-profile-vastai-sync-${Date.now()}`;
const createdSessionIds: number[] = [];

async function createTestSession(
  vastInstanceId: number,
  provider: "vastai" | "nim" = "vastai",
  startedAt?: Date,
  teamMembers?: TeamMemberRecord[],
) {
  const [session] = await db
    .insert(sessionsTable)
    .values({
      profileId: testProfileId,
      status: "provisioning",
      provider,
      vastInstanceId,
      startedAt: startedAt || new Date(),
      teamMembers: teamMembers || null,
    })
    .returning();
  createdSessionIds.push(session.id);
  return session;
}

async function cleanup() {
  for (const id of createdSessionIds) {
    await db.delete(sessionsTable).where(eq(sessionsTable.id, id)).catch(() => {});
  }
  if (testProfileId) {
    await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, testProfileId)).catch(() => {});
  }
}

beforeAll(async () => {
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: TEST_PROFILE_NAME,
      displayName: "Test GPU Vastai Sync",
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
});

afterAll(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("syncSessionFromVastai State Machine", () => {
  it("transitions from provisioning to downloading when status_msg contains 'downloading'", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    const session = await createTestSession(9900);
    const sessionId = session.id;

    // Mock Vast.ai response: instance is running with "downloading" status
    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "downloading model weights...",
      dph_total: 0.35,
      cost_run_time: 0,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "http://mock-host:8080",
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: "http://mock-host:8081/v1",
    } as never);

    // Trigger sync via GET /sessions/:id
    const res = await request(app).get(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);

    // Check DB for updated status
    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(updated.status).toBe("downloading");
    expect(updated.statusMessage).toContain("model");
  });

  it("transitions to starting when status_msg contains 'starting_llm'", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    const session = await createTestSession(9901);
    const sessionId = session.id;

    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "starting_llm server...",
      dph_total: 0.35,
      cost_run_time: 0,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "http://mock-host:8080",
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: "http://mock-host:8081/v1",
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(updated.status).toBe("starting");
    expect(updated.statusMessage).toContain("GPU");
  });

  it("transitions to ready when status_msg contains 'llm_ready'", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    const session = await createTestSession(9902);
    const sessionId = session.id;

    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "llm_ready",
      dph_total: 0.35,
      cost_run_time: 5.25, // Cumulative cost
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "http://mock-host:8080",
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: "http://mock-host:8081/v1",
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(updated.status).toBe("ready");
    expect(updated.theiaUrl).toBe("http://mock-host:8080");
  });

  it("handles provisioning instance state (loading, creating)", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    const session = await createTestSession(9903);
    const sessionId = session.id;

    // Test "loading" state
    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "loading",
      status_msg: "Booting instance...",
      dph_total: 0.35,
      cost_run_time: 0,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      codeServerUrl: null,
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: null,
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    let [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(updated.status).toBe("provisioning");

    // Test "creating" state
    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "creating",
      status_msg: "Provisioning compute resources...",
      dph_total: 0.35,
      cost_run_time: 0,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: null,
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: null,
      llmProxyUrl: null,
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(updated.status).toBe("provisioning");
  });

  it("transitions to error when instance state is exited or error", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    const session = await createTestSession(9904);
    const sessionId = session.id;

    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "exited",
      status_msg: "Instance shut down by user",
      dph_total: 0.35,
      cost_run_time: 12.5,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: null,
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: null,
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    expect(updated.status).toBe("error");
    expect(updated.statusMessage).toContain("Instance error");
  });

  it("calculates cumulative cost from vastCumulativeCost when available", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    const session = await createTestSession(9905);
    const sessionId = session.id;

    // Vast.ai provides cumulative cost_run_time
    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "llm_ready",
      dph_total: 0.35,
      cost_run_time: 17.85, // Cumulative cost ($17.85)
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "http://mock-host:8080",
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: "http://mock-host:8081/v1",
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    // Should use cost_run_time directly
    expect(updated.totalCost).toBeCloseTo(17.85, 1);
  });

  it("calculates cost from dph_total × hours when cumulative cost unavailable", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    // Start session 2 hours ago
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const session = await createTestSession(9906, "vastai", startedAt);
    const sessionId = session.id;

    // Vast.ai only provides hourly rate, no cumulative cost_run_time
    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "running",
      dph_total: 0.5, // $0.50/hr
      cost_run_time: null, // Not available
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "http://mock-host:8080",
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: "http://mock-host:8081/v1",
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    // Should compute: 0.5 (dph) × ~2 (hours) = ~1.0
    expect(updated.totalCost).toBeGreaterThanOrEqual(0.9);
    expect(updated.totalCost).toBeLessThanOrEqual(1.1);
  });

  it("applies 30+ min heuristic: 'success' status auto-marks ready if no callback", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    // Start session 35 minutes ago (past the 30 min threshold)
    const startedAt = new Date(Date.now() - 35 * 60 * 1000);
    const session = await createTestSession(9907, "vastai", startedAt);
    const sessionId = session.id;

    // Vast.ai reports "success" but no callback has been received yet
    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "success, running image v1.0.0",
      dph_total: 0.35,
      cost_run_time: 20.5,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "http://mock-host:8080",
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: "http://mock-host:8081/v1",
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    // Should auto-transition to ready after 30+ min of "success"
    expect(updated.status).toBe("ready");
  });

  it("does not auto-mark ready if under 30 minutes despite success status", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    // Start session only 10 minutes ago
    const startedAt = new Date(Date.now() - 10 * 60 * 1000);
    const session = await createTestSession(9908, "vastai", startedAt);
    const sessionId = session.id;

    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "success, running",
      dph_total: 0.35,
      cost_run_time: 5.8,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "http://mock-host:8080",
      previewUrl: null,
      sshHost: "mock-host",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: "http://mock-host:8081/v1",
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    // Should NOT auto-transition; stay in current state
    expect(updated.status).toBe("provisioning");
  });

  it("reconstructs team member ideUrl from theiaUrl", async () => {
    const { getInstance, buildInstanceUrls } = await import("../services/vastai");

    const teamMembers: TeamMemberRecord[] = [
      { name: "backend", path: "/backend", ideUrl: null, password: "test" },
      { name: "frontend", path: "/frontend", ideUrl: null, password: "test" },
    ];

    const session = await createTestSession(9909, "vastai", undefined, teamMembers);
    const sessionId = session.id;

    vi.mocked(getInstance).mockResolvedValueOnce({
      actual_status: "running",
      status_msg: "llm_ready",
      dph_total: 0.35,
      cost_run_time: 8.5,
    } as never);

    vi.mocked(buildInstanceUrls).mockReturnValueOnce({
      theiaUrl: "http://instance.fly.dev:8080",
      previewUrl: null,
      sshHost: "instance.fly.dev",
      sshPort: 22,
      publicIp: "1.2.3.4",
      llmProxyUrl: "http://instance.fly.dev:8081/v1",
    } as never);

    await request(app).get(`/api/sessions/${sessionId}`);

    const [updated] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    const updatedMembers = updated.teamMembers as TeamMemberRecord[] | null;

    expect(updatedMembers).toBeDefined();
    expect(updatedMembers?.[0].ideUrl).toBe("http://instance.fly.dev:8080/backend");
    expect(updatedMembers?.[1].ideUrl).toBe("http://instance.fly.dev:8080/frontend");
  });

  it("skips sync if vastInstanceId is null or session not in active status", async () => {
    const { getInstance } = await import("../services/vastai");

    // Create session with no vastInstanceId
    const [session] = await db
      .insert(sessionsTable)
      .values({
        profileId: testProfileId,
        status: "ready", // Active status, but no vastInstanceId
        vastInstanceId: null,
      })
      .returning();
    createdSessionIds.push(session.id);

    await request(app).get(`/api/sessions/${session.id}`);

    // getInstance should NOT be called
    expect(vi.mocked(getInstance)).not.toHaveBeenCalled();
  });
});
