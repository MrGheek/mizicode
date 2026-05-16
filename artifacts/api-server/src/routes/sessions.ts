import { Router, type RequestHandler } from "express";
import { db, sessionsTable, gpuProfilesTable, templatesTable, skillBundlesTable, sessionLanesTable, sessionModelSwitchesTable, nimCatalogTable, provisionedResourcesTable, schemaTemplatesTable, projectPlansTable } from "@workspace/db";
import { eq, desc, inArray, and, isNull, notLike } from "drizzle-orm";
import * as neonService from "../services/neon";
import { getBridge, getBridgeForSession, tryAcquireExecLock, releaseExecLock } from "../services/bridge-registry";
import { getProfileById, getNimWorkspaceProfile } from "../services/profiles";
import * as vastai from "../services/vastai";
import type { VastOffer } from "../services/vastai";
import * as fly from "../services/fly";
import { logger } from "../lib/logger";
import { listObservations, listSessions, searchMemory, subscribeToObservations, backupDb, restoreDb, addObservation, addSummary, getGovernanceStats, runStaleSweep, bulkUpdateStaleItems, getReviewNeededCount, listStaleItems, listConflicts } from "../services/memory";
import { listRecallAudit, getRecallMetrics, setPassiveRecallForSession, isPassiveRecallEnabled, passiveRecallGloballyEnabled } from "../services/memory-passive";
import fs from "fs";
import type { TeamMemberRecord, SessionRoutingStats } from "@workspace/db";
import { compileBundle, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext, seedDefaultBundles, getRepoIntelligenceForSession } from "../services/skills-bundler";
import type { SessionContext } from "../services/skills-types";
import { autoEnqueueRepoIndexIfNeeded } from "./repo";

import { randomBytes } from "crypto";
import { requireAgentAuth, permitBearer, type ApiKeyRecord } from "../middlewares/agent-auth";
import { getStoredGitHubToken } from "./auth";
import { encryptConnectionString, decryptConnectionString, maskConnectionString } from "../lib/encrypt";

function generatePassword(length = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = randomBytes(length);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

const RESERVED_NAMES = new Set(["__shared__", "owner", "admin", "root", "shared"]);
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function sanitizeMemberName(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  if (!SAFE_NAME_RE.test(cleaned)) return null;
  if (RESERVED_NAMES.has(cleaned)) return null;
  return cleaned;
}

const router = Router();

const ACTIVE_STATUSES = ["pending", "provisioning", "downloading", "starting", "ready"];

// Remove ownerToken from any session-shaped object before sending to the client.
// ownerToken is a sensitive bearer secret — expose ONLY on the single detail endpoint
// GET /sessions/:id (where the operator dashboard reads it to authorize abort calls).
// All list, active, refresh, and delete responses must redact it.
function redactOwnerToken<T extends { ownerToken?: string | null }>(
  session: T
): Omit<T, "ownerToken"> {
  const { ownerToken: _redacted, ...rest } = session;
  return rest;
}

async function syncSessionFromVastai(session: typeof sessionsTable.$inferSelect): Promise<typeof sessionsTable.$inferSelect> {
  if (!session.vastInstanceId || !ACTIVE_STATUSES.includes(session.status)) {
    return session;
  }

  try {
    const instance = await vastai.getInstance(session.vastInstanceId);
    const urls = vastai.buildInstanceUrls(instance);

    let status = session.status;
    let statusMessage = session.statusMessage;

    const vastStatus = instance.actual_status || "";
    const rawStatusMsg = (instance.status_msg || "").trim();
    const statusMsg = rawStatusMsg.toLowerCase();

    // Actual cost fields from Vast.ai: dph_total is the running $/hr, cost_run_time is cumulative.
    const actualCostPerHour = instance.dph_total ?? instance.dph_base ?? null;
    const vastCumulativeCost = instance.cost_run_time ?? null;

    logger.info(
      { sessionId: session.id, vastInstanceId: session.vastInstanceId, vastStatus, rawStatusMsg, codeServerUrl: urls.codeServerUrl, llmProxyUrl: urls.llmProxyUrl, dph_total: actualCostPerHour, cost_run_time: vastCumulativeCost },
      "Vast.ai sync — raw values"
    );

    if (vastStatus === "running") {
      // First: check for keyword markers written by onstart.sh to /tmp/instance-status
      // (works when Vast.ai reads that file as status_msg, which depends on the image/agent)
      if (statusMsg.includes("downloading") || statusMsg.includes("pulling")) {
        status = "downloading";
        statusMessage = "Downloading model weights...";
      } else if (statusMsg.includes("starting_llm")) {
        status = "starting";
        statusMessage = "Loading model into GPU memory...";
      } else if (statusMsg.includes("llm_ready")) {
        status = "ready";
        statusMessage = "Session is ready — vLLM online";
      } else if (statusMsg.includes("services_ready")) {
        status = "starting";
        statusMessage = "Tools ready — LLM model loading in background...";
      } else {
        // Fallback: Vast.ai sets its own status_msg (e.g. "success, running <image>").
        // Actual phase transitions come from the instance via POST /sessions/:id/status.
        // Until the instance calls back, keep the current DB status (don't regress it).
        if (!["downloading", "starting", "ready"].includes(status)) {
          status = "starting";
        }
        statusMessage = session.statusMessage || (rawStatusMsg ? `Starting... (${rawStatusMsg})` : "Services starting up...");

        // Time-based heuristic: if Vast.ai reports "success" and the instance has been
        // running for >30 min without a callback (e.g. older instance launched before
        // callback was wired up), assume the LLM is ready.
        const minutesRunning = session.startedAt
          ? (Date.now() - session.startedAt.getTime()) / 60000
          : 0;
        if (rawStatusMsg.toLowerCase().startsWith("success") && minutesRunning > 30 && status !== "ready") {
          status = "ready";
          statusMessage = "Session is ready — vLLM online";
          logger.info({ sessionId: session.id, minutesRunning: Math.round(minutesRunning) }, "Auto-marking session ready after 30+ min with success status");
        }
      }
    } else if (vastStatus === "loading" || vastStatus === "creating") {
      status = "provisioning";
      statusMessage = rawStatusMsg ? `[${vastStatus}] ${rawStatusMsg}` : "Instance is booting...";
    } else if (vastStatus === "exited" || vastStatus === "error") {
      status = "error";
      statusMessage = `Instance error: ${rawStatusMsg || vastStatus}`;
    }

    const hoursRunning = session.startedAt
      ? (Date.now() - session.startedAt.getTime()) / (1000 * 60 * 60)
      : 0;
    // Prefer Vast.ai's own cumulative cost_run_time; fall back to dph_total × hours; last resort: DB value × hours.
    const costPerHourFinal = actualCostPerHour ?? session.costPerHour ?? 0;
    const totalCost = vastCumulativeCost != null
      ? Math.round(vastCumulativeCost * 1000) / 1000
      : Math.round(costPerHourFinal * hoursRunning * 1000) / 1000;

    // Update team member ideUrls by appending each member's path to the codeServerUrl
    let updatedTeamMembers = session.teamMembers as TeamMemberRecord[] | null;
    const baseCodeServerUrl = (urls.codeServerUrl || session.codeServerUrl || "").replace(/\/$/, "");
    if (updatedTeamMembers && baseCodeServerUrl) {
      updatedTeamMembers = updatedTeamMembers.map((m) => ({
        ...m,
        ideUrl: m.ideUrl || `${baseCodeServerUrl}${m.path}`,
      }));
    }

    const [updated] = await db
      .update(sessionsTable)
      .set({
        status,
        statusMessage,
        boltDiyUrl: urls.boltDiyUrl || session.boltDiyUrl,
        codeServerUrl: urls.codeServerUrl || session.codeServerUrl,
        previewUrl: urls.previewUrl || session.previewUrl,
        sshHost: urls.sshHost || session.sshHost,
        sshPort: urls.sshPort || session.sshPort,
        publicIp: urls.publicIp || session.publicIp,
        // Always persist the latest cost data from Vast.ai so it survives restarts.
        ...(costPerHourFinal > 0 ? { costPerHour: costPerHourFinal } : {}),
        totalCost,
        teamMembers: updatedTeamMembers,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, session.id))
      .returning();

    if (status === "ready" && session.status !== "ready") {
      autoEnqueueRepoIndexIfNeeded(session.id).catch(() => {});
    }

    return updated;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "Failed to auto-sync session from Vast.ai");
    return session;
  }
}

// ─── Instance callback: the running instance POSTs its phase transitions here ──
// Replaces the unreliable server-side probe (Vast.ai firewall blocks server→instance).
//
// Production posture: MIZI_MEM_TOKEN MUST be set when NODE_ENV=production,
// otherwise the callback endpoint becomes an unauthenticated status-mutation
// surface that any internet host can hit. Memory and ambient routes already
// fail fast on the same env var; we mirror that here so the launch posture is
// uniform across all token-gated surfaces.
const CALLBACK_TOKEN = process.env["MIZI_MEM_TOKEN"] || "";
const CALLBACK_IS_PROD = process.env["NODE_ENV"] === "production";
if (CALLBACK_IS_PROD && !CALLBACK_TOKEN) {
  throw new Error(
    "MIZI_MEM_TOKEN must be set in production to protect the instance status callback endpoint",
  );
}
if (!CALLBACK_TOKEN) {
  logger.warn("[sessions] MIZI_MEM_TOKEN not set — instance status callback is unauthenticated (dev mode only)");
}

/**
 * Failure classifications reported by the running instance via onstart.sh.
 * Each entry maps a structured cause to its default human-readable summary.
 * Kept in sync with the report_failure calls in docker/onstart.sh.
 *
 * The persisted statusMessage always begins with `boot_failure:<cause>: ` so
 * the dashboard boot-phase classifier (parseBootFailure in boot-phases.ts)
 * can surface a suggested next step. The marker is prepended in the callback
 * handler regardless of whether the agent supplied its own message — see
 * the buildFailureStatusMessage helper below.
 */
const FAILURE_DEFAULT_MESSAGES: Record<string, string> = {
  provisioning_failed:   "Container provisioning failed before services came up",
  download_failed:       "Model weight download failed after retries",
  download_stalled:      "Model download stalled — host network or HuggingFace unreachable",
  vllm_warmup_failed:    "vLLM did not respond to /health within the warmup window",
  skills_compile_failed: "Smart Skills bundle failed to compile",
  disk_full:             "Host ran out of disk space — destroy and retry on a different machine",
};

/** Build a `boot_failure:<cause>: <message>` marker that survives the callback. */
function buildFailureStatusMessage(cause: string, suppliedMessage: string | undefined): string {
  const trimmed = suppliedMessage?.trim();
  const human = trimmed && trimmed.length > 0 ? trimmed : (FAILURE_DEFAULT_MESSAGES[cause] ?? cause);
  return `boot_failure:${cause}: ${human}`;
}

const INSTANCE_STATUS_MAP: Record<string, { status: typeof sessionsTable.$inferSelect["status"]; statusMessage: string }> = {
  services_ready:   { status: "starting",    statusMessage: "Tools ready — LLM model loading in background..." },
  downloading:      { status: "downloading", statusMessage: "Downloading model weights..." },
  starting_llm:     { status: "starting",    statusMessage: "Loading model into GPU memory..." },
  skills_compiling: { status: "starting",    statusMessage: "Compiling Smart Skills bundle..." },
  skills_ready:     { status: "starting",    statusMessage: "Smart Skills loaded — LLM loading in background..." },
  llm_ready:        { status: "ready",       statusMessage: "Session is ready — vLLM online" },
  // Failure phases — all map to status "error". The persisted statusMessage
  // is built per-request to preserve the structured cause marker.
  ...Object.fromEntries(
    Object.entries(FAILURE_DEFAULT_MESSAGES).map(([cause, human]) => [
      cause,
      { status: "error" as const, statusMessage: `boot_failure:${cause}: ${human}` },
    ]),
  ),
};

router.post("/sessions/:sessionId/status", async (req, res) => {
  const sessionId = Number(req.params["sessionId"]);
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  // Validate Bearer token when MIZI_MEM_TOKEN is configured.
  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Instance callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const { status: instanceStatus, message } = req.body as { status?: string; message?: string };
  if (!instanceStatus) {
    res.status(400).json({ error: "Missing status field" });
    return;
  }

  const mapped = INSTANCE_STATUS_MAP[instanceStatus];
  if (!mapped) {
    res.status(400).json({ error: `Unknown status: ${instanceStatus}` });
    return;
  }

  // For failure phases, ALWAYS rebuild the message so the
  // `boot_failure:<cause>: ` marker survives even when onstart.sh supplies
  // its own human-readable message text. Without this, the dashboard's
  // parseBootFailure() classifier loses the structured cause and the
  // suggested-next-step UX silently regresses.
  const isFailurePhase = instanceStatus in FAILURE_DEFAULT_MESSAGES;
  const statusMessage = isFailurePhase
    ? buildFailureStatusMessage(instanceStatus, message)
    : ((message?.trim()) || mapped.statusMessage);

  logger.info({ sessionId, instanceStatus, dbStatus: mapped.status, statusMessage }, "Instance status callback received");

  const [prevSession] = await db.select({ status: sessionsTable.status }).from(sessionsTable).where(eq(sessionsTable.id, sessionId));

  await db
    .update(sessionsTable)
    .set({ status: mapped.status, statusMessage, updatedAt: new Date() })
    .where(eq(sessionsTable.id, sessionId));

  if (mapped.status === "ready" && prevSession?.status !== "ready") {
    autoEnqueueRepoIndexIfNeeded(sessionId).catch(() => {});

    // Activate lanes provisioned by POST /sessions/orchestrate.
    // Orchestrate creates lanes with status="pending" so they don't appear
    // functional until the GPU instance fires its llm_ready callback here.
    db.update(sessionLanesTable)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(sessionLanesTable.sessionId, sessionId), eq(sessionLanesTable.status, "pending")))
      .catch((laneErr: unknown) => {
        logger.warn({ err: laneErr, sessionId }, "llm_ready: failed to activate pending lanes (non-fatal)");
      });
  }

  if (
    (mapped.status === "error" && prevSession?.status !== "error") ||
    (mapped.status === "stopped" && prevSession?.status !== "stopped")
  ) {
    cleanupSessionResources(sessionId).catch(() => {});
  }

  // Post-session plan reassessment: fire-and-forget when a session stops.
  // Retrieves the session's linked plan_id and re-evaluates task statuses
  // against memory observations. Skips user-confirmed tasks.
  if (mapped.status === "stopped" && prevSession?.status !== "stopped") {
    (async () => {
      try {
        const [stoppedSession] = await db.select({ planId: sessionsTable.planId, id: sessionsTable.id }).from(sessionsTable).where(eq(sessionsTable.id, sessionId));
        if (stoppedSession?.planId) {
          const { reassessSession } = await import("../services/plan");
          // userId for reassessment: read from the plan owner since sessions don't store userId
          const { projectPlansTable: plansTable } = await import("@workspace/db");
          const [plan] = await db.select({ userId: plansTable.userId }).from(plansTable).where(eq(plansTable.id, stoppedSession.planId));
          if (plan?.userId) {
            await reassessSession({ sessionId, userId: plan.userId });
            logger.info({ sessionId, planId: stoppedSession.planId }, "[plan] Post-session reassessment completed");
          }
        }
      } catch (err) {
        logger.warn({ err, sessionId }, "[plan] Post-session reassessment failed (non-fatal)");
      }
    })();
  }

  res.json({ ok: true, status: mapped.status });
});

router.get("/sessions", async (_req, res) => {
  const sessions = await db
    .select({
      id: sessionsTable.id,
      profileId: sessionsTable.profileId,
      profileName: gpuProfilesTable.displayName,
      vastInstanceId: sessionsTable.vastInstanceId,
      vastOfferId: sessionsTable.vastOfferId,
      templateHash: sessionsTable.templateHash,
      status: sessionsTable.status,
      statusMessage: sessionsTable.statusMessage,
      boltDiyUrl: sessionsTable.boltDiyUrl,
      codeServerUrl: sessionsTable.codeServerUrl,
      previewUrl: sessionsTable.previewUrl,
      sshHost: sessionsTable.sshHost,
      sshPort: sessionsTable.sshPort,
      publicIp: sessionsTable.publicIp,
      costPerHour: sessionsTable.costPerHour,
      totalCost: sessionsTable.totalCost,
      gpuName: sessionsTable.gpuName,
      numGpus: sessionsTable.numGpus,
      startedAt: sessionsTable.startedAt,
      stoppedAt: sessionsTable.stoppedAt,
      teamMembers: sessionsTable.teamMembers,
      createdAt: sessionsTable.createdAt,
      updatedAt: sessionsTable.updatedAt,
      swarmSnapshotJson: sessionsTable.swarmSnapshotJson,
      provider: sessionsTable.provider,
      nimProvider: sessionsTable.nimProvider,
      nimModelId: sessionsTable.nimModelId,
      hasGithubToken: sessionsTable.hasGithubToken,
    })
    .from(sessionsTable)
    .leftJoin(gpuProfilesTable, eq(sessionsTable.profileId, gpuProfilesTable.id))
    .orderBy(desc(sessionsTable.createdAt));

  // Redact passwords from list response — full credentials are only on the detail endpoint.
  // Enrich each session with a swarmStatus field so the frontend can render swarm pills
  // on the very first paint without waiting for the batch poll round-trip.
  const sanitized = sessions.map((s) => {
    const { swarmSnapshotJson, ...rest } = s;

    // Derive swarm status using the same priority logic as swarm-status-batch:
    // 1. in-memory cache (freshest), 2. DB snapshot (stale), 3. status-based sentinel.
    let swarmStatus: { availability: string; snapshot: SwarmSnapshot | null } | null = null;

    if (["pending", "provisioning", "downloading", "starting"].includes(s.status)) {
      swarmStatus = { availability: "starting", snapshot: null };
    } else {
      const cached = swarmCache.get(s.id);
      const dbSnapshot = swarmSnapshotJson as SwarmSnapshot | null;

      if (cached) {
        const ageMs = Date.now() - cached.receivedAt;
        swarmStatus = {
          availability: ageMs <= STALE_THRESHOLD_MS ? "live" : "stale",
          snapshot: cached.snapshot,
        };
      } else if (dbSnapshot) {
        swarmStatus = { availability: "stale", snapshot: dbSnapshot };
      } else {
        swarmStatus = { availability: "unavailable", snapshot: null };
      }
    }

    return {
      ...rest,
      teamMembers: s.teamMembers
        ? (s.teamMembers as TeamMemberRecord[]).map(({ password: _pw, ...m }) => m)
        : null,
      swarmStatus,
    };
  });

  res.json(sanitized);
});

router.get("/sessions/active", async (_req, res) => {
  // Join gpu_profiles so we can exclude test-suite sessions (profile name starts
  // with "test-") from surfacing in the dashboard's active-session banner.
  const [rawSession] = await db
    .select({ session: sessionsTable })
    .from(sessionsTable)
    .leftJoin(gpuProfilesTable, eq(sessionsTable.profileId, gpuProfilesTable.id))
    .where(
      and(
        inArray(sessionsTable.status, ACTIVE_STATUSES),
        notLike(gpuProfilesTable.name, "test-%"),
      )
    )
    .orderBy(desc(sessionsTable.createdAt))
    .limit(1)
    .then(rows => rows.map(r => r.session));

  if (!rawSession) {
    res.json({ session: null });
    return;
  }

  const synced = await syncSessionFromVastai(rawSession);
  const [profile] = await db
    .select({ displayName: gpuProfilesTable.displayName })
    .from(gpuProfilesTable)
    .where(eq(gpuProfilesTable.id, synced.profileId));

  // Redact team member passwords and ownerToken — these are only exposed on the detail endpoint.
  const sanitizedMembers = synced.teamMembers
    ? (synced.teamMembers as TeamMemberRecord[]).map(({ password: _pw, ...rest }) => rest)
    : null;

  res.json({ session: { ...redactOwnerToken(synced), teamMembers: sanitizedMembers, profileName: profile?.displayName || "" } });
});

// GET /sessions/swarm-status-batch?ids=1,2,3 — batch endpoint for the sessions list.
// Returns a map of session-id → SwarmStatusResponse so the list can refresh all pills
// with a single request instead of one per row.
// NOTE: must be registered before /sessions/:sessionId to avoid being caught by that route.
router.get("/sessions/swarm-status-batch", async (req, res) => {
  const raw = typeof req.query["ids"] === "string" ? req.query["ids"] : "";
  const ids = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (ids.length === 0) {
    res.json({});
    return;
  }

  try {
    const rows = await db
      .select({ id: sessionsTable.id, status: sessionsTable.status, swarmSnapshotJson: sessionsTable.swarmSnapshotJson })
      .from(sessionsTable)
      .where(inArray(sessionsTable.id, ids));

    const result: Record<number, { availability: string; snapshot: SwarmSnapshot | null }> = {};

    for (const session of rows) {
      const sessionId = session.id;

      if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
        result[sessionId] = { availability: "starting", snapshot: null };
        continue;
      }

      const cached = swarmCache.get(sessionId);
      const dbSnapshot = session.swarmSnapshotJson as SwarmSnapshot | null;

      if (!cached && !dbSnapshot) {
        result[sessionId] = { availability: "unavailable", snapshot: null };
        continue;
      }

      if (cached) {
        const ageMs = Date.now() - cached.receivedAt;
        if (ageMs <= STALE_THRESHOLD_MS) {
          result[sessionId] = { availability: "live", snapshot: cached.snapshot };
        } else {
          result[sessionId] = { availability: "stale", snapshot: cached.snapshot };
        }
        continue;
      }

      if (dbSnapshot) {
        swarmCache.set(sessionId, { snapshot: dbSnapshot, receivedAt: 0 });
        result[sessionId] = { availability: "stale", snapshot: dbSnapshot };
        continue;
      }

      result[sessionId] = { availability: "unavailable", snapshot: null };
    }

    res.json(result);
  } catch (err) {
    logger.error(err, "Failed to fetch batch swarm status");
    res.status(500).json({ error: "Failed to fetch batch swarm status" });
  }
});

router.get("/sessions/:sessionId", async (req, res) => {
  const id = parseInt(req.params.sessionId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [rawSession] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, id));

  if (!rawSession) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const synced = await syncSessionFromVastai(rawSession);
  const [profile] = await db
    .select({ displayName: gpuProfilesTable.displayName, swarmWorkerCap: gpuProfilesTable.swarmWorkerCap })
    .from(gpuProfilesTable)
    .where(eq(gpuProfilesTable.id, synced.profileId));

  // Recover repoUrl from the fingerprint JSON so the frontend can use it for
  // branch-chip gating (repoUrl is not a dedicated column — it's embedded in
  // repoFingerprintJson.url by buildOnStartScript / launch flow).
  const fpJson = synced.repoFingerprintJson as Record<string, unknown> | null;
  const repoUrl = fpJson && typeof fpJson.url === "string" ? fpJson.url : null;

  // ownerToken is a session-scoped bearer secret used by mutation endpoints
  // (PATCH /phase, /model, /routing-mode). It must never be returned on
  // unauthenticated reads — the detail page obtains it once at creation time.
  res.json({ ...redactOwnerToken(synced), profileName: profile?.displayName || "", swarmWorkerCap: profile?.swarmWorkerCap ?? null, repoUrl });
});

// GET /sessions/:sessionId/clone — return the launch options needed to re-create
// a similar session. Read-only, no new session is created. Passwords and
// ownerToken are never returned.
router.get("/sessions/:sessionId/clone", async (req, res) => {
  const id = parseInt(req.params.sessionId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, id));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const [profile] = await db
    .select({ displayName: gpuProfilesTable.displayName })
    .from(gpuProfilesTable)
    .where(eq(gpuProfilesTable.id, session.profileId));

  // Recover repoUrl from the fingerprint JSON stored at launch time. Newer
  // sessions store `{ url, branch, urlHash, langs, ... }`; older sessions may
  // not have it.
  const fp = session.repoFingerprintJson as Record<string, unknown> | null;
  const repoUrl = fp && typeof fp.url === "string" ? (fp.url as string) : null;

  const teamMemberNames = (session.teamMembers as TeamMemberRecord[] | null ?? [])
    .map((m) => m.name)
    .filter((n) => n && n !== "__shared__");

  res.json({
    sessionId: session.id,
    profileId: session.profileId,
    profileName: profile?.displayName ?? null,
    taskMode: session.taskMode ?? null,
    tokenMode: session.tokenMode ?? null,
    bundleId: session.activeBundleId ?? null,
    repoUrl,
    intentText: session.intentText ?? null,
    teamMemberNames,
    stoppedAt: session.stoppedAt ? session.stoppedAt.toISOString() : null,
    totalCost: session.totalCost ?? null,
  });
});

// PATCH /sessions/:sessionId — update editable session fields. Currently only
// supports `intentText` (the natural-language session goal). When the goal
// changes, we also append a `session_goal` observation so the change is
// visible in the memory timeline.
router.patch("/sessions/:sessionId", async (req, res) => {
  const id = parseInt(req.params.sessionId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const body = (req.body ?? {}) as { intentText?: string | null };

  // PATCH semantics: only fields explicitly present in the body are updated.
  // An absent `intentText` key is a no-op; `null` or an empty/whitespace string
  // explicitly clears the goal.
  const intentTextPresent = Object.prototype.hasOwnProperty.call(body, "intentText");
  let nextIntentText: string | null | undefined = undefined;
  if (intentTextPresent) {
    const raw = body.intentText;
    if (raw === null || raw === undefined) {
      nextIntentText = null;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      nextIntentText = trimmed.length > 0 ? trimmed.slice(0, 500) : null;
    } else {
      res.status(400).json({ error: "intentText must be a string or null" });
      return;
    }
  }

  const [existing] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (!intentTextPresent) {
    // Nothing to update — just return the current session shape for consistency.
    const [profile0] = await db
      .select({ displayName: gpuProfilesTable.displayName, swarmWorkerCap: gpuProfilesTable.swarmWorkerCap })
      .from(gpuProfilesTable)
      .where(eq(gpuProfilesTable.id, existing.profileId));
    res.json({
      ...redactOwnerToken(existing),
      profileName: profile0?.displayName || "",
      swarmWorkerCap: profile0?.swarmWorkerCap ?? null,
    });
    return;
  }

  const [updated] = await db
    .update(sessionsTable)
    .set({ intentText: nextIntentText ?? null, updatedAt: new Date() })
    .where(eq(sessionsTable.id, id))
    .returning();

  if (nextIntentText && nextIntentText !== existing.intentText) {
    try {
      const memUserId = process.env["MIZI_MEM_USER_ID"] || "operator";
      addObservation(String(id), memUserId, "session_goal", "", nextIntentText);
    } catch (memErr) {
      logger.warn({ err: memErr, sessionId: id }, "Failed to record updated session_goal observation (non-fatal)");
    }
  }

  const [profile] = await db
    .select({ displayName: gpuProfilesTable.displayName, swarmWorkerCap: gpuProfilesTable.swarmWorkerCap })
    .from(gpuProfilesTable)
    .where(eq(gpuProfilesTable.id, updated.profileId));

  res.json({
    ...redactOwnerToken(updated),
    profileName: profile?.displayName || "",
    swarmWorkerCap: profile?.swarmWorkerCap ?? null,
  });
});

router.post("/sessions", permitBearer([], { optional: true }), async (req, res) => {
  const { profileId, offerId, teamMembers: teamMemberNames, taskMode, tokenMode, bundleId: requestedBundleId, repoUrl, repoBranch, repoFingerprint, intentText: rawIntentText, nimModelId, nimProvider, githubToken: rawGithubToken, modelRoutingMode: rawModelRoutingMode, enableLaneBranches: rawEnableLaneBranches, planId: requestedPlanId } = req.body;
  const modelRoutingMode: "auto" | "pinned" = rawModelRoutingMode === "pinned" ? "pinned" : "auto";

  // If no PAT was passed from the dashboard, attempt to load the stored OAuth token.
  // The dashboard omits the field when it knows an OAuth token is connected,
  // but we also fall back here in case the request came from an older client.
  let githubToken: string | undefined = (typeof rawGithubToken === "string" && rawGithubToken.trim())
    ? rawGithubToken.trim()
    : undefined;

  if (!githubToken) {
    const oauthToken = await getStoredGitHubToken();
    if (oauthToken) {
      githubToken = oauthToken;
      logger.info("Session launch: using stored GitHub OAuth token");
    }
  }

  // Sanitize and bound the natural-language session intent (optional).
  let intentText: string | null = null;
  if (typeof rawIntentText === "string") {
    const trimmed = rawIntentText.trim();
    if (trimmed.length > 0) {
      intentText = trimmed.slice(0, 500);
    }
  }

  if (!profileId && !nimModelId) {
    res.status(400).json({ error: "profileId or nimModelId is required" });
    return;
  }

  let profile = profileId ? await getProfileById(profileId) : null;
  if (!profile && nimModelId) {
    profile = await getNimWorkspaceProfile();
  }
  if (!profile) {
    res.status(400).json({ error: "Invalid profile" });
    return;
  }

  // Validate NIM provider key BEFORE any DB writes to prevent orphaned sessions.
  let nimApiBase: string | undefined;
  let nimApiKey: string | undefined;
  if (nimModelId) {
    const prov = nimProvider || "nvidia";
    const provConfig: Record<string, { apiBase: string; envKey: string }> = {
      nvidia:    { apiBase: "https://integrate.api.nvidia.com/v1", envKey: "NVIDIA_NIM_API_KEY" },
      vultr:     { apiBase: "https://api.vultrinference.com/v1",   envKey: "VULTR_INFERENCE_API_KEY" },
      together:  { apiBase: "https://api.together.xyz/v1",         envKey: "TOGETHER_API_KEY" },
      deepinfra: { apiBase: "https://api.deepinfra.com/v1/openai", envKey: "DEEPINFRA_API_KEY" },
    };
    const pc = provConfig[prov] ?? provConfig["nvidia"];
    nimApiBase = pc.apiBase;
    nimApiKey = process.env[pc.envKey];
    if (!nimApiKey) {
      res.status(400).json({
        error: `Provider "${prov}" is not configured — set the ${pc.envKey} environment variable to use this provider.`,
      });
      return;
    }
  }

  // Validate planId existence before any DB writes to prevent sessions from
  // being created with a dangling FK reference.
  if (requestedPlanId != null) {
    const planIdNum = Number(requestedPlanId);
    if (!Number.isFinite(planIdNum) || planIdNum <= 0) {
      res.status(400).json({ error: "planId must be a positive integer" });
      return;
    }
    const [existingPlan] = await db
      .select({ id: projectPlansTable.id, planRepoUrl: projectPlansTable.repoUrl, userId: projectPlansTable.userId })
      .from(projectPlansTable)
      .where(eq(projectPlansTable.id, planIdNum));
    if (!existingPlan) {
      res.status(400).json({ error: `Plan #${planIdNum} does not exist` });
      return;
    }
    // Ownership: require userId in the request and verify it matches the plan owner.
    // Unconditional — planId without a matching userId is rejected with 403.
    const requestedUserId = typeof req.body.userId === "string" ? req.body.userId.trim() : "";
    if (!requestedUserId || existingPlan.userId !== requestedUserId) {
      res.status(403).json({ error: "Forbidden: plan does not belong to the requesting user" });
      return;
    }
    // Reject cross-repo linkage when both sides carry a repoUrl.
    if (repoUrl && existingPlan.planRepoUrl && existingPlan.planRepoUrl !== repoUrl) {
      res.status(400).json({
        error: `Plan #${planIdNum} belongs to a different repository (${existingPlan.planRepoUrl})`,
      });
      return;
    }
  }

  let insertedSessionId: number | undefined;

  try {
    // NIM sessions provision on Fly.io — skip Vast.ai offer search entirely.
    let selectedOfferId: number | undefined = nimModelId ? undefined : offerId;

    if (!nimModelId && !selectedOfferId) {
      const searchParams = (profile.searchParams as Record<string, unknown>) || {};
      const offers = await vastai.searchOffers({
        gpu_name: searchParams.gpu_name as string,
        num_gpus: searchParams.num_gpus as number,
        min_gpu_ram: searchParams.min_gpu_ram as number,
        disk_space: profile.diskSizeGb,
        limit: 1,
      });

      if (!offers || offers.length === 0) {
        res.status(400).json({ error: "No GPU offers available for this profile. Try again later or choose a different profile." });
        return;
      }
      selectedOfferId = (offers[0] as VastOffer).id;
    }

    const [defaultTemplate] = await db
      .select()
      .from(templatesTable)
      .where(eq(templatesTable.isDefault, true))
      .limit(1);

    const templateHash = defaultTemplate?.templateHash || undefined;

    // Build team member records (up to 4 named members + __shared__ workspace)
    const rawNames: string[] = Array.isArray(teamMemberNames)
      ? teamMemberNames.map(String)
      : [];
    const sanitizedNames = [...new Set(
      rawNames.map(sanitizeMemberName).filter((n): n is string => n !== null)
    )].slice(0, 4);

    const teamMemberRecords: TeamMemberRecord[] = sanitizedNames.length > 0
      ? [
          // __shared__ listed first so it appears as the primary team entry
          {
            name: "__shared__",
            password: generatePassword(),
            path: "/shared/",
            ideUrl: null,
          },
          ...sanitizedNames.map((name) => ({
            name,
            password: generatePassword(),
            path: `/ide/${name}/`,
            ideUrl: null,
          })),
        ]
      : [];

    logger.info({ profileId, selectedOfferId, teamMemberCount: teamMemberRecords.length }, "Launching session — model will download on instance startup");

    const resolvedTaskMode = taskMode || (teamMemberRecords.length > 0 ? "team" : "build");
    const resolvedTokenMode = tokenMode || "core";
    const sessionType = teamMemberRecords.length > 0 ? "team" : "solo";

    // Build repo fingerprint from provided data or derive from repoUrl
    let repoFingerprintJson: Record<string, unknown> | null = null;
    if (repoFingerprint && typeof repoFingerprint === "object") {
      repoFingerprintJson = repoFingerprint as Record<string, unknown>;
    } else if (repoUrl && typeof repoUrl === "string") {
      const { createHash } = await import("crypto");
      const trimmedUrl = repoUrl.trim();
      const urlHash = createHash("sha256").update(trimmedUrl.toLowerCase()).digest("hex").slice(0, 16);
      let langs: string[] = [];
      let frameworks: string[] = [];

      // For GitHub repos, attempt to derive language fingerprint via public API (no auth required for public repos)
      const ghMatch = trimmedUrl.match(/github\.com\/([^/]+)\/([^/.\s]+)/);
      if (ghMatch) {
        try {
          const [owner, repo] = [ghMatch[1], ghMatch[2]];
          const ghHeaders = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

          // Detect languages
          const langResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, {
            headers: ghHeaders,
            signal: AbortSignal.timeout(5000),
          });
          if (langResp.ok) {
            const data = await langResp.json() as Record<string, number>;
            langs = Object.keys(data).map(l => l.toLowerCase());
          }

          // Detect frameworks from common marker files (GitHub contents API, non-blocking)
          const frameworkMarkers: Record<string, string> = {
            "package.json": "node",
            "requirements.txt": "python",
            "pyproject.toml": "python",
            "go.mod": "go",
            "Cargo.toml": "rust",
            "pom.xml": "java",
            "build.gradle": "java",
            "composer.json": "php",
            "Gemfile": "ruby",
          };
          const markerChecks = Object.keys(frameworkMarkers).map(async (file) => {
            try {
              const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}`, {
                headers: ghHeaders,
                signal: AbortSignal.timeout(3000),
              });
              if (r.ok) frameworks.push(frameworkMarkers[file]);
            } catch {
              // Ignore per-file failures
            }
          });
          await Promise.all(markerChecks);
          // Deduplicate frameworks
          frameworks = [...new Set(frameworks)];
        } catch {
          // Non-blocking: ignore if GitHub API is unreachable
        }
      }

      repoFingerprintJson = {
        url: trimmedUrl,
        branch: repoBranch || "main",
        urlHash,
        langs,
        frameworks,
        derivedAt: new Date().toISOString(),
        langSource: langs.length > 0 ? "github_api" : "none",
      };
    }

    const [session] = await db
      .insert(sessionsTable)
      .values({
        profileId: profile.id,
        vastOfferId: selectedOfferId,
        templateHash: templateHash || null,
        status: "provisioning",
        statusMessage: nimModelId
          ? "Provisioning workspace container — NIM API will be ready in ~2 min..."
          : "Finding GPU and provisioning instance...",
        gpuName: profile.gpuName,
        numGpus: profile.numGpus,
        teamMembers: teamMemberRecords.length > 0 ? teamMemberRecords : null,
        taskMode: resolvedTaskMode,
        tokenMode: resolvedTokenMode,
        activeBundleId: requestedBundleId || null,
        repoFingerprintJson,
        intentText,
        provider: nimModelId ? "nim" : "vastai",
        nimProvider: nimModelId ? String(nimProvider ?? "nvidia") : null,
        nimModelId: nimModelId ? String(nimModelId) : null,
        // Owner token: a random secret issued at session creation. Required by
        // the dashboard to call owner-only endpoints (e.g. swarm abort). Not a
        // team-member credential — team members use their own name+password.
        ownerToken: generatePassword(32),
        // Record that a GitHub PAT was supplied — the token itself is never stored.
        hasGithubToken: !!githubToken,
        // Phase-aware inference routing mode: "auto" | "pinned" (default "auto")
        modelRoutingMode: nimModelId ? modelRoutingMode : "auto",
        // Seed the active model from the launch parameters so model-history works immediately
        activeNimModelId: nimModelId ? String(nimModelId) : null,
        activeNimProvider: nimModelId ? String(nimProvider ?? "nvidia") : null,
        // Link an approved project plan to this session for task tracking.
        planId: requestedPlanId ? Number(requestedPlanId) : null,
      })
      .returning();

    insertedSessionId = session.id;

    const MODEL_REPO = profile.modelRepo;
    const MODEL_QUANT = profile.defaultQuant;
    const SERVED_MODEL_NAME = profile.servedModelName;

    const memProxyUrl = process.env["MIZI_MEM_PROXY_URL"]
      || (process.env["REPLIT_DEV_DOMAIN"]
        ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
        : undefined);

    const memUserId = process.env["MIZI_MEM_USER_ID"] || "operator";

    const callbackBaseUrl = memProxyUrl; // same base URL the instance can already reach

    // ── Smart Skills: compile the active bundle and encode it for the onstart script ──
    let activeBundleB64: string | undefined;
    let resolvedBundleId: number | undefined;
    let pendingCompiled: Awaited<ReturnType<typeof compileBundle>> | undefined;
    try {
      await seedDefaultBundles();
      const repoLangs: string[] = Array.isArray((repoFingerprintJson as Record<string, unknown> | null)?.langs)
        ? ((repoFingerprintJson as Record<string, unknown>).langs as string[])
        : [];

      const repoIntelligence = await getRepoIntelligenceForSession(session.id).catch(() => undefined);

      const sessionCtx: SessionContext = {
        sessionType: sessionType as SessionContext["sessionType"],
        taskMode: resolvedTaskMode as SessionContext["taskMode"],
        modelProfile: profile.servedModelName || "kimi",
        repoLangs,
        tokenMode: resolvedTokenMode as SessionContext["tokenMode"],
        repoIntelligence,
        intentText: intentText || undefined,
      };

      let bundle: typeof skillBundlesTable.$inferSelect | null = null;
      if (requestedBundleId) {
        const [found] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, requestedBundleId));
        bundle = found || null;
      }
      if (!bundle) {
        // Pass hasRepoContext so mizi-builder is forced when no repo URL was supplied
        bundle = await getDefaultBundleForContext(sessionCtx, !!(repoUrl && typeof repoUrl === "string" && repoUrl.trim()));
      }

      if (bundle) {
        resolvedBundleId = bundle.id;
        const compiled = await compileBundle(bundle.id, sessionCtx);
        activeBundleB64 = buildActiveBundleEnvPayload(compiled, resolvedTokenMode as SessionContext["tokenMode"]);
        // NOTE: recordSessionActivation is deferred to after createInstance succeeds
        // to avoid orphaned activation records on failed instance launches.
        pendingCompiled = compiled;
        logger.info({ sessionId: session.id, bundleId: bundle.id, bundleSlug: bundle.slug }, "Smart Skills bundle compiled for session");
      }
    } catch (skillsErr) {
      logger.warn({ err: skillsErr, sessionId: session.id }, "Smart Skills compilation failed — session will launch without skills bundle");
    }

    if (resolvedBundleId && resolvedBundleId !== (requestedBundleId || null)) {
      await db.update(sessionsTable).set({ activeBundleId: resolvedBundleId, updatedAt: new Date() }).where(eq(sessionsTable.id, session.id));
    }

    // nimApiBase / nimApiKey were validated and resolved before the session insert.

    // For NIM sessions with auto-routing, pre-select a high-throughput economy
    // model dedicated to swarm workers so they don't contend with the orchestrator
    // model. The swarm model is injected as SWARM_MODEL_ID + SWARM_PROVIDER env
    // vars via the onstart script; the Claw Runner forwards them to worker agents.
    let swarmModelId: string | undefined;
    let swarmProvider: string | undefined;
    let swarmApiBase: string | undefined;
    let swarmApiKey: string | undefined;
    if (nimModelId && modelRoutingMode === "auto") {
      try {
        const { getBestModelForPhase } = await import("../services/inference-router");
        const { getConfiguredProviders, PROVIDER_CONFIG } = await import("../services/nim-catalog");
        const best = await getBestModelForPhase("swarm", String(nimModelId), { configuredProviders: getConfiguredProviders() });
        if (best) {
          swarmModelId = best.model.nimModelId;
          swarmProvider = best.provider;
          // Resolve provider-specific credentials so the swarm LiteLLM route
          // uses the correct API base + key, even when the swarm provider differs
          // from the orchestrator provider (e.g. DeepInfra swarm + NVIDIA orchestrator).
          const swarmCfg = PROVIDER_CONFIG[swarmProvider];
          if (swarmCfg) {
            swarmApiBase = swarmCfg.apiBase;
            swarmApiKey = process.env[swarmCfg.envKey] ?? undefined;
          }
          logger.info({ sessionId: insertedSessionId, swarmModelId, swarmProvider, swarmApiBase },
            "Swarm model pre-selected for NIM session");
        }
      } catch (err) {
        logger.warn({ err }, "Swarm model pre-selection failed (non-fatal)");
      }
    }

    // enableLaneBranches defaults to true when an OAuth/PAT token is present.
    // Callers can pass false to revert to the legacy single-branch behaviour.
    const enableLaneBranches: boolean = rawEnableLaneBranches === false ? false : !!githubToken;

    const onstart = vastai.buildOnStartScript({
      modelRepo: MODEL_REPO,
      modelQuant: MODEL_QUANT,
      servedModelName: SERVED_MODEL_NAME,
      llamaCtxSize: profile.llamaCtxSize,
      llamaBatchSize: profile.llamaBatchSize,
      llamaExtraArgs: profile.llamaExtraArgs || "",
      numGpus: profile.numGpus,
      swarmWorkerCap: profile.swarmWorkerCap,
      memProxyUrl,
      memAuthToken: process.env["MIZI_MEM_TOKEN"],
      memUserId,
      teamMembers: teamMemberRecords,
      sessionId: insertedSessionId,
      callbackBaseUrl,
      activeBundleB64,
      nimModelId: nimModelId ? String(nimModelId) : undefined,
      nimApiBase,
      nimApiKey,
      swarmModelId,
      swarmProvider,
      swarmApiBase,
      swarmApiKey,
      githubToken,
      enableLaneBranches,
    });

    // ── Provision the workspace machine ────────────────────────────────────────
    // NIM sessions: Fly.io Machine (cheap always-on CPU host; brain is the NIM API).
    // Vast.ai sessions: GPU instance via the Vast.ai API (existing path).
    let provisionedFlyMachineId: string | undefined;
    let provisionedVastInstanceId: number | undefined;
    let provisionedCostPerHour: number | undefined;

    if (nimModelId) {
      const flyResult = await fly.createMachine({
        image: profile.dockerImageTag,
        env: {
          MODEL_REPO,
          MODEL_QUANT,
          SERVED_MODEL_NAME,
          VLLM_MAX_MODEL_LEN: String(profile.llamaCtxSize),
          VLLM_MAX_NUM_SEQS: String(profile.llamaBatchSize),
          NUM_GPUS: String(profile.numGpus),
        },
        startCmd: onstart,
      });
      provisionedFlyMachineId = flyResult.machineId;
      provisionedCostPerHour = 0.08; // fixed estimate: Fly shared-CPU-1x (~$3–6/mo)
      logger.info({ sessionId: insertedSessionId, flyMachineId: provisionedFlyMachineId }, "NIM session provisioned on Fly.io");
    } else {
      const result = await vastai.createInstance({
        offerId: selectedOfferId!,
        image: profile.dockerImageTag,
        onstart,
        disk: profile.diskSizeGb,
        templateHashId: templateHash,
        env: {
          MODEL_REPO,
          MODEL_QUANT,
          SERVED_MODEL_NAME,
          VLLM_MAX_MODEL_LEN: String(profile.llamaCtxSize),
          VLLM_MAX_NUM_SEQS: String(profile.llamaBatchSize),
          NUM_GPUS: String(profile.numGpus),
        },
      });
      provisionedVastInstanceId = result.new_contract;
      provisionedCostPerHour = result.expected_price ?? undefined;
    }

    // Record Skills activation now that instance creation succeeded (deferred from compile step)
    if (pendingCompiled) {
      try {
        await recordSessionActivation(session.id, pendingCompiled, resolvedTokenMode as SessionContext["tokenMode"]);
      } catch (activationErr) {
        logger.warn({ err: activationErr, sessionId: session.id }, "Failed to record session activation (non-fatal)");
      }
    }

    const [updated] = await db
      .update(sessionsTable)
      .set({
        vastInstanceId: provisionedVastInstanceId ?? null,
        flyMachineId: provisionedFlyMachineId ?? null,
        status: "provisioning",
        statusMessage: nimModelId
          ? "Fly.io workspace machine started — NIM fast-boot running..."
          : "Instance created — waiting for startup and model download...",
        startedAt: new Date(),
        costPerHour: provisionedCostPerHour ?? null,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, session.id))
      .returning();

    // Seed the natural-language session goal as the opening memory observation
    // so it shows up in session timelines and is searchable from day one.
    // Fire-and-forget — memory writes shouldn't block the launch response.
    if (intentText) {
      try {
        addObservation(
          String(session.id),
          memUserId,
          "session_goal",
          "",
          intentText,
        );
      } catch (memErr) {
        logger.warn({ err: memErr, sessionId: session.id }, "Failed to seed session_goal observation (non-fatal)");
      }
    }

    // ownerToken is included in the 201 creation response ONLY.
    // The dashboard persists it immediately to sessionStorage (keyed nim-owner-token:{id})
    // so mutation endpoints (PATCH /phase, /model, /routing-mode) work after redirect.
    // All subsequent reads (GET /sessions/:id) redact the token so it is never leaked
    // to unauthenticated pollers — it is only readable by whoever received the 201.
    res.status(201).json({
      ...updated,
      profileName: profile.displayName,
    });
  } catch (err: unknown) {
    logger.error(err, "Failed to create session");
    const message = err instanceof Error ? err.message : "Unknown error";

    if (insertedSessionId !== undefined) {
      await db
        .update(sessionsTable)
        .set({
          status: "error",
          statusMessage: `Provisioning failed: ${message}`,
          updatedAt: new Date(),
        })
        .where(eq(sessionsTable.id, insertedSessionId))
        .catch((e) => logger.warn(e, "Failed to mark session as error after provisioning failure"));
    }

    res.status(500).json({ error: `Failed to provision session: ${message}` });
  }
});

router.post("/sessions/:sessionId/refresh", async (req, res) => {
  const id = parseInt(req.params.sessionId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // NIM sessions on Fly.io: status updates arrive via the onstart callback
  // (POST /sessions/:id/status). Skip the Vast.ai poll entirely and return
  // the current DB state. Optionally cross-check Fly Machine liveness so we
  // can surface an unexpected machine destruction as a session error.
  if (session.provider === "nim") {
    if (session.flyMachineId && ACTIVE_STATUSES.includes(session.status)) {
      try {
        const machineState = await fly.getMachineState(session.flyMachineId);
        if (machineState === "destroyed") {
          const [updated] = await db
            .update(sessionsTable)
            .set({
              status: "error",
              statusMessage: "Fly.io workspace machine was destroyed unexpectedly",
              updatedAt: new Date(),
            })
            .where(eq(sessionsTable.id, id))
            .returning();
          cleanupSessionResources(id).catch(() => {});
          const [p] = await db.select().from(gpuProfilesTable).where(eq(gpuProfilesTable.id, session.profileId));
          res.json({ ...redactOwnerToken(updated), profileName: p?.displayName || "" });
          return;
        }
      } catch (flyErr) {
        logger.warn({ err: flyErr, flyMachineId: session.flyMachineId }, "Failed to check Fly Machine state during refresh (non-fatal)");
      }
    }
    const [p] = await db.select().from(gpuProfilesTable).where(eq(gpuProfilesTable.id, session.profileId));
    res.json({ ...redactOwnerToken(session), profileName: p?.displayName || "" });
    return;
  }

  if (!session.vastInstanceId) {
    res.json({ ...redactOwnerToken(session), profileName: "" });
    return;
  }

  try {
    const instance = await vastai.getInstance(session.vastInstanceId);
    const urls = vastai.buildInstanceUrls(instance);

    let status = session.status;
    let statusMessage = session.statusMessage;

    const vastStatus = instance.actual_status || instance.status_msg || "";
    const statusMsg = (instance.status_msg || "").toLowerCase();

    if (vastStatus === "running") {
      if (statusMsg.includes("downloading") || statusMsg.includes("pulling")) {
        status = "downloading";
        statusMessage = "Downloading model weights...";
      } else if (statusMsg.includes("starting_llm")) {
        status = "starting";
        statusMessage = "Loading model into GPU memory...";
      } else if (statusMsg.includes("llm_ready")) {
        status = "ready";
        statusMessage = "Session is ready — vLLM online";
      } else if (statusMsg.includes("services_ready")) {
        status = "starting";
        statusMessage = "Tools ready — LLM model loading in background...";
      } else {
        status = "starting";
        statusMessage = "Services starting up...";
      }
    } else if (vastStatus === "loading" || vastStatus === "creating") {
      status = "provisioning";
      const rawMsg = (instance.status_msg || "").trim();
      statusMessage = rawMsg ? `[${vastStatus}] ${rawMsg}` : "Instance is booting...";
    } else if (vastStatus === "exited" || vastStatus === "error") {
      status = "error";
      statusMessage = `Instance error: ${instance.status_msg || vastStatus}`;
    }

    const hoursRunning = session.startedAt
      ? (Date.now() - session.startedAt.getTime()) / (1000 * 60 * 60)
      : 0;
    const totalCost = session.costPerHour ? session.costPerHour * hoursRunning : 0;

    const [updated] = await db
      .update(sessionsTable)
      .set({
        status,
        statusMessage,
        boltDiyUrl: urls.boltDiyUrl || session.boltDiyUrl,
        codeServerUrl: urls.codeServerUrl || session.codeServerUrl,
        previewUrl: urls.previewUrl || session.previewUrl,
        sshHost: urls.sshHost || session.sshHost,
        sshPort: urls.sshPort || session.sshPort,
        publicIp: urls.publicIp || session.publicIp,
        totalCost: Math.round(totalCost * 100) / 100,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, id))
      .returning();

    if ((status === "error" || status === "stopped") && session.status !== status) {
      cleanupSessionResources(id).catch(() => {});
    }

    const [profile] = await db.select().from(gpuProfilesTable).where(eq(gpuProfilesTable.id, session.profileId));

    res.json({
      ...redactOwnerToken(updated),
      profileName: profile?.displayName || "",
    });
  } catch (err: unknown) {
    logger.error(err, "Failed to refresh session");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to refresh: ${message}` });
  }
});

router.delete("/sessions/:sessionId", async (req, res) => {
  const id = parseInt(req.params.sessionId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  try {
    if (session.provider === "nim" && session.flyMachineId) {
      // NIM session: destroy the Fly.io Machine (404 = already gone, treat as success).
      try {
        await fly.destroyMachine(session.flyMachineId);
      } catch (flyErr: unknown) {
        const msg = flyErr instanceof Error ? flyErr.message : "";
        if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
          logger.warn({ flyMachineId: session.flyMachineId }, "Fly Machine already gone — cleaning up DB record");
        } else {
          throw flyErr;
        }
      }
    } else if (session.vastInstanceId) {
      try {
        await vastai.destroyInstance(session.vastInstanceId);
      } catch (vastErr: unknown) {
        const msg = vastErr instanceof Error ? vastErr.message : "";
        if (msg.includes("404") || msg.includes("no_such_instance")) {
          logger.warn({ vastInstanceId: session.vastInstanceId }, "Instance already gone on Vast.ai — cleaning up DB record");
        } else {
          throw vastErr;
        }
      }
    }

    const hoursRunning = session.startedAt
      ? (Date.now() - session.startedAt.getTime()) / (1000 * 60 * 60)
      : 0;
    const totalCost = session.costPerHour ? session.costPerHour * hoursRunning : 0;

    cleanupSessionResources(id).catch(() => {});

    const [updated] = await db
      .update(sessionsTable)
      .set({
        status: "stopped",
        statusMessage: "Session destroyed",
        stoppedAt: new Date(),
        totalCost: Math.round(totalCost * 100) / 100,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, id))
      .returning();

    const [profile] = await db.select().from(gpuProfilesTable).where(eq(gpuProfilesTable.id, session.profileId));

    res.json({
      ...redactOwnerToken(updated),
      profileName: profile?.displayName || "",
    });
  } catch (err: unknown) {
    logger.error(err, "Failed to destroy session");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to destroy session: ${message}` });
  }
});

const MEM_USER_ID = process.env["MIZI_MEM_USER_ID"] || "operator";

// Dashboard memory proxy — these routes exist so the dashboard can fetch
// operator-scoped memory without needing the MIZI_MEM_TOKEN bearer header.
// MIZI is a single-operator platform: all sessions share one userId
// (MIZI_MEM_USER_ID, default "operator") for cross-session memory continuity.
// The :sessionId path parameter identifies the Vast.ai/MIZI session for
// route namespacing; memory records are scoped by MEM_USER_ID globally, not
// by individual session, since the intent is cross-session recall.
router.get("/sessions/:sessionId/memory/observations", (_req, res) => {
  const limit = 50;
  try {
    const observations = listObservations(MEM_USER_ID, limit, 0);
    res.json(observations);
  } catch (err) {
    logger.error(err, "Failed to list memory observations for dashboard");
    res.status(500).json({ error: "Failed to list observations" });
  }
});

router.get("/sessions/:sessionId/memory/sessions", (req, res) => {
  const limit = 30;
  const projectPath = (req.query["projectPath"] as string | undefined) || undefined;
  try {
    const sessions = listSessions(MEM_USER_ID, limit, 0, projectPath);
    res.json(sessions);
  } catch (err) {
    logger.error(err, "Failed to list memory sessions for dashboard");
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

// SSE stream: pushes new tool observations in real time as they are recorded.
// The dashboard subscribes when the session is active and falls back to polling when stopped.
router.get("/sessions/:sessionId/memory/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  const unsubscribe = subscribeToObservations(MEM_USER_ID, (obs) => {
    res.write(`data: ${JSON.stringify(obs)}\n\n`);
  });

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

router.get("/sessions/:sessionId/memory/search", (req, res) => {
  const q = (req.query["q"] as string | undefined) || "";
  const projectPath = (req.query["projectPath"] as string | undefined) || undefined;
  if (!q.trim()) {
    res.json({ observations: [], sessions: [], totalObservations: 0, totalSessions: 0 });
    return;
  }
  const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "30", 10) || 30));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const results = searchMemory(MEM_USER_ID, q, limit, offset, projectPath);
    res.json(results);
  } catch (err) {
    logger.error(err, "Failed to search memory for dashboard");
    res.status(500).json({ error: "Failed to search memory" });
  }
});

router.patch("/sessions/:sessionId/memory/sessions/:memSessionId/summary", (req, res) => {
  const { memSessionId } = req.params;
  const { summary } = req.body as { summary?: string };
  if (typeof summary !== "string") {
    res.status(400).json({ error: "summary (string) is required" });
    return;
  }
  try {
    addSummary(memSessionId, MEM_USER_ID, summary.trim());
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "Failed to update mem session summary");
    res.status(500).json({ error: "Failed to update summary" });
  }
});

router.get("/memory/search", (req, res) => {
  const q = (req.query["q"] as string | undefined) || "";
  const projectPath = (req.query["projectPath"] as string | undefined) || undefined;
  if (!q.trim()) {
    res.json({ observations: [], sessions: [], totalObservations: 0, totalSessions: 0 });
    return;
  }
  const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "30", 10) || 30));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const results = searchMemory(MEM_USER_ID, q, limit, offset, projectPath);
    res.json(results);
  } catch (err) {
    logger.error(err, "Failed to search global memory for dashboard");
    res.status(500).json({ error: "Failed to search memory" });
  }
});

router.patch("/memory/sessions/:memSessionId/summary", (req, res) => {
  const { memSessionId } = req.params;
  const { summary } = req.body as { summary?: string };
  if (typeof summary !== "string") {
    res.status(400).json({ error: "summary (string) is required" });
    return;
  }
  try {
    addSummary(memSessionId, MEM_USER_ID, summary.trim());
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "Failed to update mem session summary (global proxy)");
    res.status(500).json({ error: "Failed to update summary" });
  }
});

router.get("/memory/sessions", (req, res) => {
  const projectPath = (req.query["projectPath"] as string | undefined) || undefined;
  const limit = Math.min(200, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "100", 10) || 100));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const sessions = listSessions(MEM_USER_ID, limit, offset, projectPath);
    res.json(sessions);
  } catch (err) {
    logger.error(err, "Failed to list all memory sessions for dashboard");
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

router.get("/memory/governance-stats", (_req, res) => {
  try {
    const stats = getGovernanceStats({ userId: MEM_USER_ID });
    res.json(stats);
  } catch (err) {
    logger.error(err, "Failed to get memory governance stats for dashboard");
    res.status(500).json({ error: "Failed to get governance stats" });
  }
});

router.get("/memory/backup", async (_req, res) => {
  let tmpPath: string | null = null;
  try {
    tmpPath = await backupDb();
    const stat = fs.statSync(tmpPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="mem-backup-${new Date().toISOString().slice(0, 10)}.db"`);
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(tmpPath);
    stream.on("end", () => {
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    });
    stream.on("error", (err) => {
      logger.error(err, "Error streaming memory backup");
      if (!res.headersSent) res.status(500).json({ error: "Failed to stream backup" });
    });
    stream.pipe(res);
  } catch (err) {
    logger.error(err, "Failed to create memory backup");
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    if (!res.headersSent) res.status(500).json({ error: "Failed to create backup" });
  }
});

router.get("/memory/review-count", (_req, res) => {
  try {
    const counts = getReviewNeededCount(MEM_USER_ID);
    res.json(counts);
  } catch (err) {
    logger.error(err, "Failed to get memory review count");
    res.status(500).json({ error: "Failed to get review count" });
  }
});

router.post("/memory/sweep", (_req, res) => {
  try {
    const markedStale = runStaleSweep(MEM_USER_ID);
    const counts = getReviewNeededCount(MEM_USER_ID);
    res.json({ ok: true, markedStale, reviewNeeded: counts });
  } catch (err) {
    logger.error(err, "Failed to run memory stale sweep");
    res.status(500).json({ error: "Failed to run stale sweep" });
  }
});

router.get("/memory/stale", (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "50", 10) || 50));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const items = listStaleItems({ userId: MEM_USER_ID, limit, offset });
    res.json({ items, count: items.length });
  } catch (err) {
    logger.error(err, "Failed to list stale memory items");
    res.status(500).json({ error: "Failed to list stale items" });
  }
});

// ─── Dashboard proxies for passive recall (Task #225) ───────────────────────

router.get("/memory/recall-audit", (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "50", 10) || 50));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  const sessionId = (req.query["sessionId"] as string | undefined) || undefined;
  try {
    const entries = listRecallAudit({ userId: MEM_USER_ID, sessionId, limit, offset });
    res.json({ entries });
  } catch (err) {
    logger.error(err, "Failed to list recall audit for dashboard");
    res.status(500).json({ error: "Failed to list recall audit" });
  }
});

router.get("/memory/recall-metrics", (_req, res) => {
  try {
    const metrics = getRecallMetrics(MEM_USER_ID);
    res.json(metrics);
  } catch (err) {
    logger.error(err, "Failed to get recall metrics for dashboard");
    res.status(500).json({ error: "Failed to get recall metrics" });
  }
});

router.get("/memory/passive-config", (req, res) => {
  const sessionId = (req.query["sessionId"] as string | undefined) || undefined;
  try {
    res.json({
      globalDefault: passiveRecallGloballyEnabled(),
      sessionEnabled: sessionId ? isPassiveRecallEnabled(sessionId) : null,
    });
  } catch (err) {
    logger.error(err, "Failed to get passive config");
    res.status(500).json({ error: "Failed to get passive config" });
  }
});

router.post("/memory/passive-config", (req, res) => {
  const { sessionId, enabled } = req.body as { sessionId?: string; enabled?: boolean };
  if (!sessionId || typeof enabled !== "boolean") {
    res.status(400).json({ error: "sessionId and enabled (boolean) are required" });
    return;
  }
  try {
    setPassiveRecallForSession(sessionId, enabled);
    res.json({ ok: true, sessionId, enabled, globalDefault: passiveRecallGloballyEnabled() });
  } catch (err) {
    logger.error(err, "Failed to set passive config");
    res.status(500).json({ error: "Failed to set passive config" });
  }
});

router.get("/memory/governance/conflicts", (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "20", 10) || 20));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const conflicts = listConflicts({ userId: MEM_USER_ID, conflictStatus: "open", limit, offset });
    res.json({ conflicts });
  } catch (err) {
    logger.error(err, "Failed to list open conflict groups");
    res.status(500).json({ error: "Failed to list conflicts" });
  }
});

router.patch("/memory/stale/bulk", (req, res) => {
  const { itemIds, action } = req.body as { itemIds?: number[]; action?: string };
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    res.status(400).json({ error: "itemIds (non-empty array) is required" });
    return;
  }
  if (action !== "dismiss" && action !== "retract") {
    res.status(400).json({ error: "action must be 'dismiss' or 'retract'" });
    return;
  }
  try {
    const updated = bulkUpdateStaleItems(MEM_USER_ID, itemIds, action);
    const counts = getReviewNeededCount(MEM_USER_ID);
    res.json({ ok: true, updated, reviewNeeded: counts });
  } catch (err) {
    logger.error(err, "Failed to bulk update stale items");
    res.status(500).json({ error: "Failed to bulk update stale items" });
  }
});

const RESTORE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

router.post("/memory/restore", (req, res) => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let rejected = false;

  req.on("data", (chunk: Buffer) => {
    if (rejected) return;
    totalBytes += chunk.length;
    if (totalBytes > RESTORE_MAX_BYTES) {
      rejected = true;
      res.status(413).json({ error: "File too large. Restore files must be 200 MB or smaller." });
      res.once("finish", () => req.destroy());
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (rejected) return;
    const buf = Buffer.concat(chunks);
    if (!buf.length) {
      res.status(400).json({ error: "No file data received" });
      return;
    }
    try {
      restoreDb(buf);
      res.json({ ok: true, message: "Memory database restored successfully" });
    } catch (err) {
      logger.error(err, "Failed to restore memory database");
      const msg = err instanceof Error ? err.message : "Failed to restore database";
      res.status(400).json({ error: msg });
    }
  });
  req.on("error", (err) => {
    if (rejected) return;
    logger.error(err, "Error reading restore upload body");
    res.status(500).json({ error: "Failed to read uploaded file" });
  });
});

// ── Soft-interrupt telemetry endpoint ────────────────────────────────────────
// POST /sessions/:sessionId/telemetry/soft-interrupts
// Called by the claw-runner after each turn to forward SoftInterruptEvent records
// produced by SoftInterruptQueue::take_events(). Each record carries the time the
// user message waited in the queue before being injected and the number of messages
// coalesced at the same injection point. Logging here lets dashboards chart how
// often soft interrupts fire and how long messages waited (the cache-warm UX win).
router.post("/sessions/:sessionId/telemetry/soft-interrupts", (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Soft-interrupt telemetry callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const body = req.body as { events?: unknown[] };
  if (!Array.isArray(body?.events)) {
    res.status(400).json({ error: "events (array) is required" });
    return;
  }

  const safeMs = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  };
  const safeCount = (v: unknown): number => {
    const n = Number(v ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
  };

  let accepted = 0;
  for (const raw of body.events) {
    const ev = raw as Record<string, unknown>;
    const timeInQueueMs = safeMs(ev["time_in_queue_ms"]);
    const coalescedWith = safeCount(ev["coalesced_with"]);
    logger.info(
      { sessionId, timeInQueueMs, coalescedWith, event: "soft_interrupt_injected" },
      "Soft interrupt injected — message waited in queue before safe-boundary injection"
    );
    accepted++;
  }

  res.json({ ok: true, accepted });
});

// ── Routing stats endpoints ──────────────────────────────────────────────────
// POST /sessions/:sessionId/routing-stats
// Called by the claw-runner (via callbackBaseUrl) when context-shield stats are
// available. Stores the latest routing stats on the session row so the dashboard
// can read them and pass bytesAvoided to the complete-feedback endpoint.
router.post("/sessions/:sessionId/routing-stats", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  // Require the same Bearer token as the /status callback to prevent forged signals.
  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Routing-stats callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const { totalBytesAvoided, totalShielded, totalArtifacts, totalBlocked, routingFailures } = req.body as Partial<SessionRoutingStats>;

  const safeInt = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  };

  const stats: SessionRoutingStats = {
    totalBytesAvoided: safeInt(totalBytesAvoided),
    totalShielded: safeInt(totalShielded),
    totalArtifacts: safeInt(totalArtifacts),
    totalBlocked: safeInt(totalBlocked),
    routingFailures: safeInt(routingFailures),
    recordedAt: new Date().toISOString(),
  };

  try {
    const result = await db
      .update(sessionsTable)
      .set({ routingStatsJson: stats, updatedAt: new Date() })
      .where(eq(sessionsTable.id, sessionId))
      .returning({ id: sessionsTable.id });

    if (!result.length) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    logger.info({ sessionId, bytesAvoided: stats.totalBytesAvoided }, "Routing stats recorded for session");
    res.json({ ok: true, stats });
  } catch (err) {
    logger.error(err, "Failed to store routing stats");
    res.status(500).json({ error: "Failed to store routing stats" });
  }
});

// GET /sessions/:sessionId/routing-stats
// Returns the latest stored routing stats for a session (if any).
// The dashboard uses this to read bytesAvoided for the complete-feedback call.
router.get("/sessions/:sessionId/routing-stats", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  try {
    const [session] = await db
      .select({ routingStatsJson: sessionsTable.routingStatsJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.json({ stats: session.routingStatsJson ?? null });
  } catch (err) {
    logger.error(err, "Failed to fetch routing stats");
    res.status(500).json({ error: "Failed to fetch routing stats" });
  }
});

// ── Plan progress cache & endpoints ─────────────────────────────────────────
// The API server caches the last plan snapshot pushed by the Claw Runner so
// the cockpit can show what MIZI is currently doing (active task, plan
// checkpoint, active files, unresolved errors) without a direct container call.

export interface PlanSnapshot {
  activeTask?: string | null;
  planCheckpoint?: string | null;
  activeFiles?: string[];
  unresolvedErrors?: string[];
  taskSummary?: string | null;
  bundleSlug?: string | null;
  updatedAt: string;
}

const planCache = new Map<number, { snapshot: PlanSnapshot; receivedAt: number }>();
const PLAN_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes — plan updates less often than swarm

// SSE subscribers for live plan pushes, keyed by session ID.
const planSseSubscribers = new Map<number, Set<(snapshot: PlanSnapshot) => void>>();

const handlePlanPush: RequestHandler = async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Plan-push callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const snapshot = req.body as PlanSnapshot;
  if (!snapshot) {
    res.status(400).json({ error: "Missing snapshot body" });
    return;
  }
  if (!snapshot.updatedAt) snapshot.updatedAt = new Date().toISOString();

  planCache.set(sessionId, { snapshot, receivedAt: Date.now() });

  const sseSubscribers = planSseSubscribers.get(sessionId);
  if (sseSubscribers && sseSubscribers.size > 0) {
    for (const cb of sseSubscribers) {
      try { cb(snapshot); } catch { /* ignore broken pipe */ }
    }
  }

  try {
    await db
      .update(sessionsTable)
      .set({ planSnapshotJson: snapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(sessionsTable.id, sessionId));
  } catch (dbErr) {
    logger.warn({ err: dbErr, sessionId }, "Failed to persist plan snapshot to DB (non-fatal)");
  }

  logger.info({ sessionId, activeTask: snapshot.activeTask }, "Plan snapshot cached");
  res.json({ ok: true });
};

// POST /sessions/:sessionId/plan-push — canonical receiver.
router.post("/sessions/:sessionId/plan-push", handlePlanPush);

// POST /sessions/:sessionId/plan-status — alias used by the Claw Runner
// (mirrors the /swarm-status alias pattern).
router.post("/sessions/:sessionId/plan-status", handlePlanPush);

// GET /sessions/:sessionId/plan-status — cockpit polls this every ~5 seconds.
router.get("/sessions/:sessionId/plan-status", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, planSnapshotJson: sessionsTable.planSnapshotJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
      res.json({ availability: "starting", snapshot: null });
      return;
    }

    const cached = planCache.get(sessionId);
    const dbSnapshot = session.planSnapshotJson as PlanSnapshot | null;

    if (!cached && !dbSnapshot) {
      res.json({ availability: "unavailable", snapshot: null });
      return;
    }

    if (cached) {
      const ageMs = Date.now() - cached.receivedAt;
      res.json({
        availability: ageMs <= PLAN_STALE_THRESHOLD_MS ? "live" : "stale",
        snapshot: cached.snapshot,
      });
      return;
    }

    if (dbSnapshot) {
      planCache.set(sessionId, { snapshot: dbSnapshot, receivedAt: 0 });
      res.json({ availability: "stale", snapshot: dbSnapshot });
      return;
    }

    res.json({ availability: "unavailable", snapshot: null });
  } catch (err) {
    logger.error(err, "Failed to fetch plan status");
    res.status(500).json({ error: "Failed to fetch plan status" });
  }
});

// GET /sessions/:sessionId/plan-stream — SSE endpoint for live plan updates.
router.get("/sessions/:sessionId/plan-stream", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const cb = (snapshot: PlanSnapshot) => {
    res.write(`data: ${JSON.stringify({ availability: "live", snapshot })}\n\n`);
  };

  const cleanup = () => {
    if (keepAlive) clearInterval(keepAlive);
    const subs = planSseSubscribers.get(sessionId);
    if (subs) {
      subs.delete(cb);
      if (subs.size === 0) planSseSubscribers.delete(sessionId);
    }
  };

  req.on("close", cleanup);

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, planSnapshotJson: sessionsTable.planSnapshotJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.write(`data: ${JSON.stringify({ availability: "unavailable", snapshot: null })}\n\n`);
      res.end();
      return;
    }

    const cached = planCache.get(sessionId);
    const dbSnapshot = session.planSnapshotJson as PlanSnapshot | null;
    let initialPayload: { availability: string; snapshot: PlanSnapshot | null };

    if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
      initialPayload = { availability: "starting", snapshot: null };
    } else if (cached) {
      const ageMs = Date.now() - cached.receivedAt;
      initialPayload = { availability: ageMs <= PLAN_STALE_THRESHOLD_MS ? "live" : "stale", snapshot: cached.snapshot };
    } else if (dbSnapshot) {
      initialPayload = { availability: "stale", snapshot: dbSnapshot };
    } else {
      initialPayload = { availability: "unavailable", snapshot: null };
    }
    res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);
  } catch (initErr) {
    logger.warn({ err: initErr, sessionId }, "plan-stream: failed to send initial snapshot (non-fatal)");
  }

  keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  if (!planSseSubscribers.has(sessionId)) {
    planSseSubscribers.set(sessionId, new Set());
  }
  planSseSubscribers.get(sessionId)!.add(cb);
});

// ── Swarm status cache & endpoints ──────────────────────────────────────────
// The API server caches the last swarm snapshot pushed by the Claw Runner via
// the callback URL so the cockpit can render useful state even when the runner
// is temporarily unreachable. This is an in-memory cache keyed by session ID.

export interface SwarmWorker {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed" | "aborted";
  priority?: number;
  outputPreview?: string;
  outputFull?: string;
  errorSummary?: string;
  retryCount?: number;
}

export interface SwarmSnapshot {
  phase: "active" | "idle" | "synthesising" | "aborted" | "sequential" | "never";
  skipReason?: string;
  orchestratorReason?: string;
  decompositionReason?: string;
  totalWorkers?: number;
  workers?: SwarmWorker[];
  doneCount?: number;
  failedCount?: number;
  synthesisResult?: string;
  timestamp: string;
}

const swarmCache = new Map<number, { snapshot: SwarmSnapshot; receivedAt: number }>();
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// SSE subscribers waiting for live swarm pushes, keyed by session ID.
// When the runner posts a new snapshot via swarm-push, it is broadcast to all open streams.
const swarmSseSubscribers = new Map<number, Set<(snapshot: SwarmSnapshot) => void>>();

// Shared handler for swarm snapshot ingestion.
// Mounted on two paths:
//   POST /sessions/:id/swarm-push   — canonical receiver (preferred)
//   POST /sessions/:id/swarm-status — alias for Claw Runner compatibility
//
// The Claw Runner derives its push URL by replacing /status with /swarm-status
// on MIZI_CALLBACK_URL, so it always POSTs to /swarm-status rather than
// /swarm-push.  Registering both routes here ensures snapshots are never silently
// dropped without requiring an external proxy rewrite.
//
// GET /sessions/:id/swarm-status (below) is the dashboard reader and is unaffected
// — Express matches routes by method, so the GET and POST on the same path coexist.
const handleSwarmPush: RequestHandler = async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Swarm-push callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const snapshot = req.body as SwarmSnapshot;
  if (!snapshot || !snapshot.phase) {
    res.status(400).json({ error: "Missing snapshot phase" });
    return;
  }
  if (!snapshot.timestamp) snapshot.timestamp = new Date().toISOString();

  // Write to in-memory cache for fast polling response
  swarmCache.set(sessionId, { snapshot, receivedAt: Date.now() });

  // Notify any open SSE streams immediately so they reflect the update within milliseconds
  const sseSubscribers = swarmSseSubscribers.get(sessionId);
  if (sseSubscribers && sseSubscribers.size > 0) {
    for (const cb of sseSubscribers) {
      try { cb(snapshot); } catch { /* ignore broken pipe */ }
    }
  }

  // Persist to DB so snapshot survives API server restarts
  try {
    await db
      .update(sessionsTable)
      .set({ swarmSnapshotJson: snapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(sessionsTable.id, sessionId));
  } catch (dbErr) {
    logger.warn({ err: dbErr, sessionId }, "Failed to persist swarm snapshot to DB (non-fatal)");
  }

  logger.info({ sessionId, phase: snapshot.phase }, "Swarm snapshot cached");

  // Re-evaluate the best swarm model at snapshot time (closest hook to actual
  // worker dispatch — the Claw Runner POSTs here just before or after it spawns
  // each batch). Return the recommendation so the Claw Runner can forward it.
  let bestSwarmModel: { modelId: string; provider: string } | null = null;
  try {
    const [nimSession] = await db
      .select({ provider: sessionsTable.provider, nimModelId: sessionsTable.nimModelId,
                activeNimModelId: sessionsTable.activeNimModelId,
                activeNimProvider: sessionsTable.activeNimProvider,
                modelRoutingMode: sessionsTable.modelRoutingMode })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));
    if (nimSession?.provider === "nim" && nimSession.modelRoutingMode === "auto") {
      const { getBestModelForPhase } = await import("../services/inference-router");
      const { getConfiguredProviders } = await import("../services/nim-catalog");
      const currentModelId = nimSession.activeNimModelId ?? nimSession.nimModelId ?? "";
      const best = await getBestModelForPhase("swarm", currentModelId, { configuredProviders: getConfiguredProviders() });
      if (best) {
        bestSwarmModel = { modelId: best.model.nimModelId, provider: best.provider };
        logger.debug({ sessionId, ...bestSwarmModel }, "Swarm model re-evaluated at dispatch time");
      }
    }
  } catch (err) {
    logger.debug({ err, sessionId }, "Swarm model re-evaluation skipped (non-fatal)");
  }

  res.json({ ok: true, ...(bestSwarmModel ? { swarmModel: bestSwarmModel } : {}) });
};

// POST /sessions/:sessionId/swarm-push — canonical swarm snapshot receiver.
router.post("/sessions/:sessionId/swarm-push", handleSwarmPush);

// POST /sessions/:sessionId/swarm-status — alias used by the Claw Runner.
// The runner replaces /status with /swarm-status on MIZI_CALLBACK_URL, so
// without this alias every runner snapshot would 404 and be silently dropped.
router.post("/sessions/:sessionId/swarm-status", handleSwarmPush);

// GET /sessions/:sessionId/swarm-status — cockpit polls this every 3 seconds.
// Returns one of four availability states:
//   "live"        — in-memory cache is fresh (received within STALE_THRESHOLD_MS)
//   "stale"       — snapshot exists but cache is old (runner may be unreachable)
//   "starting"    — session not yet ready, runner hasn't started pushing
//   "unavailable" — no snapshot has ever been received for this session
router.get("/sessions/:sessionId/swarm-status", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, swarmSnapshotJson: sessionsTable.swarmSnapshotJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // If session is still provisioning/starting, report "starting"
    if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
      res.json({ availability: "starting", snapshot: null });
      return;
    }

    const cached = swarmCache.get(sessionId);
    const dbSnapshot = session.swarmSnapshotJson as SwarmSnapshot | null;

    // No snapshot in memory or DB — "never swarmed"
    if (!cached && !dbSnapshot) {
      res.json({ availability: "unavailable", snapshot: null });
      return;
    }

    // If we have a fresh in-memory cache, it's live
    if (cached) {
      const ageMs = Date.now() - cached.receivedAt;
      if (ageMs <= STALE_THRESHOLD_MS) {
        // Fresh cache — live regardless of phase
        res.json({ availability: "live", snapshot: cached.snapshot });
        return;
      }
      // Cache exists but is older than threshold — stale.
      // Do NOT set isHistorical: true here — whether a snapshot is "historical"
      // (from a completed run) is determined by its phase (active/synthesising = still
      // a live run that just hasn't sent updates; idle/aborted/etc = completed run).
      // Conflating stale-freshness with historical-completion misleads the UI.
      res.json({ availability: "stale", snapshot: cached.snapshot });
      return;
    }

    // No in-memory cache (server was restarted) but DB has a snapshot —
    // warm the cache from DB and return as stale (freshness unknown after restart).
    // Again, do NOT force isHistorical — let the phase drive that decision client-side.
    if (dbSnapshot) {
      swarmCache.set(sessionId, { snapshot: dbSnapshot, receivedAt: 0 });
      res.json({ availability: "stale", snapshot: dbSnapshot });
      return;
    }

    res.json({ availability: "unavailable", snapshot: null });
  } catch (err) {
    logger.error(err, "Failed to fetch swarm status");
    res.status(500).json({ error: "Failed to fetch swarm status" });
  }
});

// GET /sessions/:sessionId/swarm-stream — SSE endpoint for live swarm updates.
// The client subscribes once; every time the runner posts a new snapshot via
// swarm-push the server pushes it directly over this stream, replacing the 3-second poll.
// On connection error the dashboard falls back to polling swarm-status.
//
// AUTHORIZATION: requires ?token=<ownerToken|memberPassword> query parameter.
// EventSource does not support custom request headers, so we accept the credential
// as a URL query parameter instead. The token is validated against:
//   1. The session's ownerToken (full owner access)
//   2. Any team member's password (read-only viewer access)
// Unauthorized callers receive a 401 response before the SSE stream is opened;
// the dashboard falls back to polling swarm-status (no auth required for reads).
router.get("/sessions/:sessionId/swarm-stream", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  // Verify caller is session owner or an authorized team member before opening stream.
  const providedToken = typeof req.query["token"] === "string" ? req.query["token"].trim() : "";
  if (!providedToken) {
    res.status(401).json({ error: "Unauthorized: token query parameter is required" });
    return;
  }

  try {
    const [sessionAuth] = await db
      .select({ ownerToken: sessionsTable.ownerToken, teamMembers: sessionsTable.teamMembers })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!sessionAuth) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const isOwner = !!sessionAuth.ownerToken && providedToken === sessionAuth.ownerToken;
    const memberPasswords = (sessionAuth.teamMembers as TeamMemberRecord[] | null ?? []).map((m) => m.password).filter(Boolean);
    const isMember = memberPasswords.some((pw) => pw === providedToken);

    if (!isOwner && !isMember) {
      logger.warn({ sessionId }, "swarm-stream: rejected unauthorized connection attempt");
      res.status(403).json({ error: "Forbidden: valid owner token or member password required" });
      return;
    }
  } catch (authErr) {
    logger.error({ err: authErr, sessionId }, "swarm-stream: auth check failed");
    res.status(500).json({ error: "Internal server error during auth check" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Track cleanup resources so we can tear down correctly regardless of when the
  // client disconnects — including during the async DB read below.
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const cb = (snapshot: SwarmSnapshot) => {
    res.write(`data: ${JSON.stringify({ availability: "live", snapshot })}\n\n`);
  };

  const cleanup = () => {
    if (keepAlive) clearInterval(keepAlive);
    const subs = swarmSseSubscribers.get(sessionId);
    if (subs) {
      subs.delete(cb);
      if (subs.size === 0) swarmSseSubscribers.delete(sessionId);
    }
  };

  // Register close handler before any async work so early disconnects are caught.
  req.on("close", cleanup);

  // Send the current snapshot immediately so the UI renders without waiting for the next push.
  try {
    const [session] = await db
      .select({ status: sessionsTable.status, swarmSnapshotJson: sessionsTable.swarmSnapshotJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      // Session not found — tell the client explicitly so it can stop loading.
      res.write(`data: ${JSON.stringify({ availability: "unavailable", snapshot: null })}\n\n`);
      res.end();
      return;
    }

    const cached = swarmCache.get(sessionId);
    const dbSnapshot = session.swarmSnapshotJson as SwarmSnapshot | null;
    let initialPayload: { availability: string; snapshot: SwarmSnapshot | null };
    if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
      initialPayload = { availability: "starting", snapshot: null };
    } else if (cached) {
      const ageMs = Date.now() - cached.receivedAt;
      initialPayload = { availability: ageMs <= STALE_THRESHOLD_MS ? "live" : "stale", snapshot: cached.snapshot };
    } else if (dbSnapshot) {
      initialPayload = { availability: "stale", snapshot: dbSnapshot };
    } else {
      initialPayload = { availability: "unavailable", snapshot: null };
    }
    res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);
  } catch (initErr) {
    logger.warn({ err: initErr, sessionId }, "swarm-stream: failed to send initial snapshot (non-fatal)");
  }

  // Keep the connection alive so proxies/load-balancers don't time it out.
  keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  // Register the push callback — invoked by swarm-push whenever a new snapshot arrives.
  if (!swarmSseSubscribers.has(sessionId)) {
    swarmSseSubscribers.set(sessionId, new Set());
  }
  swarmSseSubscribers.get(sessionId)!.add(cb);
});

// POST /sessions/:sessionId/swarm/abort — session-owner emergency abort.
// This is a user-initiated action from the dashboard, NOT a runner callback.
// AUTHORIZATION: requires `Authorization: Bearer {ownerToken}` where ownerToken
// is the random secret generated at session creation (returned on the detail endpoint).
// This gates the destructive abort control against direct API calls from team members
// or other unauthorized callers.
router.post("/sessions/:sessionId/swarm/abort", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  // Verify owner token from Authorization header
  const authHeader = req.headers["authorization"] || "";
  const providedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, ownerToken: sessionsTable.ownerToken })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Server-enforced owner authorization via ownerToken.
    // The token is generated at session creation (returned ONLY on detail endpoint).
    // Always require a matching token — a null DB token is not a valid bypass.
    // (Null would only occur for sessions created before this feature; the migration
    // backfills all existing sessions so nulls should not appear in practice.)
    if (!session.ownerToken || providedToken !== session.ownerToken) {
      logger.warn({ sessionId, hasToken: !!session.ownerToken }, "Swarm abort: invalid or missing owner token");
      res.status(403).json({ error: "Forbidden: valid owner token required to abort swarm" });
      return;
    }

    // Only allow abort on sessions that are not already stopped/errored
    if (session.status === "stopped" || session.status === "error") {
      res.status(409).json({ error: "Session is already stopped — nothing to abort" });
      return;
    }

    // Record abort in snapshot cache and persist to DB
    const abortedTimestamp = new Date().toISOString();
    const cached = swarmCache.get(sessionId);
    const baseSnapshot: SwarmSnapshot = cached?.snapshot ?? {
      phase: "aborted",
      timestamp: abortedTimestamp,
    };
    const abortedSnapshot: SwarmSnapshot = {
      ...baseSnapshot,
      phase: "aborted",
      timestamp: abortedTimestamp,
    };

    swarmCache.set(sessionId, { snapshot: abortedSnapshot, receivedAt: Date.now() });

    // Persist abort state to DB
    try {
      await db
        .update(sessionsTable)
        .set({ swarmSnapshotJson: abortedSnapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(sessionsTable.id, sessionId));
    } catch (dbErr) {
      logger.warn({ err: dbErr, sessionId }, "Failed to persist abort snapshot to DB (non-fatal)");
    }

    logger.info({ sessionId }, "Swarm abort recorded");
    res.json({ ok: true, message: "Abort signal recorded. The runner will process it on next check." });
  } catch (err) {
    logger.error(err, "Failed to process swarm abort");
    res.status(500).json({ error: "Failed to process abort" });
  }
});

// ── Soft-interrupt message queue ─────────────────────────────────────────────
// The dashboard can POST messages here during an active agent turn. Messages are
// stored in memory with state "queued". When the Claw Runner injects the message
// at the next safe boundary, it calls the /injected callback to transition state
// to "sent". SSE subscribers receive real-time state-change events.

interface SoftInterruptMessage {
  id: string;
  sessionId: number;
  text: string;
  state: "queued" | "sent";
  sentAt: number;
  injectedAt: number | null;
}

// ── Phase-aware inference routing (Task #300) ─────────────────────────────────

// PATCH /sessions/:sessionId/phase — update the active reasoning phase for a
// NIM session and optionally trigger automatic model scoring/switching if
// modelRoutingMode is "auto".
// AUTHORIZATION: requires `Authorization: Bearer {ownerToken}`
router.patch("/sessions/:sessionId/phase", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const { phase } = req.body as { phase?: string };
  const VALID_PHASES = ["explore", "plan", "implement", "swarm", "synthesise", "review"];
  if (!phase || !VALID_PHASES.includes(phase)) {
    res.status(400).json({ error: `phase must be one of: ${VALID_PHASES.join(", ")}` });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Owner-only: validate bearer token
  const providedToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!session.ownerToken || providedToken !== session.ownerToken) {
    logger.warn({ sessionId }, "Phase update: invalid or missing owner token");
    res.status(403).json({ error: "Forbidden: valid owner token required" });
    return;
  }

  await db
    .update(sessionsTable)
    .set({ currentPhase: phase, updatedAt: new Date() })
    .where(eq(sessionsTable.id, sessionId));

  // If auto-routing is enabled for this NIM session, score models and execute
  // a switch if the top candidate differs meaningfully from the active model.
  let autoSwitched: { modelId: string; provider: string } | null = null;
  let suggestion: { modelId: string; provider: string } | null = null;
  if (session.provider === "nim" && session.modelRoutingMode === "auto") {
    try {
      const { getBestModelForPhase, getProviderSnapshots } = await import("../services/inference-router");
      const { getConfiguredProviders } = await import("../services/nim-catalog");
      const configuredProviders = getConfiguredProviders();
      // Fetch live provider snapshots once — used for both scoring and liveness gate.
      const snapshots = await getProviderSnapshots().catch(() => ({}));
      const currentModelId = session.activeNimModelId ?? session.nimModelId;
      const currentProvider = session.activeNimProvider ?? session.nimProvider ?? null;
      const best = await getBestModelForPhase(
        phase as import("../services/inference-router").SessionPhase,
        currentModelId,
        { configuredProviders, snapshots, currentProvider },
      );
      if (best) {
        const newProvider = best.provider;
        // Execute the model swap internally (auto mode = no user prompt required).
        // Attempt LiteLLM hot-reload first; persist switch record only on success or
        // when there is no Fly machine (non-Fly sessions don't need a reload).
        // Resolve provider-specific credentials at switch time (same as PATCH /model)
        // so non-NVIDIA providers get correct api_base + api_key.
        let reloadOk = true;
        if (session.flyMachineId) {
          try {
            const { PROVIDER_CONFIG } = await import("../services/nim-catalog");
            const providerCfg = PROVIDER_CONFIG[newProvider];
            const providerApiBase = providerCfg?.apiBase ?? "https://integrate.api.nvidia.com/v1";
            const providerApiKey = providerCfg ? (process.env[providerCfg.envKey] ?? "") : "";
            const result = await fly.execMachine(
              session.flyMachineId,
              ["/opt/mizi/reload-model.sh"],
              {
                LITELLM_MODEL_ID: best.model.nimModelId,
                LITELLM_PROVIDER: newProvider,
                LITELLM_API_BASE: providerApiBase,
                LITELLM_API_KEY: providerApiKey,
              },
            );
            reloadOk = result.exit_code === 0;
            if (!reloadOk) {
              logger.warn({ sessionId, modelId: best.model.nimModelId, stderr: result.stderr },
                "Auto-route: LiteLLM reload failed — staying on current model");
            }
          } catch (err) {
            reloadOk = false;
            logger.warn({ err, sessionId }, "Auto-route: Fly exec failed — staying on current model");
          }
        }

        if (reloadOk) {
          // Persist only after a successful reload (graceful-degradation semantics).
          await db
            .update(sessionsTable)
            .set({ activeNimModelId: best.model.nimModelId, activeNimProvider: newProvider, updatedAt: new Date() })
            .where(eq(sessionsTable.id, sessionId));
          await db.insert(sessionModelSwitchesTable).values({
            sessionId,
            fromModelId: currentModelId ?? null,
            fromProvider: session.activeNimProvider ?? session.nimProvider ?? null,
            toModelId: best.model.nimModelId,
            toProvider: newProvider,
            phase,
            triggeredBy: "auto",
            reason: `phase changed to ${phase}`,
            switchedAt: new Date(),
          });
          autoSwitched = { modelId: best.model.nimModelId, provider: newProvider };
          logger.info({ sessionId, modelId: best.model.nimModelId, phase }, "Auto-route: model switched");
        } else {
          // Return a manual suggestion for the dashboard to action.
          suggestion = { modelId: best.model.nimModelId, provider: newProvider };
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId }, "Inference router scoring failed (non-fatal)");
    }
  }

  res.json({ ok: true, phase, autoSwitched, suggestion });
});

// PATCH /sessions/:sessionId/model — swap the active LLM model for a NIM session.
// Records the switch in session_model_switches and attempts a LiteLLM hot-reload
// via Fly.io exec if the session is hosted on Fly.
// AUTHORIZATION: requires `Authorization: Bearer {ownerToken}`
router.patch("/sessions/:sessionId/model", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  // Accept both `provider` and `providerId` for contract compatibility.
  // Optional tokensIn/tokensOut/costUsd: when the Claw Runner or orchestrator
  // reports actual usage at switch time, we store it for metric-backed cost attribution.
  const { modelId, provider: providerField, providerId, triggeredBy = "manual", reason,
          tokensIn, tokensOut, costUsd } = req.body as {
    modelId?: string;
    provider?: string;
    providerId?: string;
    triggeredBy?: "manual" | "auto";
    reason?: string;
    tokensIn?: number | null;
    tokensOut?: number | null;
    costUsd?: number | null;
  };
  const provider = providerField ?? providerId;

  if (!modelId || typeof modelId !== "string" || modelId.length > 200) {
    res.status(400).json({ error: "modelId (string, max 200 chars) is required" });
    return;
  }
  if (!provider || typeof provider !== "string" || provider.length > 100) {
    res.status(400).json({ error: "provider or providerId (string, max 100 chars) is required" });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Owner-only: validate bearer token
  const providedToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!session.ownerToken || providedToken !== session.ownerToken) {
    logger.warn({ sessionId }, "Model switch: invalid or missing owner token");
    res.status(403).json({ error: "Forbidden: valid owner token required" });
    return;
  }

  if (session.provider !== "nim") {
    res.status(400).json({ error: "Model switching is only supported for NIM sessions" });
    return;
  }

  // Model switching only makes sense on an active session.
  // "ready" is the steady active state for NIM sessions; also allow starting/pending.
  const runningStatuses = ["running", "pending", "starting", "ready"];
  if (!runningStatuses.includes(session.status ?? "")) {
    res.status(409).json({ error: `Cannot switch model: session is in '${session.status}' state (must be ready/running)` });
    return;
  }

  // Validate modelId against the NIM catalog and check provider liveness.
  const [catalogEntry] = await db
    .select({
      nimModelId: nimCatalogTable.nimModelId,
      nimTypes: nimCatalogTable.nimTypes,
      partnerProviders: nimCatalogTable.partnerProviders,
    })
    .from(nimCatalogTable)
    .where(eq(nimCatalogTable.nimModelId, modelId))
    .limit(1);
  if (!catalogEntry) {
    res.status(400).json({ error: `modelId '${modelId}' is not in the NIM catalog` });
    return;
  }

  // Verify the requested provider is configured, serves this model, and is currently live.
  // nvidia is always allowed for preview/free-tier models; partner providers
  // must be both configured in env and listed in the catalog's partnerProviders.
  const { getConfiguredProviders } = await import("../services/nim-catalog");
  const { getProviderSnapshots } = await import("../services/inference-router");
  const configuredProviders = getConfiguredProviders();
  const snapshots: Record<string, import("../services/inference-router").ProviderSnapshot> =
    await getProviderSnapshots().catch(() => ({}));
  const partnerProviders: string[] = Array.isArray(catalogEntry.partnerProviders)
    ? catalogEntry.partnerProviders as string[]
    : [];
  const nimTypes: string[] = Array.isArray(catalogEntry.nimTypes)
    ? catalogEntry.nimTypes as string[]
    : [];
  const isFreeNvidia = provider === "nvidia" && nimTypes.includes("nim_type_preview");
  const isConfiguredPartner = configuredProviders[provider] && partnerProviders.includes(provider);
  if (!isFreeNvidia && !isConfiguredPartner) {
    res.status(400).json({
      error: `Provider '${provider}' is not configured or does not serve model '${modelId}'`,
    });
    return;
  }
  // Liveness gate: reject the switch if the target provider is currently unreachable.
  const snap = snapshots[provider];
  if (snap && !snap.live) {
    res.status(503).json({
      error: `Provider '${provider}' is currently unreachable — model switch aborted`,
    });
    return;
  }

  const prevModelId = session.activeNimModelId ?? session.nimModelId;
  const prevProvider = session.activeNimProvider ?? session.nimProvider;

  // Nothing to do if the requested model is already active.
  if (prevModelId === modelId && prevProvider === provider) {
    res.json({ ok: true, switched: false, modelId, provider });
    return;
  }

  // Attempt LiteLLM hot-reload FIRST (validate liveness before persisting switch).
  // Pass model/provider as env vars — no shell interpolation risk.
  // Sessions without a Fly machine (local dev / non-Fly deploys) skip the reload.
  let reloadResult: { attempted: boolean; exitCode: number | null; ok: boolean } = { attempted: false, exitCode: null, ok: true };
  if (session.flyMachineId) {
    try {
      // Resolve provider-specific credentials at switch time — not from launch-time env.
      // This ensures the new provider's api_base and api_key are written to the LiteLLM
      // config, so inference actually routes to the new upstream.
      const { PROVIDER_CONFIG } = await import("../services/nim-catalog");
      const providerCfg = PROVIDER_CONFIG[provider];
      const providerApiBase = providerCfg?.apiBase ?? "https://integrate.api.nvidia.com/v1";
      const providerApiKey = providerCfg ? (process.env[providerCfg.envKey] ?? "") : "";
      const result = await fly.execMachine(
        session.flyMachineId,
        ["/opt/mizi/reload-model.sh"],
        {
          LITELLM_MODEL_ID: modelId,
          LITELLM_PROVIDER: provider,
          LITELLM_API_BASE: providerApiBase,
          LITELLM_API_KEY: providerApiKey,
        },
      );
      const reloadOk = result.exit_code === 0;
      reloadResult = { attempted: true, exitCode: result.exit_code, ok: reloadOk };
      if (!reloadOk) {
        logger.warn({ sessionId, modelId, provider, stderr: result.stderr },
          "LiteLLM hot-reload failed — aborting model switch to preserve DB consistency");
        res.status(503).json({
          error: "Model switch aborted: LiteLLM reload failed on the session machine",
          reloadResult,
          currentModelId: prevModelId,
          currentProvider: prevProvider,
        });
        return;
      }
      logger.info({ sessionId, modelId, provider }, "LiteLLM hot-reload succeeded");
    } catch (err) {
      logger.warn({ err, sessionId }, "LiteLLM hot-reload exec failed — aborting model switch");
      res.status(503).json({
        error: "Model switch aborted: could not reach session machine for reload",
        currentModelId: prevModelId,
        currentProvider: prevProvider,
      });
      return;
    }
  }

  // Persist only after a successful reload (or for non-Fly sessions where no reload is needed).
  await db
    .update(sessionsTable)
    .set({ activeNimModelId: modelId, activeNimProvider: provider, updatedAt: new Date() })
    .where(eq(sessionsTable.id, sessionId));

  // Record the switch in the audit log.
  // tokensIn/tokensOut/costUsd are optional — populated when the caller (Claw Runner
  // or orchestrator) reports actual usage; NULL otherwise (cost chart uses estimates).
  await db.insert(sessionModelSwitchesTable).values({
    sessionId,
    fromModelId: prevModelId ?? null,
    fromProvider: prevProvider ?? null,
    toModelId: modelId,
    toProvider: provider,
    phase: session.currentPhase ?? null,
    triggeredBy: triggeredBy === "auto" ? "auto" : "manual",
    reason: reason ?? (triggeredBy === "auto" ? "auto phase routing" : "user selected"),
    switchedAt: new Date(),
    ...(tokensIn != null ? { tokensIn } : {}),
    ...(tokensOut != null ? { tokensOut } : {}),
    ...(costUsd != null ? { costUsd: String(costUsd) } : {}),
  });

  res.json({ ok: true, switched: true, modelId, provider, reloadResult });
});

// GET /sessions/:sessionId/model-history — return the model switch audit log for a session.
// Read-only endpoint consumed by the dashboard Inference tab — no owner auth required
// (session data is already visible in the cockpit; ownerToken gates mutations only).
router.get("/sessions/:sessionId/model-history", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const [session] = await db
    .select({ id: sessionsTable.id, nimModelId: sessionsTable.nimModelId, nimProvider: sessionsTable.nimProvider,
              activeNimModelId: sessionsTable.activeNimModelId, activeNimProvider: sessionsTable.activeNimProvider,
              currentPhase: sessionsTable.currentPhase, modelRoutingMode: sessionsTable.modelRoutingMode,
              createdAt: sessionsTable.createdAt })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const switches = await db
    .select()
    .from(sessionModelSwitchesTable)
    .where(eq(sessionModelSwitchesTable.sessionId, sessionId))
    .orderBy(desc(sessionModelSwitchesTable.switchedAt));

  // Enrich each switch with durationMs and estimated cost.
  // Cost estimation uses throughputClass → approx token/s and provider → cost/M tokens.
  // These are rough estimates — real costs depend on actual request volumes — but they
  // provide a useful relative split across models for the cost-attribution chart.
  const THROUGHPUT_TPS: Record<string, number> = { high: 200, standard: 80, economy: 150 };
  const COST_PER_MILLION: Record<string, number> = {
    nvidia: 0.80, vultr: 0.30, together: 0.25, deepinfra: 0.20,
  };

  // Load throughputClass for each distinct toModelId in one batch.
  const distinctModelIds = [...new Set(switches.map((s) => s.toModelId))];
  const catalogRows = distinctModelIds.length > 0
    ? await db
        .select({ nimModelId: nimCatalogTable.nimModelId, throughputClass: nimCatalogTable.throughputClass })
        .from(nimCatalogTable)
        .where(inArray(nimCatalogTable.nimModelId, distinctModelIds))
    : [];
  const throughputByModel = new Map(catalogRows.map((r) => [r.nimModelId, r.throughputClass]));

  // Synthesize the "launch model" interval as the zeroth entry in the timeline.
  // This guarantees the cost-split chart is populated even for sessions that have
  // never triggered a mid-session switch (the common case for pinned-mode sessions
  // and early-phase auto-routed sessions that haven't hit a phase boundary yet).
  // The interval runs from session.createdAt to the first real switch (or now).
  const launchModelId = session.nimModelId;
  const launchProvider = session.nimProvider ?? "nvidia";
  const launchSyntheticSwitch =
    launchModelId
      ? {
          id: -1, // synthetic — not a real DB row
          sessionId,
          fromModelId: null as string | null,
          fromProvider: null as string | null,
          toModelId: launchModelId,
          toProvider: launchProvider,
          reason: "session_launch" as const,
          phase: null as string | null,
          switchedAt: session.createdAt,
          tokensIn: null as number | null,
          tokensOut: null as number | null,
          costUsd: null as string | null,
        }
      : null;

  // Switches arrive newest-first (desc order); reverse to compute chronologically.
  const chronological = [
    ...(launchSyntheticSwitch ? [launchSyntheticSwitch] : []),
    ...[...switches].reverse(),
  ];
  const enriched = chronological.map((sw, i) => {
    const end = i < chronological.length - 1
      ? new Date(chronological[i + 1]!.switchedAt).getTime()
      : Date.now();
    const durationMs = Math.max(end - new Date(sw.switchedAt).getTime(), 0);

    // Prefer real token/cost metrics reported by the caller (stored in DB).
    // Fall back to throughput-class estimates only when real data is absent.
    const realTokensIn = sw.tokensIn ?? null;
    const realTokensOut = sw.tokensOut ?? null;
    const realCostUsd = sw.costUsd != null ? Number(sw.costUsd) : null;

    const hasRealMetrics = realTokensIn != null || realCostUsd != null;

    let estimatedTokens: number;
    let estimatedCostUsd: number;
    if (hasRealMetrics) {
      estimatedTokens = (realTokensIn ?? 0) + (realTokensOut ?? 0);
      estimatedCostUsd = realCostUsd ?? 0;
    } else {
      const tc = throughputByModel.get(sw.toModelId) ?? "standard";
      const tps = THROUGHPUT_TPS[tc] ?? 80;
      const costPerM = COST_PER_MILLION[sw.toProvider] ?? 0.50;
      estimatedTokens = Math.round((durationMs / 1000) * tps);
      estimatedCostUsd = Number(((estimatedTokens / 1_000_000) * costPerM).toFixed(6));
    }

    return { ...sw, durationMs, estimatedTokens, estimatedCostUsd, hasRealMetrics };
  }).reverse(); // back to newest-first for the client

  // Aggregate cost by model for the cost-split summary.
  const costByModel: Record<string, { modelId: string; provider: string; estimatedCostUsd: number; estimatedTokens: number }> = {};
  for (const sw of enriched) {
    const key = `${sw.toModelId}::${sw.toProvider}`;
    if (!costByModel[key]) costByModel[key] = { modelId: sw.toModelId, provider: sw.toProvider, estimatedCostUsd: 0, estimatedTokens: 0 };
    costByModel[key]!.estimatedCostUsd += sw.estimatedCostUsd;
    costByModel[key]!.estimatedTokens += sw.estimatedTokens;
  }
  const costSplit = Object.values(costByModel).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

  res.json({
    sessionId,
    currentModelId: session.activeNimModelId ?? session.nimModelId,
    currentProvider: session.activeNimProvider ?? session.nimProvider,
    currentPhase: session.currentPhase,
    modelRoutingMode: session.modelRoutingMode ?? "auto",
    switches: enriched,
    costSplit,
    totalEstimatedCostUsd: Number(costSplit.reduce((s, c) => s + c.estimatedCostUsd, 0).toFixed(6)),
    totalEstimatedTokens: costSplit.reduce((s, c) => s + c.estimatedTokens, 0),
  });
});

// GET /sessions/:sessionId/swarm-model — return the best model for the swarm phase
// at the time of the request, using live provider latency data.
// Intended to be called by the Claw Runner immediately before dispatching each
// worker batch, so that swarm workers always get the freshest model recommendation
// rather than the one computed at session launch.
// Read-only — no owner auth required.
router.get("/sessions/:sessionId/swarm-model", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const [session] = await db
    .select({
      provider: sessionsTable.provider,
      nimModelId: sessionsTable.nimModelId,
      activeNimModelId: sessionsTable.activeNimModelId,
      activeNimProvider: sessionsTable.activeNimProvider,
      modelRoutingMode: sessionsTable.modelRoutingMode,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.provider !== "nim") {
    res.status(400).json({ error: "swarm-model is only available for NIM sessions" });
    return;
  }

  try {
    const { getBestModelForPhase, scoreModelsForPhase } = await import("../services/inference-router");
    const { getConfiguredProviders } = await import("../services/nim-catalog");
    const currentModelId = session.activeNimModelId ?? session.nimModelId ?? "";
    const configuredProviders = getConfiguredProviders();

    const [best, scored] = await Promise.all([
      getBestModelForPhase("swarm", currentModelId, { configuredProviders }),
      scoreModelsForPhase("swarm", { configuredProviders }),
    ]);

    const bestLatencyMs = best
      ? (scored.find((s) => s.model.nimModelId === best.model.nimModelId && s.provider === best.provider)?.latencyMs ?? null)
      : null;

    res.json({
      sessionId,
      phase: "swarm",
      recommendation: best
        ? { modelId: best.model.nimModelId, provider: best.provider, latencyMs: bestLatencyMs }
        : null,
      scored: scored.slice(0, 5).map((s) => ({
        modelId: s.model.nimModelId,
        provider: s.provider,
        score: s.score,
        latencyMs: s.latencyMs,
      })),
    });
  } catch (err) {
    logger.warn({ err, sessionId }, "swarm-model scoring failed");
    res.status(503).json({ error: "Scoring temporarily unavailable" });
  }
});

// PATCH /sessions/:sessionId/routing-mode — toggle between "auto" and "pinned" routing.
// AUTHORIZATION: requires `Authorization: Bearer {ownerToken}`
router.patch("/sessions/:sessionId/routing-mode", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const { mode } = req.body as { mode?: string };
  if (mode !== "auto" && mode !== "pinned") {
    res.status(400).json({ error: 'mode must be "auto" or "pinned"' });
    return;
  }

  const [session] = await db
    .select({ id: sessionsTable.id, provider: sessionsTable.provider, ownerToken: sessionsTable.ownerToken })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Owner-only: validate bearer token
  const providedToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!session.ownerToken || providedToken !== session.ownerToken) {
    logger.warn({ sessionId }, "Routing mode update: invalid or missing owner token");
    res.status(403).json({ error: "Forbidden: valid owner token required" });
    return;
  }

  if (session.provider !== "nim") {
    res.status(400).json({ error: "Routing mode is only applicable to NIM sessions" });
    return;
  }

  await db.update(sessionsTable).set({ modelRoutingMode: mode, updatedAt: new Date() }).where(eq(sessionsTable.id, sessionId));
  res.json({ ok: true, mode });
});

// GET /sessions/:sessionId/inference-ranking — score all available NIM models
// for the session's current phase and return the ranked list.
// Read-only endpoint consumed by the dashboard Inference tab — no owner auth required.
router.get("/sessions/:sessionId/inference-ranking", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const [session] = await db
    .select({
      currentPhase: sessionsTable.currentPhase,
      provider: sessionsTable.provider,
      nimProvider: sessionsTable.nimProvider,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  try {
    const { scoreModelsForPhase, VALID_PHASES } = await import("../services/inference-router");
    const { getConfiguredProviders } = await import("../services/nim-catalog");
    const phase = (VALID_PHASES.includes(session.currentPhase as typeof VALID_PHASES[number])
      ? session.currentPhase
      : "implement") as import("../services/inference-router").SessionPhase;

    const configuredProviders = getConfiguredProviders();
    const { getProviderSnapshots } = await import("../services/inference-router");
    const snapshots = await getProviderSnapshots().catch(() => ({}));
    // Pass snapshots so ranking uses the same live probes (avoids double-probe).
    const ranked = await scoreModelsForPhase(phase, { configuredProviders, snapshots });

    // ScoredModel already includes the best `provider` selected by the live scorer.
    res.json({
      phase,
      ranked: ranked.map((s) => ({
        nimModelId: s.model.nimModelId,
        displayName: s.model.displayName,
        provider: s.provider,
        latencyMs: s.latencyMs,
        score: Math.round(s.score * 1000) / 1000,
        qualityComponent: Math.round(s.qualityComponent * 1000) / 1000,
        costComponent: Math.round(s.costComponent * 1000) / 1000,
        throughputComponent: Math.round(s.throughputComponent * 1000) / 1000,
        sweBenchScore: s.model.sweBenchScore ?? null,
        throughputClass: s.model.throughputClass ?? null,
      })),
    });
  } catch (err) {
    logger.error({ err, sessionId }, "Failed to compute inference ranking");
    res.status(500).json({ error: "Failed to compute ranking" });
  }
});

// ── End inference routing ──────────────────────────────────────────────────────

// In-memory store keyed by session ID. Messages for a session are evicted when
// the session is destroyed (not strictly necessary but keeps memory tidy).
const softInterruptQueues = new Map<number, SoftInterruptMessage[]>();

// SSE subscriber sets keyed by session ID.
const softInterruptSseSubscribers = new Map<number, Set<(msg: SoftInterruptMessage) => void>>();

function getSoftInterruptMessages(sessionId: number): SoftInterruptMessage[] {
  return softInterruptQueues.get(sessionId) ?? [];
}

function broadcastSoftInterruptUpdate(sessionId: number, msg: SoftInterruptMessage) {
  const subs = softInterruptSseSubscribers.get(sessionId);
  if (!subs || subs.size === 0) return;
  for (const cb of subs) {
    try { cb(msg); } catch { /* ignore broken pipe */ }
  }
}

// POST /sessions/:sessionId/messages
// Accept a user message mid-stream. Stored as "queued" immediately so the
// dashboard can render the badge before the runtime acknowledges it.
router.post("/sessions/:sessionId/messages", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const { text } = req.body as { text?: string };
  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text (non-empty string) is required" });
    return;
  }

  const [session] = await db
    .select({ status: sessionsTable.status })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const msg: SoftInterruptMessage = {
    id: randomBytes(8).toString("hex"),
    sessionId,
    text: text.trim().slice(0, 4000),
    state: "queued",
    sentAt: Date.now(),
    injectedAt: null,
  };

  if (!softInterruptQueues.has(sessionId)) {
    softInterruptQueues.set(sessionId, []);
  }
  softInterruptQueues.get(sessionId)!.push(msg);

  broadcastSoftInterruptUpdate(sessionId, msg);

  logger.info({ sessionId, msgId: msg.id }, "Soft-interrupt message queued");
  res.status(201).json(msg);
});

// GET /sessions/:sessionId/messages
// Return all messages for this session in send order.
router.get("/sessions/:sessionId/messages", (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }
  res.json(getSoftInterruptMessages(sessionId));
});

// POST /sessions/:sessionId/messages/:msgId/injected
// Called by the Claw Runner (or any authorised caller) when it drains the
// soft-interrupt queue and injects the message into the conversation history.
// Validates the same CALLBACK_TOKEN bearer used by /status and /routing-stats.
router.post("/sessions/:sessionId/messages/:msgId/injected", (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  const msgId = req.params["msgId"] ?? "";
  if (isNaN(sessionId) || !msgId) {
    res.status(400).json({ error: "Invalid sessionId or msgId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId, msgId }, "Messages /injected callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const queue = softInterruptQueues.get(sessionId);
  const msg = queue?.find((m) => m.id === msgId);
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  if (msg.state === "sent") {
    res.json(msg);
    return;
  }

  msg.state = "sent";
  msg.injectedAt = Date.now();
  broadcastSoftInterruptUpdate(sessionId, msg);

  logger.info({ sessionId, msgId }, "Soft-interrupt message marked injected");
  res.json(msg);
});

// GET /sessions/:sessionId/messages/stream
// SSE stream that pushes SoftInterruptMessage objects whenever their state changes.
// Clients subscribe on page load and receive immediate snapshot + live updates.
router.get("/sessions/:sessionId/messages/stream", (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send current snapshot so the client doesn't have to poll on connect.
  const existing = getSoftInterruptMessages(sessionId);
  if (existing.length > 0) {
    res.write(`data: ${JSON.stringify({ type: "snapshot", messages: existing })}\n\n`);
  }

  const keepAlive = setInterval(() => { res.write(": ping\n\n"); }, 20000);

  const cb = (msg: SoftInterruptMessage) => {
    res.write(`data: ${JSON.stringify({ type: "update", message: msg })}\n\n`);
  };

  if (!softInterruptSseSubscribers.has(sessionId)) {
    softInterruptSseSubscribers.set(sessionId, new Set());
  }
  softInterruptSseSubscribers.get(sessionId)!.add(cb);

  req.on("close", () => {
    clearInterval(keepAlive);
    const subs = softInterruptSseSubscribers.get(sessionId);
    if (subs) {
      subs.delete(cb);
      if (subs.size === 0) softInterruptSseSubscribers.delete(sessionId);
    }
  });
});


// ─── Provisioning endpoints ──────────────────────────────────────────────────

export async function cleanupSessionResources(sessionId: number): Promise<void> {
  try {
    const resources = await db
      .select()
      .from(provisionedResourcesTable)
      .where(
        and(
          eq(provisionedResourcesTable.sessionId, sessionId),
          isNull(provisionedResourcesTable.deletedAt)
        )
      );

    for (const resource of resources) {
      if (resource.type === "postgres" || resource.type === "postgres-branch") {
        if (resource.resourceId) {
          if (resource.resourceId.startsWith("local:")) {
            // Ephemeral Postgres: resourceId = "local:<pgDir>:<pgPort>"
            // Stop the server and remove the data directory.
            const parts = resource.resourceId.split(":");
            const pgDir  = parts[1] ?? "";
            const pgPort = parts[2] ?? "";
            const ws = getBridge(sessionId, 0);
            if (ws && ws.readyState === ws.OPEN && pgDir) {
              try {
                const stopCmd = pgDir
                  ? `pg_ctl -D "${pgDir}" stop -m fast 2>/dev/null || true` +
                    (pgPort ? ` && rm -rf "${pgDir}" 2>/dev/null || true` : "")
                  : "";
                if (stopCmd) ws.send(JSON.stringify({ type: "shell", cmd: stopCmd }));
              } catch {
                logger.warn({ sessionId, pgDir, pgPort }, "Failed to send pg_ctl stop via bridge (non-fatal)");
              }
            }
          } else if (resource.resourceId.startsWith("mizi_test_")) {
            // Legacy format (DB only, no dedicated server) — drop the database.
            const ws = getBridge(sessionId, 0);
            if (ws && ws.readyState === ws.OPEN) {
              try {
                ws.send(JSON.stringify({ type: "shell", cmd: `dropdb -U postgres --if-exists "${resource.resourceId}" 2>/dev/null || true` }));
              } catch {
                logger.warn({ sessionId, dbName: resource.resourceId }, "Failed to send dropdb via bridge (non-fatal)");
              }
            }
          } else {
            // Neon branch ID (starts with "br-") — delete via API.
            neonService.deleteBranch(resource.resourceId).catch((err: unknown) => {
              logger.warn({ err, resourceId: resource.resourceId, sessionId }, "Failed to delete Neon branch (non-fatal)");
            });
          }
        }
      } else if (resource.type === "redis") {
        // resourceId is stored as "pid:port" — extract PID from the first segment
        const pid = resource.resourceId ? parseInt(resource.resourceId.split(":")[0] ?? "") : NaN;
        if (!isNaN(pid) && pid > 0) {
          const ws = getBridge(sessionId, 0);
          if (ws && ws.readyState === ws.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "shell", cmd: `kill -TERM ${pid} 2>/dev/null || true` }));
            } catch {
              logger.warn({ sessionId, pid }, "Failed to send Redis kill via bridge (non-fatal)");
            }
          }
        }
      }
    }

    // Mark each resource as deleted individually (after cleanup action is dispatched for it).
    // Best-effort bridge sends are logged but still result in deleted_at being set — the bridge
    // fire-and-forget is inherently at-most-once; recording the attempt is the right granularity.
    for (const resource of resources) {
      await db
        .update(provisionedResourcesTable)
        .set({ deletedAt: new Date() })
        .where(eq(provisionedResourcesTable.id, resource.id));
    }

    if (resources.length > 0) {
      logger.info({ sessionId, count: resources.length }, "Cleaned up provisioned resources");
    }
  } catch (err) {
    logger.warn({ err, sessionId }, "cleanupSessionResources failed (non-fatal)");
  }
}

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

  if (!type || !["postgres", "postgres-branch", "redis"].includes(type)) {
    res.status(400).json({ error: "type must be 'postgres', 'postgres-branch', or 'redis'" });
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
  }
});

// ─── File Tree API ────────────────────────────────────────────────────────────
//
// These three endpoints let the dashboard browse and edit files in the session
// container without a full code-server IDE.  All operations are forwarded to
// the container via the bridge exec channel.
//
// Auth: mirrors swarm-stream / swarm-abort:
//   - GET endpoints: ?token=<ownerToken> or any valid team-member password
//   - PUT endpoint:  Authorization: Bearer <ownerToken> (owner-only write gate)

const FILE_SIZE_LIMIT_BYTES = 512 * 1024; // 500 KB read guard

// WORKSPACE_ROOT is the only allowed directory root for file operations.
// Paths that do not start with this prefix are rejected as out-of-scope.
const WORKSPACE_ROOT = "/workspace";

/**
 * Verify a caller-supplied token against the session's ownerToken and, for
 * read access, team-member passwords.  Returns the authorization level or
 * throws with code 401/403/404.
 */
async function verifyFileToken(
  sessionId: number,
  providedToken: string,
  writeRequired = false,
): Promise<void> {
  if (!providedToken) {
    throw Object.assign(new Error("token query parameter is required"), { code: 401 });
  }

  const [sessionAuth] = await db
    .select({ ownerToken: sessionsTable.ownerToken, teamMembers: sessionsTable.teamMembers })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!sessionAuth) {
    throw Object.assign(new Error("Session not found"), { code: 404 });
  }

  const isOwner = !!sessionAuth.ownerToken && providedToken === sessionAuth.ownerToken;
  if (writeRequired && !isOwner) {
    throw Object.assign(new Error("Forbidden: owner token required for write operations"), { code: 403 });
  }

  const memberPasswords = (sessionAuth.teamMembers as TeamMemberRecord[] | null ?? []).map((m) => m.password).filter(Boolean);
  const isMember = memberPasswords.some((pw) => pw === providedToken);

  if (!isOwner && !isMember) {
    throw Object.assign(new Error("Forbidden: valid owner token or member password required"), { code: 403 });
  }
}

/**
 * Validate that a path is safe: no traversal components, absolute, and
 * strictly within /workspace.
 */
function validateWorkspacePath(rawPath: string): void {
  if (!rawPath || rawPath.includes("..") || !rawPath.startsWith("/")) {
    throw Object.assign(new Error("Invalid path"), { code: 400 });
  }
  const normalized = rawPath.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(WORKSPACE_ROOT + "/")) {
    throw Object.assign(new Error("Path must be within /workspace"), { code: 400 });
  }
}

/**
 * Dispatch a shell command via the first available bridge for the session and
 * collect the full stdout.  Returns the raw stdout string, or throws with a
 * human-readable error if the bridge is unavailable or the exec fails.
 *
 * Uses the centralized per-lane exec lock from bridge-registry so that
 * file-tree operations and the bridge exec SSE route are fully serialised on
 * the same WebSocket — preventing message-frame cross-talk between concurrent
 * callers on the same lane.
 *
 * Timeout defaults to 15 s — long enough for large `ls` trees, short enough
 * to fail fast when the container is unreachable.
 */
async function execViaBridge(
  sessionId: number,
  command: string,
  timeoutMs = 15_000,
): Promise<string> {
  const bridge = getBridgeForSession(sessionId);
  if (!bridge) {
    throw Object.assign(new Error("Bridge not connected — session container is unreachable"), { code: 503 });
  }

  const { ws, laneId } = bridge;

  // Acquire the shared per-lane exec lock (also held by the bridge exec SSE
  // route) to prevent concurrent frame delivery on the same socket.
  if (!tryAcquireExecLock(sessionId, laneId)) {
    throw Object.assign(new Error("Another exec is already in progress for this lane — please retry in a moment"), { code: 409 });
  }

  try {
    return await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      let settled = false;

      const tid = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.off("message", onMessage);
        reject(Object.assign(new Error("Bridge exec timed out"), { code: 504 }));
      }, timeoutMs);

      function onMessage(raw: import("ws").RawData) {
        let frame: { type: string; [k: string]: unknown };
        try {
          frame = JSON.parse(raw.toString()) as { type: string; [k: string]: unknown };
        } catch {
          return;
        }
        if (frame.type === "output" || frame.type === "chunk") {
          chunks.push(String(frame["text"] ?? frame["content"] ?? ""));
        }
        if (frame.type === "done") {
          if (settled) return;
          settled = true;
          clearTimeout(tid);
          ws.off("message", onMessage);
          resolve(chunks.join(""));
        }
        if (frame.type === "error") {
          if (settled) return;
          settled = true;
          clearTimeout(tid);
          ws.off("message", onMessage);
          const msg = String(frame["message"] ?? "Bridge exec error");
          reject(Object.assign(new Error(msg), { code: 502 }));
        }
      }

      ws.on("message", onMessage);

      const execMsg = JSON.stringify({ type: "exec", prompt: command });
      ws.send(execMsg, (err) => {
        if (err) {
          if (settled) return;
          settled = true;
          clearTimeout(tid);
          ws.off("message", onMessage);
          reject(Object.assign(new Error("Failed to send command to bridge"), { code: 502 }));
        }
      });
    });
  } finally {
    releaseExecLock(sessionId, laneId);
  }
}

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

export default router;
