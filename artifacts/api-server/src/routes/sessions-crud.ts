import { Router } from "express";
import { db, sessionsTable, gpuProfilesTable, templatesTable, skillBundlesTable, sessionLanesTable, provisionedResourcesTable, projectPlansTable } from "@workspace/db";
import { eq, desc, inArray, and, isNull, notLike, sql } from "drizzle-orm";
import type { TeamMemberRecord } from "@workspace/db";
import { logger } from "../lib/logger";
import * as vastai from "../services/vastai";
import type { VastOffer } from "../services/vastai";
import { getProfileById, getNimWorkspaceProfile } from "../services/profiles";
import { getStoredGitHubToken } from "./auth";
import { autoEnqueueRepoIndexIfNeeded } from "./repo";
import { requireAgentAuth, permitBearer } from "../middlewares/agent-auth";
import { encryptConnectionString, decryptConnectionString, maskConnectionString } from "../lib/encrypt";
import { compileBundle, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext, seedDefaultBundles, getRepoIntelligenceForSession } from "../services/skills-bundler";
import type { SessionContext } from "../services/skills-types";
import * as neonService from "../services/neon";
import * as fly from "../services/fly";
import { addObservation } from "../services/memory";
import {
  ACTIVE_STATUSES,
  CALLBACK_TOKEN,
  CALLBACK_IS_PROD,
  FAILURE_DEFAULT_MESSAGES,
  INSTANCE_STATUS_MAP,
  buildFailureStatusMessage,
  redactOwnerToken,
  generatePassword,
  sanitizeMemberName,
  syncSessionFromVastai,
  cleanupSessionResources,
  evictWorkspaceProxy,
  RESERVED_NAMES,
  SAFE_NAME_RE,
  SwarmSnapshot,
  swarmCache,
  STALE_THRESHOLD_MS,
  planCache,
  PLAN_STALE_THRESHOLD_MS,
} from "./sessions-common";

const router = Router();

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

  const { status: instanceStatus, message, theiaUrl } = req.body as { status?: string; message?: string; theiaUrl?: string };
  if (!instanceStatus) {
    res.status(400).json({ error: "Missing status field" });
    return;
  }

  const mapped = INSTANCE_STATUS_MAP[instanceStatus];
  if (!mapped) {
    res.status(400).json({ error: `Unknown status: ${instanceStatus}` });
    return;
  }

  // Fetch the current session early — needed for both the NIM llm_ready
  // override below and the post-ready side-effects further down.
  const [prevSession] = await db
    .select({ status: sessionsTable.status, provider: sessionsTable.provider })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  // For NIM sessions, `llm_ready` means "NIM proxy is up" but Theia's
  // frontend assets may not be served yet. Keep the session in "starting"
  // state until `theia_ready` is received.
  const effectiveMapped =
    instanceStatus === "llm_ready" && prevSession?.provider === "nim"
      ? { status: "starting" as const, statusMessage: "Waiting for Theia to start..." }
      : mapped;

  // For failure phases, ALWAYS rebuild the message so the
  // `boot_failure:<cause>: ` marker survives even when onstart.sh supplies
  // its own human-readable message text. Without this, the dashboard's
  // parseBootFailure() classifier loses the structured cause and the
  // suggested-next-step UX silently regresses.
  //
  // For non-failure phases, always use the mapped statusMessage — the raw
  // `message` field sent by onstart.sh is an internal log string (e.g.
  // "Starting NIM proxy...") that is NOT intended for user display. The
  // INSTANCE_STATUS_MAP values are the canonical user-facing copy.
  const isFailurePhase = instanceStatus in FAILURE_DEFAULT_MESSAGES;
  const statusMessage = isFailurePhase
    ? buildFailureStatusMessage(instanceStatus, message)
    : effectiveMapped.statusMessage;

  logger.info({ sessionId, instanceStatus, dbStatus: effectiveMapped.status, statusMessage }, "Instance status callback received");

  await db
    .update(sessionsTable)
    .set({
      status: effectiveMapped.status,
      statusMessage,
      ...(theiaUrl ? { theiaUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(sessionsTable.id, sessionId));

  if (effectiveMapped.status === "ready" && prevSession?.status !== "ready") {
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
    (effectiveMapped.status === "error" && prevSession?.status !== "error") ||
    (effectiveMapped.status === "stopped" && prevSession?.status !== "stopped")
  ) {
    cleanupSessionResources(sessionId).catch(() => {});
  }

  // Post-session plan reassessment: fire-and-forget when a session stops.
  // Retrieves the session's linked plan_id and re-evaluates task statuses
  // against memory observations. Skips user-confirmed tasks.
  if (effectiveMapped.status === "stopped" && prevSession?.status !== "stopped") {
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
      theiaUrl: sessionsTable.theiaUrl,
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
      // Evict stale proxy entry so we don't hold lingering TCP connections to a
      // machine that no longer exists (machine gone in both the success and 404 path).
      evictWorkspaceProxy(session.flyMachineId);
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
  // ── Local distribution provider path ──────────────────────────────────────
  // When MIZI_DISTRIBUTION=local, ALL sessions use the local SQLite provider.
  // localModelId is optional — if absent we fall back to a sensible default
  // model (qwen2.5-coder:7b or whatever was last pulled into Ollama).
  // Cloud-specific body params (profileId, nimModelId, offerId) are ignored.
  if (process.env.MIZI_DISTRIBUTION === "local") {
    const rawModelId = typeof req.body.localModelId === "string" && req.body.localModelId.trim()
      ? req.body.localModelId.trim()
      : typeof req.body.nimModelId === "string" && req.body.nimModelId.trim()
        ? req.body.nimModelId.trim()  // allow nimModelId as a fallback for compatibility
        : "qwen2.5-coder:7b";        // sensible default if nothing is specified
    try {
      const { createLocalSessionRecord, startLocalSession } = await import("../services/local.js");
      const record = await createLocalSessionRecord({
        modelId: rawModelId,
        intentText: typeof req.body.intentText === "string" ? req.body.intentText.trim().slice(0, 500) : null,
        templateSlug: typeof req.body.templateSlug === "string" ? req.body.templateSlug : null,
        repoUrl: typeof req.body.repoUrl === "string" ? req.body.repoUrl.trim() : null,
      });
      await startLocalSession({ sessionId: record.id, modelId: rawModelId });
      res.status(201).json({
        id: record.id,
        provider: "local",
        status: record.status,
        ollamaEndpoint: record.ollamaEndpoint,
        localChatUrl: record.localChatUrl,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to create local session", detail: String(err) });
    }
    return;
  }

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

    // In production on Fly.io, FLY_APP_NAME is always present (injected by the
    // platform into every machine in the app). We use it as the final fallback so
    // NIM sessions — which run on Fly Machines — can reach the callback endpoint
    // at https://<app>.fly.dev/api/sessions/:id/status even when MIZI_MEM_PROXY_URL
    // and REPLIT_DEV_DOMAIN are both absent.
    const callbackBaseUrl = memProxyUrl
      || (process.env["FLY_APP_NAME"]
        ? `https://${process.env["FLY_APP_NAME"]}.fly.dev`
        : undefined);

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
    let provisionedWorkspaceUser: string | undefined;
    let provisionedWorkspacePassword: string | undefined;

    if (nimModelId) {
      // Generate nginx basic-auth credentials so the dashboard can display them.
      // Username is fixed; password is a random 16-char alphanumeric string.
      const nimWorkspaceUser = "mizi";
      const nimWorkspacePassword = Array.from(
        { length: 16 },
        () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[
          Math.floor(Math.random() * 62)
        ]
      ).join("");

      const flyResult = await fly.createMachine({
        image: profile.dockerImageTag,
        env: {
          MODEL_REPO,
          MODEL_QUANT,
          SERVED_MODEL_NAME,
          VLLM_MAX_MODEL_LEN: String(profile.llamaCtxSize),
          VLLM_MAX_NUM_SEQS: String(profile.llamaBatchSize),
          NUM_GPUS: String(profile.numGpus),
          // nim-proxy.py listens on VLLM_PORT (default 8081). Must be set here AND
          // exported by the generated onstart script so onstart.sh probes the right port.
          VLLM_PORT: "8081",
          // Fly.io exposes internal port 5180 as an HTTP service (fly.ts services config).
          // Override the onstart.sh default (5173) so bolt.diy binds on the exposed port.
          THEIA_PORT: "8788",
          // nginx basic-auth credentials — onstart.sh picks these up via
          // NGINX_AUTH_USER / NGINX_AUTH_PASS env vars.
          NGINX_AUTH_USER: nimWorkspaceUser,
          NGINX_AUTH_PASS: nimWorkspacePassword,
        },
        startCmd: onstart,
      });
      provisionedFlyMachineId = flyResult.machineId;
      provisionedWorkspaceUser = nimWorkspaceUser;
      provisionedWorkspacePassword = nimWorkspacePassword;
      // NIM inference is free (NVIDIA hosted APIs) or per-token (Vultr) — no hourly rate.
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
          ? "Fly.io workspace machine started — NIM fast-boot running (~60s)"
          : "Instance created — waiting for startup and model download...",
        startedAt: new Date(),
        costPerHour: provisionedCostPerHour ?? null,
        workspaceUser: provisionedWorkspaceUser ?? null,
        workspacePassword: provisionedWorkspacePassword ?? null,
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
        theiaUrl: urls.theiaUrl || session.theiaUrl,
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

export default router;
