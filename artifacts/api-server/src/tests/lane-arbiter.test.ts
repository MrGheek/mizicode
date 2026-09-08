import { describe, expect, it } from "vitest";
import {
  arbitrateConflict,
  parseArbiterProposal,
  type ArbiterConflict,
  type ArbiterLlm,
} from "../services/lane-arbiter";
import type { IntentEvent } from "../services/lane-intent";

const conflict: ArbiterConflict = {
  filePath: "src/auth/UserIdentity.ts",
  baseContent: "export class UserIdentity {}",
  laneA: { laneId: 1, content: "export class UserIdentity { oauthProvider!: string }" },
  laneB: { laneId: 2, content: "export class UserIdentity { role!: string }" },
  intentEvents: [
    { id: 1, sessionId: 1, laneId: 1, eventType: "intent_interface_change", summary: "Add OAuth provider identity", file: "src/auth/UserIdentity.ts", contract: "UserIdentity(providerType)", risk: null, evidence: null, createdAt: new Date() },
    { id: 2, sessionId: 1, laneId: 2, eventType: "intent_interface_change", summary: "Add authorization role", file: "src/auth/UserIdentity.ts", contract: "UserIdentity(role)", risk: null, evidence: null, createdAt: new Date() },
  ] as IntentEvent[],
};

function llmReturning(raw: string): ArbiterLlm {
  return async () => raw;
}

const passingGate = { run: async () => ({ passed: true, output: "ok" }) };
const failingGate = { run: async () => ({ passed: false, output: "1 test failed" }) };
const git = { writeFile: async () => true };

describe("parseArbiterProposal", () => {
  it("parses a valid preserved_both proposal", () => {
    const p = parseArbiterProposal('{"resolution":"merged","outcome":"preserved_both","summary":"both survive"}');
    expect(p).toEqual({ resolution: "merged", outcome: "preserved_both", summary: "both survive" });
  });

  it("returns null for malformed JSON", () => {
    expect(parseArbiterProposal("not json")).toBeNull();
    expect(parseArbiterProposal('{"resolution":"x","outcome":"bogus"}')).toBeNull();
  });
});

describe("arbitrateConflict", () => {
  it("accepts a preserved_both proposal verified by a passing test", async () => {
    const r = await arbitrateConflict(conflict, {
      llm: llmReturning('{"resolution":"merged","outcome":"preserved_both","summary":"both survive"}'),
      testGate: passingGate,
      git,
    }, "/repo");
    expect(r.accepted).toBe(true);
    expect(r.testVerified).toBe(true);
    expect(r.proposal?.outcome).toBe("preserved_both");
  });

  it("rejects a proposal when the test gate fails", async () => {
    const r = await arbitrateConflict(conflict, {
      llm: llmReturning('{"resolution":"merged","outcome":"preserved_both","summary":"both survive"}'),
      testGate: failingGate,
      git,
    }, "/repo");
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("test gate rejected");
    expect(r.testVerified).toBe(false);
  });

  it("escalates true requirement conflicts instead of guessing", async () => {
    const r = await arbitrateConflict(conflict, {
      llm: llmReturning('{"resolution":"","outcome":"escalated","summary":"one removes what the other adds"}'),
      testGate: passingGate,
      git,
    }, "/repo");
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("escalated");
  });

  it("rejects when the LLM returns no output", async () => {
    const r = await arbitrateConflict(conflict, { llm: async () => null, testGate: passingGate, git }, "/repo");
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("no output");
  });

  it("accepts without test verification when skipTestVerify is set", async () => {
    const r = await arbitrateConflict(conflict, {
      llm: llmReturning('{"resolution":"merged","outcome":"chose_one","summary":"subsumed"}'),
      testGate: failingGate,
      git,
      skipTestVerify: true,
    }, "/repo");
    expect(r.accepted).toBe(true);
    expect(r.testVerified).toBe(false);
  });
});