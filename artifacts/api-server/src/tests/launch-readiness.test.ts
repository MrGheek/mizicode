/**
 * Launch-readiness tests (Task #233).
 *
 * Covers the critical user-facing flows that must work before MIZI ships
 * to operators:
 *
 *   1. Passive recall backfill must not crash on a fresh memory DB. Reproduces
 *      the "no such table: mem_items" bug that surfaced during boot when
 *      memory.ts's getDb() hadn't been called before backfill.
 *
 *   2. Coordination claim creation must surface blast-radius overlap when
 *      another lane has claimed a file that's adjacent in the repo graph
 *      (i.e. the new claim does NOT directly overlap any existing claim
 *      path, but does share a dependency).
 *
 *   3. The instance-status callback must accept the structured failure
 *      phases (provisioning_failed, download_failed, vllm_warmup_failed,
 *      skills_compile_failed, disk_full) and persist them as status="error"
 *      with a `boot_failure:<cause>` marker the dashboard can parse.
 *
 *   4. The instance-status callback must reject unknown phase names and
 *      reject unauthenticated requests when MIZI_MEM_TOKEN is configured.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// Use a fresh on-disk SQLite memory DB for the passive recall test.
let tmpDir: string;
const originalMemDir = process.env["MEM_DATA_DIR"];
const originalToken = process.env["MIZI_MEM_TOKEN"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-readiness-"));
  process.env["MEM_DATA_DIR"] = tmpDir;
  process.env["MIZI_MEM_TOKEN"] = "test-launch-readiness-token";
});

afterAll(() => {
  if (originalMemDir !== undefined) process.env["MEM_DATA_DIR"] = originalMemDir;
  else delete process.env["MEM_DATA_DIR"];
  if (originalToken !== undefined) process.env["MIZI_MEM_TOKEN"] = originalToken;
  else delete process.env["MIZI_MEM_TOKEN"];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Avoid network in the embedding pipeline — the lexical TF-IDF fallback is
// exercised by the real backfill code and is sufficient for this smoke test.
vi.mock("../services/memory-semantic", () => ({
  computeSemanticSimilarityBatch: vi.fn(async (_q: string, cs: string[]) => cs.map(() => 0)),
  cosineSimilarity: () => 0,
  tfidfCosineSimilarity: () => 0,
  computeSemanticSimilarity: vi.fn(),
}));

describe("launch readiness — passive recall backfill on fresh DB", () => {
  it("does not throw 'no such table: mem_items' on a freshly initialised memory DB", async () => {
    // Calling runPassiveRecallBackfill in isolation BEFORE any other memory
    // route has been touched is exactly the boot-time path that broke
    // before Task #233. The fix in memory.ts ensures runGovernanceMigrations
    // runs first.
    const { runPassiveRecallBackfill } = await import("../services/memory");
    await expect(runPassiveRecallBackfill(50)).resolves.toBeTypeOf("number");
  });
});

describe("launch readiness — coordination claim blast radius", () => {
  it("surfaces blastRadiusOverlap > 0 when claiming a file adjacent in the repo graph", async () => {
    const request = (await import("supertest")).default;
    const app = (await import("../app")).default;
    const dbModule = await import("@workspace/db");
    const { db, gpuProfilesTable, sessionsTable, sessionLanesTable, laneClaimsTable, sessionRepoContextTable } = dbModule;
    const { eq, inArray } = await import("drizzle-orm");

    // ── Test fixture ──────────────────────────────────────────────────────
    const profileName = `launch-readiness-blast-${Date.now()}`;
    const [profile] = await db.insert(gpuProfilesTable).values({
      name: profileName, displayName: "Test", gpuName: "A100", numGpus: 1,
      totalVram: 80, dockerImageTag: "test:latest", defaultQuant: "Q4_K_M",
      quantSizeGb: 10, diskSizeGb: 50, estimatedSpeedMin: 20, estimatedSpeedMax: 40,
      estimatedCostMin: 0.5, estimatedCostMax: 1.0, searchParams: {},
    }).returning();
    const [session] = await db.insert(sessionsTable).values({
      profileId: profile.id, status: "ready",
    }).returning();
    const [laneA] = await db.insert(sessionLanesTable).values({
      sessionId: session.id, memberIdentifier: "alice", laneType: "feature",
    }).returning();
    const [laneB] = await db.insert(sessionLanesTable).values({
      sessionId: session.id, memberIdentifier: "bob", laneType: "feature",
    }).returning();

    // Seed a repo graph where src/ui/button.tsx imports src/lib/utils.ts.
    // Alice claims utils.ts (downstream); Bob then claims button.tsx (upstream).
    // Their paths don't directly overlap, but the graph link makes them
    // blast-radius adjacent.
    await db.insert(sessionRepoContextTable).values({
      sessionId: session.id,
      repoPath: "/tmp/test-repo",
      edgesJson: [
        { from: "src/ui/button.tsx", to: "src/lib/utils.ts" },
      ] as unknown as object,
    });

    await db.insert(laneClaimsTable).values({
      laneId: laneA.id, claimType: "file", pathOrSymbol: "src/lib/utils.ts",
      claimStrength: "soft", active: true,
      claimedAt: new Date(), lastHeartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    try {
      const res = await request(app)
        .post(`/api/sessions/${session.id}/lanes/${laneB.id}/claim`)
        .set("Authorization", "Bearer test-launch-readiness-token")
        .send({ resourcePath: "src/ui/button.tsx", claimStrength: "soft" });

      expect(res.status).toBe(201);
      expect(res.body.overlaps).toBeDefined();
      // The hardcoded `blastRadiusOverlap = 0` bug would have produced no
      // overlap entry at all (overlapScore is also 0 for non-overlapping
      // paths). With the fix, the graph edge means we expect at least one
      // overlap entry whose blastRadiusOverlap > 0.
      const withBlast = (res.body.overlaps as Array<{ blastRadiusOverlap: number }>)
        .filter(o => o.blastRadiusOverlap > 0);
      expect(withBlast.length).toBeGreaterThan(0);
    } finally {
      // Cleanup
      const lanes = await db.select({ id: sessionLanesTable.id })
        .from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, session.id));
      const laneIds = lanes.map(l => l.id);
      if (laneIds.length) await db.delete(laneClaimsTable).where(inArray(laneClaimsTable.laneId, laneIds));
      await db.delete(sessionRepoContextTable).where(eq(sessionRepoContextTable.sessionId, session.id));
      await db.delete(sessionLanesTable).where(eq(sessionLanesTable.sessionId, session.id));
      await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
      await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, profile.id));
    }
  });
});

describe("launch readiness — instance status callback", () => {
  it("accepts structured failure phases and persists them with the boot_failure marker", async () => {
    const request = (await import("supertest")).default;
    const app = (await import("../app")).default;
    const dbModule = await import("@workspace/db");
    const { db, gpuProfilesTable, sessionsTable } = dbModule;
    const { eq } = await import("drizzle-orm");

    const profileName = `launch-readiness-callback-${Date.now()}`;
    const [profile] = await db.insert(gpuProfilesTable).values({
      name: profileName, displayName: "Test", gpuName: "A100", numGpus: 1,
      totalVram: 80, dockerImageTag: "test:latest", defaultQuant: "Q4_K_M",
      quantSizeGb: 10, diskSizeGb: 50, estimatedSpeedMin: 20, estimatedSpeedMax: 40,
      estimatedCostMin: 0.5, estimatedCostMax: 1.0, searchParams: {},
    }).returning();
    const [session] = await db.insert(sessionsTable).values({
      profileId: profile.id, status: "starting",
    }).returning();

    // Each case mirrors the report_failure() shape that docker/onstart.sh
    // actually sends in production: a structured cause plus a human message.
    // The marker MUST survive both the no-message and with-message paths.
    const FAILURE_CASES: Array<{ cause: string; message?: string }> = [
      { cause: "provisioning_failed", message: "Container provisioning failed (exit 137) — see boot log for details" },
      { cause: "download_failed",     message: "Model weight download from HuggingFace failed after 3 attempts" },
      { cause: "download_stalled",    message: "Model download stalled — no progress for 180s" },
      { cause: "vllm_warmup_failed",  message: "vLLM did not respond to /health within 600s — check /var/log/vllm-server.log" },
      { cause: "skills_compile_failed", message: "Failed to decode MIZI_ACTIVE_BUNDLE_B64 — Smart Skills unavailable this session" },
      { cause: "disk_full",           message: "Host disk full during boot — destroy this session and retry on a different host" },
      // Bare cause with no message — fallback path. Marker must still survive.
      { cause: "vllm_warmup_failed" },
    ];

    try {
      for (const { cause, message } of FAILURE_CASES) {
        // Reset to a non-error status so each iteration is independent.
        await db.update(sessionsTable)
          .set({ status: "starting", statusMessage: null })
          .where(eq(sessionsTable.id, session.id));

        const payload: { status: string; message?: string } = { status: cause };
        if (message) payload.message = message;

        const res = await request(app)
          .post(`/api/sessions/${session.id}/status`)
          .set("Authorization", "Bearer test-launch-readiness-token")
          .send(payload);

        expect(res.status, `phase ${cause}`).toBe(200);
        expect(res.body.status).toBe("error");

        const [updated] = await db.select()
          .from(sessionsTable).where(eq(sessionsTable.id, session.id));
        expect(updated.status).toBe("error");
        // Critical: the structured `boot_failure:<cause>` marker MUST be
        // preserved verbatim so parseBootFailure() in the dashboard can
        // surface a suggested next step. This regression killed the guided
        // failure UX in the first revision of Task #233.
        expect(updated.statusMessage ?? "", `phase ${cause} marker`)
          .toMatch(new RegExp(`boot_failure:${cause}`));
        // When the agent supplied a human message, it must also be present
        // in the persisted text — the marker prefix wraps it, never replaces it.
        if (message) {
          expect(updated.statusMessage ?? "", `phase ${cause} message`).toContain(message);
        }
      }
    } finally {
      await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
      await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, profile.id));
    }
  });

  it("rejects unknown status phase names with 400", async () => {
    const request = (await import("supertest")).default;
    const app = (await import("../app")).default;
    const dbModule = await import("@workspace/db");
    const { db, gpuProfilesTable, sessionsTable } = dbModule;
    const { eq } = await import("drizzle-orm");

    const profileName = `launch-readiness-unknown-${Date.now()}`;
    const [profile] = await db.insert(gpuProfilesTable).values({
      name: profileName, displayName: "Test", gpuName: "A100", numGpus: 1,
      totalVram: 80, dockerImageTag: "test:latest", defaultQuant: "Q4_K_M",
      quantSizeGb: 10, diskSizeGb: 50, estimatedSpeedMin: 20, estimatedSpeedMax: 40,
      estimatedCostMin: 0.5, estimatedCostMax: 1.0, searchParams: {},
    }).returning();
    const [session] = await db.insert(sessionsTable).values({
      profileId: profile.id, status: "starting",
    }).returning();

    try {
      const res = await request(app)
        .post(`/api/sessions/${session.id}/status`)
        .set("Authorization", "Bearer test-launch-readiness-token")
        .send({ status: "wat_is_this_phase" });
      expect(res.status).toBe(400);
    } finally {
      await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
      await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, profile.id));
    }
  });

  it("rejects unauthenticated callback requests when MIZI_MEM_TOKEN is set", async () => {
    const request = (await import("supertest")).default;
    const app = (await import("../app")).default;
    const dbModule = await import("@workspace/db");
    const { db, gpuProfilesTable, sessionsTable } = dbModule;
    const { eq } = await import("drizzle-orm");

    const profileName = `launch-readiness-authz-${Date.now()}`;
    const [profile] = await db.insert(gpuProfilesTable).values({
      name: profileName, displayName: "Test", gpuName: "A100", numGpus: 1,
      totalVram: 80, dockerImageTag: "test:latest", defaultQuant: "Q4_K_M",
      quantSizeGb: 10, diskSizeGb: 50, estimatedSpeedMin: 20, estimatedSpeedMax: 40,
      estimatedCostMin: 0.5, estimatedCostMax: 1.0, searchParams: {},
    }).returning();
    const [session] = await db.insert(sessionsTable).values({
      profileId: profile.id, status: "starting",
    }).returning();

    try {
      const noAuth = await request(app)
        .post(`/api/sessions/${session.id}/status`)
        .send({ status: "services_ready" });
      expect(noAuth.status).toBe(401);

      const wrongAuth = await request(app)
        .post(`/api/sessions/${session.id}/status`)
        .set("Authorization", "Bearer wrong-token")
        .send({ status: "services_ready" });
      expect(wrongAuth.status).toBe(401);
    } finally {
      await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
      await db.delete(gpuProfilesTable).where(eq(gpuProfilesTable.id, profile.id));
    }
  });
});
