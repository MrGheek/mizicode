/**
 * POST /sessions/orchestrate — Single-call team provisioning
 *
 * Accepts a declarative team composition + goal and provisions a fully-configured
 * session in one call:
 *   1. GPU offer selection → session row creation
 *   2. Per-member skill bundle upsert (from teamMembers[].skills)
 *   3. Vast.ai instance creation
 *   4. compileLaneBundles (session-core + per-lane overlays), lane row creation
 *   5. Pre-registered file claims (from teamMembers[].claimPaths)
 *   6. Returns 202 immediately; agents poll GET /sessions/:id/orchestration-status
 *
 * Orchestration design:
 *   Lanes are DB records created in this call — they become functional (bridge
 *   connected, IDE accessible) when the GPU instance fires the `llm_ready`
 *   callback handled by PUT /sessions/:id/instance-status.
 *   The polling endpoint reflects the live `bootPhase` and per-lane bridge state.
 */

import { Router } from "express";
import type { Response } from "express";
import { createHash, randomBytes } from "crypto";
import { db, sessionsTable, gpuProfilesTable, templatesTable, sessionLanesTable, laneClaimsTable, skillBundlesTable, orchestrationIdempotencyTable } from "@workspace/db";
import { eq, desc, lt, sql } from "drizzle-orm";
import { requireAgentAuth } from "../middlewares/agent-auth";
import { getProfileById } from "../services/profiles";
import * as vastai from "../services/vastai";
import type { VastOffer } from "../services/vastai";
import { compileLaneBundles, buildActiveBundleEnvPayload, recordSessionActivation, getDefaultBundleForContext, seedDefaultBundles } from "../services/skills-bundler";
import type { SessionContext } from "../services/skills-types";
import { getLanePolicyAsync, resolveValidLaneType, LANE_DEFAULT_TTL_SECONDS } from "../services/lane-policy";
import { getBridgeStatus } from "../services/bridge-registry";
import { logger } from "../lib/logger";
import type { TeamMemberRecord } from "@workspace/db";

const router = Router();

// ─── Member name sanitization ─────────────────────────────────────────────────
// Mirrors the same rules enforced by POST /sessions to prevent shell injection
// via `teamMembers[].role`, which flows into teamMemberRecords and ultimately
// into the onstart script's TEAM_MEMBERS_JSON env var.
const ORCHESTRATE_RESERVED_NAMES = new Set([
  "__shared__", "owner", "admin", "root", "shared",
]);
const ORCHESTRATE_SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function sanitizeRole(raw: string): string | null {
  const cleaned = (raw || "").trim().toLowerCase();
  if (!ORCHESTRATE_SAFE_NAME_RE.test(cleaned)) return null;
  if (ORCHESTRATE_RESERVED_NAMES.has(cleaned)) return null;
  return cleaned;
}

// ─── Provisioning status set ──────────────────────────────────────────────────
const ACTIVE_PROVISIONING_STATUSES: ReadonlySet<string> = new Set([
  "pending", "provisioning", "downloading", "starting",
]);

// ─── Auth ──────────────────────────────────────────────────────────────────────

router.post("/sessions/orchestrate", requireAgentAuth(["sessions:write"]));
router.get("/sessions/:sessionId/orchestration-status", requireAgentAuth(["sessions:write"]));

// ─── Idempotency (DB-backed, race-safe) ───────────────────────────────────────
// Keyed by SHA-256 of (goal + profileId + sorted member roles).
// Within a 5-minute window a second identical call returns the existing session.
// Keys are persisted in the database so server restarts don't cause duplicates.
//
// Race-safety: the first caller atomically INSERTs a row with session_id = NULL
// (a "reservation"). Only if the INSERT wins does that caller proceed to provision.
// Concurrent callers that lose the INSERT see the existing row and either wait
// (session_id = NULL) or get the completed session (session_id = <id>).
// A NULL reservation older than 60 s is treated as a stale crash and cleared.

const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;
// Time to wait before treating a NULL-session_id reservation as a stale crash.
const IDEMPOTENCY_RESERVATION_STALE_MS = 60_000;

function buildIdempotencyKey(goal: string, profileId: string | number, memberRoles: string[]): string {
  const sorted = [...memberRoles].sort().join(",");
  const raw = `${String(goal).trim()}|${profileId}|${sorted}`;
  return createHash("sha256").update(raw).digest("hex");
}

type AcquireOutcome =
  | { outcome: "reserved" }
  | { outcome: "in_progress" }
  | { outcome: "exists"; sessionId: number }
  | { outcome: "stale_cleared" };

/**
 * Atomically attempt to reserve the idempotency key.
 *
 * Returns:
 *   "reserved"      — this caller won the race; proceed to provision, then call
 *                     confirmIdempotencyEntry() with the real sessionId.
 *   "exists"        — a completed session already exists; return it to the caller.
 *   "in_progress"   — another request is currently provisioning; caller should
 *                     respond with 409 and ask the client to retry shortly.
 *   "stale_cleared" — a stale crash reservation was cleared; caller may retry
 *                     immediately (treated the same as "reserved" on retry).
 */
async function acquireIdempotencyKey(key: string): Promise<AcquireOutcome> {
  // Try to atomically claim the key with a NULL session_id ("in-progress" marker).
  const inserted = await db
    .insert(orchestrationIdempotencyTable)
    .values({ idempotencyKey: key, sessionId: null })
    .onConflictDoNothing()
    .returning({ idempotencyKey: orchestrationIdempotencyTable.idempotencyKey });

  if (inserted.length > 0) {
    return { outcome: "reserved" };
  }

  // Another row already exists — read it.
  const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
  const [row] = await db
    .select()
    .from(orchestrationIdempotencyTable)
    .where(eq(orchestrationIdempotencyTable.idempotencyKey, key));

  if (!row || row.createdAt < cutoff) {
    // Expired or gone (unlikely race) — clear and let caller retry.
    if (row) await deleteIdempotencyEntry(key);
    return { outcome: "stale_cleared" };
  }

  if (row.sessionId !== null) {
    return { outcome: "exists", sessionId: row.sessionId };
  }

  // session_id is NULL: provisioning is in-progress.
  // If the reservation is old enough to be a stale crash, clear it.
  const age = Date.now() - row.createdAt.getTime();
  if (age > IDEMPOTENCY_RESERVATION_STALE_MS) {
    logger.warn({ key, ageMs: age }, "Orchestrate idempotency: stale NULL reservation — clearing for retry");
    await deleteIdempotencyEntry(key);
    return { outcome: "stale_cleared" };
  }

  return { outcome: "in_progress" };
}

/**
 * After a session has been successfully created, update the reservation row
 * with the real session_id so subsequent callers can return it idempotently.
 */
async function confirmIdempotencyEntry(key: string, sessionId: number): Promise<void> {
  await db
    .update(orchestrationIdempotencyTable)
    .set({ sessionId })
    .where(eq(orchestrationIdempotencyTable.idempotencyKey, key));
}

/**
 * Non-reserving existence check used as an early fast-path before expensive
 * pre-provisioning work (profile lookup, GPU offer search). Pure read — does
 * NOT insert or modify any row.
 */
async function checkIdempotencyStatus(key: string): Promise<
  | { status: "exists"; sessionId: number }
  | { status: "in_progress" }
  | { status: "not_found" }
> {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
  const [row] = await db
    .select()
    .from(orchestrationIdempotencyTable)
    .where(
      sql`${orchestrationIdempotencyTable.idempotencyKey} = ${key}
          AND ${orchestrationIdempotencyTable.createdAt} >= ${cutoff}`
    );

  if (!row) return { status: "not_found" };
  if (row.sessionId !== null) return { status: "exists", sessionId: row.sessionId };

  // NULL session_id — another request is provisioning.
  // If it looks like a stale crash reservation, treat as not_found (will be
  // formally cleared by the next acquireIdempotencyKey call).
  const age = Date.now() - row.createdAt.getTime();
  if (age > IDEMPOTENCY_RESERVATION_STALE_MS) return { status: "not_found" };

  return { status: "in_progress" };
}

/** Delete an idempotency entry so a failed provisioning attempt can be retried. */
async function deleteIdempotencyEntry(key: string): Promise<void> {
  await db
    .delete(orchestrationIdempotencyTable)
    .where(eq(orchestrationIdempotencyTable.idempotencyKey, key));
}

/** Periodically remove entries older than the 5-minute window. */
async function pruneExpiredIdempotencyEntries(): Promise<void> {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
  try {
    await db
      .delete(orchestrationIdempotencyTable)
      .where(lt(orchestrationIdempotencyTable.createdAt, cutoff));
  } catch (err) {
    logger.warn({ err }, "Orchestrate: failed to prune expired idempotency entries (non-fatal)");
  }
}

// Run cleanup every 5 minutes (matches the TTL window).
setInterval(() => { pruneExpiredIdempotencyEntries().catch(() => undefined); }, IDEMPOTENCY_WINDOW_MS).unref();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function generatePassword(length = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = randomBytes(length);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

const CALLBACK_TOKEN = process.env["MIZI_MEM_TOKEN"] || "";

/**
 * Upsert an ephemeral (non-default) skill bundle for a member's explicit skill list.
 * The bundle slug is deterministic from the sorted skill IDs so identical skill sets
 * reuse the same row across sessions. Returns the bundle DB id.
 */
async function upsertMemberSkillBundle(memberRole: string, skillIds: string[]): Promise<number> {
  const sorted = [...skillIds].sort();
  const slugSuffix = createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 16);
  const slug = `orchestrate-member-${memberRole}-${slugSuffix}`;

  const [existing] = await db.select({ id: skillBundlesTable.id }).from(skillBundlesTable).where(eq(skillBundlesTable.slug, slug));
  if (existing) return existing.id;

  const [created] = await db.insert(skillBundlesTable).values({
    slug,
    name: `Orchestrate member overlay: ${memberRole} (${sorted.join(", ")})`,
    bundleJson: { skillIds: sorted } as unknown as Record<string, unknown>,
    taskMode: "team",
    sessionMode: "solo",
    tokenMode: "core",
    isDefault: false,
  }).returning({ id: skillBundlesTable.id });

  logger.info({ memberRole, skillIds: sorted, bundleSlug: slug }, "Orchestrate: upserted member skill bundle");
  return created.id;
}

// ─── Idempotent-response helper ────────────────────────────────────────────────
// Single source of truth for the "existing session" response shape. Used by
// every "exists" branch so all callers get the same contract.

async function sendExistingSessionResponse(res: Response, sessionId: number): Promise<boolean> {
  const [sess] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!sess) return false;

  const lanes = await db
    .select()
    .from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId))
    .orderBy(desc(sessionLanesTable.createdAt));

  const baseUrl = (sess.codeServerUrl || "").replace(/\/$/, "");
  const members = lanes.map((lane) => {
    const member = (sess.teamMembers as TeamMemberRecord[] | null)
      ?.find((tm) => tm.name === lane.memberIdentifier);
    return {
      laneId: lane.id,
      memberIdentifier: lane.memberIdentifier,
      role: lane.laneType,
      overlayBundleId: lane.overlayBundleId ?? null,
      ideUrl: member?.ideUrl || (baseUrl ? `${baseUrl}/ide/${lane.memberIdentifier}/` : null),
      bridgeStatus: getBridgeStatus(sessionId, lane.id),
    };
  });

  res.status(200).json({
    idempotent: true,
    sessionId,
    status: ACTIVE_PROVISIONING_STATUSES.has(sess.status) ? "provisioning" : sess.status,
    vastInstanceId: sess.vastInstanceId,
    members,
  });
  return true;
}

// ─── POST /sessions/orchestrate ────────────────────────────────────────────────

export interface OrchestrateTeamMember {
  role: string;
  skills?: string[];
  claimPaths?: string[];
}

export interface OrchestrateBody {
  goal: string;
  teamMembers: OrchestrateTeamMember[];
  profileId: string | number;
  repoUrl?: string;
  githubToken?: string;
}

router.post("/sessions/orchestrate", async (req, res) => {
  const body = req.body as Partial<OrchestrateBody>;

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!body.goal || typeof body.goal !== "string" || !body.goal.trim()) {
    res.status(400).json({ error: "goal (string) is required" });
    return;
  }
  if (!body.profileId) {
    res.status(400).json({ error: "profileId is required" });
    return;
  }
  if (!Array.isArray(body.teamMembers) || body.teamMembers.length === 0) {
    res.status(400).json({ error: "teamMembers (non-empty array) is required" });
    return;
  }

  const goal = body.goal.trim().slice(0, 500);
  const profileId = body.profileId;

  // ── Sanitize member roles to prevent shell injection via onstart script ──────
  const rawMembers = body.teamMembers;
  const sanitizedRoles: string[] = [];
  for (let i = 0; i < rawMembers.length; i++) {
    const m = rawMembers[i];
    const safe = sanitizeRole(typeof m.role === "string" ? m.role : "");
    if (!safe) {
      res.status(400).json({
        error: `teamMembers[${i}].role "${m.role}" is invalid — must match /^[a-z0-9][a-z0-9_-]{0,30}$/ and not be a reserved name`,
      });
      return;
    }
    sanitizedRoles.push(safe);
  }
  const teamMembers: OrchestrateTeamMember[] = rawMembers.map((m, i) => ({
    role: sanitizedRoles[i],
    skills: Array.isArray(m.skills) ? m.skills.filter((s) => typeof s === "string") : undefined,
    claimPaths: Array.isArray(m.claimPaths) ? m.claimPaths.filter((p) => typeof p === "string") : undefined,
  }));
  const repoUrl = typeof body.repoUrl === "string" && body.repoUrl.trim() ? body.repoUrl.trim() : undefined;
  const githubToken = typeof body.githubToken === "string" && body.githubToken.trim() ? body.githubToken.trim() : undefined;

  // ── Idempotency fast-path (non-reserving read) ──────────────────────────────
  // Avoids expensive profile/offer work for duplicate calls in the common case.
  // No reservation is acquired here, so validation 400s below will never leak a key.
  const idempKey = buildIdempotencyKey(goal, profileId, teamMembers.map((m) => m.role));
  const precheck = await checkIdempotencyStatus(idempKey);
  if (precheck.status === "in_progress") {
    res.status(409).json({
      error: "provisioning_in_progress",
      message: "An identical session is already being provisioned. Retry in a few seconds.",
    });
    return;
  }
  if (precheck.status === "exists") {
    try {
      const sent = await sendExistingSessionResponse(res, precheck.sessionId);
      if (sent) return;
      // Session row is gone (hard-deleted) — stale key; clear it and fall through.
      logger.warn({ sessionId: precheck.sessionId }, "Orchestrate idempotency fast-path: session row missing — clearing stale key");
      await deleteIdempotencyEntry(idempKey);
    } catch (lookupErr) {
      logger.warn({ err: lookupErr, sessionId: precheck.sessionId }, "Orchestrate idempotency fast-path: session lookup failed — clearing and creating fresh");
      deleteIdempotencyEntry(idempKey).catch(() => undefined);
    }
    // Fall through to provision a fresh session.
  }

  // ── Profile lookup ──────────────────────────────────────────────────────────
  const profile = await getProfileById(Number(profileId));
  if (!profile) {
    res.status(400).json({ error: `Profile "${profileId}" not found` });
    return;
  }

  let insertedSessionId: number | undefined;
  let vastInstanceId: number | undefined;
  // Tracks whether this request holds a NULL-session_id reservation in the DB.
  // Set to true only inside the try block after a successful atomic INSERT.
  // The catch block uses this flag to clean up on failure.
  let keyReserved = false;

  try {
    // ── GPU offer selection ─────────────────────────────────────────────────
    const searchParams = (profile.searchParams as Record<string, unknown>) || {};
    const offers = await vastai.searchOffers({
      gpu_name: searchParams.gpu_name as string,
      num_gpus: searchParams.num_gpus as number,
      min_gpu_ram: searchParams.min_gpu_ram as number,
      disk_space: profile.diskSizeGb,
      limit: 1,
    });

    if (!offers || offers.length === 0) {
      // No reservation has been acquired yet — safe to return 400 with no cleanup.
      res.status(400).json({ error: "No GPU offers available for this profile. Try again later or choose a different profile." });
      return;
    }
    const selectedOfferId = (offers[0] as VastOffer).id;

    // ── Template lookup ─────────────────────────────────────────────────────
    const [defaultTemplate] = await db
      .select()
      .from(templatesTable)
      .where(eq(templatesTable.isDefault, true))
      .limit(1);
    const templateHash = defaultTemplate?.templateHash || undefined;

    // ── Build team member records ────────────────────────────────────────────
    const teamMemberRecords: TeamMemberRecord[] = [
      { name: "__shared__", password: generatePassword(), path: "/shared/", ideUrl: null },
      ...teamMembers.map((m) => ({
        name: m.role,
        password: generatePassword(),
        path: `/ide/${m.role}/`,
        ideUrl: null,
      })),
    ];

    // ── Repo fingerprint ─────────────────────────────────────────────────────
    let repoFingerprintJson: Record<string, unknown> | null = null;
    if (repoUrl) {
      const urlHash = createHash("sha256").update(repoUrl.toLowerCase()).digest("hex").slice(0, 16);
      repoFingerprintJson = { url: repoUrl, branch: "main", urlHash, langs: [], frameworks: [], derivedAt: new Date().toISOString() };
    }

    // ── Atomic idempotency reservation ───────────────────────────────────────
    // All validation is done above. Acquiring the key here (right before the
    // session INSERT) minimises how long the NULL-reservation is held, and
    // ensures that any validation 400 paths above never leave an orphaned key.
    const acquired = await acquireIdempotencyKey(idempKey);
    if (acquired.outcome === "exists") {
      // Another request completed provisioning between our fast-path check and now.
      const sent = await sendExistingSessionResponse(res, acquired.sessionId).catch(() => false);
      if (!sent) res.status(409).json({ error: "provisioning_in_progress", message: "An identical session is already being provisioned. Retry in a few seconds." });
      return;
    }
    if (acquired.outcome === "in_progress") {
      // No reservation held (INSERT was a conflict) — safe to return with no cleanup.
      res.status(409).json({ error: "provisioning_in_progress", message: "An identical session is already being provisioned. Retry in a few seconds." });
      return;
    }
    if (acquired.outcome === "stale_cleared") {
      // Stale reservation was cleared — retry the atomic acquire once.
      const retry = await acquireIdempotencyKey(idempKey);
      if (retry.outcome === "exists") {
        const sent = await sendExistingSessionResponse(res, retry.sessionId).catch(() => false);
        if (!sent) res.status(409).json({ error: "provisioning_in_progress", message: "An identical session is already being provisioned. Retry in a few seconds." });
        return;
      }
      if (retry.outcome !== "reserved") {
        // In-progress or another stale-cleared — give up cleanly.
        res.status(409).json({ error: "provisioning_in_progress", message: "An identical session is already being provisioned. Retry in a few seconds." });
        return;
      }
    }
    // outcome === "reserved": we own the reservation. Track it for cleanup.
    keyReserved = true;

    // ── Create session row ───────────────────────────────────────────────────
    const [session] = await db
      .insert(sessionsTable)
      .values({
        profileId: profile.id,
        vastOfferId: selectedOfferId,
        templateHash: templateHash || null,
        status: "provisioning",
        statusMessage: "Orchestration: finding GPU and provisioning instance...",
        gpuName: profile.gpuName,
        numGpus: profile.numGpus,
        teamMembers: teamMemberRecords,
        taskMode: "team",
        tokenMode: "core",
        repoFingerprintJson,
        intentText: goal,
        provider: "vastai",
        ownerToken: generatePassword(32),
        hasGithubToken: !!githubToken,
      })
      .returning();

    insertedSessionId = session.id;

    // Confirm the reservation by updating the idempotency row with the real
    // session_id. Concurrent callers will now see outcome "exists" instead of
    // "in_progress" and get returned this session.
    await confirmIdempotencyEntry(idempKey, insertedSessionId);

    // ── Per-member skill bundle upsert (before createInstance) ───────────────
    // Members with an explicit `skills` list get a deterministic ephemeral bundle.
    // This step runs before instance creation so any skills-service failure aborts
    // cleanly without leaving an orphaned GPU instance.
    const memberBundleIds = new Map<string, number | null>();
    for (const member of teamMembers) {
      if (member.skills && member.skills.length > 0) {
        const bundleId = await upsertMemberSkillBundle(member.role, member.skills);
        memberBundleIds.set(member.role, bundleId);
      } else {
        memberBundleIds.set(member.role, null);
      }
    }

    // ── Session-level skills bundle (optional) ───────────────────────────────
    let activeBundleB64: string | undefined;
    let resolvedBundleId: number | undefined;

    try {
      await seedDefaultBundles();
      const sessionCtx: SessionContext = {
        sessionType: "team",
        taskMode: "team",
        modelProfile: profile.servedModelName || "kimi",
        repoLangs: [],
        tokenMode: "core",
        intentText: goal,
      };

      const bundle = await getDefaultBundleForContext(sessionCtx, !!repoUrl);
      if (bundle) {
        resolvedBundleId = bundle.id;
        // Compile the session bundle for the onstart script payload
        const { compileBundle } = await import("../services/skills-bundler");
        const compiled = await compileBundle(bundle.id, sessionCtx);
        activeBundleB64 = buildActiveBundleEnvPayload(compiled, "core");

        // Record activation once instance is up (best-effort, non-blocking)
        recordSessionActivation(insertedSessionId, compiled, "core").catch((activationErr) => {
          logger.warn({ err: activationErr, sessionId: insertedSessionId }, "Orchestrate: skills activation record failed (non-fatal)");
        });
      }
    } catch (skillsErr) {
      logger.warn({ err: skillsErr, sessionId: insertedSessionId }, "Orchestrate: session-level skills compilation failed — continuing without bundle");
    }

    if (resolvedBundleId) {
      await db.update(sessionsTable)
        .set({ activeBundleId: resolvedBundleId, updatedAt: new Date() })
        .where(eq(sessionsTable.id, insertedSessionId));
    }

    // ── Build onstart script and create Vast.ai instance ────────────────────
    const memProxyUrl = process.env["MIZI_MEM_PROXY_URL"]
      || (process.env["REPLIT_DEV_DOMAIN"]
        ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
        : undefined);
    const memUserId = process.env["MIZI_MEM_USER_ID"] || "operator";

    const onstart = vastai.buildOnStartScript({
      modelRepo: profile.modelRepo,
      modelQuant: profile.defaultQuant,
      servedModelName: profile.servedModelName,
      llamaCtxSize: profile.llamaCtxSize,
      llamaBatchSize: profile.llamaBatchSize,
      llamaExtraArgs: profile.llamaExtraArgs || "",
      numGpus: profile.numGpus,
      swarmWorkerCap: profile.swarmWorkerCap,
      memProxyUrl,
      memAuthToken: CALLBACK_TOKEN || undefined,
      memUserId,
      teamMembers: teamMemberRecords,
      sessionId: insertedSessionId,
      callbackBaseUrl: memProxyUrl,
      activeBundleB64,
      githubToken,
    });

    const result = await vastai.createInstance({
      offerId: selectedOfferId,
      image: profile.dockerImageTag,
      onstart,
      disk: profile.diskSizeGb,
      templateHashId: templateHash,
      env: {
        MODEL_REPO: profile.modelRepo,
        MODEL_QUANT: profile.defaultQuant,
        SERVED_MODEL_NAME: profile.servedModelName,
        VLLM_MAX_MODEL_LEN: String(profile.llamaCtxSize),
        VLLM_MAX_NUM_SEQS: String(profile.llamaBatchSize),
        NUM_GPUS: String(profile.numGpus),
      },
    });

    // vastInstanceId is now set — any throw after this point triggers teardown
    vastInstanceId = result.new_contract;

    await db.update(sessionsTable).set({
      vastInstanceId: vastInstanceId ?? null,
      status: "provisioning",
      statusMessage: "Orchestration: instance created — waiting for startup and model download...",
      startedAt: new Date(),
      costPerHour: result.expected_price || null,
      updatedAt: new Date(),
    }).where(eq(sessionsTable.id, insertedSessionId));

    // ── compileLaneBundles (synchronous — in main flow) ───────────────────────
    // Runs in main try block so any failure here triggers teardown.
    // For lanes with explicit member.skills, the member's custom bundle takes
    // precedence as the overlay; for others, compileLaneBundles selects by policy.
    const sessionCtx: SessionContext = {
      sessionType: "team",
      taskMode: "team",
      modelProfile: profile.servedModelName || "kimi",
      repoLangs: [],
      tokenMode: "core",
      intentText: goal,
    };

    // ── Create lanes for each team member (stub — overlayBundleId set after compile) ──
    // Lanes must exist before compileLaneBundles so real lane IDs are available for
    // prompt-snapshot FK rows (laneId: 0 would be filtered and never written).
    const laneInserts = await Promise.all(
      teamMembers.map(async (member) => {
        // resolveValidLaneType checks both built-in LANE_POLICIES and the custom_lane_types
        // table, so DB-defined lane types (e.g. "security-review") are honoured end-to-end.
        const resolvedLaneType = await resolveValidLaneType(member.role);
        const policy = await getLanePolicyAsync(resolvedLaneType);

        const [lane] = await db.insert(sessionLanesTable).values({
          sessionId: insertedSessionId!,
          memberIdentifier: member.role,
          laneType: resolvedLaneType,
          taskMode: policy.defaultTaskMode,
          status: "pending",
          tokenMode: policy.defaultTokenMode,
          currentTask: goal.slice(0, 200),
          overlayBundleId: null, // resolved below after compileLaneBundles
        }).returning();

        return { lane, member };
      })
    );

    // Re-use the already-stored laneType from each lane row and fetch its policy
    // asynchronously — this avoids a second DB lookup for custom lane types.
    const laneInputs = await Promise.all(
      laneInserts.map(async ({ lane, member }) => {
        const policy = await getLanePolicyAsync(lane.laneType);
        return {
          laneId: lane.id, // real DB ID — required for snapshot FK
          memberIdentifier: member.role,
          laneType: lane.laneType,
          taskMode: policy.defaultTaskMode,
          tokenMode: policy.defaultTokenMode,
        };
      })
    );

    const bundleResult = await compileLaneBundles(insertedSessionId, sessionCtx, laneInputs);

    // ── Resolve overlay bundle ID per lane and update rows ────────────────────
    // Priority: explicit member.skills bundle > compileLaneBundles result > null
    await Promise.all(
      laneInserts.map(async ({ lane, member }) => {
        const memberBundleId = memberBundleIds.get(member.role) ?? null;
        const compiledOverlay = bundleResult.laneOverlays.find(o => o.memberIdentifier === member.role);
        const overlayBundleId = memberBundleId ?? compiledOverlay?.overlayBundleId ?? null;
        if (overlayBundleId !== null) {
          await db.update(sessionLanesTable)
            .set({ overlayBundleId })
            .where(eq(sessionLanesTable.id, lane.id));
          lane.overlayBundleId = overlayBundleId; // keep in-memory object in sync
        }
      })
    );

    // ── Pre-register file claims ─────────────────────────────────────────────
    const now = new Date();
    const expiresAt = new Date(Date.now() + LANE_DEFAULT_TTL_SECONDS * 1000);
    const claimInserts: Promise<void>[] = [];

    for (const { lane, member } of laneInserts) {
      if (!member.claimPaths || member.claimPaths.length === 0) continue;
      for (const resourcePath of member.claimPaths) {
        claimInserts.push(
          db.insert(laneClaimsTable).values({
            laneId: lane.id,
            claimType: "file",
            pathOrSymbol: resourcePath,
            claimedAt: now,
            lastHeartbeatAt: now,
            expiresAt,
            claimStrength: "owner",
            active: true,
          }).onConflictDoUpdate({
            target: [laneClaimsTable.laneId, laneClaimsTable.pathOrSymbol],
            targetWhere: eq(laneClaimsTable.active, true),
            set: {
              claimStrength: "owner",
              lastHeartbeatAt: now,
              expiresAt,
            },
          }).then(() => undefined)
        );
      }
    }

    await Promise.all(claimInserts);

    // ── Build response ───────────────────────────────────────────────────────
    const members = laneInserts.map(({ lane, member }) => ({
      laneId: lane.id,
      memberIdentifier: lane.memberIdentifier,
      role: lane.laneType,
      overlayBundleId: lane.overlayBundleId ?? null,
      claimPaths: member.claimPaths ?? [],
      skills: member.skills ?? [],
      ideUrl: null, // available only after instance is running (llm_ready callback)
      bridgeStatus: getBridgeStatus(insertedSessionId!, lane.id) as "connected" | "disconnected",
    }));

    logger.info({ sessionId: insertedSessionId, vastInstanceId, laneCount: members.length }, "Orchestrate: session + lanes provisioned");

    res.status(202).json({
      sessionId: insertedSessionId,
      status: "provisioning",
      vastInstanceId: vastInstanceId ?? null,
      profile: {
        id: profile.id,
        name: profile.name,
        gpuName: profile.gpuName,
        numGpus: profile.numGpus,
      },
      goal,
      taskMode: "team",
      members,
      sessionCoreBundleId: bundleResult.sessionCoreBundleId,
      message: "Session provisioning started. Poll GET /sessions/:id/orchestration-status for readiness.",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(err, "Orchestrate: provisioning failed");

    // Teardown: destroy the GPU instance if it was created
    if (vastInstanceId !== undefined) {
      try {
        await vastai.destroyInstance(vastInstanceId);
        logger.info({ vastInstanceId }, "Orchestrate: GPU instance destroyed after failure");
      } catch (destroyErr) {
        logger.warn({ err: destroyErr, vastInstanceId }, "Orchestrate: failed to destroy GPU instance on error cleanup");
      }
    }

    // Release the idempotency reservation so the next call can retry cleanly.
    // Use keyReserved (not insertedSessionId) so we also clean up if the session
    // INSERT itself throws before insertedSessionId is assigned.
    if (keyReserved) {
      deleteIdempotencyEntry(idempKey).catch(() => undefined);
    }

    if (insertedSessionId !== undefined) {
      await db.update(sessionsTable).set({
        status: "error",
        statusMessage: `Orchestration failed: ${message}`,
        updatedAt: new Date(),
      }).where(eq(sessionsTable.id, insertedSessionId)).catch((e) => {
        logger.warn(e, "Orchestrate: failed to mark session as error");
      });
    }

    res.status(500).json({ error: `Orchestration failed: ${message}` });
  }
});

// ─── GET /sessions/:sessionId/orchestration-status ────────────────────────────
// Polling endpoint for async readiness. Returns current boot phase, lane
// readiness (bridge connected or not), and any errors.

type SessionStatus = typeof sessionsTable.$inferSelect["status"];

function deriveOrchestrationStatus(sessionStatus: SessionStatus): "provisioning" | "ready" | "error" | "stopped" {
  if (sessionStatus === "ready") return "ready";
  if (sessionStatus === "error") return "error";
  if (sessionStatus === "stopped") return "stopped";
  return "provisioning";
}

router.get("/sessions/:sessionId/orchestration-status", async (req, res) => {
  const sessionId = parseInt(req.params["sessionId"] ?? "", 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  try {
    const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const lanes = await db
      .select()
      .from(sessionLanesTable)
      .where(eq(sessionLanesTable.sessionId, sessionId))
      .orderBy(desc(sessionLanesTable.createdAt));

    const baseUrl = (session.codeServerUrl || "").replace(/\/$/, "");
    const teamMembers = (session.teamMembers as TeamMemberRecord[] | null) ?? [];

    const laneStatuses = lanes.map((lane) => {
      const bridgeStatus = getBridgeStatus(sessionId, lane.id);
      const member = teamMembers.find((tm) => tm.name === lane.memberIdentifier);
      const ideUrl = member?.ideUrl || (baseUrl ? `${baseUrl}${member?.path ?? `/ide/${lane.memberIdentifier}/`}` : null);
      return {
        laneId: lane.id,
        memberIdentifier: lane.memberIdentifier,
        role: lane.laneType,
        laneStatus: lane.status,
        overlayBundleId: lane.overlayBundleId ?? null,
        ideUrl,
        bridgeStatus,
      };
    });

    const orchestrationStatus = deriveOrchestrationStatus(session.status);
    const allLanesConnected = laneStatuses.length > 0 && laneStatuses.every((l) => l.bridgeStatus === "connected");

    // Effective status upgrades to "ready" only when both the session is ready
    // AND all bridge connections are established (or no lanes were requested).
    const effectiveStatus = orchestrationStatus === "ready" && !allLanesConnected && laneStatuses.length > 0
      ? "provisioning"
      : orchestrationStatus;

    res.json({
      sessionId,
      status: effectiveStatus,
      bootPhase: session.status,
      bootMessage: session.statusMessage ?? null,
      vastInstanceId: session.vastInstanceId ?? null,
      allLanesConnected,
      lanes: laneStatuses,
      error: session.status === "error" ? (session.statusMessage ?? "Provisioning failed") : null,
    });
  } catch (err) {
    logger.error(err, "Orchestrate status: failed to fetch");
    res.status(500).json({ error: "Failed to fetch orchestration status" });
  }
});

export default router;
