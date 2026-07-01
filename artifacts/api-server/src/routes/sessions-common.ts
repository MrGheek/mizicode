// ── Imports ──────────────────────────────────────────────────────────────────────
import { createProxyMiddleware, responseInterceptor, type RequestHandler as ProxyRequestHandler } from "http-proxy-middleware";
import { db, sessionsTable, provisionedResourcesTable, gpuProfilesTable } from "@workspace/db";
import type { TeamMemberRecord } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import * as neonService from "../services/neon";
import * as tigrisService from "../services/tigris";
import { getBridge, getBridgeForSession, tryAcquireExecLock, releaseExecLock } from "../services/bridge-registry";
import * as fly from "../services/fly";
import * as vastai from "../services/vastai";
import { logger } from "../lib/logger";
import { randomBytes } from "crypto";
import { autoEnqueueRepoIndexIfNeeded } from "./repo";

// ── Type definitions ─────────────────────────────────────────────────────────────

export interface PlanSnapshot {
  activeTask?: string | null;
  planCheckpoint?: string | null;
  activeFiles?: string[];
  unresolvedErrors?: string[];
  taskSummary?: string | null;
  bundleSlug?: string | null;
  updatedAt: string;
}

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

export interface SoftInterruptMessage {
  id: string;
  sessionId: number;
  text: string;
  state: "queued" | "sent";
  sentAt: number;
  injectedAt: number | null;
}

// ── Constants ────────────────────────────────────────────────────────────────────

export const RESERVED_NAMES = new Set(["__shared__", "owner", "admin", "root", "shared"]);
export const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export const ACTIVE_STATUSES = ["pending", "provisioning", "downloading", "starting", "ready"];

export const CALLBACK_TOKEN = process.env["MIZI_MEM_TOKEN"] || "";
export const CALLBACK_IS_PROD = process.env["NODE_ENV"] === "production";

if (CALLBACK_IS_PROD && !CALLBACK_TOKEN) {
  throw new Error(
    "MIZI_MEM_TOKEN must be set in production to protect the instance status callback endpoint",
  );
}
if (!CALLBACK_TOKEN) {
  logger.warn("[sessions] MIZI_MEM_TOKEN not set — instance status callback is unauthenticated (dev mode only)");
}

export const FAILURE_DEFAULT_MESSAGES: Record<string, string> = {
  provisioning_failed:   "Container provisioning failed before services came up",
  download_failed:       "Model weight download failed after retries",
  download_stalled:      "Model download stalled — host network or HuggingFace unreachable",
  vllm_warmup_failed:    "vLLM did not respond to /health within the warmup window",
  skills_compile_failed: "Smart Skills bundle failed to compile",
  disk_full:             "Host ran out of disk space — destroy and retry on a different machine",
};

export const INSTANCE_STATUS_MAP: Record<string, { status: typeof sessionsTable.$inferSelect["status"]; statusMessage: string }> = {
  services_ready:   { status: "starting",    statusMessage: "Tools ready — LLM model loading in background..." },
  downloading:      { status: "downloading", statusMessage: "Downloading model weights..." },
  starting_llm:     { status: "starting",    statusMessage: "NIM proxy ready — waiting for Theia to start..." },
  skills_compiling: { status: "starting",    statusMessage: "Compiling Smart Skills bundle..." },
  skills_ready:     { status: "starting",    statusMessage: "Smart Skills loaded — LLM loading in background..." },
  llm_ready:        { status: "ready",       statusMessage: "Session is ready" },
  theia_ready:      { status: "ready",       statusMessage: "Theia IDE is ready — open your coding environment!" },
  ...Object.fromEntries(
    Object.entries(FAILURE_DEFAULT_MESSAGES).map(([cause, human]) => [
      cause,
      { status: "error" as const, statusMessage: `boot_failure:${cause}: ${human}` },
    ]),
  ),
};

export const MEM_USER_ID = process.env["MIZI_MEM_USER_ID"] || "operator";

export const RESTORE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

export const FILE_SIZE_LIMIT_BYTES = 512 * 1024; // 500 KB read guard

export const WORKSPACE_ROOT = "/workspace";

export const PLAN_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export async function syncSessionFromVastai(session: typeof sessionsTable.$inferSelect): Promise<typeof sessionsTable.$inferSelect> {
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

    const actualCostPerHour = instance.dph_total ?? instance.dph_base ?? null;
    const vastCumulativeCost = instance.cost_run_time ?? null;

    logger.info(
      { sessionId: session.id, vastInstanceId: session.vastInstanceId, vastStatus, rawStatusMsg, theiaUrl: urls.theiaUrl, llmProxyUrl: urls.llmProxyUrl, dph_total: actualCostPerHour, cost_run_time: vastCumulativeCost },
      "Vast.ai sync — raw values"
    );

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
        if (!["downloading", "starting", "ready"].includes(status)) {
          status = "starting";
        }
        statusMessage = session.statusMessage || (rawStatusMsg ? `Starting... (${rawStatusMsg})` : "Services starting up...");

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
    const costPerHourFinal = actualCostPerHour ?? session.costPerHour ?? 0;
    const totalCost = vastCumulativeCost != null
      ? Math.round(vastCumulativeCost * 1000) / 1000
      : Math.round(costPerHourFinal * hoursRunning * 1000) / 1000;

    let updatedTeamMembers = session.teamMembers as TeamMemberRecord[] | null;
    const baseIdeUrl = (urls.theiaUrl || session.theiaUrl || "").replace(/\/$/, "");
    if (updatedTeamMembers && baseIdeUrl) {
      updatedTeamMembers = updatedTeamMembers.map((m) => ({
        ...m,
        ideUrl: m.ideUrl || `${baseIdeUrl}${m.path}`,
      }));
    }

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

// ── Caches & subscriber maps ─────────────────────────────────────────────────────

export const planCache = new Map<number, { snapshot: PlanSnapshot; receivedAt: number }>();
export const planSseSubscribers = new Map<number, Set<(snapshot: PlanSnapshot) => void>>();

export const swarmCache = new Map<number, { snapshot: SwarmSnapshot; receivedAt: number }>();
export const swarmSseSubscribers = new Map<number, Set<(snapshot: SwarmSnapshot) => void>>();

export const softInterruptQueues = new Map<number, SoftInterruptMessage[]>();
export const softInterruptSseSubscribers = new Map<number, Set<(msg: SoftInterruptMessage) => void>>();

const _workspaceProxies = new Map<string, ProxyRequestHandler>();

// ── Internal functions ───────────────────────────────────────────────────────────

export function generatePassword(length = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = randomBytes(length);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

export function sanitizeMemberName(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  if (!SAFE_NAME_RE.test(cleaned)) return null;
  if (RESERVED_NAMES.has(cleaned)) return null;
  return cleaned;
}

export function redactOwnerToken<T extends { ownerToken?: string | null }>(
  session: T
): Omit<T, "ownerToken"> {
  const { ownerToken: _redacted, ...rest } = session;
  return rest;
}

export function buildFailureStatusMessage(cause: string, suppliedMessage: string | undefined): string {
  const trimmed = suppliedMessage?.trim();
  const human = trimmed && trimmed.length > 0 ? trimmed : (FAILURE_DEFAULT_MESSAGES[cause] ?? cause);
  return `boot_failure:${cause}: ${human}`;
}

export function getSoftInterruptMessages(sessionId: number): SoftInterruptMessage[] {
  return softInterruptQueues.get(sessionId) ?? [];
}

export function broadcastSoftInterruptUpdate(sessionId: number, msg: SoftInterruptMessage) {
  const subs = softInterruptSseSubscribers.get(sessionId);
  if (!subs || subs.size === 0) return;
  for (const cb of subs) {
    try { cb(msg); } catch { /* ignore broken pipe */ }
  }
}

/**
 * Validate that a path is safe: no traversal components, absolute, and
 * strictly within /workspace.
 */
export function validateWorkspacePath(rawPath: string): void {
  if (!rawPath || rawPath.includes("..") || !rawPath.startsWith("/")) {
    throw Object.assign(new Error("Invalid path"), { code: 400 });
  }
  const normalized = rawPath.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(WORKSPACE_ROOT + "/")) {
    throw Object.assign(new Error("Path must be within /workspace"), { code: 400 });
  }
}

/**
 * Verify a caller-supplied token against the session's ownerToken and, for
 * read access, team-member passwords.  Returns the authorization level or
 * throws with code 401/403/404.
 */
export async function verifyFileToken(
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
 * Dispatch a shell command via the first available bridge for the session and
 * collect the full stdout.  Returns the raw stdout string, or throws with a
 * human-readable error if the bridge is unavailable or the exec fails.
 */
export async function execViaBridge(
  sessionId: number,
  command: string,
  timeoutMs = 15_000,
): Promise<string> {
  const bridge = getBridgeForSession(sessionId);
  if (!bridge) {
    throw Object.assign(new Error("Bridge not connected — session container is unreachable"), { code: 503 });
  }

  const { ws, laneId } = bridge;

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

// ── Exported functions ───────────────────────────────────────────────────────────

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
            const ws = getBridge(sessionId, 0);
            if (ws && ws.readyState === ws.OPEN) {
              try {
                ws.send(JSON.stringify({ type: "shell", cmd: `dropdb -U postgres --if-exists "${resource.resourceId}" 2>/dev/null || true` }));
              } catch {
                logger.warn({ sessionId, dbName: resource.resourceId }, "Failed to send dropdb via bridge (non-fatal)");
              }
            }
          } else {
            neonService.deleteBranch(resource.resourceId).catch((err: unknown) => {
              logger.warn({ err, resourceId: resource.resourceId, sessionId }, "Failed to delete Neon branch (non-fatal)");
            });
          }
        }
      } else if (resource.type === "redis") {
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
      } else if (resource.type === "storage") {
        if (resource.resourceId) {
          tigrisService.deleteBucket(resource.resourceId).catch((err: unknown) => {
            logger.warn({ err, resourceId: resource.resourceId, sessionId }, "Failed to delete Tigris bucket (non-fatal)");
          });
        }
      }
    }

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
 * Returns (or creates) the http-proxy-middleware instance for a specific
 * workspace machine.  Proxies directly to the machine over Fly's 6PN private
 * network — no subprocess or tunnel needed since the API server container
 * already has WireGuard access to all machines in the workspace app.
 */
export function getWorkspaceProxy(machineId: string, workspaceApp: string): ProxyRequestHandler {
  const cached = _workspaceProxies.get(machineId);
  if (cached) return cached;

  const target = fly.getMachineProxyUrl(machineId, workspaceApp);
  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true,
    selfHandleResponse: true,
    on: {
      error: (err, _req, res) => {
        logger.warn({ err, machineId, target }, "Workspace proxy error");
        const r = res as { headersSent?: boolean; writeHead: (c: number, h: Record<string, string>) => void; end: (b: string) => void };
        if (!r.headersSent) {
          r.writeHead(502, { "Content-Type": "text/plain" });
          r.end("Workspace proxy unavailable — the machine may still be starting. Try again in a few seconds.");
        }
      },
      proxyRes: responseInterceptor(async (buffer, proxyRes, req) => {
        const contentType = String(proxyRes.headers["content-type"] ?? "");
        if (!contentType.includes("text/html") && !contentType.includes("javascript")) {
          return buffer;
        }

        const expressReq = req as import("express").Request;
        const basePath = (expressReq.baseUrl ?? "").replace(/\/$/, "");
        let body = buffer.toString("utf-8");

        body = body
          .replace(/(['"])\/(assets\/)/g, `$1${basePath}/assets/`)
          .replace(/(['"])\/favicon\.(svg|ico|png)/g, `$1${basePath}/favicon.$2`);

        return body;
      }),
    },
  });
  _workspaceProxies.set(machineId, proxy);
  return proxy;
}

/**
 * Evict a proxy from the cache and stop its fly proxy subprocess when a
 * machine is destroyed, so we don't hold stale connections or processes open.
 */
export function evictWorkspaceProxy(machineId: string): void {
  _workspaceProxies.delete(machineId);
  fly.stopMachineProxy(machineId);
}
