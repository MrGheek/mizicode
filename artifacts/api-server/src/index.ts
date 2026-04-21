import app from "./app";
import { logger } from "./lib/logger";
import { seedProfiles } from "./services/profiles";
import { registerDefaultTemplate } from "./services/templates";
import { startScheduler } from "./services/scheduler";
import { seedDefaultBundles } from "./services/skills-bundler";

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
});
