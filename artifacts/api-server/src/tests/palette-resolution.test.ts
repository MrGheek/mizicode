import { describe, it, expect } from "vitest";
import { resolvePaletteCommandHeuristic } from "../services/palette-resolution";

const ctx = {
  route: "/",
  activeSessionId: 9,
  activeSessionStatus: "ready",
  recentSessionIds: [9, 4, 12],
};

describe("resolvePaletteCommandHeuristic — session actions", () => {
  it("resolves explicit session numbers", () => {
    const r = resolvePaletteCommandHeuristic("stop session 3", ctx);
    expect(r).toEqual({
      ok: true,
      action: "stop-session",
      payload: { route: null, sessionId: 3 },
      explanation: expect.stringContaining("3"),
    });
  });

  it("resolves bare #N claims", () => {
    const r = resolvePaletteCommandHeuristic("relaunch #7", ctx);
    expect(r?.action).toBe("relaunch-session");
    expect(r?.payload?.sessionId).toBe(7);
  });

  it("binds 'session number N'", () => {
    const r = resolvePaletteCommandHeuristic("reindex session number 7", ctx);
    expect(r?.action).toBe("reindex-session");
    expect(r?.payload?.sessionId).toBe(7);
  });

  it("binds active-session references to activeSessionId", () => {
    for (const q of ["stop my session", "restart the running one", "reindex the active session", "kill this session"]) {
      const r = resolvePaletteCommandHeuristic(q, ctx);
      expect(r?.ok).toBe(true);
      expect(r?.payload?.sessionId).toBe(9);
      expect(SET_ACTIONS_HAS(r?.action)).toBe(true);
    }
  });

  it("binds 'last/recent session' to the most recent id", () => {
    const r = resolvePaletteCommandHeuristic("stop the last session", ctx);
    expect(r?.payload?.sessionId).toBe(9);
  });

  it("returns a deterministic no-target failure instead of guessing", () => {
    const r = resolvePaletteCommandHeuristic("stop", ctx);
    expect(r?.ok).toBe(false);
    expect(r?.action).toBeNull();
    expect(r?.explanation.length).toBeGreaterThan(0);
  });

  it("requires a target for copy-ssh", () => {
    const r = resolvePaletteCommandHeuristic("copy the ssh command for session 2", ctx);
    expect(r?.action).toBe("copy-ssh");
    expect(r?.payload?.sessionId).toBe(2);
    const noTarget = resolvePaletteCommandHeuristic("ssh", { ...ctx, activeSessionId: null, recentSessionIds: [] });
    expect(noTarget?.ok).toBe(false);
  });
});

const SET_ACTIONS_HAS = (a: unknown) => ["stop-session", "reindex-session", "relaunch-session"].includes(a as string);

describe("resolvePaletteCommandHeuristic — navigation", () => {
  it("resolves named routes", () => {
    expect(resolvePaletteCommandHeuristic("go to dashboard", ctx)?.payload?.route).toBe("/");
    expect(resolvePaletteCommandHeuristic("show skills", ctx)?.payload?.route).toBe("/skills");
    expect(resolvePaletteCommandHeuristic("open memory", ctx)?.payload?.route).toBe("/memory");
    expect(resolvePaletteCommandHeuristic("list sessions", ctx)?.payload?.route).toBe("/sessions");
    expect(resolvePaletteCommandHeuristic("take me to templates", ctx)?.payload?.route).toBe("/templates");
    expect(resolvePaletteCommandHeuristic("design intelligence", ctx)?.payload?.route).toBe("/design-intelligence");
  });

  it("resolves open-session navigation to /sessions/N", () => {
    const r = resolvePaletteCommandHeuristic("open session 5", ctx);
    expect(r?.action).toBe("navigate");
    expect(r?.payload?.route).toBe("/sessions/5");
    expect(r?.payload?.sessionId).toBe(5);
  });

  it("resolves a bare 'session N' as navigation", () => {
    const r = resolvePaletteCommandHeuristic("session 5", ctx);
    expect(r?.action).toBe("navigate");
    expect(r?.payload?.route).toBe("/sessions/5");
  });
});

describe("resolvePaletteCommandHeuristic — new session + fallback", () => {
  it("resolves new-session variants", () => {
    for (const q of ["new session", "create a session", "start a new coding session", "launch session"]) {
      const r = resolvePaletteCommandHeuristic(q, ctx);
      expect(r?.action).toBe("new-session");
      expect(r?.ok).toBe(true);
    }
  });

  it("returns null for queries it cannot confidently place", () => {
    for (const q of ["please optimize all the things", "what is 2+2", "go", "help me fix the pipeline"]) {
      expect(resolvePaletteCommandHeuristic(q, ctx)).toBeNull();
    }
  });
});