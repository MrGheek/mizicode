import { db, schedulerConfigTable, sessionsTable, gpuProfilesTable, templatesTable } from "@workspace/db";
import type { TeamMemberRecord } from "@workspace/db";
import { inArray, desc, eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { logger } from "../lib/logger";
import * as vastai from "./vastai";
import { getProfileById } from "./profiles";
import type { VastOffer } from "./vastai";
import { seedCuratedSources, fetchCurrentHeadSha, getStoredCommitSha, isShaRateLimited } from "./curated-sources";
import { compileBundle, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext, seedDefaultBundles } from "./skills-bundler";
import type { SessionContext } from "./skills-types";

// ─── Credential helpers (mirrors sessions.ts) ────────────────────────────────

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

function buildTeamMemberRecords(rawNames: string[]): TeamMemberRecord[] {
  const sanitizedNames = [...new Set(
    rawNames.map(sanitizeMemberName).filter((n): n is string => n !== null)
  )].slice(0, 4);

  if (sanitizedNames.length === 0) return [];

  return [
    { name: "__shared__", password: generatePassword(), path: "/shared/", ideUrl: null },
    ...sanitizedNames.map((name) => ({
      name,
      password: generatePassword(),
      path: `/ide/${name}/`,
      ideUrl: null,
    })),
  ];
}

// ─── Design Sync Scheduler ───────────────────────────────────────────────────

const DEFAULT_DESIGN_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SHA_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function parseDesignSyncInterval(): number {
  const raw = process.env["DESIGN_SYNC_INTERVAL_MS"];
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DESIGN_SYNC_INTERVAL_MS;
}

interface DesignSyncStatus {
  lastSyncedAt: Date | null;
  lastAttemptedAt: Date | null;
  lastError: string | null;
  nextSyncAt: Date | null;
  intervalMs: number;
  isRunning: boolean;
}

const designSyncState: DesignSyncStatus = {
  lastSyncedAt: null,
  lastAttemptedAt: null,
  lastError: null,
  nextSyncAt: null,
  intervalMs: parseDesignSyncInterval(),
  isRunning: false,
};

export function getDesignSyncStatus(): DesignSyncStatus {
  return { ...designSyncState };
}

export async function triggerDesignSync(): Promise<{ success: boolean; reason: string }> {
  return runDesignSync();
}

export function markDesignSyncComplete(): void {
  designSyncState.lastSyncedAt = new Date();
  designSyncState.lastAttemptedAt = new Date();
  designSyncState.lastError = null;
}

async function runDesignSync(): Promise<{ success: boolean; reason: string }> {
  if (designSyncState.isRunning) {
    logger.warn("Design sync: previous run still in progress — skipping this interval tick");
    return { success: false, reason: "Sync already in progress" };
  }

  designSyncState.isRunning = true;
  designSyncState.lastAttemptedAt = new Date();
  logger.info("Design sync: starting re-sync of curated sources");

  try {
    const result = await seedCuratedSources();
    if (result.success) {
      designSyncState.lastSyncedAt = new Date();
      designSyncState.lastError = null;
      logger.info({ reason: result.reason, updated: result.updated }, "Design sync: completed successfully");
      return { success: true, reason: result.reason };
    } else {
      designSyncState.lastError = result.reason;
      logger.error({ reason: result.reason }, "Design sync: sync reported failure — lastSyncedAt not updated");
      return { success: false, reason: result.reason };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    designSyncState.lastError = message;
    logger.error({ err }, "Design sync: unexpected error during scheduled sync");
    return { success: false, reason: message };
  } finally {
    designSyncState.isRunning = false;
  }
}

/**
 * Lightweight job: polls GitHub for the HEAD SHA every 15 minutes.
 * Triggers a full ingest only when the SHA has changed since the last sync.
 * The 6-hour full-sync timer remains as an unconditional safety net.
 */
async function runShaCheckJob(): Promise<void> {
  if (designSyncState.isRunning) {
    logger.debug("SHA-check: full sync already in progress — skipping poll");
    return;
  }

  // Bail out early without hitting the network if we're inside a rate-limit cool-down.
  if (isShaRateLimited()) return;

  const remoteSha = await fetchCurrentHeadSha();
  if (!remoteSha) {
    // fetchCurrentHeadSha already logged the appropriate message (info for rate-limit, warn for other errors).
    return;
  }

  let storedSha: string | null;
  try {
    storedSha = await getStoredCommitSha();
  } catch (err) {
    logger.warn({ err }, "SHA-check: failed to read stored commit SHA");
    return;
  }

  if (remoteSha === storedSha) {
    logger.debug({ sha: remoteSha }, "SHA-check: no change detected — skipping full sync");
    return;
  }

  logger.info(
    { oldSha: storedSha ?? "none", newSha: remoteSha },
    "SHA-check: new commit detected — triggering immediate design sync",
  );
  void runDesignSync();
}

function startDesignSyncScheduler(): void {
  const intervalMs = designSyncState.intervalMs;
  designSyncState.nextSyncAt = new Date(Date.now() + intervalMs);

  // 6-hour safety-net: full sync regardless of SHA
  setInterval(() => {
    designSyncState.nextSyncAt = new Date(Date.now() + intervalMs);
    void runDesignSync();
  }, intervalMs);

  // 15-minute lightweight SHA-check: only syncs when a new commit is detected
  setInterval(() => void runShaCheckJob(), SHA_POLL_INTERVAL_MS);

  logger.info(
    { intervalMs, shaPollIntervalMs: SHA_POLL_INTERVAL_MS, nextSyncAt: designSyncState.nextSyncAt.toISOString() },
    "Design sync scheduler started (6-hour safety net + 15-minute SHA-check poll)",
  );
}

const ACTIVE_STATUSES = ["pending", "provisioning", "downloading", "starting", "ready"];

function getLocalHHMM(timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const hourRaw = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0");
  const hour = hourRaw % 24; // guard against "24" for midnight in some runtimes
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${String(hour).padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function getLocalDay(timezone: string): string {
  const dayFull = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date());
  return dayFull.toLowerCase().slice(0, 3); // "mon", "tue", etc.
}

function getLocalDateKey(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // "2024-01-15"
}

function addMinutesToTimeStr(timeStr: string, minutesToAdd: number): string {
  const [h, m] = timeStr.split(":").map(Number);
  const totalMinutes = h * 60 + m + minutesToAdd;
  const newHour = Math.floor(totalMinutes / 60) % 24;
  const newMinute = totalMinutes % 60;
  return `${String(newHour).padStart(2, "0")}:${String(newMinute).padStart(2, "0")}`;
}

async function getActiveSession() {
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(inArray(sessionsTable.status, ACTIVE_STATUSES))
    .orderBy(desc(sessionsTable.createdAt))
    .limit(1);
  return session || null;
}

async function deriveRepoFingerprint(repoUrl: string): Promise<{ langs: string[]; frameworks: string[]; urlHash: string }> {
  const { createHash } = await import("crypto");
  const trimmedUrl = repoUrl.trim();
  const urlHash = createHash("sha256").update(trimmedUrl.toLowerCase()).digest("hex").slice(0, 16);
  let langs: string[] = [];
  let frameworks: string[] = [];

  const ghMatch = trimmedUrl.match(/github\.com\/([^/]+)\/([^/.\s]+)/);
  if (ghMatch) {
    try {
      const [owner, repo] = [ghMatch[1], ghMatch[2]];
      const ghHeaders = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

      const langResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, {
        headers: ghHeaders,
        signal: AbortSignal.timeout(5000),
      });
      if (langResp.ok) {
        const data = await langResp.json() as Record<string, number>;
        langs = Object.keys(data).map(l => l.toLowerCase());
      }

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
      frameworks = [...new Set(frameworks)];
    } catch {
      // Non-blocking: ignore if GitHub API is unreachable
    }
  }

  return { langs, frameworks, urlHash };
}

async function launchScheduledSession(profileId: number, teamMemberNames: string[] = [], repoUrl?: string | null): Promise<void> {
  const profile = await getProfileById(profileId);
  if (!profile) {
    logger.warn({ profileId }, "Scheduler: profile not found, skipping launch");
    return;
  }

  const searchParams = (profile.searchParams as Record<string, unknown>) || {};

  const [defaultTemplate] = await db
    .select()
    .from(templatesTable)
    .where(eq(templatesTable.isDefault, true))
    .limit(1);

  const templateHash = defaultTemplate?.templateHash || undefined;

  const offers = await vastai.searchOffers({
    gpu_name: searchParams.gpu_name as string,
    num_gpus: searchParams.num_gpus as number,
    min_gpu_ram: searchParams.min_gpu_ram as number,
    disk_space: profile.diskSizeGb,
    limit: 1,
  });

  if (!offers || offers.length === 0) {
    logger.warn({ profileId }, "Scheduler: no GPU offers available, skipping launch");
    return;
  }

  const selectedOfferId = (offers[0] as VastOffer).id;

  // Build team member records from the scheduler-configured names (max 4)
  const teamMemberRecords = buildTeamMemberRecords(teamMemberNames);

  // Create the session row before launching so we have a sessionId for the boot script
  const [session] = await db
    .insert(sessionsTable)
    .values({
      profileId: profile.id,
      vastOfferId: selectedOfferId,
      templateHash: templateHash || null,
      status: "provisioning",
      statusMessage: "Auto-launched by scheduler — model download will begin.",
      gpuName: profile.gpuName,
      numGpus: profile.numGpus,
      teamMembers: teamMemberRecords.length > 0 ? teamMemberRecords : null,
      taskMode: teamMemberRecords.length > 0 ? "team" : "build",
      tokenMode: "core",
      ownerToken: generatePassword(32),
    })
    .returning();

  const insertedSessionId = session.id;

  try {
    const MODEL_REPO = profile.modelRepo;
    const MODEL_QUANT = profile.defaultQuant;
    const SERVED_MODEL_NAME = profile.servedModelName;

    // Resolve memory proxy and callback credentials (same logic as manual launch)
    const memProxyUrl = process.env["OMNIQL_MEM_PROXY_URL"]
      || (process.env["REPLIT_DEV_DOMAIN"]
        ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
        : undefined);

    const memUserId = process.env["OMNIQL_MEM_USER_ID"] || "operator";
    // Support both OMNIQL_MEM_AUTH_TOKEN (task contract) and OMNIQL_MEM_TOKEN (current manual launch name)
    const memAuthToken = process.env["OMNIQL_MEM_AUTH_TOKEN"] || process.env["OMNIQL_MEM_TOKEN"];
    const callbackBaseUrl = memProxyUrl;

    // Derive repo fingerprint from repoUrl (mirrors manual session launch logic)
    let repoFingerprintJson: Record<string, unknown> | null = null;
    let repoLangs: string[] = [];
    if (repoUrl && typeof repoUrl === "string" && repoUrl.trim()) {
      try {
        const { langs, frameworks, urlHash } = await deriveRepoFingerprint(repoUrl);
        repoLangs = langs;
        repoFingerprintJson = {
          url: repoUrl.trim(),
          urlHash,
          langs,
          frameworks,
          derivedAt: new Date().toISOString(),
          langSource: langs.length > 0 ? "github_api" : "none",
        };
        logger.info(
          { sessionId: insertedSessionId, repoUrl: repoUrl.trim(), langs, frameworks },
          "Scheduler: repo fingerprint derived for Smart Skills bundle selection",
        );
      } catch (fingerprintErr) {
        logger.warn({ err: fingerprintErr, repoUrl }, "Scheduler: failed to derive repo fingerprint — will use default bundle");
      }
    }

    // Persist repo fingerprint to session row
    if (repoFingerprintJson) {
      await db.update(sessionsTable).set({ repoFingerprintJson, updatedAt: new Date() }).where(eq(sessionsTable.id, insertedSessionId));
    }

    // Compile the active skills bundle (same logic as manual launch)
    let activeBundleB64: string | undefined;
    let resolvedBundleId: number | undefined;
    let pendingCompiled: Awaited<ReturnType<typeof compileBundle>> | undefined;
    try {
      await seedDefaultBundles();
      const sessionCtx: SessionContext = {
        sessionType: teamMemberRecords.length > 0 ? "team" : "solo",
        taskMode: teamMemberRecords.length > 0 ? "team" : "build",
        modelProfile: profile.servedModelName || "kimi",
        repoLangs,
        tokenMode: "core",
        repoIntelligence: undefined,
      };

      const bundle = await getDefaultBundleForContext(sessionCtx, !!(repoUrl && typeof repoUrl === "string" && repoUrl.trim()));
      if (bundle) {
        resolvedBundleId = bundle.id;
        const compiled = await compileBundle(bundle.id, sessionCtx);
        activeBundleB64 = buildActiveBundleEnvPayload(compiled, "core");
        pendingCompiled = compiled;
        logger.info(
          { sessionId: insertedSessionId, bundleId: bundle.id, bundleSlug: bundle.slug, repoLangs, repoFrameworks: repoFingerprintJson?.frameworks ?? [] },
          "Scheduler: Smart Skills bundle compiled for session",
        );
      }
    } catch (skillsErr) {
      logger.warn({ err: skillsErr, sessionId: insertedSessionId }, "Scheduler: Smart Skills compilation failed — session will launch without skills bundle");
    }

    if (resolvedBundleId) {
      await db.update(sessionsTable).set({ activeBundleId: resolvedBundleId, updatedAt: new Date() }).where(eq(sessionsTable.id, insertedSessionId));
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
      memAuthToken,
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

    // Record Skills activation now that instance creation succeeded
    if (pendingCompiled) {
      try {
        await recordSessionActivation(insertedSessionId, pendingCompiled, "core");
      } catch (activationErr) {
        logger.warn({ err: activationErr, sessionId: insertedSessionId }, "Scheduler: failed to record session activation (non-fatal)");
      }
    }

    await db
      .update(sessionsTable)
      .set({
        vastInstanceId: result.new_contract,
        status: "provisioning",
        statusMessage: "Scheduler-launched — waiting for startup and model download...",
        startedAt: new Date(),
        costPerHour: result.expected_price || null,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, insertedSessionId));

    logger.info(
      { sessionId: insertedSessionId, vastInstanceId: result.new_contract },
      "Scheduler: session launched successfully"
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId: insertedSessionId }, "Scheduler: failed to provision instance — marking session as error");
    await db
      .update(sessionsTable)
      .set({
        status: "error",
        statusMessage: `Scheduler provisioning failed: ${message}`,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, insertedSessionId))
      .catch((e) => logger.warn(e, "Scheduler: failed to mark session as error after provisioning failure"));
  }
}

async function stopActiveSession(): Promise<void> {
  const session = await getActiveSession();
  if (!session) return;

  logger.info({ sessionId: session.id }, "Scheduler: safety net stop triggered");

  if (session.vastInstanceId) {
    try {
      await vastai.destroyInstance(session.vastInstanceId);
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "Scheduler: failed to destroy Vast.ai instance");
    }
  }

  const hoursRunning = session.startedAt
    ? (Date.now() - session.startedAt.getTime()) / (1000 * 60 * 60)
    : 0;
  const totalCost = session.costPerHour ? session.costPerHour * hoursRunning : 0;

  await db
    .update(sessionsTable)
    .set({
      status: "stopped",
      statusMessage: "Auto-stopped by scheduler (safety net)",
      stoppedAt: new Date(),
      totalCost: Math.round(totalCost * 100) / 100,
      updatedAt: new Date(),
    })
    .where(eq(sessionsTable.id, session.id));

  logger.info({ sessionId: session.id }, "Scheduler: session stopped");
}

// Track recent actions to prevent double-firing across 30-second interval ticks
const recentActions = new Set<string>();

async function checkSchedule(): Promise<void> {
  try {
    const [config] = await db.select().from(schedulerConfigTable).limit(1);
    if (!config || !config.enabled) return;

    const localTime = getLocalHHMM(config.timezone);
    const dayOfWeek = getLocalDay(config.timezone);
    const dateKey = getLocalDateKey(config.timezone);

    if (!config.daysOfWeek.includes(dayOfWeek)) return;

    // Auto-launch check
    if (localTime === config.launchTime && config.profileId) {
      const actionKey = `launch-${dateKey}-${localTime}`;
      if (!recentActions.has(actionKey)) {
        recentActions.add(actionKey);
        const active = await getActiveSession();
        if (!active) {
          logger.info(
            { launchTime: config.launchTime, timezone: config.timezone, repoUrl: config.repoUrl ?? null },
            "Scheduler: auto-launching session"
          );
          await launchScheduledSession(config.profileId, config.teamMemberNames ?? [], config.repoUrl);
        } else {
          logger.info({ sessionId: active.id }, "Scheduler: session already running, skipping auto-launch");
        }
      }
    }

    // Safety-net stop: 2 minutes after the configured stop time
    const safetyTime = addMinutesToTimeStr(config.stopTime, 2);
    if (localTime === safetyTime) {
      const actionKey = `stop-${dateKey}-${localTime}`;
      if (!recentActions.has(actionKey)) {
        recentActions.add(actionKey);
        await stopActiveSession();
      }
    }

    // Safety-net stop: 2 minutes after the second reminder time (if configured and different from stopTime)
    if (config.secondReminderTime && config.secondReminderTime !== config.stopTime) {
      const secondSafetyTime = addMinutesToTimeStr(config.secondReminderTime, 2);
      if (localTime === secondSafetyTime) {
        const actionKey = `stop2-${dateKey}-${localTime}`;
        if (!recentActions.has(actionKey)) {
          recentActions.add(actionKey);
          await stopActiveSession();
        }
      }
    }

    // Prune old action keys (keep only today's entries)
    for (const key of recentActions) {
      if (!key.includes(dateKey)) {
        recentActions.delete(key);
      }
    }
  } catch (err) {
    logger.error(err, "Scheduler: error during schedule check");
  }
}

export function startScheduler(): void {
  logger.info("Scheduler: started — checking every 30 seconds");

  // Run once at startup, then every 30 seconds aligned to the schedule
  void checkSchedule();
  setInterval(() => void checkSchedule(), 30 * 1000);

  startDesignSyncScheduler();
}
