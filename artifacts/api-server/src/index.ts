import http from "http";
import path from "path";
import { WebSocketServer } from "ws";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import app from "./app";
import { logger } from "./lib/logger";
import { seedProfiles } from "./services/profiles";
import { registerDefaultTemplate } from "./services/templates";
import { startScheduler, markDesignSyncComplete } from "./services/scheduler";
import { seedDefaultBundles } from "./services/skills-bundler";
import { seedCuratedSources } from "./services/curated-sources";
import { startEvalScheduler } from "./services/skills-evals";
import { validateMemoryDataDir, startMemoryDiskMonitor, runPassiveRecallBackfill } from "./services/memory";
import { initSafetySubsystem, drainApprovedActions } from "./services/safety";
import { startAmbientRunner, registerAmbientExecutors } from "./services/ambient";
import { startClaimSweeper, sweepExpiredClaims, recordExternalSweep } from "./services/claim-sweeper";
import { syncNimCatalog } from "./services/nim-catalog";
import { handleBridgeUpgrade } from "./routes/bridge";
import { db, pool, laneClaimsTable, claimPurgeLogsTable } from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";

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

// Validate memory data directory before accepting requests.
// Throws (and exits) if the directory is missing or not writable so that
// operators can detect a misconfigured volume mount immediately at deploy time.
try {
  validateMemoryDataDir();
} catch (err) {
  logger.error({ err }, "Memory data directory validation failed — aborting startup");
  process.exit(1);
}

// Production guard: MIZI_ENCRYPTION_KEY must be set when NODE_ENV=production
// to ensure provisioned connection strings are encrypted at rest.
if (process.env["NODE_ENV"] === "production" && !process.env["MIZI_ENCRYPTION_KEY"]) {
  logger.error("MIZI_ENCRYPTION_KEY is required in production — provisioned connection strings would be stored in plaintext. Set a 64-hex-char key and restart.");
  process.exit(1);
}

// ─── Database migrations ──────────────────────────────────────────────────────
// In production, migrations are applied by the Fly.io release command
// (dist/migrate.mjs) before any instances start, so we skip them here.
//
// In development, run migrations at startup with a pg advisory lock so
// concurrent processes (e.g. dev server + test runner) don't deadlock.
// Migration failures are non-fatal in dev — the server still starts so
// developers can iterate without a fully-seeded local DB.
if (process.env.DATABASE_URL && process.env["NODE_ENV"] !== "production") {
  const MIGRATION_LOCK_KEY = 1297044553; // 0x4d495a49 — "MIZI"
  let migClient;
  try {
    migClient = await pool.connect();
    await migClient.query(`SELECT pg_advisory_lock($1::bigint)`, [MIGRATION_LOCK_KEY]);
    const migrationsFolder = path.join(__dirname, "migrations");
    await migrate(db, { migrationsFolder });
    logger.info("Database migrations applied (dev)");
  } catch (err) {
    logger.warn({ err }, "Database migration failed in dev (non-fatal) — run: pnpm --filter @workspace/db migrate");
  } finally {
    if (migClient) {
      try { await migClient.query(`SELECT pg_advisory_unlock($1::bigint)`, [MIGRATION_LOCK_KEY]); } catch (_) { /* ignore */ }
      migClient.release();
    }
  }
} else if (!process.env.DATABASE_URL) {
  logger.warn("DATABASE_URL not set — skipping migrations");
}

// ─── HTTP server + WebSocket bridge ──────────────────────────────────────────
// Wrap the Express app in a raw http.Server so we can intercept WebSocket
// upgrade events for the claw bridge at /api/bridge/:sessionId/:laneId.

const server = http.createServer(app);

// A single no-listen WebSocketServer is used purely to parse upgrade requests.
// We do NOT call wss.handleUpgrade for requests that don't match the bridge
// path — those are passed through to Express as normal HTTP 400s.
const wss = new WebSocketServer({ noServer: true });

// Bridge URL pattern: /api/bridge/:sessionId/:laneId
const BRIDGE_PATH_RE = /^\/api\/bridge\/(\d+)\/(\d+)(\/|\?.*)?$/;

server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";
  const match = BRIDGE_PATH_RE.exec(url);
  if (!match) {
    // Not a bridge path — reject the upgrade
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

server.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  try {
    await seedProfiles();
    logger.info("GPU profiles seeded");
  } catch (e) {
    logger.error(e, "Failed to seed profiles");
  }

  try {
    await registerDefaultTemplate();
  } catch (e) {
    logger.error(e, "Failed to register default template");
  }

  try {
    await seedDefaultBundles();
    logger.info("Default skill bundles seeded");
  } catch (e) {
    logger.error(e, "Failed to seed default skill bundles");
  }

  try {
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

  startScheduler();

  try {
    const bootSweep = await sweepExpiredClaims();
    recordExternalSweep(bootSweep);
    logger.info({ deleted: bootSweep.deleted }, "Startup claim sweep complete");
  } catch (err) {
    logger.error({ err }, "Startup claim sweep failed");
  }

  startClaimSweeper();
  startClaimPurger();
  startEvalScheduler(60);
  startMemoryDiskMonitor();

  try {
    await syncNimCatalog();
    logger.info("NIM catalog synced");
    // Re-sync every 6 hours to pick up new partner models.
    setInterval(() => {
      syncNimCatalog().catch((e) => logger.warn({ err: e }, "NIM catalog re-sync failed"));
    }, 6 * 60 * 60 * 1000);
  } catch (e) {
    logger.warn({ err: e }, "NIM catalog initial sync failed (non-fatal)");
  }

  try {
    initSafetySubsystem();
    registerAmbientExecutors();
    drainApprovedActions();
    startAmbientRunner();
    logger.info("Ambient mode runner started");
  } catch (e) {
    logger.error(e, "Failed to start ambient runner");
  }

  // Passive memory recall (Task #225): embedding backfill for legacy items.
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
});
