import { describe, expect, it } from "vitest";
import {
  compareLaneEval,
  runLaneEval,
  type LaneEvalRunResult,
  type LaneEvalRunner,
  type LaneEvalScenario,
} from "../services/lane-eval";

const scenario: LaneEvalScenario = {
  goal: "Add OAuth + billing + dashboard nav",
  tasks: ["Add OAuth", "Add billing", "Add dashboard nav"],
  acceptanceCriteria: ["OAuth works", "Billing works", "Nav works"],
};

function result(partial: Partial<LaneEvalRunResult>): LaneEvalRunResult {
  return {
    wallClockMs: 0,
    testsPassed: true,
    mergeConflicts: 0,
    structuralMerges: 0,
    correctness: null,
    laneCount: 1,
    ...partial,
  };
}

describe("compareLaneEval", () => {
  it("declares multi_lane_wins when faster with no correctness regression", () => {
    const c = compareLaneEval(
      scenario,
      result({ wallClockMs: 120_000, correctness: 0.8 }),
      result({ wallClockMs: 45_000, laneCount: 3, correctness: 0.85 }),
    );
    expect(c.verdict).toBe("multi_lane_wins");
    expect(c.deltas.wallClockMs).toBe(-75_000);
  });

  it("declares single_agent_wins when slower", () => {
    const c = compareLaneEval(
      scenario,
      result({ wallClockMs: 30_000, correctness: 0.8 }),
      result({ wallClockMs: 90_000, laneCount: 3, correctness: 0.8 }),
    );
    expect(c.verdict).toBe("single_agent_wins");
  });

  it("declares inconclusive when faster but correctness regressed", () => {
    const c = compareLaneEval(
      scenario,
      result({ wallClockMs: 120_000, correctness: 0.9 }),
      result({ wallClockMs: 40_000, laneCount: 3, correctness: 0.5 }),
    );
    expect(c.verdict).toBe("inconclusive");
  });

  it("declares tie when neither faster nor correctness-regressed", () => {
    const c = compareLaneEval(
      scenario,
      result({ wallClockMs: 60_000, correctness: 0.8 }),
      result({ wallClockMs: 60_000, laneCount: 3, correctness: 0.8 }),
    );
    expect(c.verdict).toBe("tie");
  });

  it("treats unjudged correctness as non-regressing", () => {
    const c = compareLaneEval(
      scenario,
      result({ wallClockMs: 100_000 }),
      result({ wallClockMs: 50_000, laneCount: 3 }),
    );
    expect(c.verdict).toBe("multi_lane_wins");
  });
});

describe("runLaneEval", () => {
  it("runs both arms and compares", async () => {
    const runner: LaneEvalRunner = {
      async run(_s, laneCount) {
        return result({
          wallClockMs: laneCount === 1 ? 100_000 : 40_000,
          laneCount,
          mergeConflicts: laneCount === 1 ? 0 : 1,
        });
      },
    };

    const report = await runLaneEval({ scenario, runner });
    expect(report.judged).toBe(false);
    expect(report.comparison.singleAgent.laneCount).toBe(1);
    expect(report.comparison.multiLane.laneCount).toBe(3);
    expect(report.comparison.verdict).toBe("multi_lane_wins");
  });

  it("judges correctness when a judge + arm output are provided", async () => {
    const runner: LaneEvalRunner = {
      async run(_s, laneCount) {
        return result({ wallClockMs: laneCount === 1 ? 100_000 : 40_000, laneCount });
      },
    };
    const judge = async () => ({ score: 0.9, summary: "good" });
    const armOutput = async () => "diff";

    const report = await runLaneEval({ scenario, runner, judge, armOutput });
    expect(report.judged).toBe(true);
    expect(report.comparison.singleAgent.correctness).toBe(0.9);
    expect(report.comparison.multiLane.correctness).toBe(0.9);
  });
});