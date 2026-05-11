/**
 * Auth Routes
 *
 * Machine-to-Machine API Key Management:
 * POST   /auth/keys          — create a new API key (plaintext returned once)
 * GET    /auth/keys          — list active (non-revoked) keys; values never returned
 * DELETE /auth/keys/:id      — revoke a key by id
 *
 * GitHub OAuth (single-operator model):
 * GET    /auth/github         — initiate OAuth flow (redirects to GitHub)
 * GET    /auth/github/callback — OAuth callback (exchanges code for token)
 * GET    /auth/github/status  — returns { connected, login, avatarUrl } — never the raw token
 * DELETE /auth/github         — disconnect (deletes stored token)
 *
 * All key management routes require MIZI_MEM_TOKEN bearer auth.
 * GitHub status and disconnect also require MIZI_MEM_TOKEN.
 * GitHub OAuth initiation and callback are browser-facing (no bearer required).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "crypto";
import { db, apiKeysTable, operatorCredentialsTable } from "@workspace/db";
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
      res.status(503).json({
        error: "Key management is not configured — MIZI_MEM_TOKEN must be set in production",
      });
      return;
    }
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

// ─── GitHub OAuth helpers ─────────────────────────────────────────────────────

/**
 * Derive a 32-byte AES key from MIZI_MEM_TOKEN (or a fallback) using SHA-256.
 * This ensures the key is always exactly the right length for AES-256-GCM.
 */
function deriveEncryptionKey(): Buffer {
  const secret = process.env["MIZI_MEM_TOKEN"];
  const isProd = process.env["NODE_ENV"] === "production";
  if (!secret) {
    if (isProd) {
      throw new Error("MIZI_MEM_TOKEN must be set in production to encrypt stored OAuth tokens");
    }
    // Dev-only non-deterministic stand-in — not suitable for production
    return createHash("sha256").update("mizi-dev-only-key").digest();
  }
  return createHash("sha256").update(secret).digest();
}

function encryptToken(plaintext: string): string {
  const key = deriveEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12B) + tag(16B) + ciphertext — all hex-encoded
  return iv.toString("hex") + tag.toString("hex") + encrypted.toString("hex");
}

function decryptToken(encoded: string): string {
  const key = deriveEncryptionKey();
  const ivHex = encoded.slice(0, 24);
  const tagHex = encoded.slice(24, 56);
  const ctHex = encoded.slice(56);
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString("utf8") + decipher.final("utf8");
}

// Short-lived in-memory state map (oauth state parameter → { expiry, returnOrigin, returnTo })
// Single-operator model: a simple Map is sufficient.
interface OAuthStateEntry {
  expiry: number;
  returnOrigin: string;
  /** Optional full URL to redirect to after OAuth (validated against DASHBOARD_URL). */
  returnTo?: string;
}
const oauthStateMap = new Map<string, OAuthStateEntry>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of oauthStateMap.entries()) {
    if (now > entry.expiry) oauthStateMap.delete(state);
  }
}

// ─── GET /auth/github — initiate OAuth flow ───────────────────────────────────

router.get("/auth/github", (req, res) => {
  const clientId = process.env["GITHUB_OAUTH_CLIENT_ID"];
  if (!clientId) {
    res.status(503).json({ error: "GitHub OAuth is not configured — set GITHUB_OAUTH_CLIENT_ID" });
    return;
  }

  cleanExpiredStates();
  const state = randomBytes(16).toString("hex");

  // Capture the frontend origin so we can redirect back there after OAuth.
  // Security: only redirect to DASHBOARD_URL (explicit config), same API origin, or a
  // Referer/Origin that is HTTPS — preventing open-redirect to arbitrary HTTP URLs.
  const configuredDashboardUrl = (process.env["DASHBOARD_URL"] ?? "").replace(/\/$/, "");
  const apiProto = ((req.headers["x-forwarded-proto"] as string | undefined) || req.protocol || "http").split(",")[0]!.trim();
  const apiHost = ((req.headers["x-forwarded-host"] as string | undefined) || (req.headers["host"] as string | undefined) || "").split(",")[0]!.trim();
  const sameOrigin = apiHost ? `${apiProto}://${apiHost}` : "";

  // Derive candidate origin from browser-set Referer or Origin headers
  const referer = (req.headers["referer"] as string | undefined) ?? "";
  const originHeader = (req.headers["origin"] as string | undefined) ?? "";
  let candidateOrigin = "";
  if (referer) {
    try { candidateOrigin = new URL(referer).origin; } catch { /* ignore */ }
  }
  if (!candidateOrigin && originHeader) {
    candidateOrigin = originHeader.replace(/\/$/, "");
  }

  // Resolve return origin: prefer explicit DASHBOARD_URL, then validate candidate.
  // A candidate is accepted when it matches a known trusted origin (same-origin or
  // configured dashboard URL), OR when it is HTTPS (browser-set Referer is trustworthy
  // for cross-origin dashboard + API deployments as long as we stay on HTTPS).
  let returnOrigin = configuredDashboardUrl; // explicit config always wins
  if (!returnOrigin && candidateOrigin) {
    const isTrusted = candidateOrigin === sameOrigin
      || candidateOrigin.startsWith("https://");
    if (isTrusted) returnOrigin = candidateOrigin;
  }
  // Final fallback to same API origin (never an external domain)
  if (!returnOrigin) returnOrigin = sameOrigin;

  // Optional return_to: a full URL the browser should land on after OAuth.
  // Security: we parse the URL and compare origins exactly — prefix-based
  // startsWith checks are bypassable via crafted hostnames (e.g.
  // https://trusted.com.evil.tld/...).  Only an exact origin match against
  // configuredDashboardUrl and/or sameOrigin is accepted.
  let returnTo: string | undefined;
  const rawReturnTo = (req.query["return_to"] as string | undefined) ?? "";
  if (rawReturnTo) {
    try {
      const returnToUrl = new URL(rawReturnTo);
      // Build the set of accepted origins
      const allowedOrigins = new Set<string>();
      if (configuredDashboardUrl) {
        try { allowedOrigins.add(new URL(configuredDashboardUrl + "/").origin); } catch { /* ignore bad config */ }
      }
      if (sameOrigin) allowedOrigins.add(sameOrigin);

      if (allowedOrigins.size > 0 && allowedOrigins.has(returnToUrl.origin)) {
        returnTo = rawReturnTo;
      } else {
        logger.warn({ rawReturnTo, allowedOrigins: [...allowedOrigins] }, "GitHub OAuth: return_to rejected — origin not trusted");
      }
    } catch {
      logger.warn({ rawReturnTo }, "GitHub OAuth: return_to rejected — invalid URL");
    }
  }

  oauthStateMap.set(state, { expiry: Date.now() + OAUTH_STATE_TTL_MS, returnOrigin, returnTo });

  // Build callback URL from request host so it works in both dev and prod.
  // x-forwarded-proto/host can be comma-separated on multi-hop proxies (e.g. Fly.io);
  // always take the first (outermost) value to avoid a malformed URL.
  const rawProto = (req.headers["x-forwarded-proto"] as string | undefined) || req.protocol || "http";
  const proto = rawProto.split(",")[0]!.trim();
  const rawHost = (req.headers["x-forwarded-host"] as string | undefined) || (req.headers["host"] as string | undefined) || "localhost";
  const host = rawHost.split(",")[0]!.trim();
  const callbackUrl = `${proto}://${host}/api/auth/github/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: "repo",
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// ─── GET /auth/github/callback — OAuth callback ───────────────────────────────

router.get("/auth/github/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query as Record<string, string>;

  // Resolve the returnOrigin from state (even for error cases)
  const stateEntry = state ? oauthStateMap.get(state) : undefined;
  const returnOrigin = stateEntry?.returnOrigin ?? "";

  if (oauthError) {
    logger.warn({ oauthError }, "GitHub OAuth: user denied authorization");
    res.redirect(`${returnOrigin}/?github_oauth=denied`);
    return;
  }

  if (!code || !state) {
    res.status(400).json({ error: "Missing code or state parameter" });
    return;
  }

  cleanExpiredStates();
  if (!stateEntry || Date.now() > stateEntry.expiry) {
    res.status(400).json({ error: "Invalid or expired OAuth state — please try connecting again" });
    return;
  }
  oauthStateMap.delete(state);

  const clientId = process.env["GITHUB_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GITHUB_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    res.status(503).json({ error: "GitHub OAuth is not configured on the server" });
    return;
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    if (!tokenRes.ok) {
      throw new Error(`GitHub token endpoint returned ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      error?: string;
      refresh_token?: string;
      refresh_token_expires_in?: number;
    };
    if (tokenData.error || !tokenData.access_token) {
      throw new Error(tokenData.error || "No access_token in response");
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token ?? null;
    const refreshTokenExpiresAt = tokenData.refresh_token_expires_in
      ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000)
      : null;

    // Fetch authenticated user info
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!userRes.ok) {
      throw new Error(`GitHub user API returned ${userRes.status}`);
    }

    const userData = await userRes.json() as { login?: string; avatar_url?: string };
    const githubLogin = userData.login || null;
    const githubAvatarUrl = userData.avatar_url || null;

    // Encrypt and upsert into operator_credentials
    const encryptedToken = encryptToken(accessToken);
    const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : null;

    // Delete any existing github credential and insert fresh (upsert pattern)
    await db
      .delete(operatorCredentialsTable)
      .where(eq(operatorCredentialsTable.provider, "github"));

    await db.insert(operatorCredentialsTable).values({
      provider: "github",
      accessTokenEncrypted: encryptedToken,
      refreshTokenEncrypted: encryptedRefreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt ?? undefined,
      githubLogin,
      githubAvatarUrl,
    });

    logger.info({ githubLogin }, "GitHub OAuth: token stored successfully");

    // Build the final redirect URL.
    // If the initiating page passed a validated return_to URL, append the
    // github_oauth param to that exact URL so the user lands back on the
    // same page (and same scroll position / dialog state) they started from.
    // Otherwise fall back to the plain origin root.
    let successUrl: string;
    if (stateEntry.returnTo) {
      try {
        const u = new URL(stateEntry.returnTo);
        u.searchParams.set("github_oauth", "connected");
        successUrl = u.toString();
      } catch {
        successUrl = `${returnOrigin}/?github_oauth=connected`;
      }
    } else {
      successUrl = `${returnOrigin}/?github_oauth=connected`;
    }
    res.redirect(successUrl);
  } catch (err) {
    logger.error(err, "GitHub OAuth callback failed");
    // On error, redirect to the return_to URL if available, else root.
    const errBase = stateEntry?.returnTo ?? `${returnOrigin}/`;
    try {
      const u = new URL(errBase);
      u.searchParams.set("github_oauth", "error");
      res.redirect(u.toString());
    } catch {
      res.redirect(`${returnOrigin}/?github_oauth=error`);
    }
  }
});

// ─── GET /auth/github/status — connection status (operator-only) ──────────────

router.get("/auth/github/status", requireOperator, async (_req, res) => {
  try {
    const [row] = await db
      .select({
        githubLogin: operatorCredentialsTable.githubLogin,
        githubAvatarUrl: operatorCredentialsTable.githubAvatarUrl,
      })
      .from(operatorCredentialsTable)
      .where(eq(operatorCredentialsTable.provider, "github"))
      .limit(1);

    if (!row) {
      res.json({ connected: false, login: null, avatarUrl: null });
      return;
    }

    res.json({ connected: true, login: row.githubLogin, avatarUrl: row.githubAvatarUrl });
  } catch (err) {
    logger.error(err, "Failed to fetch GitHub OAuth status");
    res.status(500).json({ error: "Failed to fetch GitHub OAuth status" });
  }
});

// ─── Token refresh helper ─────────────────────────────────────────────────────

/**
 * Attempt to refresh the GitHub access token using the stored refresh token.
 * Returns the new access token on success, or null if refresh is not possible
 * or fails.
 */
async function refreshGitHubToken(): Promise<string | null> {
  const clientId = process.env["GITHUB_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GITHUB_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;

  try {
    const [row] = await db
      .select({
        refreshTokenEncrypted: operatorCredentialsTable.refreshTokenEncrypted,
        refreshTokenExpiresAt: operatorCredentialsTable.refreshTokenExpiresAt,
      })
      .from(operatorCredentialsTable)
      .where(eq(operatorCredentialsTable.provider, "github"))
      .limit(1);

    if (!row?.refreshTokenEncrypted) {
      logger.warn("GitHub token refresh: no refresh token stored");
      return null;
    }

    if (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt < new Date()) {
      logger.warn("GitHub token refresh: refresh token has expired");
      return null;
    }

    const refreshToken = decryptToken(row.refreshTokenEncrypted);

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!tokenRes.ok) {
      logger.warn({ status: tokenRes.status }, "GitHub token refresh: token endpoint returned non-OK status");
      return null;
    }

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      error?: string;
      refresh_token?: string;
      refresh_token_expires_in?: number;
    };

    if (tokenData.error || !tokenData.access_token) {
      logger.warn({ error: tokenData.error }, "GitHub token refresh: failed to get new access token");
      return null;
    }

    const newAccessToken = tokenData.access_token;
    const newRefreshToken = tokenData.refresh_token ?? null;
    const newRefreshTokenExpiresAt = tokenData.refresh_token_expires_in
      ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000)
      : null;

    // Persist the new tokens
    await db
      .update(operatorCredentialsTable)
      .set({
        accessTokenEncrypted: encryptToken(newAccessToken),
        refreshTokenEncrypted: newRefreshToken ? encryptToken(newRefreshToken) : null,
        refreshTokenExpiresAt: newRefreshTokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(operatorCredentialsTable.provider, "github"));

    logger.info("GitHub token refresh: new access token stored successfully");
    return newAccessToken;
  } catch (err) {
    logger.error(err, "GitHub token refresh: unexpected error");
    return null;
  }
}

// ─── GET /auth/github/repos — list operator's GitHub repos (operator-only) ───

type GithubRepoRaw = {
  full_name: string;
  name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  owner: { login: string };
};

function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

const REPOS_PER_PAGE = 100;

type GithubSearchRepoRaw = {
  full_name: string;
  name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  owner: { login: string };
};

async function fetchReposPage(token: string, page: number): Promise<{ repos: GithubRepoRaw[]; hasMore: boolean }> {
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const url = `https://api.github.com/user/repos?sort=updated&per_page=${REPOS_PER_PAGE}&affiliation=owner,organization_member&page=${page}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    throw new Error(`GitHub repos API returned ${r.status}`);
  }
  const repos = await r.json() as GithubRepoRaw[];
  const hasMore = !!parseLinkNext(r.headers.get("Link"));
  return { repos, hasMore };
}

async function getUserOrgs(token: string): Promise<string[]> {
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  try {
    const r = await fetch("https://api.github.com/user/orgs?per_page=100", { headers });
    if (!r.ok) return [];
    const orgs = await r.json() as Array<{ login: string }>;
    return orgs.map((o) => o.login);
  } catch {
    return [];
  }
}

async function searchRepos(token: string, login: string, q: string): Promise<GithubRepoRaw[]> {
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Fetch org memberships in parallel with no extra blocking
  const orgs = await getUserOrgs(token);

  // Build owner qualifiers: personal account + all member orgs
  // GitHub search supports multiple user:/org: qualifiers in one query
  const ownerQualifiers = [`user:${login}`, ...orgs.map((o) => `org:${o}`)].join(" ");
  const query = `${q} ${ownerQualifiers} fork:true`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=30&sort=updated`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    throw new Error(`GitHub search API returned ${r.status}`);
  }
  const data = await r.json() as { items: GithubSearchRepoRaw[] };
  return (data.items ?? []) as GithubRepoRaw[];
}

router.get("/auth/github/repos", requireOperator, async (req, res) => {
  try {
    let token = await getStoredGitHubToken();
    if (!token) {
      res.status(404).json({ error: "No GitHub OAuth token stored — connect GitHub first" });
      return;
    }

    const q = ((req.query["q"] as string | undefined) ?? "").trim();
    const rawPage = parseInt((req.query["page"] as string | undefined) ?? "1", 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    // On 401 from GitHub, attempt token refresh and retry once.
    // Returns false (and sends the 401 response) when refresh fails.
    const tryRefresh = async (): Promise<boolean> => {
      logger.warn("GitHub repos API returned 401 — attempting token refresh");
      const refreshed = await refreshGitHubToken();
      if (!refreshed) {
        res.status(401).json({
          error: "GitHub token expired and could not be refreshed — please reconnect",
          reconnect_required: true,
        });
        return false;
      }
      token = refreshed;
      return true;
    };

    if (q) {
      // Server-side search via GitHub search API
      const [row] = await db
        .select({ githubLogin: operatorCredentialsTable.githubLogin })
        .from(operatorCredentialsTable)
        .where(eq(operatorCredentialsTable.provider, "github"))
        .limit(1);
      const login = row?.githubLogin ?? "";
      if (!login) {
        res.status(404).json({ error: "GitHub login not found — reconnect GitHub" });
        return;
      }
      let data;
      try {
        data = await searchRepos(token, login, q);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("401"))) throw err;
        if (!await tryRefresh()) return;
        data = await searchRepos(token, login, q);
      }
      res.json({
        repos: data.map((repo) => ({
          fullName: repo.full_name,
          name: repo.name,
          owner: repo.owner.login,
          private: repo.private,
          htmlUrl: repo.html_url,
          cloneUrl: repo.clone_url,
        })),
        hasMore: false,
        page,
      });
    } else {
      // Paginated browse — fetch one page at a time
      let result;
      try {
        result = await fetchReposPage(token, page);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("401"))) throw err;
        if (!await tryRefresh()) return;
        result = await fetchReposPage(token, page);
      }
      const { repos: data, hasMore } = result;
      res.json({
        repos: data.map((repo) => ({
          fullName: repo.full_name,
          name: repo.name,
          owner: repo.owner.login,
          private: repo.private,
          htmlUrl: repo.html_url,
          cloneUrl: repo.clone_url,
        })),
        hasMore,
        page,
      });
    }
  } catch (err) {
    logger.error(err, "Failed to fetch GitHub repos");
    res.status(500).json({ error: "Failed to fetch GitHub repos" });
  }
});

// ─── DELETE /auth/github — disconnect (operator-only) ────────────────────────

router.delete("/auth/github", requireOperator, async (_req, res) => {
  try {
    await db
      .delete(operatorCredentialsTable)
      .where(eq(operatorCredentialsTable.provider, "github"));

    logger.info("GitHub OAuth: token disconnected");
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "Failed to disconnect GitHub OAuth token");
    res.status(500).json({ error: "Failed to disconnect GitHub OAuth token" });
  }
});

// ─── getStoredGitHubToken — internal helper for session launch ────────────────

/**
 * Load and decrypt the stored GitHub OAuth token from operator_credentials.
 * Returns null if no token is stored. Used by the session creation handler
 * to auto-inject the token without requiring the dashboard to pass it.
 */
export async function getStoredGitHubToken(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ accessTokenEncrypted: operatorCredentialsTable.accessTokenEncrypted })
      .from(operatorCredentialsTable)
      .where(eq(operatorCredentialsTable.provider, "github"))
      .limit(1);

    if (!row) return null;
    return decryptToken(row.accessTokenEncrypted);
  } catch (err) {
    logger.warn(err, "Failed to load stored GitHub OAuth token");
    return null;
  }
}

export default router;
