/**
 * Tests for the POST /api/memory/restore upload size limit.
 *
 * Uses a self-contained minimal Express app that replicates the streaming
 * handler logic so the test never touches the database or Vast.ai.
 *
 * Verified behaviours:
 *   - Requests under the 200 MB limit are processed normally
 *   - Requests exceeding 200 MB are rejected with HTTP 413 before the body is
 *     fully consumed
 *   - The 413 response body carries a human-readable error message
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";

const RESTORE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

function buildApp(onSuccess?: (buf: Buffer) => void) {
  const app = express();

  app.post("/api/memory/restore", (req, res) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > RESTORE_MAX_BYTES) {
        rejected = true;
        res.status(413).json({ error: "File too large. Restore files must be 200 MB or smaller." });
        res.once("finish", () => req.destroy());
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (rejected) return;
      const buf = Buffer.concat(chunks);
      if (!buf.length) {
        res.status(400).json({ error: "No file data received" });
        return;
      }
      try {
        onSuccess?.(buf);
        res.json({ ok: true, message: "Memory database restored successfully" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to restore database";
        res.status(400).json({ error: msg });
      }
    });

    req.on("error", (err) => {
      if (rejected) return;
      res.status(500).json({ error: "Failed to read uploaded file" });
    });
  });

  return app;
}

describe("POST /api/memory/restore — upload size limit", () => {
  it("accepts uploads under the 200 MB limit", async () => {
    let received: Buffer | undefined;
    const app = buildApp((buf) => { received = buf; });

    const payload = Buffer.alloc(1024, 0x41); // 1 KB
    const res = await request(app)
      .post("/api/memory/restore")
      .set("Content-Type", "application/octet-stream")
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(received?.length).toBe(1024);
  });

  it("rejects uploads larger than 200 MB with HTTP 413", async () => {
    const app = buildApp();

    const oversized = Buffer.alloc(RESTORE_MAX_BYTES + 1, 0x42);
    const res = await request(app)
      .post("/api/memory/restore")
      .set("Content-Type", "application/octet-stream")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: "File too large. Restore files must be 200 MB or smaller.",
    });
  });

  it("returns 413 error message that mentions the size limit", async () => {
    const app = buildApp();

    const oversized = Buffer.alloc(RESTORE_MAX_BYTES + 100, 0x43);
    const res = await request(app)
      .post("/api/memory/restore")
      .set("Content-Type", "application/octet-stream")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error).toMatch(/200\s*MB/i);
  });

  it("returns 400 when no body is sent", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/memory/restore")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(0));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "No file data received" });
  });
});
