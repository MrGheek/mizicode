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
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, apiKeysTable } from "@workspace/db";
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

  it("returns 401 when no Authorization header is supplied (MIZI_MEM_TOKEN is configured)", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send({});
    expect(res.status).toBe(401);
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

  it("returns 403 when key lacks sessions:write scope", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", `Bearer ${noScopeKey2}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scope/i);
  });

  it("returns 401 when a revoked sessions:write key is used", async () => {
    const created = await createKey("sessions-revoke-test", ["sessions:write"]);
    const key: string = created.body.key;
    const id: number = created.body.id;
    createdKeyIds.push(id);

    await revokeKey(id);

    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", `Bearer ${key}`)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it("returns 401 for an unknown key presented to POST /sessions", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", "Bearer mizi_unknown_key_for_sessions_test")
      .send({});
    expect(res.status).toBe(401);
  });
});
