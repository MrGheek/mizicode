import { Router } from "express";
import { db, sessionsTable, gpuProfilesTable, templatesTable, skillBundlesTable } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import { getProfileById } from "../services/profiles";
import * as vastai from "../services/vastai";
import type { VastOffer } from "../services/vastai";
import { logger } from "../lib/logger";
import { listObservations, listSessions, searchMemory, subscribeToObservations } from "../services/memory";
import type { TeamMemberRecord } from "@workspace/db";
import { compileBundle, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext, seedDefaultBundles, getRepoIntelligenceForSession } from "../services/skills-bundler";
import type { SessionContext } from "../services/skills-types";

import { randomBytes } from "crypto";

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

    return updated;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "Failed to auto-sync session from Vast.ai");
    return session;
  }
}

// ─── Instance callback: the running instance POSTs its phase transitions here ──
// Replaces the unreliable server-side probe (Vast.ai firewall blocks server→instance).
const CALLBACK_TOKEN = process.env["OMNIQL_MEM_TOKEN"] || "";

const INSTANCE_STATUS_MAP: Record<string, { status: typeof sessionsTable.$inferSelect["status"]; statusMessage: string }> = {
  services_ready:   { status: "starting",    statusMessage: "Tools ready — LLM model loading in background..." },
  downloading:      { status: "downloading", statusMessage: "Downloading model weights..." },
  starting_llm:     { status: "starting",    statusMessage: "Loading model into GPU memory..." },
  skills_compiling: { status: "starting",    statusMessage: "Compiling Smart Skills bundle..." },
  skills_ready:     { status: "starting",    statusMessage: "Smart Skills loaded — LLM loading in background..." },
  llm_ready:        { status: "ready",       statusMessage: "Session is ready — vLLM online" },
};

router.post("/sessions/:sessionId/status", async (req, res) => {
  const sessionId = Number(req.params["sessionId"]);
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  // Validate Bearer token when OMNIQL_MEM_TOKEN is configured.
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

  const statusMessage = (message?.trim()) || mapped.statusMessage;

  logger.info({ sessionId, instanceStatus, dbStatus: mapped.status, statusMessage }, "Instance status callback received");

  await db
    .update(sessionsTable)
    .set({ status: mapped.status, statusMessage, updatedAt: new Date() })
    .where(eq(sessionsTable.id, sessionId));

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

  // Redact passwords (only /sessions/:id detail endpoint exposes them)
  const sanitizedMembers = synced.teamMembers
    ? (synced.teamMembers as TeamMemberRecord[]).map(({ password: _pw, ...rest }) => rest)
    : null;

  res.json({ session: { ...synced, teamMembers: sanitizedMembers, profileName: profile?.displayName || "" } });
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
  const { profileId, offerId, teamMembers: teamMemberNames, taskMode, tokenMode, bundleId: requestedBundleId, repoUrl, repoBranch, repoFingerprint } = req.body;

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
        statusMessage: "Finding GPU and provisioning instance...",
        gpuName: profile.gpuName,
        numGpus: profile.numGpus,
        teamMembers: teamMemberRecords.length > 0 ? teamMemberRecords : null,
        taskMode: resolvedTaskMode,
        tokenMode: resolvedTokenMode,
        activeBundleId: requestedBundleId || null,
        repoFingerprintJson,
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
      };

      let bundle: typeof skillBundlesTable.$inferSelect | null = null;
      if (requestedBundleId) {
        const [found] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, requestedBundleId));
        bundle = found || null;
      }
      if (!bundle) {
        // Pass hasRepoContext so floatr-builder is forced when no repo URL was supplied
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
      sessionId: insertedSessionId,
      callbackBaseUrl,
      activeBundleB64,
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
