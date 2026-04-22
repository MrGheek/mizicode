import { db, schedulerConfigTable, sessionsTable, gpuProfilesTable, templatesTable } from "@workspace/db";
import { inArray, desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import * as vastai from "./vastai";
import { getProfileById } from "./profiles";
import type { VastOffer } from "./vastai";
import { seedCuratedSources } from "./curated-sources";

// ─── Design Sync Scheduler ───────────────────────────────────────────────────

const DEFAULT_DESIGN_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

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

export function markDesignSyncComplete(): void {
  designSyncState.lastSyncedAt = new Date();
  designSyncState.lastAttemptedAt = new Date();
  designSyncState.lastError = null;
}

async function runDesignSync(): Promise<void> {
  if (designSyncState.isRunning) {
    logger.warn("Design sync: previous run still in progress — skipping this interval tick");
    return;
  }

  designSyncState.isRunning = true;
  designSyncState.lastAttemptedAt = new Date();
  logger.info("Design sync: starting scheduled re-sync of curated sources");

  try {
    const result = await seedCuratedSources();
    if (result.success) {
      designSyncState.lastSyncedAt = new Date();
      designSyncState.lastError = null;
      logger.info({ reason: result.reason, updated: result.updated }, "Design sync: completed successfully");
    } else {
      designSyncState.lastError = result.reason;
      logger.error({ reason: result.reason }, "Design sync: sync reported failure — lastSyncedAt not updated");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    designSyncState.lastError = message;
    logger.error({ err }, "Design sync: unexpected error during scheduled sync");
  } finally {
    designSyncState.isRunning = false;
  }
}

function startDesignSyncScheduler(): void {
  const intervalMs = designSyncState.intervalMs;
  designSyncState.nextSyncAt = new Date(Date.now() + intervalMs);

  setInterval(() => {
    designSyncState.nextSyncAt = new Date(Date.now() + intervalMs);
    void runDesignSync();
  }, intervalMs);

  logger.info(
    { intervalMs, nextSyncAt: designSyncState.nextSyncAt.toISOString() },
    "Design sync scheduler started",
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

async function launchScheduledSession(profileId: number): Promise<void> {
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
    })
    .returning();

  const MODEL_REPO = profile.modelRepo;
  const MODEL_QUANT = profile.defaultQuant;
  const SERVED_MODEL_NAME = profile.servedModelName;

  const onstart = vastai.buildOnStartScript({
    modelRepo: MODEL_REPO,
    modelQuant: MODEL_QUANT,
    servedModelName: SERVED_MODEL_NAME,
    llamaCtxSize: profile.llamaCtxSize,
    llamaBatchSize: profile.llamaBatchSize,
    llamaExtraArgs: profile.llamaExtraArgs || "",
    numGpus: profile.numGpus,
    swarmWorkerCap: profile.swarmWorkerCap,
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
    .where(eq(sessionsTable.id, session.id));

  logger.info(
    { sessionId: session.id, vastInstanceId: result.new_contract },
    "Scheduler: session launched successfully"
  );
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
            { launchTime: config.launchTime, timezone: config.timezone },
            "Scheduler: auto-launching session"
          );
          await launchScheduledSession(config.profileId);
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
