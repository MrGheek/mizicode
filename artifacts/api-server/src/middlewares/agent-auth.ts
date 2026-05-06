import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db, apiKeysTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export type ApiKeyRecord = typeof apiKeysTable.$inferSelect;

declare module "express-serve-static-core" {
  interface Request {
    apiKey?: ApiKeyRecord;
  }
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ─── Shared validation core ───────────────────────────────────────────────────

/**
 * Validate a raw Bearer token against the api_keys table and check scopes.
 * Returns the key record on success, or sets an error response and returns null.
 * Does NOT handle MIZI_MEM_TOKEN pass-through — callers handle that first.
 */
async function validateApiKey(
  raw: string,
  requiredScopes: string[],
  res: Response
): Promise<ApiKeyRecord | null> {
  const hash = hashApiKey(raw);

  let keyRecord: ApiKeyRecord | undefined;
  try {
    const [row] = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.keyHash, hash));
    keyRecord = row;
  } catch (err) {
    logger.error(err, "agent-auth: DB lookup failed");
    res.status(500).json({ error: "Internal server error" });
    return null;
  }

  if (!keyRecord) {
    res.status(401).json({ error: "Invalid API key" });
    return null;
  }

  if (keyRecord.revokedAt) {
    res.status(401).json({ error: "API key has been revoked" });
    return null;
  }

  if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
    res.status(401).json({ error: "API key has expired" });
    return null;
  }

  if (requiredScopes.length > 0) {
    const keyScopes = (keyRecord.scopes as string[]) ?? [];
    const missing = requiredScopes.filter((s) => !keyScopes.includes(s));
    if (missing.length > 0) {
      res.status(403).json({ error: `Missing required scopes: ${missing.join(", ")}` });
      return null;
    }
  }

  // Record last-used timestamp asynchronously — don't block the request.
  db.update(apiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeysTable.id, keyRecord.id))
    .catch((err) => logger.warn(err, "agent-auth: failed to update last_used_at"));

  return keyRecord;
}

// ─── requireAgentAuth ─────────────────────────────────────────────────────────

/**
 * Strict middleware: every request MUST carry a valid Bearer token.
 * Use on agent-only endpoints and mixed endpoints where the operator
 * can pass MIZI_MEM_TOKEN as the dashboard/internal credential.
 *
 * Auth logic:
 *  - Dev mode (no MIZI_MEM_TOKEN set, no bearer header): open pass-through.
 *  - No bearer header (any other case): 401.
 *  - MIZI_MEM_TOKEN bearer present and matches: pass-through for operator/internal.
 *  - Bearer present but not MIZI_MEM_TOKEN: validate as API key.
 *    API-key validation works regardless of whether MIZI_MEM_TOKEN is configured.
 *
 * Env vars are read lazily (at call time) so tests can stub them via
 * process.env assignment before making requests.
 */
export function requireAgentAuth(requiredScopes: string[] = []) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const memToken = process.env["MIZI_MEM_TOKEN"] || "";
    const isProd = process.env["NODE_ENV"] === "production";

    const auth = (req.headers["authorization"] as string | undefined) ?? "";
    const raw = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    // Dev bypass: no token configured, no bearer presented, not production.
    if (!memToken && !raw && !isProd) {
      next();
      return;
    }

    // Auth is required: reject missing credentials.
    if (!raw) {
      res.status(401).json({ error: "Missing Bearer token" });
      return;
    }

    // MIZI_MEM_TOKEN bearer → pass-through for operator/internal callers.
    if (memToken && raw === memToken) {
      next();
      return;
    }

    // Validate as an API key (works regardless of MIZI_MEM_TOKEN configuration).
    const keyRecord = await validateApiKey(raw, requiredScopes, res);
    if (!keyRecord) return;

    req.apiKey = keyRecord;
    next();
  };
}

// ─── optionalAgentAuth ────────────────────────────────────────────────────────

/**
 * Optional middleware: pass-through if NO Authorization header is present
 * (unauthenticated browser or internal requests carry no token), but validate
 * FULLY when a header IS present. This is the correct posture for endpoints
 * that serve both unauthenticated callers and M2M agents.
 *
 * Behaviour:
 *  - No Authorization header → next() unconditionally
 *  - MIZI_MEM_TOKEN bearer → next() (operator/internal pass-through)
 *  - Valid API key with required scopes → next(), req.apiKey populated
 *  - Invalid / revoked / expired key → 401
 *  - Key missing required scope → 403
 *  - Dev mode (no MIZI_MEM_TOKEN, token present): still validates the token
 *
 * Env vars are read lazily so tests can stub via process.env assignment.
 */
export function optionalAgentAuth(requiredScopes: string[] = []) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const memToken = process.env["MIZI_MEM_TOKEN"] || "";

    const auth = (req.headers["authorization"] as string | undefined) ?? "";
    const raw = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    // No Authorization header → unauthenticated pass-through.
    if (!raw) {
      next();
      return;
    }

    // MIZI_MEM_TOKEN bearer → pass-through for operator/internal callers.
    if (memToken && raw === memToken) {
      next();
      return;
    }

    // Authorization header present: validate as API key.
    const keyRecord = await validateApiKey(raw, requiredScopes, res);
    if (!keyRecord) return;

    req.apiKey = keyRecord;
    next();
  };
}
