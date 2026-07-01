# MIZI × Theia Extension Architecture

## Overview

MIZI's intelligence layer — skills system, token budget, phase router, repo graph, passive recall, ambient agent, living plan board — all live outside the IDE today. Theia integration makes every system visible, controllable, and interactive from inside the coding environment.

## Extensions (27 total)

| # | Extension | Type | Backend API | Theia Hook | Priority |
|---|-----------|------|-------------|------------|----------|
| 1 | `mizi-plan-view` | frontend | routes/plan.ts, services/plan.ts, plan-decompose.ts, plan-auto-advance.ts | Custom view panel + lane SSE broadcaster | P0 |
| 2 | `mizi-phase-selector` | frontend | services/inference-router.ts | Status bar widget (left, coloured dot) + quick-pick | P0 |
| 3 | `mizi-token-mode` | frontend | services/skills-types.ts, TOKEN_MODE_PROFILES | Status bar widget (right, ◈ LEAN/CORE/FULL/ULTRA) | P0 |
| 4 | `mizi-session-status-bar` | frontend | — | Status bar: phase, model, GPU cost, token %, health | P0 |
| 5 | `mizi-nim-provider` | backend | routes/models.ts | Dynamic model discovery and switch backend | P0 |
| 6 | `mizi-repo-context-provider` | backend | routes/repo.ts, repo-indexer/graph/fingerprint, skills-ranker.ts | ai-core ContextProvider — symbol graph + tech stack per AI request | P0 |
| 7 | `mizi-mcp-server` | backend | routes/mcp.ts | Registers 12 MIZI MCP tools (memory, repo, skills, swarm, plan, phase) | P0 |
| 8 | `mizi-repo-index-status` | frontend | services/repo-graph.ts | Status bar ("⟳ Indexing..." → "✓ 247 symbols") | P1 |
| 9 | `mizi-memory-panel` | frontend | services/memory-passive.ts, memory-semantic.ts | AI chat sidebar — recalled memories with pin/suppress | P1 |
| 10 | `mizi-memory-bridge` | backend | ai-history → POST /mem/observations | ai-history poller → memory pipeline | P1 |
| 11 | `mizi-ambient-panel` | frontend | routes/ambient.ts, services/ambient.ts, services/safety.ts | Notifications (approve/reject) + panel (cycle history, kill switch) | P1 |
| 12 | `mizi-ai-palette` | frontend | routes/palette-intent.ts | Command palette ("MIZI: Ask...") → free-text → LLM-mapped action | P1 |
| 13 | `mizi-local-config` | both | — (reads MIZI_API_BASE env) | Frontend/Backend app contributions — injects API base URL into browser | P1 |
| 14 | `mizi-agent-workflows` | backend | — (AgentService in-process) | Registers 11 agents + 5 bundle presets via ai-core AgentService | P1 |
| 15 | `mizi-git-lanes` | frontend | routes/git.ts | SCM commands: session/lane branch, handoff to PR, push | P1 |
| 16 | `mizi-claw-runner` | both | routes/swarm.ts | Swarm job start/stop/stream from IDE | P1 |
| 17 | `mizi-design-context` | both | routes/design-intelligence.ts, services/curated-sources.ts | Side panel + ai-core ContextProvider | P2 |
| 18 | `mizi-skills-view` | frontend | services/skills-evals.ts, skills-leaderboard.ts, skills-ranker.ts | Side panel (bundle + leaderboard + eval lift) | P2 |
| 19 | `mizi-snapshot-rollback` | frontend | services/snapshot.ts | quick-input pick + confirm rollback | P2 |
| 20 | `mizi-lane-coordinator` | frontend | services/lane-coordinator.ts | Status bar (claim, blast radius, handoff) | P2 |
| 21 | `mizi-vllm-manager` | backend | routes/vllm.ts | Local vLLM process control: start/stop/config | P2 |
| 22 | `mizi-metrics-contributor` | backend | routes/metrics.ts | Prometheus-format GPU/token/latency/cost metrics | P2 |
| 23 | `mizi-doctrine-prompt` | backend | — (PromptService in-process) | Registers Karpathy Doctrine + Design Intelligence prompt fragments | P2 |
| 24 | `mizi-language-tasks` | both | — (TaskContribution in-process) | 13 language-specific tasks (test, lint, typecheck, build) per workspace | P2 |
| 25 | `mizi-working-state` | both | — (AIVariableService in-process) | Registers mizi_working_state variable — editor tabs, cursor, selection | P2 |
| 26 | `mizi-skill-feedback` | frontend | POST /skills/{id}/feedback | Chat thumbs up/down toolbar action → skills learning loop | P2 |
| 27 | `mizi-terminal-ops` | backend | POST /api/mcp/call (proxied) | 7 ops tools (dns, docker, sql, port-scan, etc.) via ToolInvocationRegistry | P2 |

## Theia Packages Used (free unlocks)

| Package | What It Unlocks |
|---------|-----------------|
| `@theia/timeline` | Shows MIZI snapshot commits in timeline panel — zero custom code |
| `@theia/callhierarchy` | Populated from MIZI repo graph symbol relationships |
| `@theia/typehierarchy` | Same — repo graph as hierarchy source |
| `@theia/ai-history` | Write side of memory pipeline (bridged by mizi-memory-bridge) |
| `@theia/ai-chat-ui` | Extension points for memory panel in chat sidebar |
| `@theia/ai-core` | ContextProvider interface for repo + design context injection |
| `@theia/ai-mcp` | MCP client for mizi-mcp-server tool registration |
| `@theia/scm` | SCM provider interface for mizi-git-lanes |

## Integration Points

- **Status bar (left)**: phase-selector, session-status-bar, lane-coordinator, repo-index-status
- **Status bar (right)**: token-mode
- **View panels**: plan-view, ambient-panel, design-context, skills-view, memory-panel
- **Command palette**: ai-palette, snapshot-rollback, git-lanes, claw-runner
- **Context providers**: repo-context-provider, design-context (via @theia/ai-core)
- **MCP tools**: mizi-mcp-server (memory, skills, repo, swarm, plan — via @theia/ai-mcp)
- **Backend services**: nim-provider, memory-bridge, vllm-manager, metrics-contributor, claw-runner

## Simple Grouping

### Visibility (expose hidden backend state)
`mizi-plan-view` · `mizi-token-mode` · `mizi-phase-selector` · `mizi-session-status-bar` · `mizi-repo-index-status` · `mizi-memory-panel` · `mizi-design-context` · `mizi-skills-view`

### Control (act from inside the IDE)
`mizi-ai-palette` · `mizi-ambient-panel` · `mizi-snapshot-rollback` · `mizi-git-lanes` · `mizi-lane-coordinator` · `mizi-vllm-manager`

### AI Context (what the AI knows per request)
`mizi-repo-context-provider` · `mizi-design-context` · `mizi-memory-bridge` · `mizi-mcp-server`

### Agent / Swarm (deeper agentic system)
`mizi-claw-runner` · `mizi-mcp-server` · `mizi-lane-coordinator` · `mizi-ambient-panel`

## Build & CI

- **All 27 extensions**: live in `docker/mizi-theia/packages/mizi-extensions/` as `@mizi/theia-extensions`
- **Registration**: `theiaExtensions` field in `packages/mizi-extensions/package.json` — auto-discovered by `theia build`
- **CI workflow**: `.github/workflows/build-theia.yml` — `npm install` + `npx tsc` (extensions) + `npx theia build` → publishes artifact to GitHub release `theia`
- **Docker consumption**: `THEIA_ARTIFACT_URL` ARG in `docker/Dockerfile` downloads tarball to `/opt/mizi-theia/`
- **Startup**: `onstart.sh` runs `node /opt/mizi-theia/src-gen/backend/server.js` with MIZI AI config from env vars
