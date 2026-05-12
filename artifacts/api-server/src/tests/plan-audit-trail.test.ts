/**
 * Regression tests for the plan approval task preservation policy.
 *
 * Covers the core requirement: completed tasks (done/skipped) must remain
 * on the board as an audit trail even when a subsequent plan approval omits them.
 */
import { describe, it, expect } from "vitest";
import { shouldPreserveTask } from "../services/plan";

type Task = Parameters<typeof shouldPreserveTask>[0];

function task(overrides: Partial<Task> & { id: number }): Task {
  return {
    text: "default task text",
    status: "planned",
    confirmedByUser: false,
    ...overrides,
  };
}

const EMPTY = new Set<number>();
const EMPTY_TEXTS = new Set<string>();

describe("shouldPreserveTask — audit trail preservation policy", () => {
  describe("approved by id", () => {
    it("preserves a task whose id is in the approved set", () => {
      const t = task({ id: 1, status: "planned" });
      expect(shouldPreserveTask(t, new Set([1]), EMPTY_TEXTS, EMPTY)).toBe(true);
    });

    it("removes a planned task whose id is NOT in the approved set", () => {
      const t = task({ id: 99, status: "planned" });
      expect(shouldPreserveTask(t, new Set([1, 2]), EMPTY_TEXTS, EMPTY)).toBe(false);
    });
  });

  describe("approved by text fallback", () => {
    it("preserves a task matched by normalized text when no id is present", () => {
      const t = task({ id: 5, text: "  Add unit tests  ", status: "planned" });
      expect(shouldPreserveTask(t, EMPTY, new Set(["add unit tests"]), EMPTY)).toBe(true);
    });
  });

  describe("audit trail (done / skipped)", () => {
    it("preserves a done task even when omitted from the approved step list", () => {
      const t = task({ id: 10, text: "Set up CI pipeline", status: "done" });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, EMPTY)).toBe(true);
    });

    it("preserves a skipped task even when omitted from the approved step list", () => {
      const t = task({ id: 11, text: "Write docs", status: "skipped" });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, EMPTY)).toBe(true);
    });

    it("does NOT preserve a planned task omitted from the approved list", () => {
      const t = task({ id: 12, text: "Unstarted work", status: "planned" });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, EMPTY)).toBe(false);
    });

    it("does NOT preserve an in_progress task omitted from the approved list (not audit status)", () => {
      const t = task({ id: 13, text: "Active work", status: "in_progress" });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, EMPTY)).toBe(false);
    });

    // Core regression: task marked done by reassessment (confirmedByUser=false)
    // must survive a subsequent plan approval that omits it.
    it("preserves a reassessment-done task (confirmedByUser=false) omitted from next approval", () => {
      const t = task({ id: 20, text: "Implement auth", status: "done", confirmedByUser: false });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, EMPTY)).toBe(true);
    });
  });

  describe("confirmedByUser", () => {
    it("preserves a confirmed planned task omitted from the approved list", () => {
      const t = task({ id: 30, status: "planned", confirmedByUser: true });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, EMPTY)).toBe(true);
    });
  });

  describe("explicit removal overrides all protections", () => {
    it("removes a done task that is explicitly removed by the user", () => {
      const t = task({ id: 40, status: "done" });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, new Set([40]))).toBe(false);
    });

    it("removes a confirmedByUser task that is explicitly removed", () => {
      const t = task({ id: 41, status: "planned", confirmedByUser: true });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, new Set([41]))).toBe(false);
    });

    it("removes a skipped task that is explicitly removed", () => {
      const t = task({ id: 42, status: "skipped" });
      expect(shouldPreserveTask(t, EMPTY, EMPTY_TEXTS, new Set([42]))).toBe(false);
    });
  });
});
