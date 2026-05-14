/**
 * Tests verifying that the four new language workflow skills are correctly
 * defined in the default skill list and appear with the expected metadata.
 *
 * Covers:
 *   - ruby-workflow, java-workflow, swift-workflow, cpp-workflow are present
 *   - Each has class: "efficiency"
 *   - Each has safety.shellExecution: "restricted" and safety.networkAccess: "none"
 *   - Each has install.type: "virtual"
 *   - Each declares the expected repoKinds triggers
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_SKILLS } from "../services/default-skills";

const LANGUAGE_SKILL_IDS = ["ruby-workflow", "java-workflow", "swift-workflow", "cpp-workflow"] as const;

function getSkill(id: string) {
  return DEFAULT_SKILLS.find(s => s.id === id);
}

describe("language workflow skills — presence in DEFAULT_SKILLS", () => {
  for (const id of LANGUAGE_SKILL_IDS) {
    it(`${id} exists in the default skill list`, () => {
      expect(getSkill(id)).toBeDefined();
    });
  }
});

describe("language workflow skills — class", () => {
  for (const id of LANGUAGE_SKILL_IDS) {
    it(`${id} has class "efficiency"`, () => {
      expect(getSkill(id)?.class).toBe("efficiency");
    });
  }
});

describe("language workflow skills — safety", () => {
  for (const id of LANGUAGE_SKILL_IDS) {
    it(`${id} has safety.shellExecution: "restricted"`, () => {
      expect(getSkill(id)?.safety.shellExecution).toBe("restricted");
    });

    it(`${id} has safety.networkAccess: "none"`, () => {
      expect(getSkill(id)?.safety.networkAccess).toBe("none");
    });
  }
});

describe("language workflow skills — install type", () => {
  for (const id of LANGUAGE_SKILL_IDS) {
    it(`${id} has install.type: "virtual"`, () => {
      expect(getSkill(id)?.install.type).toBe("virtual");
    });
  }
});

describe("language workflow skills — repoKinds triggers", () => {
  it("ruby-workflow triggers on ruby, rails, and sinatra repos", () => {
    const skill = getSkill("ruby-workflow");
    expect(skill?.triggers.repoKinds).toContain("ruby");
    expect(skill?.triggers.repoKinds).toContain("rails");
    expect(skill?.triggers.repoKinds).toContain("sinatra");
  });

  it("java-workflow triggers on java, maven, gradle, and spring repos", () => {
    const skill = getSkill("java-workflow");
    expect(skill?.triggers.repoKinds).toContain("java");
    expect(skill?.triggers.repoKinds).toContain("maven");
    expect(skill?.triggers.repoKinds).toContain("gradle");
    expect(skill?.triggers.repoKinds).toContain("spring");
  });

  it("swift-workflow triggers on swift, swiftpm, ios, and macos repos", () => {
    const skill = getSkill("swift-workflow");
    expect(skill?.triggers.repoKinds).toContain("swift");
    expect(skill?.triggers.repoKinds).toContain("swiftpm");
    expect(skill?.triggers.repoKinds).toContain("ios");
    expect(skill?.triggers.repoKinds).toContain("macos");
  });

  it("cpp-workflow triggers on cpp, c++, and cmake repos", () => {
    const skill = getSkill("cpp-workflow");
    expect(skill?.triggers.repoKinds).toContain("cpp");
    expect(skill?.triggers.repoKinds).toContain("c++");
    expect(skill?.triggers.repoKinds).toContain("cmake");
  });
});
