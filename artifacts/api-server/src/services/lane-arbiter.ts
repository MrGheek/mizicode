/**
 * lane-arbiter.ts — RFC 0002 Phase 2 (verified AI conflict resolution)
 *
 * When a real merge conflict survives the structural merge, the Arbiter
 * reconstructs both lanes' durable intent (from lane-intent events) and
 * proposes a resolution. The proposal is ONLY accepted after the real test
 * command passes against it in a candidate worktree — a rejection leaves the
 * lane as a normal skipped conflict, resumable. True requirement conflicts
 * (one lane removes what another adds) are escalated to a human, never guessed.
 *
 * The LLM, test gate, and git executor are pluggable so the logic is
 * unit-testable without a real repo or network.
 */

import { logger } from "../lib/logger";
import { LANE_ARBITER_VERSION, renderLaneArbiter } from "../prompts/contracts";
import type { LlmMessage } from "./llm-client";
import type { IntentEvent } from "./lane-intent";
import { renderIntentBlock } from "./lane-intent";
import type { ConflictResolutionOutcome } from "./lane-intent";

export interface ArbiterConflict {
  filePath: string;
  baseContent: string;
  laneA: { laneId: number; content: string };
  laneB: { laneId: number; content: string };
  /** Intent events for both lanes, used to reconstruct durable intent. */
  intentEvents: IntentEvent[];
}

export interface ArbiterProposal {
  resolution: string;
  outcome: ConflictResolutionOutcome;
  summary: string;
}

export interface ArbiterResult {
  accepted: boolean;
  proposal: ArbiterProposal | null;
  /** Reason for rejection/escalation. */
  reason: string;
  /** True when the proposal was verified by a passing test command. */
  testVerified: boolean;
}

export type ArbiterLlm = (messages: LlmMessage[]) => Promise<string | null>;

export interface ArbiterTestGate {
  run(repoPath: string, sessionId: number): Promise<{ passed: boolean; output: string }>;
}

export interface ArbiterGit {
  /** Write the resolution into the candidate worktree. */
  writeFile(repoPath: string, filePath: string, content: string): Promise<boolean>;
}

export interface ArbiterOptions {
  llm: ArbiterLlm;
  testGate: ArbiterTestGate;
  git: ArbiterGit;
  /** Skip the test-verification step (used in tests / dry runs). */
  skipTestVerify?: boolean;
}

/** Parse the Arbiter's JSON response; null on malformed output. */
export function parseArbiterProposal(raw: string): ArbiterProposal | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const resolution = typeof parsed["resolution"] === "string" ? parsed["resolution"] : null;
    const outcome = parsed["outcome"];
    const summary = typeof parsed["summary"] === "string" ? parsed["summary"] : "";
    if (resolution === null) return null;
    if (outcome !== "preserved_both" && outcome !== "chose_one" && outcome !== "escalated") return null;
    return { resolution, outcome, summary };
  } catch {
    return null;
  }
}

/**
 * Resolve a conflicted file via the Arbiter. Returns an accepted proposal only
 * when the LLM produced a parseable, non-escalated resolution AND the test
 * command passed against it (unless skipTestVerify).
 */
export async function arbitrateConflict(
  conflict: ArbiterConflict,
  opts: ArbiterOptions,
  repoPath: string,
): Promise<ArbiterResult> {
  const intentA = renderIntentBlock(conflict.intentEvents.filter((e) => e.laneId === conflict.laneA.laneId));
  const intentB = renderIntentBlock(conflict.intentEvents.filter((e) => e.laneId === conflict.laneB.laneId));

  const messages = renderLaneArbiter({
    filePath: conflict.filePath,
    baseContent: conflict.baseContent,
    laneA: { laneId: conflict.laneA.laneId, content: conflict.laneA.content, intent: intentA || undefined },
    laneB: { laneId: conflict.laneB.laneId, content: conflict.laneB.content, intent: intentB || undefined },
  });

  const raw = await opts.llm(messages);
  if (!raw) {
    return { accepted: false, proposal: null, reason: "Arbiter LLM returned no output", testVerified: false };
  }

  const proposal = parseArbiterProposal(raw);
  if (!proposal) {
    return { accepted: false, proposal: null, reason: "Arbiter returned malformed JSON", testVerified: false };
  }

  if (proposal.outcome === "escalated") {
    return { accepted: false, proposal, reason: "escalated — requirements are logically incompatible", testVerified: false };
  }

  if (opts.skipTestVerify) {
    return { accepted: true, proposal, reason: "accepted (test verification skipped)", testVerified: false };
  }

  // Write the resolution and verify against the real test command.
  const written = await opts.git.writeFile(repoPath, conflict.filePath, proposal.resolution);
  if (!written) {
    return { accepted: false, proposal, reason: "could not write resolution to candidate worktree", testVerified: false };
  }

  const test = await opts.testGate.run(repoPath, 0);
  if (!test.passed) {
    return { accepted: false, proposal, reason: `test gate rejected resolution: ${test.output.slice(0, 200)}`, testVerified: false };
  }

  return { accepted: true, proposal, reason: "accepted + tests passed", testVerified: true };
}

/**
 * Default LLM adapter: routes through the shared callLlm client so prompt
 * versioning and the RFC 0001 budget/ledger apply uniformly.
 */
export function createDefaultArbiterLlm(): ArbiterLlm {
  return async (messages) => {
    const { callLlm } = await import("./llm-client");
    return callLlm({
      messages,
      temperature: 0,
      max_tokens: 2048,
      promptVersion: LANE_ARBITER_VERSION,
      logTag: "lane.arbiter",
      budget: { taskClass: "plan-reassess" },
    });
  };
}