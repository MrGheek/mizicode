/**
 * Integration tests for swarm snapshot ingestion and retrieval.
 *
 * Verifies the end-to-end path:
 *   POST /api/sessions/:id/swarm-push   (canonical route)
 *   POST /api/sessions/:id/swarm-status (Claw Runner alias)
 *   GET  /api/sessions/:id/swarm-status (dashboard poll reader)
 *   GET  /api/sessions/:id/swarm-stream (SSE live-push stream)
 *
 * Uses a real PostgreSQL database and a real Express app instance;
 * test data is isolated by a unique session and cleaned up in afterAll.
 */

import http from "http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, gpuProfilesTable, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─── Test Fixture Setup ────────────────────────────────────────────────────────

let testSessionId: number;
let testProfileId: number;
let testOwnerToken: string;

// A live HTTP server is needed for the SSE stream tests — supertest does not
// support keep-alive streaming responses without a real server.
let server: http.Server;
let serverPort: number;

const TEST_PROFILE_NAME = `test-profile-swarm-snapshot-${Date.now()}`;
const FIXED_OWNER_TOKEN = `test-owner-token-${Date.now()}`;

beforeAll(async () => {
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: TEST_PROFILE_NAME,
      displayName: "Test GPU (swarm)",
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
      profileId: testProfileId,
      status: "ready",
      ownerToken: FIXED_OWNER_TOKEN,
    })
    .returning();
  testSessionId = session.id;
  testOwnerToken = FIXED_OWNER_TOKEN;

  // Start a real HTTP server for SSE streaming tests
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (testSessionId) {
    await db.delete(sessionsTable).where(eq(sessionsTable.id, testSessionId));
  }
  if (testProfileId) {
    await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, testProfileId));
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(phase: string = "active", extra: Record<string, unknown> = {}) {
  return {
    phase,
    totalWorkers: 3,
    doneCount: 1,
    failedCount: 0,
    timestamp: new Date().toISOString(),
    workers: [{ id: "w1", status: "running", task: "Analyse codebase" }],
    ...extra,
  };
}

/**
 * Opens an SSE connection to the swarm-stream endpoint and collects data events.
 * Returns a promise that resolves with the first `data:` event payload received
 * after the connection is established, plus a close() function to end the stream.
 *
 * @param onConnected - callback invoked once the SSE connection is open and the
 *   initial event has arrived, so callers can fire a POST *after* the stream is
 *   subscribed.
 */
function openSseStream(
  sessionId: number,
  token: string,
  onConnected: () => void,
): Promise<{ events: unknown[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const path = `/api/sessions/${sessionId}/swarm-stream?token=${encodeURIComponent(token)}`;
    const req = http.get(
      { hostname: "127.0.0.1", port: serverPort, path },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            reject(new Error(`SSE handshake failed: ${res.statusCode} ${Buffer.concat(chunks)}`)),
          );
          return;
        }

        let buffer = "";
        let resolvedOnce = false;

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const payload = JSON.parse(line.slice(6));
                events.push(payload);
                if (!resolvedOnce) {
                  resolvedOnce = true;
                  // Initial event received — let the caller know the stream is ready,
                  // then surface the events array + close handle.
                  onConnected();
                  resolve({
                    events,
                    close: () => req.destroy(),
                  });
                }
              } catch {
                /* ignore non-JSON lines (keep-alive pings) */
              }
            }
          }
        });

        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

/**
 * Waits until `predicate(events)` is true, polling every 20 ms up to `timeoutMs`.
 */
async function waitFor(
  events: unknown[],
  predicate: (events: unknown[]) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(events)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms. Events so far: ${JSON.stringify(events)}`);
}

// ─── POST /swarm-push — canonical route ────────────────────────────────────────

describe("POST /api/sessions/:id/swarm-push", () => {
  it("accepts a valid SwarmSnapshot and returns { ok: true }", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-push`)
      .send(makeSnapshot("active"));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 400 for a missing phase field", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-push`)
      .send({ totalWorkers: 2, timestamp: new Date().toISOString() });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 for an invalid session ID", async () => {
    const res = await request(app)
      .post("/api/sessions/not-a-number/swarm-push")
      .send(makeSnapshot("active"));

    expect(res.status).toBe(400);
  });
});

// ─── POST /swarm-status — Claw Runner alias route ──────────────────────────────

describe("POST /api/sessions/:id/swarm-status", () => {
  it("accepts a valid SwarmSnapshot and returns { ok: true }", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-status`)
      .send(makeSnapshot("idle"));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 400 for a missing phase field", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-status`)
      .send({ timestamp: new Date().toISOString() });

    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid session ID", async () => {
    const res = await request(app)
      .post("/api/sessions/not-a-number/swarm-status")
      .send(makeSnapshot("active"));

    expect(res.status).toBe(400);
  });
});

// ─── End-to-end: snapshot arrives at GET /swarm-status ─────────────────────────

describe("End-to-end: snapshot reaches GET /swarm-status after POST", () => {
  it("GET reflects snapshot with availability 'live' after POST /swarm-push", async () => {
    const snapshot = makeSnapshot("active");

    const postRes = await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-push`)
      .send(snapshot);
    expect(postRes.status).toBe(200);

    const getRes = await request(app).get(`/api/sessions/${testSessionId}/swarm-status`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.availability).toBe("live");
    expect(getRes.body.snapshot).toBeDefined();
    expect(getRes.body.snapshot.phase).toBe("active");
    expect(getRes.body.snapshot.totalWorkers).toBe(3);
  });

  it("GET reflects snapshot with availability 'live' after POST /swarm-status alias", async () => {
    const snapshot = makeSnapshot("synthesising", { doneCount: 3 });

    const postRes = await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-status`)
      .send(snapshot);
    expect(postRes.status).toBe(200);

    const getRes = await request(app).get(`/api/sessions/${testSessionId}/swarm-status`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.availability).toBe("live");
    expect(getRes.body.snapshot.phase).toBe("synthesising");
    expect(getRes.body.snapshot.doneCount).toBe(3);
  });

  it("most recent POST overwrites the cache (last-write wins)", async () => {
    await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-push`)
      .send(makeSnapshot("idle"));

    await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-status`)
      .send(makeSnapshot("aborted"));

    const getRes = await request(app).get(`/api/sessions/${testSessionId}/swarm-status`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.availability).toBe("live");
    expect(getRes.body.snapshot.phase).toBe("aborted");
  });
});

// ─── End-to-end: snapshot arrives over SSE stream ──────────────────────────────

describe("End-to-end: snapshot reaches GET /swarm-stream SSE after POST", () => {
  it("SSE stream sends initial event on connect", async () => {
    // Seed a known snapshot first so the initial event has a deterministic value
    await request(app)
      .post(`/api/sessions/${testSessionId}/swarm-push`)
      .send(makeSnapshot("active"));

    const { events, close } = await openSseStream(
      testSessionId,
      testOwnerToken,
      () => { /* nothing extra needed — just wait for the initial event */ },
    );

    try {
      expect(events.length).toBeGreaterThanOrEqual(1);
      const initial = events[0] as { availability: string; snapshot: { phase: string } };
      expect(initial.availability).toBeDefined();
    } finally {
      close();
    }
  });

  it("POST /swarm-push pushes live snapshot over open SSE stream", async () => {
    const pushed: { phase: string; totalWorkers: number } = { phase: "active", totalWorkers: 5 };
    let close: () => void;
    let events: unknown[];

    // Open the stream; fire the POST only after the initial event has been delivered
    await new Promise<void>((resolve, reject) => {
      openSseStream(testSessionId, testOwnerToken, async () => {
        try {
          await request(app)
            .post(`/api/sessions/${testSessionId}/swarm-push`)
            .send(makeSnapshot(pushed.phase, { totalWorkers: pushed.totalWorkers }));
          resolve();
        } catch (err) {
          reject(err);
        }
      })
        .then((result) => {
          events = result.events;
          close = result.close;
        })
        .catch(reject);
    });

    try {
      // Wait until the pushed snapshot arrives as a second event on the stream
      await waitFor(events!, (evs) =>
        evs.some((e) => {
          const ev = e as { availability: string; snapshot?: { phase: string; totalWorkers: number } };
          return ev.availability === "live"
            && ev.snapshot?.phase === pushed.phase
            && ev.snapshot?.totalWorkers === pushed.totalWorkers;
        }),
      );

      const liveEvent = (events! as Array<{ availability: string; snapshot?: { phase: string; totalWorkers: number } }>)
        .find((e) => e.availability === "live" && e.snapshot?.totalWorkers === pushed.totalWorkers);
      expect(liveEvent).toBeDefined();
      expect(liveEvent!.snapshot!.phase).toBe("active");
    } finally {
      close!();
    }
  });

  it("POST /swarm-status alias also pushes live snapshot over open SSE stream", async () => {
    const pushed = { phase: "synthesising", totalWorkers: 7 };
    let close: () => void;
    let events: unknown[];

    await new Promise<void>((resolve, reject) => {
      openSseStream(testSessionId, testOwnerToken, async () => {
        try {
          await request(app)
            .post(`/api/sessions/${testSessionId}/swarm-status`)
            .send(makeSnapshot(pushed.phase, { totalWorkers: pushed.totalWorkers }));
          resolve();
        } catch (err) {
          reject(err);
        }
      })
        .then((result) => {
          events = result.events;
          close = result.close;
        })
        .catch(reject);
    });

    try {
      await waitFor(events!, (evs) =>
        evs.some((e) => {
          const ev = e as { availability: string; snapshot?: { phase: string; totalWorkers: number } };
          return ev.availability === "live"
            && ev.snapshot?.phase === pushed.phase
            && ev.snapshot?.totalWorkers === pushed.totalWorkers;
        }),
      );

      const liveEvent = (events! as Array<{ availability: string; snapshot?: { phase: string; totalWorkers: number } }>)
        .find((e) => e.availability === "live" && e.snapshot?.totalWorkers === pushed.totalWorkers);
      expect(liveEvent).toBeDefined();
      expect(liveEvent!.snapshot!.phase).toBe("synthesising");
    } finally {
      close!();
    }
  });

  it("returns 401 when no token is provided to swarm-stream", async () => {
    const res = await request(app).get(`/api/sessions/${testSessionId}/swarm-stream`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when an invalid token is provided to swarm-stream", async () => {
    const res = await request(app).get(
      `/api/sessions/${testSessionId}/swarm-stream?token=wrong-token`,
    );
    expect(res.status).toBe(403);
  });
});

// ─── GET /swarm-status — edge cases ───────────────────────────────────────────

describe("GET /api/sessions/:id/swarm-status — edge cases", () => {
  it("returns 404 for a non-existent session", async () => {
    const res = await request(app).get("/api/sessions/999999999/swarm-status");
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid session ID", async () => {
    const res = await request(app).get("/api/sessions/not-a-number/swarm-status");
    expect(res.status).toBe(400);
  });

  it("returns 'unavailable' for a fresh session with no snapshot", async () => {
    const [freshProfile] = await db
      .insert(gpuProfilesTable)
      .values({
        name: `test-profile-swarm-fresh-${Date.now()}`,
        displayName: "Fresh GPU",
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

    const [freshSession] = await db
      .insert(sessionsTable)
      .values({ profileId: freshProfile.id, status: "ready" })
      .returning();

    try {
      const res = await request(app).get(`/api/sessions/${freshSession.id}/swarm-status`);
      expect(res.status).toBe(200);
      expect(res.body.availability).toBe("unavailable");
      expect(res.body.snapshot).toBeNull();
    } finally {
      await db.delete(sessionsTable).where(eq(sessionsTable.id, freshSession.id));
      await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, freshProfile.id));
    }
  });

  it("returns 'starting' for a session that is still provisioning", async () => {
    const [provProfile] = await db
      .insert(gpuProfilesTable)
      .values({
        name: `test-profile-swarm-prov-${Date.now()}`,
        displayName: "Provisioning GPU",
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

    const [provSession] = await db
      .insert(sessionsTable)
      .values({ profileId: provProfile.id, status: "provisioning" })
      .returning();

    try {
      const res = await request(app).get(`/api/sessions/${provSession.id}/swarm-status`);
      expect(res.status).toBe(200);
      expect(res.body.availability).toBe("starting");
      expect(res.body.snapshot).toBeNull();
    } finally {
      await db.delete(sessionsTable).where(eq(sessionsTable.id, provSession.id));
      await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, provProfile.id));
    }
  });
});
