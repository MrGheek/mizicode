# ============================================================
# Stage 1 — Build
# Build context must be the monorepo root so that shared lib/
# packages and pnpm-lock.yaml are available.
# ============================================================
FROM node:20-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

# better-sqlite3 (workspace dep) requires Python + C++ build tools
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# ── Dependency caching layer ─────────────────────────────────
# Copy only workspace manifests so that `pnpm install` is cached
# until the lockfile changes — not on every source edit.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

# Copy package.json files only (for workspace package resolution)
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-spec/package.json         lib/api-spec/
COPY lib/api-zod/package.json          lib/api-zod/
COPY lib/db/package.json               lib/db/
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/
COPY artifacts/dashboard/package.json  artifacts/dashboard/

# Install dependencies (cached until lockfile changes)
RUN pnpm install --frozen-lockfile

# ── Source copy ──────────────────────────────────────────────
COPY lib/ lib/
COPY artifacts/dashboard/ artifacts/dashboard/

# VITE_API_BASE_URL is injected at build time so the SPA knows
# where to reach the API server on Fly.io.
ARG VITE_API_BASE_URL=https://mizi-api.fly.dev

# BASE_PATH and PORT are required by vite.config.ts even for builds
ENV BASE_PATH="/" \
    PORT="3000" \
    VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    NODE_ENV=production

RUN pnpm --filter @workspace/dashboard run build

# ============================================================
# Stage 2 — Serve
# Lightweight Caddy image to serve the compiled static assets.
# ============================================================
FROM caddy:2-alpine AS runner

# Copy the Vite build output into Caddy's default site root
COPY --from=builder /app/artifacts/dashboard/dist/public /usr/share/caddy

# Caddyfile: serve the SPA and fall back to index.html for
# client-side routing (all 404s → index.html).
RUN printf ':80 {\n  root * /usr/share/caddy\n  try_files {path} /index.html\n  file_server\n}\n' > /etc/caddy/Caddyfile

EXPOSE 80
