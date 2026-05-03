import { Router, type RequestHandler } from "express";
import { db, sessionsTable, gpuProfilesTable, templatesTable, skillBundlesTable } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import { getProfileById } from "../services/profiles";
import * as vastai from "../services/vastai";
import type { VastOffer } from "../services/vastai";
import { logger } from "../lib/logger";
import { listObservations, listSessions, searchMemory, subscribeToObservations, backupDb, restoreDb, addObservation, addSummary, getGovernanceStats, runStaleSweep, bulkUpdateStaleItems, getReviewNeededCount, listStaleItems, listConflicts } from "../services/memory";
import fs from "fs";
import type { TeamMemberRecord, SessionRoutingStats } from "@workspace/db";
import { compileBundle, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext, seedDefaultBundles, getRepoIntelligenceForSession } from "../services/skills-bundler";
import type { SessionContext } from "../services/skills-types";
import { autoEnqueueRepoIndexIfNeeded } from "./repo";

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

  const [prevSession] = await db.select({ status: sessionsTable.status }).from(sessionsTable).where(eq(sessionsTable.id, sessionId));

  await db
    .update(sessionsTable)
    .set({ status: mapped.status, statusMessage, updatedAt: new Date() })
    .where(eq(sessionsTable.id, sessionId));

  if (mapped.status === "ready" && prevSession?.status !== "ready") {
    autoEnqueueRepoIndexIfNeeded(sessionId).catch(() => {});
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

  res.json({ ...synced, profileName: profile?.displayName || "", swarmWorkerCap: profile?.swarmWorkerCap ?? null });
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
      const memUserId = process.env["OMNIQL_MEM_USER_ID"] || "operator";
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

router.post("/sessions", async (req, res) => {
  const { profileId, offerId, teamMembers: teamMemberNames, taskMode, tokenMode, bundleId: requestedBundleId, repoUrl, repoBranch, repoFingerprint, intentText: rawIntentText } = req.body;

  // Sanitize and bound the natural-language session intent (optional).
  let intentText: string | null = null;
  if (typeof rawIntentText === "string") {
    const trimmed = rawIntentText.trim();
    if (trimmed.length > 0) {
      intentText = trimmed.slice(0, 500);
    }
  }

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
        intentText,
        // Owner token: a random secret issued at session creation. Required by
        // the dashboard to call owner-only endpoints (e.g. swarm abort). Not a
        // team-member credential — team members use their own name+password.
        ownerToken: generatePassword(32),
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
        intentText: intentText || undefined,
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
      swarmWorkerCap: profile.swarmWorkerCap,
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

    // ownerToken is a bearer secret — expose only via GET /sessions/:id detail.
    // The creation response goes to the dashboard which will redirect to the detail page.
    res.status(201).json({
      ...redactOwnerToken(updated),
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
      ...redactOwnerToken(updated),
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

router.post("/memory/restore", (req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
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
    logger.error(err, "Error reading restore upload body");
    res.status(500).json({ error: "Failed to read uploaded file" });
  });
});

// ── Routing stats endpoints ──────────────────────────────────────────────────
// POST /sessions/:sessionId/routing-stats
// Called by the claw-runner (via callbackBaseUrl) when context-shield stats are
// available. Stores the latest routing stats on the session row so the dashboard
// can read them and pass bytesAvoided to the complete-feedback endpoint.
router.post("/sessions/:sessionId/routing-stats", async (req, res) => {
  const sessionId = parseInt(req.params["sessionId"] ?? "", 10);
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
  const sessionId = parseInt(req.params["sessionId"] ?? "", 10);
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
// on OMNIQL_CALLBACK_URL, so it always POSTs to /swarm-status rather than
// /swarm-push.  Registering both routes here ensures snapshots are never silently
// dropped without requiring an external proxy rewrite.
//
// GET /sessions/:id/swarm-status (below) is the dashboard reader and is unaffected
// — Express matches routes by method, so the GET and POST on the same path coexist.
const handleSwarmPush: RequestHandler = async (req, res) => {
  const sessionId = parseInt(req.params["sessionId"] ?? "", 10);
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
  res.json({ ok: true });
};

// POST /sessions/:sessionId/swarm-push — canonical swarm snapshot receiver.
router.post("/sessions/:sessionId/swarm-push", handleSwarmPush);

// POST /sessions/:sessionId/swarm-status — alias used by the Claw Runner.
// The runner replaces /status with /swarm-status on OMNIQL_CALLBACK_URL, so
// without this alias every runner snapshot would 404 and be silently dropped.
router.post("/sessions/:sessionId/swarm-status", handleSwarmPush);

// GET /sessions/:sessionId/swarm-status — cockpit polls this every 3 seconds.
// Returns one of four availability states:
//   "live"        — in-memory cache is fresh (received within STALE_THRESHOLD_MS)
//   "stale"       — snapshot exists but cache is old (runner may be unreachable)
//   "starting"    — session not yet ready, runner hasn't started pushing
//   "unavailable" — no snapshot has ever been received for this session
router.get("/sessions/:sessionId/swarm-status", async (req, res) => {
  const sessionId = parseInt(req.params["sessionId"] ?? "", 10);
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
  const sessionId = parseInt(req.params["sessionId"] ?? "", 10);
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
  const sessionId = parseInt(req.params["sessionId"] ?? "", 10);
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

export default router;
