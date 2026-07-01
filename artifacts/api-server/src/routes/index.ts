import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import schedulerRouter from "./scheduler";
import memoryRouter from "./memory";
import skillsRouter from "./skills";
import repoRouter, { batchRepoRouter, repoGraphRouter } from "./repo";
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
import metricsRouter from "./metrics";
import sessionShortcutsRouter from "./session-shortcuts";
import localRouter from "./local";

/* ─── API Surface ─────────────────────────────────────────────────────────
 *
 * Router                    Registered paths (relative to /api)
 * ────────────────────────  ─────────────────────────────────────────────
 * sessions.ts (cloud)       /sessions/*     — CRUD, memory, plan, swarm,
 *                              messages, model, files, workspace proxy
 * sessions-local.ts (local)  /sessions/*     — SQLite-backed subset
 * offers.ts (cloud only)     /offers/*       — Vast.ai GPU offers
 * templates.ts (cloud only)  /templates/*    — Session templates
 * orchestrate.ts (cloud)     /orchestrate/*  — Fly.io machine orchestration
 * bridge.ts (cloud only)     /bridge/*       — Claw bridge WebSocket
 * nim.ts (cloud only)        /nim/*          — NIM model discovery
 * profiles.ts (cloud only)   /profiles/*     — Session profiles
 * auth.ts                    /auth/*         — API keys, GitHub OAuth
 * health.ts                  /health, /healthz, /admin/status
 * dashboard.ts               /dashboard/*    — Dashboard API proxy
 * scheduler.ts               /scheduler/*    — Cron job scheduling
 * memory.ts                  /mem/*          — Memory CRUD, governance,
 *                              passive recall, conflict management
 * skills.ts                  /skills/*, /skill-bundles/*,
 *                              /admin/*, /sessions/:id/skills/*
 * repo.ts (graph)            /repo/*         — Standalone repo graph
 * repo.ts (batch)            /sessions/repo  — Batch repo status
 * repo.ts (per-session)      /sessions/:id/repo — Per-session index/search
 * coordination.ts            /coordination/* — Lane coordination
 * design-intelligence.ts    /design-intelligence/* — Curated patterns
 * ambient.ts                 /ambient/*, /safety/*,
 *                              /dashboard/ambient/*, /dashboard/safety/*
 * palette-intent.ts         /palette/intent — AI command palette
 * intent.ts                  /intent/*       — Intent classification
 * schema-templates.ts       /schema-templates/* — Schema templates
 * plan.ts                    /plan/*, /plans/*,
 *                              /sessions/:id/plan, /sessions/:id/decompose
 * tools.ts                   /sessions/:id/tools/* — Web search, fetch
 * metrics.ts                 /metrics/*      — GPU/token/latency/cost
 * snapshots.ts               /snapshots/*    — Snapshot/rollback
 * session-shortcuts.ts       /session/*      — Session shortcuts
 * local.ts (local only)     /local/*        — Hardware probe, Ollama, ACP
 *
 * MCP router (mounted in app.ts, outside this index):
 *   /mcp — MCP tools via @modelcontextprotocol/sdk
 *
 * ─── Route ordering rules ────────────────────────────────────────────────
 * 1. Session router is mounted FIRST so session-level 404s take priority.
 * 2. Cloud-only routes (offers, templates, orchestrate, etc.) mount
 *    between sessions and core resources — esbuild tree-shakes them from
 *    local builds via MIZI_DISTRIBUTION constant-folding.
 * 3. Core resources (auth, health, dashboard, skills, plan, ambient)
 *    mount after cloud-only — order between them does not matter as long
 *    as no two routers register the same path (verified at startup).
 * 4. If two routers MUST register sibling sub-paths (e.g. sessions/:id/skills
 *    in skills.ts), the earlier-mounted router wins — mount the more
 *    specific or more commonly-hit router first.
 *
 * When adding a new route file, update this doc block.
 */

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
router.use("/repo", repoGraphRouter);
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
router.use(metricsRouter);
router.use(snapshotsRouter);
router.use("/session", sessionShortcutsRouter);

if (IS_LOCAL_DISTRIBUTION) {
  router.use(localRouter);
}

export default router;
