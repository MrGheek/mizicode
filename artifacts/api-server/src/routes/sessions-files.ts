import { Router } from "express";
import { db, sessionsTable, provisionedResourcesTable, schemaTemplatesTable, lanePromptSnapshotsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import * as neonService from "../services/neon";
import * as tigrisService from "../services/tigris";
import * as fly from "../services/fly";
import * as vastai from "../services/vastai";
import { getBridge, getBridgeForSession, tryAcquireExecLock, releaseExecLock } from "../services/bridge-registry";
import { logger } from "../lib/logger";
import { requireAgentAuth, permitBearer, type ApiKeyRecord } from "../middlewares/agent-auth";
import { encryptConnectionString, decryptConnectionString, maskConnectionString } from "../lib/encrypt";
import { FILE_SIZE_LIMIT_BYTES, WORKSPACE_ROOT, validateWorkspacePath, verifyFileToken, execViaBridge, cleanupSessionResources } from "./sessions-common";

const router = Router();

/**
 * Best-effort: write DATABASE_URL and/or REDIS_URL into /workspace/.env.test
 * inside the running workspace instance. Tries Fly exec first (NIM sessions),
 * then falls back to sending a shell message over the Claw Bridge.
 */
async function injectEnvVars(
  session: typeof sessionsTable.$inferSelect,
  vars: Record<string, string>
): Promise<void> {
  // ── NIM / Fly path ─────────────────────────────────────────────────────────
  // Persist env vars permanently in the Fly machine config (survives restarts)
  // then inject into the running filesystem via exec so they're available
  // to processes spawned in the current container lifetime.
  if (session.provider === "nim" && session.flyMachineId) {
    try {
      await fly.patchMachineEnv(session.flyMachineId, vars);
      logger.info({ sessionId: session.id, vars: Object.keys(vars) }, "Env vars patched on Fly Machine config");
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "Fly Machine env patch failed (non-fatal — continuing with exec)");
    }
    try {
      const shellCmd = vastai.buildEnvInjectionCmd(vars);
      await fly.execMachineCommand(session.flyMachineId, ["sh", "-c", shellCmd]);
      logger.info({ sessionId: session.id, vars: Object.keys(vars) }, "Env vars injected into NIM workspace via Fly exec");
      return;
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "Fly exec env injection failed — falling back to bridge");
    }
  }

  // ── Vast.ai (and fallback) path — Claw Bridge ──────────────────────────────
  // Vast.ai workspaces communicate exclusively over the Claw Bridge; there is
  // no server-side SSH client. The bridge shell message writes to both
  // /workspace/.env.test (workspace convention) and /etc/environment
  // (system-wide, survives new shell spawns).
  const bridge = getBridge(session.id, 0);
  if (bridge && bridge.readyState === bridge.OPEN) {
    try {
      const shellCmd = vastai.buildEnvInjectionCmd(vars);
      bridge.send(JSON.stringify({ type: "shell", cmd: shellCmd }));
      logger.info({ sessionId: session.id, provider: session.provider, vars: Object.keys(vars) }, "Env vars injected via Claw Bridge");
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "Bridge env injection failed (non-fatal)");
    }
  } else {
    logger.info({ sessionId: session.id, provider: session.provider }, "injectEnvVars: no bridge connected — skipping (connection string returned in API response)");
  }
}

// GET /sessions/:sessionId/resources — list provisioned resources (connection strings masked)
// Dashboard reads this without credentials (data is masked); agents may present ownerToken/API key.
router.get("/sessions/:sessionId/resources", permitBearer(["sessions:read"], { optional: true }), async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db
    .select({ id: sessionsTable.id, ownerToken: sessionsTable.ownerToken })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Ownership check: raw bearer (not a validated API key) must match session ownerToken.
  // Validated API keys (req.apiKey set) already passed scope checks — allow cross-session access.
  const { rawBearer: listRawBearer, apiKey: listApiKey } = req as typeof req & { rawBearer?: string; apiKey?: ApiKeyRecord };
  if (listRawBearer && !listApiKey) {
    if (!session.ownerToken || listRawBearer !== session.ownerToken) {
      res.status(403).json({ error: "Not authorized to access this session's resources" });
      return;
    }
  }

  const resources = await db
    .select()
    .from(provisionedResourcesTable)
    .where(eq(provisionedResourcesTable.sessionId, sessionId))
    .orderBy(desc(provisionedResourcesTable.createdAt));

  // Return masked connection strings in the list — use the reveal endpoint for the full string
  const masked = resources.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    type: r.type,
    resourceId: r.resourceId,
    connectionString: r.connectionString ? maskConnectionString(r.connectionString) : null,
    schemaTemplateId: r.schemaTemplateId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    deletedAt: r.deletedAt,
  }));

  res.json(masked);
});

// GET /sessions/:sessionId/resources/:resourceId/connection-string — reveal full connection string
router.get("/sessions/:sessionId/resources/:resourceId/connection-string", permitBearer(["sessions:read"]), async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  const resourceId = parseInt(String(req.params["resourceId"] ?? ""), 10);
  if (isNaN(sessionId) || isNaN(resourceId)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  // Ownership check: unknown bearer must match session ownerToken
  const { rawBearer: revealRawBearer } = req as typeof req & { rawBearer?: string };
  if (revealRawBearer) {
    const [session] = await db
      .select({ ownerToken: sessionsTable.ownerToken })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));
    if (!session || !session.ownerToken || revealRawBearer !== session.ownerToken) {
      res.status(403).json({ error: "Not authorized to access this session's resources" });
      return;
    }
  }

  const [resource] = await db
    .select()
    .from(provisionedResourcesTable)
    .where(
      and(
        eq(provisionedResourcesTable.id, resourceId),
        eq(provisionedResourcesTable.sessionId, sessionId)
      )
    );

  if (!resource) {
    res.status(404).json({ error: "Resource not found" });
    return;
  }

  let plain: string | null = null;
  if (resource.connectionString) {
    try {
      plain = decryptConnectionString(resource.connectionString);
    } catch (err) {
      logger.error({ err, sessionId, resourceId }, "Failed to decrypt connection string");
      res.status(500).json({ error: "Failed to decrypt connection string" });
      return;
    }
  }

  res.json({ connectionString: plain });
});

// POST /sessions/:sessionId/provision — provision a Postgres branch or Redis instance
// Dashboard may call this without credentials; agents use ownerToken/API key.
// Session ownership is enforced via ownerToken when an unrecognised bearer is present.
router.post("/sessions/:sessionId/provision", permitBearer(["sessions:write"], { optional: true }), async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const { type, schemaTemplate } = req.body as {
    type?: string;
    schemaTemplate?: string | number;
  };

  if (!type || !["postgres", "postgres-branch", "redis", "storage"].includes(type)) {
    res.status(400).json({ error: "type must be 'postgres', 'postgres-branch', 'redis', or 'storage'" });
    return;
  }

  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Ownership check: raw bearer (not a validated API key) must match session ownerToken.
  // Validated API keys (req.apiKey set) already passed scope checks — allow cross-session access.
  const { rawBearer: provRawBearer, apiKey: provApiKey } = req as typeof req & { rawBearer?: string; apiKey?: ApiKeyRecord };
  if (provRawBearer && !provApiKey) {
    if (!session.ownerToken || provRawBearer !== session.ownerToken) {
      res.status(403).json({ error: "Not authorized to provision resources for this session" });
      return;
    }
  }

  if (session.status !== "ready") {
    res.status(409).json({ error: `Session must be in 'ready' state to provision resources (current: ${session.status})` });
    return;
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  if (type === "postgres" || type === "postgres-branch") {
    let sqlContent: string | undefined;
    let schemaTemplateId: number | undefined;

    if (schemaTemplate) {
      const tmplId = typeof schemaTemplate === "number"
        ? schemaTemplate
        : parseInt(String(schemaTemplate), 10);

      if (!isNaN(tmplId)) {
        const [tmpl] = await db
          .select()
          .from(schemaTemplatesTable)
          .where(eq(schemaTemplatesTable.id, tmplId));
        if (tmpl) {
          sqlContent = tmpl.sqlContent;
          schemaTemplateId = tmpl.id;
        }
      }
    }

    if (!neonService.isNeonConfigured()) {
      // In-container Postgres fallback: provision an ephemeral Postgres instance
      // by running initdb + pg_ctl start via the mizi_execute shielded path.
      // This works even when no system Postgres server is running.
      const bridge = getBridge(sessionId, 0);
      if (!bridge || bridge.readyState !== bridge.OPEN) {
        res.status(503).json({
          error: "Neon is not configured and no Claw Bridge is connected for in-container fallback. " +
            "Set NEON_API_KEY and NEON_PROJECT_ID, or ensure the session bridge is connected.",
          fallback: "none",
        });
        return;
      }

      // Allocate a per-session port in the ephemeral range (25432 + sessionId % 10000)
      // and a fresh data directory under /workspace/.mizi/ (writable in the Claw container).
      const pgPort = 25432 + (sessionId % 10000);
      const pgDir  = `/workspace/.mizi/pg_${sessionId}_${Date.now()}`;
      const dbName = `mizi_test_${sessionId}`;
      const marker = `PG_READY:${dbName}:${pgPort}`;

      // Script uses mizi_execute for initdb/pg_ctl (shielded — may produce large output)
      // and bare commands for createdb + the marker line (must appear verbatim in output).
      const setupScript = [
        `mkdir -p /workspace/.mizi`,
        `mizi_execute initdb -D "${pgDir}" --no-sync -U postgres 2>&1 | tail -2`,
        `mizi_execute pg_ctl -D "${pgDir}" -o "-p ${pgPort} -k /tmp" -l /tmp/pg_${sessionId}.log start -w 2>&1 | tail -2`,
        `createdb -h /tmp -p ${pgPort} -U postgres "${dbName}" 2>&1`,
        `echo "${marker}"`,
      ].join(" && ");

      let pgReady = false;

      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("In-container Postgres startup timed out (30 s)")), 30000);
          const handler = (data: Buffer) => {
            try {
              const msg = JSON.parse(data.toString()) as Record<string, unknown>;
              if (msg.type === "shell_output" && typeof msg.output === "string") {
                if ((msg.output as string).includes(marker)) {
                  pgReady = true;
                  clearTimeout(t);
                  bridge.off("message", handler);
                  resolve();
                }
              }
            } catch {}
          };
          bridge.on("message", handler);
          bridge.send(JSON.stringify({ type: "shell", cmd: setupScript }));
        });
      } catch (err) {
        logger.error({ err, sessionId, pgDir }, "In-container Postgres startup failed");
        res.status(500).json({ error: "In-container Postgres startup timed out or failed" });
        return;
      }

      if (!pgReady) {
        res.status(500).json({ error: "In-container Postgres did not confirm readiness" });
        return;
      }

      // Connect via Unix socket (/tmp/.s.PGSQL.<port>) to avoid network config.
      const connectionString = `postgresql://postgres@localhost:${pgPort}/${dbName}?host=/tmp`;

      if (sqlContent) {
        const applyCmd = `psql -h /tmp -p ${pgPort} -U postgres -d "${dbName}" -c ${JSON.stringify(sqlContent)} 2>&1`;
        bridge.send(JSON.stringify({ type: "shell", cmd: applyCmd }));
      }

      // Store resourceId as "local:<pgDir>:<pgPort>" so cleanup can stop the server.
      const localResourceId = `local:${pgDir}:${pgPort}`;

      const [resource] = await db
        .insert(provisionedResourcesTable)
        .values({ sessionId, type: "postgres", resourceId: localResourceId, connectionString: encryptConnectionString(connectionString), schemaTemplateId: schemaTemplateId ?? null, expiresAt })
        .returning();

      injectEnvVars(session, { DATABASE_URL: connectionString }).catch(() => {});

      logger.info({ sessionId, pgDir, pgPort, dbName }, "In-container ephemeral Postgres provisioned");
      res.status(201).json({
        id: resource.id,
        sessionId: resource.sessionId,
        type: resource.type,
        resourceId: resource.resourceId,
        connectionString,
        schemaTemplateId: resource.schemaTemplateId,
        createdAt: resource.createdAt,
        expiresAt: resource.expiresAt,
        fallback: "in-container",
      });
      return;
    }

    try {
      const result = await neonService.createBranch(sessionId, sqlContent);

      const [resource] = await db
        .insert(provisionedResourcesTable)
        .values({
          sessionId,
          type,
          resourceId: result.branchId,
          connectionString: encryptConnectionString(result.connectionString),
          schemaTemplateId: schemaTemplateId ?? null,
          expiresAt,
        })
        .returning();

      injectEnvVars(session, { DATABASE_URL: result.connectionString }).catch(() => {});

      logger.info({ sessionId, type, branchId: result.branchId }, "Postgres branch provisioned");

      res.status(201).json({
        id: resource.id,
        sessionId: resource.sessionId,
        type: resource.type,
        resourceId: resource.resourceId,
        connectionString: result.connectionString,
        schemaTemplateId: resource.schemaTemplateId,
        createdAt: resource.createdAt,
        expiresAt: resource.expiresAt,
      });
    } catch (err: unknown) {
      logger.error({ err, sessionId }, "Failed to provision Postgres branch");
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `Postgres provisioning failed: ${message}` });
    }
    return;
  }

  if (type === "redis") {
    const bridge = getBridge(sessionId, 0);
    if (!bridge || bridge.readyState !== bridge.OPEN) {
      res.status(503).json({
        error: "Claw Bridge is not connected for this session",
        retryAfter: 10,
      });
      return;
    }

    // Use a random ephemeral port to avoid collisions when multiple resources are provisioned
    const port = 20000 + Math.floor(Math.random() * 5000);
    const cmd = `redis-server --port ${port} --daemonize yes --logfile /workspace/.mizi/redis-${port}.log 2>&1 && sleep 0.5 && echo "REDIS_PID:$(pgrep -f 'redis-server.*--port ${port}' | head -1):PORT:${port}"`;

    try {
      let pidFromOutput: string | undefined;
      let portFromOutput: number = port;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Redis startup timed out (8 s)")), 8000);

        const msgHandler = (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString()) as Record<string, unknown>;
            if (msg.type === "shell_output" && typeof msg.output === "string") {
              const match = (msg.output as string).match(/REDIS_PID:(\d*):PORT:(\d+)/);
              if (match) {
                pidFromOutput = match[1];
                portFromOutput = parseInt(match[2] ?? String(port), 10);
                clearTimeout(timeout);
                bridge.off("message", msgHandler);
                resolve();
              }
            }
          } catch {}
        };

        bridge.on("message", msgHandler);
        bridge.send(JSON.stringify({ type: "shell", cmd }));
      });

      // Reject a PID of "0" — redis-server didn't actually start
      if (!pidFromOutput || pidFromOutput === "0") {
        res.status(500).json({ error: "Redis server did not confirm startup (PID not reported)" });
        return;
      }

      const connectionString = `redis://localhost:${portFromOutput}`;
      // resourceId format: "<pid>:<port>" — cleanup can safely split on ":"
      const resourceIdentifier = `${pidFromOutput}:${portFromOutput}`;

      const [resource] = await db
        .insert(provisionedResourcesTable)
        .values({
          sessionId,
          type: "redis",
          resourceId: resourceIdentifier,
          connectionString: encryptConnectionString(connectionString),
          expiresAt,
        })
        .returning();

      injectEnvVars(session, { REDIS_URL: connectionString }).catch(() => {});

      logger.info({ sessionId, port: portFromOutput, pid: pidFromOutput }, "Redis instance provisioned");

      res.status(201).json({
        id: resource.id,
        sessionId: resource.sessionId,
        type: resource.type,
        resourceId: resource.resourceId,
        connectionString,
        schemaTemplateId: resource.schemaTemplateId,
        createdAt: resource.createdAt,
        expiresAt: resource.expiresAt,
      });
    } catch (err: unknown) {
      logger.error({ err, sessionId }, "Failed to provision Redis");
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `Redis provisioning failed: ${message}` });
    }
    return;
  }

  if (type === "storage") {
    if (!tigrisService.isTigrisConfigured()) {
      res.status(503).json({
        error: "Tigris storage is not configured. Set TIGRIS_TOKEN or FLY_API_TOKEN to enable storage provisioning.",
      });
      return;
    }

    try {
      const result = await tigrisService.createBucket(sessionId);

      const [resource] = await db
        .insert(provisionedResourcesTable)
        .values({
          sessionId,
          type: "storage",
          resourceId: result.bucketName,
          connectionString: encryptConnectionString(result.endpoint),
          expiresAt,
        })
        .returning();

      injectEnvVars(session, {
        BUCKET_NAME: result.bucketName,
        AWS_ACCESS_KEY_ID: result.accessKeyId,
        AWS_SECRET_ACCESS_KEY: result.secretAccessKey,
        AWS_ENDPOINT_URL_S3: result.endpoint,
        AWS_REGION: result.region,
      }).catch(() => {});

      logger.info({ sessionId, bucketName: result.bucketName }, "Tigris storage bucket provisioned");

      res.status(201).json({
        id: resource.id,
        sessionId: resource.sessionId,
        type: resource.type,
        resourceId: resource.resourceId,
        bucketName: result.bucketName,
        endpoint: result.endpoint,
        region: result.region,
        createdAt: resource.createdAt,
        expiresAt: resource.expiresAt,
      });
    } catch (err: unknown) {
      logger.error({ err, sessionId }, "Failed to provision Tigris storage bucket");
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `Storage provisioning failed: ${message}` });
    }
    return;
  }
});

// GET /sessions/:id/files?path=<dir>&token=<ownerToken>
// Returns a JSON array of { name, type, size } for the directory at <path>.
// Defaults to /workspace when path is not supplied.
router.get("/sessions/:id/files", async (req, res) => {
  const sessionId = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const providedToken = typeof req.query["token"] === "string" ? req.query["token"].trim() : "";
  try {
    await verifyFileToken(sessionId, providedToken, false);
  } catch (authErr: unknown) {
    const e = authErr as Error & { code?: number };
    res.status(e.code ?? 401).json({ error: e.message });
    return;
  }

  const rawPath = typeof req.query["path"] === "string" ? req.query["path"].trim() : WORKSPACE_ROOT;

  try {
    validateWorkspacePath(rawPath);
  } catch (pathErr: unknown) {
    const e = pathErr as Error & { code?: number };
    res.status(e.code ?? 400).json({ error: e.message });
    return;
  }

  const escaped = rawPath.replace(/'/g, "'\\''");
  // realpath resolves symlinks in-container; we re-validate after resolution
  // so that a symlink pointing outside /workspace is still blocked.
  const command = [
    "python3 -c \"",
    "import os,json,sys;",
    "p=os.path.realpath(sys.argv[1]);",
    "assert p=='/workspace' or p.startswith('/workspace/'),'symlink escapes workspace';",
    "entries=[];",
    "[entries.append({'name':e.name,'type':'dir' if e.is_dir(follow_symlinks=False) else 'file','size':e.stat(follow_symlinks=False).st_size}) for e in sorted(os.scandir(p),key=lambda x:(x.is_file(),x.name.lower()))];",
    "print(json.dumps(entries))",
    `\" '${escaped}'`,
  ].join("");

  try {
    const output = await execViaBridge(sessionId, command);
    const lines = output.trim().split("\n");
    // Find last non-empty line that looks like JSON (the scandir output)
    let jsonLine = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]?.trim() ?? "";
      if (l.startsWith("[")) { jsonLine = l; break; }
    }
    if (!jsonLine) {
      res.json([]);
      return;
    }
    const entries = JSON.parse(jsonLine) as Array<{ name: string; type: string; size: number }>;
    res.json(entries);
  } catch (err: unknown) {
    const e = err as Error & { code?: number };
    logger.warn({ err, sessionId, rawPath }, "File tree listing failed");
    res.status(e.code ?? 500).json({ error: e.message ?? "Listing failed" });
  }
});

// GET /sessions/:id/files/content?path=<filepath>&token=<ownerToken>
// Returns the raw file content as { content: string }.
// Rejects files over 500 KB.
router.get("/sessions/:id/files/content", async (req, res) => {
  const sessionId = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const providedToken = typeof req.query["token"] === "string" ? req.query["token"].trim() : "";
  try {
    await verifyFileToken(sessionId, providedToken, false);
  } catch (authErr: unknown) {
    const e = authErr as Error & { code?: number };
    res.status(e.code ?? 401).json({ error: e.message });
    return;
  }

  const rawPath = typeof req.query["path"] === "string" ? req.query["path"].trim() : "";
  try {
    validateWorkspacePath(rawPath);
  } catch (pathErr: unknown) {
    const e = pathErr as Error & { code?: number };
    res.status(e.code ?? 400).json({ error: e.message });
    return;
  }

  const escaped = rawPath.replace(/'/g, "'\\''");

  // Check size first (realpath canonicalizes symlinks; assertion re-validates
  // the resolved path is still within /workspace).
  const sizeCommand = `python3 -c "import os,sys; p=os.path.realpath(sys.argv[1]); assert p.startswith('/workspace/'),'symlink escapes workspace'; s=os.stat(p).st_size; print(s)" '${escaped}'`;
  try {
    const sizeOut = await execViaBridge(sessionId, sizeCommand);
    const size = parseInt(sizeOut.trim().split("\n").pop() ?? "0", 10);
    if (size > FILE_SIZE_LIMIT_BYTES) {
      res.status(413).json({ error: `File too large (${size} bytes, limit ${FILE_SIZE_LIMIT_BYTES})` });
      return;
    }
  } catch (err: unknown) {
    const e = err as Error & { code?: number };
    res.status(e.code ?? 500).json({ error: e.message ?? "Could not stat file" });
    return;
  }

  // Read file as base64 to safely handle arbitrary text encodings.
  // Realpath re-validated here to cover the gap between stat and read.
  const readCommand = `python3 -c "import base64,os,sys; p=os.path.realpath(sys.argv[1]); assert p.startswith('/workspace/'),'symlink escapes workspace'; print(base64.b64encode(open(p,'rb').read()).decode())" '${escaped}'`;
  try {
    const b64Out = await execViaBridge(sessionId, readCommand);
    const b64 = b64Out.trim().split("\n").pop() ?? "";
    const content = Buffer.from(b64, "base64").toString("utf8");
    res.json({ content });
  } catch (err: unknown) {
    const e = err as Error & { code?: number };
    logger.warn({ err, sessionId, rawPath }, "File read failed");
    res.status(e.code ?? 500).json({ error: e.message ?? "Read failed" });
  }
});

// PUT /sessions/:id/files/content
// Body: { path: string; content: string }
// Writes the content back to the file via base64 bridge exec.
// AUTHORIZATION: requires Authorization: Bearer <ownerToken> (owner-only).
router.put("/sessions/:id/files/content", async (req, res) => {
  const sessionId = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  // Write requires the owner token in Authorization header.
  const authHeader = req.headers["authorization"] ?? "";
  const providedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  try {
    await verifyFileToken(sessionId, providedToken, true);
  } catch (authErr: unknown) {
    const e = authErr as Error & { code?: number };
    res.status(e.code ?? 401).json({ error: e.message });
    return;
  }

  const { path: rawPath, content } = req.body as { path?: string; content?: string };
  try {
    validateWorkspacePath(rawPath ?? "");
  } catch (pathErr: unknown) {
    const e = pathErr as Error & { code?: number };
    res.status(e.code ?? 400).json({ error: e.message });
    return;
  }
  if (typeof content !== "string") {
    res.status(400).json({ error: "content must be a string" });
    return;
  }
  if (Buffer.byteLength(content, "utf8") > FILE_SIZE_LIMIT_BYTES) {
    res.status(413).json({ error: "Content too large" });
    return;
  }

  const escaped = (rawPath as string).replace(/'/g, "'\\''");
  const b64Content = Buffer.from(content, "utf8").toString("base64");

  // Realpath validates resolved canonical path before writing so a symlink
  // pointing outside /workspace cannot be used to overwrite arbitrary files.
  const writeCommand = `python3 -c "import base64,os,sys; p=os.path.realpath(sys.argv[1]); assert p.startswith('/workspace/'),'symlink escapes workspace'; open(p,'wb').write(base64.b64decode(sys.argv[2]))" '${escaped}' '${b64Content}'`;

  try {
    await execViaBridge(sessionId, writeCommand);
    res.json({ ok: true });
  } catch (err: unknown) {
    const e = err as Error & { code?: number };
    logger.warn({ err, sessionId, rawPath }, "File write failed");
    res.status(e.code ?? 500).json({ error: e.message ?? "Write failed" });
  }
});

router.get(
  "/sessions/:sessionId/lanes/:laneId/prompt-snapshot",
  requireAgentAuth(["sessions:read"]),
  async (req, res) => {
    const sessionId = Number(req.params["sessionId"]);
    const laneId = Number(req.params["laneId"]);
    if (!Number.isFinite(sessionId) || !Number.isFinite(laneId)) {
      res.status(400).json({ error: "Invalid session or lane ID" });
      return;
    }
    try {
      const [snapshot] = await db
        .select()
        .from(lanePromptSnapshotsTable)
        .where(
          and(
            eq(lanePromptSnapshotsTable.sessionId, sessionId),
            eq(lanePromptSnapshotsTable.laneId, laneId),
          ),
        )
        .orderBy(desc(lanePromptSnapshotsTable.activatedAt))
        .limit(1);
      if (!snapshot) {
        res.status(404).json({ error: "No prompt snapshot found for this lane" });
        return;
      }
      res.json(snapshot);
    } catch (err) {
      logger.warn({ err, sessionId, laneId }, "Failed to fetch prompt snapshot");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

export default router;
