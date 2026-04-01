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
- **sessions** — Coding session records with Vast.ai instance IDs, status tracking, service URLs (Bolt.diy, code-server, preview), cost tracking
- **templates** — Vast.ai template records with Docker image, on-start script, and env vars

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
- Routes: profiles, sessions, templates, offers, dashboard
- Services: `vastai.ts` (Vast.ai API wrapper), `profiles.ts` (profile management + seeding)

### `artifacts/dashboard` (`@workspace/dashboard`)

React + Vite frontend with dark theme. Pages: Dashboard, Sessions, Session Detail, GPU Offers, Templates.

### `lib/db` (`@workspace/db`)

Database layer with Drizzle ORM. Schemas: gpu_profiles, sessions, templates.

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI 3.1 spec and Orval codegen config. Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client.
