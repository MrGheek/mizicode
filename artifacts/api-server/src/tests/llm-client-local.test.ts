import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLocalOllamaModelId,
  getLocalOllamaClientConfig,
  resolveLlmConfig,
  _resetLocalOllamaProbe,
} from "../services/llm-client";

const LIVE = { baseUrl: "http://localhost:11434/v1", apiKey: "ollama", provider: "ollama-local" };

// Force a deterministic hosted provider (replit path) so hosted fallbacks
// resolve without depending on the operator's NIM credentials.
process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "https://repl.it/v1";
process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key";
process.env["PLAN_LLM_MODEL"] = "meta/llama-3.3-70b-instruct";

function stubOllama(live: boolean): void {
  globalThis.fetch = vi.fn(async () => {
    if (!live) throw new Error("connection refused");
    return new Response("{}", { status: 200 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  _resetLocalOllamaProbe();
  delete process.env["OLLAMA_BASE_URL"];
});

describe("isLocalOllamaModelId", () => {
  it("recognizes routed-local candidates", () => {
    expect(isLocalOllamaModelId("qwen2.5-coder:7b")).toBe(true);
    expect(isLocalOllamaModelId("qwen2.5-coder:14b")).toBe(true);
    expect(isLocalOllamaModelId("llama3.1:8b")).toBe(true);
  });

  it("rejects hosted ids", () => {
    expect(isLocalOllamaModelId("meta/llama-3.3-70b-instruct")).toBe(false);
    expect(isLocalOllamaModelId("meta/llama-3.1-8b-instruct")).toBe(false);
  });
});

describe("getLocalOllamaClientConfig", () => {
  it("defaults to localhost:11434 when OLLAMA_BASE_URL is unset", () => {
    expect(getLocalOllamaClientConfig("qwen2.5-coder:7b")).toEqual({
      ...LIVE,
      model: "qwen2.5-coder:7b",
    });
  });

  it("honors OLLAMA_BASE_URL and strips trailing slashes", () => {
    process.env["OLLAMA_BASE_URL"] = "http://ollama.local:8080/";
    expect(getLocalOllamaClientConfig("llama3.1:8b").baseUrl).toBe("http://ollama.local:8080/v1");
  });
});

describe("resolveLlmConfig — local routing (RFC 0001 Layer 3)", () => {
  it("routes an explicit local candidate to the live daemon", async () => {
    stubOllama(true);
    const cfg = await resolveLlmConfig({ messages: [], overrideModel: "qwen2.5-coder:7b", taskClass: "quality" });
    expect(cfg).toEqual({ ...LIVE, model: "qwen2.5-coder:7b" });
  });

  it("falls back to the hosted default when an explicit local candidate is down", async () => {
    stubOllama(false);
    const cfg = await resolveLlmConfig({ messages: [], overrideModel: "llama3.1:8b" });
    // getLlmClientConfig(undefined) + PLAN_LLM_MODEL env → default hosted model.
    expect(cfg?.provider).toBe("replit");
    expect(cfg?.model).toBe("meta/llama-3.3-70b-instruct");
  });

  it("prefers a local coder model for cheap tasks when the daemon is live", async () => {
    stubOllama(true);
    const cfg = await resolveLlmConfig({ messages: [], taskClass: "cheap" });
    expect(cfg).toEqual({ ...LIVE, model: "qwen2.5-coder:7b" });
  });

  it("falls back to the hosted small model for cheap tasks when the daemon is down", async () => {
    stubOllama(false);
    const cfg = await resolveLlmConfig({ messages: [], taskClass: "cheap" });
    expect(cfg).toEqual({
      baseUrl: "https://repl.it/v1",
      apiKey: "test-key",
      model: "meta/llama-3.1-8b-instruct",
      provider: "replit",
    });
  });

  it("never sends a local candidate to a NIM provider", async () => {
    stubOllama(true);
    const cfg = await resolveLlmConfig({ messages: [], overrideModel: "qwen2.5-coder:14b" });
    expect(cfg?.provider).toBe("ollama-local");
  });

  it("lets a pinned override beat the cheap-task routing", async () => {
    stubOllama(true);
    const cfg = await resolveLlmConfig({ messages: [], overrideModel: "meta/llama-3.1-8b-instruct", taskClass: "cheap" });
    expect(cfg?.model).toBe("meta/llama-3.1-8b-instruct");
    expect(cfg?.provider).toBe("replit");
  });
});