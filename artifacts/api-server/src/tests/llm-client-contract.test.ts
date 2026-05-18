/**
 * Unit tests for callLlm — verifies promptVersion is stamped in every log path.
 *
 * Tests the three observable log paths:
 *   success  → logger.debug  with promptVersion + hasContent
 *   HTTP err → logger.warn   with promptVersion + status
 *   no cfg   → logger.warn   with promptVersion, no debug call
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock nim-catalog so getLlmClientConfig resolves without real env vars ──────

vi.mock("../services/nim-catalog", () => ({
  getConfiguredProviders: vi.fn(() => ({ nvidia: true })),
  PROVIDER_CONFIG: {
    nvidia: { apiBase: "https://api.nim.test/v1", envKey: "NIM_TEST_API_KEY_UNIT" },
  },
}));

// ── Capture logger calls using vi.hoisted so the variable is available inside ──
// ── the vi.mock factory (which is hoisted to the top of the file by vitest). ───

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/logger", () => ({ logger: mockLogger }));

// ── Import subject under test (after mocks are hoisted) ───────────────────────

import { callLlm } from "../services/llm-client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFetchOk(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as typeof global.fetch;
}

function makeFetchEmpty() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [] }),
  }) as unknown as typeof global.fetch;
}

function makeFetchError(status: number) {
  return vi.fn().mockResolvedValue({ ok: false, status }) as unknown as typeof global.fetch;
}

describe("callLlm — promptVersion logging", () => {
  let savedFetch: typeof global.fetch;

  beforeEach(() => {
    savedFetch = global.fetch;
    process.env["NIM_TEST_API_KEY_UNIT"] = "test-api-key-unit";
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = savedFetch;
    delete process.env["NIM_TEST_API_KEY_UNIT"];
  });

  it("logs debug with promptVersion and hasContent=true on successful LLM response", async () => {
    global.fetch = makeFetchOk("  generated content  ");

    const result = await callLlm({
      messages: [{ role: "user", content: "Build a login page" }],
      promptVersion: "plan.generate@1.0.0",
      logTag: "test-plan",
    });

    expect(result).toBe("generated content");
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        promptVersion: "plan.generate@1.0.0",
        hasContent: true,
        tag: "test-plan",
      }),
      "[llm-client] LLM call succeeded",
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("logs debug with hasContent=false when LLM returns empty choices", async () => {
    global.fetch = makeFetchEmpty();

    const result = await callLlm({
      messages: [{ role: "user", content: "test" }],
      promptVersion: "memory.sidecarVerify@1.0.0",
    });

    expect(result).toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        promptVersion: "memory.sidecarVerify@1.0.0",
        hasContent: false,
      }),
      "[llm-client] LLM call succeeded",
    );
  });

  it("logs warn with promptVersion and status on HTTP error response", async () => {
    global.fetch = makeFetchError(429);

    const result = await callLlm({
      messages: [{ role: "user", content: "test" }],
      promptVersion: "plan.reassess@1.0.0",
      logTag: "test-reassess",
    });

    expect(result).toBeNull();
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        promptVersion: "plan.reassess@1.0.0",
        status: 429,
        tag: "test-reassess",
      }),
      "[llm-client] LLM request failed",
    );
  });

  it("logs warn and returns null when no LLM provider is configured", async () => {
    delete process.env["NIM_TEST_API_KEY_UNIT"];
    // Also clear the AI Integrations fallback so getLlmClientConfig returns null
    const savedBase = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    const savedKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    try {
      const result = await callLlm({
        messages: [{ role: "user", content: "test" }],
        promptVersion: "palette.intent@1.0.0",
      });

      expect(result).toBeNull();
      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ promptVersion: "palette.intent@1.0.0" }),
        "[llm-client] No LLM provider configured",
      );
    } finally {
      if (savedBase !== undefined) process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = savedBase;
      if (savedKey !== undefined) process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedKey;
    }
  });
});
