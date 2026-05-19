/**
 * Tests for Tigris object storage provisioning (Task #451).
 *
 * Covers:
 * - isTigrisConfigured() guard
 * - createBucket() happy path and error handling
 * - deleteBucket() happy path, 204 No Content, and 404 graceful handling
 * - POST /api/sessions/:id/provision with { type: "storage" } → 503 when unconfigured
 * - POST /api/sessions/:id/provision with { type: "storage" } → reaches provisioning logic when configured
 * - Type validation: unknown types still rejected with 400; "storage" is now a valid type
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, gpuProfilesTable, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const originalTigrisToken = process.env["TIGRIS_TOKEN"];
const originalFlyToken = process.env["FLY_API_TOKEN"];

afterAll(() => {
  if (originalTigrisToken !== undefined) process.env["TIGRIS_TOKEN"] = originalTigrisToken;
  else delete process.env["TIGRIS_TOKEN"];
  if (originalFlyToken !== undefined) process.env["FLY_API_TOKEN"] = originalFlyToken;
  else delete process.env["FLY_API_TOKEN"];
});

describe("isTigrisConfigured()", () => {
  it("returns false when neither TIGRIS_TOKEN nor FLY_API_TOKEN is set", async () => {
    delete process.env["TIGRIS_TOKEN"];
    delete process.env["FLY_API_TOKEN"];
    const { isTigrisConfigured } = await import("../services/tigris");
    expect(isTigrisConfigured()).toBe(false);
  });

  it("returns true when TIGRIS_TOKEN is set", async () => {
    process.env["TIGRIS_TOKEN"] = "test-tigris-token";
    delete process.env["FLY_API_TOKEN"];
    const { isTigrisConfigured } = await import("../services/tigris");
    expect(isTigrisConfigured()).toBe(true);
    delete process.env["TIGRIS_TOKEN"];
  });

  it("returns true when FLY_API_TOKEN is set (fallback)", async () => {
    delete process.env["TIGRIS_TOKEN"];
    process.env["FLY_API_TOKEN"] = "test-fly-token";
    const { isTigrisConfigured } = await import("../services/tigris");
    expect(isTigrisConfigured()).toBe(true);
    delete process.env["FLY_API_TOKEN"];
  });
});

describe("createBucket()", () => {
  it("throws when Tigris is not configured", async () => {
    delete process.env["TIGRIS_TOKEN"];
    delete process.env["FLY_API_TOKEN"];
    const { createBucket } = await import("../services/tigris");
    await expect(createBucket(1)).rejects.toThrow(/TIGRIS_TOKEN/i);
  });

  it("returns bucket credentials on success", async () => {
    process.env["TIGRIS_TOKEN"] = "test-token";

    const mockResponse = {
      bucket: {
        name: "mizi-session-42-1234567890",
        access_key_id: "AKIATEST",
        secret_access_key: "secretkey",
        endpoint_url: "https://fly.storage.tigris.dev",
        region: "auto",
      },
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(mockResponse),
    }));

    const { createBucket } = await import("../services/tigris");
    const result = await createBucket(42);

    expect(result.bucketName).toBe("mizi-session-42-1234567890");
    expect(result.accessKeyId).toBe("AKIATEST");
    expect(result.secretAccessKey).toBe("secretkey");
    expect(result.endpoint).toBe("https://fly.storage.tigris.dev");
    expect(result.region).toBe("auto");

    vi.unstubAllGlobals();
    delete process.env["TIGRIS_TOKEN"];
  });

  it("throws when API returns an error", async () => {
    process.env["TIGRIS_TOKEN"] = "test-token";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => "Internal Server Error",
    }));

    const { createBucket } = await import("../services/tigris");
    await expect(createBucket(99)).rejects.toThrow(/Tigris API error 500/);

    vi.unstubAllGlobals();
    delete process.env["TIGRIS_TOKEN"];
  });
});

describe("deleteBucket()", () => {
  it("resolves successfully on 200 OK", async () => {
    process.env["TIGRIS_TOKEN"] = "test-token";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
    }));

    const { deleteBucket } = await import("../services/tigris");
    await expect(deleteBucket("mizi-session-42-abc")).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    delete process.env["TIGRIS_TOKEN"];
  });

  it("resolves successfully on 204 No Content without JSON parse error", async () => {
    process.env["TIGRIS_TOKEN"] = "test-token";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: { get: () => null },
      text: async () => "",
    }));

    const { deleteBucket } = await import("../services/tigris");
    await expect(deleteBucket("mizi-session-42-abc")).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    delete process.env["TIGRIS_TOKEN"];
  });

  it("treats 404 as success (bucket already gone)", async () => {
    process.env["TIGRIS_TOKEN"] = "test-token";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => "Not Found",
    }));

    const { deleteBucket } = await import("../services/tigris");
    await expect(deleteBucket("mizi-session-gone")).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    delete process.env["TIGRIS_TOKEN"];
  });

  it("skips deletion when not configured (non-fatal)", async () => {
    delete process.env["TIGRIS_TOKEN"];
    delete process.env["FLY_API_TOKEN"];

    const { deleteBucket } = await import("../services/tigris");
    await expect(deleteBucket("some-bucket")).resolves.toBeUndefined();
  });
});

describe("POST /api/sessions/:id/provision — storage type", () => {
  let profileId: number;
  let sessionId: number;

  beforeAll(async () => {
    const profileName = `test-storage-prov-${Date.now()}`;
    const [profile] = await db.insert(gpuProfilesTable).values({
      name: profileName, displayName: "Test Storage", gpuName: "A100", numGpus: 1,
      totalVram: 80, dockerImageTag: "test:latest", defaultQuant: "Q4_K_M",
      quantSizeGb: 10, diskSizeGb: 50, estimatedSpeedMin: 20, estimatedSpeedMax: 40,
      estimatedCostMin: 0.5, estimatedCostMax: 1.0, searchParams: {},
    }).returning();
    profileId = profile!.id;

    const [session] = await db.insert(sessionsTable).values({
      name: `storage-prov-test-${Date.now()}`,
      status: "ready",
      profileId,
      providerKind: "nim",
    }).returning();
    sessionId = session!.id;
  });

  afterAll(async () => {
    if (sessionId) await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId)).catch(() => {});
    if (profileId) await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, profileId)).catch(() => {});
  });

  it("rejects unknown resource types with 400", async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/provision`)
      .send({ type: "unknown-type" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type must be/i);
  });

  it("accepts 'storage' as a valid type (does not return 400)", async () => {
    delete process.env["TIGRIS_TOKEN"];
    delete process.env["FLY_API_TOKEN"];

    const res = await request(app)
      .post(`/api/sessions/${sessionId}/provision`)
      .send({ type: "storage" });

    expect(res.status).not.toBe(400);
  });

  it("returns 503 when Tigris is not configured", async () => {
    delete process.env["TIGRIS_TOKEN"];
    delete process.env["FLY_API_TOKEN"];

    const res = await request(app)
      .post(`/api/sessions/${sessionId}/provision`)
      .send({ type: "storage" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/TIGRIS_TOKEN/i);
  });

  it("attempts to provision when TIGRIS_TOKEN is set (mocked API → 201)", async () => {
    process.env["TIGRIS_TOKEN"] = "test-tigris-provision-token";

    const mockBucket = {
      bucket: {
        name: `mizi-session-${sessionId}-test`,
        access_key_id: "AKIATEST123",
        secret_access_key: "secretaccesskey",
        endpoint_url: "https://fly.storage.tigris.dev",
        region: "auto",
      },
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(mockBucket),
    }));

    const res = await request(app)
      .post(`/api/sessions/${sessionId}/provision`)
      .send({ type: "storage" });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("storage");
    expect(res.body.bucketName).toBe(`mizi-session-${sessionId}-test`);
    expect(res.body.endpoint).toBe("https://fly.storage.tigris.dev");
    expect(res.body.region).toBe("auto");

    vi.unstubAllGlobals();
    delete process.env["TIGRIS_TOKEN"];
  });
});
