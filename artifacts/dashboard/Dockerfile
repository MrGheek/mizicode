# ============================================================
# Stage 1 — Build
# Build context must be the monorepo root so that shared lib/
# packages and pnpm-lock.yaml are available.
# ============================================================
FROM node:20-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

# Copy shared libraries used by the dashboard
COPY lib/ lib/

# Copy the dashboard artifact source
COPY artifacts/dashboard/ artifacts/dashboard/

# Install dependencies
RUN pnpm install --frozen-lockfile

# VITE_API_BASE_URL is injected at build time so the SPA knows
# where to reach the API server on Fly.io.
ARG VITE_API_BASE_URL=https://floatr-api.fly.dev

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
