import { Router } from "express";
import { db, sessionsTable, gpuProfilesTable, templatesTable } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import { getProfileById } from "../services/profiles";
import * as vastai from "../services/vastai";
import type { VastOffer } from "../services/vastai";
import { logger } from "../lib/logger";
import { listObservations, listSessions, searchMemory, subscribeToObservations } from "../services/memory";
import type { TeamMemberRecord } from "@workspace/db";

import { randomBytes } from "crypto";

function generatePassword(length = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = randomBytes(length);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

const router = Router();

const ACTIVE_STATUSES = ["pending", "provisioning", "downloading", "starting", "ready"];

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
    const totalCost = session.costPerHour ? Math.round(session.costPerHour * hoursRunning * 100) / 100 : 0;

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
        totalCost,
        teamMembers: updatedTeamMembers,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, session.id))
      .returning();

    return updated;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "Failed to auto-sync session from Vast.ai");
    return session;
  }
}

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
    })
    .from(sessionsTable)
    .leftJoin(gpuProfilesTable, eq(sessionsTable.profileId, gpuProfilesTable.id))
    .orderBy(desc(sessionsTable.createdAt));

  // Redact passwords from list response — full credentials are only on the detail endpoint
  const sanitized = sessions.map((s) => ({
    ...s,
    teamMembers: s.teamMembers
      ? (s.teamMembers as TeamMemberRecord[]).map(({ password: _pw, ...rest }) => rest)
      : null,
  }));

  res.json(sanitized);
});

router.get("/sessions/active", async (_req, res) => {
  const [rawSession] = await db
    .select()
    .from(sessionsTable)
    .where(inArray(sessionsTable.status, ACTIVE_STATUSES))
    .orderBy(desc(sessionsTable.createdAt))
    .limit(1);

  if (!rawSession) {
    res.json({ session: null });
    return;
  }

  const synced = await syncSessionFromVastai(rawSession);
  const [profile] = await db
    .select({ displayName: gpuProfilesTable.displayName })
    .from(gpuProfilesTable)
    .where(eq(gpuProfilesTable.id, synced.profileId));

  res.json({ session: { ...synced, profileName: profile?.displayName || "" } });
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
    .select({ displayName: gpuProfilesTable.displayName })
    .from(gpuProfilesTable)
    .where(eq(gpuProfilesTable.id, synced.profileId));

  res.json({ ...synced, profileName: profile?.displayName || "" });
});

router.post("/sessions", async (req, res) => {
  const { profileId, offerId, teamMembers: teamMemberNames } = req.body;

  if (!profileId) {
    res.status(400).json({ error: "profileId is required" });
    return;
  }

  const profile = await getProfileById(profileId);
  if (!profile) {
    res.status(400).json({ error: "Invalid profile" });
    return;
  }

  let insertedSessionId: number | undefined;

  try {
    let selectedOfferId = offerId;

    if (!selectedOfferId) {
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

    // Build team member records (up to 4 named members + 1 shared workspace)
    const rawNames: string[] = Array.isArray(teamMemberNames)
      ? teamMemberNames.slice(0, 4).map(String).filter(n => n.trim())
      : [];
    const teamMemberRecords: TeamMemberRecord[] = rawNames.length > 0
      ? [
          ...rawNames.map((name) => ({
            name: name.trim(),
            password: generatePassword(),
            path: `/ide/${name.trim()}/`,
            ideUrl: null,
          })),
          {
            name: "__shared__",
            password: generatePassword(),
            path: "/shared/",
            ideUrl: null,
          },
        ]
      : [];

    logger.info({ profileId, selectedOfferId, teamMemberCount: teamMemberRecords.length }, "Launching session — model will download on instance startup");

    const [session] = await db
      .insert(sessionsTable)
      .values({
        profileId: profile.id,
        vastOfferId: selectedOfferId,
        templateHash: templateHash || null,
        status: "provisioning",
        statusMessage: "Finding GPU and provisioning instance...",
        gpuName: profile.gpuName,
        numGpus: profile.numGpus,
        teamMembers: teamMemberRecords.length > 0 ? teamMemberRecords : null,
      })
      .returning();

    insertedSessionId = session.id;

    const MODEL_REPO = profile.modelRepo;
    const MODEL_QUANT = profile.defaultQuant;
    const SERVED_MODEL_NAME = profile.servedModelName;

    const memProxyUrl = process.env["OMNIQL_MEM_PROXY_URL"]
      || (process.env["REPLIT_DEV_DOMAIN"]
        ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
        : undefined);

    const memUserId = process.env["OMNIQL_MEM_USER_ID"] || "operator";

    const onstart = vastai.buildOnStartScript({
      modelRepo: MODEL_REPO,
      modelQuant: MODEL_QUANT,
      servedModelName: SERVED_MODEL_NAME,
      llamaCtxSize: profile.llamaCtxSize,
      llamaBatchSize: profile.llamaBatchSize,
      llamaExtraArgs: profile.llamaExtraArgs || "",
      numGpus: profile.numGpus,
      memProxyUrl,
      memAuthToken: process.env["OMNIQL_MEM_TOKEN"],
      memUserId,
      teamMembers: teamMemberRecords,
    });

    const result = await vastai.createInstance({
      offerId: selectedOfferId,
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

    const instanceId = result.new_contract;

    const [updated] = await db
      .update(sessionsTable)
      .set({
        vastInstanceId: instanceId,
        status: "provisioning",
        statusMessage: "Instance created — waiting for startup and model download...",
        startedAt: new Date(),
        costPerHour: result.expected_price || null,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, session.id))
      .returning();

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

  if (!session.vastInstanceId) {
    res.json({ ...session, profileName: "" });
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

    const [profile] = await db.select().from(gpuProfilesTable).where(eq(gpuProfilesTable.id, session.profileId));

    res.json({
      ...updated,
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
    if (session.vastInstanceId) {
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
      ...updated,
      profileName: profile?.displayName || "",
    });
  } catch (err: unknown) {
    logger.error(err, "Failed to destroy session");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to destroy session: ${message}` });
  }
});

const MEM_USER_ID = process.env["OMNIQL_MEM_USER_ID"] || "operator";

// Dashboard memory proxy — these routes exist so the dashboard can fetch
// operator-scoped memory without needing the OMNIQL_MEM_TOKEN bearer header.
// OmniQL is a single-operator platform: all sessions share one userId
// (OMNIQL_MEM_USER_ID, default "operator") for cross-session memory continuity.
// The :sessionId path parameter identifies the Vast.ai/OmniQL session for
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

router.get("/sessions/:sessionId/memory/sessions", (_req, res) => {
  const limit = 30;
  try {
    const sessions = listSessions(MEM_USER_ID, limit, 0);
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
  if (!q.trim()) {
    res.json({ observations: [], sessions: [] });
    return;
  }
  try {
    const results = searchMemory(MEM_USER_ID, q);
    res.json(results);
  } catch (err) {
    logger.error(err, "Failed to search memory for dashboard");
    res.status(500).json({ error: "Failed to search memory" });
  }
});

router.get("/memory/search", (req, res) => {
  const q = (req.query["q"] as string | undefined) || "";
  if (!q.trim()) {
    res.json({ observations: [], sessions: [] });
    return;
  }
  try {
    const results = searchMemory(MEM_USER_ID, q);
    res.json(results);
  } catch (err) {
    logger.error(err, "Failed to search global memory for dashboard");
    res.status(500).json({ error: "Failed to search memory" });
  }
});

router.get("/memory/sessions", (_req, res) => {
  try {
    const sessions = listSessions(MEM_USER_ID, 100, 0);
    res.json(sessions);
  } catch (err) {
    logger.error(err, "Failed to list all memory sessions for dashboard");
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

export default router;
