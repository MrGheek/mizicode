import app from "./app";
import { logger } from "./lib/logger";
import { seedProfiles } from "./services/profiles";
import { registerDefaultTemplate } from "./services/templates";
import { startScheduler, markDesignSyncComplete } from "./services/scheduler";
import { seedDefaultBundles } from "./services/skills-bundler";
import { seedCuratedSources } from "./services/curated-sources";
import { startEvalScheduler } from "./services/skills-evals";
import { validateMemoryDataDir } from "./services/memory";
import { startClaimSweeper, sweepExpiredClaims, recordExternalSweep } from "./services/claim-sweeper";
import { db, laneClaimsTable, claimPurgeLogsTable } from "@workspace/db";
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

app.listen(port, async (err) => {
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
});
