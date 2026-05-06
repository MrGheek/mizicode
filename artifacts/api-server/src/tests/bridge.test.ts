/**
 * Tests for the Remote CLI Bridge
 *
 * Covers:
 *   - GET  /api/sessions/:id/lanes/:laneId/bridge/status
 *   - POST /api/sessions/:id/lanes/:laneId/exec
 *     • prompt forwarding to a mock bridge WebSocket
 *     • SSE event relay for observation/done/error frames
 *     • 503 when no bridge is registered
 *     • SSE stream closure on done frame
 *   - Bridge registry helpers (unit)
 *   - 400 on missing/invalid params
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import http from "http";
import { AddressInfo } from "net";
import { WebSocket, WebSocketServer } from "ws";
import app from "../app";
import { db, gpuProfilesTable, sessionsTable, sessionLanesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  registerBridge,
  unregisterBridge,
  getBridge,
  getBridgeStatus,
  bridgeKey,
} from "../services/bridge-registry";
import { _clearActiveExec } from "../routes/bridge";

// ─── DB fixtures ──────────────────────────────────────────────────────────────

let testSessionId: number;
let testLaneId: number;
let testProfileId: number;
const PROFILE_NAME = `test-profile-bridge-${Date.now()}`;

beforeAll(async () => {
  const [profile] = await db
    .insert(gpuProfilesTable)
    .values({
      name: PROFILE_NAME,
      displayName: "Bridge Test GPU",
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
    .values({ profileId: testProfileId, status: "ready" })
    .returning();
  testSessionId = session.id;

  const [lane] = await db
    .insert(sessionLanesTable)
    .values({
      sessionId: testSessionId,
      memberIdentifier: "bridge-test-agent",
      laneType: "general",
      taskMode: "build",
      status: "active",
      tokenMode: "core",
    })
    .returning();
  testLaneId = lane.id;
});

afterAll(async () => {
  await db.delete(sessionLanesTable).where(eq(sessionLanesTable.sessionId, testSessionId));
  await db.delete(sessionsTable).where(eq(sessionsTable.id, testSessionId));
  await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, testProfileId));
});

afterEach(() => {
  // Ensure registry and exec lock are clean between tests
  unregisterBridge(testSessionId, testLaneId);
  _clearActiveExec(testSessionId, testLaneId);
});

// ─── Helper: create a mock WebSocket server and connect a mock bridge WS ──────
//
// Architecture:
//   clientWs  — the outbound socket registered in the bridge registry
//               (simulates what claw-bridge.mjs opens on boot)
//   serverWs  — the server-side socket on the mock server
//               (simulates what handleBridgeUpgrade receives in real usage)
//
// When the exec endpoint calls liveWs.send(execMsg), clientWs sends it to
// the mock server where serverWs.on("message") fires.  When serverWs.send()
// replies, clientWs.on("message") fires — which is exactly liveWs's listener.

interface MockBridge {
  serverWs: WebSocket;
  server: http.Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
}

async function createMockBridgeClient(sessionId: number, laneId: number): Promise<MockBridge> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    const wss = new WebSocketServer({ server: srv });

    let resolvedServerWs: WebSocket | null = null;
    let clientReady = false;
    let clientWs: WebSocket;

    function tryResolve() {
      if (!resolvedServerWs || !clientReady) return;
      // clientWs is now OPEN — safe to register
      registerBridge(sessionId, laneId, clientWs);
      const serverWs = resolvedServerWs;
      resolve({
        serverWs,
        server: srv,
        wss,
        close: () =>
          new Promise<void>((res) => {
            unregisterBridge(sessionId, laneId);
            clientWs.close();
            srv.close(() => res());
          }),
      });
    }

    srv.listen(0, () => {
      const addr = srv.address() as { port: number };
      clientWs = new WebSocket(`ws://127.0.0.1:${addr.port}`);

      clientWs.once("open", () => {
        clientReady = true;
        tryResolve();
      });

      wss.once("connection", (serverWs) => {
        resolvedServerWs = serverWs;
        tryResolve();
      });

      wss.once("error", reject);
      clientWs.once("error", reject);
    });

    srv.once("error", reject);
  });
}

// ─── SSE helper: make a real HTTP POST to a bound server, collect SSE events ──
// Supertest's .parse() doesn't reliably detect SSE stream end, so we bind
// the Express app to a random port and use Node's http.request directly.

let testHttpServer: http.Server;
let testPort: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    testHttpServer = app.listen(0, () => {
      testPort = (testHttpServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => testHttpServer.close(() => resolve()));
});

function collectSseEvents(
  method: string,
  path: string,
  body: unknown,
  timeoutMs = 10_000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSE timeout after ${timeoutMs}ms`)), timeoutMs);

    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: testPort,
        path: `/api${path}`,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          let errBody = "";
          res.on("data", (c: Buffer) => { errBody += c.toString(); });
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        const events: Array<Record<string, unknown>> = [];
        let buf = "";

        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const json = line.slice("data:".length).trim();
            if (!json) continue;
            try { events.push(JSON.parse(json) as Record<string, unknown>); } catch { /* skip */ }
          }
        });

        res.on("end", () => {
          clearTimeout(timer);
          resolve(events);
        });

        res.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

// ─── Bridge registry unit tests ───────────────────────────────────────────────

describe("bridge-registry helpers", () => {
  it("bridgeKey formats correctly", () => {
    expect(bridgeKey(1, 2)).toBe("1:2");
    expect(bridgeKey("10", "20")).toBe("10:20");
  });

  it("registers and retrieves a socket", async () => {
    const mock = await createMockBridgeClient(testSessionId, testLaneId);
    const ws = getBridge(testSessionId, testLaneId);
    expect(ws).toBeDefined();
    expect(getBridgeStatus(testSessionId, testLaneId)).toBe("connected");
    await mock.close();
  });

  it("returns disconnected when no bridge is registered", () => {
    expect(getBridgeStatus(99999, 99999)).toBe("disconnected");
    expect(getBridge(99999, 99999)).toBeUndefined();
  });

  it("unregisters a socket", async () => {
    const mock = await createMockBridgeClient(testSessionId, testLaneId);
    expect(getBridgeStatus(testSessionId, testLaneId)).toBe("connected");
    await mock.close();
    expect(getBridgeStatus(testSessionId, testLaneId)).toBe("disconnected");
  });
});

// ─── GET /api/sessions/:id/lanes/:laneId/bridge/status ────────────────────────

describe("GET /api/sessions/:id/lanes/:laneId/bridge/status", () => {
  it("returns disconnected when no bridge is registered", async () => {
    const res = await request(app)
      .get(`/api/sessions/${testSessionId}/lanes/${testLaneId}/bridge/status`);
    expect(res.status).toBe(200);
    expect(res.body.bridge).toBe("disconnected");
    expect(res.body.sessionId).toBe(testSessionId);
    expect(res.body.laneId).toBe(testLaneId);
  });

  it("returns connected when a bridge is registered", async () => {
    const mock = await createMockBridgeClient(testSessionId, testLaneId);

    const res = await request(app)
      .get(`/api/sessions/${testSessionId}/lanes/${testLaneId}/bridge/status`);
    expect(res.status).toBe(200);
    expect(res.body.bridge).toBe("connected");

    await mock.close();
  });

  it("returns 400 for invalid session ID", async () => {
    const res = await request(app)
      .get(`/api/sessions/not-a-number/lanes/${testLaneId}/bridge/status`);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid lane ID", async () => {
    const res = await request(app)
      .get(`/api/sessions/${testSessionId}/lanes/bad/bridge/status`);
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/sessions/:id/lanes/:laneId/exec ────────────────────────────────

describe("POST /api/sessions/:id/lanes/:laneId/exec", () => {
  it("returns 503 when no bridge is registered", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`)
      .send({ prompt: "hello claw" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not connected/i);
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt/i);
  });

  it("returns 400 when prompt is empty string", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`)
      .send({ prompt: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid session ID", async () => {
    const res = await request(app)
      .post(`/api/sessions/nope/lanes/${testLaneId}/exec`)
      .send({ prompt: "test" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid lane ID", async () => {
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/nope/exec`)
      .send({ prompt: "test" });
    expect(res.status).toBe(400);
  });

  it("returns 409 when another exec is already in progress for the lane", async () => {
    const mock = await createMockBridgeClient(testSessionId, testLaneId);

    // First exec starts but doesn't complete (mock never sends done).
    // We wait until the SSE response HEADERS arrive — that means the server
    // has already called activeExecs.add() and written writeHead(), so the
    // lock is definitely held before we fire the second request.
    let firstReqAbort: (() => void) | null = null;
    const firstExecPromise = new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: testPort,
          path: `/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          // Response callback fires when HTTP headers are received from the
          // server. By this point activeExecs.add(laneKey) has already run
          // (it executes before res.writeHead in the handler).
          res.resume(); // drain body so socket doesn't back-pressure
          resolve();
        },
      );
      req.once("error", reject);
      firstReqAbort = () => req.destroy();
      req.end(JSON.stringify({ prompt: "slow command" }));
    });

    // Wait for the first exec to be in flight (headers received)
    await firstExecPromise;

    // Second exec on the same lane must be rejected with 409
    const res = await request(app)
      .post(`/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`)
      .send({ prompt: "concurrent command" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in progress/i);

    // Abort the dangling first request so the server-side SSE stream closes
    // and finish() clears activeExecs before afterEach runs.
    firstReqAbort?.();
    await mock.close();
  });

  it("forwards the exec frame to the bridge WebSocket", async () => {
    const mock = await createMockBridgeClient(testSessionId, testLaneId);

    // Race: wait for serverWs to receive the exec frame (or 5 s timeout)
    const received = await new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("exec frame not received within 5s")), 5_000);
      mock.serverWs.once("message", (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });

      // Make the exec request (fire and forget — SSE stays open while mock is alive)
      http.request(
        {
          host: "127.0.0.1",
          port: testPort,
          path: `/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        () => { /* response handled by mock WS */ },
      ).end(JSON.stringify({ prompt: "explain this codebase" }));
    });

    expect((received as any).type).toBe("exec");
    expect((received as any).prompt).toBe("explain this codebase");

    await mock.close();
  });

  it("relays SSE observation and done frames from the bridge", async () => {
    const mock = await createMockBridgeClient(testSessionId, testLaneId);

    // Reply immediately when exec frame arrives
    mock.serverWs.once("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "exec") {
        mock.serverWs.send(JSON.stringify({ type: "observation", text: "tool output line 1" }));
        mock.serverWs.send(JSON.stringify({ type: "done", result: "final answer" }));
      }
    });

    // Collect SSE events using raw http (waits for res.end())
    const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSE timeout")), 8_000);
      const collected: Array<Record<string, unknown>> = [];
      let buf = "";

      http.request(
        {
          host: "127.0.0.1",
          port: testPort,
          path: `/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith("data:")) continue;
              const json = line.slice("data:".length).trim();
              if (!json) continue;
              try { collected.push(JSON.parse(json) as Record<string, unknown>); } catch { /* skip */ }
            }
          });
          res.on("end", () => { clearTimeout(timer); resolve(collected); });
          res.on("error", (err) => { clearTimeout(timer); reject(err); });
        },
      ).end(JSON.stringify({ prompt: "explain this codebase" }));
    });

    const obsFrame = events.find((e) => e["type"] === "observation");
    const doneFrame = events.find((e) => e["type"] === "done");
    expect(obsFrame).toBeDefined();
    expect(obsFrame!["text"]).toBe("tool output line 1");
    expect(doneFrame).toBeDefined();
    expect(doneFrame!["result"]).toBe("final answer");

    await mock.close();
  });

  it("relays SSE error frame when bridge sends error", async () => {
    const mock = await createMockBridgeClient(testSessionId, testLaneId);

    mock.serverWs.once("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "exec") {
        mock.serverWs.send(JSON.stringify({ type: "error", message: "claw crashed" }));
      }
    });

    const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSE timeout")), 8_000);
      const collected: Array<Record<string, unknown>> = [];
      let buf = "";

      http.request(
        {
          host: "127.0.0.1",
          port: testPort,
          path: `/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith("data:")) continue;
              const json = line.slice("data:".length).trim();
              if (!json) continue;
              try { collected.push(JSON.parse(json) as Record<string, unknown>); } catch { /* skip */ }
            }
          });
          res.on("end", () => { clearTimeout(timer); resolve(collected); });
          res.on("error", (err) => { clearTimeout(timer); reject(err); });
        },
      ).end(JSON.stringify({ prompt: "crash please" }));
    });

    const errorFrame = events.find((e) => e["type"] === "error");
    expect(errorFrame).toBeDefined();
    expect(errorFrame!["message"]).toBe("claw crashed");

    await mock.close();
  });

  it("closes SSE stream with error when bridge disconnects mid-exec", async () => {
    const mock = await createMockBridgeClient(testSessionId, testLaneId);

    // Bridge closes right after receiving exec
    mock.serverWs.once("message", () => {
      // Small delay so the exec response headers are sent first
      setImmediate(() => mock.serverWs.close());
    });

    const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSE timeout")), 8_000);
      const collected: Array<Record<string, unknown>> = [];
      let buf = "";

      http.request(
        {
          host: "127.0.0.1",
          port: testPort,
          path: `/api/sessions/${testSessionId}/lanes/${testLaneId}/exec`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith("data:")) continue;
              const json = line.slice("data:".length).trim();
              if (!json) continue;
              try { collected.push(JSON.parse(json) as Record<string, unknown>); } catch { /* skip */ }
            }
          });
          res.on("end", () => { clearTimeout(timer); resolve(collected); });
          res.on("error", (err) => { clearTimeout(timer); reject(err); });
        },
      ).end(JSON.stringify({ prompt: "disconnect mid-exec" }));
    });

    const errorFrame = events.find((e) => e["type"] === "error");
    expect(errorFrame).toBeDefined();
    expect(String(errorFrame!["message"])).toMatch(/disconnected/i);

    await mock.close();
  });
});
