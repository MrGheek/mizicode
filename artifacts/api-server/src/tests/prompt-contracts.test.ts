import { describe, it, expect } from "vitest";
import {
  PLAN_GENERATE_VERSION,
  PLAN_REASSESS_VERSION,
  PLAN_DECOMPOSE_VERSION,
  MEMORY_SIDECAR_VERIFY_VERSION,
  PALETTE_INTENT_VERSION,
  PlanGenerateInputSchema,
  PlanReassessInputSchema,
  PlanDecomposeInputSchema,
  MemorySidecarVerifyInputSchema,
  PaletteIntentInputSchema,
  renderPlanGenerate,
  renderPlanReassess,
  renderPlanDecompose,
  renderMemorySidecarVerify,
  renderPaletteIntent,
  renderPrompt,
} from "../prompts/contracts";

// ── Version stamps ─────────────────────────────────────────────────────────────

describe("prompt contract version stamps", () => {
  it("all stamps are non-empty semver-style strings (site@major.minor.patch)", () => {
    const stamps = [
      PLAN_GENERATE_VERSION,
      PLAN_REASSESS_VERSION,
      PLAN_DECOMPOSE_VERSION,
      MEMORY_SIDECAR_VERIFY_VERSION,
      PALETTE_INTENT_VERSION,
    ];
    for (const v of stamps) {
      expect(v).toMatch(/^[\w.]+@\d+\.\d+\.\d+$/);
    }
  });

  it("version stamps are stable (hardcoded semver, not runtime-computed hashes)", () => {
    expect(PLAN_GENERATE_VERSION).toBe("plan.generate@1.0.0");
    expect(PLAN_REASSESS_VERSION).toBe("plan.reassess@1.0.0");
    expect(PLAN_DECOMPOSE_VERSION).toBe("plan.decompose@1.0.0");
    expect(MEMORY_SIDECAR_VERIFY_VERSION).toBe("memory.sidecarVerify@1.0.0");
    expect(PALETTE_INTENT_VERSION).toBe("palette.intent@1.0.0");
  });

  it("each stamp has a unique prefix identifying its site", () => {
    const prefixes = [
      PLAN_GENERATE_VERSION,
      PLAN_REASSESS_VERSION,
      PLAN_DECOMPOSE_VERSION,
      MEMORY_SIDECAR_VERIFY_VERSION,
      PALETTE_INTENT_VERSION,
    ].map((v) => v.split("@")[0]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

// ── renderPlanGenerate ─────────────────────────────────────────────────────────

describe("renderPlanGenerate", () => {
  it("returns [system, user] messages", () => {
    const msgs = renderPlanGenerate({ intentText: "Build a todo app" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });

  it("user message contains the intent text", () => {
    const msgs = renderPlanGenerate({ intentText: "Build a search feature" });
    expect(msgs[1]!.content).toContain("Build a search feature");
  });

  it("user message includes repoUrl when provided", () => {
    const msgs = renderPlanGenerate({
      intentText: "Refactor auth",
      repoUrl: "https://github.com/acme/auth-service",
    });
    expect(msgs[1]!.content).toContain("github.com/acme/auth-service");
  });

  it("omits repository line when repoUrl is null", () => {
    const msgs = renderPlanGenerate({ intentText: "Plan something", repoUrl: null });
    expect(msgs[1]!.content).not.toContain("Repository:");
  });

  it("includes USER CONFIRMED marker for confirmed tasks", () => {
    const msgs = renderPlanGenerate({
      intentText: "Add tests",
      existingTasks: [
        { stepIndex: 0, text: "Setup DB", status: "done", confirmedByUser: true },
        { stepIndex: 1, text: "Write unit tests", status: "planned", confirmedByUser: false },
      ],
    });
    expect(msgs[1]!.content).toContain("USER CONFIRMED");
    expect(msgs[1]!.content).toContain("Write unit tests");
  });

  it("includes skillContext section when provided", () => {
    const msgs = renderPlanGenerate({
      intentText: "Migrate DB",
      skillContext: "Active skills: mizi-builder, karpathy-doctrine",
    });
    expect(msgs[1]!.content).toContain("Active skills: mizi-builder");
  });

  it("rejects invalid input (empty intentText)", () => {
    expect(() =>
      PlanGenerateInputSchema.parse({ intentText: 123 }),
    ).toThrow();
  });
});

// ── renderPlanReassess ─────────────────────────────────────────────────────────

describe("renderPlanReassess", () => {
  const baseTasks = [
    { id: 1, text: "Setup DB", status: "planned", confirmedByUser: false },
    { id: 2, text: "Auth flow", status: "planned", confirmedByUser: true },
  ];
  const baseObs = [
    { toolName: "bash", inputSummary: "ls -la", outputSummary: "file list" },
  ];

  it("returns [system, user] messages", () => {
    const msgs = renderPlanReassess({ tasks: baseTasks, observations: baseObs });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });

  it("user message contains task IDs and text", () => {
    const msgs = renderPlanReassess({ tasks: baseTasks, observations: baseObs });
    expect(msgs[1]!.content).toContain("taskId=1");
    expect(msgs[1]!.content).toContain("Setup DB");
    expect(msgs[1]!.content).toContain("USER CONFIRMED");
  });

  it("truncates observations at 40 entries", () => {
    const manyObs = Array.from({ length: 50 }, (_, i) => ({
      toolName: "read",
      inputSummary: `file${i}`,
      outputSummary: `content${i}`,
    }));
    const msgs = renderPlanReassess({ tasks: baseTasks, observations: manyObs });
    const obsCount = (msgs[1]!.content.match(/\[read\]/g) ?? []).length;
    expect(obsCount).toBeLessThanOrEqual(40);
  });

  it("rejects input with missing tasks field", () => {
    expect(() => PlanReassessInputSchema.parse({ observations: [] })).toThrow();
  });
});

// ── renderPlanDecompose ────────────────────────────────────────────────────────

describe("renderPlanDecompose", () => {
  const baseInput = {
    existingTasks: [{ text: "Setup CI", status: "done" }],
    recentObservations: [{ toolName: "bash", inputSummary: "npm test", outputSummary: "3 failures" }],
    activeSkills: [{ name: "mizi-builder", tasks: ["build", "debug"] }],
    rationaleContext: "Fast TypeScript project",
    maxCandidates: 3,
  };

  it("returns [system, user] messages", () => {
    const msgs = renderPlanDecompose(baseInput);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });

  it("system prompt includes maxCandidates limit", () => {
    const msgs = renderPlanDecompose({ ...baseInput, maxCandidates: 5 });
    expect(msgs[0]!.content).toContain("Maximum 5 tasks");
  });

  it("system prompt includes active skill names", () => {
    const msgs = renderPlanDecompose(baseInput);
    expect(msgs[0]!.content).toContain("mizi-builder");
  });

  it("user message includes task list and observations", () => {
    const msgs = renderPlanDecompose(baseInput);
    expect(msgs[1]!.content).toContain("Setup CI");
    expect(msgs[1]!.content).toContain("npm test");
  });

  it("applies default maxCandidates=3 when not provided", () => {
    const { maxCandidates: _omit, ...withoutMax } = baseInput;
    const input = PlanDecomposeInputSchema.parse(withoutMax);
    expect(input.maxCandidates).toBe(3);
  });
});

// ── renderMemorySidecarVerify ──────────────────────────────────────────────────

describe("renderMemorySidecarVerify", () => {
  const baseInput = {
    turnContent: "How do I set up auth?",
    candidateContent: "Use JWT with refresh tokens",
    candidateId: 42,
    similarity: 0.87,
  };

  it("returns [system, user] messages", () => {
    const msgs = renderMemorySidecarVerify(baseInput);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });

  it("user message contains turn and memory content", () => {
    const msgs = renderMemorySidecarVerify(baseInput);
    expect(msgs[1]!.content).toContain("TURN:");
    expect(msgs[1]!.content).toContain("How do I set up auth?");
    expect(msgs[1]!.content).toContain("MEMORY:");
    expect(msgs[1]!.content).toContain("Use JWT with refresh tokens");
  });

  it("truncates very long turnContent to 1500 chars", () => {
    const longContent = "x".repeat(3000);
    const msgs = renderMemorySidecarVerify({ ...baseInput, turnContent: longContent });
    expect(msgs[1]!.content.length).toBeLessThan(4000);
  });

  it("rejects out-of-range similarity values", () => {
    expect(() =>
      MemorySidecarVerifyInputSchema.parse({ ...baseInput, similarity: 1.5 }),
    ).toThrow();
  });
});

// ── renderPaletteIntent ────────────────────────────────────────────────────────

describe("renderPaletteIntent", () => {
  const baseInput = {
    query: "stop my session",
    context: {
      route: "/sessions",
      activeSessionId: 7,
      activeSessionStatus: "running",
      recentSessionIds: [7, 5],
    },
    fewShotExamples: [],
  };

  it("returns [system, user] messages", () => {
    const msgs = renderPaletteIntent(baseInput);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });

  it("user message contains the query", () => {
    const msgs = renderPaletteIntent(baseInput);
    expect(msgs[1]!.content).toContain("stop my session");
  });

  it("user message includes context fields", () => {
    const msgs = renderPaletteIntent(baseInput);
    expect(msgs[1]!.content).toContain("activeSessionId: 7");
    expect(msgs[1]!.content).toContain("route: /sessions");
  });

  it("appends few-shot examples to system prompt when provided", () => {
    const withExamples = {
      ...baseInput,
      fewShotExamples: [
        { query: "navigate to skills", action: "navigate", payloadJson: { route: "/skills", sessionId: null }, explanation: "Opening skills page" },
      ],
    };
    const msgs = renderPaletteIntent(withExamples);
    expect(msgs[0]!.content).toContain("Past successful commands");
    expect(msgs[0]!.content).toContain("navigate to skills");
  });

  it("does not append few-shot block when examples array is empty", () => {
    const msgs = renderPaletteIntent(baseInput);
    expect(msgs[0]!.content).not.toContain("Past successful commands");
  });

  it("defaults context fields correctly via schema parse", () => {
    const partial = PaletteIntentInputSchema.parse({
      query: "go to dashboard",
      context: {},
    });
    expect(partial.context.route).toBe("/");
    expect(partial.context.activeSessionId).toBeNull();
    expect(partial.context.recentSessionIds).toEqual([]);
    expect(partial.fewShotExamples).toEqual([]);
  });

  it("rejects query longer than 500 chars", () => {
    expect(() =>
      PaletteIntentInputSchema.parse({ query: "x".repeat(501), context: {} }),
    ).toThrow();
  });
});

// ── renderPrompt generic dispatcher ───────────────────────────────────────────

describe("renderPrompt generic dispatcher", () => {
  it("routes plan.generate correctly", () => {
    const msgs = renderPrompt("plan.generate", { intentText: "Build something" });
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toContain("Build something");
  });

  it("routes plan.reassess correctly", () => {
    const msgs = renderPrompt("plan.reassess", {
      tasks: [{ id: 1, text: "Do thing", status: "planned", confirmedByUser: false }],
      observations: [],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toContain("taskId=1");
  });

  it("routes plan.decompose correctly", () => {
    const msgs = renderPrompt("plan.decompose", {
      existingTasks: [],
      recentObservations: [],
      activeSkills: [],
      rationaleContext: "",
    });
    expect(msgs).toHaveLength(2);
  });

  it("routes memory.sidecarVerify correctly", () => {
    const msgs = renderPrompt("memory.sidecarVerify", {
      turnContent: "question",
      candidateContent: "answer",
      candidateId: 1,
      similarity: 0.5,
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toContain("TURN:");
  });

  it("routes palette.intent correctly", () => {
    const msgs = renderPrompt("palette.intent", {
      query: "open skills",
      context: {},
      fewShotExamples: [],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toContain("open skills");
  });

  it("throws for unknown contract ID", () => {
    expect(() => renderPrompt("unknown.contract", {})).toThrow(
      "Unknown prompt contract: unknown.contract",
    );
  });
});
