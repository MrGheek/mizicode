/**
 * Tests for M2M API key authentication.
 *
 * Covers:
 * - Key management routes require operator token
 * - Key creation returns plaintext once
 * - Subsequent GETs omit key values
 * - Revoked key returns 401
 * - Expired key returns 401
 * - Scope mismatch returns 403 (read scope vs write endpoint and vice-versa)
 * - Valid key passes through protected coordination routes
 * - MIZI_MEM_TOKEN bearer accepted as pass-through
 * - permitBearer: dev bypass, missing bearer (production), MIZI_MEM_TOKEN,
 *   valid API key (pass + scope miss), revoked key as rawBearer,
 *   unknown bearer matched/rejected as ownerToken
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, apiKeysTable, gpuProfilesTable, sessionsTable, provisionedResourcesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashApiKey } from "../middlewares/agent-auth";

// ─── Test MIZI_MEM_TOKEN setup ────────────────────────────────────────────────
// requireAgentAuth and the key-management requireOperator both read
// MIZI_MEM_TOKEN lazily (at call time). We set it here so auth enforcement is
// active for these tests, and restore it in afterAll so other test files are
// unaffected.

const TEST_MEM_TOKEN = `test-mem-token-agent-auth-${Date.now()}`;
const originalMemToken = process.env["MIZI_MEM_TOKEN"];

beforeAll(() => {
  process.env["MIZI_MEM_TOKEN"] = TEST_MEM_TOKEN;
});

afterAll(() => {
  if (originalMemToken === undefined) {
    delete process.env["MIZI_MEM_TOKEN"];
  } else {
    process.env["MIZI_MEM_TOKEN"] = originalMemToken;
  }
});

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

const createdKeyIds: number[] = [];

async function cleanupKeys() {
  for (const id of createdKeyIds) {
    await db.delete(apiKeysTable).where(eq(apiKeysTable.id, id)).catch(() => {});
  }
  createdKeyIds.length = 0;
}

afterAll(cleanupKeys);

/** Helper: POST /api/auth/keys with the operator token. */
async function createKey(label: string, scopes: string[], expiresAt?: string) {
  return request(app)
    .post("/api/auth/keys")
    .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`)
    .send({ label, scopes, ...(expiresAt ? { expiresAt } : {}) });
}

/** Helper: DELETE /api/auth/keys/:id with the operator token. */
async function revokeKey(id: number) {
  return request(app)
    .delete(`/api/auth/keys/${id}`)
    .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);
}

// ─── Operator auth on key management routes ───────────────────────────────────

describe("Operator auth on /api/auth/keys routes", () => {
  it("returns 401 when no operator token is sent to POST /auth/keys", async () => {
    const res = await request(app)
      .post("/api/auth/keys")
      .send({ label: "no-auth-key", scopes: [] });
    expect(res.status).toBe(401);
  });

  it("returns 401 when no operator token is sent to GET /auth/keys", async () => {
    const res = await request(app).get("/api/auth/keys");
    expect(res.status).toBe(401);
  });

  it("returns 401 when no operator token is sent to DELETE /auth/keys/:id", async () => {
    const res = await request(app).delete("/api/auth/keys/1");
    expect(res.status).toBe(401);
  });

  it("allows access when the correct operator token is supplied", async () => {
    const res = await request(app)
      .get("/api/auth/keys")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.keys)).toBe(true);
  });
});

// ─── POST /api/auth/keys ──────────────────────────────────────────────────────

describe("POST /api/auth/keys", () => {
  it("returns 400 when label is missing", async () => {
    const res = await request(app)
      .post("/api/auth/keys")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`)
      .send({ scopes: ["sessions:write"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/label/i);
  });

  it("returns 400 for an already-expired expiresAt", async () => {
    const res = await createKey("past-key", [], new Date(Date.now() - 1000).toISOString());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
  });

  it("creates a key and returns plaintext value exactly once", async () => {
    const res = await createKey("agent-test-key", ["sessions:write", "coordination:read"]);
    expect(res.status).toBe(201);
    expect(typeof res.body.key).toBe("string");
    expect(res.body.key).toMatch(/^mizi_/);
    expect(res.body.label).toBe("agent-test-key");
    expect(res.body.scopes).toContain("sessions:write");
    expect(res.body.id).toBeDefined();
    createdKeyIds.push(res.body.id);
  });

  it("stores the hashed key — not the plaintext — in DB", async () => {
    const res = await createKey("hash-check-key", []);
    expect(res.status).toBe(201);
    createdKeyIds.push(res.body.id);

    const plaintext: string = res.body.key;
    const expectedHash = hashApiKey(plaintext);

    const [row] = await db
      .select({ keyHash: apiKeysTable.keyHash })
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, res.body.id));

    expect(row.keyHash).toBe(expectedHash);
    expect(row.keyHash).not.toBe(plaintext);
  });
});

// ─── GET /api/auth/keys ───────────────────────────────────────────────────────

describe("GET /api/auth/keys", () => {
  let keyId: number;

  beforeAll(async () => {
    const res = await createKey("list-test-key", ["sessions:write"]);
    keyId = res.body.id;
    createdKeyIds.push(keyId);
  });

  it("returns an array of active keys without key values", async () => {
    const res = await request(app)
      .get("/api/auth/keys")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.keys)).toBe(true);

    for (const k of res.body.keys) {
      expect(k).not.toHaveProperty("key");
      expect(k).not.toHaveProperty("keyHash");
      expect(k).toHaveProperty("id");
      expect(k).toHaveProperty("label");
      expect(k).toHaveProperty("scopes");
      expect(k).toHaveProperty("createdAt");
    }
  });

  it("does not include revoked keys in list", async () => {
    await revokeKey(keyId);

    const res = await request(app)
      .get("/api/auth/keys")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);
    expect(res.status).toBe(200);
    const ids = res.body.keys.map((k: { id: number }) => k.id);
    expect(ids).not.toContain(keyId);
  });
});

// ─── DELETE /api/auth/keys/:id ────────────────────────────────────────────────

describe("DELETE /api/auth/keys/:id", () => {
  it("returns 404 for a non-existent key", async () => {
    const res = await revokeKey(999999999);
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid id", async () => {
    const res = await request(app)
      .delete("/api/auth/keys/not-a-number")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);
    expect(res.status).toBe(400);
  });

  it("revokes a key and returns ok:true", async () => {
    const created = await createKey("to-revoke", []);
    createdKeyIds.push(created.body.id);

    const res = await revokeKey(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 409 if key already revoked", async () => {
    const created = await createKey("double-revoke", []);
    createdKeyIds.push(created.body.id);

    await revokeKey(created.body.id);
    const res = await revokeKey(created.body.id);
    expect(res.status).toBe(409);
  });
});

// ─── requireAgentAuth middleware ──────────────────────────────────────────────

describe("requireAgentAuth middleware", () => {
  let readKey: string;
  let readKeyId: number;

  let writeKey: string;
  let writeKeyId: number;

  let noScopeKey: string;
  let noScopeKeyId: number;

  beforeAll(async () => {
    // Key with coordination:read only
    const readRes = await createKey("middleware-read-key", ["coordination:read"]);
    readKey = readRes.body.key;
    readKeyId = readRes.body.id;
    createdKeyIds.push(readKeyId);

    // Key with coordination:read + coordination:write (full access)
    const writeRes = await createKey("middleware-write-key", ["coordination:read", "coordination:write"]);
    writeKey = writeRes.body.key;
    writeKeyId = writeRes.body.id;
    createdKeyIds.push(writeKeyId);

    // Key with no scopes
    const emptyRes = await createKey("middleware-empty-key", []);
    noScopeKey = emptyRes.body.key;
    noScopeKeyId = emptyRes.body.id;
    createdKeyIds.push(noScopeKeyId);
  });

  it("returns 401 when no Authorization header is sent to a protected route", async () => {
    const res = await request(app).get("/api/sessions/1/lanes");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unrecognised key", async () => {
    const res = await request(app)
      .get("/api/sessions/1/lanes")
      .set("Authorization", "Bearer mizi_totally_invalid_key");
    expect(res.status).toBe(401);
  });

  it("returns 403 when read-only key is used on a write endpoint", async () => {
    // POST /lanes requires coordination:write; readKey only has coordination:read
    const res = await request(app)
      .post("/api/sessions/1/lanes")
      .set("Authorization", `Bearer ${readKey}`)
      .send({ memberIdentifier: "agent@test.com" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scope/i);
  });

  it("returns 403 when key has no scopes at all", async () => {
    const res = await request(app)
      .get("/api/sessions/1/lanes")
      .set("Authorization", `Bearer ${noScopeKey}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scope/i);
  });

  it("accepts MIZI_MEM_TOKEN bearer as a pass-through on protected routes", async () => {
    const res = await request(app)
      .get("/api/sessions/1/lanes")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);
    // Auth passed — expect 200 or 404 (session doesn't exist), not 401/403
    expect([200, 404]).toContain(res.status);
  });

  it("allows a read-scoped key on GET endpoints", async () => {
    const res = await request(app)
      .get("/api/sessions/1/lanes")
      .set("Authorization", `Bearer ${readKey}`);
    expect([200, 404]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("allows a write-scoped key on POST endpoints", async () => {
    const res = await request(app)
      .post("/api/sessions/1/lanes")
      .set("Authorization", `Bearer ${writeKey}`)
      .send({ memberIdentifier: "agent@test.com" });
    // Auth passed — 404 because session 1 doesn't exist, not 401/403
    expect([201, 404]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("records last_used_at after a successful use", async () => {
    await request(app)
      .get("/api/sessions/1/lanes")
      .set("Authorization", `Bearer ${readKey}`);

    await new Promise((r) => setTimeout(r, 200));

    const [row] = await db
      .select({ lastUsedAt: apiKeysTable.lastUsedAt })
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, readKeyId));

    expect(row.lastUsedAt).not.toBeNull();
  });

  it("returns 401 for a revoked key", async () => {
    const created = await createKey("revoke-test", ["coordination:read"]);
    const key: string = created.body.key;
    const id: number = created.body.id;
    createdKeyIds.push(id);

    await revokeKey(id);

    const res = await request(app)
      .get("/api/sessions/1/lanes")
      .set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it("returns 401 for an expired key", async () => {
    const expiredRaw = "mizi_" + "e".repeat(64);
    const hash = hashApiKey(expiredRaw);

    const [inserted] = await db
      .insert(apiKeysTable)
      .values({
        keyHash: hash,
        label: "expired-key-test",
        scopes: ["coordination:read"],
        expiresAt: new Date(Date.now() - 5000),
      })
      .returning();
    createdKeyIds.push(inserted.id);

    const res = await request(app)
      .get("/api/sessions/1/lanes")
      .set("Authorization", `Bearer ${expiredRaw}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });
});

// ─── requireAgentAuth on POST /api/sessions ──────────────────────────────────
// POST /sessions uses requireAgentAuth(["sessions:write"]) so that:
//   - No Authorization header → 401 (MIZI_MEM_TOKEN is set in test env)
//   - MIZI_MEM_TOKEN bearer → pass through (operator/internal caller)
//   - Valid API key with sessions:write → pass through, req.apiKey set
//   - API key missing sessions:write scope → 403
//   - Revoked / expired / unknown key → 401

describe("requireAgentAuth on POST /api/sessions", () => {
  let sessionsKey: string;
  let sessionsKeyId: number;
  let noScopeKey2: string;
  let noScopeKey2Id: number;

  beforeAll(async () => {
    const full = await createKey("sessions-write-key", ["sessions:write"]);
    sessionsKey = full.body.key;
    sessionsKeyId = full.body.id;
    createdKeyIds.push(sessionsKeyId);

    const empty = await createKey("sessions-noscope-key", []);
    noScopeKey2 = empty.body.key;
    noScopeKey2Id = empty.body.id;
    createdKeyIds.push(noScopeKey2Id);
  });

  it("allows unauthenticated requests to POST /sessions (dashboard access)", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({});
    // permitBearer({ optional: true }) — no auth header passes through for dashboard
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("passes through when MIZI_MEM_TOKEN bearer is supplied (operator/internal caller)", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`)
      .send({});
    // Auth passed — route returns 400 for missing profileId, not 401/403
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("passes through when a valid sessions:write key is supplied", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", `Bearer ${sessionsKey}`)
      .send({});
    // Auth passed — route returns 400 for missing profileId, not 401/403
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("allows keys regardless of scope (no scopes required on POST /sessions)", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", `Bearer ${noScopeKey2}`)
      .send({});
    // permitBearer([], { optional: true }) — no scope requirement means any valid key passes
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("allows revoked keys to pass through as rawBearer on POST /sessions", async () => {
    const created = await createKey("sessions-revoke-test", ["sessions:write"]);
    const key: string = created.body.key;
    const id: number = created.body.id;
    createdKeyIds.push(id);

    await revokeKey(id);

    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", `Bearer ${key}`)
      .send({});
    // Revoked key is stored as rawBearer and passed through (handler decides)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("allows unknown keys to pass through as rawBearer on POST /sessions", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", "Bearer mizi_unknown_key_for_sessions_test")
      .send({});
    // Unknown bearer stored as rawBearer, not rejected at middleware level
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─── permitBearer middleware ──────────────────────────────────────────────────
// Exercises the 5-tier auth ladder used by session-scoped provisioning routes:
//  1. Dev bypass: no MIZI_MEM_TOKEN, no bearer → next()
//  2. No bearer (prod mode) → 401
//  3. MIZI_MEM_TOKEN bearer → operator pass-through
//  4. Valid API key → next(), req.apiKey populated; scope miss → 403
//  5. Unknown bearer → stored as req.rawBearer; handler enforces ownerToken check

describe("permitBearer middleware", () => {
  const TEST_OWNER_TOKEN = `owner-tok-${Date.now()}`;
  let pbProfileId: number;
  let pbSessionId: number;
  let readScopedKey: string;
  let readScopedKeyId: number;
  let noScopeKey3: string;
  let noScopeKey3Id: number;

  beforeAll(async () => {
    // GPU profile required by sessionsTable FK
    const [profile] = await db
      .insert(gpuProfilesTable)
      .values({
        name: `permit-bearer-test-profile-${Date.now()}`,
        displayName: "permitBearer test GPU",
        gpuName: "A100",
        numGpus: 1,
        totalVram: 80,
        dockerImageTag: "test:latest",
        defaultQuant: "Q4_K_M",
        quantSizeGb: 10,
        diskSizeGb: 50,
        estimatedSpeedMin: 10,
        estimatedSpeedMax: 30,
        estimatedCostMin: 0.1,
        estimatedCostMax: 0.5,
        searchParams: { gpu_name: "A100", num_gpus: 1 },
      })
      .returning();
    pbProfileId = profile.id;

    // Session in "pending" state: ownership check fires and passes, then the
    // status gate returns 409 — no external bridge/Redis/Neon calls are made.
    const [session] = await db
      .insert(sessionsTable)
      .values({
        profileId: pbProfileId,
        status: "pending",
        ownerToken: TEST_OWNER_TOKEN,
      })
      .returning();
    pbSessionId = session.id;

    // API keys for scope tests
    const rk = await createKey("pb-read-scope-key", ["sessions:read"]);
    readScopedKey = rk.body.key;
    readScopedKeyId = rk.body.id;
    createdKeyIds.push(readScopedKeyId);

    const nk = await createKey("pb-noscope-key3", []);
    noScopeKey3 = nk.body.key;
    noScopeKey3Id = nk.body.id;
    createdKeyIds.push(noScopeKey3Id);
  });

  afterAll(async () => {
    // No provisioned resources are created (session status is "pending", provision returns 409)
    if (pbSessionId) {
      await db.delete(sessionsTable).where(eq(sessionsTable.id, pbSessionId)).catch(() => {});
    }
    if (pbProfileId) {
      await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, pbProfileId)).catch(() => {});
    }
  });

  it("dev bypass: no bearer and no MIZI_MEM_TOKEN → route logic runs (200/404/409)", async () => {
    // MIZI_MEM_TOKEN is set for this test file; temporarily clear it
    const saved = process.env["MIZI_MEM_TOKEN"];
    delete process.env["MIZI_MEM_TOKEN"];
    try {
      const res = await request(app).get(`/api/sessions/${pbSessionId}/resources`);
      expect([200, 404, 409]).toContain(res.status);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    } finally {
      process.env["MIZI_MEM_TOKEN"] = saved;
    }
  });

  it("returns 200 when no bearer is supplied (optional route — dashboard access allowed)", async () => {
    // GET /resources uses permitBearer({ optional: true }) so the dashboard can
    // fetch masked resource data without a token. No ownership check runs when rawBearer is absent.
    const res = await request(app).get(`/api/sessions/${pbSessionId}/resources`);
    expect(res.status).toBe(200);
  });

  it("MIZI_MEM_TOKEN bearer → operator pass-through (route logic runs)", async () => {
    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources`)
      .set("Authorization", `Bearer ${TEST_MEM_TOKEN}`);
    expect([200, 404]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("valid API key with sessions:read → passes (route logic runs)", async () => {
    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources`)
      .set("Authorization", `Bearer ${readScopedKey}`);
    expect([200]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("valid API key missing sessions:read scope → 403", async () => {
    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources`)
      .set("Authorization", `Bearer ${noScopeKey3}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scope/i);
  });

  it("valid API key with sessions:write → passes POST /provision (route logic runs)", async () => {
    const writeRes = await createKey("pb-write-key", ["sessions:write"]);
    const writeKey: string = writeRes.body.key;
    createdKeyIds.push(writeRes.body.id);

    const res = await request(app)
      .post(`/api/sessions/${pbSessionId}/provision`)
      .set("Authorization", `Bearer ${writeKey}`)
      .send({ type: "redis" });
    // Auth passed — 409 because session is in "pending" state (no external service calls)
    expect(res.status).toBe(409);
  });

  it("unknown bearer matching ownerToken → passes GET /resources (route logic runs)", async () => {
    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources`)
      .set("Authorization", `Bearer ${TEST_OWNER_TOKEN}`);
    expect([200]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("unknown bearer NOT matching ownerToken → 403 from handler ownership check", async () => {
    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources`)
      .set("Authorization", "Bearer wrong-owner-token-value");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Not authorized/i);
  });

  it("revoked API key treated as unknown bearer; if not ownerToken → 403", async () => {
    const created = await createKey("pb-revoke-test", ["sessions:read"]);
    const key: string = created.body.key;
    createdKeyIds.push(created.body.id);
    await revokeKey(created.body.id);

    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources`)
      .set("Authorization", `Bearer ${key}`);
    // Revoked key is not in active DB rows → treated as unknown bearer → 403 ownership fail
    expect(res.status).toBe(403);
  });

  it("expired API key treated as unknown bearer; if not ownerToken → 403", async () => {
    const expiredRaw = "mizi_permit_bearer_expired_" + "x".repeat(40);
    const hash = hashApiKey(expiredRaw);
    const [inserted] = await db
      .insert(apiKeysTable)
      .values({
        keyHash: hash,
        label: "pb-expired-key",
        scopes: ["sessions:read"],
        expiresAt: new Date(Date.now() - 5000),
      })
      .returning();
    createdKeyIds.push(inserted.id);

    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources`)
      .set("Authorization", `Bearer ${expiredRaw}`);
    // Expired key is in DB but expiry check fires → treated as unknown bearer → 403
    expect(res.status).toBe(403);
  });

  it("connection-string endpoint: wrong bearer → 403 ownership check", async () => {
    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources/999999/connection-string`)
      .set("Authorization", "Bearer wrong-bearer-for-conn-str");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Not authorized/i);
  });

  it("connection-string endpoint: ownerToken bearer → passes auth (404 for unknown resource)", async () => {
    const res = await request(app)
      .get(`/api/sessions/${pbSessionId}/resources/999999/connection-string`)
      .set("Authorization", `Bearer ${TEST_OWNER_TOKEN}`);
    // Auth passed — 404 because resource 999999 does not exist
    expect(res.status).toBe(404);
  });

  it("provision endpoint: ownerToken bearer → passes auth (409 because session pending)", async () => {
    const res = await request(app)
      .post(`/api/sessions/${pbSessionId}/provision`)
      .set("Authorization", `Bearer ${TEST_OWNER_TOKEN}`)
      .send({ type: "redis" });
    // Auth + ownership check passed — 409 because session is in "pending" state
    // (no external bridge/Redis/Neon calls are made)
    expect(res.status).toBe(409);
  });

  it("provision endpoint: wrong bearer → 403 ownership check", async () => {
    const res = await request(app)
      .post(`/api/sessions/${pbSessionId}/provision`)
      .set("Authorization", "Bearer wrong-bearer-for-provision")
      .send({ type: "redis" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Not authorized/i);
  });
});
