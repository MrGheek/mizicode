/**
 * Tests for providers/resolver.ts — deployment planning + image selection.
 *
 * inspectHfRepo is module-mocked so these tests run without network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInspect = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    repoId: "Uniboshi/Kimi-K3-Abliterated-V1",
    sizeGb: 1500,
    formats: ["safetensors"],
    architecture: "KimiK3ForConditionalGeneration",
    needsRemoteCode: true,
    multimodal: true,
    gated: false,
    quantHint: "mxfp4-compressed-tensors",
    sizing: {
      diskGb: 1875,
      vramGb: 188,
      numGpus: 8,
      estimatedDownloadHoursAt1Gbps: 3.33,
    },
  }),
);

vi.mock("../providers/hf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/hf")>();
  return {
    ...actual,
    inspectHfRepo: mockInspect,
  };
});

import { resolveModel, planGpuSession, pickGpuImage, ModelResolveError } from "../providers/resolver";
import type { ProviderCapabilities } from "../providers/capabilities";

const GPU_PROFILE: ProviderCapabilities = {
  provider: "vast",
  modelSource: "both",
  contentPolicy: "mizi-only",
  maxConcurrentWorkers: 250,
  maxContextTokens: 1_048_576,
  dataResidency: "on-box",
  maxModelSizeGb: 2_000,
  supportedFormats: ["safetensors", "gguf", "exl2", "awq", "gptq"],
  images: ["gheeklabs/mizi-gpu:cuda12.4", "gheeklabs/mizi-gpu:a100", "gheeklabs/mizi-gpu:h100"],
};

describe("pickGpuImage", () => {
  beforeEach(() => mockInspect.mockClear());

  it("uses the h100 image for large dense models", () => {
    const image = pickGpuImage(GPU_PROFILE, { sizeGb: 500, quantHint: null, multimodal: false }, false);
    expect(image).toMatch(/h100/);
  });

  it("uses a100 for small models", () => {
    const image = pickGpuImage(GPU_PROFILE, { sizeGb: 24, quantHint: null, multimodal: false }, false);
    expect(image).toMatch(/a100/);
  });

  it("prefers cuda12.4 base for custom-code / compressed-tensors / multimodal", () => {
    const image = pickGpuImage(GPU_PROFILE, { sizeGb: 24, quantHint: "mxfp4-compressed-tensors", multimodal: true }, true);
    expect(image).toMatch(/cuda12.4/);
  });
});

describe("planGpuSession", () => {
  it("builds a provisioning plan from the inspected repo", async () => {
    const plan = await planGpuSession("Uniboshi/Kimi-K3-Abliterated-V1", "vast");
    expect(plan.repoId).toBe("Uniboshi/Kimi-K3-Abliterated-V1");
    expect(plan.diskGb).toBe(1875);
    expect(plan.numGpus).toBe(8);
    expect(plan.modelRepo).toBe("Uniboshi/Kimi-K3-Abliterated-V1");
    expect(plan.needsRemoteCode).toBe(true);
    expect(plan.image).toMatch(/cuda12.4/);
  });
});

describe("resolveModel", () => {
  beforeEach(() => mockInspect.mockClear());

  it("routes hosted catalog picks to hosted deployments", async () => {
    const dep = await resolveModel({ nimModelId: "moonshotai/kimi-k2-instruct" });
    expect(dep.kind).toBe("hosted");
    expect(dep.hosted?.provider).toBe("nim");
    expect(dep.hosted?.modelId).toBe("moonshotai/kimi-k2-instruct");
  });

  it("routes HF URLs to GPU deployments with a plan", async () => {
    const dep = await resolveModel({ hfUrl: "https://huggingface.co/Uniboshi/Kimi-K3-Abliterated-V1" });
    expect(dep.kind).toBe("gpu");
    expect(dep.gpu?.provider).toBe("vast");
    expect(dep.gpu?.info.architecture).toBe("KimiK3ForConditionalGeneration");
    expect(dep.requiredCapabilities.modelSource).toBe("custom-hf");
    expect(dep.requiredCapabilities.contentPolicy).toBe("mizi-only");
  });

  it("throws when no model is selected", async () => {
    await expect(resolveModel({})).rejects.toThrow(ModelResolveError);
  });

  it("throws on inspect failure with a clear message", async () => {
    mockInspect.mockRejectedValueOnce(new Error("HF API error 404"));
    await expect(
      resolveModel({ hfUrl: "Uniboshi/Kimi-K3-Abliterated-V1" }),
    ).rejects.toThrow(/Failed to inspect model/);
  });
});
