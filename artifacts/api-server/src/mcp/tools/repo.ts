import { z } from "zod";
import { db, repoGraphJobsTable, sessionRepoContextTable, sessionLanesTable, laneClaimsTable } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../../lib/logger.js";

const ACTIVE_JOB_STATUSES = ["queued", "running"] as const;

export function registerRepoTools(server: McpServer): void {
  server.registerTool("get_repo_status", {
    description: "[Read] Get indexing status for a session's repository.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
    }),
  }, async ({ sessionId }) => {
    const [ctx] = await db.select({
      id: sessionRepoContextTable.id,
      sessionId: sessionRepoContextTable.sessionId,
      repoPath: sessionRepoContextTable.repoPath,
      indexStatus: sessionRepoContextTable.indexStatus,
      isStale: sessionRepoContextTable.isStale,
      confidenceLevel: sessionRepoContextTable.confidenceLevel,
      updatedAt: sessionRepoContextTable.updatedAt,
    })
      .from(sessionRepoContextTable)
      .where(eq(sessionRepoContextTable.sessionId, sessionId))
      .orderBy(desc(sessionRepoContextTable.updatedAt))
      .limit(1);

    const [activeJob] = await db.select({ id: repoGraphJobsTable.id, status: repoGraphJobsTable.status })
      .from(repoGraphJobsTable)
      .where(and(
        eq(repoGraphJobsTable.sessionId, sessionId),
        inArray(repoGraphJobsTable.status, [...ACTIVE_JOB_STATUSES]),
      ))
      .limit(1);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          sessionId,
          repoContext: ctx ?? null,
          activeJob: activeJob ?? null,
        }, null, 2),
      }],
    };
  });

  server.registerTool("repo_search", {
    description: "[Read] Search the indexed repo graph for files/symbols matching a query. Searches the session's repo edge graph for file paths and symbols that match the given query string.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      query: z.string().describe("Search query (file path fragment or symbol name)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    }),
  }, async ({ sessionId, query, limit }) => {
    const maxResults = limit ?? 10;

    const [repoCtx] = await db
      .select({ edgesJson: sessionRepoContextTable.edgesJson })
      .from(sessionRepoContextTable)
      .where(eq(sessionRepoContextTable.sessionId, sessionId))
      .orderBy(desc(sessionRepoContextTable.updatedAt))
      .limit(1);

    if (!repoCtx?.edgesJson) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sessionId,
            query,
            results: [],
            message: "No repo index found for this session. Trigger repo indexing first with trigger_repo_index.",
          }, null, 2),
        }],
      };
    }

    const edges = repoCtx.edgesJson as Array<{ from: string; to: string }>;
    const lowerQuery = query.toLowerCase();

    const matchedPaths = new Set<string>();
    for (const edge of edges) {
      if (edge.from.toLowerCase().includes(lowerQuery)) matchedPaths.add(edge.from);
      if (edge.to.toLowerCase().includes(lowerQuery)) matchedPaths.add(edge.to);
      if (matchedPaths.size >= maxResults * 2) break;
    }

    const results = Array.from(matchedPaths).slice(0, maxResults).map((path) => {
      const deps = edges
        .filter((e) => e.from === path)
        .map((e) => e.to)
        .slice(0, 5);
      const dependents = edges
        .filter((e) => e.to === path)
        .map((e) => e.from)
        .slice(0, 5);
      return { path, deps, dependents };
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          sessionId,
          query,
          results,
          totalEdges: edges.length,
        }, null, 2),
      }],
    };
  });

  server.registerTool("get_blast_radius", {
    description: "[Read] Estimate the blast radius (affected files/lanes) of a proposed change by comparing changed file paths against active lane claims and the repo dependency graph.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      filePaths: z.array(z.string()).describe("File paths being changed"),
    }),
  }, async ({ sessionId, filePaths }) => {
    const { estimateBlastRadiusOverlap } = await import("../../services/lane-policy.js");

    const [repoCtx] = await db
      .select({ edgesJson: sessionRepoContextTable.edgesJson })
      .from(sessionRepoContextTable)
      .where(eq(sessionRepoContextTable.sessionId, sessionId))
      .orderBy(desc(sessionRepoContextTable.updatedAt))
      .limit(1);

    const repoEdges = repoCtx?.edgesJson
      ? (repoCtx.edgesJson as Array<{ from: string; to: string }>)
      : [];

    const lanes = await db
      .select({ id: sessionLanesTable.id, memberIdentifier: sessionLanesTable.memberIdentifier })
      .from(sessionLanesTable)
      .where(eq(sessionLanesTable.sessionId, sessionId));

    if (lanes.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sessionId,
            filePaths,
            overlapScore: 0,
            laneBreakdown: [],
            message: "No lanes found for this session.",
          }, null, 2),
        }],
      };
    }

    const laneIds = lanes.map((l) => l.id);
    const allClaims = await db
      .select({
        laneId: laneClaimsTable.laneId,
        pathOrSymbol: laneClaimsTable.pathOrSymbol,
      })
      .from(laneClaimsTable)
      .where(and(
        inArray(laneClaimsTable.laneId, laneIds),
        eq(laneClaimsTable.active, true),
      ));

    const claimsByLane = new Map<number, string[]>();
    for (const claim of allClaims) {
      const list = claimsByLane.get(claim.laneId) ?? [];
      list.push(claim.pathOrSymbol);
      claimsByLane.set(claim.laneId, list);
    }

    let maxScore = 0;
    const laneBreakdown = lanes.map((lane) => {
      const laneClaims = claimsByLane.get(lane.id) ?? [];
      const score = estimateBlastRadiusOverlap(filePaths, laneClaims, repoEdges);
      if (score > maxScore) maxScore = score;
      return { laneId: lane.id, role: lane.memberIdentifier, claimedFiles: laneClaims.length, overlapScore: score };
    });

    logger.info({ sessionId, filePaths, maxScore }, "[MCP] get_blast_radius computed");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          sessionId,
          filePaths,
          overlapScore: maxScore,
          laneBreakdown,
          repoEdgeCount: repoEdges.length,
        }, null, 2),
      }],
    };
  });

  server.registerTool("trigger_repo_index", {
    description: "[Write] Manually enqueue a re-index for a session's repository.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      repoPath: z.string().optional().describe("Repository path to index (default: /workspace)"),
    }),
  }, async ({ sessionId, repoPath }) => {
    const { autoEnqueueRepoIndexIfNeeded } = await import("../../routes/repo.js");
    try {
      await autoEnqueueRepoIndexIfNeeded(sessionId);
      logger.info({ sessionId, repoPath }, "[MCP] Repo index triggered");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, sessionId, message: "Repo indexing job enqueued" }) }] };
    } catch (err) {
      logger.error({ err, sessionId }, "[MCP] trigger_repo_index failed");
      return { content: [{ type: "text", text: JSON.stringify({ error: "Failed to enqueue repo index" }) }] };
    }
  });
}
