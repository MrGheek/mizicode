import http from "http";
import path from "path";
import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { db, pool, laneClaimsTable, claimPurgeLogsTable, sessionsTable } from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";

// ─── Distribution mode ────────────────────────────────────────────────────────
// Resolved first so every conditional below can use it.
// esbuild constant-folds this when the local packaging script passes
// --define:'process.env.MIZI_DISTRIBUTION="local"', eliminating all
// cloud-only dynamic import() branches from the local bundle.
const IS_LOCAL_DISTRIBUTION = process.env.MIZI_DISTRIBUTION === "local";

const CLAIM_RETENTION_DAYS = parseInt(process.env["CLAIM_RETENTION_DAYS"] ?? "7", 10);
const CLAIM_CLEANUP_INTERVAL_MS = parseInt(process.env["CLAIM_CLEANUP_INTERVAL_MS"] ?? String(60 * 60 * 1000), 10);

if (isNaN(CLAIM_RETENTION_DAYS) || CLAIM_RETENTION_DAYS <= 0) {
  throw new Error(`Invalid CLAIM_RETENTION_DAYS value: "${process.env["CLAIM_RETENTION_DAYS"]}"`);
}
if (isNaN(CLAIM_CLEANUP_INTERVAL_MS) || CLAIM_CLEANUP_INTERVAL_MS <= 0) {
  throw new Error(`Invalid CLAIM_CLEANUP_INTERVAL_MS value: "${process.env["CLAIM_CLEANUP_INTERVAL_MS"]}"`);
}

logger.info({ CLAIM_RETENTION_DAYS, CLAIM_CLEANUP_INTERVAL_MS }, "Claim purge config resolved");

/**
 * Permanently delete inactive claims older than the retention window.
 * Runs hourly to keep the table lean without impacting in-flight operations.
 * Only called in cloud distribution mode (never in MIZI_DISTRIBUTION=local).
 */
async function purgeOldInactiveClaims(): Promise<void> {
  try {
    const retentionCutoff = new Date(Date.now() - CLAIM_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(laneClaimsTable)
      .where(and(
        eq(laneClaimsTable.active, false),
        lt(laneClaimsTable.expiresAt, retentionCutoff),
      ))
      .returning({ id: laneClaimsTable.id });
    const count = deleted.length;
    await db.insert(claimPurgeLogsTable).values({
      rowsDeleted: count,
      retentionDays: CLAIM_RETENTION_DAYS,
    });
    if (count > 0) {
      logger.info({ count, retentionDays: CLAIM_RETENTION_DAYS }, "Old inactive lane claims purged");
    }
  } catch (err) {
    logger.error({ err }, "Failed to purge old inactive lane claims");
  }
}

function startClaimPurger(): void {
  purgeOldInactiveClaims();
  setInterval(purgeOldInactiveClaims, CLAIM_CLEANUP_INTERVAL_MS);
  logger.info({ intervalMs: CLAIM_CLEANUP_INTERVAL_MS, retentionDays: CLAIM_RETENTION_DAYS }, "Inactive claim purge job scheduled");
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ─── Memory data directory validation — cloud/Fly.io only ─────────────────────
// In local distribution the workspace directory is user-managed and is created
// by the setup script; skipping here avoids false-positive startup failures on
// devices that haven't run the install yet.
if (!IS_LOCAL_DISTRIBUTION) {
  const { validateMemoryDataDir } = await import("./services/memory.js");
  try {
    validateMemoryDataDir();
  } catch (err) {
    logger.error({ err }, "Memory data directory validation failed — aborting startup");
    process.exit(1);
  }
}

// Local distribution skips cloud-specific secrets checks entirely.
// MIZI_ENCRYPTION_KEY, MIZI_MEM_TOKEN, and DASHBOARD_URL are cloud/Fly.io
// concerns — they are not required (and cannot be reasonably expected) when
// running on a user's home server or Raspberry Pi.

// Production guard: MIZI_ENCRYPTION_KEY must be set when NODE_ENV=production
// to ensure provisioned connection strings are encrypted at rest.
// Skipped in local distribution mode — there are no provisioned cloud instances.
if (!IS_LOCAL_DISTRIBUTION && process.env["NODE_ENV"] === "production" && !process.env["MIZI_ENCRYPTION_KEY"]) {
  logger.error("MIZI_ENCRYPTION_KEY is required in production — provisioned connection strings would be stored in plaintext. Set a 64-hex-char key and restart.");
  process.exit(1);
}

// Production guard: MIZI_MEM_TOKEN must be set when NODE_ENV=production.
// Without it, deriveEncryptionKey() throws mid-OAuth-callback, causing the
// GitHub token to never be stored and the user to see ?github_oauth=error.
// Skipped in local distribution — OAuth token encryption is not required on-device.
if (!IS_LOCAL_DISTRIBUTION && process.env["NODE_ENV"] === "production" && !process.env["MIZI_MEM_TOKEN"]) {
  logger.error("MIZI_MEM_TOKEN is required in production — GitHub OAuth token encryption will crash at runtime without it. Generate one with: openssl rand -hex 32");
  process.exit(1);
}

// Production guard: FLY_API_TOKEN must be set when NODE_ENV=production.
// Without it, all NIM session create/destroy calls to the Fly Machines API
// will throw immediately with a clear error, but that error surfaces as a
// confusing "provisioning error" in the dashboard rather than a missing-secret
// message. Catching it at startup makes the root cause unambiguous in logs.
if (!IS_LOCAL_DISTRIBUTION && process.env["NODE_ENV"] === "production" && !process.env["FLY_API_TOKEN"]) {
  logger.error(
    "FLY_API_TOKEN is required in production — NIM workspace machines cannot be provisioned without it. " +
    "Generate a token with: fly tokens create deploy -x 999999h  " +
    "Then set it with: fly secrets set --app mizi-api FLY_API_TOKEN=<token>"
  );
  process.exit(1);
}

// Production guard: FLY_WORKSPACE_APP_NAME must be explicitly set.
// FLY_APP_NAME (injected by Fly into every machine) is intentionally NOT
// accepted here because workspace machines and API machines must be in
// separate Fly apps. Falling back to FLY_APP_NAME would create workspace
// machines inside the API server's own app, bypassing isolation.
// Missing this = session provisioning creates machines in the wrong app
// and per-session workspace URLs route to random API machines.
if (!IS_LOCAL_DISTRIBUTION && process.env["NODE_ENV"] === "production" &&
    !process.env["FLY_WORKSPACE_APP_NAME"]) {
  logger.error(
    "FLY_WORKSPACE_APP_NAME is required in production — workspace machines cannot be provisioned without it. " +
    "Create the workspace app once with: flyctl apps create mizi-workspace  " +
    "Then set it with: fly secrets set --app mizi-api FLY_WORKSPACE_APP_NAME=mizi-workspace"
  );
  process.exit(1);
}

// Production warning: DASHBOARD_URL should be set when the dashboard and API
// are on different origins (the typical Fly.io deployment: mizicode.fly.dev +
// mizi-api.fly.dev).  Without it, OAuth redirects use a placeholder value.
// Not applicable to local distribution — the dashboard is served from the same
// process via a static file handler or local dev server.
if (!IS_LOCAL_DISTRIBUTION && process.env["NODE_ENV"] === "production" && !process.env["DASHBOARD_URL"]) {
  logger.warn("DASHBOARD_URL is not set — GitHub OAuth redirects will use a placeholder. Set DASHBOARD_URL to the production dashboard origin.");
}

// ─── Local SQLite migration ───────────────────────────────────────────────────
if (IS_LOCAL_DISTRIBUTION) {
  try {
    const { runLocalMigrations } = await import("./services/local-migrate.js");
    runLocalMigrations();
    logger.info("Local SQLite migrations complete");
  } catch (err) {
    logger.warn({ err }, "Local SQLite migration failed (non-fatal) — DB may be incomplete");
  }
}

// In production (cloud), migrations are applied by the Fly.io release command
// (dist/migrate.mjs) before any instances start, so we skip them here.
//
// In development, run migrations at startup with a pg advisory lock so
// concurrent processes (e.g. dev server + test runner) don't deadlock.
// Migration failures are non-fatal in dev — the server still starts so
// developers can iterate without a fully-seeded local DB.
if (!IS_LOCAL_DISTRIBUTION && process.env.DATABASE_URL && process.env["NODE_ENV"] !== "production") {
  const MIGRATION_LOCK_KEY = 1297044553; // 0x4d495a49 — "MIZI"
  let migClient;
  try {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    migClient = await pool.connect();
    await migClient.query(`SELECT pg_advisory_lock($1::bigint)`, [MIGRATION_LOCK_KEY]);
    const migrationsFolder = path.join(__dirname, "migrations");
    await migrate(db, { migrationsFolder });
    logger.info("Database migrations applied (dev)");
  } catch (err) {
    logger.warn({ err }, "Database migration failed in dev (non-fatal) — run: pnpm --filter @workspace/db migrate");
  } finally {
    if (migClient) {
      try { await migClient.query(`SELECT pg_advisory_unlock($1::bigint)`, [MIGRATION_LOCK_KEY]); } catch (_) { }
      migClient.release();
    }
  }
} else if (!IS_LOCAL_DISTRIBUTION && !process.env.DATABASE_URL) {
  logger.warn("DATABASE_URL not set — skipping migrations");
}

// ─── HTTP server + WebSocket bridge ──────────────────────────────────────────
// Wrap the Express app in a raw http.Server so we can intercept WebSocket
// upgrade events for the claw bridge at /api/bridge/:sessionId/:laneId
// and for the workspace proxy at /api/sessions/:id/workspace.

const server = http.createServer(app);

// Bridge URL pattern: /api/bridge/:sessionId/:laneId
const BRIDGE_PATH_RE = /^\/api\/bridge\/(\d+)\/(\d+)(\/|\?.*)?$/;

// Workspace proxy URL pattern: /api/sessions/:id/workspace (and sub-paths)
// WebSocket upgrades on this path are Vite HMR connections that must be
// forwarded to the correct Fly Machine via Fly.io private networking (6PN).
const WORKSPACE_PATH_RE = /^\/api\/sessions\/(\d+)\/workspace(\/.*)?$/;

if (!IS_LOCAL_DISTRIBUTION) {
  // Cloud distribution: WebSocket bridge for claw runner sessions.
  // handleBridgeUpgrade is imported dynamically so esbuild can eliminate it
  // (and the entire bridge module) from local distribution bundles.
  const { handleBridgeUpgrade } = await import("./routes/bridge.js");
  const { getWorkspaceProxy } = await import("./routes/sessions.js");
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const url = req.url ?? "";

    // ── Workspace proxy WebSocket (Vite HMR) ─────────────────────────────
    const wsMatch = WORKSPACE_PATH_RE.exec(url);
    if (wsMatch) {
      const sessionId = parseInt(wsMatch[1], 10);
      if (!Number.isFinite(sessionId)) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      try {
        const [session] = await db
          .select({ flyMachineId: sessionsTable.flyMachineId })
          .from(sessionsTable)
          .where(eq(sessionsTable.id, sessionId))
          .limit(1);
        if (!session?.flyMachineId) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        const workspaceApp = process.env.FLY_WORKSPACE_APP_NAME || process.env.FLY_APP_NAME;
        if (!workspaceApp) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }
        const proxy = getWorkspaceProxy(session.flyMachineId, workspaceApp);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proxy.upgrade?.(req, socket as any, head);
      } catch (err) {
        logger.warn({ err, url }, "Workspace WebSocket upgrade failed");
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      }
      return;
    }

    // ── Claw bridge WebSocket ─────────────────────────────────────────────
    const match = BRIDGE_PATH_RE.exec(url);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = parseInt(match[1], 10);
    const laneId    = parseInt(match[2], 10);
    if (!Number.isFinite(sessionId) || !Number.isFinite(laneId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleBridgeUpgrade(ws, req, sessionId, laneId);
    });
  });
} else {
  // Local distribution: no legacy WebSocket bridge — claw sessions use ACP (HTTP).
  // Reject all WS upgrade attempts with 404 so clients get a clear error rather
  // than a silent hang.
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
}

server.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // ── Cloud distribution startup jobs ───────────────────────────────────────
  // All of the following depend on PostgreSQL (db) or cloud-only services
  // (Vast.ai GPU profiles, NIM catalog, claim sweep, design intelligence, etc.).
  // In local distribution mode these jobs must not run: they will error against
  // SQLite and produce misleading log noise.  Local startup is handled by the
  // local-migrate block above and the /api/local/* routes.
  //
  // All cloud service imports are dynamic so esbuild can eliminate them from
  // local distribution bundles when MIZI_DISTRIBUTION is defined as "local".
  if (!IS_LOCAL_DISTRIBUTION) {
    try {
      const { seedProfiles } = await import("./services/profiles.js");
      await seedProfiles();
      logger.info("GPU profiles seeded");
    } catch (e) {
      logger.error(e, "Failed to seed profiles");
    }

    try {
      const { registerDefaultTemplate } = await import("./services/templates.js");
      await registerDefaultTemplate();
    } catch (e) {
      logger.error(e, "Failed to register default template");
    }

    try {
      const { seedDefaultBundles } = await import("./services/skills-bundler.js");
      await seedDefaultBundles();
      logger.info("Default skill bundles seeded");
    } catch (e) {
      logger.error(e, "Failed to seed default skill bundles");
    }

    try {
      const { seedCuratedSources } = await import("./services/curated-sources.js");
      const { markDesignSyncComplete } = await import("./services/scheduler.js");
      const seedResult = await seedCuratedSources();
      if (seedResult.success) {
        markDesignSyncComplete();
        logger.info({ reason: seedResult.reason, updated: seedResult.updated }, "Curated design intelligence sources seeded");
      } else {
        logger.warn({ reason: seedResult.reason }, "Curated design intelligence seed completed with non-success status");
      }
    } catch (e) {
      logger.error(e, "Failed to seed curated design intelligence sources");
    }

    const { startScheduler } = await import("./services/scheduler.js");
    startScheduler();

    try {
      const { sweepExpiredClaims, recordExternalSweep, startClaimSweeper } = await import("./services/claim-sweeper.js");
      const bootSweep = await sweepExpiredClaims();
      recordExternalSweep(bootSweep);
      logger.info({ deleted: bootSweep.deleted }, "Startup claim sweep complete");
      startClaimSweeper();
    } catch (err) {
      logger.error({ err }, "Startup claim sweep failed");
    }

    startClaimPurger();

    const { startEvalScheduler } = await import("./services/skills-evals.js");
    startEvalScheduler(60);

    const { startMemoryDiskMonitor, runPassiveRecallBackfill } = await import("./services/memory.js");
    startMemoryDiskMonitor();

    const { startPlanAutoAdvance } = await import("./services/plan-auto-advance.js");
    startPlanAutoAdvance();

    const { startPlanDecompose } = await import("./services/plan-decompose.js");
    startPlanDecompose();

    try {
      const { syncNimCatalog } = await import("./services/nim-catalog.js");
      await syncNimCatalog();
      logger.info("NIM catalog synced");
      setInterval(() => {
        import("./services/nim-catalog.js").then(({ syncNimCatalog: sync }) => {
          sync().catch((e) => logger.warn({ err: e }, "NIM catalog re-sync failed"));
        });
      }, 6 * 60 * 60 * 1000);
    } catch (e) {
      logger.warn({ err: e }, "NIM catalog initial sync failed (non-fatal)");
    }

    try {
      const { initSafetySubsystem, drainApprovedActions } = await import("./services/safety.js");
      const { registerAmbientExecutors, startAmbientRunner } = await import("./services/ambient.js");
      initSafetySubsystem();
      registerAmbientExecutors();
      drainApprovedActions();
      startAmbientRunner();
      logger.info("Ambient mode runner started");
    } catch (e) {
      logger.error(e, "Failed to start ambient runner");
    }

    // Passive memory recall: embedding backfill for legacy items.
    // Runs in the background so startup is never blocked on embedding API calls.
    void (async () => {
      try {
        const embedded = await runPassiveRecallBackfill(500);
        if (embedded > 0) {
          logger.info({ embedded }, "Passive recall: legacy item embeddings backfilled");
        }
      } catch (err) {
        logger.warn({ err }, "Passive recall backfill failed (non-fatal)");
      }
    })();
  } else {
    logger.info("Local distribution mode — cloud startup jobs skipped (GPU seeding, NIM catalog, claim sweep, scheduler, etc.)");
  }
});
