import { z } from "zod";
import { db, sessionsTable, gpuProfilesTable, sessionLanesTable, laneClaimsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { randomBytes } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireAdminTier } from "../tier-check.js";
import type { ApiKeyRecord } from "../../middlewares/agent-auth.js";
import { logger } from "../../lib/logger.js";
import { getProfileById } from "../../services/profiles.js";

const ACTIVE_STATUSES = ["provisioning", "ready", "running", "degraded"] as const;

function generatePassword(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function registerSessionTools(server: McpServer, getApiKey: () => ApiKeyRecord | undefined): void {
  server.registerTool("list_sessions", {
    description: "[Read] List all sessions with status summaries.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
    }),
  }, async ({ limit }) => {
    const rows = await db
      .select({
        id: sessionsTable.id,
        status: sessionsTable.status,
        statusMessage: sessionsTable.statusMessage,
        provider: sessionsTable.provider,
        gpuName: sessionsTable.gpuName,
        numGpus: sessionsTable.numGpus,
        costPerHour: sessionsTable.costPerHour,
        totalCost: sessionsTable.totalCost,
        startedAt: sessionsTable.startedAt,
        stoppedAt: sessionsTable.stoppedAt,
        createdAt: sessionsTable.createdAt,
        profileName: gpuProfilesTable.displayName,
      })
      .from(sessionsTable)
      .leftJoin(gpuProfilesTable, eq(sessionsTable.profileId, gpuProfilesTable.id))
      .orderBy(desc(sessionsTable.createdAt))
      .limit(limit ?? 50);

    return { content: [{ type: "text", text: JSON.stringify({ sessions: rows, count: rows.length }, null, 2) }] };
  });

  server.registerTool("get_session", {
    description: "[Read] Get full details for one session by ID.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
    }),
  }, async ({ sessionId }) => {
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));
    if (!session) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Session not found" }) }] };
    }
    const { ownerToken: _redacted, ...safe } = session;
    return { content: [{ type: "text", text: JSON.stringify(safe, null, 2) }] };
  });

  server.registerTool("create_session", {
    description: "[Write] Declarative one-call session provisioning. Finds a GPU offer, creates a session record, inserts team lanes, and fires GPU provisioning asynchronously — equivalent to POST /api/sessions/orchestrate.",
    inputSchema: z.object({
      goal: z.string().describe("Natural language goal for the session"),
      profileId: z.number().int().describe("Hardware profile ID to provision on"),
      teamMembers: z.array(z.object({
        role: z.string().describe("Member role name (lowercase alphanumeric + hyphens)"),
        skills: z.array(z.string()).optional().describe("Skill IDs to activate for this member"),
        claimPaths: z.array(z.string()).optional().describe("File paths to pre-claim for this member"),
      })).describe("Team composition"),
      repoUrl: z.string().optional().describe("Git repository URL to clone at session start"),
    }),
  }, async ({ goal, profileId, teamMembers, repoUrl }) => {
    // esbuild constant-folds process.env.MIZI_DISTRIBUTION → "local" in local builds,
    // so `if (false) { ... }` dead-code eliminates this entire block including
    // dynamic imports — preventing vastai.ts content from appearing in local bundles.
    if (process.env.MIZI_DISTRIBUTION !== "local") {
      const vastai = await import("../../services/vastai.js");
      const profile = await getProfileById(profileId);
      if (!profile) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Profile ${profileId} not found` }) }] };
      }

      const searchParams = (profile.searchParams as Record<string, unknown>) ?? {};
      let selectedOfferId: number | undefined;
      const provider = "vastai" as const;

      {
        const offers = await vastai.searchOffers({
          gpu_name: searchParams["gpu_name"] as string | undefined,
          num_gpus: searchParams["num_gpus"] as number | undefined,
          min_gpu_ram: searchParams["min_gpu_ram"] as number | undefined,
          disk_space: profile.diskSizeGb,
          limit: 1,
        });
        if (!offers || offers.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "No GPU offers available for this profile. Try again later or choose a different profile." }) }] };
        }
        selectedOfferId = (offers[0] as { id: number }).id;
      }

      let repoFingerprintJson: Record<string, unknown> | null = null;
      if (repoUrl) {
        const { createHash } = await import("crypto");
        const urlHash = createHash("sha256").update(repoUrl.toLowerCase()).digest("hex").slice(0, 16);
        repoFingerprintJson = { url: repoUrl, branch: "main", urlHash, langs: [], frameworks: [], derivedAt: new Date().toISOString() };
      }

      const [session] = await db
        .insert(sessionsTable)
        .values({
          profileId: profile.id,
          vastOfferId: selectedOfferId ?? null,
          status: "provisioning",
          statusMessage: "MCP: GPU instance provisioning...",
          gpuName: profile.gpuName,
          numGpus: profile.numGpus,
          taskMode: "team",
          tokenMode: "core",
          repoFingerprintJson,
          intentText: goal.slice(0, 500),
          provider,
          ownerToken: generatePassword(32),
          hasGithubToken: !!repoUrl,
        })
        .returning();

      const sessionId = session.id;

      const now = new Date();
      const expiresAt = new Date(Date.now() + 4 * 3600 * 1000);

      const laneInserts = await Promise.all(
        teamMembers.map(async (member) => {
          const [lane] = await db.insert(sessionLanesTable).values({
            sessionId,
            memberIdentifier: member.role,
            laneType: "general",
            taskMode: "agent",
            status: "pending",
            tokenMode: "core",
            currentTask: goal.slice(0, 200),
          }).returning();
          return { lane, member };
        })
      );

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
            }).then(() => undefined)
          );
        }
      }
      await Promise.all(claimInserts);

      if (provider === "vastai" && selectedOfferId !== undefined) {
        const onstart = teamMembers.map((m) => `echo "lane:${m.role}"`).join(" && ");
        vastai.createInstance({
          offerId: selectedOfferId,
          image: profile.dockerImageTag,
          onstart,
          disk: profile.diskSizeGb,
          env: {
            NUM_GPUS: String(profile.numGpus),
          },
        }).then(async (result) => {
          const inst = result as { id?: number };
          if (inst?.id) {
            await db.update(sessionsTable)
              .set({ vastInstanceId: inst.id, status: "ready", statusMessage: "MCP: GPU instance ready", updatedAt: new Date() })
              .where(eq(sessionsTable.id, sessionId));
          }
        }).catch((err: unknown) => {
          logger.error({ err, sessionId }, "[MCP] create_session: vastai provisioning failed");
          db.update(sessionsTable)
            .set({ status: "error", statusMessage: "MCP: GPU provisioning failed", updatedAt: new Date() })
            .where(eq(sessionsTable.id, sessionId))
            .catch(() => undefined);
        });
      }

      logger.info({ sessionId, goal: goal.slice(0, 80), provider }, "[MCP] create_session: session provisioning initiated");

      const { ownerToken: _redacted, ...safeSession } = session;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            session: safeSession,
            lanes: laneInserts.map(({ lane, member }) => ({ id: lane.id, role: member.role })),
            message: "Session provisioning initiated. Poll get_session for status updates.",
          }, null, 2),
        }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ error: "create_session requires cloud distribution; use local session endpoints in local mode." }) }] };
  });

  server.registerTool("delete_session", {
    description: "[Admin] Tear down a session: destroys the GPU instance (Fly.io or Vast.ai), releases provisioned resources, and marks the session stopped. Requires admin scope.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID to delete"),
    }),
  }, async ({ sessionId }) => {
    requireAdminTier(getApiKey());
    // esbuild constant-folds process.env.MIZI_DISTRIBUTION → "local" in local builds,
    // so `if (false) { ... }` dead-code eliminates this entire block including
    // dynamic imports — preventing fly.ts/vastai.ts from appearing in local bundles.
    if (process.env.MIZI_DISTRIBUTION !== "local") {
      const fly = await import("../../services/fly.js");
      const vastai = await import("../../services/vastai.js");
      const { cleanupSessionResources } = await import("../../routes/sessions.js");

      const [session] = await db
        .select({
          id: sessionsTable.id,
          status: sessionsTable.status,
          flyMachineId: sessionsTable.flyMachineId,
          vastInstanceId: sessionsTable.vastInstanceId,
          provider: sessionsTable.provider,
        })
        .from(sessionsTable)
        .where(eq(sessionsTable.id, sessionId));

      if (!session) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Session not found" }) }] };
      }

      const teardownSteps: string[] = [];

      if (session.flyMachineId && ACTIVE_STATUSES.includes(session.status as typeof ACTIVE_STATUSES[number])) {
        try {
          await fly.destroyMachine(session.flyMachineId);
          teardownSteps.push("fly_machine_destroyed");
        } catch (err) {
          logger.warn({ err, sessionId, flyMachineId: session.flyMachineId }, "[MCP] delete_session: fly.destroyMachine failed (non-fatal)");
          teardownSteps.push("fly_machine_destroy_failed");
        }
      }

      if (session.vastInstanceId) {
        try {
          await vastai.destroyInstance(session.vastInstanceId);
          teardownSteps.push("vast_instance_destroyed");
        } catch (err) {
          logger.warn({ err, sessionId, vastInstanceId: session.vastInstanceId }, "[MCP] delete_session: vastai.destroyInstance failed (non-fatal)");
          teardownSteps.push("vast_instance_destroy_failed");
        }
      }

      await db.update(sessionsTable)
        .set({ status: "stopped", stoppedAt: new Date(), updatedAt: new Date() })
        .where(eq(sessionsTable.id, sessionId));
      teardownSteps.push("status_set_stopped");

      cleanupSessionResources(sessionId).catch((err: unknown) => {
        logger.warn({ err, sessionId }, "[MCP] delete_session: cleanupSessionResources failed (non-fatal)");
      });
      teardownSteps.push("resource_cleanup_enqueued");

      logger.info({ sessionId, teardownSteps }, "[MCP] Session torn down via delete_session tool");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, sessionId, teardownSteps }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ error: "delete_session requires cloud distribution." }) }] };
  });

  server.registerTool("classify_intent", {
    description: "[Read] Classify natural language intent into a routing recommendation (nim / gpu / choice) and detect repo context. Used to inform session creation.",
    inputSchema: z.object({
      intentText: z.string().describe("Natural language description of what the user wants to do"),
      repoUrl: z.string().optional().describe("Optional repository URL to factor into classification"),
      hasGitHubToken: z.boolean().optional().describe("Whether the user has a GitHub token configured"),
    }),
  }, async ({ intentText, repoUrl, hasGitHubToken }) => {
    const { listNimModels: lnm, getConfiguredProviders: gcp } = await import("../../services/nim-catalog.js");

    const models = await lnm();
    const configured = gcp();

    const GITHUB_URL_RE = /https?:\/\/(github|gitlab)\.com\/[\w.\-]+\/[\w.\-]+/i;
    const REPO_KEYWORD_RE = /\b(my repo|existing (repo|project|code|codebase)|working on|add to my|fix in my|in the repo|in my codebase|clone|connect.*repo|pull request|pr review|open pr|my (github|gitlab)|push to|commit to|branch|checkout)\b/i;
    const isRepoIntent = !!repoUrl || GITHUB_URL_RE.test(intentText) || REPO_KEYWORD_RE.test(intentText) || (!!(hasGitHubToken) && REPO_KEYWORD_RE.test(intentText));

    const complexity = /\b(large|full.?repo|entire|whole|complete|comprehensive|all|refactor|restructur|rewrite|migrat)\b/i.test(intentText) ? "deep"
      : /\b(quick|simple|small|minor|tiny|just|only|fast)\b/i.test(intentText) ? "quick"
      : "medium";

    const path = (complexity === "deep" || /\b(team|collab|pair|multi.?user)\b/i.test(intentText)) ? "gpu"
      : models.length > 0 ? "nim"
      : "choice";

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          path,
          isRepoIntent,
          complexity,
          availableModels: models.slice(0, 3).map(m => ({ nimModelId: m.nimModelId, displayName: m.displayName })),
          configured,
        }, null, 2),
      }],
    };
  });
}
