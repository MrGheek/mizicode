import app from "./app";
import { logger } from "./lib/logger";
import { seedProfiles } from "./services/profiles";
import { registerDefaultTemplate } from "./services/templates";
import { startScheduler, markDesignSyncComplete } from "./services/scheduler";
import { seedDefaultBundles } from "./services/skills-bundler";
import { seedCuratedSources } from "./services/curated-sources";
import { startEvalScheduler } from "./services/skills-evals";
import { validateMemoryDataDir } from "./services/memory";
import { startClaimSweeper, sweepExpiredClaims } from "./services/claim-sweeper";
import { db, laneClaimsTable } from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";

const CLAIM_PURGE_INTERVAL_MS = 60 * 60 * 1000;
const CLAIM_RETENTION_DAYS = 7;

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
    if (deleted.length > 0) {
      logger.info({ count: deleted.length, retentionDays: CLAIM_RETENTION_DAYS }, "Old inactive lane claims purged");
    }
  } catch (err) {
    logger.error({ err }, "Failed to purge old inactive lane claims");
  }
}

function startClaimPurger(): void {
  purgeOldInactiveClaims();
  setInterval(purgeOldInactiveClaims, CLAIM_PURGE_INTERVAL_MS);
  logger.info({ intervalMs: CLAIM_PURGE_INTERVAL_MS, retentionDays: CLAIM_RETENTION_DAYS }, "Inactive claim purge job scheduled");
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
    logger.info({ deactivated: bootSweep.deactivated }, "Startup claim sweep complete");
  } catch (err) {
    logger.error({ err }, "Startup claim sweep failed");
  }

  startClaimSweeper();
  startClaimPurger();
  startEvalScheduler(60);
});
