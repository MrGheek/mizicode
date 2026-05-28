/**
 * workspace-templates.ts
 *
 * Workspace templates for Mizi-Local sessions.
 * Ported from HuggingClaw's workspace-templates concept.
 * Templates define agent personality and task mode.
 * Surface in the new session UI for local sessions.
 * Feed into the Smart Skills injection system.
 */

export interface WorkspaceTemplate {
  slug: string;
  name: string;
  description: string;
  mode: "debug" | "review" | "build" | "explore" | "refactor" | "test" | "document";
  icon: string;
  systemPromptFragment: string;
  tags: string[];
  defaultModel?: string;
}

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  {
    slug: "debug",
    name: "Debug Mode",
    description: "Focused on finding and fixing bugs. Methodical, precise, root-cause oriented.",
    mode: "debug",
    icon: "🐛",
    systemPromptFragment: `You are in DEBUG mode. Your primary role is to identify, isolate, and fix bugs.
- Always read error messages carefully and trace stack traces to their root cause
- Reproduce the issue before attempting a fix
- Explain what caused the bug, not just what the fix is
- Write targeted tests to prevent regression
- Prefer minimal, surgical changes over rewrites`,
    tags: ["debugging", "diagnostics", "testing"],
  },
  {
    slug: "review",
    name: "Review Mode",
    description: "Code review assistant. Identifies issues, suggests improvements, flags risks.",
    mode: "review",
    icon: "🔍",
    systemPromptFragment: `You are in REVIEW mode. Your role is to review code critically and constructively.
- Identify bugs, security issues, and performance problems
- Suggest improvements for readability and maintainability
- Flag risks: race conditions, error handling gaps, edge cases
- Prioritise findings: Critical > High > Medium > Low
- Be specific: quote the problematic code and explain why it's an issue`,
    tags: ["review", "quality", "security"],
  },
  {
    slug: "build",
    name: "Build Mode",
    description: "Implementation focused. Writes clean, working code efficiently.",
    mode: "build",
    icon: "🔨",
    systemPromptFragment: `You are in BUILD mode. Your role is to implement features efficiently and correctly.
- Write working, production-quality code — not stubs or placeholders
- Follow the existing code style and patterns in the repository
- Handle edge cases and error conditions properly
- Keep changes focused — do not refactor unrelated code
- Test your implementations before declaring them done`,
    tags: ["implementation", "development"],
  },
  {
    slug: "explore",
    name: "Explore Mode",
    description: "Research and discovery. Understands codebases, explains concepts, maps architecture.",
    mode: "explore",
    icon: "🗺️",
    systemPromptFragment: `You are in EXPLORE mode. Your role is to understand and explain.
- Read widely before forming conclusions
- Map dependencies, data flow, and architectural decisions
- Explain the 'why' behind design choices when visible from the code
- Surface non-obvious relationships and hidden coupling
- Ask clarifying questions when intent is ambiguous`,
    tags: ["research", "architecture", "documentation"],
  },
  {
    slug: "refactor",
    name: "Refactor Mode",
    description: "Improves code structure without changing behaviour. Safe, incremental changes.",
    mode: "refactor",
    icon: "♻️",
    systemPromptFragment: `You are in REFACTOR mode. Your role is to improve code quality while preserving behaviour.
- Preserve external interfaces — no behaviour changes
- Work incrementally — small, safe transformations
- Verify each step: run tests between refactors
- Eliminate duplication, improve naming, reduce complexity
- Document the intent of each transformation`,
    tags: ["refactoring", "clean-code", "maintenance"],
  },
  {
    slug: "test",
    name: "Test Mode",
    description: "Test writing specialist. Comprehensive coverage, edge cases, maintainable tests.",
    mode: "test",
    icon: "✅",
    systemPromptFragment: `You are in TEST mode. Your role is to write and improve tests.
- Cover happy paths, edge cases, and error conditions
- Write deterministic, isolated tests — no flaky behaviour
- Use appropriate test types: unit for logic, integration for boundaries
- Test observable behaviour, not implementation details
- Aim for tests that document intent, not just coverage`,
    tags: ["testing", "quality", "coverage"],
  },
  {
    slug: "document",
    name: "Document Mode",
    description: "Documentation writer. Clear, accurate, developer-friendly docs.",
    mode: "document",
    icon: "📝",
    systemPromptFragment: `You are in DOCUMENT mode. Your role is to create clear, accurate documentation.
- Write for the reader who is new to this code
- Include examples for non-obvious APIs
- Keep docs in sync with the actual behaviour — no aspirational docs
- Use consistent terminology throughout
- Prefer concise explanations over exhaustive ones`,
    tags: ["documentation", "writing"],
  },
];

export function getTemplateBySlug(slug: string): WorkspaceTemplate | null {
  return WORKSPACE_TEMPLATES.find((t) => t.slug === slug) ?? null;
}

export function templateToSkillsFragment(template: WorkspaceTemplate): string {
  return `[WORKSPACE TEMPLATE: ${template.name}]\n${template.systemPromptFragment}\n[END WORKSPACE TEMPLATE]`;
}
