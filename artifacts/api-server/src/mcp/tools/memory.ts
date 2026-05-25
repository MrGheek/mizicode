import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  memoryIndex,
  memorySearch,
  memoryGet,
  initSession,
  saveMemoryItem,
  BUDGET_PROFILES_BY_MODE,
  SCOPE_PRIORITY,
  shapeItemForProfile,
} from "../../services/memory.js";
import type { MemoryType, MemoryScope } from "../../services/memory.js";

const VALID_MEMORY_TYPES: MemoryType[] = ["observation", "research", "session_summary", "convention", "guardrail", "note", "warning"];
const VALID_TOKEN_MODES = ["full", "core", "lean", "ultra"] as const;

export function registerMemoryTools(server: McpServer): void {
  server.registerTool("memory_index", {
    description: "[Read] Layer 1 token-efficient shortlist of the most relevant memory items for a user.",
    inputSchema: z.object({
      userId: z.string().describe("User ID to retrieve memory for"),
      tokenMode: z.enum(VALID_TOKEN_MODES).optional().describe("Token budget mode (default: core)"),
      scope: z.enum(SCOPE_PRIORITY as unknown as [string, ...string[]]).optional().describe("Filter by memory scope"),
      limit: z.number().int().min(1).max(100).optional().describe("Max items to return"),
    }),
  }, async ({ userId, tokenMode, scope, limit }) => {
    const mode = tokenMode ?? "core";
    const rawItems = memoryIndex({
      userId,
      scope: scope as MemoryScope | undefined,
      tokenMode: mode,
      limit,
    });
    const profile = BUDGET_PROFILES_BY_MODE[mode] || BUDGET_PROFILES_BY_MODE["core"];
    const items = rawItems.map(item => shapeItemForProfile(item, profile));
    return { content: [{ type: "text", text: JSON.stringify({ layer: 1, tokenMode: mode, items, count: items.length }, null, 2) }] };
  });

  server.registerTool("memory_search", {
    description: "[Read] Semantic/keyword search across project memories for a user.",
    inputSchema: z.object({
      userId: z.string().describe("User ID to search memory for"),
      query: z.string().describe("Search query"),
      tokenMode: z.enum(VALID_TOKEN_MODES).optional().describe("Token budget mode (default: core)"),
      scope: z.enum(SCOPE_PRIORITY as unknown as [string, ...string[]]).optional().describe("Filter by memory scope"),
      memoryType: z.enum(VALID_MEMORY_TYPES as unknown as [string, ...string[]]).optional().describe("Filter by memory type"),
      includeStale: z.boolean().optional().describe("Include stale items (default: false)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max items to return"),
    }),
  }, async ({ userId, query, tokenMode, scope, memoryType, includeStale, limit }) => {
    const mode = tokenMode ?? "core";
    const rawItems = memorySearch({
      userId,
      query,
      scope: scope as MemoryScope | undefined,
      memoryType: memoryType as MemoryType | undefined,
      tokenMode: mode,
      includeStale: includeStale ?? false,
      limit,
    });
    const profile = BUDGET_PROFILES_BY_MODE[mode] || BUDGET_PROFILES_BY_MODE["core"];
    const items = rawItems.map(item => shapeItemForProfile(item, profile));
    return { content: [{ type: "text", text: JSON.stringify({ layer: 2, tokenMode: mode, query, items, count: items.length }, null, 2) }] };
  });

  server.registerTool("memory_get_item", {
    description: "[Read] Full retrieval of a specific memory item by ID.",
    inputSchema: z.object({
      userId: z.string().describe("User ID who owns the item"),
      itemId: z.number().int().describe("Memory item ID"),
      escalate: z.boolean().optional().describe("Set true to escalate to Layer 3 access"),
    }),
  }, async ({ userId, itemId, escalate }) => {
    const item = memoryGet({ userId, itemId, tokenMode: "full", escalate: escalate ?? true });
    if (!item) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Memory item not found" }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ layer: 3, item }, null, 2) }] };
  });

  server.registerTool("memory_init", {
    description: "[Write] Initialize memory for a user/project session.",
    inputSchema: z.object({
      sessionId: z.string().describe("Session identifier"),
      userId: z.string().describe("User ID"),
      projectPath: z.string().optional().describe("Project file path (optional)"),
    }),
  }, async ({ sessionId, userId, projectPath }) => {
    initSession(sessionId, userId, projectPath ?? "");
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });

  server.registerTool("memory_save_item", {
    description: "[Write] Save a new observation to memory with conflict detection.",
    inputSchema: z.object({
      userId: z.string().describe("User ID"),
      content: z.string().describe("Memory content to save"),
      sessionId: z.string().optional().describe("Session ID (optional)"),
      memoryType: z.enum(VALID_MEMORY_TYPES as unknown as [string, ...string[]]).optional().describe("Type of memory (default: observation)"),
      scope: z.enum(SCOPE_PRIORITY as unknown as [string, ...string[]]).optional().describe("Memory scope"),
      symbolRef: z.string().optional().describe("Symbol reference (e.g. file path or function name)"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Additional metadata"),
    }),
  }, async ({ userId, content, sessionId, memoryType, scope, symbolRef, metadata }) => {
    const result = await saveMemoryItem({
      userId,
      content,
      sessionId,
      memoryType: (memoryType as MemoryType) ?? "observation",
      scope: scope as MemoryScope | undefined,
      symbolRef,
      metadata,
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          itemId: result.itemId,
          hasConflict: result.contradictions.length > 0,
          contradictionCount: result.contradictions.length,
          conflictGroupId: result.conflictGroupId,
        }, null, 2),
      }],
    };
  });
}
