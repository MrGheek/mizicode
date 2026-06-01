/**
 * Tests for the Smart Skills normalizer (skills-normalizer.ts).
 *
 * Covers:
 *   - extractSystemInstructions: "When to Activate" section (ECC convention)
 *   - extractSystemInstructions: "When to Use" section (legacy convention)
 *   - extractSystemInstructions: fallback to all bullets when no section matches
 *   - extractSystemInstructions: cap at MAX_BULLETS (15)
 *   - detectClass: ECC naming conventions (security → doctrine, tdd → workflow, etc.)
 *   - detectClass: language/framework skills → "repo"
 *   - detectRepoKinds: flutter/dart skills get correct repoKinds
 *   - detectRepoKinds: go skills detected via path convention
 *   - detectRepoKinds: generic skills fall back to ["any"]
 *   - normalizeSource: full round-trip for an ECC-format SKILL.md
 *   - normalizeSource: slug deduplication when multiple files share a name
 *   - normalizeSource: skips files with no extractable instructions
 *   - tokenOverheadEstimate: reflects instruction content length (not capped at arbitrary value)
 */

import { describe, it, expect } from "vitest";
import { extractSystemInstructions, detectClass, detectRepoKinds, normalizeSource } from "../services/skills-normalizer";
import type { SkillSource } from "@workspace/db";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DUMMY_SOURCE: SkillSource = {
  id: 1,
  repoUrl: "https://github.com/affaan-m/ECC",
  sourceType: "github",
  defaultBranch: "main",
  pinnedCommitSha: "abc123",
  license: "MIT",
  trustLevel: "user_approved",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ECC_SECURITY_SKILL = `---
name: security-review
description: Use this skill when adding authentication, handling user input, working with secrets, creating API endpoints, or implementing payment/sensitive features.
origin: ECC
---

# Security Review Skill

This skill ensures all code follows security best practices.

## When to Activate

- Implementing authentication or authorization
- Handling user input or file uploads
- Creating new API endpoints
- Working with secrets or credentials
- Implementing payment features
- Storing or transmitting sensitive data

## Core Principles

- Never log secrets or credentials
- Validate all user input before use
- Use parameterized queries for database access
`;

const ECC_TDD_SKILL = `---
name: tdd-workflow
description: Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.
origin: ECC
---

# TDD Workflow

## When to Activate

- Writing new features or functionality
- Fixing bugs or issues
- Refactoring existing code

## Rules

- Always write tests first, then implement code to make tests pass
- Maintain minimum 80% coverage
- Create a checkpoint commit after each TDD stage
`;

const ECC_FLUTTER_SKILL = `---
name: flutter-patterns
description: Flutter and Dart development patterns, widget composition, state management, and platform channels.
origin: ECC
---

# Flutter Patterns

Best practices for building Flutter apps with Dart.

## When to Activate

- Building Flutter mobile applications
- Working with Dart code
- Implementing widget composition
- Using state management in Flutter

## Guidelines

- Prefer StatelessWidget over StatefulWidget where possible
- Use const constructors for immutable widgets
- Follow Dart naming conventions
`;

const ECC_LARGE_SKILL = `---
name: coding-standards
description: Baseline cross-project coding conventions.
origin: ECC
---

# Coding Standards

## When to Activate

- Starting a new project or module
- Reviewing code for quality and maintainability
- Refactoring existing code to follow conventions
- Enforcing naming, formatting, or structural consistency
- Setting up linting, formatting, or type-checking rules
- Onboarding new contributors to coding conventions
- Auditing a codebase for code smells
- Preparing code for a PR review

## Code Quality Principles

- Code is read more than written — prioritize readability
- Use descriptive variable and function names
- Keep functions small and single-purpose
- Avoid premature optimization
- DRY: extract common logic into reusable functions
- YAGNI: do not add functionality until it is needed
- KISS: simplest solution that works

## Additional Rules

- Consistent formatting enforced via linter
- No dead code in production
`;

const ECC_WHEN_TO_USE_SKILL = `---
name: api-design
description: REST API design patterns.
origin: ECC
---

# API Design

## When to Use

- Designing new API endpoints
- Reviewing existing API contracts
- Adding pagination or filtering
`;

// ─── extractSystemInstructions ────────────────────────────────────────────────

describe("extractSystemInstructions — When to Activate (ECC convention)", () => {
  it("extracts bullets from the When to Activate section", () => {
    const instructions = extractSystemInstructions(ECC_SECURITY_SKILL);
    expect(instructions).toContain("Implementing authentication or authorization");
    expect(instructions).toContain("Handling user input or file uploads");
    expect(instructions).toContain("Creating new API endpoints");
    expect(instructions).toContain("Working with secrets or credentials");
  });

  it("also captures bullets from subsequent rule sections", () => {
    const instructions = extractSystemInstructions(ECC_SECURITY_SKILL);
    expect(instructions.some(l => l.includes("log secrets") || l.includes("credential") || l.includes("parameterized"))).toBe(true);
  });
});

describe("extractSystemInstructions — When to Use (legacy convention)", () => {
  it("extracts bullets from the When to Use section", () => {
    const instructions = extractSystemInstructions(ECC_WHEN_TO_USE_SKILL);
    expect(instructions).toContain("Designing new API endpoints");
    expect(instructions).toContain("Reviewing existing API contracts");
  });
});

describe("extractSystemInstructions — TDD skill", () => {
  it("extracts activation bullets and rule bullets", () => {
    const instructions = extractSystemInstructions(ECC_TDD_SKILL);
    expect(instructions).toContain("Writing new features or functionality");
    expect(instructions).toContain("Fixing bugs or issues");
    expect(instructions.some(l => l.includes("test") || l.includes("coverage"))).toBe(true);
  });
});

describe("extractSystemInstructions — cap at 15 bullets for large skills", () => {
  it("returns at most 15 instructions even for a skill with many bullets", () => {
    const instructions = extractSystemInstructions(ECC_LARGE_SKILL);
    expect(instructions.length).toBeLessThanOrEqual(15);
    expect(instructions.length).toBeGreaterThan(0);
  });

  it("prioritises When to Activate bullets over generic document bullets", () => {
    const instructions = extractSystemInstructions(ECC_LARGE_SKILL);
    expect(instructions).toContain("Starting a new project or module");
    expect(instructions).toContain("Reviewing code for quality and maintainability");
  });
});

describe("extractSystemInstructions — fallback when no section matches", () => {
  it("falls back to document-level bullets when no activation section exists", () => {
    const content = `# My Skill\n\nSome intro text.\n\n- Do this important thing\n- Also do this\n- And this one too\n`;
    const instructions = extractSystemInstructions(content);
    expect(instructions).toContain("Do this important thing");
    expect(instructions).toContain("Also do this");
  });

  it("falls back to prose paragraphs when no bullets exist at all", () => {
    const content = `# My Skill\n\nAlways validate input before processing it. Keep functions small and focused. Prefer explicit over implicit.\n`;
    const instructions = extractSystemInstructions(content);
    expect(instructions.length).toBeGreaterThan(0);
  });
});

// ─── detectClass ──────────────────────────────────────────────────────────────

describe("detectClass — ECC naming conventions", () => {
  it("security-review → doctrine", () => {
    expect(detectClass("skills/security-review/SKILL.md", "security patterns")).toBe("doctrine");
  });

  it("tdd-workflow → workflow", () => {
    expect(detectClass("skills/tdd-workflow/SKILL.md", "test driven development")).toBe("workflow");
  });

  it("autonomous-loops → workflow", () => {
    expect(detectClass("skills/autonomous-loops/SKILL.md", "agent loop patterns")).toBe("workflow");
  });

  it("code-tour → context", () => {
    expect(detectClass("skills/code-tour/SKILL.md", "codebase onboarding")).toBe("context");
  });

  it("memory-persistence → context", () => {
    expect(detectClass("skills/memory-persistence/SKILL.md", "memory hooks")).toBe("context");
  });

  it("coding-standards → doctrine", () => {
    expect(detectClass("skills/coding-standards/SKILL.md", "coding conventions")).toBe("doctrine");
  });

  it("backend-patterns → doctrine", () => {
    expect(detectClass("skills/backend-patterns/SKILL.md", "service layer patterns")).toBe("doctrine");
  });

  it("flutter-patterns → repo (language/framework skill)", () => {
    expect(detectClass("skills/flutter-patterns/SKILL.md", "flutter dart widgets")).toBe("repo");
  });

  it("android-clean-architecture → repo", () => {
    expect(detectClass("skills/android-clean-architecture/SKILL.md", "android kotlin")).toBe("repo");
  });

  it("dmux-workflows → team", () => {
    expect(detectClass("skills/dmux-workflows/SKILL.md", "multi-agent orchestration")).toBe("team");
  });

  it("content-level workflow keyword → workflow when no path match", () => {
    expect(detectClass("skills/some-skill/SKILL.md", "## TDD workflow\n\nfollow the pipeline")).toBe("workflow");
  });
});

// ─── detectRepoKinds ──────────────────────────────────────────────────────────

describe("detectRepoKinds — framework detection", () => {
  it("flutter skill path → flutter + dart repoKinds", () => {
    const kinds = detectRepoKinds("skills/flutter-patterns/SKILL.md", "flutter-patterns", "Flutter and Dart development patterns");
    expect(kinds).toContain("flutter");
    expect(kinds).toContain("dart");
  });

  it("android skill → android + kotlin repoKinds", () => {
    const kinds = detectRepoKinds("skills/android-clean-architecture/SKILL.md", "android-clean-architecture", "Android Kotlin architecture patterns");
    expect(kinds).toContain("android");
    expect(kinds).toContain("kotlin");
  });

  it("go skill path (go-build convention) → go + golang repoKinds", () => {
    const kinds = detectRepoKinds("skills/go-build/SKILL.md", "go-build", "Go build patterns");
    expect(kinds).toContain("go");
    expect(kinds).toContain("golang");
  });

  it("django/python skill → python + django repoKinds", () => {
    const kinds = detectRepoKinds("skills/django-reviewer/SKILL.md", "django-reviewer", "Django and Python web application patterns");
    expect(kinds).toContain("python");
    expect(kinds).toContain("django");
  });

  it("react/nextjs skill → react + next + typescript repoKinds", () => {
    const kinds = detectRepoKinds("skills/nextjs-turbopack/SKILL.md", "nextjs-turbopack", "Next.js and React development patterns");
    expect(kinds).toContain("next");
    expect(kinds).toContain("react");
  });

  it("swift/ios skill → swift + ios + macos repoKinds", () => {
    const kinds = detectRepoKinds("skills/ios-patterns/SKILL.md", "ios-patterns", "Swift and iOS application development");
    expect(kinds).toContain("swift");
    expect(kinds).toContain("ios");
  });

  it("generic skill with no framework keywords → ['any']", () => {
    const kinds = detectRepoKinds("skills/coding-standards/SKILL.md", "coding-standards", "Baseline cross-project coding conventions");
    expect(kinds).toEqual(["any"]);
  });

  it("security-review skill → ['any'] (domain skill, not framework-specific)", () => {
    const kinds = detectRepoKinds("skills/security-review/SKILL.md", "security-review", "Security patterns for authentication and API endpoints");
    expect(kinds).toEqual(["any"]);
  });
});

// ─── normalizeSource — full round-trip ───────────────────────────────────────

describe("normalizeSource — ECC-format SKILL.md round-trip", () => {
  it("produces a valid manifest for a security-review skill", () => {
    const files = [{ path: "skills/security-review/SKILL.md", content: ECC_SECURITY_SKILL }];
    const manifests = normalizeSource(files, DUMMY_SOURCE);
    expect(manifests).toHaveLength(1);
    const m = manifests[0];
    expect(m.id).toBe("security-review");
    expect(m.name).toBe("security-review");
    expect(m.class).toBe("doctrine");
    expect(m.summary).toContain("authentication");
    expect(m.instructions.system.length).toBeGreaterThan(0);
    expect(m.instructions.system).toContain("Implementing authentication or authorization");
    expect(m.source.repoUrl).toBe("https://github.com/affaan-m/ECC");
    expect(m.source.license).toBe("MIT");
    expect(m.source.trust).toBe("user_approved");
    expect(m.triggers.repoKinds).toEqual(["any"]);
    expect(m.install.type).toBe("virtual");
    expect(m.cost.tokenOverheadEstimate).toBeGreaterThan(0);
  });

  it("produces a workflow class manifest for tdd-workflow", () => {
    const files = [{ path: "skills/tdd-workflow/SKILL.md", content: ECC_TDD_SKILL }];
    const manifests = normalizeSource(files, DUMMY_SOURCE);
    expect(manifests[0].class).toBe("workflow");
  });

  it("produces a repo class manifest for flutter-patterns with flutter repoKinds", () => {
    const files = [{ path: "skills/flutter-patterns/SKILL.md", content: ECC_FLUTTER_SKILL }];
    const manifests = normalizeSource(files, DUMMY_SOURCE);
    const m = manifests[0];
    expect(m.class).toBe("repo");
    expect(m.triggers.repoKinds).toContain("flutter");
    expect(m.triggers.repoKinds).toContain("dart");
  });

  it("tokenOverheadEstimate reflects instruction length (not capped at old 500 cap for short skills)", () => {
    const files = [{ path: "skills/tdd-workflow/SKILL.md", content: ECC_TDD_SKILL }];
    const manifests = normalizeSource(files, DUMMY_SOURCE);
    const m = manifests[0];
    expect(m.cost.tokenOverheadEstimate).toBeGreaterThanOrEqual(60);
    expect(m.cost.tokenOverheadEstimate).toBeLessThanOrEqual(500);
  });
});

describe("normalizeSource — slug deduplication", () => {
  it("deduplicates slugs when multiple files normalize to the same name", () => {
    const files = [
      { path: "skills/coding-standards/SKILL.md", content: ECC_SECURITY_SKILL.replace("security-review", "coding-standards") },
      { path: "commands/coding-standards.md", content: ECC_TDD_SKILL.replace("tdd-workflow", "coding-standards") },
    ];
    const manifests = normalizeSource(files, DUMMY_SOURCE);
    const ids = manifests.map(m => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids[0]).toBe("coding-standards");
    expect(ids[1]).toBe("coding-standards-2");
  });
});

describe("normalizeSource — skips empty / uninstructive files", () => {
  it("skips files with fewer than 20 characters of content", () => {
    const files = [
      { path: "skills/empty/SKILL.md", content: "" },
      { path: "skills/tiny/SKILL.md", content: "Too short" },
      { path: "skills/security-review/SKILL.md", content: ECC_SECURITY_SKILL },
    ];
    const manifests = normalizeSource(files, DUMMY_SOURCE);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].id).toBe("security-review");
  });

  it("skips files where no instructions can be extracted", () => {
    const contentWithNoInstructions = `---\nname: empty-skill\ndescription: Nothing here\n---\n\n# Title Only\n`;
    const files = [{ path: "skills/empty-skill/SKILL.md", content: contentWithNoInstructions }];
    const manifests = normalizeSource(files, DUMMY_SOURCE);
    expect(manifests).toHaveLength(0);
  });
});
