# Workspace

## Overview

OmniQL Cloud Coding Platform — a full-stack app that lets users spin up GPU-powered AI coding sessions on Vast.ai. The system provisions remote GPU machines running Bolt.diy (coding UI), llama.cpp with Kimi K2.5 GGUF models, code-server (VS Code), and nginx preview proxy.

Built as a pnpm workspace monorepo using TypeScript.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui components
- **External API**: Vast.ai REST API for GPU instance management

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server (Vast.ai integration)
│   └── dashboard/          # React frontend (dark theme dashboard)
├── docker/                 # Docker files for Vast.ai instances
│   ├── Dockerfile          # Pre-built GPU coding environment image
│   ├── onstart.sh          # Parameterized startup script
│   └── nginx-preview.conf  # Nginx config for preview proxy
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml     # pnpm workspace config
├── tsconfig.base.json      # Shared TS options
├── tsconfig.json           # Root TS project references
└── package.json            # Root package
```

## Database Schema

- **gpu_profiles** — GPU tier definitions (Starter/Standard/Pro/Ultra) with Vast.ai search params, model quant configs, and llama.cpp settings
- **sessions** — Coding session records with Vast.ai instance IDs, status tracking, service URLs, cost tracking. New: `taskMode`, `tokenMode`, `activeBundleId`, `repoFingerprintJson`
- **templates** — Vast.ai template records with Docker image, on-start script, and env vars
- **skill_sources** — GitHub repos imported as skill sources (url, branch, commit SHA, license, trust level)
- **skills** — Individual skills with `trustTier` (floatr_native|reviewed|user_approved|experimental), `installRisk` (virtual|config|hooked|binary|networked), `reviewStatus` (pending|approved|rejected)
- **skill_versions** — Versioned manifest snapshots per skill (manifest JSON, extracted rules, version hash)
- **skill_bundles** — Named skill sets with task/session/model/token mode metadata; 4 default bundles seeded at startup
- **session_skills** — Records which skills were activated for each session (bundle, token mode, activation mode)
- **skill_feedback** — Per-session helpful/unhelpful feedback on skills, with token delta and task success score
- **repo_graph_jobs** — Tracks repo indexing jobs for context-aware skill ranking (Phase 2)

## GPU Profiles

| Profile | GPU | Count | VRAM | Model Quant | Cost/hr |
|---------|-----|-------|------|-------------|---------|
| Starter | RTX 4090 | 1 | 24GB | UD-TQ1_0 | $0.13-$0.20 |
| Standard | RTX 4090 | 4 | 96GB | UD-TQ1_0 | $0.50-$0.80 |
| Pro | A100 80GB | 4 | 320GB | Q3_K_M | $2.00-$4.00 |
| Ultra | H100 80GB | 8 | 640GB | IQ4_XS | $8.00-$16.00 |

## API Endpoints

- `GET /api/profiles` — List GPU profiles
- `GET /api/profiles/:id` — Get profile details
- `GET /api/sessions` — List all sessions
- `POST /api/sessions` — Create session (provisions Vast.ai instance)
- `GET /api/sessions/:id` — Get session details
- `DELETE /api/sessions/:id` — Destroy session
- `GET /api/sessions/active` — Get active session
- `POST /api/sessions/:id/refresh` — Poll Vast.ai for status update
- `GET /api/templates` — List templates
- `POST /api/templates` — Create template on Vast.ai
- `PUT /api/templates/:id` — Update template
- `DELETE /api/templates/:id` — Delete template
- `GET /api/offers` — Search GPU offers on Vast.ai marketplace
- `GET /api/dashboard/summary` — Dashboard summary stats
- `POST /api/sessions` — Now accepts `taskMode`, `tokenMode`, `bundleId` — auto-compiles Smart Skills bundle on launch

### Smart Skills API

- `GET /api/skills` — List all skills (imported + builtins summary)
- `POST /api/skills/import` — Import skills from a GitHub repo URL
- `GET /api/skills/:id` — Get skill details and version history
- `PUT /api/skills/:id/review` — Approve, reject, or disable a skill
- `GET /api/skill-bundles` — List all skill bundles
- `POST /api/skill-bundles` — Create a custom bundle
- `POST /api/skill-bundles/seed` — Seed the 4 default bundles
- `GET /api/skill-bundles/:id` — Get bundle details
- `PUT /api/skill-bundles/:id` — Update a bundle
- `POST /api/skill-bundles/:id/activate` — Mark bundle as active for next session launch (next-launch semantics, v1)
- `POST /api/skills/compile-preview` — Preview bundle compilation against a given context
- `GET /api/sessions/:id/skills` — Get skill activations for a session
- `POST /api/sessions/:id/skills/feedback` — Submit helpful/unhelpful feedback on a skill
- `GET /api/skills/discover` — (501, Phase 4) Discovery feed
- `GET /api/skills/leaderboard` — (501, Phase 4) Skill leaderboard
- `POST /api/skills/evals/run` — (501, Phase 4) Run skill eval harness

### Memory API (SQLite FTS5 — no external deps)

- `POST /api/mem/init` — Start a memory session (`sessionId`, `userId`, `projectPath`)
- `POST /api/mem/observation` — Record a tool observation (`sessionId`, `userId`, `toolName`, `inputSummary`, `outputSummary`)
- `POST /api/mem/summarize` — Store end-of-session summary (`sessionId`, `userId`, `summary`)
- `GET /api/mem/context/:userId` — Fetch past-session context string (FTS5 search, injected into system prompts)
- `GET /api/mem/observations?userId=` — List recent tool observations
- `GET /api/mem/sessions?userId=` — List past sessions with summaries

Memory is scoped per `userId` (default: `"operator"`, override via `OMNIQL_MEM_USER_ID`). Optionally auth-gated via `OMNIQL_MEM_TOKEN` env var (required in `NODE_ENV=production`; warned-but-open in development). SQLite DB stored at `MEM_DATA_DIR` (defaults to `~/omniql-memory/mem.db` — outside workspace, not tracked by git).

Dashboard accesses memory via session-scoped proxy routes (`GET /api/sessions/:id/memory/sessions`, `/observations`, and `/search?q=`) and global proxy routes (`GET /api/memory/sessions` and `/api/memory/search?q=`) — no bearer token required for dashboard access.

The `searchMemory(userId, query)` service function in `artifacts/api-server/src/services/memory.ts` uses FTS5 full-text search on tool observations and LIKE on session summaries, returning `{ observations, sessions }`.

## Docker Images

Docker images are tagged by GPU architecture:
- `omniqlabs/coding-env:cuda12.4` — RTX 4090 (CUDA 12.4)
- `omniqlabs/coding-env:a100` — A100 GPUs
- `omniqlabs/coding-env:h100` — H100 GPUs

Each instance runs:
- llama.cpp server (port 8081) — Kimi K2.5 GGUF model inference
- Bolt.diy (port 5173) — AI coding UI
- code-server (port 8080) — VS Code in browser
- nginx preview proxy (port 3000) — Proxies app previews
- SSH (port 22) — Remote access

## Environment Secrets

- `VASTAI_API_KEY` — Vast.ai API key for instance management
- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly`

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server with Vast.ai integration. Routes in `src/routes/`, services in `src/services/`.

- Entry: `src/index.ts` — reads `PORT`, starts Express, seeds GPU profiles
- Routes: profiles, sessions, templates, offers, dashboard, memory, skills
- Services: `vastai.ts` (Vast.ai API wrapper), `profiles.ts` (profile management + seeding), `memory.ts` (SQLite FTS5 session memory), `skills-types.ts` (types + token mode profiles), `default-skills.ts` (11 built-in skills + 4 default bundles), `skills-normalizer.ts` (GitHub repo → FloatrSkillManifest[]), `skills-import.ts` (GitHub import pipeline), `skills-ranker.ts` (multi-factor skill scorer), `skills-bundler.ts` (bundle compiler + env payload builder)

### `artifacts/dashboard` (`@workspace/dashboard`)

React + Vite frontend with dark theme. Pages: Dashboard, Sessions, Session Detail, Templates, Memory.

Memory page (`artifacts/dashboard/src/pages/memory.tsx`) provides a global searchable notes view across all AI sessions — session summaries displayed as note blocks, full-text search via FTS5 (debounced, 350ms). Session Detail memory tab (`artifacts/dashboard/src/pages/sessions/[id].tsx`) also has per-session search and shows summaries prominently as a styled block below each session row header.

### `lib/db` (`@workspace/db`)

Database layer with Drizzle ORM. Schemas: gpu_profiles, sessions, templates.

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI 3.1 spec and Orval codegen config. Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client.
