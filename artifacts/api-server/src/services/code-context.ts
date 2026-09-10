/**
 * code-context.ts — Repo-graph context loader for prompt sites (RFC 0001).
 *
 * Thin wrapper over routes/repo.ts codeContextForTask() that:
 *   - lazy-imports the route module so services never create a static cycle
 *     (same pattern as mcp/tools/repo.ts trigger_repo_index),
 *   - returns "" when there is no session / no indexed graph, so callers can
 *     inject the optional prompt section unconditionally,
 *   - appends a compact budget/coverage footer so the receiving model knows
 *     how much of the graph it is seeing.
 */

import { logger } from "../lib/logger";

export async function loadCodeContextBlock(
  sessionId: number | null | undefined,
  query: string,
  budgetTokens = 600,
  opts: { taskText?: string; seedFiles?: string[] } = {},
): Promise<string> {
  if (!sessionId) return "";
  try {
    const { codeContextForTask } = await import("../routes/repo.js");
    const ctx = await codeContextForTask(sessionId, query, { budgetTokens, taskText: opts.taskText, seedFiles: opts.seedFiles });
    if (!ctx || ctx.signatures.length === 0) return "";
    return [
      ...ctx.signatures,
      `(~${ctx.estimatedTokens} tokens; ${ctx.symbolsIncluded}/${ctx.totalSymbolsIndexed} symbols from the repo graph)`,
    ].join("\n");
  } catch (err) {
    logger.debug({ err, sessionId }, "[code-context] Repo graph context unavailable — skipping prompt section");
    return "";
  }
}