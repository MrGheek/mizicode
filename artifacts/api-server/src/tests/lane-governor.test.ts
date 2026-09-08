import { beforeEach, describe, expect, it } from "vitest";
import {
  BREAKER_TRIP_THRESHOLD,
  LANE_PERMISSION_PROFILES,
  MemoryGovernanceStore,
  checkLanePermission,
  isLaneTripped,
  newBreakerState,
  reconcileSession,
  recordLaneFailure,
  recordLaneSuccess,
  takeoverLane,
} from "../services/lane-governor";

let store: MemoryGovernanceStore;

beforeEach(() => {
  store = new MemoryGovernanceStore();
  store.clear();
});

describe("checkLanePermission", () => {
  it("denies tools on the deny-list", () => {
    expect(checkLanePermission("ux", "docker").allowed).toBe(false);
    expect(checkLanePermission("review", "write_file").allowed).toBe(false);
  });

  it("enforces the review allow-list", () => {
    expect(checkLanePermission("review", "read").allowed).toBe(true);
    expect(checkLanePermission("review", "run_command").allowed).toBe(false);
  });

  it("enforces path allow/deny lists", () => {
    expect(checkLanePermission("backend", "edit_file", "src/backend/api.ts").allowed).toBe(true);
    expect(checkLanePermission("backend", "edit_file", "src/frontend/App.tsx").allowed).toBe(false);
    expect(checkLanePermission("ux", "edit_file", "src/components/Button.tsx").allowed).toBe(true);
    expect(checkLanePermission("ux", "edit_file", "lib/db/schema.ts").allowed).toBe(false);
  });

  it("falls back to general for unknown lane types", () => {
    expect(checkLanePermission("unknown", "terraform").allowed).toBe(false);
    expect(checkLanePermission("unknown", "read").allowed).toBe(true);
  });

  it("defines a profile for every built-in lane type", () => {
    for (const t of ["ux", "debug", "backend", "review", "general"]) {
      expect(LANE_PERMISSION_PROFILES[t as keyof typeof LANE_PERMISSION_PROFILES]).toBeDefined();
    }
  });
});

describe("circuit breakers", () => {
  it("trips after the threshold of consecutive failures", () => {
    let state = newBreakerState();
    for (let i = 0; i < BREAKER_TRIP_THRESHOLD; i++) {
      state = recordLaneFailure(state);
    }
    expect(isLaneTripped(state)).toBe(true);
    expect(state.consecutiveFailures).toBe(BREAKER_TRIP_THRESHOLD);
    expect(state.trippedAt).not.toBeNull();
  });

  it("does not trip below the threshold", () => {
    let state = newBreakerState();
    state = recordLaneFailure(state);
    state = recordLaneFailure(state);
    expect(isLaneTripped(state)).toBe(false);
  });

  it("resets on success", () => {
    let state = newBreakerState();
    for (let i = 0; i < BREAKER_TRIP_THRESHOLD; i++) state = recordLaneFailure(state);
    expect(isLaneTripped(state)).toBe(true);
    state = recordLaneSuccess(state);
    expect(isLaneTripped(state)).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe("reconcileSession", () => {
  it("surfaces orphan claims, uncommitted lanes, ghost worktrees, and goal gaps", () => {
    const r = reconcileSession({
      orphanClaims: 3,
      uncommittedLanes: ["alice"],
      ghostWorktrees: ["/tmp/wt-orphan"],
      goalGaps: ["task-9 has no lane"],
    });
    expect(r.orphanClaims).toBe(3);
    expect(r.uncommittedLanes).toEqual(["alice"]);
    expect(r.ghostWorktrees).toEqual(["/tmp/wt-orphan"]);
    expect(r.goalGaps).toHaveLength(1);
  });
});

describe("takeoverLane", () => {
  it("grants takeover only with full evidence", async () => {
    const ok = await takeoverLane(store, {
      sessionId: 1,
      fromLaneId: 1,
      toLaneId: 2,
      reason: "previous lane crashed",
      evidence: { heartbeatStale: true, noLiveProcess: true, lockStale: true },
    });
    expect(ok.ok).toBe(true);
    expect(ok.incident).not.toBeNull();
    expect((await store.listTakeovers(1))).toHaveLength(1);
  });

  it("refuses takeover without evidence", async () => {
    const denied = await takeoverLane(store, {
      sessionId: 1,
      fromLaneId: 1,
      toLaneId: 2,
      reason: "I want the files",
      evidence: { heartbeatStale: false, noLiveProcess: false, lockStale: false },
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("evidence");
    expect((await store.listTakeovers(1))).toHaveLength(0);
  });
});