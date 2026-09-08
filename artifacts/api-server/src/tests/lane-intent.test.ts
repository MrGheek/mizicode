import { beforeEach, describe, expect, it } from "vitest";
import {
  MemoryIntentStore,
  MemoryResolutionStore,
  renderIntentBlock,
  type IntentEvent,
} from "../services/lane-intent";

let intentStore: MemoryIntentStore;
let resolutionStore: MemoryResolutionStore;

beforeEach(() => {
  intentStore = new MemoryIntentStore();
  resolutionStore = new MemoryResolutionStore();
  intentStore.clear();
  resolutionStore.clear();
});

describe("MemoryIntentStore", () => {
  it("publishes and lists typed intent events per session", async () => {
    await intentStore.publish({ sessionId: 1, laneId: 1, eventType: "intent_decision", summary: "Reuse SessionService for OAuth" });
    await intentStore.publish({ sessionId: 1, laneId: 2, eventType: "intent_interface_change", summary: "UserIdentity gains providerType", contract: "UserIdentity(providerType, providerId)" });
    await intentStore.publish({ sessionId: 2, laneId: 1, eventType: "intent_warning", summary: "Preserve OAuth fields", risk: "Dropping fields breaks login" });

    const s1 = await intentStore.listForSession(1);
    expect(s1).toHaveLength(2);
    expect(s1[0]!.eventType).toBe("intent_decision");
    expect(s1[1]!.contract).toBe("UserIdentity(providerType, providerId)");

    const s1Lane2 = await intentStore.listForSession(1, 2);
    expect(s1Lane2).toHaveLength(1);
    expect(s1Lane2[0]!.eventType).toBe("intent_interface_change");
  });

  it("round-trips verification evidence", async () => {
    const e = await intentStore.publish({ sessionId: 1, laneId: 1, eventType: "intent_verification", summary: "auth tests pass", evidence: "pytest tests/auth -q: PASS" });
    const got = await intentStore.get(e.id);
    expect(got?.evidence).toBe("pytest tests/auth -q: PASS");
  });
});

describe("MemoryResolutionStore", () => {
  it("records conflict-resolution notes with intent references", async () => {
    const r = await resolutionStore.record({
      sessionId: 1,
      mergeJobId: 7,
      filePath: "src/auth/UserIdentity.ts",
      outcome: "preserved_both",
      summary: "Preserved OAuth provider fields from lane A while adding role fields from lane B",
      intentEventIds: [1, 2],
      testVerified: true,
    });
    expect(r.id).toBeGreaterThan(0);
    expect(r.testVerified).toBe(true);

    const list = await resolutionStore.listForSession(1);
    expect(list).toHaveLength(1);
    expect(list[0]!.intentEventIds).toEqual([1, 2]);
  });
});

describe("renderIntentBlock", () => {
  it("renders a compact prompt block from intent events", () => {
    const events: IntentEvent[] = [
      { id: 1, sessionId: 1, laneId: 1, eventType: "intent_decision", summary: "Reuse SessionService", file: "src/auth/SessionService.ts", contract: null, risk: null, evidence: null, createdAt: new Date() },
      { id: 2, sessionId: 1, laneId: 2, eventType: "intent_warning", summary: "Preserve OAuth fields", file: null, contract: null, risk: "Dropping fields breaks login", evidence: null, createdAt: new Date() },
    ];
    const block = renderIntentBlock(events);
    expect(block).toContain("Lane intent");
    expect(block).toContain("[intent_decision] lane 1 @ src/auth/SessionService.ts: Reuse SessionService");
    expect(block).toContain("risk=Dropping fields breaks login");
  });

  it("returns empty for no events", () => {
    expect(renderIntentBlock([])).toBe("");
  });
});