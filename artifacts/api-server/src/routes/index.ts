import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import schedulerRouter from "./scheduler";
import memoryRouter from "./memory";
import skillsRouter from "./skills";
import repoRouter, { batchRepoRouter } from "./repo";
import coordinationRouter from "./coordination";
import designIntelligenceRouter from "./design-intelligence";
import ambientRouter from "./ambient";
import paletteIntentRouter from "./palette-intent";
import authRouter from "./auth";
import intentRouter from "./intent";
import schemaTemplatesRouter from "./schema-templates";
import planRouter from "./plan";
import toolsRouter from "./tools";
import snapshotsRouter from "./snapshots";
import localRouter from "./local";

// ─── Distribution guard ───────────────────────────────────────────────────────
// When MIZI_DISTRIBUTION=local esbuild constant-folds this to `true` and
// eliminates all cloud-gated branches from the local bundle entirely.
const IS_LOCAL_DISTRIBUTION = process.env.MIZI_DISTRIBUTION === "local";

const router: IRouter = Router();

// ─── Session router — conditional on distribution ────────────────────────────
// Local distribution: sessions-local.ts (SQLite only; zero vastai/fly/vLLM/Neon
// imports — esbuild eliminates the cloud sessions module from local bundles).
// Cloud distribution: sessions.ts (full PG-backed session lifecycle).
if (IS_LOCAL_DISTRIBUTION) {
  const { default: localSessionsRouter } = await import("./sessions-local.js");
  router.use(localSessionsRouter);
} else {
  const { default: sessionsRouter } = await import("./sessions.js");
  router.use(sessionsRouter);
}

// ─── Cloud-only routes — dynamic imports so local bundles stay clean ──────────
// Each of these modules statically imports vastai / fly / vLLM / NIM at the
// top level. Gating them here lets esbuild constant-fold MIZI_DISTRIBUTION and
// eliminate their entire import trees from local distribution builds.
if (!IS_LOCAL_DISTRIBUTION) {
  const { default: offersRouter }      = await import("./offers.js");
  const { default: templatesRouter }   = await import("./templates.js");
  const { default: orchestrateRouter } = await import("./orchestrate.js");
  const { default: bridgeRouter }      = await import("./bridge.js");
  const { default: nimRouter }         = await import("./nim.js");
  const { default: profilesRouter }    = await import("./profiles.js");
  router.use(offersRouter);
  router.use(templatesRouter);
  router.use(orchestrateRouter);
  router.use(bridgeRouter);
  router.use(nimRouter);
  router.use(profilesRouter);
}

router.use(authRouter);
router.use(healthRouter);
router.use(dashboardRouter);
router.use(schedulerRouter);
router.use(memoryRouter);
router.use(skillsRouter);
router.use("/sessions/repo", batchRepoRouter);
router.use("/sessions/:sessionId/repo", repoRouter);
router.use(coordinationRouter);
router.use(designIntelligenceRouter);
router.use(ambientRouter);
router.use(paletteIntentRouter);
router.use(intentRouter);
router.use(schemaTemplatesRouter);
router.use(planRouter);
router.use(toolsRouter);
router.use(snapshotsRouter);

if (IS_LOCAL_DISTRIBUTION) {
  router.use(localRouter);
}

export default router;
