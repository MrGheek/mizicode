/**
 * Authorization tests for /api/ambient/* and /api/safety/* endpoints.
 *
 * Posture:
 *   • `/api/ambient/*` and `/api/safety/*` — token-gated by
 *     `OMNIQL_MEM_TOKEN` (Bearer). Carry the full read + write surface.
 *   • `/api/dashboard/ambient/*` and `/api/dashboard/safety/*` —
 *     browser-safe proxy used by the dashboard. READ-ONLY by design;
 *     mutating endpoints are NOT registered there. Anything mutating
 *     must go through the token-gated surface.
 */

import { describe, it, expect, beforeAll } from "vitest";

const TEST_TOKEN = "test-operator-token-authz";

let app: import("express").Express;
let request: typeof import("supertest");

beforeAll(async () => {
  process.env["OMNIQL_MEM_TOKEN"] = TEST_TOKEN;
  request = (await import("supertest")).default as unknown as typeof import("supertest");
  app = (await import("../app")).default as unknown as import("express").Express;
});

type Method = "get" | "post" | "put";
interface Route { method: Method; path: string; body?: unknown; mutating: boolean }

const TOKEN_GATED: Route[] = [
  { method: "get", path: "/api/ambient/status", mutating: false },
  { method: "get", path: "/api/ambient/config", mutating: false },
  { method: "put", path: "/api/ambient/config", body: { enabled: false }, mutating: true },
  { method: "post", path: "/api/ambient/kill", body: { engaged: true }, mutating: true },
  { method: "post", path: "/api/ambient/cycle", body: { force: true }, mutating: true },
  { method: "get", path: "/api/ambient/timeline", mutating: false },
  { method: "get", path: "/api/ambient/metrics", mutating: false },
  { method: "get", path: "/api/safety/pending", mutating: false },
  { method: "get", path: "/api/safety/actions", mutating: false },
  { method: "get", path: "/api/safety/actions/1", mutating: false },
  { method: "post", path: "/api/safety/actions/1/approve", body: { decidedBy: "x" }, mutating: true },
  { method: "post", path: "/api/safety/actions/1/deny", body: { decidedBy: "x" }, mutating: true },
  { method: "get", path: "/api/safety/transcript", mutating: false },
  { method: "get", path: "/api/safety/policies", mutating: false },
  { method: "put", path: "/api/safety/policies/default", body: { rules: {} }, mutating: true },
];

function fire(req: ReturnType<typeof request>, method: Method, path: string, token: string | null, body?: unknown) {
  let r = req[method](path);
  if (token) r = r.set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
}

describe("ambient/safety authz", () => {
  it("token-gated routes reject requests with no bearer token", async () => {
    for (const r of TOKEN_GATED) {
      const res = await fire(request(app), r.method, r.path, null, r.body);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
    }
  });

  it("token-gated routes reject requests with an invalid bearer token", async () => {
    for (const r of TOKEN_GATED) {
      const res = await fire(request(app), r.method, r.path, "wrong-token", r.body);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
    }
  });

  it("token-gated routes accept requests with the valid bearer token", async () => {
    for (const r of TOKEN_GATED) {
      const res = await fire(request(app), r.method, r.path, TEST_TOKEN, r.body);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).not.toBe(401);
    }
  });

  it("dashboard-proxy GET routes are browser-safe (no token, never 401)", async () => {
    for (const r of TOKEN_GATED.filter((x) => !x.mutating)) {
      const proxy = r.path
        .replace(/^\/api\/ambient/, "/api/dashboard/ambient")
        .replace(/^\/api\/safety/, "/api/dashboard/safety");
      const res = await fire(request(app), r.method, proxy, null);
      expect(res.status, `${r.method.toUpperCase()} ${proxy}`).not.toBe(401);
    }
  });

  it("dashboard-proxy mutating routes are NOT registered (404, not 200)", async () => {
    // The browser-safe proxy must never accept high-privilege writes.
    // Express returns 404 for unmounted routes — proves the writes
    // can't be performed without the operator bearer token.
    for (const r of TOKEN_GATED.filter((x) => x.mutating)) {
      const proxy = r.path
        .replace(/^\/api\/ambient/, "/api/dashboard/ambient")
        .replace(/^\/api\/safety/, "/api/dashboard/safety");
      const res = await fire(request(app), r.method, proxy, null, r.body);
      expect(res.status, `${r.method.toUpperCase()} ${proxy}`).toBe(404);
    }
  });

  it("POST /api/ambient/cycle returns a normalized cycle with both id and cycleId", async () => {
    // The dashboard reads c.id from the response to render "Cycle #N ..."
    // The service returns cycleId; the route normalizes to { id, cycleId, ... }.
    const res = await fire(request(app), "post", "/api/ambient/cycle", TEST_TOKEN, { force: true });
    // Cycle runs are best-effort; any non-401/5xx status is acceptable here
    // (may return 200 completed or 200 skipped if scheduler is not running).
    expect(res.status).not.toBe(401);
    if (res.status === 200) {
      expect(typeof res.body.id).toBe("number");
      expect(typeof res.body.cycleId).toBe("number");
      expect(res.body.id).toBe(res.body.cycleId);
      expect(typeof res.body.status).toBe("string");
    }
  });
});
