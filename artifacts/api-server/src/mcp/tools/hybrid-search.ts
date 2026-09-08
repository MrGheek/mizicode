import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  byteLength,
  externalizeIfLarge,
  getDefaultExternalizeStore,
  semanticFilterTerminal,
} from "../../services/hybrid-search.js";
import { logger } from "../../lib/logger.js";

export function registerHybridSearchTools(server: McpServer): void {
  server.registerTool("ctx_search", {
    description: "[Read] Recover previously externalized output (RFC 0001 externalize-big-output). Pass a `key` to recover the full blob verbatim from the store; otherwise pass a `query` (optionally scoped to a `source`) to search the stored blobs line-wise and return snippets. Use this to re-read large tool output instead of re-executing the command.",
    inputSchema: z.object({
      key: z.string().optional().describe("Externalized blob key; recovered verbatim"),
      source: z.string().optional().describe("Restrict search to blobs with this source label"),
      query: z.string().optional().describe("Substring to search for within stored blobs"),
      limit: z.number().int().min(1).max(20).optional().describe("Max snippets (default 8)"),
    }),
  }, async ({ key, source, query, limit }) => {
    const store = getDefaultExternalizeStore();
    try {
      if (key) {
        const content = await store.get(key);
        if (content === null) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `no externalized blob ${key}` }) }] };
        }
        const info = await store.info(key);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              key,
              source: info?.source ?? null,
              sizeBytes: info?.sizeBytes ?? byteLength(content),
              content,
            }),
          }],
        };
      }

      if (!query) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "pass `key` (verbatim) or `query` (search)" }) }] };
      }
      const hits = await store.search(query, { source, limit: limit ?? 8 });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, hits }, null, 2) }] };
    } catch (err) {
      logger.warn({ err }, "[ctx_search] failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }] };
    }
  });

  server.registerTool("externalize_output", {
    description: "[Write] Store oversized tool/grep/read output verbatim and return a pointer the model can `ctx_search` later, instead of holding the raw bytes in context. Output above the threshold (100 KB; 25 KB when `intentScoped`) is externalized and a pointer with `bytesAvoided` is returned. Smaller output is returned unchanged.",
    inputSchema: z.object({
      source: z.string().describe("Source label, e.g. `grep:src`, `read:package.json`, `cmd:test`"),
      content: z.string().describe("Raw output content"),
      intentScoped: z.boolean().optional().describe("Use the lower 25 KB intent-scoped threshold (default false)"),
      thresholdBytes: z.number().int().positive().optional().describe("Explicit threshold override"),
    }),
  }, async ({ source, content, intentScoped, thresholdBytes }) => {
    try {
      const decision = await externalizeIfLarge({ source, content, intentScoped, thresholdBytes });
      return { content: [{ type: "text", text: JSON.stringify(decision, null, 2) }] };
    } catch (err) {
      logger.warn({ err }, "[externalize_output] failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }] };
    }
  });

  server.registerTool("filter_terminal_output", {
    description: "[Write] Condense shell/test/lint output for the LLM (RFC 0001 RTK-pattern): collapses passing-test runs to counts, elides repeated separator runs, dedups consecutive duplicate lines — while preserving exit codes, `path:line` refs, signatures, imports, and failure details. The full unfiltered output is persisted for tee-recovery (re-read via ctx_search with the returned originalKey) so a failed run never needs re-executing.",
    inputSchema: z.object({
      output: z.string().describe("Full raw terminal/CI/test output"),
      source: z.string().describe("Source label, e.g. `claw:job-42:test`, `swarm:lint` (used as the tee-recovery key namespace)"),
    }),
  }, async ({ output, source }) => {
    try {
      const result = await semanticFilterTerminal(output, { source });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            condensed: result.condensed,
            stats: result.stats,
            preserved: result.preserved,
            originalKey: result.originalKey,
            pointer: result.pointer,
          }, null, 2),
        }],
      };
    } catch (err) {
      logger.warn({ err }, "[filter_terminal_output] failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }] };
    }
  });
}