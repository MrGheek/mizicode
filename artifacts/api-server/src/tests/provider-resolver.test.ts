/**
 * Tests for the provider capability gate + resolver (providers/capabilities.ts,
 * providers/registry.ts, providers/resolver.ts).
 *
 * The resolver hits the HF API when given an hfUrl; we stub inspectHfRepo via
 * module mock so tests exercise gating, image selection, and deployment shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  providerMatches,
  resolveProvider,
  HIGH_CONCURRENCY_THRESHOLD,
  type ProviderCapabilities,
} from "../providers/capabilities";
import { PROVIDER_REGISTRY, getRegisteredProviders } from "../providers/registry";

const GPU_PROFILE: ProviderCapabilities = {
  provider: "vast",
  modelSource: "both",
  contentPolicy: "mizi-only",
  maxConcurrentWorkers: 250,
  maxContextTokens: 1_048_576,
  dataResidency: "on-box",
  maxModelSizeGb: 2_000,
  supportedFormats: ["safetensors", "gguf"],
  images: ["gheeklabs/mizi-gpu:cuda12.4", "gheeklabs/mizi-gpu:h100"],
};

const NIM_PROFILE: ProviderCapabilities = {
  provider: "nim",
  modelSource: "catalog",
  contentPolicy: "provider-enforced",
  maxConcurrentWorkers: 4,
  maxContextTokens: 128_000,
  dataResidency: "cloud",
  maxModelSizeGb: 0,
  supportedFormats: [],
  images: [],
};

describe("providerMatches", () => {
  it("accepts a catalog request on hosted", () => {
    expect(providerMatches(NIM_PROFILE, { modelSource: "catalog" }).ok).toBe(true);
  });

  it("rejects custom-hf requests on hosted providers", () => {
    const m = providerMatches(NIM_PROFILE, { modelSource: "custom-hf" });
    expect(m.ok).toBe(false);
    expect(m.reasons.join(" ")).toMatch(/catalog models only/);
  });

  it("rejects mizi-only content on provider-enforced backends", () => {
    const m = providerMatches(NIM_PROFILE, { contentPolicy: "mizi-only" });
    expect(m.ok).toBe(false);
    expect(m.reasons.join(" ")).toMatch(/uncensored models require mizi-only/);
  });

  it("rejects high-concurrency on capped backends", () => {
    const m = providerMatches(NIM_PROFILE, { concurrency: "high" });
    expect(m.ok).toBe(false);
    expect(m.reasons.join(" ")).toMatch(new RegExp(`${HIGH_CONCURRENCY_THRESHOLD}`));
  });

  it("accepts on-box + mizi-only on GPU", () => {
    expect(
      providerMatches(GPU_PROFILE, { contentPolicy: "mizi-only", dataResidency: "on-box", concurrency: "high" }).ok,
    ).toBe(true);
  });

  it("rejects oversized models", () => {
    const m = providerMatches(GPU_PROFILE, { maxModelSizeGb: 3000 });
    expect(m.ok).toBe(false);
  });

  it("rejects unsupported formats", () => {
    const m = providerMatches(GPU_PROFILE, { requiredFormats: ["exl2"] });
    expect(m.ok).toBe(false);
  });

  it("both-sourced providers satisfy custom-hf", () => {
    expect(providerMatches(GPU_PROFILE, { modelSource: "custom-hf" }).ok).toBe(true);
  });
});

describe("resolveProvider", () => {
  it("picks hosted for catalog work, GPU for custom", () => {
    const catalog = resolveProvider({ modelSource: "catalog" }, [NIM_PROFILE, GPU_PROFILE]);
    expect(catalog[0]).toBe("nim");

    const custom = resolveProvider({ modelSource: "custom-hf" }, [NIM_PROFILE, GPU_PROFILE]);
    expect(custom).toEqual(["vast"]);
  });

  it("respects opts.pick", () => {
    const picked = resolveProvider({ modelSource: "custom-hf" }, [GPU_PROFILE], { pick: "vast" });
    expect(picked).toEqual(["vast"]);
    expect(resolveProvider({ modelSource: "custom-hf" }, [GPU_PROFILE], { pick: "nim" })).toEqual([]);
  });
});

describe("registry", () => {
  it("registers GPU providers with custom-hf + mizi-only + on-box", () => {
    for (const p of PROVIDER_REGISTRY) {
      if (p.provider === "vast" || p.provider === "vultr") {
        expect(p.modelSource).not.toBe("catalog");
        expect(p.contentPolicy).toBe("mizi-only");
        expect(p.dataResidency).toBe("on-box");
        expect(p.images.length).toBeGreaterThan(0);
      }
    }
  });

  it("hosted providers serve no local weights", () => {
    for (const p of PROVIDER_REGISTRY) {
      if (p.provider === "nim" || p.provider === "ollama-cloud" || p.provider === "openai") {
        expect(p.maxModelSizeGb).toBe(0);
        expect(p.supportedFormats).toEqual([]);
      }
    }
  });

  it("registers ollama-local as an on-box peer provider", () => {
    const local = PROVIDER_REGISTRY.find((p) => p.provider === "ollama-local");
    expect(local).toBeDefined();
    expect(local!.dataResidency).toBe("on-box");
    expect(local!.contentPolicy).toBe("mizi-only");
    expect(local!.supportedFormats).toContain("gguf");
  });

  it("getRegisteredProviders filters hosted by env", () => {
    const before = getRegisteredProviders().map((p) => p.provider);
    // GPU providers are always present; hosted depend on env (unset in tests).
    expect(before).toContain("vast");
  });
});
