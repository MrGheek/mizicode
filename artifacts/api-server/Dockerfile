# ============================================================
# Stage 1 — Build
# Build context must be the monorepo root so that shared lib/
# packages and pnpm-lock.yaml are available.
# ============================================================
FROM node:20-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

# better-sqlite3 prefers prebuilt binaries on glibc (Debian/Ubuntu).
# Only needed as fallback if no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# ── Dependency caching layer ─────────────────────────────────
# Copy only workspace manifests so that `pnpm install` (which
# compiles better-sqlite3 from source) is cached until the
# lockfile or workspace configs change — not on every source edit.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

# Copy package.json files only (for workspace package resolution)
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-spec/package.json         lib/api-spec/
COPY lib/api-zod/package.json          lib/api-zod/
COPY lib/db/package.json               lib/db/
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/
COPY artifacts/api-server/package.json artifacts/api-server/

# Install all workspace dependencies (dev deps required for esbuild).
# better-sqlite3 C++ compilation happens here and is now fully cached
# between source-only deploys.
RUN pnpm install --frozen-lockfile

# ── Source copy ──────────────────────────────────────────────
# Copy full source after install so code changes don't bust the
# expensive pnpm install / native-compile cache layer above.
COPY lib/ lib/
COPY artifacts/api-server/ artifacts/api-server/

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
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install fly CLI so the workspace proxy can use `fly proxy` to tunnel
# connections to specific workspace machines via Fly.io private networking.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh && \
    ln -sf /usr/local/bin/flyctl /usr/local/bin/fly && \
    rm -rf /var/lib/apt/lists/*

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
