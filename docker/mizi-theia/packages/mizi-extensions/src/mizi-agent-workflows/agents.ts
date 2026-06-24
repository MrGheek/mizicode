import { Agent } from "@theia/ai-core/lib/common/agent";

export const FLOW_ROUTER_AGENT: Agent = {
  id: "mizi-flow-router",
  name: "Flow Router",
  description: "Routes user requests to the appropriate specialised agent based on the task type and context",
  variables: ["mizi_repo_context", "mizi_memory_context", "mizi_working_state"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-flow-router",
    defaultVariant: { id: "mizi-flow-router-v1", template: "You are the flow router for MIZI. Your job is to analyze the user's request and route it to the correct agent. Available agents: Debug (debugging), Builder (implementation), Reviewer (code review), Designer (UX/frontend), Team (coordination), Ops (infrastructure). Explain your routing decision briefly, then delegate." },
  }],
  languageModelRequirements: [{ purpose: "routing" }],
  functions: ["mizi_plan_status", "mizi_plan_decompose", "mizi_phase_set", "mizi_skills_list"],
};

export const DEBUG_FLOW_AGENT: Agent = {
  id: "mizi-debug-flow",
  name: "Debug Flow",
  description: "Systematic debugger that follows a structured investigation, hypothesis, and fix workflow",
  variables: ["mizi_repo_context", "mizi_memory_context", "mizi_working_state"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-debug-flow",
    defaultVariant: { id: "mizi-debug-flow-v1", template: "You are a systematic debugger. Follow this flow: 1) Reproduce the error, 2) Read relevant source code and error messages, 3) Form a hypothesis about the root cause, 4) Test with minimal reproduction, 5) Implement fix, 6) Verify fix doesn't break related tests, 7) Document root cause and fix. Show each step explicitly." },
  }],
  languageModelRequirements: [{ purpose: "debugging" }],
  functions: ["mizi_repo_graph", "mizi_snapshot_create", "mizi_memory_search"],
};

export const CHECKPOINTS_LITE_AGENT: Agent = {
  id: "mizi-checkpoints-lite",
  name: "Checkpoints Lite",
  description: "Creates lightweight checkpoints during risky operations for safe rollback",
  variables: ["mizi_repo_context"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-checkpoints-lite",
    defaultVariant: { id: "mizi-checkpoints-lite-v1", template: "You manage lightweight checkpoints. Before any risky operation, create a snapshot. After each successful step, mark it as a safe checkpoint. If an operation fails, guide the user through rollback to the last safe checkpoint." },
  }],
  languageModelRequirements: [{ purpose: "checkpointing" }],
  functions: ["mizi_snapshot_create"],
};

export const DECISION_LOG_LITE_AGENT: Agent = {
  id: "mizi-decision-log-lite",
  name: "Decision Log Lite",
  description: "Logs architecture and design decisions with context and rationale",
  variables: ["mizi_design_context", "mizi_repo_context"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-decision-log-lite",
    defaultVariant: { id: "mizi-decision-log-lite-v1", template: "You maintain a decision log. When the user makes an architecture or design decision, record: 1) Context and constraints, 2) Options considered, 3) Decision and rationale, 4) Consequences. Format as ADR entries with status (proposed/accepted/deprecated)." },
  }],
  languageModelRequirements: [{ purpose: "decision-tracking" }],
  functions: ["mizi_memory_store"],
};

export const UX_REASONING_AGENT: Agent = {
  id: "mizi-ux-reasoning",
  name: "UX Reasoning",
  description: "Applies design thinking and UX best practices to UI/UX decisions",
  variables: ["mizi_design_context"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-ux-reasoning",
    defaultVariant: { id: "mizi-ux-reasoning-v1", template: "You are a UX design assistant. Apply Design Intelligence Core principles. Consider user goals, interaction patterns, accessibility, and responsive design. Before suggesting UI changes, explain the user need and how your solution addresses it." },
  }],
  languageModelRequirements: [{ purpose: "ux-design" }],
  functions: [],
};

export const DESIGN_SYSTEM_SCAFFOLD_AGENT: Agent = {
  id: "mizi-design-system-scaffold",
  name: "Design System Scaffold",
  description: "Creates and maintains design system foundations — tokens, components, documentation",
  variables: ["mizi_design_context", "mizi_repo_context"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-design-system-scaffold",
    defaultVariant: { id: "mizi-design-system-scaffold-v1", template: "You scaffold design systems. Define design tokens (colors, typography, spacing, breakpoints) as CSS custom properties or theme objects. Build primitive UI components that compose according to the design token system. Document each component with usage examples and states." },
  }],
  languageModelRequirements: [{ purpose: "design-system" }],
  functions: [],
};

export const FRONTEND_DESIGN_REVIEW_AGENT: Agent = {
  id: "mizi-frontend-design-review",
  name: "Frontend Design Review",
  description: "Reviews frontend implementations against design specs, accessibility, and responsive standards",
  variables: ["mizi_design_context", "mizi_repo_context"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-frontend-design-review",
    defaultVariant: { id: "mizi-frontend-design-review-v1", template: "You review frontend implementations. Check: 1) Visual fidelity to design specs, 2) Accessibility (keyboard navigation, screen reader, color contrast), 3) Responsive behavior at all breakpoints, 4) Performance (lazy loading, bundle size), 5) Code quality (conventions, reusability). For each issue found, include the severity and a fix suggestion." },
  }],
  languageModelRequirements: [{ purpose: "frontend-review" }],
  functions: [],
};

export const DESIGN_HANDOFF_DISCIPLINE_AGENT: Agent = {
  id: "mizi-design-handoff-discipline",
  name: "Design Handoff Discipline",
  description: "Ensures complete and consistent design-to-development handoffs",
  variables: ["mizi_design_context"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-design-handoff-discipline",
    defaultVariant: { id: "mizi-design-handoff-discipline-v1", template: "You manage design handoffs. Verify every handoff includes: 1) Visual design specs (Figma or similar), 2) Interaction states (hover, focus, active, disabled, loading, error), 3) Responsive behavior for each breakpoint, 4) Accessibility annotations, 5) Copy/content specs, 6) Edge cases and empty states." },
  }],
  languageModelRequirements: [{ purpose: "design-handoff" }],
  functions: [],
};

export const TEST_ENV_PROVISIONING_AGENT: Agent = {
  id: "mizi-test-env-provisioning",
  name: "Test Environment Provisioning",
  description: "Sets up and manages test environments, test data, and CI integration",
  variables: ["mizi_repo_context"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-test-env-provisioning",
    defaultVariant: { id: "mizi-test-env-provisioning-v1", template: "You provision test environments. For each request: 1) Determine the type of test (unit, integration, e2e), 2) Set up required infrastructure (databases, mock services, test fixtures), 3) Configure CI pipeline integration, 4) Verify the environment is working, 5) Document the setup for reproducibility." },
  }],
  languageModelRequirements: [{ purpose: "test-env" }],
  functions: ["mizi_swarm_run"],
};

export const MEMORY_COMPACT_AGENT: Agent = {
  id: "mizi-memory-compact",
  name: "Memory Compact",
  description: "Manages conversation context within token budget limits, prioritizing high-value information",
  variables: ["mizi_memory_context", "mizi_token_budget"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-memory-compact",
    defaultVariant: { id: "mizi-memory-compact-v1", template: "You manage the conversation context budget. Prioritize: 1) Active task details and constraints, 2) Recent decisions and their rationale, 3) Current state and pending actions. De-prioritize: 1) Completed tasks, 2) Historical context not relevant to current task, 3) Repeated information. When budget is exceeded, summarize the lowest-priority items." },
  }],
  languageModelRequirements: [{ purpose: "context-management" }],
  functions: ["mizi_memory_search", "mizi_memory_store"],
};

export const WORKING_STATE_CONTINUITY_AGENT: Agent = {
  id: "mizi-working-state-continuity",
  name: "Working State Continuity",
  description: "Maintains awareness of the current workspace state — open files, cursor, recent edits",
  variables: ["mizi_working_state", "mizi_repo_context"],
  agentSpecificVariables: [],
  prompts: [{
    id: "mizi-working-state-continuity",
    defaultVariant: { id: "mizi-working-state-continuity-v1", template: "You maintain working state continuity. Track: 1) Which files are currently open in the editor, 2) Cursor position and selection, 3) Recent edits and changes, 4) Current task or goal, 5) Pending actions or questions. Use this state to provide contextually relevant suggestions." },
  }],
  languageModelRequirements: [{ purpose: "state-tracking" }],
  functions: ["mizi_repo_graph"],
};

export const ALL_AGENTS: Agent[] = [
  FLOW_ROUTER_AGENT,
  DEBUG_FLOW_AGENT,
  CHECKPOINTS_LITE_AGENT,
  DECISION_LOG_LITE_AGENT,
  UX_REASONING_AGENT,
  DESIGN_SYSTEM_SCAFFOLD_AGENT,
  FRONTEND_DESIGN_REVIEW_AGENT,
  DESIGN_HANDOFF_DISCIPLINE_AGENT,
  TEST_ENV_PROVISIONING_AGENT,
  MEMORY_COMPACT_AGENT,
  WORKING_STATE_CONTINUITY_AGENT,
];

export const BUNDLE_PRESETS: Record<string, string[]> = {
  "mizi-builder": ["mizi-flow-router", "mizi-memory-compact", "mizi-working-state-continuity"],
  "mizi-reviewer": ["mizi-flow-router", "mizi-frontend-design-review", "mizi-decision-log-lite", "mizi-memory-compact"],
  "mizi-debugger": ["mizi-debug-flow", "mizi-checkpoints-lite", "mizi-memory-compact", "mizi-working-state-continuity"],
  "mizi-team-studio": ["mizi-flow-router", "mizi-decision-log-lite", "mizi-memory-compact", "mizi-working-state-continuity"],
  "mizi-team-coordination": ["mizi-flow-router", "mizi-decision-log-lite", "mizi-test-env-provisioning", "mizi-memory-compact"],
};
