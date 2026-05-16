/**
 * Tests for workspace snapshot routes and service.
 *
 * Covers:
 *   GET  /api/sessions/:id/snapshots
 *     - 503 when bridge not connected
 *     - 409 when lane is busy (exec in progress)
 *     - 200 with parsed snapshot list via mock bridge
 *     - 400 when git log exits non-zero via mock bridge
 *   POST /api/sessions/:id/snapshots/:sha/rollback
 *     - 400 for invalid SHA format
 *     - 503 when bridge not connected
 *     - 409 when lane is busy
 *     - 400 when commit subject is not a mizi snapshot (via mock bridge)
 *     - 200 on successful rollback (via mock bridge)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { WebSocket, WebSocketServer } from "ws";
import http from "http";
import { AddressInfo } from "net";
import app from "../app";
import { db, gpuProfilesTable, sessionsTable, sessionLanesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { registerBridge, unregisterBridge } from "../services/bridge-registry";
import { _testSetLaneBusy, _testClearLaneBusy } from "../mcp/tools/bridge";

// ─── DB Fixtures ──────────────────────────────────────────────────────────────

let testSessionId: number;
let testLaneId: number;
let testProfileId: number;
const PROFILE_NAME = `test-profile-snapshot-${Date.now()}`;

beforeAll(async () => {
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: PROFILE_NAME,
      displayName: "Snapshot Test GPU",
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

  const [session] = await db
    .insert(sessionsTable)
    .values({
      name: "Snapshot Test Session",
      profileId: testProfileId,
      status: "running",
    })
    .returning();
  testSessionId = session.id;

  const [lane] = await db
    .insert(sessionLanesTable)
    .values({
      sessionId: testSessionId,
      memberIdentifier: "snapshot-test@test.com",
      laneType: "general",
    })
    .returning();
  testLaneId = lane.id;
});

afterAll(async () => {
  await db.delete(sessionLanesTable).where(eq(sessionLanesTable.sessionId, testSessionId));
  await db.delete(sessionsTable).where(eq(sessionsTable.id, testSessionId));
  await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.name, PROFILE_NAME));
});

afterEach(() => {
  unregisterBridge(testSessionId, testLaneId);
  _testClearLaneBusy(testSessionId, testLaneId);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a mock bridge WebSocket that auto-responds to `shell` frames.
 *
 * The `responder` function receives the parsed shell frame and returns a
 * partial frame object merged into the `shell_done` response. Return
 * `{ __error: true }` to respond with a `shell_error` frame instead.
 */
function createMockBridge(
  responder: (frame: { id: string; cmd: string }) => { output?: string; exitCode?: number; __error?: boolean; error?: string },
): Promise<{ server: WebSocketServer; client: WebSocket }> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 });
    server.once("connection", (serverSide) => {
      serverSide.on("message", (raw) => {
        let frame: { type: string; id: string; cmd: string };
        try {
          frame = JSON.parse(raw.toString()) as { type: string; id: string; cmd: string };
        } catch {
          return;
        }
        if (frame.type !== "shell") return;
        const resp = responder({ id: frame.id, cmd: frame.cmd });
        if (resp.__error) {
          serverSide.send(JSON.stringify({ type: "shell_error", id: frame.id, error: resp.error ?? "shell error" }));
        } else {
          serverSide.send(JSON.stringify({ type: "shell_done", id: frame.id, output: resp.output ?? "", exitCode: resp.exitCode ?? 0 }));
        }
      });
    });
    server.once("listening", () => {
      const { port } = server.address() as AddressInfo;
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.once("open", () => {
        registerBridge(testSessionId, testLaneId, client);
        resolve({ server, client });
      });
    });
  });
}

async function closeMockBridge(bridge: { server: WebSocketServer; client: WebSocket }): Promise<void> {
  bridge.client.close();
  await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
}

// ─── GET /api/sessions/:id/snapshots ─────────────────────────────────────────

describe("GET /api/sessions/:id/snapshots", () => {
  it("returns 400 for non-numeric session ID", async () => {
    const res = await request(app).get("/api/sessions/not-a-number/snapshots");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Invalid") });
  });

  it("returns 503 when bridge is not connected", async () => {
    const res = await request(app).get(`/api/sessions/${testSessionId}/snapshots?laneId=${testLaneId}`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Bridge not connected") });
  });

  it("returns 409 when lane is busy", async () => {
    _testSetLaneBusy(testSessionId, testLaneId);
    const res = await request(app).get(`/api/sessions/${testSessionId}/snapshots?laneId=${testLaneId}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringContaining("busy") });
  });

  it("returns parsed snapshots from mock bridge git log output", async () => {
    const gitLogOutput = [
      "abc1234|mizi: snapshot before bridge_exec @ 2026-05-16T12:00:00.000Z|2026-05-16T12:00:00.000Z",
      "def5678|mizi: snapshot before bridge_exec @ 2026-05-16T11:00:00.000Z|2026-05-16T11:00:00.000Z",
    ].join("\n");

    const bridge = await createMockBridge(() => ({ output: gitLogOutput, exitCode: 0 }));

    try {
      const res = await request(app).get(`/api/sessions/${testSessionId}/snapshots?laneId=${testLaneId}`);
      expect(res.status).toBe(200);
      expect(res.body.snapshots).toHaveLength(2);
      expect(res.body.snapshots[0]).toMatchObject({
        sha: "abc1234",
        tool: "bridge_exec",
        timestamp: "2026-05-16T12:00:00.000Z",
      });
      expect(res.body.snapshots[1]).toMatchObject({
        sha: "def5678",
        tool: "bridge_exec",
      });
    } finally {
      await closeMockBridge(bridge);
    }
  });

  it("returns empty list when git log has no mizi snapshot commits", async () => {
    const bridge = await createMockBridge(() => ({ output: "", exitCode: 0 }));
    try {
      const res = await request(app).get(`/api/sessions/${testSessionId}/snapshots?laneId=${testLaneId}`);
      expect(res.status).toBe(200);
      expect(res.body.snapshots).toHaveLength(0);
    } finally {
      await closeMockBridge(bridge);
    }
  });

  it("returns 500 when git log exits non-zero", async () => {
    const bridge = await createMockBridge(() => ({ output: "fatal: not a git repository", exitCode: 128 }));
    try {
      const res = await request(app).get(`/api/sessions/${testSessionId}/snapshots?laneId=${testLaneId}`);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/git log failed/);
    } finally {
      await closeMockBridge(bridge);
    }
  });
});

// ─── POST /api/sessions/:id/snapshots/:sha/rollback ──────────────────────────

describe("POST /api/sessions/:id/snapshots/:sha/rollback", () => {
  it("returns 400 for invalid SHA format", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/snapshots/not-a-sha/rollback?laneId=${testLaneId}`)
      .send();
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Invalid") });
  });

  it("returns 400 for SHA that is too short", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/snapshots/abc/rollback?laneId=${testLaneId}`)
      .send();
    expect(res.status).toBe(400);
  });

  it("returns 503 when bridge is not connected", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/snapshots/abc1234/rollback?laneId=${testLaneId}`)
      .send();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Bridge not connected") });
  });

  it("returns 409 when lane is busy", async () => {
    _testSetLaneBusy(testSessionId, testLaneId);
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/snapshots/abc1234/rollback?laneId=${testLaneId}`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringContaining("busy") });
  });

  it("returns 400 when commit is not a mizi snapshot commit", async () => {
    const bridge = await createMockBridge(({ cmd }) => {
      if (cmd.includes("git log") && cmd.includes("^!")) {
        return { output: "some other commit message", exitCode: 0 };
      }
      return { output: "", exitCode: 0 };
    });
    try {
      const res = await request(app)
        .post(`/api/sessions/${testSessionId}/snapshots/abc1234/rollback?laneId=${testLaneId}`)
        .send();
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/is not a mizi-created snapshot commit/);
    } finally {
      await closeMockBridge(bridge);
    }
  });

  it("returns 500 when verify git log exits non-zero", async () => {
    const bridge = await createMockBridge(() => ({ output: "fatal: bad object abc1234", exitCode: 128 }));
    try {
      const res = await request(app)
        .post(`/api/sessions/${testSessionId}/snapshots/abc1234/rollback?laneId=${testLaneId}`)
        .send();
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/git log verify failed/);
    } finally {
      await closeMockBridge(bridge);
    }
  });

  it("returns 200 on successful rollback", async () => {
    let callCount = 0;
    const bridge = await createMockBridge(({ cmd }) => {
      callCount++;
      if (cmd.includes("git log") && cmd.includes("^!")) {
        return { output: "mizi: snapshot before bridge_exec @ 2026-05-16T12:00:00.000Z", exitCode: 0 };
      }
      if (cmd.includes("git reset --hard")) {
        return { output: "HEAD is now at abc1234 mizi: snapshot before bridge_exec", exitCode: 0 };
      }
      return { output: "", exitCode: 0 };
    });
    try {
      const res = await request(app)
        .post(`/api/sessions/${testSessionId}/snapshots/abc1234/rollback?laneId=${testLaneId}`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, sha: "abc1234" });
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      await closeMockBridge(bridge);
    }
  });

  it("returns 500 when git reset --hard exits non-zero", async () => {
    const bridge = await createMockBridge(({ cmd }) => {
      if (cmd.includes("git log") && cmd.includes("^!")) {
        return { output: "mizi: snapshot before bridge_exec @ 2026-05-16T12:00:00.000Z", exitCode: 0 };
      }
      if (cmd.includes("git reset")) {
        return { output: "error: Your local changes would be overwritten", exitCode: 1 };
      }
      return { output: "", exitCode: 0 };
    });
    try {
      const res = await request(app)
        .post(`/api/sessions/${testSessionId}/snapshots/abc1234/rollback?laneId=${testLaneId}`)
        .send();
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/git reset --hard failed/);
    } finally {
      await closeMockBridge(bridge);
    }
  });
});
