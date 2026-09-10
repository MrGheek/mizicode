/**
 * deliverable-contract.ts — RFC 0003 Phase 2: deliverable schema + per-station
 * quality gates.
 *
 * A lane's output must satisfy a schema before it can merge: diff, tests run +
 * results, intent events (RFC 0002), verification evidence, and a clean
 * worktree. Non-conforming work is rejected at the station and routed to
 * rework — never merged.
 *
 * Each station role has a gate (build station requires compile+test; review
 * station requires lint+typecheck). Gates reuse `mizi-language-tasks` and
 * RFC 0002's test-gate machinery.
 */

import type { StationRole } from "@workspace/db";

// ── Deliverable schema ───────────────────────────────────────────────────────

export interface TestResult {
  /** Test suite / file name. */
  suite: string;
  passed: number;
  failed: number;
  /** Overall suite status. */
  status: "pass" | "fail";
}

export interface VerificationTask {
  /** Task name (e.g. "compile", "lint", "typecheck", "test"). */
  taskName: string;
  /** Task type — maps to a gate name. */
  taskType: "compile" | "lint" | "typecheck" | "test";
  /** Whether the task passed. */
  status: "pass" | "fail";
  /** Optional detail / summary (error output, counts). */
  detail?: string;
}

/**
 * A lane's output — must satisfy the station's gate before it can merge.
 *
 * All fields are required. A deliverable with empty diff, no intent events,
 * or a dirty worktree is non-conforming regardless of verification evidence.
 */
export interface Deliverable {
  /** Work order this deliverable is for. */
  workOrderId: number;
  /** Station that produced it. */
  stationId: number;
  /** Unified diff / patch content (must be non-empty). */
  diff: string;
  /** RFC 0002 intent event IDs (must be non-empty). */
  intentEvents: string[];
  /** Test suite results. */
  tests: TestResult[];
  /** Verification evidence: compile, lint, typecheck, test. */
  verification: VerificationTask[];
  /** Whether the worktree was clean after applying. */
  worktreeClean: boolean;
}

// ── Per-station quality gates ────────────────────────────────────────────────

export type GateName = "compile" | "lint" | "typecheck" | "test";

/**
 * Per-station-role required gates.
 *
 * - build  → compile + test (the code must build and pass tests)
 * - review → lint + typecheck (code style and type safety)
 * - debug  → test (reproduce + fix the bug)
 * - refactor → typecheck + test (structural change without regression)
 * - explore → no gates (exploration / prototyping)
 * - team → test + lint + typecheck (cross-cutting team changes)
 */
export const STATION_ROLE_GATES: Record<StationRole, GateName[]> = {
  build: ["compile", "test"],
  review: ["lint", "typecheck"],
  debug: ["test"],
  refactor: ["typecheck", "test"],
  explore: [],
  team: ["test", "lint", "typecheck"],
};

export interface GateResult {
  gate: GateName;
  passed: boolean;
  detail: string;
}

/**
 * Inspect a deliverable against the required gates for a station role.
 *
 * Returns a conforming result (all gates passed + base checks) or a
 * non-conforming result with the failing gates and a defect class suitable
 * for the rework loop.
 */
export interface DeliverableInspection {
  /** Whether the deliverable conforms to the station's gate. */
  conforms: boolean;
  /** Per-gate results. */
  gates: GateResult[];
  /** Defect class (null when conforms). First failing gate name suffices. */
  defectClass: string | null;
  /** Human-readable reasons for non-conformance. */
  reasons: string[];
}

// ── Gate logic ───────────────────────────────────────────────────────────────

function findVerification(deliverable: Deliverable, taskType: VerificationTask["taskType"]): VerificationTask | undefined {
  return deliverable.verification.find((v) => v.taskType === taskType);
}

function checkGate(deliverable: Deliverable, gate: GateName): GateResult {
  const evidence = findVerification(deliverable, gate);
  if (!evidence) {
    return { gate, passed: false, detail: `no ${gate} evidence provided` };
  }
  if (evidence.status === "fail") {
    return { gate, passed: false, detail: `${gate} failed: ${evidence.detail ?? "no detail"}` };
  }
  return { gate, passed: true, detail: `${gate} passed` };
}

/**
 * Inspect a deliverable against a station role's required gates.
 *
 * Base checks (always enforced, regardless of station role):
 * - diff must be non-empty
 * - intentEvents must be non-empty
 * - worktreeClean must be true
 *
 * Then the station role's required gates are checked against the
 * verification evidence.
 */
export function inspectDeliverable(
  deliverable: Deliverable,
  stationRole: StationRole,
): DeliverableInspection {
  const reasons: string[] = [];
  const gates: GateResult[] = [];

  // ── Base checks ────────────────────────────────────────────────────────
  if (!deliverable.diff || deliverable.diff.trim().length === 0) {
    reasons.push("diff is empty");
  }
  if (deliverable.intentEvents.length === 0) {
    reasons.push("no intent events (RFC 0002)");
  }
  if (!deliverable.worktreeClean) {
    reasons.push("worktree is dirty");
  }

  // ── Station role gates ─────────────────────────────────────────────────
  const required = STATION_ROLE_GATES[stationRole] ?? [];
  for (const gate of required) {
    const result = checkGate(deliverable, gate);
    gates.push(result);
    if (!result.passed) {
      reasons.push(result.detail);
    }
  }

  const conforms = reasons.length === 0;
  const defectClass = conforms ? null : gates.find((g) => !g.passed)?.gate ?? "base";

  return { conforms, gates, defectClass, reasons };
}
