/**
 * Tests verifying that all workflow skills in DEFAULT_SKILLS are well-formed
 * and rank correctly for their target repo types.
 *
 * Covers:
 *   - Every skill in DEFAULT_SKILLS has a unique id (no duplicates)
 *   - All six language workflow skills are present:
 *     ruby-workflow, java-workflow, swift-workflow, cpp-workflow,
 *     kotlin-workflow, typescript-node-workflow
 *   - Each workflow skill has the expected class, install type, and safety profile
 *   - Each workflow skill declares the correct repoKinds triggers
 *   - Each workflow skill ranks first (above a pool of generic competitors) when
 *     the session repoLangs match its primary language — confirming the ranker
 *     signals are wired correctly end-to-end from DEFAULT_SKILLS through rankSkills
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_SKILLS } from "../services/default-skills";
import { rankSkills } from "../services/skills-ranker";
import type { MiziSkillManifest, SessionContext } from "../services/skills-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSkill(id: string): MiziSkillManifest | undefined {
  return DEFAULT_SKILLS.find(s => s.id === id);
}

/** Generic skill that scores well (repoKinds: any) but cannot beat a
 *  language-specific skill when the session language aligns. */
function makeGeneric(id: string): MiziSkillManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    class: "workflow",
    source: { repoUrl: "https://github.com/mizi/skills", commitSha: "builtin", license: "MIT", trust: "mizi_native" },
    summary: `Generic skill ${id}`,
    triggers: { tasks: ["build", "debug", "refactor", "review"], repoKinds: ["any"], sessionModes: ["solo", "team"] },
    compatibility: { models: ["kimi", "qwen", "glm", "deepseek", "minimax"], interfaces: ["claw", "vscode", "bolt"] },
    instructions: { system: [] },
    install: { type: "virtual", outputs: ["system_prompt_fragment"] },
    cost: { tokenOverheadEstimate: 100 },
    rankingHints: { taskFitWeight: 1.0, repoFitWeight: 0.5, measuredLiftWeight: 0.0 },
    safety: { shellExecution: "none", networkAccess: "none" },
  };
}

/** Build a session context for a given primary language. */
function langCtx(lang: string): SessionContext {
  return {
    sessionType: "solo",
    taskMode: "build",
    modelProfile: "deepseek",
    repoLangs: [lang],
    tokenMode: "core",
  };
}

const GENERIC_POOL = ["generic-a", "generic-b", "generic-c", "generic-d", "generic-e"].map(makeGeneric);

// ---------------------------------------------------------------------------
// ID uniqueness across the entire DEFAULT_SKILLS list
// ---------------------------------------------------------------------------

describe("DEFAULT_SKILLS — id uniqueness", () => {
  it("every skill has a unique id (no duplicates)", () => {
    const ids = DEFAULT_SKILLS.map(s => s.id);
    const unique = new Set(ids);
    const duplicates = ids.filter((id, idx) => ids.indexOf(id) !== idx);
    expect(duplicates).toEqual([]);
    expect(unique.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Presence of all six language workflow skills
// ---------------------------------------------------------------------------

const WORKFLOW_SKILL_IDS = [
  "ruby-workflow",
  "java-workflow",
  "swift-workflow",
  "cpp-workflow",
  "kotlin-workflow",
  "typescript-node-workflow",
] as const;

describe("workflow skills — presence in DEFAULT_SKILLS", () => {
  for (const id of WORKFLOW_SKILL_IDS) {
    it(`${id} exists`, () => {
      expect(getSkill(id)).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Shared metadata assertions
// ---------------------------------------------------------------------------

describe("workflow skills — class", () => {
  for (const id of WORKFLOW_SKILL_IDS) {
    it(`${id} has class "efficiency"`, () => {
      expect(getSkill(id)?.class).toBe("efficiency");
    });
  }
});

describe("workflow skills — install type", () => {
  for (const id of WORKFLOW_SKILL_IDS) {
    it(`${id} has install.type "virtual"`, () => {
      expect(getSkill(id)?.install.type).toBe("virtual");
    });
  }
});

describe("workflow skills — safety profile", () => {
  for (const id of WORKFLOW_SKILL_IDS) {
    it(`${id} has shellExecution "restricted"`, () => {
      expect(getSkill(id)?.safety.shellExecution).toBe("restricted");
    });

    it(`${id} has networkAccess "none"`, () => {
      expect(getSkill(id)?.safety.networkAccess).toBe("none");
    });
  }
});

// ---------------------------------------------------------------------------
// repoKinds trigger assertions
// ---------------------------------------------------------------------------

describe("workflow skills — repoKinds triggers", () => {
  it("ruby-workflow triggers on ruby, rails, and sinatra", () => {
    const skill = getSkill("ruby-workflow")!;
    expect(skill.triggers.repoKinds).toContain("ruby");
    expect(skill.triggers.repoKinds).toContain("rails");
    expect(skill.triggers.repoKinds).toContain("sinatra");
  });

  it("java-workflow triggers on java, maven, gradle, and spring", () => {
    const skill = getSkill("java-workflow")!;
    expect(skill.triggers.repoKinds).toContain("java");
    expect(skill.triggers.repoKinds).toContain("maven");
    expect(skill.triggers.repoKinds).toContain("gradle");
    expect(skill.triggers.repoKinds).toContain("spring");
  });

  it("swift-workflow triggers on swift, swiftpm, ios, and macos", () => {
    const skill = getSkill("swift-workflow")!;
    expect(skill.triggers.repoKinds).toContain("swift");
    expect(skill.triggers.repoKinds).toContain("swiftpm");
    expect(skill.triggers.repoKinds).toContain("ios");
    expect(skill.triggers.repoKinds).toContain("macos");
  });

  it("cpp-workflow triggers on cpp, c++, and cmake", () => {
    const skill = getSkill("cpp-workflow")!;
    expect(skill.triggers.repoKinds).toContain("cpp");
    expect(skill.triggers.repoKinds).toContain("c++");
    expect(skill.triggers.repoKinds).toContain("cmake");
  });

  it("kotlin-workflow triggers on kotlin, android, kmp, and gradle", () => {
    const skill = getSkill("kotlin-workflow")!;
    expect(skill.triggers.repoKinds).toContain("kotlin");
    expect(skill.triggers.repoKinds).toContain("android");
    expect(skill.triggers.repoKinds).toContain("kmp");
    expect(skill.triggers.repoKinds).toContain("gradle");
  });

  it("typescript-node-workflow triggers on typescript, node, nodejs, next, react, vite, and express", () => {
    const skill = getSkill("typescript-node-workflow")!;
    expect(skill.triggers.repoKinds).toContain("typescript");
    expect(skill.triggers.repoKinds).toContain("node");
    expect(skill.triggers.repoKinds).toContain("nodejs");
    expect(skill.triggers.repoKinds).toContain("next");
    expect(skill.triggers.repoKinds).toContain("react");
    expect(skill.triggers.repoKinds).toContain("vite");
    expect(skill.triggers.repoKinds).toContain("express");
  });
});

// ---------------------------------------------------------------------------
// Ranking: each workflow skill beats generic competitors for its language
//
// The ranker score formula is:
//   score = taskFit*taskFitWeight + repoFit*repoFitWeight + modelFit
//           + trustBonus + freshness - tokenPenalty - installPenalty
//
// For a language-matched workflow skill vs a generic (repoKinds:any) skill:
//   Language skill repoFit contribution: 1.0 * 0.9 = 0.90
//   Generic skill repoFit contribution:  0.5 * 0.5 = 0.25
//   Minimum expected score gap:          0.90 - 0.25 = 0.65 (before penalties)
//
// We assert both rank position (first) and a concrete score gap >= 0.3 so
// the test exercises the ranking *signal*, not just the sort order.
// ---------------------------------------------------------------------------

/** Minimum score margin the matching workflow skill must hold over the top generic. */
const MIN_SCORE_GAP = 0.3;

function assertWorkflowRanksFirst(skillId: string, repoLang: string): void {
  const skill = getSkill(skillId)!;
  const pool = [...GENERIC_POOL, skill];
  const ranked = rankSkills(pool, langCtx(repoLang));

  const winnerEntry = ranked[0];
  const runnerUpEntry = ranked[1];

  expect(winnerEntry.manifest.id).toBe(skillId);
  expect(winnerEntry.score - runnerUpEntry.score).toBeGreaterThanOrEqual(MIN_SCORE_GAP);
}

describe("workflow skills — rank above generic competitors for their primary repoKind", () => {
  it("ruby-workflow ranks first with a score gap ≥ 0.3 in a Ruby build session", () => {
    assertWorkflowRanksFirst("ruby-workflow", "ruby");
  });

  it("java-workflow ranks first with a score gap ≥ 0.3 in a Java build session", () => {
    assertWorkflowRanksFirst("java-workflow", "java");
  });

  it("swift-workflow ranks first with a score gap ≥ 0.3 in a Swift build session", () => {
    assertWorkflowRanksFirst("swift-workflow", "swift");
  });

  it("cpp-workflow ranks first with a score gap ≥ 0.3 in a C++ build session", () => {
    assertWorkflowRanksFirst("cpp-workflow", "cpp");
  });

  it("kotlin-workflow ranks first with a score gap ≥ 0.3 in a Kotlin build session", () => {
    assertWorkflowRanksFirst("kotlin-workflow", "kotlin");
  });

  it("typescript-node-workflow ranks first with a score gap ≥ 0.3 in a TypeScript build session", () => {
    assertWorkflowRanksFirst("typescript-node-workflow", "typescript");
  });

  it("typescript-node-workflow ranks first with a score gap ≥ 0.3 in a Node.js build session", () => {
    assertWorkflowRanksFirst("typescript-node-workflow", "node");
  });
});

// ---------------------------------------------------------------------------
// Cross-language isolation: mismatched language does not put the skill first
// ---------------------------------------------------------------------------

describe("workflow skills — do not rank first for mismatched languages", () => {
  it("ruby-workflow does not rank first in a Java session", () => {
    const rubySkill = getSkill("ruby-workflow")!;
    const javaSkill = getSkill("java-workflow")!;
    const ranked = rankSkills([...GENERIC_POOL, rubySkill, javaSkill], langCtx("java"));
    expect(ranked[0].manifest.id).not.toBe("ruby-workflow");
  });

  it("kotlin-workflow does not rank first in a Swift session", () => {
    const kotlinSkill = getSkill("kotlin-workflow")!;
    const swiftSkill = getSkill("swift-workflow")!;
    const ranked = rankSkills([...GENERIC_POOL, kotlinSkill, swiftSkill], langCtx("swift"));
    expect(ranked[0].manifest.id).not.toBe("kotlin-workflow");
  });

  it("cpp-workflow does not rank first in a TypeScript session", () => {
    const cppSkill = getSkill("cpp-workflow")!;
    const tsSkill = getSkill("typescript-node-workflow")!;
    const ranked = rankSkills([...GENERIC_POOL, cppSkill, tsSkill], langCtx("typescript"));
    expect(ranked[0].manifest.id).not.toBe("cpp-workflow");
  });
});
