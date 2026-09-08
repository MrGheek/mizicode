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
    description: "[Read] Search the indexed repo graph for files/symbols/chunks using hybrid retrieval (lexical + semantic + graph centrality), then surface the PageRank dependency halo of the top hits. Returns ranked symbols with their snippets and `path:line` refs plus related files the task may touch.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      query: z.string().describe("Search query (natural language, symbol name, or file path fragment)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    }),
  }, async ({ sessionId, query, limit }) => {
    const maxResults = limit ?? 10;

    // Lazy import avoids a static routes→mcp cycle; routes/repo already exports
    // autoEnqueueRepoIndexIfNeeded for trigger_repo_index via the same pattern.
    const { searchRepoContext, codeContextForTask } = await import("../../routes/repo.js");
    const { pageRankFiles } = await import("../../services/repo-rank.js");

    const [repoCtx] = await db
      .select({
        edgesJson: sessionRepoContextTable.edgesJson,
        filesJson: sessionRepoContextTable.filesJson,
        indexStatus: sessionRepoContextTable.indexStatus,
      })
      .from(sessionRepoContextTable)
      .where(eq(sessionRepoContextTable.sessionId, sessionId))
      .orderBy(desc(sessionRepoContextTable.updatedAt))
      .limit(1);

    if (!repoCtx) {
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

    const search = await searchRepoContext(sessionId, query, { limit: maxResults });
    const topPaths = search.results.slice(0, 8).map((r) => r.path).filter(Boolean);

    // PageRank dependency halo seeded by the top hits: tells the model which
    // files around the relevant symbols it is likely to need.
    const ranks = pageRankFiles(
      (repoCtx.edgesJson ?? []) as Array<{ from: string; to: string }>,
      (repoCtx.filesJson ?? []) as Array<{ path?: string; centralityScore?: number; dependencyDegree?: number }>,
      topPaths,
    );
    const relatedFiles = Array.from(ranks.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, score]) => ({ path, pageRank: Number(score.toFixed(4)) }));

    // Compact per-hit context for the LLM (declaration + path:line), budget ~1200 tokens.
    const compact = await codeContextForTask(sessionId, query, { budgetTokens: 1200, topN: maxResults });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          sessionId,
          query,
          indexStatus: repoCtx.indexStatus || null,
          results: search.results.slice(0, maxResults).map((r) => ({
            type: r.type,
            name: r.name,
            kind: r.kind,
            path: r.path,
            line: r.line,
            snippet: r.snippet,
            score: Number(r.scores.combined.toFixed(4)),
          })),
          relatedFiles,
          compactContext: compact,
          total: search.total,
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
