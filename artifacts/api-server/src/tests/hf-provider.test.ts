/**
 * Tests for providers/hf.ts — HuggingFace URL parse, format detection,
 * sizing, and repo inspection (network mocked via fetchImpl).
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseHfRepoRef,
  detectFormats,
  estimateDownloadHours,
  inspectHfRepo,
  tryInspectHfRepo,
} from "../providers/hf";

describe("parseHfRepoRef", () => {
  it("parses full HF URLs", () => {
    expect(parseHfRepoRef("https://huggingface.co/Uniboshi/Kimi-K3-Abliterated-V1")).toBe(
      "Uniboshi/Kimi-K3-Abliterated-V1",
    );
    expect(parseHfRepoRef("https://huggingface.co/owner/repo/tree/main")).toBe("owner/repo");
    expect(parseHfRepoRef("https://hf.co/owner/repo")).toBe("owner/repo");
  });

  it("accepts bare repo ids", () => {
    expect(parseHfRepoRef("unsloth/Kimi-K2.6-GGUF")).toBe("unsloth/Kimi-K2.6-GGUF");
  });

  it("rejects unsafe references", () => {
    expect(() => parseHfRepoRef("https://evil.example/owner/repo")).toThrow();
    expect(() => parseHfRepoRef("../../etc/passwd")).toThrow();
    expect(() => parseHfRepoRef("")).toThrow();
    expect(() => parseHfRepoRef("no-slash-here")).toThrow();
  });
});

describe("detectFormats", () => {
  it("detects safetensors + gguf", () => {
    expect(detectFormats(["model.safetensors", "config.json"])).toEqual(["safetensors"]);
    expect(detectFormats(["kimi-k2.6-q4_k_m.gguf"])).toEqual(["gguf"]);
  });

  it("detects exl2/awq/gptq", () => {
    expect(detectFormats(["model-00001-of-00003.exl2"])).toEqual(["exl2"]);
    expect(detectFormats(["model.q4.awq"])).toEqual(["awq"]);
    expect(detectFormats(["model.q4.gptq"])).toEqual(["gptq"]);
    // Index json is not a weights shard.
    expect(detectFormats(["model.safetensors.index.json"])).toEqual([]);
  });

  it("returns empty for unknown files", () => {
    expect(detectFormats(["config.json", "README.md"])).toEqual([]);
  });
});

describe("estimateDownloadHours", () => {
  it("computes hours from size and bandwidth", () => {
    expect(estimateDownloadHours(1500, 1000)).toBeCloseTo(1500 * 8000 / 1000 / 3600, 3);
  });

  it("returns 0 for no size, Infinity for no bandwidth", () => {
    expect(estimateDownloadHours(0, 1000)).toBe(0);
    expect(estimateDownloadHours(10, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("inspectHfRepo", () => {
  it("derives formats, sizing, and flags from API metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        usedStorage: 1.5e12, // 1500 GB
        pipeline_tag: "image-text-to-text",
        gated: false,
        siblings: [
          { rfilename: "model-00001-of-00096.safetensors" },
          { rfilename: "model.safetensors.index.json" },
          { rfilename: "modeling_kimi_k3.py" },
        ],
        config: {
          architectures: ["KimiK3ForConditionalGeneration"],
          auto_map: { AutoConfig: "modeling_kimi_k3.KimiK3Config" },
        },
      }),
    });

    const info = await inspectHfRepo("Uniboshi/Kimi-K3-Abliterated-V1", { fetchImpl });
    expect(info.sizeGb).toBe(1500);
    expect(info.formats).toEqual(["safetensors"]);
    expect(info.architecture).toBe("KimiK3ForConditionalGeneration");
    expect(info.needsRemoteCode).toBe(true);
    expect(info.multimodal).toBe(true);
    expect(info.sizing.diskGb).toBe(1875);
    // 1500 GB → 80 GB GPUs → ceil(1500/80) = 19 → capped at 8, VRAM per GPU = ceil(1500/8) = 188.
    expect(info.sizing.numGpus).toBe(8);
    expect(info.sizing.vramGb).toBe(188);
  });

  it("detects mxfp4 compressed-tensors quant hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        usedStorage: 3.2e11,
        gated: false,
        siblings: [{ rfilename: "model.mxfp4.safetensors" }],
        config: {},
      }),
    });
    const info = await inspectHfRepo("foo/bar", { fetchImpl });
    expect(info.quantHint).toBe("mxfp4-compressed-tensors");
  });

  it("throws for gated repos without a token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "gated" });
    await expect(inspectHfRepo("gated/repo", { fetchImpl })).rejects.toThrow(/gated/);
  });

  it("throws on network errors and tryInspectHfRepo returns null", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(inspectHfRepo("foo/bar", { fetchImpl })).rejects.toThrow();
    expect(await tryInspectHfRepo("foo/bar", { fetchImpl })).toBeNull();
  });
});
