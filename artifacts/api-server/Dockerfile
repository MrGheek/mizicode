# ============================================================
# Stage 1 — Build
# Build context must be the monorepo root so that shared lib/
# packages and pnpm-lock.yaml are available.
# ============================================================
FROM node:20-alpine AS builder

# libc6-compat is required for rollup 4.x native bindings on Alpine (musl).
RUN apk add --no-cache libc6-compat

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

# Copy workspace manifests first so layer caching works well
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

# Copy shared libraries used by the API server
COPY lib/ lib/

# Copy the api-server artifact source
COPY artifacts/api-server/ artifacts/api-server/

# Install all workspace dependencies (dev deps required for esbuild)
RUN pnpm install --frozen-lockfile

# Run the esbuild bundle from the api-server directory
WORKDIR /app/artifacts/api-server
RUN node build.mjs

# Use pnpm deploy to create a self-contained production deployment
# directory with all native/external deps resolved (no symlinks).
WORKDIR /app
# --legacy: pnpm v10 requires inject-workspace-packages=true by default;
# --legacy restores the previous copy-based deploy behaviour.
RUN pnpm deploy --filter @workspace/api-server --prod --legacy /app/prod-deploy

# ============================================================
# Stage 2 — Runtime
# Slim image that only carries the compiled bundle and the
# production node_modules created by `pnpm deploy`.
# ============================================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Production node_modules (includes better-sqlite3 native module,
# fully resolved — no pnpm symlinks or virtual store needed)
COPY --from=builder /app/prod-deploy/node_modules ./node_modules

# Compiled bundle (index.mjs + pino transport worker files)
COPY --from=builder /app/artifacts/api-server/dist ./dist

# Create the default memory data directory.
# Override the mount path with the MEM_DATA_DIR env var.
RUN mkdir -p /data/memory

VOLUME ["/data/memory"]

EXPOSE 8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
