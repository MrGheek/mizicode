/**
 * Machine-to-Machine API Key Management
 *
 * POST   /auth/keys          — create a new API key (plaintext returned once)
 * GET    /auth/keys          — list active (non-revoked) keys; values never returned
 * DELETE /auth/keys/:id      — revoke a key by id
 *
 * All three routes are operator-only: they require the same MIZI_MEM_TOKEN
 * bearer used by the ambient/safety and memory control-plane surfaces.
 * In dev mode (no MIZI_MEM_TOKEN set) they are open, exactly matching the
 * posture of those existing surfaces.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "crypto";
import { db, apiKeysTable } from "@workspace/db";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { logger } from "../lib/logger";
import { hashApiKey } from "../middlewares/agent-auth";

const router = Router();

// ─── Operator guard (same pattern as ambient.ts requireOperator) ──────────────

function requireOperator(req: Request, res: Response, next: NextFunction): void {
  const token = process.env["MIZI_MEM_TOKEN"] || "";
  const isProd = process.env["NODE_ENV"] === "production";

  if (!token) {
    if (isProd) {
      // Fail closed: key management in production requires MIZI_MEM_TOKEN.
      res.status(503).json({
        error: "Key management is not configured — MIZI_MEM_TOKEN must be set in production",
      });
      return;
    }
    // Dev mode: open access, mirrors memory/ambient posture.
    next();
    return;
  }

  const auth = (req.headers["authorization"] as string | undefined) ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (bearer !== token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.use("/auth/keys", requireOperator);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a cryptographically random API key with a recognisable prefix. */
function generateApiKey(): string {
  const raw = randomBytes(32).toString("hex");
  return `mizi_${raw}`;
}

// ─── POST /auth/keys — create a new API key ───────────────────────────────────

router.post("/auth/keys", async (req, res) => {
  const { label, scopes, expiresAt: expiresAtRaw } = req.body as {
    label?: string;
    scopes?: string[];
    expiresAt?: string;
  };

  if (!label || typeof label !== "string" || !label.trim()) {
    res.status(400).json({ error: "label is required" });
    return;
  }

  const resolvedScopes: string[] = Array.isArray(scopes) ? scopes : [];
  let expiresAt: Date | null = null;
  if (expiresAtRaw) {
    expiresAt = new Date(expiresAtRaw);
    if (isNaN(expiresAt.getTime())) {
      res.status(400).json({ error: "Invalid expiresAt — must be an ISO 8601 date string" });
      return;
    }
    if (expiresAt <= new Date()) {
      res.status(400).json({ error: "expiresAt must be in the future" });
      return;
    }
  }

  const plaintext = generateApiKey();
  const keyHash = hashApiKey(plaintext);

  try {
    const [created] = await db
      .insert(apiKeysTable)
      .values({
        keyHash,
        label: label.trim(),
        scopes: resolvedScopes,
        expiresAt: expiresAt ?? undefined,
      })
      .returning();

    logger.info({ keyId: created.id, label: created.label }, "API key created");

    res.status(201).json({
      id: created.id,
      key: plaintext,
      label: created.label,
      scopes: created.scopes,
      expiresAt: created.expiresAt?.toISOString() ?? null,
      createdAt: created.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error(err, "Failed to create API key");
    res.status(500).json({ error: "Failed to create API key" });
  }
});

// ─── GET /auth/keys — list active keys (values never returned) ────────────────

router.get("/auth/keys", async (_req, res) => {
  try {
    const keys = await db
      .select({
        id: apiKeysTable.id,
        label: apiKeysTable.label,
        scopes: apiKeysTable.scopes,
        expiresAt: apiKeysTable.expiresAt,
        lastUsedAt: apiKeysTable.lastUsedAt,
        createdAt: apiKeysTable.createdAt,
      })
      .from(apiKeysTable)
      .where(
        // Exclude revoked and already-expired keys from the "active" list.
        and(
          isNull(apiKeysTable.revokedAt),
          or(isNull(apiKeysTable.expiresAt), gt(apiKeysTable.expiresAt, new Date()))
        )
      )
      .orderBy(apiKeysTable.createdAt);

    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        label: k.label,
        scopes: k.scopes,
        expiresAt: k.expiresAt?.toISOString() ?? null,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        createdAt: k.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error(err, "Failed to list API keys");
    res.status(500).json({ error: "Failed to list API keys" });
  }
});

// ─── DELETE /auth/keys/:id — revoke a key ────────────────────────────────────

router.delete("/auth/keys/:id", async (req, res) => {
  const raw = req.params["id"] ?? "";
  const id = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid key ID" });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: apiKeysTable.id, revokedAt: apiKeysTable.revokedAt })
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, id));

    if (!existing) {
      res.status(404).json({ error: "API key not found" });
      return;
    }

    if (existing.revokedAt) {
      res.status(409).json({ error: "API key is already revoked" });
      return;
    }

    await db
      .update(apiKeysTable)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeysTable.id, id));

    logger.info({ keyId: id }, "API key revoked");
    res.json({ ok: true, id });
  } catch (err) {
    logger.error(err, "Failed to revoke API key");
    res.status(500).json({ error: "Failed to revoke API key" });
  }
});

export default router;
