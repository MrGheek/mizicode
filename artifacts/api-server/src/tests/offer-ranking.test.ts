/**
 * Tests for bandwidth-aware offer ranking in services/vastai.ts.
 *
 * Covers:
 *   - parseBandwidthMbps (numeric + string forms)
 *   - estimateDownloadHours / effectiveBootCost
 *   - searchOffers re-ranking by effective boot cost (network mocked via fetch)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseBandwidthMbps,
  estimateDownloadHours,
  effectiveBootCost,
  searchOffers,
  type VastOffer,
} from "../services/vastai";

describe("parseBandwidthMbps", () => {
  it("passes through numeric Mbps", () => {
    expect(parseBandwidthMbps(10240)).toBe(10240);
    expect(parseBandwidthMbps(0)).toBe(0);
    expect(parseBandwidthMbps(-5)).toBe(0);
  });

  it("parses string forms", () => {
    expect(parseBandwidthMbps("10240 Mbps")).toBe(10240);
    expect(parseBandwidthMbps("10 Gbps")).toBe(10000);
    expect(parseBandwidthMbps("1.5 Gbps")).toBe(1500);
    expect(parseBandwidthMbps("250 mbps")).toBe(250);
  });

  it("returns 0 for unusable input", () => {
    expect(parseBandwidthMbps(undefined)).toBe(0);
    expect(parseBandwidthMbps(null)).toBe(0);
    expect(parseBandwidthMbps("")).toBe(0);
    expect(parseBandwidthMbps("fast")).toBe(0);
  });
});

describe("estimateDownloadHours / effectiveBootCost", () => {
  it("estimates hours for a model at a given bandwidth", () => {
    // 50 GB at 10240 Mbps (10 Gbps): 50*8000/10240/3600 ≈ 0.0109 h
    const h = estimateDownloadHours(50, 10240);
    expect(h).toBeCloseTo(0.0109, 3);
  });

  it("returns Infinity for unknown bandwidth", () => {
    expect(estimateDownloadHours(50, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("effective boot cost = rate × hours", () => {
    const cost = effectiveBootCost({ dph_total: 2, inet_down: 1000 }, 50);
    expect(cost).toBeCloseTo(2 * (50 * 8000 / 1000 / 3600), 3);
  });

  it("unknown bandwidth → infinite effective cost", () => {
    expect(effectiveBootCost({ dph_total: 1, inet_down: 0 }, 50)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("searchOffers bandwidth-aware ranking", () => {
  const offers: VastOffer[] = [
    // Expensive host but very fast download — wins on effective cost.
    { id: 1, dph_total: 5, inet_down: 10240 },
    // Cheaper host but 100× slower download — loses for large models.
    { id: 2, dph_total: 0.5, inet_down: 100 },
    // Unknown bandwidth — always sinks to the bottom.
    { id: 3, dph_total: 0.1, inet_down: 0 },
  ];

  beforeEach(() => {
    process.env.VASTAI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ offers }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VASTAI_API_KEY;
  });

  it("re-ranks by effective boot cost when modelSizeGb is set", async () => {
    const ranked = await searchOffers({ modelSizeGb: 1500, limit: 3 });
    // Offer 1 (fast) first despite higher rate; offer 3 (unknown bw) last.
    expect(ranked.map((o) => o.id)).toEqual([1, 2, 3]);
  });

  it("requests a wider candidate pool for large models", async () => {
    await searchOffers({ modelSizeGb: 1500, limit: 1 });
    const fetchMock = vi.mocked(fetch);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.limit).toBeGreaterThanOrEqual(100);
  });

  it("keeps original order when modelSizeGb is not set", async () => {
    const ranked = await searchOffers({ limit: 3 });
    expect(ranked.map((o) => o.id)).toEqual([1, 2, 3]);
  });

  it("clamps bandwidth above maxInetDownMbps", async () => {
    const ranked = await searchOffers({ modelSizeGb: 1500, limit: 3, maxInetDownMbps: 90 });
    // Both offer 1 (10240 Mbps) and offer 2 (100 Mbps) clamp to 90 Mbps, so the
    // cheaper-rate host (offer 2) now wins on effective cost; unknown-bw offer 3
    // stays last.
    expect(ranked.map((o) => o.id)).toEqual([2, 1, 3]);
  });
});
