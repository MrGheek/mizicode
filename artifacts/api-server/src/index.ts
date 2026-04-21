import app from "./app";
import { logger } from "./lib/logger";
import { seedProfiles } from "./services/profiles";
import { registerDefaultTemplate } from "./services/templates";
import { startScheduler } from "./services/scheduler";
import { seedDefaultBundles } from "./services/skills-bundler";
import { db, laneClaimsTable } from "@workspace/db";
import { lt } from "drizzle-orm";

const CLAIM_EXPIRY_INTERVAL_MS = 60_000;

async function sweepExpiredClaims(): Promise<void> {
  try {
    const deleted = await db
      .delete(laneClaimsTable)
      .where(lt(laneClaimsTable.expiresAt, new Date()))
      .returning({ id: laneClaimsTable.id });
    logger.info({ count: deleted.length }, "Expired lane claims deleted");
  } catch (err) {
    logger.error({ err }, "Failed to sweep expired lane claims");
  }
}

function startClaimExpiryCleanup(): void {
  setInterval(sweepExpiredClaims, CLAIM_EXPIRY_INTERVAL_MS);
  logger.info({ intervalMs: CLAIM_EXPIRY_INTERVAL_MS }, "Claim expiry cleanup scheduled");
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

  startScheduler();
  startClaimExpiryCleanup();
});
