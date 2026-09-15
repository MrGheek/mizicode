/**
 * Tests for RFC 0006 — factory fab model: shared lane pool with claim/release,
 * dispatch-score arbitration, starvation signals, and pool bounds. All run
 * against the in-memory store (no DB).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFactoryStore } from "../services/factory";
import {
  sessionClaimable,
  findStationClaim,
  chooseClaimableSession,
  claimSession,
  releaseClaim,
  sweepIdleClaims,
  releaseClaimsIfSessionIdle,
  DEFAULT_CLAIM_LAPSE_AFTER_MS,
  DEFAULT_IDLE_RELEASE_AFTER_MS,
} from "../services/factory-lane-pool";
import {
  dispatchScoreFor,
  dueDatePressure,
  budgetWeight,
  runArbitrationPass,
  _resetArbitrationForTest,
} from "../services/factory-arbitration";
import type { Session, Station, StationClaim } from "@workspace/db";

function makeSession(id: number, status: string = "ready"): Session {
  return { id, status, provider: "vastai" } as unknown as Session;
}

function makeClaim(id: number, stationId: number, sessionId: number, active = true): StationClaim {
  return {
    id,
    productId: 1,
    stationId,
    sessionId,
    workOrderId: null,
    claimedAt: new Date(),
    expiresAt: new Date(Date.now() + DEFAULT_CLAIM_LAPSE_AFTER_MS),
    lastHeartbeatAt: new Date(),
    releasedAt: null,
    active,
  };
}

function makeStation(id: number, sessionId: number | null = null, capacity = 2): Station {
  return {
    id,
    productId: 1,
    sessionId,
    role: "build" as const,
    capacity,
    wipLimit: 2,
    defectCount: 0,
    reworkCycles: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("factory lane pool (RFC 0006)", () => {
  let store: MemoryFactoryStore;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    _resetArbitrationForTest();
  });

  describe("sessionClaimable", () => {
    it("rejects sessions that are not ready", () => {
      const s = makeSession(1, "stopped");
      expect(sessionClaimable(s, [], 8)).toMatch(/status is 'stopped'/);
    });

    it("rejects sessions held by an active claim", () => {
      const s = makeSession(1);
      expect(sessionClaimable(s, [makeClaim(1, 1, 1)], 8)).toMatch(/already claimed/);
    });

    it("rejects when the fab pool is saturated", () => {
      const s = makeSession(9);
      const claims = Array.from({ length: 8 }, (_, i) => makeClaim(i + 1, i + 1, i + 1));
      expect(sessionClaimable(s, claims, 8)).toMatch(/lane pool saturated/);
    });

    it("accepts a ready, unclaimed session with headroom", () => {
      const s = makeSession(3);
      expect(sessionClaimable(s, [makeClaim(1, 1, 1)], 8)).toBeNull();
    });
  });

  describe("findStationClaim (swarm fan-out)", () => {
    it("returns the station's active claim when under capacity", () => {
      const station = makeStation(1, null, 2);
      const claim = makeClaim(1, 1, 10);
      expect(findStationClaim(station, [claim], 1)?.id).toBe(1);
    });

    it("returns null at capacity", () => {
      const station = makeStation(1, null, 2);
      const claim = makeClaim(1, 1, 10);
      expect(findStationClaim(station, [claim], 2)).toBeNull();
    });
  });

  describe("chooseClaimableSession", () => {
    it("prefers the station's current session", () => {
      const station = makeStation(1, 10);
      const candidates = [
        { session: makeSession(5), blockedReason: null },
        { session: makeSession(10), blockedReason: null },
      ];
      expect(chooseClaimableSession(station, candidates, [])?.id).toBe(10);
    });

    it("returns null when nothing is claimable", () => {
      const station = makeStation(1);
      const candidates = [{ session: makeSession(5), blockedReason: "claimed" }];
      expect(chooseClaimableSession(station, candidates, [])).toBeNull();
    });
  });

  describe("claimSession / releaseClaim", () => {
    it("grants and persists a claim", async () => {
      const fab = await store.createFactory({ name: "Test Fab" });
      const product = await store.createProduct({ name: "p", repoUrl: "https://x/p" });
      const station = await store.createStation({ productId: product.id });
      const grant = await claimSession(store, {
        factoryId: fab.id,
        station,
        workOrderId: 1,
        sessions: [makeSession(10)],
      });
      expect(grant.granted).toBe(true);
      expect(grant.claim?.sessionId).toBe(10);
      const claims = await store.listActiveClaims();
      expect(claims.length).toBe(1);
    });

    it("blocks a second claim on the same session", async () => {
      const fab = await store.createFactory({ name: "Test Fab" });
      const product = await store.createProduct({ name: "p", repoUrl: "https://x/p" });
      const s1 = await store.createStation({ productId: product.id });
      const s2 = await store.createStation({ productId: product.id });
      const first = await claimSession(store, { factoryId: fab.id, station: s1, workOrderId: 1, sessions: [makeSession(10)] });
      expect(first.granted).toBe(true);
      const second = await claimSession(store, { factoryId: fab.id, station: s2, workOrderId: 2, sessions: [makeSession(10)] });
      expect(second.granted).toBe(false);
      expect(second.reason).toMatch(/already claimed/);
    });

    it("releases a claim once", async () => {
      const fab = await store.createFactory({ name: "Test Fab" });
      const product = await store.createProduct({ name: "p", repoUrl: "https://x/p" });
      const station = await store.createStation({ productId: product.id });
      const grant = await claimSession(store, { factoryId: fab.id, station, workOrderId: 1, sessions: [makeSession(10)] });
      const released = await releaseClaim(store, grant.claim!.id);
      expect(released.released).toBe(true);
      const again = await releaseClaim(store, grant.claim!.id);
      expect(again.released).toBe(false);
      expect((await store.listActiveClaims()).length).toBe(0);
    });
  });

  describe("sweepIdleClaims", () => {
    it("lapses an expired claim", async () => {
      const fab = await store.createFactory({ name: "Test Fab" });
      const product = await store.createProduct({ name: "p", repoUrl: "https://x/p" });
      const station = await store.createStation({ productId: product.id });
      const grant = await claimSession(store, { factoryId: fab.id, station, workOrderId: 1, sessions: [makeSession(10)] });
      const far = new Date(Date.now() + DEFAULT_CLAIM_LAPSE_AFTER_MS + 60_000);
      const released = await sweepIdleClaims(store, { now: far });
      expect(released).toContain(grant.claim!.id);
    });

    it("releases an idle claim past the idle timer", async () => {
      const fab = await store.createFactory({ name: "Test Fab" });
      const product = await store.createProduct({ name: "p", repoUrl: "https://x/p" });
      const station = await store.createStation({ productId: product.id });
      const grant = await claimSession(store, { factoryId: fab.id, station, workOrderId: 1, sessions: [makeSession(10)] });
      const later = new Date(Date.now() + DEFAULT_IDLE_RELEASE_AFTER_MS + 60_000);
      const released = await sweepIdleClaims(store, { now: later, busySessionIds: new Set() });
      expect(released).toContain(grant.claim!.id);
    });

    it("keeps busy claims", async () => {
      const fab = await store.createFactory({ name: "Test Fab" });
      const product = await store.createProduct({ name: "p", repoUrl: "https://x/p" });
      const station = await store.createStation({ productId: product.id });
      const grant = await claimSession(store, { factoryId: fab.id, station, workOrderId: 1, sessions: [makeSession(10)] });
      const later = new Date(Date.now() + DEFAULT_IDLE_RELEASE_AFTER_MS + 60_000);
      const released = await sweepIdleClaims(store, { now: later, busySessionIds: new Set([10]) });
      expect(released).toEqual([]);
    });
  });

  describe("releaseClaimsIfSessionIdle", () => {
    it("releases when no in-flight orders remain on the session", async () => {
      const fab = await store.createFactory({ name: "Test Fab" });
      const product = await store.createProduct({ name: "p", repoUrl: "https://x/p" });
      const station = await store.createStation({ productId: product.id });
      const grant = await claimSession(store, { factoryId: fab.id, station, workOrderId: 1, sessions: [makeSession(10)] });
      const released = await releaseClaimsIfSessionIdle(store, { sessionId: 10, productId: product.id });
      expect(released).toContain(grant.claim!.id);
    });

    it("keeps the claim while orders are in flight", async () => {
      const fab = await store.createFactory({ name: "Test Fab" });
      const product = await store.createProduct({ name: "p", repoUrl: "https://x/p" });
      const station = await store.createStation({ productId: product.id });
      const grant = await claimSession(store, { factoryId: fab.id, station, workOrderId: 1, sessions: [makeSession(10)] });
      await store.createWorkOrder({ productId: product.id, goal: "w" });
      await store.updateWorkOrder(1, { status: "in_progress", sessionId: 10 });
      const released = await releaseClaimsIfSessionIdle(store, { sessionId: 10, productId: product.id });
      expect(released).toEqual([]);
    });
  });
});

describe("dispatch score (RFC 0006)", () => {
  it("weights product priority", () => {
    const now = new Date();
    const p0 = dispatchScoreFor({ productPriority: "p0", orderPriority: "normal", dueDate: null, spentUsd: 0, budgetUsd: null, now });
    const p2 = dispatchScoreFor({ productPriority: "p2", orderPriority: "normal", dueDate: null, spentUsd: 0, budgetUsd: null, now });
    expect(p0.score).toBeGreaterThan(p2.score);
    expect(p0.factors.productWeight).toBe(1.0);
    expect(p2.factors.productWeight).toBe(0.3);
  });

  it("weights work-order priority", () => {
    const now = new Date();
    const high = dispatchScoreFor({ productPriority: "p2", orderPriority: "high", dueDate: null, spentUsd: 0, budgetUsd: null, now });
    const low = dispatchScoreFor({ productPriority: "p2", orderPriority: "low", dueDate: null, spentUsd: 0, budgetUsd: null, now });
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("applies piecewise due-date pressure", () => {
    const now = new Date();
    const far = new Date(now.getTime() + 10 * 3_600_000);
    const near = new Date(now.getTime() + 1 * 3_600_000);
    const overdue = new Date(now.getTime() - 3_600_000);
    expect(dueDatePressure(far, now, 3_600_000)).toBe(0.5);
    expect(dueDatePressure(near, now, 3_600_000)).toBe(1.0);
    expect(dueDatePressure(overdue, now, 3_600_000)).toBe(1.5);
    expect(dueDatePressure(null, now, 3_600_000)).toBe(1);
  });

  it("applies budget weight with a floor of 0.25", () => {
    expect(budgetWeight(0, 100)).toBe(1);
    expect(budgetWeight(50, 100)).toBeCloseTo(0.625);
    expect(budgetWeight(200, 100)).toBe(0.25);
    expect(budgetWeight(500, null)).toBe(1);
  });
});

describe("arbitration pass (RFC 0006)", () => {
  let store: MemoryFactoryStore;

  beforeEach(() => {
    store = new MemoryFactoryStore();
    _resetArbitrationForTest();
  });

  it("dispatches a P0 product's normal order before a P2 product's high order", async () => {
    const fab = await store.createFactory({ name: "Test Fab", lanePoolLimit: 8 });
    const p0 = await store.createProduct({ name: "p0", repoUrl: "https://x/p0", productPriority: "p0" });
    const p2 = await store.createProduct({ name: "p2", repoUrl: "https://x/p2", productPriority: "p2" });
    await store.createStation({ productId: p0.id });
    await store.createStation({ productId: p2.id });
    await store.createWorkOrder({ productId: p0.id, goal: "p0 normal", priority: "normal" });
    await store.createWorkOrder({ productId: p2.id, goal: "p2 high", priority: "high" });

    const sessions = [makeSession(10), makeSession(11)];
    const pass = await runArbitrationPass(store, { factoryId: fab.id, sessions });

    expect(pass.dispatched).toBe(2);
    const p0Line = pass.lines.find((l) => l.workOrderId === 1);
    const p2Line = pass.lines.find((l) => l.workOrderId === 2);
    expect(p0Line?.outcome).toBe("dispatched");
    expect(p2Line?.outcome).toBe("dispatched");
    expect(p0Line!.dispatchScore).toBeGreaterThan(p2Line!.dispatchScore);
  });

  it("serializes across products when the pool has one lane", async () => {
    const fab = await store.createFactory({ name: "Test Fab", lanePoolLimit: 1 });
    const p0 = await store.createProduct({ name: "p0", repoUrl: "https://x/p0", productPriority: "p0" });
    const p2 = await store.createProduct({ name: "p2", repoUrl: "https://x/p2", productPriority: "p2" });
    await store.createStation({ productId: p0.id });
    await store.createStation({ productId: p2.id });
    await store.createWorkOrder({ productId: p0.id, goal: "a" });
    await store.createWorkOrder({ productId: p2.id, goal: "b" });

    const sessions = [makeSession(10)];
    const pass = await runArbitrationPass(store, { factoryId: fab.id, sessions });

    const p0Line = pass.lines.find((l) => l.productId === p0.id);
    const p2Line = pass.lines.find((l) => l.productId === p2.id);
    expect(p0Line?.outcome).toBe("dispatched");
    expect(p2Line?.outcome).toBe("held");
    expect(p2Line?.reason).toMatch(/lane pool saturated/);
    expect(p2Line?.lostTo?.some((l) => l.productId === p0.id)).toBe(true);
  });

  it("fans out a second order on the same claimed session within capacity", async () => {
    const fab = await store.createFactory({ name: "Test Fab", lanePoolLimit: 8 });
    const product = await store.createProduct({ name: "p", repoUrl: "https://x/p", productPriority: "p0" });
    await store.createStation({ productId: product.id, capacity: 2 });
    await store.createWorkOrder({ productId: product.id, goal: "a" });
    await store.createWorkOrder({ productId: product.id, goal: "b" });

    const sessions = [makeSession(10)];
    const pass = await runArbitrationPass(store, { factoryId: fab.id, sessions });

    expect(pass.dispatched).toBe(2);
    const claims = await store.listActiveClaims();
    expect(claims.length).toBe(1);
    expect(claims[0]!.sessionId).toBe(10);
  });

  it("emits a starvation signal when a senior product is starved by lower-priority claims", async () => {
    const store2 = new MemoryFactoryStore();
    const fab2 = await store2.createFactory({ name: "Test Fab", lanePoolLimit: 1 });
    const senior = await store2.createProduct({ name: "senior", repoUrl: "https://x/a", productPriority: "p0" });
    const junior = await store2.createProduct({ name: "junior", repoUrl: "https://x/b", productPriority: "p2" });
    await store2.createStation({ productId: senior.id });
    const juniorStation = await store2.createStation({ productId: junior.id });
    await store2.createWorkOrder({ productId: senior.id, goal: "senior order" });
    await store2.createWorkOrder({ productId: junior.id, goal: "junior order" });
    // The junior product already holds the single lane.
    const grant = await claimSession(store2, {
      factoryId: fab2.id,
      station: juniorStation,
      workOrderId: 2,
      sessions: [makeSession(10)],
    });
    expect(grant.granted).toBe(true);

    const pass = await runArbitrationPass(store2, { factoryId: fab2.id, sessions: [] });
    expect(pass.starvationSignals.length).toBeGreaterThan(0);
    expect(pass.starvationSignals[0]!.productId).toBe(senior.id);
    expect(pass.starvationSignals[0]!.holdingClaims.some((c) => c.productId === junior.id)).toBe(true);
  });

  it("holds when no station has WIP headroom", async () => {
    const fab = await store.createFactory({ name: "Test Fab", lanePoolLimit: 8 });
    const product = await store.createProduct({ name: "p", repoUrl: "https://x/p", productPriority: "p0" });
    await store.createStation({ productId: product.id, capacity: 1, wipLimit: 1 });
    await store.createWorkOrder({ productId: product.id, goal: "a" });
    await store.createWorkOrder({ productId: product.id, goal: "b" });

    const sessions = [makeSession(10), makeSession(11)];
    const pass = await runArbitrationPass(store, { factoryId: fab.id, sessions });

    const lines = pass.lines;
    expect(lines.filter((l) => l.outcome === "dispatched").length).toBe(1);
    expect(lines.some((l) => l.reason === "no station has WIP headroom")).toBe(true);
  });
});
