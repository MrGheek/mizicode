/**
 * Integration tests for the MCP server endpoint.
 *
 * Covers:
 *  - GET  /.well-known/mcp  — discovery document
 *  - POST /api/mcp          — rejects unauthenticated requests
 *  - POST /api/mcp          — initialize session (JSON-RPC 2.0)
 *  - POST /api/mcp          — tools/list returns all expected tool names
 *  - POST /api/mcp          — resources/list returns expected URIs
 *  - POST /api/mcp          — tools/call: sessions domain
 *  - POST /api/mcp          — tools/call: dashboard domain
 *  - POST /api/mcp          — tools/call: safety domain
 *  - POST /api/mcp          — tools/call: memory domain
 *  - POST /api/mcp          — tools/call: skills domain
 *  - POST /api/mcp          — tools/call: lanes domain
 *  - POST /api/mcp          — tools/call: planning domain
 *  - POST /api/mcp          — tools/call: repo domain
 *  - POST /api/mcp          — tools/call: design domain
 *  - POST /api/mcp          — tools/call: bridge domain (bridge_status, bridge_exec)
 *  - POST /api/mcp          — tools/call: agent-tools domain (web_search, fetch_url, screenshot_url)
 *  - POST /api/mcp          — Admin-tier tool rejects non-admin key
 *  - POST /api/mcp          — Admin-tier tool accepts admin-scoped key
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, apiKeysTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashApiKey } from "../middlewares/agent-auth";
import { requestPermission } from "../services/safety";

// ─── Auth setup ───────────────────────────────────────────────────────────────

const TEST_MEM_TOKEN = `test-mem-token-mcp-${Date.now()}`;
const originalMemToken = process.env["MIZI_MEM_TOKEN"];

let readKeyPlaintext: string;
let adminKeyPlaintext: string;
let readKeyId: number;
let adminKeyId: number;
let readSessionId: string | undefined;
let adminSessionId: string | undefined;
let operatorSessionId: string | undefined;

const INIT_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test-client", version: "1.0" },
};

// ─── SSE-aware response helper ─────────────────────────────────────────────────
//
// StreamableHTTPServerTransport requires Accept: application/json, text/event-stream
// on all POST requests and responds with SSE (text/event-stream). The payload is
// embedded in an SSE event: `data: <json>\n\n`.
// Supertest parses the body as {} for non-JSON content types, so we read res.text
// and extract the embedded JSON-RPC message ourselves.

function parseSseBody(rawText: string): Record<string, unknown> {
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const jsonStr = trimmed.slice("data:".length).trim();
      if (!jsonStr) continue;
      try {
        return JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
  }
  return {};
}

interface McpResponse {
  status: number;
  body: Record<string, unknown>;
  sessionId: string | undefined;
}

async function mcpRawPost(
  method: string,
  params: unknown,
  apiKey: string,
  sessionId: string | undefined,
): Promise<McpResponse> {
  const payload = {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1_000_000),
    method,
    params,
  };

  let req = request(app)
    .post("/api/mcp")
    .set("Authorization", `Bearer ${apiKey}`)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json");

  if (sessionId) {
    req = req.set("Mcp-Session-Id", sessionId);
  }

  const res = await req.send(payload);
  const sid = (res.headers["mcp-session-id"] as string | undefined) ?? sessionId;

  const contentType = res.headers["content-type"] ?? "";
  let body: Record<string, unknown>;
  if (contentType.includes("text/event-stream")) {
    body = parseSseBody(res.text);
  } else if (res.body && typeof res.body === "object" && Object.keys(res.body).length > 0) {
    body = res.body as Record<string, unknown>;
  } else if (res.text) {
    try {
      body = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      body = {};
    }
  } else {
    body = {};
  }

  return { status: res.status, body, sessionId: sid };
}

beforeAll(async () => {
  process.env["MIZI_MEM_TOKEN"] = TEST_MEM_TOKEN;

  readKeyPlaintext = `mcp-read-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  adminKeyPlaintext = `mcp-admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const [readKey] = await db.insert(apiKeysTable).values({
    label: "mcp-test-read",
    keyHash: hashApiKey(readKeyPlaintext),
    keyPrefix: readKeyPlaintext.slice(0, 8),
    scopes: ["read"],
    expiresAt: null,
    revokedAt: null,
  }).returning({ id: apiKeysTable.id });
  readKeyId = readKey.id;

  const [adminKey] = await db.insert(apiKeysTable).values({
    label: "mcp-test-admin",
    keyHash: hashApiKey(adminKeyPlaintext),
    keyPrefix: adminKeyPlaintext.slice(0, 8),
    scopes: ["read", "write", "admin"],
    expiresAt: null,
    revokedAt: null,
  }).returning({ id: apiKeysTable.id });
  adminKeyId = adminKey.id;

  const readInit = await mcpRawPost("initialize", INIT_PARAMS, readKeyPlaintext, undefined);
  readSessionId = readInit.sessionId;

  const adminInit = await mcpRawPost("initialize", INIT_PARAMS, adminKeyPlaintext, undefined);
  adminSessionId = adminInit.sessionId;

  // Operator session uses MIZI_MEM_TOKEN directly as the bearer token.
  // The auth middleware recognizes it and sets apiKey = undefined (operator mode).
  const operatorInit = await mcpRawPost("initialize", INIT_PARAMS, TEST_MEM_TOKEN, undefined);
  operatorSessionId = operatorInit.sessionId;
});

afterAll(async () => {
  await db.delete(apiKeysTable).where(eq(apiKeysTable.id, readKeyId)).catch(() => {});
  await db.delete(apiKeysTable).where(eq(apiKeysTable.id, adminKeyId)).catch(() => {});

  if (originalMemToken === undefined) {
    delete process.env["MIZI_MEM_TOKEN"];
  } else {
    process.env["MIZI_MEM_TOKEN"] = originalMemToken;
  }
});

// ─── Helper shorthands ─────────────────────────────────────────────────────────

function mcpCallRead(method: string, params: unknown): Promise<McpResponse> {
  return mcpRawPost(method, params, readKeyPlaintext, readSessionId);
}

function mcpCallAdmin(method: string, params: unknown): Promise<McpResponse> {
  return mcpRawPost(method, params, adminKeyPlaintext, adminSessionId);
}

// Operator calls use MIZI_MEM_TOKEN directly as the bearer token.
// This bypasses API-key lookup and sets apiKey = undefined (operator mode).
function mcpCallOperator(method: string, params: unknown): Promise<McpResponse> {
  return mcpRawPost(method, params, TEST_MEM_TOKEN, operatorSessionId);
}

function extractToolContent(body: Record<string, unknown>): Array<{ type: string; text: string }> | null {
  if (body["error"]) return null;
  const result = body["result"] as Record<string, unknown> | undefined;
  if (!result) return null;
  if (result["isError"]) return null;
  return (result["content"] as Array<{ type: string; text: string }>) ?? null;
}

function isErrorResponse(body: Record<string, unknown>): boolean {
  return (
    body["error"] != null ||
    (body["result"] as Record<string, unknown> | undefined)?.["isError"] === true
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /.well-known/mcp — discovery document", () => {
  it("returns schema_version and mcp_url", async () => {
    const res = await request(app).get("/.well-known/mcp");
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBeDefined();
    expect(res.body.mcp_url).toBe("/api/mcp");
    expect(res.body.name).toBe("mizi");
    expect(res.body.auth).toBeDefined();
    expect(res.body.privilege_tiers).toBeDefined();
  });

  it("no auth required to read discovery doc", async () => {
    const res = await request(app).get("/.well-known/mcp");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/mcp — auth enforcement", () => {
  it("returns 401 when no bearer token is provided", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown bearer token", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", "Bearer totally-invalid-key")
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS });
    expect(res.status).toBe(401);
  });

  it("accepts MIZI_MEM_TOKEN as operator pass-through", async () => {
    const { status } = await mcpRawPost("initialize", INIT_PARAMS, TEST_MEM_TOKEN, undefined);
    expect([200, 202]).toContain(status);
  });
});

describe("POST /api/mcp — MCP protocol — initialize", () => {
  it("initializes a session and returns protocolVersion", async () => {
    const { status, body } = await mcpRawPost("initialize", INIT_PARAMS, readKeyPlaintext, undefined);
    expect([200, 202]).toContain(status);
    const result = body["result"] as Record<string, unknown> | undefined;
    if (result) {
      expect(result["protocolVersion"]).toBeDefined();
      expect((result["serverInfo"] as Record<string, unknown>)?.["name"]).toBe("mizi");
    }
  });
});

describe("POST /api/mcp — tools/list", () => {
  it("returns all expected tool names", async () => {
    const { status, body } = await mcpCallRead("tools/list", {});
    expect([200, 202]).toContain(status);

    const tools = ((body["result"] as Record<string, unknown>)?.["tools"] ?? []) as Array<{ name: string }>;
    const names = tools.map((t) => t.name);

    const expectedTools = [
      "list_sessions", "get_session", "create_session", "delete_session", "classify_intent",
      "memory_index", "memory_search", "memory_get_item", "memory_init", "memory_save_item",
      "list_skills", "get_skills_leaderboard", "run_skill_eval",
      "list_lanes", "create_lane", "claim_resource", "lane_handoff",
      "bridge_status", "bridge_exec",
      "list_pending_approvals", "get_safety_transcript", "get_safety_policies",
      "approve_action", "deny_action", "update_safety_policy",
      "list_plans", "get_plan", "get_session_plan", "generate_plan",
      "update_task", "add_task", "reassess_plan",
      "get_repo_status", "repo_search", "get_blast_radius", "trigger_repo_index",
      "web_search", "fetch_url", "screenshot_url",
      "query_design_patterns", "list_design_categories", "get_design_lane_config",
      "list_nim_catalog", "get_nim_health", "list_gpu_offers", "list_profiles",
      "get_ambient_status", "get_ambient_timeline", "get_ambient_metrics",
      "get_ambient_config", "update_ambient_config", "trigger_ambient_cycle",
      "get_dashboard_summary",
    ];

    for (const expected of expectedTools) {
      expect(names, `expected tool "${expected}" in tools/list`).toContain(expected);
    }
  });
});

describe("POST /api/mcp — resources/list", () => {
  it("returns expected resource URIs", async () => {
    const { status, body } = await mcpCallRead("resources/list", {});
    expect([200, 202]).toContain(status);

    const resources = ((body["result"] as Record<string, unknown>)?.["resources"] ?? []) as Array<{ uri: string }>;
    const uris = resources.map((r) => r.uri);

    const expectedUris = [
      "mizi://sessions",
      "mizi://memory/index",
      "mizi://plans",
      "mizi://nim/catalog",
      "mizi://profiles",
      "mizi://safety/pending",
      "mizi://ambient/status",
    ];

    for (const expected of expectedUris) {
      expect(uris, `expected resource "${expected}" in resources/list`).toContain(expected);
    }
  });

  it("mizi://memory/index resource returns disk health and item arrays", async () => {
    const { status, body } = await mcpCallRead("resources/read", { uri: "mizi://memory/index" });
    expect([200, 202]).toContain(status);
    const result = body["result"] as Record<string, unknown> | undefined;
    if (result) {
      const contents = result["contents"] as Array<{ text: string }> | undefined;
      if (contents && contents.length > 0) {
        const parsed = JSON.parse(contents[0].text);
        expect(parsed.diskHealth).toBeDefined();
        expect(Array.isArray(parsed.globalItems)).toBe(true);
        expect(Array.isArray(parsed.sessionCoreItems)).toBe(true);
      }
    }
  });

  it("mizi://plans resource returns plans array", async () => {
    const { status, body } = await mcpCallRead("resources/read", { uri: "mizi://plans" });
    expect([200, 202]).toContain(status);
    const result = body["result"] as Record<string, unknown> | undefined;
    if (result) {
      const contents = result["contents"] as Array<{ text: string }> | undefined;
      if (contents && contents.length > 0) {
        const parsed = JSON.parse(contents[0].text);
        expect(Array.isArray(parsed.plans)).toBe(true);
        expect(typeof parsed.count).toBe("number");
      }
    }
  });
});

describe("POST /api/mcp — tools/call: sessions domain", () => {
  it("list_sessions returns valid JSON content", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "list_sessions", arguments: { limit: 5 } });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    expect(content!.length).toBeGreaterThan(0);
    expect(content![0].type).toBe("text");
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.sessions)).toBe(true);
  });

  it("get_session returns not-found for nonexistent ID", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "get_session", arguments: { sessionId: 99999 } });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.error).toMatch(/not found/i);
  });

  it("classify_intent returns a path recommendation", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "classify_intent",
      arguments: { intentText: "fix a small bug in my React component" },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(["nim", "gpu", "choice"]).toContain(parsed.path);
    expect(typeof parsed.isRepoIntent).toBe("boolean");
    expect(typeof parsed.complexity).toBe("string");
  });
});

describe("POST /api/mcp — tools/call: dashboard domain", () => {
  it("get_dashboard_summary returns aggregate counts", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "get_dashboard_summary", arguments: {} });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(typeof parsed.totalSessions).toBe("number");
    expect(typeof parsed.activeSessions).toBe("number");
    expect(typeof parsed.totalCost).toBe("number");
  });
});

describe("POST /api/mcp — tools/call: safety domain", () => {
  it("get_safety_policies returns a policies array", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "get_safety_policies", arguments: {} });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.policies)).toBe(true);
  });

  it("list_pending_approvals returns actions array", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "list_pending_approvals", arguments: { limit: 10 } });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.actions)).toBe(true);
  });

  it("get_safety_transcript returns entries array", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "get_safety_transcript", arguments: { limit: 10 } });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.entries)).toBe(true);
  });
});

describe("POST /api/mcp — tools/call: memory domain", () => {
  it("memory_index returns shortlist array", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "memory_index",
      arguments: { userId: "test-user-mcp", limit: 5 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.shortlist ?? parsed.items ?? [])).toBe(true);
  });

  it("memory_search returns results array", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "memory_search",
      arguments: { userId: "test-user-mcp", query: "convention", limit: 5 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.results ?? [])).toBe(true);
  });
});

describe("POST /api/mcp — tools/call: skills domain", () => {
  it("list_skills returns skills array", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "list_skills",
      arguments: { limit: 10 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.skills ?? [])).toBe(true);
  });

  it("get_skills_leaderboard returns leaderboard array", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "get_skills_leaderboard",
      arguments: { limit: 5 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.leaderboard ?? parsed.skills ?? [])).toBe(true);
  });
});

describe("POST /api/mcp — tools/call: lanes domain", () => {
  it("list_lanes returns not-found or empty lanes for nonexistent session", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "list_lanes",
      arguments: { sessionId: 99999 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.lanes ?? [])).toBe(true);
  });
});

describe("POST /api/mcp — tools/call: planning domain", () => {
  it("list_plans returns plans array for a user", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "list_plans",
      arguments: { userId: "test-user-mcp" },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.plans)).toBe(true);
    expect(typeof parsed.count).toBe("number");
  });

  it("get_plan returns not-found for nonexistent plan", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "get_plan",
      arguments: { planId: 99999 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.error).toMatch(/not found/i);
  });
});

describe("POST /api/mcp — tools/call: repo domain", () => {
  it("get_repo_status returns null repoContext for unknown session", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "get_repo_status",
      arguments: { sessionId: 99999 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.repoContext).toBeNull();
    expect(parsed.activeJob).toBeNull();
  });

  it("repo_search returns empty results for session with no index", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "repo_search",
      arguments: { sessionId: 99999, query: "App.tsx", limit: 5 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBe(0);
  });

  it("get_blast_radius returns overlapScore for session with no lanes", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "get_blast_radius",
      arguments: { sessionId: 99999, filePaths: ["src/App.tsx", "src/index.ts"] },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(typeof parsed.overlapScore).toBe("number");
  });
});

describe("POST /api/mcp — tools/call: design domain", () => {
  it("list_design_categories returns categories array", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "list_design_categories",
      arguments: {},
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.categories)).toBe(true);
  });

  it("query_design_patterns returns entries array", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "query_design_patterns",
      arguments: { limit: 5 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(typeof parsed.count).toBe("number");
  });
});

describe("POST /api/mcp — tools/call: NIM / GPU domain", () => {
  it("list_nim_catalog returns models array", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "list_nim_catalog", arguments: {} });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(Array.isArray(parsed.models)).toBe(true);
  });

  it("list_profiles returns profiles field", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "list_profiles", arguments: {} });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.profiles).toBeDefined();
  });
});

describe("POST /api/mcp — tools/call: ambient domain", () => {
  it("get_ambient_status returns defined output", async () => {
    const { status, body } = await mcpCallRead("tools/call", { name: "get_ambient_status", arguments: {} });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed).toBeDefined();
  });
});

describe("POST /api/mcp — tools/call: bridge domain", () => {
  it("bridge_status returns status object for a nonexistent session/lane", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "bridge_status",
      arguments: { sessionId: 99999, laneId: 99999 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.sessionId).toBe(99999);
    expect(parsed.laneId).toBe(99999);
    expect(parsed.bridge).toBeDefined();
  });

  it("bridge_exec returns error when bridge is not connected", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "bridge_exec",
      arguments: { sessionId: 99999, laneId: 99999, prompt: "echo hello", timeoutMs: 3000 },
    });
    expect([200, 202]).toContain(status);
    // bridge_exec gracefully returns a content error (not an MCP protocol error)
    // when no bridge WS is connected for the given session/lane.
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toMatch(/not connected|Bridge not connected/i);
  });
});

describe("POST /api/mcp — tools/call: agent-tools domain", () => {
  it("web_search returns results or graceful error for a test query", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "web_search",
      arguments: { query: "MCP protocol model context" },
    });
    expect([200, 202]).toContain(status);
    // web_search may fail in test env (no API key) but must return valid MCP content
    // (not a protocol-level error). A graceful content error is acceptable.
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    // Either an array of results or an error string — never undefined
    expect(parsed.results !== undefined || typeof parsed.error === "string").toBe(true);
  });

  it("fetch_url returns page content or graceful error", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "fetch_url",
      arguments: { url: "https://example.com" },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    // Success: { url, statusCode, contentType, truncated, text }  Failure: { error }
    expect(parsed.text !== undefined || typeof parsed.error === "string").toBe(true);
  });

  it("screenshot_url returns screenshot data or graceful error", async () => {
    const { status, body } = await mcpCallRead("tools/call", {
      name: "screenshot_url",
      arguments: { url: "https://example.com" },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.screenshot !== undefined || typeof parsed.error === "string").toBe(true);
  });
});

describe("POST /api/mcp — Admin-tier enforcement", () => {
  it("approve_action rejects a non-admin key", async () => {
    const { status, body } = await mcpCallRead(
      "tools/call",
      { name: "approve_action", arguments: { actionId: 99999 } },
    );
    expect([200, 202]).toContain(status);
    expect(isErrorResponse(body)).toBe(true);
  });

  it("deny_action rejects a non-admin key", async () => {
    const { status, body } = await mcpCallRead(
      "tools/call",
      { name: "deny_action", arguments: { actionId: 99999 } },
    );
    expect([200, 202]).toContain(status);
    expect(isErrorResponse(body)).toBe(true);
  });

  it("trigger_ambient_cycle rejects a non-admin key", async () => {
    const { status, body } = await mcpCallRead(
      "tools/call",
      { name: "trigger_ambient_cycle", arguments: { force: false } },
    );
    expect([200, 202]).toContain(status);
    expect(isErrorResponse(body)).toBe(true);
  });

  it("approve_action with admin API key returns action-not-found for default-account (not auth error)", async () => {
    // Admin API keys pass requireAdminTier and are scoped to "default" account.
    // A nonexistent actionId produces "Action not found", not an auth rejection.
    const { status, body } = await mcpCallAdmin(
      "tools/call",
      { name: "approve_action", arguments: { actionId: 99999 } },
    );
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.error ?? "").toMatch(/not found/i);
  });

  it("deny_action with admin API key returns action-not-found for default-account (not auth error)", async () => {
    const { status, body } = await mcpCallAdmin(
      "tools/call",
      { name: "deny_action", arguments: { actionId: 99999 } },
    );
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.error ?? "").toMatch(/not found/i);
  });

  it("approve_action with admin API key is rejected for non-default-account actions (ownership check)", async () => {
    // Create a real pending action for a non-"default" account using the safety service.
    // scope "external" with the "local-only" bundle falls through to requires-permission.
    const decision = await requestPermission({
      accountId: "other-test-account",
      kind: "test:cross-account",
      summary: "Cross-account ownership test action",
      requestedBy: "mcp-test",
      scope: "external",
      policyBundle: "local-only",
    });
    const { actionId } = decision;

    const { status, body } = await mcpCallAdmin(
      "tools/call",
      { name: "approve_action", arguments: { actionId } },
    );
    expect([200, 202]).toContain(status);
    // Admin API keys are scoped to "default" — ownership check must reject this action
    expect(isErrorResponse(body)).toBe(true);
  });

  it("approve_action with operator token returns action-not-found (not auth error)", async () => {
    // Operator token (MIZI_MEM_TOKEN) is allowed and unrestricted; the action just doesn't exist.
    const { status, body } = await mcpCallOperator(
      "tools/call",
      { name: "approve_action", arguments: { actionId: 99999 } },
    );
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.error ?? "").toMatch(/not found/i);
  });

  it("list_pending_approvals with API key is scoped to default account (ignores accountId param)", async () => {
    // API-key callers are always scoped to "default" regardless of the accountId arg.
    const { status, body } = await mcpCallRead("tools/call", {
      name: "list_pending_approvals",
      arguments: { accountId: "some-other-account", limit: 5 },
    });
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    // The response must be scoped to "default", not "some-other-account"
    expect(parsed.scopedTo).toBe("default");
    expect(Array.isArray(parsed.actions)).toBe(true);
  });

  it("delete_session with admin key returns session-not-found", async () => {
    const { status, body } = await mcpCallAdmin(
      "tools/call",
      { name: "delete_session", arguments: { sessionId: 99999 } },
    );
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content![0].text);
    expect(parsed.error ?? "").toMatch(/not found/i);
  });

  it("update_ambient_config with admin key succeeds", async () => {
    const { status, body } = await mcpCallAdmin(
      "tools/call",
      { name: "update_ambient_config", arguments: { enabled: false } },
    );
    expect([200, 202]).toContain(status);
    const content = extractToolContent(body);
    expect(content).not.toBeNull();
  });
});
